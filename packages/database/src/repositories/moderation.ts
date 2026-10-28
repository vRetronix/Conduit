import { execute, queryAll, queryOne, type Database } from '../sqlite';

export type ModerationActionKind = 'timeout' | 'untimeout' | 'ban' | 'unban' | 'delete_message' | 'flag';

/** The rules of Kick's automated protection (and raid mode), as stored. */
export type ModerationRuleName = 'blocked_terms' | 'repeat' | 'spam' | 'caps' | 'links' | 'emotes' | 'long_message' | 'symbols' | 'raid';

/**
 * One moderation action taken (or attempted) through CONDUIT, or (source 'platform') done on Kick itself, from Kick's
 * moderation.banned events.
 */
export interface ModerationRecord {
  id: string;
  createdAt: string;
  platform: 'discord' | 'kick';
  placeId: string | null;
  placeName: string | null;
  action: ModerationActionKind;
  targetUserId: string;
  targetName: string | null;
  messageId: string | null;
  durationSeconds: number | null;
  reason: string | null;
  source: 'manual' | 'automod' | 'platform';
  actor: string | null;
  rule: ModerationRuleName | null;
  outcome: 'success' | 'failed' | 'logged';
  detail: string | null;
}

interface Row {
  id: string;
  created_at: string;
  platform: ModerationRecord['platform'];
  place_id: string | null;
  place_name: string | null;
  action: ModerationActionKind;
  target_user_id: string;
  target_name: string | null;
  message_id: string | null;
  duration_seconds: number | null;
  reason: string | null;
  source: ModerationRecord['source'];
  actor: string | null;
  rule: ModerationRecord['rule'];
  outcome: ModerationRecord['outcome'];
  detail: string | null;
}

const COLUMNS =
  'id, created_at, platform, place_id, place_name, action, target_user_id, target_name, message_id, duration_seconds, reason, source, actor, rule, outcome, detail';

const cap = (s: string | null, n: number): string | null => (s === null ? null : s.slice(0, n));

function toRecord(r: Row): ModerationRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    platform: r.platform,
    placeId: r.place_id,
    placeName: r.place_name,
    action: r.action,
    targetUserId: r.target_user_id,
    targetName: r.target_name,
    messageId: r.message_id,
    durationSeconds: r.duration_seconds,
    reason: r.reason,
    source: r.source,
    actor: r.actor,
    rule: r.rule,
    outcome: r.outcome,
    detail: r.detail,
  };
}

export const moderationRepo = {
  insert(db: Database, r: ModerationRecord): void {
    execute(
      db,
      `INSERT INTO moderation_actions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.createdAt,
      r.platform,
      r.placeId,
      cap(r.placeName, 100),
      r.action,
      r.targetUserId,
      cap(r.targetName, 100),
      r.messageId,
      r.durationSeconds,
      cap(r.reason, 200),
      r.source,
      cap(r.actor, 100),
      r.rule,
      r.outcome,
      cap(r.detail, 300),
    );
  },

  /** Newest first; optionally one platform only. */
  list(db: Database, limit = 100, platform?: ModerationRecord['platform']): ModerationRecord[] {
    const n = Math.min(Math.max(limit, 1), 500);
    const rows = platform
      ? queryAll<Row>(db, `SELECT ${COLUMNS} FROM moderation_actions WHERE platform = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, platform, n)
      : queryAll<Row>(db, `SELECT ${COLUMNS} FROM moderation_actions ORDER BY created_at DESC, rowid DESC LIMIT ?`, n);
    return rows.map(toRecord);
  },

  count(db: Database): number {
    return queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM moderation_actions')?.n ?? 0;
  },

  /** Everything recorded for one user on one platform, newest first. */
  listForUser(db: Database, platform: ModerationRecord['platform'], userId: string, limit = 200): ModerationRecord[] {
    const n = Math.min(Math.max(limit, 1), 500);
    return queryAll<Row>(db, `SELECT ${COLUMNS} FROM moderation_actions WHERE platform = ? AND target_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, platform, userId, n).map(toRecord);
  },

  /** Whether CONDUIT itself (not the platform) did one of these actions to the user since a time (to skip echoes). */
  conduitActedSince(db: Database, platform: ModerationRecord['platform'], userId: string, actions: ModerationActionKind[], sinceIso: string): boolean {
    if (actions.length === 0) return false;
    const marks = actions.map(() => '?').join(', ');
    return (
      queryOne<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM moderation_actions WHERE platform = ? AND target_user_id = ? AND source != 'platform' AND outcome = 'success' AND action IN (${marks}) AND created_at >= ?`,
        platform,
        userId,
        ...actions,
        sinceIso,
      )?.n ?? 0
    ) > 0;
  },
};
