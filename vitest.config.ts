import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The web app imports shadcn components through "@/"; tests resolve it the same way Vite does.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
});
