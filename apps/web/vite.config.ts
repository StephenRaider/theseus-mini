import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Strict Content-Security-Policy for the built app (dev needs inline scripts for hot reload). */
const csp = (): Plugin => ({
  name: "theseus-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:" />`,
    ),
});

export default defineConfig({
  plugins: [react(), csp()],
  // Relative asset paths: the built UI is served from app:// inside Electron.
  base: "./",
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
