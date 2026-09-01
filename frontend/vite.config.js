import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,   // LAN 노출 — 폰에서 QR 스캔으로 접속하려면 필요 (localhost 대신 PC IP로 접속)
    allowedHosts: true,   // cloudflared 등 HTTPS 터널 도메인(*.trycloudflare.com) 접속 허용
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
