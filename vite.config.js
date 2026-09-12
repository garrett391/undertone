import { defineConfig } from 'vite';

// 127.0.0.1 (not localhost) so the same address works later as a Spotify redirect URI.
export default defineConfig({
  base: '/undertone/', // repo name for a project site; use '/' on a username.github.io repo
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
