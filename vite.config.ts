import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    fs: {
      // Setting deny replaces Vite's defaults, so they are repeated here (vite 8.3 defaults),
      // plus local secrets/config that the dev server must never serve.
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '.dev.vars',
        '.dev.vars.*',
        'wrangler.jsonc',
      ],
    },
  },
})
