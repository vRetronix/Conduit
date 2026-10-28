/**
 * Contract for the narrow API the Electron preload script exposes to the renderer as `window.conduit`.
 * The renderer has no Node.js access and no network access (CSP connect-src 'none'). Everything it can ask the
 * main process for is listed here.
 *
 * Since Phase 2.3 there is no CONDUIT sign-in on the desktop. The main process attaches the per-launch local
 * access key to backend requests; the key never crosses this bridge. The renderer can reach only an allow-listed
 * set of API endpoints (apps/desktop/src/ipc-validation.ts).
 */
import type { ApiErrorBody } from './protocol';

export const IPC_CHANNELS = {
  getAppInfo: 'conduit:get-app-info',
  getBackendStatus: 'conduit:get-backend-status',
  backendStatusChanged: 'conduit:backend-status-changed',
  apiRequest: 'conduit:api:request',
  connectionsConnect: 'conduit:connections:connect',
  discordInstallBot: 'conduit:discord:install-bot',
  discordOpenPortal: 'conduit:discord:open-portal',
  kickOpenDeveloperSettings: 'conduit:kick:open-developer-settings',
  kickOpenClip: 'conduit:kick:open-clip',
  filesOpenLogsFolder: 'conduit:files:open-logs-folder',
  filesOpenBackupsFolder: 'conduit:files:open-backups-folder',
  filesOpenClipsFolder: 'conduit:files:open-clips-folder',
  filesChooseFolder: 'conduit:files:choose-folder',
  windowSetControlsColor: 'conduit:window:set-controls-color',
} as const;

export interface AppInfo {
  version: string;
  platform: string;
  isPackaged: boolean;
  /** Displayed for diagnostics only; the renderer cannot connect to it. */
  apiBaseUrl: string;
}

export type BackendState = 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'failed';

export interface BackendStatus {
  state: BackendState;
  /** Number of automatic restarts since the app started. */
  restarts: number;
  /** Human-readable reason for the last failure, if any. Never contains secrets. */
  lastError: string | null;
}

export type ApiResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiErrorBody };

export const API_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export interface ApiRequest {
  method: ApiMethod;
  /** Path under /api/. Only allow-listed endpoints are reachable (see apps/desktop/src/ipc-validation.ts). */
  path: string;
  body?: unknown;
}

/** What the renderer can do. */
export interface ConduitBridge {
  getAppInfo(): Promise<AppInfo>;
  getBackendStatus(): Promise<BackendStatus>;
  /** Subscribes to backend status changes; returns an unsubscribe function. */
  onBackendStatus(listener: (status: BackendStatus) => void): () => void;

  /** Call to an allow-listed local API endpoint; the main process attaches the local access key. */
  api: {
    request<T = unknown>(request: ApiRequest): Promise<ApiResult<T>>;
  };

  connections: {
    /**
     * Starts the official authorization for a platform: the main process asks the backend for the authorization
     * URL, checks it against that platform's known authorization page, and opens it in the user's browser.
     * The renderer never sees the URL, codes or tokens. Resolves once the browser has been opened.
     * `role` 'bot' connects a separate chatbot account (Kick); the default is the streamer's own account.
     */
    connect(platform: string, role?: 'primary' | 'bot'): Promise<ApiResult<{ started: true }>>;
  };

  kick: {
    /** Opens Kick's developer settings (where the user creates their own Kick app) in the browser. Fixed URL. */
    openDeveloperSettings(): Promise<ApiResult<{ opened: true }>>;
    /** Opens a clip's page on kick.com in the browser (only kick.com clip addresses are accepted). */
    openClip?(url: string): Promise<ApiResult<{ opened: true }>>;
  };

  discord: {
    /** Opens Discord's "add bot to server" page for the user's own application (URL validated by the main process). */
    installBot(): Promise<ApiResult<{ started: true }>>;
    /** Opens an allow-listed Discord Developer Portal page in the browser. */
    openPortal(page: string): Promise<ApiResult<{ opened: true }>>;
  };

  /**
   * Settings → Backup & Logs. The renderer never names a path to open: the main process opens its own logs folder,
   * or the backup folder the backend reports. Optional: absent outside the desktop app.
   */
  files?: {
    openLogsFolder(): Promise<ApiResult<{ opened: true }>>;
    openBackupsFolder(): Promise<ApiResult<{ opened: true }>>;
    /** Kick → Clips: the folder saved clips are in. */
    openClipsFolder?(): Promise<ApiResult<{ opened: true }>>;
    /** Folder picker (for backups, or for saved clips); `path` is null when cancelled. */
    chooseFolder(purpose?: 'backups' | 'clips'): Promise<ApiResult<{ path: string | null }>>;
  };

  /**
   * The installed app has no title bar of its own: the page reaches the top of the window and the window buttons are
   * drawn over it. This sets their colour to match the theme (#rrggbb). Optional: absent outside the desktop app.
   */
  window?: {
    setControlsColor(color: string): Promise<void>;
  };
}
