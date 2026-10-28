/**
 * Alerts: short pop-up notifications ("bubbles") for things that happen while CONDUIT runs — a platform rate limiting
 * requests, an account disconnecting or coming back, a role reward that couldn't be given. Account status itself is
 * shown only on the Dashboard; alerts only tell you that something changed.
 */
import { z } from 'zod';

export type AlertLevel = 'info' | 'warn' | 'error';

export interface AlertView {
  /** Increasing; the dashboard asks for alerts after the last id it has seen. */
  id: number;
  at: string;
  level: AlertLevel;
  title: string;
  detail: string | null;
}

export interface AlertFeed {
  alerts: AlertView[];
  /** The newest alert id (0 when there are none yet). */
  latestId: number;
}

/** after: the last id already shown; null on first load (returns no old alerts, only the latest id). */
export const alertQuerySchema = z.strictObject({ after: z.number().int().min(0).nullable().default(null) });
