// CLI: npm run audit -w agent -- [--serve <dir>] --url <path|absolute>... [--level L] [--out D]
// Local runs audit over http (127.0.0.1) so the same code path as CI/production
// applies. Non-local URLs require an explicit --allow-host.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LocalStore, type AuditStore } from "./store/index.ts";
import { SupabaseStore } from "./store/supabase.ts";
import { runAudit } from "./agent/orchestrator.ts";
import { newRunId } from "./ids.ts";
import { serveDir } from "./serve.ts";
import { getRepoRoot } from "./paths.ts";
import { loadWorkerRun } from "./worker_run.ts";

interface Args {
  serve?: string;
  urls: string[];
  level: string;
  out: string;
  allowHosts: string[];
  runId?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { urls: [], level: "WCAG2.2-AA", out: "output", allowHosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--serve") args.serve = argv[++i];
    else if (a === "--url") args.urls.push(argv[++i] ?? "");
    else if (a === "--level") args.level = argv[++i] ?? args.level;
    else if (a === "--out") args.out = argv[++i] ?? args.out;
    else if (a === "--allow-host") args.allowHosts.push((argv[++i] ?? "").toLowerCase());
    else if (a === "--run") args.runId = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.urls.length === 0 && !args.runId) {
  console.error("usage: npm run audit -w agent -- (--run <run_id> | [--serve <dir>] --url <path|absolute>...) [--level WCAG2.2-AA] [--out output] [--allow-host h]");
  process.exit(2);
}



let baseUrl = "";
if (args.serve) {
  const dir = existsSync(args.serve) ? resolve(args.serve) : resolve(getRepoRoot(), args.serve);
  const server = await serveDir(dir);
  baseUrl = server.url;
  console.log(`serving ${dir} at ${baseUrl}`);
}
let urls = args.urls.map((u) => (/^https?:\/\//.test(u) ? u : baseUrl + u));
let targetLevel = args.level;
let maxPages = Number(process.env.MAX_PAGES_PER_RUN ?? 5);
let store: AuditStore;
if (args.runId) {
  store = new SupabaseStore(args.runId);
  const cfg = await loadWorkerRun(store, args.runId, Number(process.env.MAX_PAGES_PER_RUN ?? 5));
  urls = cfg.urls;
  targetLevel = cfg.targetLevel;
  maxPages = cfg.maxPages;
  console.log(`worker run ${args.runId}: loaded ${urls.length} page input(s) from Supabase`);
} else {
  const runId = newRunId();
  const outResolved = resolve(getRepoRoot(), args.out);
  store = await LocalStore.open(outResolved, runId);
  console.log(`run ${runId} → ${outResolved}/${runId}/`);
}
const allowedHosts = [...new Set([...urls.map((u) => new URL(u).hostname.toLowerCase()), ...args.allowHosts])];

const { status } = await runAudit({
  urls,
  targetLevel,
  maxPages,
  allowedHosts,
  store,
});

const doc = await store.read();
const counts = { fail: 0, uncertain: 0, pass: 0 };
for (const f of doc.findings) counts[f.state]++;
console.log(`status: ${status}; findings: ${counts.fail} fail / ${counts.uncertain} uncertain / ${counts.pass} pass`);
for (const f of doc.findings) {
  console.log(`  [${f.state.toUpperCase()}] ${f.rule_id} (${f.wcag_criterion}, ${f.check_type}) ${f.selector ?? ""} — ${f.reason}`);
}
process.exit(status === "done" || status === "awaiting_approval" ? 0 : 1);
