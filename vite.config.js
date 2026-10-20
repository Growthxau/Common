import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/site',
    emptyOutDir: true,
  },
});
