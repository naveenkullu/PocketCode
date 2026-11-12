import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (path) => (
          path.startsWith("/api/ai/") ||
          path.startsWith("/api/github/") ||
          path.startsWith("/api/workspaces") ||
          path.startsWith("/api/agent/") ||
          path.startsWith("/api/repository-connections")
        ) ? path : path.replace(/^\/api/, ""),
      },
    },
  },
});