import path from "node:path";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { API_PORT, WEB_PORT } from "./src/server/ports.ts";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["solid-js", "@solidjs/web"],
  },
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${API_PORT}`,
      "/events": `http://localhost:${API_PORT}`,
    },
  },
});
