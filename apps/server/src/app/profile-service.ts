import crypto from 'node:crypto';
import { profilesRepo, usersRepo, withTransaction, type Database, type ProfileRecord } from '@conduit/database';
import {
  addMemberRequestSchema,
  createProfileRequestSchema,
  transferOwnershipRequestSchema,
  updateMemberRequestSchema,
  updateProfileRequestSchema,
  type Profile,
  type ProfileMember,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { requireMemberAction, requireProfileAccess, type Principal } from '../authz';
import { conflict, notFound } from '../errors';
import type { EventBus } from '../events';
import { parseInput } from '../validation';
import { toMember, toProfile } from './mappers';

export const PROFILE_DEFAULTS = { commandPrefix: '!', accentColor: '#7c5cff' } as const;

/** "Retro's Stream!" → "retros-stream". Never empty. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'profile';
}

/** Inserts a profile owned by `ownerUserId`. Must run inside the caller's transaction. */
export function insertProfile(
  db: Database,
  input: {
    ownerUserId: string;
    displayName: string;
    slug?: string;
    botDisplayName?: string;
    commandPrefix?: string;
    accentColor?: string;
  },
  nowIso: string,
): ProfileRecord {
  let slug = input.slug;
  if (slug !== undefined) {
    if (profilesRepo.slugExists(db, slug)) throw conflict('That slug is already in use');
  } else {
    const base = slugify(input.displayName);
    slug = base;
    for (let n = 2; profilesRepo.slugExists(db, slug); n++) slug = `${base}-${n}`;
  }
  const record = {
    id: crypto.randomUUID(),
    slug,
    displayName: input.displayName,
    botDisplayName: input.botDisplayName ?? input.displayName,
    commandPrefix: input.commandPrefix ?? PROFILE_DEFAULTS.commandPrefix,
    accentColor: input.accentColor ?? PROFILE_DEFAULTS.accentColor,
    ownerUserId: input.ownerUserId,
    createdBy: input.ownerUserId,
  };
  profilesRepo.insert(db, { ...record, now: nowIso });
  return { ...record, createdAt: nowIso, updatedAt: nowIso };
}

/**
 * Streamer profiles and their memberships. Every method authorizes through authz.ts inside the same
 * transaction as its writes, so the decision and the change see the same database state.
 */
export class ProfileService {
  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
    private readonly now: () => Date,
  ) {}

  list(principal: Principal): Profile[] {
    return profilesRepo.listForUser(this.db, principal.user.id).map(toProfile);
  }

  create(principal: Principal, input: unknown): Profile {
    const data = parseInput(createProfileRequestSchema, input);
    const now = this.now();
    return withTransaction(this.db, () => {
      const record = insertProfile(this.db, { ...data, ownerUserId: principal.user.id }, now.toISOString());
      writeAudit(this.db, { action: 'profile.created', outcome: 'success', actorUserId: principal.user.id, profileId: record.id }, now);
      return toProfile({ ...record, role: 'owner' });
    });
  }

  get(principal: Principal, profileId: string): Profile {
    return toProfile(requireProfileAccess(this.db, principal, profileId, 'profile.read'));
  }

  update(principal: Principal, profileId: string, input: unknown): Profile {
    const patch = parseInput(updateProfileRequestSchema, input);
    const now = this.now();
    const updated = withTransaction(this.db, () => {
      requireProfileAccess(this.db, principal, profileId, 'profile.update');
      profilesRepo.update(this.db, profileId, patch, now.toISOString());
      writeAudit(
        this.db,
        {
          action: 'profile.updated',
          outcome: 'success',
          actorUserId: principal.user.id,
          profileId,
          metadata: { fields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined) },
        },
        now,
      );
      return profilesRepo.findForUser(this.db, profileId, principal.user.id)!;
    });
    this.events.emit('profile.updated', { profileId });
    return toProfile(updated);
  }

  listMembers(principal: Principal, profileId: string): ProfileMember[] {
    requireProfileAccess(this.db, principal, profileId, 'members.read');
    return profilesRepo.listMembers(this.db, profileId).map(toMember);
  }

  addMember(principal: Principal, profileId: string, input: unknown): ProfileMember {
    const data = parseInput(addMemberRequestSchema, input);
    const now = this.now();
    const member = withTransaction(this.db, () => {
      const profile = requireProfileAccess(this.db, principal, profileId, 'members.manage');
      requireMemberAction(profile, { kind: 'add', newRole: data.role });
      const target = usersRepo.findByUsername(this.db, data.username);
      if (!target) throw notFound('User');
      if (target.status !== 'active') throw conflict('That account is disabled');
      if (profilesRepo.roleOf(this.db, profileId, target.id) !== null) throw conflict('That user is already a member');
      profilesRepo.addMembership(this.db, { profileId, userId: target.id, role: data.role, addedBy: principal.user.id, now: now.toISOString() });
      writeAudit(
        this.db,
        { action: 'member.added', outcome: 'success', actorUserId: principal.user.id, targetUserId: target.id, profileId, metadata: { role: data.role } },
        now,
      );
      return profilesRepo.listMembers(this.db, profileId).find((m) => m.userId === target.id)!;
    });
    this.events.emit('membership.changed', { profileId, userIds: [member.userId] });
    return toMember(member);
  }

  changeRole(principal: Principal, profileId: string, userId: string, input: unknown): ProfileMember {
    const { role } = parseInput(updateMemberRequestSchema, input);
    const now = this.now();
    const member = withTransaction(this.db, () => {
      const profile = requireProfileAccess(this.db, principal, profileId, 'members.manage');
      const targetRole = profilesRepo.roleOf(this.db, profileId, userId);
      if (targetRole === null) throw notFound('Member');
      requireMemberAction(profile, { kind: 'changeRole', targetRole, newRole: role, isSelf: userId === principal.user.id });
      if (targetRole !== role) {
        profilesRepo.setMembershipRole(this.db, profileId, userId, role, now.toISOString());
        writeAudit(
          this.db,
          { action: 'member.role_changed', outcome: 'success', actorUserId: principal.user.id, targetUserId: userId, profileId, metadata: { from: targetRole, to: role } },
          now,
        );
      }
      return profilesRepo.listMembers(this.db, profileId).find((m) => m.userId === userId)!;
    });
    this.events.emit('membership.changed', { profileId, userIds: [userId] });
    return toMember(member);
  }

  /** Removes a member, or lets the caller leave. The owner can be removed by no one. */
  removeMember(principal: Principal, profileId: string, userId: string): void {
    const now = this.now();
    withTransaction(this.db, () => {
      const profile = requireProfileAccess(this.db, principal, profileId, 'profile.read');
      const targetRole = profilesRepo.roleOf(this.db, profileId, userId);
      if (targetRole === null) throw notFound('Member');
      const isSelf = userId === principal.user.id;
      requireMemberAction(profile, { kind: 'remove', targetRole, isSelf });
      profilesRepo.removeMembership(this.db, profileId, userId);
      writeAudit(
        this.db,
        { action: 'member.removed', outcome: 'success', actorUserId: principal.user.id, targetUserId: userId, profileId, metadata: { role: targetRole, left: isSelf } },
        now,
      );
    });
    this.events.emit('membership.changed', { profileId, userIds: [userId] });
  }

  /** Hands ownership to an existing admin/member; the previous owner stays on as admin. */
  transferOwnership(principal: Principal, profileId: string, input: unknown): Profile {
    const { userId: newOwnerId } = parseInput(transferOwnershipRequestSchema, input);
    const now = this.now();
    const iso = now.toISOString();
    const profile = withTransaction(this.db, () => {
      const current = requireProfileAccess(this.db, principal, profileId, 'profile.transferOwnership');
      const targetRole = profilesRepo.roleOf(this.db, profileId, newOwnerId);
      if (targetRole === null) throw notFound('Member');
      requireMemberAction(current, { kind: 'transferOwnership', targetRole, isSelf: newOwnerId === principal.user.id });
      const target = usersRepo.findById(this.db, newOwnerId);
      if (!target || target.status !== 'active') throw conflict('That account is disabled');

      // Order matters for the schema's triggers: the new owner must not hold a membership when ownership moves.
      profilesRepo.removeMembership(this.db, profileId, newOwnerId);
      profilesRepo.setOwner(this.db, profileId, newOwnerId, iso);
      profilesRepo.addMembership(this.db, { profileId, userId: principal.user.id, role: 'admin', addedBy: newOwnerId, now: iso });
      writeAudit(
        this.db,
        { action: 'profile.ownership_transferred', outcome: 'success', actorUserId: principal.user.id, targetUserId: newOwnerId, profileId },
        now,
      );
      return profilesRepo.findForUser(this.db, profileId, principal.user.id)!;
    });
    this.events.emit('membership.changed', { profileId, userIds: [principal.user.id, newOwnerId] });
    return toProfile(profile);
  }
}
