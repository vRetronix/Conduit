/**
 * Puts Zod in "jitless" mode for the desktop renderer. Import it before anything that defines a schema.
 *
 * Zod normally checks whether it may compile faster parsers with `new Function(...)`. The renderer's Content Security
 * Policy forbids that (no 'unsafe-eval'), so the check fails. Zod catches the failure and works anyway, but Chromium
 * still reports every blocked attempt as a CSP violation. In jitless mode Zod skips the check and uses its normal
 * parsers, so nothing is blocked and the CSP stays strict. Validation results are identical.
 */
import { z } from 'zod';

z.config({ jitless: true });
