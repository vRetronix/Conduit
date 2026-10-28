import type { BackendStatus } from '@conduit/shared/app/desktop-bridge';

const LABELS: Record<BackendStatus['state'], string> = {
  starting: 'Backend starting',
  running: 'Backend running',
  restarting: 'Backend restarting',
  stopping: 'Backend stopping',
  stopped: 'Backend stopped',
  failed: 'Backend failed',
};

const TONES: Record<BackendStatus['state'], 'ok' | 'warn' | 'bad'> = {
  starting: 'warn',
  running: 'ok',
  restarting: 'warn',
  stopping: 'warn',
  stopped: 'bad',
  failed: 'bad',
};

export function StatusPill({ status }: { status: BackendStatus | null }) {
  if (!status) return <span className="pill pill-warn">Backend unknown</span>;
  return (
    <span className={`pill pill-${TONES[status.state]}`} role="status">
      {LABELS[status.state]}
    </span>
  );
}
