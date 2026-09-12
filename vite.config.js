import { defineConfig } from 'vite';

// 127.0.0.1 (not localhost) so the same address works later as a Spotify redirect URI.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
