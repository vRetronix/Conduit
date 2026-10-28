/**
 * Electron main process: owns the window, serves the renderer over app://, enforces renderer
 * security policy, supervises the backend server process, and is the only holder of the backend's local access key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { createLogger, type Logger } from '@conduit/logger';
import { envValue } from '@conduit/shared/app/config';
import { IPC_CHANNELS, type ApiResult, type AppInfo, type BackendStatus } from '@conduit/shared/app/desktop-bridge';
import { APP_HOST, APP_ORIGIN, APP_PROTOCOL, DEFAULT_API_PORT } from '@conduit/shared/app/net';
import { BackendSupervisor } from './backend-supervisor';
import { FileCredentialVault, handleVaultRequest } from './credential-vault';
import { connectRequestSchema, validateApiRequest, validateControlsColor, validateKickClipUrl } from './ipc-validation';
import { LocalApiClient } from './local-api';
import { discordPortalUrl, KICK_DEVELOPER_SETTINGS_URL, validateAuthorizationUrl, validateBotInstallUrl } from './oauth-launch';
import { isRecoveryInvocation, refuseRecoveryWhileRunning, runRecoveryMode } from './recovery-mode';
import { buildContentSecurityPolicy, isPermissionAllowed, isTrustedRendererUrl, mimeTypeFor, resolveRendererPath } from './renderer-security';

const PRODUCT_NAME = 'CONDUIT';
/** Height of the strip at the top of the window that holds the window buttons and drags the window (installed app). */
const TITLE_BAR_HEIGHT = 36;

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const version = __CONDUIT_VERSION__;
const userAgent = `${PRODUCT_NAME}-Desktop/${version}`;

/** For logs: the origin of a URL only (never paths or query strings, which can carry codes). */
function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return 'invalid';
  }
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

/**
 * The data folder: CONDUIT_DATA_DIR if set, otherwise Electron's userData folder (%APPDATA%\CONDUIT). userData also
 * holds Chromium's Local State, whose DPAPI-protected key decrypts the stored platform credentials.
 */
function resolveDesktopDataDir(): string {
  return envValue(process.env, 'CONDUIT_DATA_DIR') ?? app.getPath('userData');
}

function startDesktop(dataDir: string): void {
  /** Dev server URL is honoured only in unpackaged (development) builds. */
  const devServerUrl = !app.isPackaged ? envValue(process.env, 'CONDUIT_RENDERER_URL') : undefined;
  const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined;
  const port = parsePort(envValue(process.env, 'CONDUIT_PORT')) ?? DEFAULT_API_PORT;
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  // The renderer makes no network requests of its own; all backend traffic goes through this process.
  const csp = buildContentSecurityPolicy({ devServerOrigin });
  /**
   * Per-launch local access key: the backend accepts API calls only with it. It is shared only with the backend
   * process started below, never with the renderer, and never written to disk or logged.
   */
  const localKey = crypto.randomBytes(32).toString('base64url');
  /** The dormant account setup endpoint still needs a token; nobody receives this one. */
  const setupToken = crypto.randomBytes(32).toString('base64url');

  const logger: Logger = createLogger({
    name: 'desktop',
    level: app.isPackaged ? 'info' : 'debug',
    filePath: path.join(dataDir, 'logs', 'desktop.log'),
    console: !app.isPackaged,
  });

  let mainWindow: BrowserWindow | null = null;
  const sendToRenderer = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const localApi = new LocalApiClient(apiBaseUrl, localKey, userAgent);

  /** Platform tokens, encrypted with Windows DPAPI via safeStorage. Only ciphertext is written to disk. */
  const vault = new FileCredentialVault(path.join(dataDir, 'credentials'), {
    unavailableReason: () =>
      safeStorage.isEncryptionAvailable() ? null : 'Windows secure storage (DPAPI) is not available, so CONDUIT cannot store platform credentials safely.',
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  });

  /**
   * Starts a platform authorization: asks the backend for the authorization URL, verifies it is that platform's
   * official authorization page redirecting to CONDUIT's loopback callback, and opens it in the system browser.
   */
  async function connectPlatform(arg: unknown): Promise<ApiResult<{ started: true }>> {
    const input = connectRequestSchema.safeParse(arg);
    if (!input.success) return { ok: false, status: 400, error: INVALID_REQUEST };
    const platform = { data: input.data.platform };
    const res = await localApi.request({ method: 'POST', path: `/api/connections/${platform.data}/connect`, body: { role: input.data.role } });
    if (!res.ok) return res;
    const url = validateAuthorizationUrl(platform.data, (res.data as { authorizationUrl?: unknown } | null)?.authorizationUrl);
    if (!url) {
      logger.error('refused to open an unexpected authorization URL', { platform: platform.data });
      return { ok: false, status: 502, error: { code: 'internal_error', message: 'CONDUIT received an unexpected authorization address and did not open it.' } };
    }
    try {
      await shell.openExternal(url);
    } catch {
      return { ok: false, status: 500, error: { code: 'internal_error', message: 'CONDUIT could not open your web browser.' } };
    }
    return { ok: true, status: 200, data: { started: true } };
  }

  async function openExternal(url: string): Promise<ApiResult<{ started: true }>> {
    try {
      await shell.openExternal(url);
    } catch {
      return { ok: false, status: 500, error: { code: 'internal_error', message: 'CONDUIT could not open your web browser.' } };
    }
    return { ok: true, status: 200, data: { started: true } };
  }

  /** Adds the user's bot to a server: the backend builds Discord's add-bot URL; it is validated, then opened. */
  async function installDiscordBot(): Promise<ApiResult<{ started: true }>> {
    const res = await localApi.request({ method: 'POST', path: '/api/discord/install' });
    if (!res.ok) return res;
    const url = validateBotInstallUrl((res.data as { authorizationUrl?: unknown } | null)?.authorizationUrl);
    if (!url) {
      logger.error('refused to open an unexpected bot install URL');
      return { ok: false, status: 502, error: { code: 'internal_error', message: 'CONDUIT received an unexpected address and did not open it.' } };
    }
    return openExternal(url);
  }

  /** Opens an allow-listed Developer Portal page for the configured application (id from the backend). */
  async function openDiscordPortal(page: unknown): Promise<ApiResult<{ opened: true }>> {
    let applicationId: string | null = null;
    if (page !== 'applications') {
      const res = await localApi.request({ method: 'GET', path: '/api/discord/setup' });
      if (res.ok) applicationId = (res.data as { application?: { applicationId?: unknown } } | null)?.application?.applicationId as string | null;
    }
    const url = discordPortalUrl(page, typeof applicationId === 'string' ? applicationId : null);
    if (!url) return { ok: false, status: 400, error: INVALID_REQUEST };
    const opened = await openExternal(url);
    return opened.ok ? { ok: true, status: 200, data: { opened: true } } : opened;
  }

  // A Phase 2 desktop session is no longer used; remove its stored credential instead of leaving it at rest.
  void fs.rm(path.join(dataDir, 'session.bin'), { force: true }).catch(() => {});

  const supervisor = new BackendSupervisor({
    entry: path.join(__dirname, 'server.cjs'),
    serviceName: `${PRODUCT_NAME} Server`,
    logger: logger.child({ module: 'supervisor' }),
    env: {
      CONDUIT_HOST: '127.0.0.1',
      CONDUIT_PORT: String(port),
      CONDUIT_DATA_DIR: dataDir,
      CONDUIT_LOG_LEVEL: app.isPackaged ? 'info' : 'debug',
      CONDUIT_LOG_CONSOLE: app.isPackaged ? 'false' : 'true',
      CONDUIT_ALLOWED_ORIGINS: [APP_ORIGIN, ...(devServerOrigin ? [devServerOrigin] : [])].join(','),
      CONDUIT_SETUP_TOKEN: setupToken,
      CONDUIT_LOCAL_KEY: localKey,
    },
    onStatus: (status: BackendStatus) => sendToRenderer(IPC_CHANNELS.backendStatusChanged, status),
    onVaultRequest: (request) => handleVaultRequest(vault, request),
  });

  function registerAppProtocol(): void {
    const rendererRoot = path.join(__dirname, 'renderer');
    protocol.handle(APP_PROTOCOL, async (request) => {
      const url = new URL(request.url);
      const filePath = url.host === APP_HOST ? resolveRendererPath(rendererRoot, url.pathname) : null;
      if (!filePath) return new Response('Not found', { status: 404 });
      try {
        const body = await fs.readFile(filePath);
        return new Response(body, {
          headers: {
            'Content-Type': mimeTypeFor(filePath),
            'Content-Security-Policy': csp,
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
  }

  function hardenSessions(): void {
    const ses = session.defaultSession;
    // The dashboard needs no camera, microphone, notifications, geolocation, etc. Its only permission is writing to the
    // clipboard (Copy buttons), and only from CONDUIT's own page; reading the clipboard stays denied.
    ses.setPermissionRequestHandler((wc, permission, callback, details) =>
      callback(isPermissionAllowed(permission, details.requestingUrl ?? wc?.getURL(), devServerOrigin)),
    );
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => isPermissionAllowed(permission, requestingOrigin, devServerOrigin));

    if (devServerOrigin) {
      ses.webRequest.onHeadersReceived({ urls: [`${devServerOrigin}/*`] }, (details, callback) => {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
      });
    }

    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-navigate', (event, url) => {
        if (!isTrustedRendererUrl(url, devServerOrigin)) event.preventDefault();
      });
      contents.on('will-attach-webview', (event) => event.preventDefault());
      // Nothing opens inside the app, and the renderer cannot make CONDUIT open URLs in the system browser either:
      // the only external pages CONDUIT opens are validated platform authorization pages (see connectPlatform).
      contents.setWindowOpenHandler(({ url }) => {
        logger.warn('blocked window.open from renderer', { origin: safeOrigin(url) });
        return { action: 'deny' };
      });
    });
  }

  const INVALID_REQUEST = { code: 'bad_request', message: 'Invalid request' } as const;

  function registerIpc(): void {
    const handle = <T>(channel: string, fn: (arg: unknown) => T) => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, arg: unknown) => {
        const frame = event.senderFrame;
        if (!frame || frame.parent !== null || !isTrustedRendererUrl(frame.url, devServerOrigin)) {
          logger.warn('rejected IPC from untrusted sender', { channel, url: frame?.url });
          throw new Error('Unauthorized IPC sender');
        }
        return fn(arg);
      });
    };

    handle(IPC_CHANNELS.getAppInfo, (): AppInfo => ({ version, platform: process.platform, isPackaged: app.isPackaged, apiBaseUrl }));
    handle(IPC_CHANNELS.getBackendStatus, (): BackendStatus => supervisor.getStatus());

    // The renderer's only route to the backend: allow-listed endpoints, with the local key added here.
    handle(IPC_CHANNELS.apiRequest, (arg): Promise<ApiResult> | ApiResult => {
      const request = validateApiRequest(arg);
      if (!request) {
        logger.warn('rejected API request from renderer');
        return { ok: false, status: 400, error: INVALID_REQUEST };
      }
      return localApi.request(request);
    });

    handle(IPC_CHANNELS.connectionsConnect, (arg) => connectPlatform(arg));
    handle(IPC_CHANNELS.discordInstallBot, () => installDiscordBot());
    handle(IPC_CHANNELS.discordOpenPortal, (arg) => openDiscordPortal(arg));
    handle(IPC_CHANNELS.filesOpenLogsFolder, () => openFolder(path.join(dataDir, 'logs')));
    handle(IPC_CHANNELS.filesOpenBackupsFolder, async (): Promise<ApiResult<{ opened: true }>> => {
      // The folder comes from the backend's own settings, never from the renderer.
      const res = await localApi.request({ method: 'GET', path: '/api/backups' });
      if (!res.ok) return res;
      const directory = (res.data as { directory?: unknown } | null)?.directory;
      if (typeof directory !== 'string') return { ok: false, status: 502, error: { code: 'internal_error', message: 'The backup folder is unknown.' } };
      return openFolder(directory);
    });
    handle(IPC_CHANNELS.filesOpenClipsFolder, async (): Promise<ApiResult<{ opened: true }>> => {
      // The folder comes from the backend's own settings, never from the renderer. Created on first use.
      const res = await localApi.request({ method: 'GET', path: '/api/kick/clips' });
      if (!res.ok) return res;
      const folder = (res.data as { folder?: unknown } | null)?.folder;
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) return { ok: false, status: 502, error: { code: 'internal_error', message: 'The clips folder is unknown.' } };
      await fs.mkdir(folder, { recursive: true }).catch(() => undefined);
      return openFolder(folder);
    });
    handle(IPC_CHANNELS.filesChooseFolder, async (arg): Promise<ApiResult<{ path: string | null }>> => {
      const win = BrowserWindow.getFocusedWindow();
      const what = arg === 'clips' ? 'saved Kick clips' : 'CONDUIT backups';
      const options = { title: `Choose a folder for ${what}`, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return { ok: true, status: 200, data: { path: picked.canceled ? null : (picked.filePaths[0] ?? null) } };
    });
    handle(IPC_CHANNELS.windowSetControlsColor, (arg): void => {
      const color = validateControlsColor(arg);
      if (color && app.isPackaged) mainWindow?.setTitleBarOverlay({ color: '#00000000', symbolColor: color, height: TITLE_BAR_HEIGHT });
    });
    handle(IPC_CHANNELS.kickOpenDeveloperSettings, async (): Promise<ApiResult<{ opened: true }>> => {
      const opened = await openExternal(KICK_DEVELOPER_SETTINGS_URL);
      return opened.ok ? { ok: true, status: 200, data: { opened: true } } : opened;
    });
    handle(IPC_CHANNELS.kickOpenClip, async (arg): Promise<ApiResult<{ opened: true }>> => {
      const url = validateKickClipUrl(arg);
      if (!url) return { ok: false, status: 400, error: INVALID_REQUEST };
      const opened = await openExternal(url);
      return opened.ok ? { ok: true, status: 200, data: { opened: true } } : opened;
    });
  }

  /** Opens a folder in Explorer, only if it is an existing directory (never a file, which would run it). */
  async function openFolder(folder: string): Promise<ApiResult<{ opened: true }>> {
    try {
      if (!(await fs.stat(folder)).isDirectory()) throw new Error('not a folder');
    } catch {
      return { ok: false, status: 404, error: { code: 'not_found', message: 'That folder doesn’t exist yet.' } };
    }
    const problem = await shell.openPath(folder);
    return problem ? { ok: false, status: 500, error: { code: 'internal_error', message: 'Windows couldn’t open the folder.' } } : { ok: true, status: 200, data: { opened: true } };
  }

  async function createWindow(): Promise<void> {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 600,
      show: false,
      title: PRODUCT_NAME,
      backgroundColor: '#20201d',
      // The CONDUIT logo on the window and taskbar. The installed CONDUIT.exe carries it already; in development the
      // app runs as electron.exe, which would otherwise show Electron's icon.
      ...(app.isPackaged ? {} : { icon: path.join(__dirname, '..', 'build', 'icon.png') }),
      // Installed app: no Windows title bar. The page fills the window and the window buttons are drawn over it,
      // in the theme's colour. Development keeps the normal title bar and the menu bar (File, Edit, View, Window).
      ...(app.isPackaged ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#00000000', symbolColor: '#e9eef2', height: TITLE_BAR_HEIGHT } } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    await mainWindow.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    logger.info('quitting; stopping backend');
    void supervisor.stop().finally(() => {
      logger.info('exit');
      logger.close();
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());

  process.on('uncaughtException', (err) => logger.error('uncaught exception in main process', { err }));

  void app.whenReady().then(async () => {
    logger.info('starting', { version, packaged: app.isPackaged, dataDir, port });
    if (app.isPackaged) Menu.setApplicationMenu(null);
    registerAppProtocol();
    hardenSessions();
    registerIpc();
    supervisor.start();
    await createWindow();
  });
}

// The single-instance lock comes first: it keeps two launches from racing the data-folder migration, and in
// recovery mode it proves CONDUIT is not running.
const recovery = isRecoveryInvocation(process.argv);
if (!app.requestSingleInstanceLock()) {
  if (recovery) void refuseRecoveryWhileRunning().finally(() => app.exit(1));
  else app.quit();
} else if (recovery) {
  void app.whenReady().then(async () => {
    const code = await runRecoveryMode(process.argv, resolveDesktopDataDir()).catch((err: unknown) => {
      process.stdout.write(`Recovery failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    });
    app.exit(code);
  });
} else {
  startDesktop(resolveDesktopDataDir());
}
