/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const API_TARGET = 'http://127.0.0.1:8081';

/**
 * The page's Content-Security-Policy, as a <meta> tag in the production build only (the dev server
 * needs inline scripts for hot reload). Everything is same-origin: the fonts are bundled, Socket.IO
 * is on our own host, and no avatar or other third-party image is ever shown. data: is for the
 * inline favicon. A meta CSP can't carry frame-ancestors; the web image's Caddy sends the same
 * policy plus frame-ancestors as a header (web/Caddyfile, kept equal by src/caddyfile.test.ts).
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'hisaab-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: WEB_CSP }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cspMeta()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, ws: true } }, // ws: Socket.IO at /api/socket.io
  },
  preview: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, ws: true } }, // ws: Socket.IO at /api/socket.io
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
