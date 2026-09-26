import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Every directory under pages/ is one demo page with its own index.html.
const pagesDir = resolve(__dirname, 'pages');
const pages = Object.fromEntries(
  readdirSync(pagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [entry.name, resolve(pagesDir, entry.name, 'index.html')]),
);

export default defineConfig({
  base: './',
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        ...pages,
      },
    },
  },
});
