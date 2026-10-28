import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'apps/dashboard/src/**/*.test.tsx'],
    environment: 'node',
    pool: 'forks',
  },
});
