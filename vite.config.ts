import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/, so the deploy workflow sets BASE_PATH
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  test: {
    environment: "node",
  },
} as any);
