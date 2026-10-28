import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages: https://abdullayevilkin.github.io/flimio/
  base: '/flimio/',
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        // previous, copy-only version: /flimio/simple.html
        simple: resolve(import.meta.dirname, 'simple.html'),
      },
    },
  },
})
