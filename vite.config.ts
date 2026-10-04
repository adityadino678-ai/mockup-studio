import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Cross-origin isolation unlocks SharedArrayBuffer, which onnxruntime-web needs
 * for multi-threaded wasm — the difference between a couple of seconds and most
 * of a minute per design in the background remover. Only the dev and preview
 * servers can set these; a static host has to send the same two headers, and
 * without them the remover still works, just single-threaded.
 */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
});
