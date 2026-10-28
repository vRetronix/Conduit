import { execute, queryAll, queryOne, type Database } from '../sqlite';

// ── saved embeds ─────────────────────────────────────────────────────────────

export interface SavedEmbedRecord {
  id: string;
  name: string;
  embed: string;
  createdAt: string;
  updatedAt: string;
}

export const savedEmbedsRepo = {
  list(db: Database): SavedEmbedRecord[] {
    return queryAll<SavedEmbedRecord>(db, 'SELECT id, name, embed, created_at AS createdAt, updated_at AS updatedAt FROM saved_embeds ORDER BY name, id');
  },
  insert(db: Database, r: SavedEmbedRecord): void {
    execute(db, 'INSERT INTO saved_embeds (id, name, embed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', r.id, r.name, r.embed, r.createdAt, r.updatedAt);
  },
  update(db: Database, id: string, name: string, embed: string, at: string): boolean {
    return execute(db, 'UPDATE saved_embeds SET name = ?, embed = ?, updated_at = ? WHERE id = ?', name, embed, at, id) > 0;
  },
  delete(db: Database, id: string): boolean {
    return execute(db, 'DELETE FROM saved_embeds WHERE id = ?', id) > 0;
  },
};

// ── timed messages ───────────────────────────────────────────────────────────

export interface TimedMessageRecord {
  id: string;
  enabled: boolean;
  config: string;
  lastSentAt: string | null;
  enabledAt: string | null;
  recent: string;
  /** Chat messages counted towards the "after N messages" interval since the last post (stored: survives restarts). */
  messagesSince: number;
  createdAt: string;
  updatedAt: string;
}

interface TimedRow {
  id: string;
  enabled: number;
  config: string;
  last_sent_at: string | null;
  enabled_at: string | null;
  recent: string;
  messages_since: number;
  created_at: string;
  updated_at: string;
}

const timed = (r: TimedRow): TimedMessageRecord => ({
  id: r.id,
  enabled: r.enabled === 1,
  config: r.config,
  lastSentAt: r.last_sent_at,
  enabledAt: r.enabled_at,
  recent: r.recent,
  messagesSince: r.messages_since,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const timedMessagesRepo = {
  list(db: Database): TimedMessageRecord[] {
    return queryAll<TimedRow>(db, 'SELECT * FROM timed_messages ORDER BY created_at, rowid').map(timed);
  },
  get(db: Database, id: string): TimedMessageRecord | undefined {
    const r = queryOne<TimedRow>(db, 'SELECT * FROM timed_messages WHERE id = ?', id);
    return r ? timed(r) : undefined;
  },
  insert(db: Database, r: Omit<TimedMessageRecord, 'lastSentAt' | 'recent' | 'messagesSince'>): void {
    execute(db, 'INSERT INTO timed_messages (id, enabled, config, enabled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', r.id, r.enabled ? 1 : 0, r.config, r.enabledAt, r.createdAt, r.updatedAt);
  },
  /** resetCount: start the message count again (switched on, or the configuration changed). */
  update(db: Database, id: string, r: { enabled: boolean; config: string; enabledAt: string | null; resetCount: boolean }, at: string): boolean {
    return (
      execute(
        db,
        'UPDATE timed_messages SET enabled = ?, config = ?, enabled_at = ?, messages_since = CASE WHEN ? THEN 0 ELSE messages_since END, updated_at = ? WHERE id = ?',
        r.enabled ? 1 : 0,
        r.config,
        r.enabledAt,
        r.resetCount ? 1 : 0,
        at,
        id,
      ) > 0
    );
  },
  /** Counts one chat message for an enabled timed message, in one statement. Returns the new count (null: gone or off). */
  countMessage(db: Database, id: string): number | null {
    return queryOne<{ n: number }>(db, 'UPDATE timed_messages SET messages_since = messages_since + 1 WHERE id = ? AND enabled = 1 RETURNING messages_since AS n', id)?.n ?? null;
  },
  /**
   * Records a send. On success the count it was triggered with is subtracted (never below 0), so messages counted
   * while it was being sent stay for the next interval; a failure keeps the count.
   */
  recordSend(db: Database, id: string, r: { sentAt: string | null; recent: string; countUsed: number }): void {
    if (r.sentAt) execute(db, 'UPDATE timed_messages SET last_sent_at = ?, recent = ?, messages_since = MAX(messages_since - ?, 0) WHERE id = ?', r.sentAt, r.recent, r.countUsed, id);
    else execute(db, 'UPDATE timed_messages SET recent = ? WHERE id = ?', r.recent, id);
  },
  delete(db: Database, id: string): boolean {
    return execute(db, 'DELETE FROM timed_messages WHERE id = ?', id) > 0;
  },
};

// ── sticky messages ──────────────────────────────────────────────────────────

export interface StickyRecord {
  id: string;
  enabled: boolean;
  guildId: string;
  channelId: string;
  config: string;
  postedMessageId: string | null;
  lastPostedAt: string | null;
  problem: string | null;
  recent: string;
  createdAt: string;
  updatedAt: string;
}

interface StickyRow {
  id: string;
  enabled: number;
  guild_id: string;
  channel_id: string;
  config: string;
  posted_message_id: string | null;
  last_posted_at: string | null;
  problem: string | null;
  recent: string;
  created_at: string;
  updated_at: string;
}

const sticky = (r: StickyRow): StickyRecord => ({
  id: r.id,
  enabled: r.enabled === 1,
  guildId: r.guild_id,
  channelId: r.channel_id,
  config: r.config,
  postedMessageId: r.posted_message_id,
  lastPostedAt: r.last_posted_at,
  problem: r.problem,
  recent: r.recent,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const stickyRepo = {
  list(db: Database): StickyRecord[] {
    return queryAll<StickyRow>(db, 'SELECT * FROM sticky_messages ORDER BY created_at, rowid').map(sticky);
  },
  get(db: Database, id: string): StickyRecord | undefined {
    const r = queryOne<StickyRow>(db, 'SELECT * FROM sticky_messages WHERE id = ?', id);
    return r ? sticky(r) : undefined;
  },
  byChannel(db: Database, channelId: string): StickyRecord | undefined {
    const r = queryOne<StickyRow>(db, 'SELECT * FROM sticky_messages WHERE channel_id = ?', channelId);
    return r ? sticky(r) : undefined;
  },
  insert(db: Database, r: { id: string; enabled: boolean; guildId: string; channelId: string; config: string; at: string }): void {
    execute(db, 'INSERT INTO sticky_messages (id, enabled, guild_id, channel_id, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', r.id, r.enabled ? 1 : 0, r.guildId, r.channelId, r.config, r.at, r.at);
  },
  update(db: Database, id: string, r: { enabled: boolean; guildId: string; channelId: string; config: string }, at: string): boolean {
    return execute(db, 'UPDATE sticky_messages SET enabled = ?, guild_id = ?, channel_id = ?, config = ?, updated_at = ? WHERE id = ?', r.enabled ? 1 : 0, r.guildId, r.channelId, r.config, at, id) > 0;
  },
  setPosted(db: Database, id: string, messageId: string | null, at: string | null): void {
    execute(db, 'UPDATE sticky_messages SET posted_message_id = ?, last_posted_at = COALESCE(?, last_posted_at), problem = NULL WHERE id = ?', messageId, at, id);
  },
  setProblem(db: Database, id: string, problem: string | null): void {
    execute(db, 'UPDATE sticky_messages SET problem = ? WHERE id = ?', problem?.slice(0, 300) ?? null, id);
  },
  setRecent(db: Database, id: string, recent: string): void {
    execute(db, 'UPDATE sticky_messages SET recent = ? WHERE id = ?', recent, id);
  },
  delete(db: Database, id: string): boolean {
    return execute(db, 'DELETE FROM sticky_messages WHERE id = ?', id) > 0;
  },
};

// ── stream notifiers ─────────────────────────────────────────────────────────

export interface NotifierRecord {
  id: string;
  platform: 'kick' | 'twitch' | 'youtube';
  channelSlug: string;
  discordChannelId: string;
  enabled: boolean;
  config: string;
  broadcasterId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  live: boolean | null;
  sessionKey: string | null;
  liveSince: string | null;
  title: string | null;
  category: string | null;
  lastCheckedAt: string | null;
  messageId: string | null;
  messageChannelId: string | null;
  notifyAttempts: number;
  lastNotifiedAt: string | null;
  status: string | null;
  problem: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NotifierRow {
  id: string;
  platform: NotifierRecord['platform'];
  channel_slug: string;
  discord_channel_id: string;
  enabled: number;
  config: string;
  broadcaster_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  live: number | null;
  session_key: string | null;
  live_since: string | null;
  title: string | null;
  category: string | null;
  last_checked_at: string | null;
  message_id: string | null;
  message_channel_id: string | null;
  notify_attempts: number;
  last_notified_at: string | null;
  status: string | null;
  problem: string | null;
  created_at: string;
  updated_at: string;
}

const notifier = (r: NotifierRow): NotifierRecord => ({
  id: r.id,
  platform: r.platform,
  channelSlug: r.channel_slug,
  discordChannelId: r.discord_channel_id,
  enabled: r.enabled === 1,
  config: r.config,
  broadcasterId: r.broadcaster_id,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  live: r.live === null ? null : r.live === 1,
  sessionKey: r.session_key,
  liveSince: r.live_since,
  title: r.title,
  category: r.category,
  lastCheckedAt: r.last_checked_at,
  messageId: r.message_id,
  messageChannelId: r.message_channel_id,
  notifyAttempts: r.notify_attempts,
  lastNotifiedAt: r.last_notified_at,
  status: r.status,
  problem: r.problem,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The live-state columns a check may change (others are configuration). */
export type NotifierState = Partial<
  Pick<
    NotifierRecord,
    | 'broadcasterId'
    | 'displayName'
    | 'avatarUrl'
    | 'live'
    | 'sessionKey'
    | 'liveSince'
    | 'title'
    | 'category'
    | 'lastCheckedAt'
    | 'messageId'
    | 'messageChannelId'
    | 'notifyAttempts'
    | 'lastNotifiedAt'
    | 'status'
    | 'problem'
  >
>;

const STATE_COLUMNS: Record<keyof NotifierState, string> = {
  broadcasterId: 'broadcaster_id',
  displayName: 'display_name',
  avatarUrl: 'avatar_url',
  live: 'live',
  sessionKey: 'session_key',
  liveSince: 'live_since',
  title: 'title',
  category: 'category',
  lastCheckedAt: 'last_checked_at',
  messageId: 'message_id',
  messageChannelId: 'message_channel_id',
  notifyAttempts: 'notify_attempts',
  lastNotifiedAt: 'last_notified_at',
  status: 'status',
  problem: 'problem',
};

const cap = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : v);

export const notifiersRepo = {
  list(db: Database): NotifierRecord[] {
    return queryAll<NotifierRow>(db, 'SELECT * FROM stream_notifiers ORDER BY created_at, rowid').map(notifier);
  },
  get(db: Database, id: string): NotifierRecord | undefined {
    const r = queryOne<NotifierRow>(db, 'SELECT * FROM stream_notifiers WHERE id = ?', id);
    return r ? notifier(r) : undefined;
  },
  insert(db: Database, r: { id: string; platform: NotifierRecord['platform']; channelSlug: string; discordChannelId: string; enabled: boolean; config: string; at: string }): void {
    execute(
      db,
      'INSERT INTO stream_notifiers (id, platform, channel_slug, discord_channel_id, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      r.id,
      r.platform,
      r.channelSlug,
      r.discordChannelId,
      r.enabled ? 1 : 0,
      r.config,
      r.at,
      r.at,
    );
  },
  updateConfig(db: Database, id: string, r: { channelSlug: string; discordChannelId: string; enabled: boolean; config: string }, at: string): boolean {
    return execute(db, 'UPDATE stream_notifiers SET channel_slug = ?, discord_channel_id = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?', r.channelSlug, r.discordChannelId, r.enabled ? 1 : 0, r.config, at, id) > 0;
  },
  setState(db: Database, id: string, s: NotifierState): void {
    const keys = Object.keys(s) as Array<keyof NotifierState>;
    if (keys.length === 0) return;
    const values = keys.map((k) => {
      const v = s[k];
      if (typeof v === 'boolean') return v ? 1 : 0;
      return (cap(v, k === 'avatarUrl' ? 2048 : 300) ?? null) as string | number | null;
    });
    execute(db, `UPDATE stream_notifiers SET ${keys.map((k) => `${STATE_COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`, ...values, id);
  },
  delete(db: Database, id: string): boolean {
    return execute(db, 'DELETE FROM stream_notifiers WHERE id = ?', id) > 0;
  },
};

// ── Discord log deduplication ────────────────────────────────────────────────

export const logEventsRepo = {
  /** Claims an event key; false when it was already logged. Old keys are pruned. */
  claim(db: Database, key: string, at: string): boolean {
    const n = execute(db, 'INSERT INTO discord_log_events (event_key, created_at) VALUES (?, ?) ON CONFLICT (event_key) DO NOTHING', key.slice(0, 200), at);
    if (n > 0 && Math.random() < 0.02) execute(db, "DELETE FROM discord_log_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-7 days')", at);
    return n > 0;
  },
};
