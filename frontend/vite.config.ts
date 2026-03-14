import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    proxy: {
      // Proxy /api requests to the Fastify server in development
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // Credentials (cookies) are forwarded automatically
      },
    },
  },

  build: {
    outDir: 'dist',
    // Output goes into the Fastify server's static files directory
    // Server serves dist/ at / in production (add @fastify/static)
  },
});
