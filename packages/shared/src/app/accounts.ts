/**
 * Account, session and streamer-profile contracts: request validation schemas (enforced by the server,
 * reused by the dashboard for form feedback) and response shapes.
 */
import { z } from 'zod';

export const SYSTEM_ROLES = ['admin', 'user'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const PROFILE_ROLES = ['owner', 'admin', 'member'] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

/** Roles that can be granted through membership management. Ownership changes only via transfer. */
export const ASSIGNABLE_ROLES = ['admin', 'member'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

// ── field schemas ───────────────────────────────────────────────────────────

/** Canonical form of a login name: Unicode-normalized, trimmed, lower-case. */
export function normalizeUsername(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const usernameSchema = z
  .string()
  .max(64)
  .transform(normalizeUsername)
  .pipe(
    z
      .string()
      .regex(
        USERNAME_PATTERN,
        'Use 3–32 characters: letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.',
      ),
  );

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(64, 'Use at most 64 characters')
  .refine((v) => !CONTROL_CHARS.test(v), 'Contains unsupported characters');

/** Length-only rules (NIST SP 800-63B): no composition requirements. */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

const submittedPasswordSchema = z.string().min(1, 'Required').max(PASSWORD_MAX_LENGTH);

export const idSchema = z.uuid();

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'Use lower-case letters, numbers and dashes (max 40)');

export const accentColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #7c5cff')
  .transform((v) => v.toLowerCase());

export const commandPrefixSchema = z
  .string()
  .regex(/^[^\s\p{C}]{1,3}$/u, 'Use 1–3 visible characters, no spaces');

// ── requests ────────────────────────────────────────────────────────────────
// All request objects are strict: unknown keys (e.g. a smuggled "role" or "userId") are rejected.

export const setupRequestSchema = z.strictObject({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: newPasswordSchema,
  profileDisplayName: displayNameSchema,
});
export type SetupRequest = z.input<typeof setupRequestSchema>;

export const loginRequestSchema = z.strictObject({
  username: z.string().min(1, 'Required').max(64).transform(normalizeUsername),
  password: submittedPasswordSchema,
});
export type LoginRequest = z.input<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: submittedPasswordSchema,
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.input<typeof changePasswordRequestSchema>;

export const createProfileRequestSchema = z.strictObject({
  displayName: displayNameSchema,
  slug: slugSchema.optional(),
  botDisplayName: displayNameSchema.optional(),
  commandPrefix: commandPrefixSchema.optional(),
  accentColor: accentColorSchema.optional(),
});
export type CreateProfileRequest = z.input<typeof createProfileRequestSchema>;

export const updateProfileRequestSchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    botDisplayName: displayNameSchema.optional(),
    commandPrefix: commandPrefixSchema.optional(),
    accentColor: accentColorSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');
export type UpdateProfileRequest = z.input<typeof updateProfileRequestSchema>;

export const addMemberRequestSchema = z.strictObject({
  username: z.string().min(1, 'Required').max(64).transform(normalizeUsername),
  role: z.enum(ASSIGNABLE_ROLES),
});
export type AddMemberRequest = z.input<typeof addMemberRequestSchema>;

export const updateMemberRequestSchema = z.strictObject({ role: z.enum(ASSIGNABLE_ROLES) });
export type UpdateMemberRequest = z.input<typeof updateMemberRequestSchema>;

export const transferOwnershipRequestSchema = z.strictObject({ userId: idSchema });
export type TransferOwnershipRequest = z.input<typeof transferOwnershipRequestSchema>;

export const adminCreateUserRequestSchema = z.strictObject({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: newPasswordSchema,
});
export type AdminCreateUserRequest = z.input<typeof adminCreateUserRequestSchema>;

export const adminUpdateUserRequestSchema = z.strictObject({ status: z.enum(USER_STATUSES) });
export type AdminUpdateUserRequest = z.input<typeof adminUpdateUserRequestSchema>;

export const adminResetPasswordRequestSchema = z.strictObject({ password: newPasswordSchema });
export type AdminResetPasswordRequest = z.input<typeof adminResetPasswordRequestSchema>;

// ── responses ───────────────────────────────────────────────────────────────

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  systemRole: SystemRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  /**
   * The password was set by offline recovery and must be replaced. Until it is, the API allows only reading the
   * current session, changing the password, and signing out (everything else returns `password_change_required`).
   */
  mustChangePassword: boolean;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  clientName: string | null;
  current: boolean;
}

/** Returned by setup and login. Only the desktop main process ever sees `token`. */
export interface AuthResponse {
  token: string;
  user: CurrentUser;
  session: SessionInfo;
}

export interface CurrentSessionResponse {
  user: CurrentUser;
  session: SessionInfo;
}

export interface SetupStatusResponse {
  setupRequired: boolean;
}

export interface Profile {
  id: string;
  slug: string;
  displayName: string;
  botDisplayName: string;
  commandPrefix: string;
  accentColor: string;
  /** The caller's effective role in this profile. */
  role: ProfileRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileMember {
  userId: string;
  username: string;
  displayName: string;
  status: UserStatus;
  role: ProfileRole;
  since: string;
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  systemRole: SystemRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}
