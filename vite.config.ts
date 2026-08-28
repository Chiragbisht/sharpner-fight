import { defineConfig } from 'vite';

// One page: the game, at /. There is no separate landing page — anyone who
// arrives is put straight on the desk.
export default defineConfig({
  // Without this, Vite's dev server falls back to index.html for any path it
  // does not recognise — so /play quietly served the landing page again and the
  // game was unreachable. 'mpa' turns the fallback off and resolves directories.
  appType: 'mpa',
  // Pinned, not just Vite's default: this exact origin has to be registered in
  // the Google client ID's authorised JavaScript origins. If the port drifts,
  // Google rejects sign-in with origin_mismatch.
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        // The game is the site. play/ is only a redirect for room links that
        // were shared before the move.
        game: 'index.html',
        legacyPlay: 'play/index.html',
      },
    },
  },
});
