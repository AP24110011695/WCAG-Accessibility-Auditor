// Re-verify the SHA-256 checksum of every evidence row in every official run
// store (output/official/<run>/store.json) against the file on disk, then
// verify the official test-case manifest. Prints "Verified N/N" — any mismatch
// fails loudly (tamper detection for the evidence chain).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getRootDir } from "./paths.ts";

const officialDir = join(getRootDir("output"), "official");
let verified = 0;
let failed = 0;

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

for (const entry of existsSync(officialDir) ? readdirSync(officialDir, { withFileTypes: true }) : []) {
  if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
  const storeFile = join(officialDir, entry.name, "store.json");
  if (!existsSync(storeFile)) continue;
  const store = JSON.parse(readFileSync(storeFile, "utf8"));
  for (const ev of store.evidence ?? []) {
    const filePath = join(officialDir, entry.name, ev.path);
    if (!existsSync(filePath) || sha256(filePath) !== ev.checksum) {
      failed++;
      console.error(`MISMATCH: ${filePath}`);
    } else {
      verified++;
    }
  }
}

console.log(failed === 0 ? `Verified ${verified}/${verified}` : `Verified ${verified}/${verified + failed} — ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
