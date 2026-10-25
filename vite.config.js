import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, host: true },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // three.js is a single ~575 kB vendor chunk on purpose (one entry, no
    // network waterfall for a local app); don't nag about it
    chunkSizeWarningLimit: 900,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // one js + one css file: this app has exactly one entry point
        manualChunks: () => 'app',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // the browser render test boots a real GPU context
    testTimeout: 320000,
  },
});
