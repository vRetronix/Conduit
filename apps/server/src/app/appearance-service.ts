/**
 * Settings → Appearance & Themes: the saved theme, glass intensity and density (one app_settings key). Only these
 * preferences are touched; resetting them never affects credentials, integrations or other settings.
 */
import { settingsRepo, SETTING_KEYS, type Database } from '@conduit/database';
import { appearanceSchema, readAppearance, type Appearance } from '@conduit/shared';
import { parseInput } from '../validation';

export class AppearanceService {
  constructor(private readonly o: { db: Database; now: () => Date }) {}

  get(): Appearance {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.appearance);
    if (!raw) return readAppearance({});
    try {
      return readAppearance(JSON.parse(raw));
    } catch {
      return readAppearance({});
    }
  }

  save(raw: unknown): Appearance {
    const next = parseInput(appearanceSchema, raw);
    settingsRepo.set(this.o.db, SETTING_KEYS.appearance, JSON.stringify(next), this.o.now().toISOString());
    return next;
  }
}
