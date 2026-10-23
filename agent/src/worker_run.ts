// Worker-side load + revalidation of the persisted run row (audit.yml `--run`
// path). A tampered or corrupted row must be refused before any browser starts
// (FR-01): the page cap always comes from the worker's own environment, so a
// row that claims a higher cap is still held to it.
import { validateAuditInput } from "./validate.ts";
import type { AuditStore } from "./store/index.ts";

interface WorkerRunConfig {
  urls: string[];
  targetLevel: string;
  maxPages: number;
  allowedHosts: string[];
}

export async function loadWorkerRun(store: AuditStore, runId: string, envMaxPages: number): Promise<WorkerRunConfig> {
  const doc = await store.read();
  const run = doc.runs[0];
  if (!run) throw new Error(`Run ${runId} was not found in Supabase`);
  const maxPages = Math.min(run.config_json.max_pages ?? envMaxPages, envMaxPages);
  const errors = validateAuditInput(
    { urls: run.config_json.urls, target_level: run.config_json.target_level },
    { maxPages, allowedHosts: run.config_json.allowed_hosts ?? [] },
  );
  if (errors.length > 0) {
    throw new Error(`Run ${runId} config failed validation: ${errors.map((e) => e.message).join("; ")}`);
  }
  return { urls: run.config_json.urls, targetLevel: run.config_json.target_level, maxPages, allowedHosts: run.config_json.allowed_hosts ?? [] };
}
