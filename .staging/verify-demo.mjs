// One-off P0-T4 verification (gitignored). Permanent harness lands in P3-T5.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const axeSrc = readFileSync(resolve(root, "node_modules/axe-core/axe.min.js"), "utf8");
const page = (name) => pathToFileURL(resolve(root, "demo-site", name)).href;

const browser = await chromium.launch();
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function axeViolations(url, { openModal = false } = {}) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(url);
  if (openModal) await p.click("#open-preview");
  await p.addScriptTag({ content: axeSrc });
  const res = await p.evaluate(async () => {
    const r = await axe.run();
    return {
      violations: r.violations.map((v) => v.id),
      incomplete: r.incomplete.map((v) => v.id),
    };
  });
  await ctx.close();
  return res;
}

// axe expectations per fixture
for (const [file, expectViolations] of [
  ["index.html", 0],
  ["links.html", 0],        // TC2 premise: scanners pass
  ["form.html", null],      // must have >=1 (label rule)
  ["form-fixed.html", 0],
  ["photo-hero.html", 0],   // TC3: axe cannot see image backgrounds
  ["modal.html", 0],        // closed state
]) {
  const { violations } = await axeViolations(page(file));
  if (expectViolations === null) {
    check(`${file} has at least one axe violation`, violations.length >= 1, violations.join(", "));
    check(`${file} violation is the label rule`, violations.includes("label"), violations.join(", "));
  } else {
    check(`${file} axe violations == ${expectViolations}`, violations.length === expectViolations, violations.join(", ") || "clean");
  }
}

// TC3 premise: hero text over a photo is not flagged by axe (it cannot compute image backgrounds)
const ph = await axeViolations(page("photo-hero.html"));
check("photo-hero color-contrast not a violation", !ph.violations.includes("color-contrast"),
  `incomplete: ${ph.incomplete.join(", ") || "none"}`);

// TC1: modal really traps
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(page("modal.html"));
  await p.click("#open-preview");
  const inDialog = async () =>
    p.evaluate(() => !!document.activeElement?.closest(".dialog"));
  let trapHeld = true;
  for (let i = 0; i < 12; i++) {
    await p.keyboard.press("Tab");
    if (!(await inDialog())) { trapHeld = false; break; }
  }
  check("modal.html Tab never leaves the dialog (12 presses)", trapHeld);
  let shiftHeld = true;
  for (let i = 0; i < 6; i++) {
    await p.keyboard.press("Shift+Tab");
    if (!(await inDialog())) { shiftHeld = false; break; }
  }
  check("modal.html Shift+Tab never leaves the dialog", shiftHeld);
  await p.keyboard.press("Escape");
  const escapeIgnored = await p.evaluate(() => !document.getElementById("overlay").hidden);
  check("modal.html Escape does not close the dialog", escapeIgnored);
  const outsideUnreachable = await p.evaluate(() => {
    const before = document.activeElement;
    return before !== null && before !== document.getElementById("open-preview");
  });
  check("modal.html focus is not restored to the opener while open", outsideUnreachable);
  await p.click("#close-preview");
  const closed = await p.evaluate(() => document.getElementById("overlay").hidden);
  check("modal.html Close button closes the dialog", closed);
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "\nALL FIXTURE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
