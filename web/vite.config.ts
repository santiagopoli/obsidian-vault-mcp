import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/web": "http://127.0.0.1:8787",
      "/callback": "http://127.0.0.1:8787",
      "/authorize": "http://127.0.0.1:8787",
      "/consent": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
    },
  },
});
