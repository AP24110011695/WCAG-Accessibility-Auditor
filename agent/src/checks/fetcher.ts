// P2-T1 (FR-03): static retrieval. The orchestrator escalates to a Playwright
// render (fetch_method 'playwright') when the static body looks like an empty
// app shell, so every source record always carries URL + retrieval time.
import * as cheerio from "cheerio";

export interface StaticFetch {
  url: string;
  html: string;
  httpStatus: number | null;
  retrievedAt: string;
}

const APP_SHELL_MIN_TEXT = 200;

export function looksJsRendered(html: string): boolean {
  const $ = cheerio.load(html);
  const text = $("body").text().trim();
  return text.length < APP_SHELL_MIN_TEXT && $("script[src]").length > 0;
}

export async function staticFetch(url: string): Promise<StaticFetch> {
  const retrievedAt = new Date().toISOString();
  const res = await fetch(url, { redirect: "follow" });
  const html = await res.text();
  return { url: res.url || url, html, httpStatus: res.status, retrievedAt };
}
