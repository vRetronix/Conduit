// The renderer's CSP blocks eval. With zod-jitless imported first, Zod never tries `new Function`, so the CSP reports
// nothing (zod-eval-probe.test.ts shows the same check catches the probe without it). Separate files: each runs in its
// own process, so Zod's one-time probe result can't leak between them.
import { expect, it } from 'vitest';

it('with jitless imported first, creating and using schemas never constructs a Function', async () => {
  const RealFunction = globalThis.Function;
  let attempts = 0;
  globalThis.Function = new Proxy(RealFunction, {
    construct() {
      attempts++;
      throw new EvalError('Refused to evaluate a string as JavaScript (CSP)');
    },
  });
  try {
    await import('@conduit/shared/app/zod-jitless');
    const { embedSchema } = await import('@conduit/shared/discord/embeds');
    const { notifierSchema } = await import('@conduit/shared/kick/stream-notifications');
    expect(embedSchema.safeParse({ title: 'Hi' }).success).toBe(true);
    expect(notifierSchema.safeParse({ platform: 'kick', channel: 'x', guildId: '1', channelId: '2' }).success).toBe(true);
    expect(attempts).toBe(0);
  } finally {
    globalThis.Function = RealFunction;
  }
});
