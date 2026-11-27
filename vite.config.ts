import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true },
  preview: { port: 4180, strictPort: true },
  optimizeDeps: { exclude: ["mupdf", "harfbuzzjs"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
