import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, BackendStatus } from '@conduit/shared/app/desktop-bridge';
import { bridge } from './bridge';

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void bridge?.getAppInfo().then(setInfo);
  }, []);
  return info;
}

export function useBackendStatus(): BackendStatus | null {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onBackendStatus((s) => active && setStatus(s));
    void bridge.getBackendStatus().then((s) => active && setStatus((prev) => prev ?? s));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return status;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Runs `fn` when deps change; `reload` re-runs it. Stale results are discarded. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    fn().then(
      (value) => {
        if (!current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!current) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}

/**
 * Refreshes after `ms` (pass the latest result in deps, so each result schedules the next refresh). Paused while the
 * window is hidden (minimized or covered): nothing is fetched then, and it refreshes as soon as it is visible again.
 * The backend keeps working either way; this only saves the dashboard's own requests and renders.
 */
export function usePolling(reload: () => void, ms: number, deps: readonly unknown[]): void {
  useEffect(() => {
    if (typeof document !== 'undefined' && document.hidden) {
      const onVisible = () => {
        if (!document.hidden) reload();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => document.removeEventListener('visibilitychange', onVisible);
    }
    const timer = setTimeout(reload, ms);
    return () => clearTimeout(timer);
  }, [...deps, reload, ms]);
}
