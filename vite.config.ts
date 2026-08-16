import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // injectManifest, not generateSW. A generated worker would replace the
        // Web Push handlers this app already relies on, and only one service
        // worker can control a scope. src/sw.ts owns both concerns.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',

        // The worker is registered by hand from src/lib/pwa.ts so the update
        // and install flows can drive real UI rather than a browser default.
        injectRegister: null,
        registerType: 'prompt',

        // The brief asked for /manifest.json. The spec-registered extension is
        // .webmanifest, but .json is widely used and browsers accept either —
        // what matters is that the served Content-Type is JSON-ish, which it is.
        manifestFilename: 'manifest.json',

        manifest: {
          name: 'Yappr',
          short_name: 'Yappr',
          description: 'A social chat app for posts, group chats and direct messages.',
          // Brand blue for the browser/OS chrome…
          theme_color: '#123B8C',
          // …but the splash screen paints the app's real background, so launch
          // does not flash a colour the app never shows.
          background_color: '#050507',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          id: '/',
          icons: [
            {src: '/favicon/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any'},
            {src: '/favicon/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any'},
            // Separate entry rather than `purpose: "any maskable"`. A combined
            // value makes Android use the same art for both, and the maskable
            // file is inset into the 72% safe zone — it would look shrunken
            // wherever a plain icon was wanted.
            {src: '/favicon/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
          ],
        },

        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          // The JS bundle is ~1.25 MB, over Workbox's 2 MiB default only once
          // sourcemaps are counted; raised so a precache entry is never dropped
          // silently, which would leave the app broken offline with no warning.
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },

        devOptions: {
          // OFF by design.
          //
          // With this on, a worker registered in dev competes with one left
          // over from any production build you ran earlier, and the stale one
          // keeps serving its precached app shell — so the dev server is
          // running and silently bypassed. Source edits appear to do nothing
          // and values baked into the old bundle keep being sent. That cost
          // real debugging time here.
          //
          // src/lib/pwa.ts actively unregisters stray workers in dev for the
          // same reason. To exercise the PWA, build and run the production
          // server: `npm run build && NODE_ENV=production npx tsx server.ts`,
          // then `npm run verify:pwa`.
          enabled: false,
        },
      }),
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
