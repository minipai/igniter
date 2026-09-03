import path from "node:path";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    conditions: ["browser"],
    dedupe: ["solid-js", "@solidjs/web"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.dom.test.tsx"],
  },
});
