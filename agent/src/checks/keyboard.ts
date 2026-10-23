// P3-T1/T2 (FR-05, TC1): keyboard walker — Tab/Shift+Tab/Escape trace,
// focus-trap detection (3 full cycles inside modal while outside elements exist),
// focus-visibility check (computed-style diff). Video via Playwright context.
import { type Browser, type BrowserContext, type Page } from "playwright";

export interface KeystrokeEntry {
  key: string;
  ts: string;
  activeElementPath: string;
}

export interface FocusWalkResult {
  trace: KeystrokeEntry[];
  trapDetected: boolean;
  escapeCloses: boolean | null;
  focusInvisibleSelectors: string[];
  videoPath: string | null;
  keyframes: Buffer[];
}

const TRAP_CYCLES = 3;
const MAX_TABS = 150;

async function elementPath(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return "body";
    const parts: string[] = [];
    let node: Element | null = el as Element;
    for (let depth = 0; depth < 3 && node && node !== document.body; depth++) {
      const tag = node.tagName.toLowerCase();
      const id = node.id ? "#" + node.id : "";
      const cls =
        node.className && typeof node.className === "string"
          ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
      parts.unshift(tag + id + cls);
      node = node.parentElement;
    }
    return parts.join(" > ");
  });
}

async function isFocusInvisible(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const atRest = window.getComputedStyle(el as Element);
    const restSig = atRest.outlineWidth + atRest.outlineColor + atRest.outlineStyle + atRest.boxShadow;
    (el as HTMLElement).focus({ preventScroll: true });
    const focused = window.getComputedStyle(el as Element);
    const focusSig = focused.outlineWidth + focused.outlineColor + focused.outlineStyle + focused.boxShadow;
    (el as HTMLElement).blur();
    const noOutline = focused.outlineWidth === "0px" || focused.outlineStyle === "none";
    return restSig === focusSig && noOutline;
  }, selector);
}

async function modalState(page: Page): Promise<{ modalOpen: boolean; outsideSelectors: string[] }> {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>("dialog[open], [role='dialog'], [aria-modal='true']"));
    let modal: HTMLElement | null = null;
    for (const d of dialogs) {
      if (d.hasAttribute("hidden")) continue;
      let curr: HTMLElement | null = d.parentElement;
      let parentHidden = false;
      while (curr) {
        if (curr.hasAttribute("hidden") || window.getComputedStyle(curr).display === "none") {
          parentHidden = true;
          break;
        }
        curr = curr.parentElement;
      }
      if (!parentHidden) {
        modal = d;
        break;
      }
    }

    if (!modal) return { modalOpen: false, outsideSelectors: [] };
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
    const outside = focusable
      .filter((el) => !modal!.contains(el))
      .map((el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""));
    return { modalOpen: true, outsideSelectors: outside };
  });
}

async function isInsideModal(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>("dialog[open], [role='dialog'], [aria-modal='true']"));
    let modal: HTMLElement | null = null;
    for (const d of dialogs) {
      if (d.hasAttribute("hidden")) continue;
      let curr: HTMLElement | null = d.parentElement;
      let parentHidden = false;
      while (curr) {
        if (curr.hasAttribute("hidden") || window.getComputedStyle(curr).display === "none") {
          parentHidden = true;
          break;
        }
        curr = curr.parentElement;
      }
      if (!parentHidden) {
        modal = d;
        break;
      }
    }
    if (!modal) return false;
    return modal.contains(document.activeElement);
  });
}

async function getAllFocusableSelectors(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? "#" + el.id : "";
      return tag + id + ":nth-of-type(" + (i + 1) + ")";
    }),
  );
}

export async function runKeyboardWalk(
  browser: Browser,
  url: string,
  videoDir: string,
): Promise<FocusWalkResult> {
  let ctx: BrowserContext | null = null;
  try {
    ctx = await browser.newContext({ recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load" });

    const trace: KeystrokeEntry[] = [];
    const focusInvisibleSelectors: string[] = [];
    const keyframes: Buffer[] = [];

    await page.keyboard.press("Tab");
    trace.push({ key: "Tab", ts: new Date().toISOString(), activeElementPath: await elementPath(page) });

    // Screenshot 1 captured during keyboard walk: initial page load / before modal open
    keyframes.push(await page.screenshot());

    // If there is an unopened modal on the page, trigger its opening to test focus containment
    const modalTrigger = await page.$("button[id*='open'], [aria-haspopup='dialog'], [data-demo-bug*='trap']");
    if (modalTrigger) {
      await modalTrigger.click();
      await page.waitForTimeout(300);
      // Screenshot 2 captured during keyboard walk: modal opened
      keyframes.push(await page.screenshot());
    }

    const { modalOpen, outsideSelectors } = await modalState(page);
    let trapDetected = false;
    let escapeCloses: boolean | null = modalOpen ? false : null;

    if (modalOpen && outsideSelectors.length > 0) {
      const seenPaths: string[] = [];
      let completedCycles = 0;
      let cyclePivot = "";
      let cyclesTrapped = false;

      for (let t = 0; t < MAX_TABS; t++) {
        await page.keyboard.press("Tab");
        const path = await elementPath(page);
        trace.push({ key: "Tab", ts: new Date().toISOString(), activeElementPath: path });
        const inside = await isInsideModal(page);
        if (!inside) break;

        if (path === cyclePivot) {
          completedCycles++;
          if (completedCycles >= TRAP_CYCLES) {
            cyclesTrapped = true;
            // Screenshot 3 captured during keyboard walk: trapped inside modal across cycles
            keyframes.push(await page.screenshot());
            break;
          }
          seenPaths.length = 0;
        } else if (seenPaths.includes(path) && cyclePivot === "") {
          cyclePivot = path;
          completedCycles = 1;
          seenPaths.length = 0;
        } else {
          seenPaths.push(path);
        }
      }

      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      trace.push({ key: "Escape", ts: new Date().toISOString(), activeElementPath: await elementPath(page) });
      const { modalOpen: stillOpen } = await modalState(page);
      escapeCloses = !stillOpen;
      // Screenshot 4 captured during keyboard walk: after Escape attempt
      keyframes.push(await page.screenshot());

      // Under WCAG 2.1.2: A modal is a trap if focus cycles inside AND cannot be exited via standard keyboard commands (Escape)
      trapDetected = cyclesTrapped && !escapeCloses;
    } else {
      const selectors = await getAllFocusableSelectors(page);
      for (let i = 0; i < Math.min(selectors.length, 50); i++) {
        await page.keyboard.press("Tab");
        const path = await elementPath(page);
        trace.push({ key: "Tab", ts: new Date().toISOString(), activeElementPath: path });
        const sel = selectors[i];
        if (sel) {
          const invisible = await isFocusInvisible(page, sel).catch(() => false);
          if (invisible) focusInvisibleSelectors.push(path);
        }
      }
    }

    const videoObj = page.video();
    await ctx.close();
    let videoPath: string | null = null;
    try {
      videoPath = (await videoObj?.path()) ?? null;
    } catch {
      // video path may not be available if recording was empty
    }

    return { trace, trapDetected, escapeCloses, focusInvisibleSelectors, videoPath, keyframes };
  } catch (err) {
    if (ctx) await ctx.close().catch(() => undefined);
    throw err;
  }
}