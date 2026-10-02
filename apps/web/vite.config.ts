import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_URL ?? 'http://localhost:8080', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'charts';
          if (id.includes('node_modules/react-markdown') || id.includes('node_modules/micromark') || id.includes('node_modules/mdast') || id.includes('node_modules/unified') || id.includes('node_modules/remark')) return 'markdown';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler') || id.includes('node_modules/@tanstack') || id.includes('node_modules/zustand')) return 'vendor';
        },
      },
    },
  },
});
