import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true },
  preview: { port: 4180, strictPort: true },
  optimizeDeps: { exclude: ["mupdf", "harfbuzzjs"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    // "r1": new addresses for files a CDN edge cached uncompressed; keep or bump, never reuse old names
    rollupOptions: { output: { entryFileNames: "assets/[name]-r1-[hash].js", chunkFileNames: "assets/[name]-r1-[hash].js" } },
  },
});
