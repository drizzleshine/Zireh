/**
 * Enforces the package layering in context/architecture.md §4:
 *  - every package declares `zireh.layer` in package.json;
 *  - a package may depend only on @zireh packages in strictly lower layers;
 *  - apps may depend on any package but never on another app;
 *  - every @zireh import in source is a declared dependency.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
type Pkg = { name: string; dir: string; kind: "package" | "app"; layer: number; deps: string[] };

/** Packages live in packages/*; apps are app/ and the servers being retired in legacy/*. */
function dirsOf(kind: "package" | "app"): string[] {
  const under = (base: string) =>
    existsSync(join(root, base)) ? readdirSync(join(root, base)).map((d) => join(root, base, d)) : [];
  return kind === "package" ? under("packages") : [join(root, "app"), ...under("legacy")];
}

function load(kind: "package" | "app"): Pkg[] {
  return dirsOf(kind)
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => {
      const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const deps = Object.keys({ ...json.dependencies, ...json.devDependencies }).filter((n) => n.startsWith("@zireh/"));
      return { name: json.name, dir, kind, layer: json.zireh?.layer ?? Infinity, deps };
    });
}

function sourceImports(dir: string): Set<string> {
  const found = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name))
        for (const m of readFileSync(p, "utf8").matchAll(/from\s+["'](@zireh\/[a-z-]+)/g)) found.add(m[1]!);
    }
  };
  for (const sub of ["src", "test"]) if (existsSync(join(dir, sub))) walk(join(dir, sub));
  return found;
}

const packages = load("package");
const apps = load("app");
const byName = new Map([...packages, ...apps].map((p) => [p.name, p]));
const errors: string[] = [];

for (const p of [...packages, ...apps]) {
  if (p.kind === "package" && !Number.isFinite(p.layer)) errors.push(`${p.name}: missing zireh.layer`);
  for (const dep of p.deps) {
    const target = byName.get(dep);
    if (!target) errors.push(`${p.name}: unknown dependency ${dep}`);
    else if (target.kind === "app") errors.push(`${p.name}: depends on app ${dep}`);
    else if (p.kind === "package" && target.layer >= p.layer)
      errors.push(`${p.name} (L${p.layer}) → ${dep} (L${target.layer}): must point to a lower layer`);
  }
  for (const imp of sourceImports(p.dir))
    if (imp !== p.name && !p.deps.includes(imp)) errors.push(`${p.name}: imports ${imp} without declaring it`);
}

if (errors.length) {
  console.error(`layer check failed:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
const rows = packages.sort((a, b) => a.layer - b.layer).map((p) => `L${p.layer} ${p.name}`);
console.log(`layers ok (${packages.length} packages, ${apps.length} apps)\n  ${rows.join("\n  ")}`);
