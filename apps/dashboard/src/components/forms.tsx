import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
import { useId } from 'react';
import { ApiClientError, errorMessage } from '../api';
import { useAppearance } from '../theme/appearance';
import { resolveTheme } from '../theme/registry';
import { ThemeSprite } from '../theme/ThemeSprite';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}

export function Field({ label, value, onChange, error, hint, ...input }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {error ? (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

interface SelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
}

export function Select({ label, value, onChange, options, disabled }: SelectProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Button({
  variant = 'primary',
  busy,
  disabled,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`btn btn-${variant}${className ? ` ${className}` : ''}`}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}

/** Banner for a request-level error (validation details are shown on the fields themselves). */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiClientError && error.code === 'validation_error' ? 'Please fix the highlighted fields.' : errorMessage(error);
  return (
    <div className="banner banner-error" role="alert">
      {message}
    </div>
  );
}

/** Field error from either a client-side check or the server's validation response. */
export function fieldError(field: string, clientErrors: Record<string, string>, serverError: unknown): string | undefined {
  if (clientErrors[field]) return clientErrors[field];
  return serverError instanceof ApiClientError ? serverError.fieldError(field) : undefined;
}

/**
 * Flattens a zod safeParse failure into { field: message }, the first issue per field. Fields are keyed like the
 * server's validation issues ("activity.url"); an issue about the whole form is under "".
 */
export function issuesToFieldErrors(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) out[issue.path.map(String).join('.')] ??= issue.message;
  return out;
}

/** Field errors from a shared schema (the same rules the backend applies), keyed like issuesToFieldErrors. */
export function schemaFieldErrors(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } } },
  value: unknown,
): Record<string, string> {
  const r = schema.safeParse(value);
  return r.success ? {} : issuesToFieldErrors(r.error?.issues ?? []);
}

/**
 * A page's loading state, centred in the page: a spinner (or the theme's walking character, large) with what is loading
 * underneath (announced to screen readers).
 */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  const { applied, preview } = useAppearance();
  const walker = resolveTheme((preview ?? applied).themeId).art?.walk;
  return (
    <div className="loading muted" role="status">
      {walker ? <ThemeSprite art={walker} className="loading-walker" /> : <span className="spinner" aria-hidden="true" />}
      <span className="loading-label">{label}</span>
    </div>
  );
}
