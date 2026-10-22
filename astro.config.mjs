import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://toolairy.com",
  integrations: [sitemap()],
  vite: {
    build: { target: "esnext" },
    optimizeDeps: { esbuildOptions: { target: "esnext" } },
  },
});