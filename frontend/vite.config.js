import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin API in development, mirroring the Vercel rewrite in production
    proxy: { '/api': process.env.VITE_API_PROXY || 'http://localhost:3000' },
  },
});
