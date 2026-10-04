import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  root: __dirname,
  build: {
    outDir: '../../dist/console',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // The dev proxy normally points at `npm run dev` on :3000; tests inject
      // the harness runtime's port so the Console can run against a real
      // runtime that is not the developer's own.
      '/v1': process.env.CONSOLE_API_TARGET ?? 'http://localhost:3000',
    },
  },
});
