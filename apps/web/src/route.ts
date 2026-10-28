import { useMemo, useSyncExternalStore } from "react";
import type { Tab } from "./components/CaseView.tsx";

/**
 * Where the app is, kept in the address bar so Back, Forward, reload and bookmarks all work:
 *   /                          the welcome page
 *   /settings                  settings
 *   /case/<id>                 a case, on Research
 *   /case/<id>/<tab>           a case, on that tab
 *   /case/<id>/<tab>/<item>    a case, with one item opened on that tab
 * Only ids go in the path. Case keys stay in invite fragments, which are never sent anywhere.
 */
export type Route = { view: "home" } | { view: "settings" } | { view: "case"; caseId: string; tab: Tab; item?: string };

export const TABS: readonly Tab[] = ["research", "evidence", "board", "timeline", "findings", "conclude", "log"];
const ID = /^[0-9a-z]{8,64}$/i;

export function parseRoute(path: string): Route {
  const [first, id, tab, item] = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (first === "settings") return { view: "settings" };
  if (first === "case" && id && ID.test(id)) {
    const t = TABS.find((x) => x === tab) ?? "research";
    return { view: "case", caseId: id, tab: t, ...(item && ID.test(item) && t === tab ? { item } : {}) };
  }
  return { view: "home" };
}

export function routePath(route: Route): string {
  if (route.view === "home") return "/";
  if (route.view === "settings") return "/settings";
  return `/case/${route.caseId}${route.tab === "research" && !route.item ? "" : `/${route.tab}`}${route.item ? `/${route.item}` : ""}`;
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
if (typeof window !== "undefined") window.addEventListener("popstate", notify);

/** Go somewhere. `replace` is for corrections (a missing case, the first redirect), not for clicks. */
export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}) {
  const path = routePath(route);
  if (path === location.pathname) return;
  history[replace ? "replaceState" : "pushState"](null, "", path);
  notify();
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => location.pathname,
    () => "/",
  );
  return useMemo(() => parseRoute(path), [path]);
}
