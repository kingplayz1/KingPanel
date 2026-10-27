import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // @tailwindcss/vite must run for Tailwind v4 (`@import "tailwindcss"` in
    // src/index.css) — without it the build ships no generated utilities and
    // the UI renders unstyled (the plugin scans sources and emits utilities).
    plugins: [react(), tailwindcss()],
    build: {
      sourcemap: false,
      minify: 'esbuild' as const,
      target: 'es2022',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
      reportCompressedSize: false,
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
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});