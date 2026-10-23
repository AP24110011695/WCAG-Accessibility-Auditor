// Privacy & secrets scan over everything that would be committed to the
// public repo. Flags secret-shaped strings (GitHub PATs, OpenAI/Groq/Google
// keys, JWTs, Supabase sb_secret_/sb_publishable_, passcode assignments) and
// absolute local paths (privacy leak: usernames, directory layout).
// Reusable verification script — documented in README §Verification.
import fs from "node:fs";
import path from "node:path";

// Everything that would be committed (no node_modules, no web/dist build).
const TARGETS = [
  ".env.example", ".gitignore", "package.json", "package-lock.json", "README.md",
  "prd.md", "architecture.md", "rules.md", "design.md", "tasks.md", "memory.md",
  "agent/src", "agent/test", "agent/package.json", "agent/tsconfig.json",
  "web/src", "web/index.html", "web/package.json", "web/tsconfig.json", "web/vite.config.ts",
  "demo-site", "supabase", ".github", "docs",
  "output/official", "output/evidence-pack",
];

const secretPatterns = [
  [/ghp_[A-Za-z0-9]{20,}/, "GitHub classic PAT"],
  [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained PAT"],
  [/sk-[A-Za-z0-9]{20,}/, "OpenAI-style key"],
  [/gsk_[A-Za-z0-9]{20,}/, "Groq key"],
  [/AIza[A-Za-z0-9_-]{20,}/, "Google API key"],
  [/sb_secret_[A-Za-z0-9_]{20,}/, "Supabase secret key"],
  [/sb_publishable_[A-Za-z0-9_]{20,}/, "Supabase publishable key"],
  [/eyJ[A-Za-z0-9_-]{30,}/, "JWT (legacy Supabase key shape)"],
  [/\b(?:password|passcode|secret|token|api_key|apikey)\s*[:=]\s*["'][^"']{8,}["']/i, "hardcoded credential assignment"],
];

const privacyPatterns = [
  // A real drive path has a directory separator after the first segment, so
  // JSON escapes like "following:\n" don't false-positive.
  [/[A-Za-z]:\\(?:[^\s"\\/]+\\)+[^\s"\\/]*/, "absolute Windows path"],
  [/(?:\/Users\/|\/home\/)[A-Za-z0-9_.-]+/, "absolute POSIX home path"],
];

const files = [];
function walk(target) {
  const full = path.resolve(target);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isFile()) { files.push(full); return; }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    if (entry.isDirectory()) walk(path.join(target, entry.name));
    else if (!/\.(png|jpe?g|webm|ico|woff2?|webp)$/i.test(entry.name)) files.push(path.join(full, entry.name));
  }
}

for (const t of TARGETS) walk(t);

const findings = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, idx) => {
    if (line.includes("data:image/")) return; // base64 evidence payloads are expected in the pack
    for (const [re, label] of secretPatterns) {
      if (re.test(line)) findings.push({ file: path.relative(process.cwd(), file), line: idx + 1, label, text: line.trim().slice(0, 110) });
    }
    for (const [re, label] of privacyPatterns) {
      if (re.test(line)) findings.push({ file: path.relative(process.cwd(), file), line: idx + 1, label, text: line.trim().slice(0, 110) });
    }
  });
}

console.log(`Files scanned: ${files.length}`);
console.log(`Findings: ${findings.length}`);
for (const f of findings) console.log(`  [${f.label}] ${f.file}:${f.line} → ${f.text}`);
process.exit(findings.length === 0 ? 0 : 1);
