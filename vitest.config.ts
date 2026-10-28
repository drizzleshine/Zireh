import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// The web app imports shadcn components through "@/"; tests resolve it the same way Vite does.
// .claude/ holds agent worktrees and context/ local notes and retired code: never part of this run.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./app/src", import.meta.url)) } },
  test: { exclude: [...configDefaults.exclude, ".claude/**", "context/**"] },
});
