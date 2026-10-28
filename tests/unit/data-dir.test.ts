import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATABASE_FILE, defaultDataDirectory } from '@conduit/database';
import { envValue } from '@conduit/shared/app/config';

describe('data directory', () => {
  it('the database file is conduit.db', () => {
    expect(DATABASE_FILE).toBe('conduit.db');
  });

  it('defaults to %APPDATA%\\CONDUIT on Windows and ~/.conduit elsewhere', () => {
    const appData = 'C:\\Users\\x\\AppData\\Roaming';
    expect(defaultDataDirectory({ APPDATA: appData }, 'C:\\Users\\x')).toBe(path.join(appData, 'CONDUIT'));
    expect(defaultDataDirectory({}, '/home/x')).toBe(path.join('/home/x', '.conduit'));
  });

  it('CONDUIT_DATA_DIR is read as-is (blank counts as unset); no other names are read', () => {
    expect(envValue({ CONDUIT_DATA_DIR: ' D:/data ' }, 'CONDUIT_DATA_DIR')).toBe('D:/data');
    expect(envValue({ CONDUIT_DATA_DIR: '   ' }, 'CONDUIT_DATA_DIR')).toBeUndefined();
    expect(envValue({ DATA_DIR: 'D:/x' }, 'CONDUIT_DATA_DIR')).toBeUndefined();
  });
});
