import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { Platform } from '@conduit/shared/app/connections';
import { Button } from './forms';
import { PlatformIcon } from './PlatformIcon';

/**
 * The shared shell of every platform setup wizard (Discord, Kick): dialog, header, numbered step list, the current
 * step's title and description, and Back / Continue / Done. Each platform supplies only its steps and their content,
 * so both setups look and behave the same while keeping their own workflows.
 */

export interface WizardStep<T extends string> {
  id: T;
  label: string;
  /** One line under the step title. */
  description: string;
  /** Verified complete (from backend state, never from having clicked through). */
  complete: boolean;
  /** Whether the user may open it yet (earlier steps it depends on are done). */
  reachable: boolean;
}

export interface SetupWizardProps<T extends string> {
  platform: Platform;
  title: string;
  steps: ReadonlyArray<WizardStep<T>>;
  current: T;
  onStep: (step: T) => void;
  onClose: () => void;
  children: ReactNode;
  /** Hide Continue on a step that moves on by itself (e.g. after a successful save). */
  hideContinue?: boolean;
}

export function SetupWizard<T extends string>({ platform, title, steps, current, onStep, onClose, children, hideContinue }: SetupWizardProps<T>) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const index = Math.max(0, steps.findIndex((s) => s.id === current));
  const step = steps[index]!;
  const prev = steps[index - 1];
  const next = steps[index + 1];
  const last = index === steps.length - 1;

  // Focus the dialog once when it opens (not on every poll, which would pull focus out of fields); Escape closes.
  useEffect(() => {
    dialog.current?.focus();
  }, []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="modal-backdrop">
      <div className="modal wizard" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog}>
        <header className="wizard-head">
          <PlatformIcon platform={platform} size={32} />
          <div className="wizard-title">
            <h2 id={titleId}>{title}</h2>
            <span className="muted small">
              Step {index + 1} of {steps.length} · {step.label}
            </span>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label={`Close ${title}`}>
            Close
          </Button>
        </header>

        <ol className="wizard-steps" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s.id} className={`${s.id === current ? 'current' : ''} ${s.complete ? 'complete' : ''}`}>
              <button type="button" disabled={!s.reachable} aria-current={s.id === current ? 'step' : undefined} onClick={() => onStep(s.id)}>
                <span className="step-number">{s.complete ? '✓' : i + 1}</span> {s.label}
              </button>
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          <div className="step-intro">
            <h3 className="step-title">{step.label}</h3>
            <p className="muted small">{step.description}</p>
          </div>
          {children}
        </div>

        <footer className="wizard-foot">
          {prev && (
            <Button variant="secondary" onClick={() => onStep(prev.id)}>
              Back
            </Button>
          )}
          <span className="spacer" />
          {last ? (
            <Button onClick={onClose}>{step.complete ? 'Finish' : 'Close'}</Button>
          ) : (
            !hideContinue &&
            next && (
              <Button disabled={!step.complete || !next.reachable} onClick={() => onStep(next.id)}>
                Continue
              </Button>
            )
          )}
        </footer>
      </div>
    </div>
  );
}

/** A labelled fact in a setup summary (User Account, Bot, Server…): verified value or the incomplete state. */
export function SummaryItem({ label, ok, children }: { label: string; ok: boolean; children: ReactNode }) {
  return (
    <div className={`summary-item${ok ? ' summary-ok' : ''}`}>
      <span className="summary-label">{label}</span>
      <span className="summary-value">{children}</span>
    </div>
  );
}
