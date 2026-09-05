import { defineConfig } from 'vite'

export default defineConfig({
  // The .ehpk is served from a file-relative root inside the Even app WebView,
  // so absolute asset paths would not resolve.
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  server: {
    // Bound to every interface so `evenhub qr` can point the phone at this
    // machine over the LAN.
    host: true,
    port: 5173,
  },
})
