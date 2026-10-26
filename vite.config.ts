import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The API (sightline-backend, or mock/server.ts) listens on 127.0.0.1:8000.
// Proxying /api keeps dev same-origin, so the backend needs no CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    // Not Vite's 5173, which the Pattern Perspectives site dev server already takes.
    port: Number(process.env.PORT ?? 5180),
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
