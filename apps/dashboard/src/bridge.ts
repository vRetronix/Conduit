import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';

declare global {
  interface Window {
    /** Provided by the Electron preload script; absent when the page is opened in a normal browser. */
    conduit?: ConduitBridge;
  }
}

export const bridge: ConduitBridge | null = (typeof window !== 'undefined' && window.conduit) || null;
