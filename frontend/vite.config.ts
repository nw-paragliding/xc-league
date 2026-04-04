import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
        configure: (proxy, _options) => {
          proxy.on('proxyRes', (proxyRes, req, res) => {
            // Rewrite cookies from :3000 to :5173 so they work cross-port
            const cookies = proxyRes.headers['set-cookie'];
            if (cookies) {
              proxyRes.headers['set-cookie'] = cookies.map((cookie) =>
                cookie.replace(/Domain=localhost:3000/gi, 'Domain=localhost'),
              );
            }
          });
        },
      },
    },
  },

  build: {
    outDir: 'dist',
    // Output goes into the Fastify server's static files directory
    // Server serves dist/ at / in production (add @fastify/static)
  },
});
