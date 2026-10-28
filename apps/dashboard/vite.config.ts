import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    // The desktop app serves these files over app://conduit.
    outDir: path.resolve(import.meta.dirname, '../desktop/dist/renderer'),
    emptyOutDir: true,
    target: 'es2023',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
