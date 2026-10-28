import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages: https://abdullayevilkin.github.io/flimio/
  base: '/flimio/',
})
