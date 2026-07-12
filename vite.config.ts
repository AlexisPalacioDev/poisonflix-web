/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // PWA plugin present per design.md §9 but intentionally INACTIVE for MVP:
    // no service worker registration is wired up (injectRegister: null,
    // empty workbox globPatterns), so there's no offline caching / install
    // prompt yet. Deferred per tasks.md "Deferred" list. Wiring it live is
    // a later slice, not a retrofit of the plugin itself.
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      manifest: {
        name: 'poisonflix-web',
        short_name: 'poisonflix',
        description: 'Thin same-origin PWA client for Jellyfin + Jellyseerr',
        theme_color: '#0a0c10',
        background_color: '#0a0c10',
        display: 'standalone',
        icons: [],
      },
      workbox: {
        globPatterns: [],
      },
    }),
  ],
  server: {
    proxy: {
      // Mirrors infra/Caddyfile's `handle_path /jellyfin/*` (strips the
      // /jellyfin prefix before reverse-proxying to Jellyfin) so dev is
      // same-origin exactly like production.
      '/jellyfin': {
        target: 'http://localhost:8096',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jellyfin/, ''),
      },
      // Mirrors infra/Caddyfile's `handle_path /jellyseerr/*`.
      '/jellyseerr': {
        target: 'http://localhost:5055',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jellyseerr/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
