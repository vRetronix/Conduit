// Control for zod-jitless.test.ts: without jitless, Zod probes `new Function` on first use; the browser reports that as a
// CSP violation. If this ever stops failing the probe, the jitless test proves nothing and should be revisited.
import { expect, it } from 'vitest';

it('without jitless, Zod probes new Function when an object schema is used', async () => {
  const RealFunction = globalThis.Function;
  let attempts = 0;
  globalThis.Function = new Proxy(RealFunction, {
    construct() {
      attempts++;
      throw new EvalError('Refused to evaluate a string as JavaScript (CSP)');
    },
  });
  try {
    const { embedSchema } = await import('@conduit/shared/discord/embeds');
    expect(embedSchema.safeParse({ title: 'Hi' }).success).toBe(true); // still works: Zod swallows the refusal
    expect(attempts).toBeGreaterThan(0);
  } finally {
    globalThis.Function = RealFunction;
  }
});
