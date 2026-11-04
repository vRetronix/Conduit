import type { BackendStatus } from '@conduit/shared/app/desktop-bridge';

const LABELS: Record<Exclude<BackendStatus['state'], 'running'>, string> = {
  starting: 'Backend starting',
  restarting: 'Backend restarting',
  stopping: 'Backend stopping',
  stopped: 'Backend stopped',
  failed: 'Backend failed',
};

/** Shown only while the backend isn't running; when everything works there is nothing to say. */
export function StatusPill({ status }: { status: BackendStatus | null }) {
  if (status?.state === 'running') return null;
  if (!status) return <span className="pill pill-warn">Backend unknown</span>;
  const bad = status.state === 'stopped' || status.state === 'failed';
  return (
    <span className={`pill ${bad ? 'pill-bad' : 'pill-warn'}`} role="status">
      {LABELS[status.state]}
    </span>
  );
}
