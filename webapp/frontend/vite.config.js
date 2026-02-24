import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    watch: {
      usePolling: true,  // Enable polling for Docker on Windows
      interval: 1000,    // Check for changes every second
    },
    hmr: {
      port: 3000,        // Hot Module Replacement port
    },
    proxy: {
      '/api': {
        target: process.env.NODE_ENV === 'production' 
          ? 'http://backend-container:5000'  // Use container name for Docker networking
          : 'http://backend-container:5000',  // Use backend container name for development
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
