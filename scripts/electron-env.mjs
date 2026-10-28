// Environment handling for launching Electron from the development scripts (`npm run dev`, `npm start`).
//
// Tools launched from VS Code's extension host (and other Electron-based tools) can pass ELECTRON_RUN_AS_NODE=1 to
// their children. Electron would then start as a plain Node.js runtime instead of the app. The variable is removed
// only from the environment of the Electron child process we spawn; the caller's own environment is not modified.
// Packaged builds are immune regardless: their RunAsNode fuse is disabled (apps/desktop/electron-builder.yml).

/** Variables that must never reach the Electron app process. */
export const STRIPPED_VARIABLES = ['ELECTRON_RUN_AS_NODE'];

/**
 * Reads CONDUIT_* settings from a local, git-ignored env file
 * (e.g. `.env.local`) for development: KEY=VALUE
 * lines, `#` comments, optional surrounding quotes. Other variable names are ignored. Values set in the real
 * environment win. Never logged.
 */
export function readLocalEnvFile(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(CONDUIT_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) out[match[1]] = value;
  }
  return out;
}

/** A copy of `parentEnv` (plus `extra`) that is safe to pass to the Electron app process. */
export function electronChildEnv(parentEnv, extra = {}) {
  const env = { ...parentEnv, ...extra };
  for (const name of Object.keys(env)) {
    if (STRIPPED_VARIABLES.includes(name.toUpperCase())) delete env[name];
  }
  return env;
}
