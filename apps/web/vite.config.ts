import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the UI runs on Vite and calls the daemon through this proxy.
// In production the daemon serves the built UI itself (same origin).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:7878" } },
  build: { outDir: "dist", sourcemap: false },
});
