import { z } from 'zod';

/** GET /api/health */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  time: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  database: z.object({
    ok: z.boolean(),
    schemaVersion: z.number().int().nonnegative(),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ── realtime (/ws) ──────────────────────────────────────────────────────────

/**
 * Messages a client may send. Strict objects: identity always comes from the authenticated session, never
 * from message fields, so extra keys such as a spoofed `userId` or `role` are rejected.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('subscribe'), profileId: z.uuid() }),
  z.strictObject({ type: z.literal('unsubscribe'), profileId: z.uuid() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Messages the server pushes to authenticated clients. */
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.string(), serverTime: z.string(), userId: z.string() }),
  z.object({ type: z.literal('subscribed'), profileId: z.string() }),
  z.object({
    type: z.literal('unsubscribed'),
    profileId: z.string(),
    reason: z.enum(['requested', 'access_revoked']),
  }),
  z.object({ type: z.literal('profile.updated'), profileId: z.string() }),
  z.object({ type: z.literal('members.changed'), profileId: z.string() }),
  z.object({
    type: z.literal('error'),
    code: z.enum(['bad_request', 'not_found']),
    message: z.string(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** WebSocket close codes used by the server (4000–4999 is the application range). */
export const WS_CLOSE = {
  /** The session was revoked, expired, or its account was disabled. */
  sessionInvalid: 4401,
  /** Too many malformed messages. */
  policyViolation: 1008,
  goingAway: 1001,
} as const;

// ── errors ──────────────────────────────────────────────────────────────────

export const API_ERROR_CODES = [
  'bad_request',
  'validation_error',
  'unauthorized',
  'forbidden',
  'password_change_required',
  'not_found',
  'conflict',
  'rate_limited',
  'not_implemented',
  'not_configured',
  'internal_error',
  'service_unavailable',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    /** Field-level validation problems; paths and messages only, never submitted values. */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorBody = ApiError['error'];
