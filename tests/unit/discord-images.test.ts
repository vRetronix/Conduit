import { describe, expect, it } from 'vitest';
import { DiscordImageCache } from '../../apps/server/src/discord/discord-images';

const HASH = 'a'.repeat(32);
const PNG = Buffer.from('png-bytes');

function cdn(respond: (url: string) => Response) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return respond(url);
  };
  return { urls, fetch };
}

describe('DiscordImageCache', () => {
  it('returns nothing at first, fetches in the background, then serves a data URL', async () => {
    const { urls, fetch } = cdn(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const images = new DiscordImageCache({ version: '1', fetch });
    expect(images.get('icon', '42', HASH)).toBeNull();
    await images.settled();
    expect(images.get('icon', '42', HASH)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(urls).toEqual([`https://cdn.discordapp.com/icons/42/${HASH}.png?size=64`]);
  });

  it('never fetches for a missing or malformed hash or id', async () => {
    const { urls, fetch } = cdn(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const images = new DiscordImageCache({ version: '1', fetch });
    for (const [id, hash] of [
      ['42', null],
      ['42', '../../evil'],
      ['42', 'A'.repeat(32)],
      ['1/../x', HASH],
    ] as const) {
      expect(images.get('avatar', id, hash)).toBeNull();
    }
    await images.settled();
    expect(urls).toEqual([]);
  });

  it('rejects non-images and oversized files, and waits before trying a failed image again', async () => {
    let now = 0;
    const { urls, fetch } = cdn((url) =>
      url.includes('/icons/')
        ? new Response('<html>', { headers: { 'content-type': 'text/html' } })
        : new Response(Buffer.alloc(200 * 1024), { headers: { 'content-type': 'image/png' } }),
    );
    const images = new DiscordImageCache({ version: '1', fetch, now: () => now });
    images.get('icon', '42', HASH);
    images.get('avatar', '7', HASH);
    await images.settled();
    expect(images.get('icon', '42', HASH)).toBeNull();
    expect(images.get('avatar', '7', HASH)).toBeNull();
    await images.settled();
    expect(urls).toHaveLength(2); // not retried immediately
    now = 11 * 60_000;
    images.get('icon', '42', HASH);
    await images.settled();
    expect(urls).toHaveLength(3);
  });

  it('a network failure just means no picture', async () => {
    const images = new DiscordImageCache({
      version: '1',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    images.get('avatar', '7', HASH);
    await images.settled();
    expect(images.get('avatar', '7', HASH)).toBeNull();
  });
});
