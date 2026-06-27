import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/ams/',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:47821', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:47821', ws: true, changeOrigin: true },
    },
  },
})
