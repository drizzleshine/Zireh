import { useSyncExternalStore } from "react";

/** Light, dark, or follow the device. Stored per browser; index.html applies it before first paint. */
export type Theme = "system" | "light" | "dark";

const KEY = "zireh:theme";
const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let current: Theme = read();

function apply() {
  const dark = current === "dark" || (current === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

media.addEventListener("change", () => {
  if (current === "system") apply();
  for (const l of listeners) l();
});
apply();

export function setTheme(theme: Theme) {
  current = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* remembered for this visit only */
  }
  apply();
  for (const l of listeners) l();
}

export function useTheme(): { theme: Theme; dark: boolean } {
  const theme = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return { theme, dark: theme === "dark" || (theme === "system" && media.matches) };
}
