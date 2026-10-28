/**
 * Runs in the sandboxed preload context. Exposes only the narrow, typed ConduitBridge to the
 * renderer — no ipcRenderer, Node.js, filesystem, database or credential access.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
// Deep import keeps zod and other shared code out of the preload bundle.
import { IPC_CHANNELS, type BackendStatus, type ConduitBridge } from '@conduit/shared/app/desktop-bridge';

const bridge: ConduitBridge = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getBackendStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getBackendStatus),
  onBackendStatus: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const handler = (_event: IpcRendererEvent, status: BackendStatus) => listener(status);
    ipcRenderer.on(IPC_CHANNELS.backendStatusChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.backendStatusChanged, handler);
    };
  },
  api: {
    request: (request) => ipcRenderer.invoke(IPC_CHANNELS.apiRequest, request),
  },
  connections: {
    connect: (platform, role) => ipcRenderer.invoke(IPC_CHANNELS.connectionsConnect, { platform, role: role ?? 'primary' }),
  },
  kick: {
    openDeveloperSettings: () => ipcRenderer.invoke(IPC_CHANNELS.kickOpenDeveloperSettings),
    openClip: (url) => ipcRenderer.invoke(IPC_CHANNELS.kickOpenClip, url),
  },
  discord: {
    installBot: () => ipcRenderer.invoke(IPC_CHANNELS.discordInstallBot),
    openPortal: (page) => ipcRenderer.invoke(IPC_CHANNELS.discordOpenPortal, page),
  },
  files: {
    openLogsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.filesOpenLogsFolder),
    openBackupsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.filesOpenBackupsFolder),
    openClipsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.filesOpenClipsFolder),
    chooseFolder: (purpose) => ipcRenderer.invoke(IPC_CHANNELS.filesChooseFolder, purpose === 'clips' ? 'clips' : 'backups'),
  },
  window: {
    setControlsColor: (color) => ipcRenderer.invoke(IPC_CHANNELS.windowSetControlsColor, color),
  },
};

contextBridge.exposeInMainWorld('conduit', bridge);
