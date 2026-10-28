import { execute, queryAll, queryOne, type Database } from '../sqlite';

export type LoyaltyPlatform = 'discord' | 'kick';
export type LoyaltyTransactionKind = 'chat' | 'adjustment' | 'redemption' | 'refund';
export type LoyaltyRedemptionStatus = 'pending' | 'fulfilled' | 'rejected';

export interface LoyaltyAccountRecord {
  platform: LoyaltyPlatform;
  userId: string;
  displayName: string | null;
  balance: number;
  lifetimeEarned: number;
  lastEarnedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyTransactionRecord {
  id: string;
  platform: LoyaltyPlatform;
  userId: string;
  amount: number;
  balanceAfter: number;
  kind: LoyaltyTransactionKind;
  reason: string | null;
  eventKey: string | null;
  redemptionId: string | null;
  createdAt: string;
}

export interface LoyaltyRewardRecord {
  id: string;
  name: string;
  description: string | null;
  cost: number;
  enabled: boolean;
  /** Remaining quantity; null = unlimited. */
  stock: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyRedemptionRecord {
  id: string;
  rewardId: string;
  rewardName: string;
  platform: LoyaltyPlatform;
  userId: string;
  displayName: string | null;
  cost: number;
  status: LoyaltyRedemptionStatus;
  note: string | null;
  requestKey: string;
  createdAt: string;
  resolvedAt: string | null;
}

const ACCOUNT = `platform, user_id AS userId, display_name AS displayName, balance, lifetime_earned AS lifetimeEarned,
  last_earned_at AS lastEarnedAt, created_at AS createdAt, updated_at AS updatedAt`;
const TRANSACTION = `id, platform, user_id AS userId, amount, balance_after AS balanceAfter, kind, reason, event_key AS eventKey,
  redemption_id AS redemptionId, created_at AS createdAt`;
const REWARD = `id, name, description, cost, enabled, stock, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt`;
const REDEMPTION = `id, reward_id AS rewardId, reward_name AS rewardName, platform, user_id AS userId, display_name AS displayName, cost,
  status, note, request_key AS requestKey, created_at AS createdAt, resolved_at AS resolvedAt`;

const reward = (r: Omit<LoyaltyRewardRecord, 'enabled'> & { enabled: number }): LoyaltyRewardRecord => ({ ...r, enabled: r.enabled === 1 });

/** LIKE pattern for a plain-text search (%, _ and \ are matched literally). */
const likeText = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Loyalty storage. Every function is a plain statement or a short sequence of them; the service runs related changes
 * (balance + ledger + redemption) inside one withTransaction so they commit or roll back together.
 */
export const loyaltyRepo = {
  // ── accounts ──

  getAccount(db: Database, platform: LoyaltyPlatform, userId: string): LoyaltyAccountRecord | undefined {
    return queryOne<LoyaltyAccountRecord>(db, `SELECT ${ACCOUNT} FROM loyalty_accounts WHERE platform = ? AND user_id = ?`, platform, userId);
  },

  /** Creates the account (balance 0) if it doesn't exist; refreshes the display name when one is given. */
  ensureAccount(db: Database, platform: LoyaltyPlatform, userId: string, displayName: string | null, at: string): LoyaltyAccountRecord {
    execute(
      db,
      `INSERT INTO loyalty_accounts (platform, user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (platform, user_id) DO UPDATE SET display_name = COALESCE(excluded.display_name, display_name)`,
      platform,
      userId,
      displayName?.slice(0, 100) ?? null,
      at,
      at,
    );
    return loyaltyRepo.getAccount(db, platform, userId)!;
  },

  /**
   * Applies one balance change and its ledger entry. Call inside a transaction.
   * - 'duplicate': a transaction with this event_key already exists (nothing changed).
   * - 'insufficient': the balance would go below 0 (nothing changed).
   */
  applyChange(
    db: Database,
    c: { id: string; platform: LoyaltyPlatform; userId: string; amount: number; kind: LoyaltyTransactionKind; reason: string | null; eventKey: string | null; redemptionId: string | null; at: string },
  ): { outcome: 'ok'; balance: number } | { outcome: 'duplicate' | 'insufficient'; balance: number } {
    const account = loyaltyRepo.getAccount(db, c.platform, c.userId);
    if (!account) throw new Error('loyalty account missing');
    if (c.eventKey && queryOne(db, 'SELECT 1 AS x FROM loyalty_transactions WHERE event_key = ?', c.eventKey)) return { outcome: 'duplicate', balance: account.balance };
    const balance = account.balance + c.amount;
    if (balance < 0) return { outcome: 'insufficient', balance: account.balance };
    execute(
      db,
      `INSERT INTO loyalty_transactions (id, platform, user_id, amount, balance_after, kind, reason, event_key, redemption_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id,
      c.platform,
      c.userId,
      c.amount,
      balance,
      c.kind,
      c.reason?.slice(0, 200) ?? null,
      c.eventKey?.slice(0, 200) ?? null,
      c.redemptionId,
      c.at,
    );
    const earned = c.kind === 'chat' || (c.kind === 'adjustment' && c.amount > 0) ? c.amount : 0;
    execute(
      db,
      `UPDATE loyalty_accounts SET balance = ?, lifetime_earned = lifetime_earned + ?,
         last_earned_at = CASE WHEN ? THEN ? ELSE last_earned_at END, updated_at = ? WHERE platform = ? AND user_id = ?`,
      balance,
      earned,
      c.kind === 'chat' ? 1 : 0,
      c.at,
      c.at,
      c.platform,
      c.userId,
    );
    return { outcome: 'ok', balance };
  },

  /** Whether a ledger entry with this event key exists (the event was already applied). */
  hasEvent(db: Database, eventKey: string): boolean {
    return queryOne(db, 'SELECT 1 AS x FROM loyalty_transactions WHERE event_key = ?', eventKey) !== undefined;
  },

  /** Points earned from chat since a time (for the daily limit). */
  chatEarnedSince(db: Database, platform: LoyaltyPlatform, userId: string, since: string): number {
    return (
      queryOne<{ n: number | null }>(db, "SELECT SUM(amount) AS n FROM loyalty_transactions WHERE platform = ? AND user_id = ? AND kind = 'chat' AND created_at >= ?", platform, userId, since)?.n ?? 0
    );
  },

  listAccounts(db: Database, f: { platform: LoyaltyPlatform | null; query: string | null; limit: number; offset: number }): { accounts: LoyaltyAccountRecord[]; total: number } {
    const where = ['1 = 1'];
    const params: string[] = [];
    if (f.platform) {
      where.push('platform = ?');
      params.push(f.platform);
    }
    if (f.query) {
      where.push("(display_name LIKE ? ESCAPE '\\' OR user_id = ?)");
      params.push(likeText(f.query), f.query);
    }
    const w = where.join(' AND ');
    const total = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM loyalty_accounts WHERE ${w}`, ...params)?.n ?? 0;
    const accounts = queryAll<LoyaltyAccountRecord>(
      db,
      `SELECT ${ACCOUNT} FROM loyalty_accounts WHERE ${w} ORDER BY balance DESC, lifetime_earned DESC, platform, user_id LIMIT ? OFFSET ?`,
      ...params,
      f.limit,
      f.offset,
    );
    return { accounts, total };
  },

  transactions(db: Database, platform: LoyaltyPlatform, userId: string, limit: number): LoyaltyTransactionRecord[] {
    return queryAll<LoyaltyTransactionRecord>(db, `SELECT ${TRANSACTION} FROM loyalty_transactions WHERE platform = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, platform, userId, limit);
  },

  recentTransactions(db: Database, limit: number): Array<LoyaltyTransactionRecord & { displayName: string | null }> {
    return queryAll(
      db,
      `SELECT t.id, t.platform, t.user_id AS userId, t.amount, t.balance_after AS balanceAfter, t.kind, t.reason, t.event_key AS eventKey,
         t.redemption_id AS redemptionId, t.created_at AS createdAt, a.display_name AS displayName
       FROM loyalty_transactions t JOIN loyalty_accounts a ON a.platform = t.platform AND a.user_id = t.user_id
       ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`,
      limit,
    );
  },

  /** Discord points totals, pending redemptions, and any older Kick balances (kept as history, no longer used). */
  stats(db: Database): { viewers: number; outstanding: number; pending: number; legacyKick: { accounts: number; points: number } } {
    const totals = (platform: LoyaltyPlatform) =>
      queryOne<{ n: number; points: number | null }>(db, 'SELECT COUNT(*) AS n, SUM(balance) AS points FROM loyalty_accounts WHERE platform = ?', platform);
    const discord = totals('discord');
    const kick = totals('kick');
    const pending = queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM loyalty_redemptions WHERE status = 'pending'")?.n ?? 0;
    return { viewers: discord?.n ?? 0, outstanding: discord?.points ?? 0, pending, legacyKick: { accounts: kick?.n ?? 0, points: kick?.points ?? 0 } };
  },

  // ── rewards ──

  listRewards(db: Database): LoyaltyRewardRecord[] {
    return queryAll<Parameters<typeof reward>[0]>(db, `SELECT ${REWARD} FROM loyalty_rewards WHERE archived_at IS NULL ORDER BY cost, lower(name)`).map(reward);
  },

  getReward(db: Database, id: string): LoyaltyRewardRecord | undefined {
    const r = queryOne<Parameters<typeof reward>[0]>(db, `SELECT ${REWARD} FROM loyalty_rewards WHERE id = ?`, id);
    return r ? reward(r) : undefined;
  },

  /** The active (not archived) reward with this name, ignoring case. */
  findRewardByName(db: Database, name: string): LoyaltyRewardRecord | undefined {
    const r = queryOne<Parameters<typeof reward>[0]>(db, `SELECT ${REWARD} FROM loyalty_rewards WHERE archived_at IS NULL AND lower(name) = lower(?)`, name);
    return r ? reward(r) : undefined;
  },

  insertReward(db: Database, r: Omit<LoyaltyRewardRecord, 'archivedAt'>): void {
    execute(
      db,
      'INSERT INTO loyalty_rewards (id, name, description, cost, enabled, stock, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      r.id,
      r.name,
      r.description,
      r.cost,
      r.enabled ? 1 : 0,
      r.stock,
      r.createdAt,
      r.updatedAt,
    );
  },

  updateReward(db: Database, id: string, r: Pick<LoyaltyRewardRecord, 'name' | 'description' | 'cost' | 'enabled' | 'stock'>, at: string): boolean {
    return (
      execute(
        db,
        'UPDATE loyalty_rewards SET name = ?, description = ?, cost = ?, enabled = ?, stock = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
        r.name,
        r.description,
        r.cost,
        r.enabled ? 1 : 0,
        r.stock,
        at,
        id,
      ) > 0
    );
  },

  /** Removes a reward from the catalog; it is kept (archived) for the redemption history. */
  archiveReward(db: Database, id: string, at: string): boolean {
    return execute(db, 'UPDATE loyalty_rewards SET archived_at = ?, enabled = 0, updated_at = ? WHERE id = ? AND archived_at IS NULL', at, at, id) > 0;
  },

  /** Takes one from a limited stock. False when none is left. Unlimited (null) always succeeds. */
  takeStock(db: Database, id: string): boolean {
    return execute(db, 'UPDATE loyalty_rewards SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - 1 END WHERE id = ? AND (stock IS NULL OR stock > 0)', id) > 0;
  },

  returnStock(db: Database, id: string): void {
    execute(db, 'UPDATE loyalty_rewards SET stock = stock + 1 WHERE id = ? AND stock IS NOT NULL', id);
  },

  // ── redemptions ──

  /** False when a redemption with this request key already exists (the same chat message or interaction). */
  insertRedemption(db: Database, r: Omit<LoyaltyRedemptionRecord, 'resolvedAt' | 'note' | 'status'>): boolean {
    return (
      execute(
        db,
        `INSERT INTO loyalty_redemptions (id, reward_id, reward_name, platform, user_id, display_name, cost, status, request_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (request_key) DO NOTHING`,
        r.id,
        r.rewardId,
        r.rewardName,
        r.platform,
        r.userId,
        r.displayName?.slice(0, 100) ?? null,
        r.cost,
        r.requestKey.slice(0, 200),
        r.createdAt,
      ) > 0
    );
  },

  getRedemption(db: Database, id: string): LoyaltyRedemptionRecord | undefined {
    return queryOne<LoyaltyRedemptionRecord>(db, `SELECT ${REDEMPTION} FROM loyalty_redemptions WHERE id = ?`, id);
  },

  listRedemptions(db: Database, status: LoyaltyRedemptionStatus | null, limit: number): LoyaltyRedemptionRecord[] {
    return status
      ? queryAll<LoyaltyRedemptionRecord>(db, `SELECT ${REDEMPTION} FROM loyalty_redemptions WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, status, limit)
      : queryAll<LoyaltyRedemptionRecord>(db, `SELECT ${REDEMPTION} FROM loyalty_redemptions ORDER BY created_at DESC, rowid DESC LIMIT ?`, limit);
  },

  /** Moves a pending redemption to fulfilled or rejected. False when it isn't pending (already resolved). */
  resolveRedemption(db: Database, id: string, status: 'fulfilled' | 'rejected', note: string | null, at: string): boolean {
    return execute(db, "UPDATE loyalty_redemptions SET status = ?, note = ?, resolved_at = ? WHERE id = ? AND status = 'pending'", status, note?.slice(0, 200) ?? null, at, id) > 0;
  },
};
