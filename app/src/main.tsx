import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { load, startSyncLoop } from "./store.ts";
import "@fontsource-variable/outfit/index.css";
import "./index.css";
import "./theme.ts";

await load();
startSyncLoop();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
