import { execute, queryAll, queryOne, type Database } from '../sqlite';

// Kick clips of the streamer's channel (migration 28).

export interface KickClipRecord {
  id: string;
  channelSlug: string;
  title: string;
  creatorName: string | null;
  category: string | null;
  durationSeconds: number;
  views: number;
  thumbnailUrl: string | null;
  videoUrl: string;
  vodId: string | null;
  /** When it was clipped, on Kick. */
  createdAt: string;
  firstSeenAt: string;
  savedPath: string | null;
  savedAt: string | null;
  discordChannelId: string | null;
  discordMessageId: string | null;
  postedAt: string | null;
  postProblem: string | null;
}

/** What Kick says about a clip (the rest is CONDUIT's own). */
export type KickClipSeen = Pick<KickClipRecord, 'id' | 'channelSlug' | 'title' | 'creatorName' | 'category' | 'durationSeconds' | 'views' | 'thumbnailUrl' | 'videoUrl' | 'createdAt'>;

/** At most this many are kept; the oldest go first. */
const KEPT = 2000;

interface Row {
  id: string;
  channel_slug: string;
  title: string;
  creator_name: string | null;
  category: string | null;
  duration_seconds: number;
  views: number;
  thumbnail_url: string | null;
  video_url: string;
  vod_id: string | null;
  created_at: string;
  first_seen_at: string;
  saved_path: string | null;
  saved_at: string | null;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  posted_at: string | null;
  post_problem: string | null;
}

const toRecord = (r: Row): KickClipRecord => ({
  id: r.id,
  channelSlug: r.channel_slug,
  title: r.title,
  creatorName: r.creator_name,
  category: r.category,
  durationSeconds: r.duration_seconds,
  views: r.views,
  thumbnailUrl: r.thumbnail_url,
  videoUrl: r.video_url,
  vodId: r.vod_id,
  createdAt: r.created_at,
  firstSeenAt: r.first_seen_at,
  savedPath: r.saved_path,
  savedAt: r.saved_at,
  discordChannelId: r.discord_channel_id,
  discordMessageId: r.discord_message_id,
  postedAt: r.posted_at,
  postProblem: r.post_problem,
});

export const kickClipsRepo = {
  /** Adds a clip, or refreshes what Kick says about it (title, views…). True when it's new. */
  upsert(db: Database, c: KickClipSeen, at: string): boolean {
    const known = queryOne<{ id: string }>(db, 'SELECT id FROM kick_clips WHERE id = ?', c.id);
    if (known) {
      execute(
        db,
        `UPDATE kick_clips SET title = ?, creator_name = ?, category = ?, duration_seconds = ?, views = ?, thumbnail_url = ?, video_url = ?
         WHERE id = ?`,
        c.title.slice(0, 200),
        c.creatorName,
        c.category,
        c.durationSeconds,
        c.views,
        c.thumbnailUrl,
        c.videoUrl,
        c.id,
      );
      return false;
    }
    execute(
      db,
      `INSERT INTO kick_clips (id, channel_slug, title, creator_name, category, duration_seconds, views, thumbnail_url, video_url, created_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id,
      c.channelSlug,
      c.title.slice(0, 200),
      c.creatorName,
      c.category,
      c.durationSeconds,
      c.views,
      c.thumbnailUrl,
      c.videoUrl,
      c.createdAt,
      at,
    );
    execute(db, `DELETE FROM kick_clips WHERE id NOT IN (SELECT id FROM kick_clips ORDER BY created_at DESC LIMIT ${KEPT})`);
    return true;
  },

  get(db: Database, id: string): KickClipRecord | null {
    const r = queryOne<Row>(db, 'SELECT * FROM kick_clips WHERE id = ?', id);
    return r ? toRecord(r) : null;
  },

  /** Newest first. */
  list(db: Database, channelSlug: string, limit: number): KickClipRecord[] {
    return queryAll<Row>(db, 'SELECT * FROM kick_clips WHERE channel_slug = ? ORDER BY created_at DESC LIMIT ?', channelSlug, limit).map(toRecord);
  },

  setVod(db: Database, id: string, vodId: string | null): void {
    execute(db, 'UPDATE kick_clips SET vod_id = ? WHERE id = ?', vodId, id);
  },

  setSaved(db: Database, id: string, savedPath: string | null, at: string | null): void {
    execute(db, 'UPDATE kick_clips SET saved_path = ?, saved_at = ? WHERE id = ?', savedPath, at, id);
  },

  setPosted(db: Database, id: string, p: { channelId: string; messageId: string; at: string } | { problem: string }): void {
    if ('problem' in p) execute(db, 'UPDATE kick_clips SET post_problem = ? WHERE id = ?', p.problem.slice(0, 300), id);
    else execute(db, 'UPDATE kick_clips SET discord_channel_id = ?, discord_message_id = ?, posted_at = ?, post_problem = NULL WHERE id = ?', p.channelId, p.messageId, p.at, id);
  },
};
