// P3-T4 (FR-07, TC2): heuristics for common manual failures that automated scanners miss:
// 1. Generic link text (WCAG 2.4.4): banned phrases like "click here", "read more"
// 2. Removed focus indicators (WCAG 2.4.7): outline: none/0 without replacement
import type { Page } from "playwright";

export interface GenericLinkIssue {
  selector: string;
  text: string;
  href: string;
}

export interface RemovedOutlineIssue {
  selector: string;
  tag: string;
  text?: string;
  href?: string;
}

export interface HeuristicResults {
  genericLinks: GenericLinkIssue[];
  removedOutlines: RemovedOutlineIssue[];
}

const BANNED_LINK_TEXTS = new Set([
  "click here",
  "read more",
  "learn more",
  "here",
  "more",
  "link",
  "info",
  "details",
  "go",
]);

export async function checkHeuristics(page: Page): Promise<HeuristicResults> {
  const genericLinks = await page.evaluate((bannedList) => {
    const banned = new Set(bannedList);
    const links = Array.from(document.querySelectorAll("a[href]"));
    const issues: { selector: string; text: string; href: string }[] = [];

    for (let i = 0; i < links.length; i++) {
      const a = links[i] as HTMLAnchorElement;
      const text = (a.innerText || "").trim();
      const name = (a.getAttribute("aria-label") || text).trim().toLowerCase();
      if (banned.has(name)) {
        const href = a.getAttribute("href") || "";
        const cls =
          a.className && typeof a.className === "string" && a.className.trim()
            ? "." + a.className.trim().split(/\s+/)[0]
            : "";
        // Stable unique selector: id > contextual selector (section/container) > [href] > positional fallback
        let selector = a.id ? `a#${a.id}` : "";
        if (!selector) {
          const base = cls && href ? `a${cls}[href='${href}']` : href ? `a[href='${href}']` : `a`;
          const matches = Array.from(document.querySelectorAll(base));
          if (matches.length > 1) {
            const sec = a.closest("section");
            const secId = sec?.getAttribute("aria-labelledby") || sec?.id;
            if (secId) {
              selector = `section[aria-labelledby='${secId}'] ${base}`;
            } else {
              // Structural fallback
              let p = a as HTMLElement;
              const segs: string[] = [];
              while (p && p.nodeType === 1 && p.tagName !== "BODY") {
                const parent = p.parentElement;
                if (!parent) break;
                const siblings = Array.from(parent.children).filter((c) => c.tagName === p.tagName);
                const idx = siblings.indexOf(p) + 1;
                const tag = p.tagName.toLowerCase();
                segs.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
                p = parent;
              }
              selector = segs.join(" > ");
            }
          } else {
            selector = base;
          }
        }
        issues.push({ selector, text, href });
      }
    }
    return issues;
  }, Array.from(BANNED_LINK_TEXTS));

  const removedOutlines = await page.evaluate(() => {
    const focusables = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
    const issues: { selector: string; tag: string; text?: string; href?: string }[] = [];

    for (let i = 0; i < focusables.length; i++) {
      const el = focusables[i];
      if (!el) continue;

      // Check outline/box-shadow while focused
      el.focus();
      const focused = window.getComputedStyle(el);
      const outlineNone =
        focused.outlineStyle === "none" ||
        focused.outlineWidth === "0px" ||
        focused.outlineColor === "transparent";
      const noBoxShadow = !focused.boxShadow || focused.boxShadow === "none";

      if (outlineNone && noBoxShadow) {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const cls =
          el.className && typeof el.className === "string" && el.className.trim()
            ? "." + el.className.trim().split(/\s+/)[0]
            : "";
        const bug = el.getAttribute("data-demo-bug");
        const ariaLabel = el.getAttribute("aria-label");
        const href = el.getAttribute("href") || undefined;
        const text = el.innerText?.trim() || undefined;

        let selector = id ? `${tag}${id}` : "";
        if (!selector) {
          if (cls && bug) selector = `${tag}${cls}[data-demo-bug='${bug}']`;
          else if (cls && ariaLabel) selector = `${tag}${cls}[aria-label='${ariaLabel}']`;
          else if (cls) selector = `${tag}${cls}`;
          else if (bug) selector = `${tag}[data-demo-bug='${bug}']`;
          else selector = `${tag}:nth-of-type(${i + 1})`;
        }

        issues.push({ selector, tag, text, href });
      }
      el.blur();
    }
    return issues;
  });

  return { genericLinks, removedOutlines };
}