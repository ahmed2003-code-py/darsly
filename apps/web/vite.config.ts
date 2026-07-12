import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Build-time id used to version the service-worker cache so each deploy evicts
  // the previous build's cached assets (see public/sw.js + main.tsx).
  define: {
    __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? String(Date.now())),
  },
  resolve: {
    alias: {
      // Consume the workspace package from TS source: its dist is CommonJS
      // (for the NestJS API) which Rollup won't tree-shake named exports from.
      '@darsly/shared-types': fileURLToPath(
        new URL('../../packages/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // Polling avoids inotify-instance exhaustion (EMFILE) on Linux dev machines.
    // Set VITE_NO_POLLING=1 to use native watchers if your system allows.
    watch: process.env.VITE_NO_POLLING ? undefined : { usePolling: true, interval: 1000 },
  },
});
