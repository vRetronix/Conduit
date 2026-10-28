/** Backend validation for the appearance preference (same rules as readAppearance in appearance.ts, with field errors). */
import { z } from 'zod';
import { DEFAULT_APPEARANCE, THEME_ID_PATTERN } from './appearance';

export const appearanceSchema = z.strictObject({
  themeId: z.string().regex(THEME_ID_PATTERN, 'Unknown theme').default(DEFAULT_APPEARANCE.themeId),
});
