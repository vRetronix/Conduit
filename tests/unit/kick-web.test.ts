/** Kick website data for !followage: safe requests, soft failures, caching and pausing. */
import { describe, expect, it } from 'vitest';
import { KickWebData } from '../../apps/server/src/kick/kick-web';

function setup(respond: (url: string) => Response | Promise<Response>) {
  let t = Date.parse('2026-10-18T12:00:00Z');
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const web = new KickWebData({
    now: () => new Date(t),
    fetch: async (url, init) => {
      urls.push(url);
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return respond(url);
    },
  });
  return { web, urls, headers, advance: (ms: number) => (t += ms) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const FOLLOWING = { following_since: '2025-01-02T03:04:05.000000Z', subscribed_for: 7 };

describe('Kick website data (!followage)', () => {
  it('reads a viewer’s follow date and sub months; sends no credentials', async () => {
    const { web, urls, headers } = setup(() => json(FOLLOWING));
    expect(await web.viewer('retronix', 'MyChatBot')).toEqual({ followingSince: '2025-01-02T03:04:05.000000Z', subscribedFor: 7 });
    expect(urls).toEqual(['https://kick.com/api/v2/channels/retronix/users/mychatbot']);
    expect(Object.keys(headers[0]!).sort()).toEqual(['accept', 'user-agent']);
    const notFollowing = setup(() => json({ following_since: null, subscribed_for: 0 }));
    expect(await notFollowing.web.viewer('retronix', 'someone')).toEqual({ followingSince: null, subscribedFor: null });
  });

  it('names from chat can’t steer the request: anything but a Kick name is refused without a request', async () => {
    const { web, urls } = setup(() => json({}));
    for (const bad of ['../../admin', 'a/b', 'x?y=1', 'http://evil', '', 'a'.repeat(26), 'some one']) {
      expect(await web.viewer(bad, 'viewer')).toBeNull();
      expect(await web.viewer('retronix', bad)).toBeNull();
    }
    expect(urls).toEqual([]);
  });

  it('caches answers for a few minutes', async () => {
    const { web, urls, advance } = setup(() => json(FOLLOWING));
    await web.viewer('retronix', 'viewer');
    await web.viewer('retronix', 'viewer');
    expect(urls).toHaveLength(1);
    advance(5 * 60_000 + 1);
    await web.viewer('retronix', 'viewer');
    expect(urls).toHaveLength(2);
  });

  it('when Kick refuses (403 / 429 / 5xx) it pauses instead of retrying, then tries again later', async () => {
    let status = 403;
    const { web, urls, advance } = setup(() => (status === 200 ? json(FOLLOWING) : new Response('blocked', { status })));
    expect(await web.viewer('retronix', 'viewer')).toBeNull();
    expect(await web.viewer('retronix', 'other')).toBeNull(); // paused: no request
    expect(urls).toHaveLength(1);
    status = 200;
    advance(10 * 60_000 + 1);
    expect((await web.viewer('retronix', 'other'))?.followingSince).toBe(FOLLOWING.following_since);
  });

  it('network errors, timeouts, non-JSON and oversized answers give nothing, never an error', async () => {
    for (const respond of [
      () => Promise.reject(new TypeError('fetch failed')),
      () => new Response('<html>Just a moment…</html>', { status: 200 }),
      () => new Response('x'.repeat(300 * 1024), { status: 200 }),
      () => json(['not', 'an', 'object']),
      () => new Response('not found', { status: 404 }),
    ]) {
      const { web } = setup(respond);
      await expect(web.viewer('retronix', 'viewer')).resolves.toBeNull();
    }
  });
});
