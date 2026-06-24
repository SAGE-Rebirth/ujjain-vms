import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, proxy /api to the central FastAPI server so the citizen app and admin
// dashboard share an origin. The checkpoint node (port 8001) is called directly
// via CORS, since the whole point is that it is a physically separate box.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
