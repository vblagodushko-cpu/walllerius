import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        admin:  resolve(__dirname, 'admin.html'),
        login:  resolve(__dirname, 'login.html'),
        portal: resolve(__dirname, 'portal.html'),
      }
    }
  }
})
