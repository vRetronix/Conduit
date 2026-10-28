import { execute, queryAll, queryOne, type Database } from '../sqlite';

export type GiveawayStatus = 'draft' | 'open' | 'closed' | 'drawn' | 'cancelled';
export type GiveawayPlatform = 'kick' | 'discord';
export type AnnouncementKind = 'started' | 'closed' | 'winners' | 'redraw';
export type AnnouncementOutcome = 'sent' | 'failed' | 'unconfirmed' | 'skipped';
export type DiscordAnnouncementStatus = 'posted' | 'failed' | 'missing';
/**
 * How an entry was made: 'chat' = Kick !enter; 'command' = a Discord interaction (the Enter Giveaway button, or an
 * earlier slash command); 'reaction' = an earlier 🎉 reaction (no longer used for entering; kept on existing entries).
 * Entries are never removed by entrants (there is no leave option).
 */
export type EntrySource = 'chat' | 'command' | 'reaction';
export type KickRewardStatus = 'active' | 'paused' | 'removed' | 'failed';

export interface GiveawayRecord {
  id: string;
  prize: string;
  description: string | null;
  status: GiveawayStatus;
  winnerCount: number;
  durationMinutes: number | null;
  allowKick: boolean;
  allowDiscord: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endsAt: string | null;
  closedAt: string | null;
  drawnAt: string | null;
  cancelledAt: string | null;
  announceAt: string | null;
  announceKind: AnnouncementKind | null;
  announceOutcome: AnnouncementOutcome | null;
  announceDetail: string | null;
  discordGuildId: string | null;
  discordChannelId: string | null;
  discordChannelName: string | null;
  discordMessageId: string | null;
  discordStatus: DiscordAnnouncementStatus | null;
  discordDetail: string | null;
  discordUpdatedAt: string | null;
  /** Kick Channel Points bonus tickets: cost and tickets per redemption (null: no reward). */
  kickRewardCost: number | null;
  kickRewardTickets: number | null;
  kickRewardTitle: string | null;
  /** The reward Kick created for this giveaway, and its state. */
  kickRewardId: string | null;
  kickRewardStatus: KickRewardStatus | null;
  kickRewardDetail: string | null;
  /** Ticket multiplier for verified active Kick subscribers (1 = off). */
  subscriberMultiplier: number;
}

export interface GiveawayEntryRecord {
  id: number;
  giveawayId: string;
  platform: GiveawayPlatform;
  platformUserId: string;
  displayName: string;
  enteredAt: string;
  /** How the entry was made (null: before this was recorded). */
  source: EntrySource | null;
  /** Verified as an active Kick subscriber when the entry was made (evidence: JSON, see the service). */
  subscriberVerified: boolean;
  subscriberEvidence: string | null;
}

export interface GiveawayRedemptionRecord {
  /** Kick's redemption id. */
  id: string;
  giveawayId: string;
  rewardId: string;
  redeemerUserId: string;
  redeemerName: string | null;
  redeemedAt: string;
  status: 'accepted' | 'rejected';
  reason: string | null;
  tickets: number;
  /** Whether Kick was told (accept/reject call succeeded or Kick already had that status). */
  kickSynced: boolean;
  processedAt: string;
}

export interface GiveawayDrawRecord {
  id: string;
  giveawayId: string;
  kind: 'initial' | 'redraw';
  drawnAt: string;
  poolSize: number;
  replacedWinnerId: string | null;
  reason: string | null;
  /** JSON: each entry in the pool with its ticket calculation (null for draws made before tickets were recorded). */
  ticketSnapshot?: string | null;
}

export interface GiveawayWinnerRecord {
  id: string;
  giveawayId: string;
  drawId: string;
  entryId: number;
  position: number;
  status: 'won' | 'replaced';
  selectedAt: string;
  replacedAt: string | null;
  platform: GiveawayPlatform;
  platformUserId: string;
  displayName: string;
}

const COLUMNS = `id, prize, description, status, winner_count AS winnerCount, duration_minutes AS durationMinutes,
  allow_kick AS allowKick, allow_discord AS allowDiscord, created_at AS createdAt, updated_at AS updatedAt,
  started_at AS startedAt, ends_at AS endsAt, closed_at AS closedAt, drawn_at AS drawnAt, cancelled_at AS cancelledAt,
  announce_at AS announceAt, announce_kind AS announceKind, announce_outcome AS announceOutcome,
  announce_detail AS announceDetail, discord_guild_id AS discordGuildId, discord_channel_id AS discordChannelId,
  discord_channel_name AS discordChannelName, discord_message_id AS discordMessageId, discord_status AS discordStatus,
  discord_detail AS discordDetail, discord_updated_at AS discordUpdatedAt, kick_reward_cost AS kickRewardCost,
  kick_reward_tickets AS kickRewardTickets, kick_reward_title AS kickRewardTitle, kick_reward_id AS kickRewardId,
  kick_reward_status AS kickRewardStatus, kick_reward_detail AS kickRewardDetail, subscriber_multiplier AS subscriberMultiplier`;

type Row = Omit<GiveawayRecord, 'allowKick' | 'allowDiscord'> & { allowKick: number; allowDiscord: number };
const toRecord = (r: Row): GiveawayRecord => ({ ...r, allowKick: r.allowKick === 1, allowDiscord: r.allowDiscord === 1 });

const ENTRY_COLUMNS = `id, giveaway_id AS giveawayId, platform, platform_user_id AS platformUserId, display_name AS displayName,
  entered_at AS enteredAt, source, subscriber_verified AS subscriberVerified, subscriber_evidence AS subscriberEvidence`;

type EntryRow = Omit<GiveawayEntryRecord, 'subscriberVerified'> & { subscriberVerified: number };
const toEntry = (r: EntryRow): GiveawayEntryRecord => ({ ...r, subscriberVerified: r.subscriberVerified === 1 });

const REDEMPTION_COLUMNS = `id, giveaway_id AS giveawayId, reward_id AS rewardId, redeemer_user_id AS redeemerUserId,
  redeemer_name AS redeemerName, redeemed_at AS redeemedAt, status, reason, tickets, kick_synced AS kickSynced, processed_at AS processedAt`;
type RedemptionRow = Omit<GiveawayRedemptionRecord, 'kickSynced'> & { kickSynced: number };
const toRedemption = (r: RedemptionRow): GiveawayRedemptionRecord => ({ ...r, kickSynced: r.kickSynced === 1 });

export const giveawaysRepo = {
  list(db: Database): GiveawayRecord[] {
    return queryAll<Row>(db, `SELECT ${COLUMNS} FROM giveaways ORDER BY created_at DESC, id`).map(toRecord);
  },

  get(db: Database, id: string): GiveawayRecord | undefined {
    const r = queryOne<Row>(db, `SELECT ${COLUMNS} FROM giveaways WHERE id = ?`, id);
    return r ? toRecord(r) : undefined;
  },

  /** The giveaway accepting entries, if any (at most one, enforced by the schema). */
  findOpen(db: Database): GiveawayRecord | undefined {
    const r = queryOne<Row>(db, `SELECT ${COLUMNS} FROM giveaways WHERE status = 'open'`);
    return r ? toRecord(r) : undefined;
  },

  insert(
    db: Database,
    g: Pick<
      GiveawayRecord,
      | 'id'
      | 'prize'
      | 'description'
      | 'winnerCount'
      | 'durationMinutes'
      | 'allowKick'
      | 'allowDiscord'
      | 'createdAt'
      | 'discordGuildId'
      | 'discordChannelId'
      | 'discordChannelName'
    >,
  ): void {
    execute(
      db,
      `INSERT INTO giveaways (id, prize, description, status, winner_count, duration_minutes, allow_kick, allow_discord,
         created_at, updated_at, discord_guild_id, discord_channel_id, discord_channel_name)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      g.id,
      g.prize,
      g.description,
      g.winnerCount,
      g.durationMinutes,
      g.allowKick ? 1 : 0,
      g.allowDiscord ? 1 : 0,
      g.createdAt,
      g.createdAt,
      g.discordGuildId,
      g.discordChannelId,
      g.discordChannelName,
    );
  },

  /** Creates a giveaway that is open right away (the Start Giveaway action: there are no drafts). */
  insertOpen(
    db: Database,
    g: Pick<
      GiveawayRecord,
      | 'id'
      | 'prize'
      | 'description'
      | 'winnerCount'
      | 'durationMinutes'
      | 'allowKick'
      | 'allowDiscord'
      | 'createdAt'
      | 'endsAt'
      | 'discordGuildId'
      | 'discordChannelId'
      | 'discordChannelName'
      | 'kickRewardCost'
      | 'kickRewardTickets'
      | 'kickRewardTitle'
      | 'subscriberMultiplier'
    >,
  ): void {
    execute(
      db,
      `INSERT INTO giveaways (id, prize, description, status, winner_count, duration_minutes, allow_kick, allow_discord, created_at,
         updated_at, started_at, ends_at, discord_guild_id, discord_channel_id, discord_channel_name, kick_reward_cost,
         kick_reward_tickets, kick_reward_title, subscriber_multiplier)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      g.id,
      g.prize,
      g.description,
      g.winnerCount,
      g.durationMinutes,
      g.allowKick ? 1 : 0,
      g.allowDiscord ? 1 : 0,
      g.createdAt,
      g.createdAt,
      g.createdAt,
      g.endsAt,
      g.discordGuildId,
      g.discordChannelId,
      g.discordChannelName,
      g.kickRewardCost,
      g.kickRewardTickets,
      g.kickRewardTitle,
      g.subscriberMultiplier,
    );
  },

  /** Deletes a giveaway with everything that belongs to it (entries, draws, winners, redemptions: ON DELETE CASCADE). */
  remove(db: Database, id: string): boolean {
    execute(db, 'DELETE FROM giveaway_winners WHERE giveaway_id = ?', id);
    return execute(db, 'DELETE FROM giveaways WHERE id = ?', id) === 1;
  },

  setKickReward(db: Database, id: string, r: { rewardId?: string | null; status: KickRewardStatus | null; detail: string | null }): void {
    if (r.rewardId !== undefined) execute(db, 'UPDATE giveaways SET kick_reward_id = ? WHERE id = ?', r.rewardId, id);
    execute(
      db,
      'UPDATE giveaways SET kick_reward_status = ?, kick_reward_detail = ? WHERE id = ?',
      r.status,
      r.detail === null ? null : r.detail.slice(0, 300),
      id,
    );
  },

  /** Updates the editable fields while the giveaway is still in `expectedStatus`. Returns false if it changed meanwhile. */
  updateDetails(
    db: Database,
    id: string,
    expectedStatus: GiveawayStatus,
    d: Pick<
      GiveawayRecord,
      | 'prize'
      | 'description'
      | 'winnerCount'
      | 'durationMinutes'
      | 'allowKick'
      | 'allowDiscord'
      | 'updatedAt'
      | 'discordGuildId'
      | 'discordChannelId'
      | 'discordChannelName'
    >,
  ): boolean {
    // The channel can't change once the announcement exists (discord_message_id set): the old message would be orphaned.
    return (
      execute(
        db,
        `UPDATE giveaways SET prize = ?, description = ?, winner_count = ?, duration_minutes = ?, allow_kick = ?,
           allow_discord = ?, updated_at = ?, discord_guild_id = ?, discord_channel_id = ?, discord_channel_name = ?
           WHERE id = ? AND status = ?
             AND (discord_message_id IS NULL OR (discord_channel_id IS ? AND discord_guild_id IS ?))`,
        d.prize,
        d.description,
        d.winnerCount,
        d.durationMinutes,
        d.allowKick ? 1 : 0,
        d.allowDiscord ? 1 : 0,
        d.updatedAt,
        d.discordGuildId,
        d.discordChannelId,
        d.discordChannelName,
        id,
        expectedStatus,
        d.discordChannelId,
        d.discordGuildId,
      ) === 1
    );
  },

  /** draft → open. Throws a UNIQUE constraint error if another giveaway is open. */
  start(db: Database, id: string, at: string, endsAt: string | null): boolean {
    return (
      execute(
        db,
        `UPDATE giveaways SET status = 'open', started_at = ?, ends_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
        at,
        endsAt,
        at,
        id,
      ) === 1
    );
  },

  /** open → closed (entries stop). */
  close(db: Database, id: string, at: string): boolean {
    return (
      execute(db, `UPDATE giveaways SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'`, at, at, id) ===
      1
    );
  },

  /** Open giveaways whose end time has passed. */
  listOverdue(db: Database, now: string): GiveawayRecord[] {
    return queryAll<Row>(db, `SELECT ${COLUMNS} FROM giveaways WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at <= ?`, now).map(
      toRecord,
    );
  },

  /** open/closed → drawn. */
  markDrawn(db: Database, id: string, at: string): boolean {
    return (
      execute(
        db,
        `UPDATE giveaways SET status = 'drawn', closed_at = COALESCE(closed_at, ?), drawn_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('open', 'closed')`,
        at,
        at,
        at,
        id,
      ) === 1
    );
  },

  /** draft/open/closed → cancelled. */
  cancel(db: Database, id: string, at: string): boolean {
    return (
      execute(
        db,
        `UPDATE giveaways SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'open', 'closed')`,
        at,
        at,
        id,
      ) === 1
    );
  },

  recordAnnouncement(db: Database, id: string, a: { at: string; kind: AnnouncementKind; outcome: AnnouncementOutcome; detail: string | null }): void {
    execute(
      db,
      `UPDATE giveaways SET announce_at = ?, announce_kind = ?, announce_outcome = ?, announce_detail = ? WHERE id = ?`,
      a.at,
      a.kind,
      a.outcome,
      a.detail === null ? null : a.detail.slice(0, 300),
      id,
    );
  },

  /** The giveaway announced by this Discord message, if any. */
  findByDiscordMessage(db: Database, messageId: string): GiveawayRecord | undefined {
    const r = queryOne<Row>(db, `SELECT ${COLUMNS} FROM giveaways WHERE discord_message_id = ?`, messageId);
    return r ? toRecord(r) : undefined;
  },

  /** Giveaways with a posted Discord announcement, in one of `statuses`. */
  listWithDiscordMessage(db: Database, statuses: readonly GiveawayStatus[]): GiveawayRecord[] {
    return queryAll<Row>(db, `SELECT ${COLUMNS} FROM giveaways WHERE discord_message_id IS NOT NULL ORDER BY created_at`)
      .map(toRecord)
      .filter((g) => statuses.includes(g.status));
  },

  /** Stores the posted announcement's message id: only if none is stored, or replacing `previous` when reposting. */
  setDiscordMessage(db: Database, id: string, messageId: string, previous: string | null, at: string): boolean {
    return (
      execute(
        db,
        `UPDATE giveaways SET discord_message_id = ?, discord_status = 'posted', discord_detail = NULL, discord_updated_at = ?
           WHERE id = ? AND discord_message_id IS ?`,
        messageId,
        at,
        id,
        previous,
      ) === 1
    );
  },

  /** Stores the channel's current name (checked with Discord when the announcement is posted). */
  setDiscordChannelName(db: Database, id: string, name: string): void {
    execute(db, 'UPDATE giveaways SET discord_channel_name = ? WHERE id = ?', name.slice(0, 100), id);
  },

  /** Forgets an announcement that no longer exists in Discord (deleted message or channel), so another can be posted. */
  forgetMissingDiscordMessage(db: Database, id: string): boolean {
    return (
      execute(
        db,
        `UPDATE giveaways SET discord_message_id = NULL, discord_status = NULL, discord_detail = NULL
           WHERE id = ? AND discord_status = 'missing'`,
        id,
      ) === 1
    );
  },

  recordDiscord(db: Database, id: string, a: { status: DiscordAnnouncementStatus; detail: string | null; at: string }): void {
    execute(
      db,
      'UPDATE giveaways SET discord_status = ?, discord_detail = ?, discord_updated_at = ? WHERE id = ?',
      a.status,
      a.detail === null ? null : a.detail.slice(0, 300),
      a.at,
      id,
    );
  },

  // ── entries ──

  /** Adds an entry; false if this platform user had already entered (the unique key makes repeats harmless). */
  addEntry(db: Database, e: Omit<GiveawayEntryRecord, 'id'>): boolean {
    return (
      execute(
        db,
        `INSERT INTO giveaway_entries (giveaway_id, platform, platform_user_id, display_name, entered_at, source,
           subscriber_verified, subscriber_evidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (giveaway_id, platform, platform_user_id) DO NOTHING`,
        e.giveawayId,
        e.platform,
        e.platformUserId,
        e.displayName,
        e.enteredAt,
        e.source,
        e.subscriberVerified ? 1 : 0,
        e.subscriberEvidence,
      ) === 1
    );
  },


  entries(db: Database, giveawayId: string): GiveawayEntryRecord[] {
    return queryAll<EntryRow>(db, `SELECT ${ENTRY_COLUMNS} FROM giveaway_entries WHERE giveaway_id = ? ORDER BY id`, giveawayId).map(toEntry);
  },

  findEntry(db: Database, giveawayId: string, platform: GiveawayPlatform, platformUserId: string): GiveawayEntryRecord | undefined {
    const r = queryOne<EntryRow>(
      db,
      `SELECT ${ENTRY_COLUMNS} FROM giveaway_entries WHERE giveaway_id = ? AND platform = ? AND platform_user_id = ?`,
      giveawayId,
      platform,
      platformUserId,
    );
    return r ? toEntry(r) : undefined;
  },

  entryCounts(db: Database): Array<{ giveawayId: string; platform: GiveawayPlatform; n: number }> {
    return queryAll(db, `SELECT giveaway_id AS giveawayId, platform, COUNT(*) AS n FROM giveaway_entries GROUP BY giveaway_id, platform`);
  },

  entryCount(db: Database, giveawayId: string): number {
    return queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?', giveawayId)?.n ?? 0;
  },

  // ── draws and winners ──

  insertDraw(db: Database, d: GiveawayDrawRecord): void {
    execute(
      db,
      `INSERT INTO giveaway_draws (id, giveaway_id, kind, drawn_at, pool_size, replaced_winner_id, reason, ticket_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      d.id,
      d.giveawayId,
      d.kind,
      d.drawnAt,
      d.poolSize,
      d.replacedWinnerId,
      d.reason,
      d.ticketSnapshot ?? null,
    );
  },

  // ── Kick reward redemptions ──

  getRedemption(db: Database, id: string): GiveawayRedemptionRecord | undefined {
    const r = queryOne<RedemptionRow>(db, `SELECT ${REDEMPTION_COLUMNS} FROM giveaway_redemptions WHERE id = ?`, id);
    return r ? toRedemption(r) : undefined;
  },

  /** Records a redemption once; false if this redemption id was already recorded (a repeated event). */
  insertRedemption(db: Database, r: GiveawayRedemptionRecord): boolean {
    return (
      execute(
        db,
        `INSERT INTO giveaway_redemptions (id, giveaway_id, reward_id, redeemer_user_id, redeemer_name, redeemed_at, status, reason,
           tickets, kick_synced, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        r.id,
        r.giveawayId,
        r.rewardId,
        r.redeemerUserId,
        r.redeemerName,
        r.redeemedAt,
        r.status,
        r.reason,
        r.tickets,
        r.kickSynced ? 1 : 0,
        r.processedAt,
      ) === 1
    );
  },

  /** An accepted redemption that Kick (or the streamer) rejected afterwards: no tickets. */
  revokeRedemption(db: Database, id: string, reason: string, at: string): boolean {
    return (
      execute(
        db,
        `UPDATE giveaway_redemptions SET status = 'rejected', tickets = 0, reason = ?, kick_synced = 1, processed_at = ?
           WHERE id = ? AND status = 'accepted'`,
        reason,
        at,
        id,
      ) === 1
    );
  },

  markRedemptionSynced(db: Database, id: string): void {
    execute(db, 'UPDATE giveaway_redemptions SET kick_synced = 1 WHERE id = ?', id);
  },

  redemptions(db: Database, giveawayId: string): GiveawayRedemptionRecord[] {
    return queryAll<RedemptionRow>(
      db,
      `SELECT ${REDEMPTION_COLUMNS} FROM giveaway_redemptions WHERE giveaway_id = ? ORDER BY redeemed_at, id`,
      giveawayId,
    ).map(toRedemption);
  },

  /** Redemptions Kick hasn't been told about yet (the accept/reject call failed), oldest first. */
  unsyncedRedemptions(db: Database): GiveawayRedemptionRecord[] {
    return queryAll<RedemptionRow>(db, `SELECT ${REDEMPTION_COLUMNS} FROM giveaway_redemptions WHERE kick_synced = 0 ORDER BY processed_at`).map(
      toRedemption,
    );
  },

  /** Bonus tickets per Kick user id from accepted redemptions. */
  bonusTickets(db: Database, giveawayId: string): Map<string, number> {
    const rows = queryAll<{ userId: string; n: number }>(
      db,
      `SELECT redeemer_user_id AS userId, SUM(tickets) AS n FROM giveaway_redemptions WHERE giveaway_id = ? AND status = 'accepted'
         GROUP BY redeemer_user_id`,
      giveawayId,
    );
    return new Map(rows.map((r) => [r.userId, r.n]));
  },

  insertWinner(db: Database, w: Pick<GiveawayWinnerRecord, 'id' | 'giveawayId' | 'drawId' | 'entryId' | 'position' | 'selectedAt'>): void {
    execute(
      db,
      `INSERT INTO giveaway_winners (id, giveaway_id, draw_id, entry_id, position, status, selected_at) VALUES (?, ?, ?, ?, ?, 'won', ?)`,
      w.id,
      w.giveawayId,
      w.drawId,
      w.entryId,
      w.position,
      w.selectedAt,
    );
  },

  /** won → replaced. Returns false if the winner wasn't a current winner of this giveaway. */
  markReplaced(db: Database, giveawayId: string, winnerId: string, at: string): boolean {
    return (
      execute(
        db,
        `UPDATE giveaway_winners SET status = 'replaced', replaced_at = ? WHERE id = ? AND giveaway_id = ? AND status = 'won'`,
        at,
        winnerId,
        giveawayId,
      ) === 1
    );
  },

  draws(db: Database, giveawayId: string): GiveawayDrawRecord[] {
    return queryAll<GiveawayDrawRecord>(
      db,
      `SELECT id, giveaway_id AS giveawayId, kind, drawn_at AS drawnAt, pool_size AS poolSize, replaced_winner_id AS replacedWinnerId,
         reason, ticket_snapshot AS ticketSnapshot FROM giveaway_draws WHERE giveaway_id = ? ORDER BY drawn_at, rowid`,
      giveawayId,
    );
  },

  winners(db: Database, giveawayId: string): GiveawayWinnerRecord[] {
    return queryAll<GiveawayWinnerRecord>(
      db,
      `SELECT w.id, w.giveaway_id AS giveawayId, w.draw_id AS drawId, w.entry_id AS entryId, w.position, w.status,
         w.selected_at AS selectedAt, w.replaced_at AS replacedAt, e.platform, e.platform_user_id AS platformUserId,
         e.display_name AS displayName
       FROM giveaway_winners w JOIN giveaway_entries e ON e.id = w.entry_id
       WHERE w.giveaway_id = ? ORDER BY w.position, w.selected_at, w.rowid`,
      giveawayId,
    );
  },
};
