import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

let cachedRepoRoot: string | null = null;

export function getRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;
  let curr = process.cwd();
  while (curr !== dirname(curr)) {
    const pkg = join(curr, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8"));
        if (json.workspaces) {
          cachedRepoRoot = curr;
          return curr;
        }
      } catch {}
    }
    curr = dirname(curr);
  }
  cachedRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return cachedRepoRoot;
}

export function getRootDir(relativeSubpath = "output"): string {
  return resolve(getRepoRoot(), relativeSubpath);
}
