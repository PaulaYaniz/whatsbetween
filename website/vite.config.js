import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {cloudflare} from '@cloudflare/vite-plugin';

export default defineConfig({
  server: {
    port: 3000,
    open: true, // Open browser when server starts.
  },
  plugins: [cloudflare({configPath: './wrangler.jsonc', inspectorPort: false}), react()],
});
