import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: { externalizeDeps: true, rollupOptions: { input: {
      index: resolve(__dirname, 'src/main/index.ts'),
      'vpn-proxy': resolve(__dirname, 'src/main/vpn/proxy/entry.ts'),
    } } },
  },
  preload: {
    resolve: { alias: shared },
    // The preload runs sandboxed: it may only require('electron'), so bundle zod into it.
    build: { externalizeDeps: false, rollupOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    resolve: { alias: { ...shared, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()],
  },
})
