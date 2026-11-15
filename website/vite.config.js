import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {cloudflare} from '@cloudflare/vite-plugin';

export default defineConfig({
  server: {
    port: 3000,
    open: true, // Open browser when server starts.
  },
  // Demoing from this Mac: the preview is reached through a Cloudflare Tunnel on these hosts.
  preview: {
    allowedHosts: ['whatsbetween.us', 'www.whatsbetween.us', '.trycloudflare.com'],
  },
  plugins: [cloudflare({configPath: './wrangler.jsonc', inspectorPort: false}), react()],
});
