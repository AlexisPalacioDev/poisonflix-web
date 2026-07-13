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
      // same-origin exactly like production. Targets are env-overridable so a
      // dev machine that reaches the backends on a LAN IP (e.g. 192.168.1.61)
      // instead of localhost can point the proxy without editing this file.
      '/jellyfin': {
        target: process.env.JELLYFIN_TARGET ?? 'http://localhost:8096',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jellyfin/, ''),
      },
      // Mirrors infra/Caddyfile's `handle_path /jellyseerr/*`.
      '/jellyseerr': {
        target: process.env.JELLYSEERR_TARGET ?? 'http://localhost:5055',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jellyseerr/, ''),
      },
      // Prowlarr manual search for the availability preview. The API key is
      // injected here (server-side) from PROWLARR_API_KEY so it never ships in
      // the client bundle — the browser calls /prowlarr/* with no credential.
      // Mirrors infra/Caddyfile's `handle_path /prowlarr/*` (header_up X-Api-Key).
      '/prowlarr': {
        target: process.env.PROWLARR_TARGET ?? 'http://localhost:9696',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/prowlarr/, ''),
        configure: (proxy) => {
          const key = process.env.PROWLARR_API_KEY;
          if (key) {
            proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('X-Api-Key', key));
          }
        },
      },
      // Radarr (movies) and Sonarr (series) power live download-% (queue),
      // library delete, and download cancel. Same server-side X-Api-Key
      // injection pattern as Prowlarr so the key never ships to the client.
      // Mirror these `handle_path` blocks in infra/Caddyfile for production.
      '/radarr': {
        target: process.env.RADARR_TARGET ?? 'http://localhost:7878',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/radarr/, ''),
        configure: (proxy) => {
          const key = process.env.RADARR_API_KEY;
          if (key) {
            proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('X-Api-Key', key));
          }
        },
      },
      '/sonarr': {
        target: process.env.SONARR_TARGET ?? 'http://localhost:8989',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sonarr/, ''),
        configure: (proxy) => {
          const key = process.env.SONARR_API_KEY;
          if (key) {
            proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('X-Api-Key', key));
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
