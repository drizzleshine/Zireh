import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app runs entirely in the browser and calls the Zireh host directly (VITE_HOST_URL,
// default http://127.0.0.1:8788). The on-device model runs in a module worker.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, host: "127.0.0.1" },
  worker: { format: "es" },
  build: { outDir: "dist", sourcemap: false },
});
