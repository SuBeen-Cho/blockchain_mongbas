import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devHost = process.env.VITE_DEV_HOST || '127.0.0.1';
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS || 'localhost,127.0.0.1')
  .split(',')
  .map(host => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: devHost,
    allowedHosts,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
