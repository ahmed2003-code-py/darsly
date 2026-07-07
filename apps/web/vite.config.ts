import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Polling avoids inotify-instance exhaustion (EMFILE) on Linux dev machines.
    // Set VITE_NO_POLLING=1 to use native watchers if your system allows.
    watch: process.env.VITE_NO_POLLING ? undefined : { usePolling: true, interval: 1000 },
  },
});
