import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * SPEC §11: the engine runs fully in-browser. core has zero I/O dependencies,
 * so importing it directly means the playground deploys as a static site with
 * no backend — only Tier 5 would need a proxy route.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
});
