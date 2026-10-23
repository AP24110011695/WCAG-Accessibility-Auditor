// P3-T3 (FR-06, TC3): contrast sampler against real background pixels.
// Evaluates text elements sitting on background images/gradients.
// 1. Screenshot bounding box with text visible
// 2. Hide text (visibility: hidden), screenshot bounding box again (background only)
// 3. Compute relative luminance and contrast ratios
import type { Page } from "playwright";

export const STANDARD_VIEWPORT = { width: 1280, height: 720 } as const;
export const STANDARD_DEVICE_SCALE_FACTOR = 1 as const;

export interface ContrastSample {
  selector: string;
  text: string;
  fontSize: number;
  isBold: boolean;
  isLargeText: boolean;
  requiredRatio: number;
  measuredRatio: number; // worst-case ratio
  meanRatio: number;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  textColorRgb: [number, number, number];
  bgAvgRgb: [number, number, number];
  usablePixels: number;
  status: "pass" | "fail" | "uncertain";
  screenshotWithText?: Buffer;
  screenshotBgOnly?: Buffer;
}

function sRgbToLinear(c: number): number {
  const norm = c / 255;
  return norm <= 0.03928 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * sRgbToLinear(r) + 0.7152 * sRgbToLinear(g) + 0.0722 * sRgbToLinear(b);
}

function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseRgb(colorStr: string): [number, number, number] {
  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match && match[1] && match[2] && match[3]) {
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  }
  return [0, 0, 0];
}

export async function samplePageContrast(page: Page): Promise<ContrastSample[]> {
  // Find candidates: elements with text whose background has an image or whose parent has an image
  const candidates = await page.evaluate(() => {
    const list: { selector: string; text: string; color: string; fontSize: number; isBold: boolean }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;

    while (node) {
      const el = node as HTMLElement;
      if (el.innerText && el.innerText.trim().length > 0 && el.children.length === 0) {
        // leaf text element
        let curr: HTMLElement | null = el;
        let hasBgImg = false;
        while (curr && curr !== document.documentElement) {
          const style = window.getComputedStyle(curr);
          if (style.backgroundImage && style.backgroundImage !== "none") {
            hasBgImg = true;
            break;
          }
          curr = curr.parentElement;
        }

        if (hasBgImg) {
          const style = window.getComputedStyle(el);
          const fSize = parseFloat(style.fontSize) || 16;
          const weight = parseInt(style.fontWeight, 10) || 400;
          const sel = el.id ? `#${el.id}` : el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase();
          list.push({
            selector: sel,
            text: el.innerText.trim().slice(0, 80),
            color: style.color,
            fontSize: fSize,
            isBold: weight >= 700 || style.fontWeight === "bold",
          });
        }
      }
      node = walker.nextNode();
    }
    return list;
  });

  return sampleElementContrast(page, candidates);
}

export async function sampleElementContrast(
  page: Page,
  candidates: { selector: string; text?: string; color?: string; fontSize?: number; isBold?: boolean }[]
): Promise<ContrastSample[]> {
  const results: ContrastSample[] = [];

  for (const cand of candidates) {
    const loc = page.locator(cand.selector).first();
    const count = await loc.count();
    if (count === 0) continue;

    const computed = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (!el) return null;
      const style = window.getComputedStyle(el);
      const fSize = parseFloat(style.fontSize) || 16;
      const weight = parseInt(style.fontWeight, 10) || 400;
      return {
        text: el.innerText?.trim()?.slice(0, 80) || "",
        color: style.color,
        fontSize: fSize,
        isBold: weight >= 700 || style.fontWeight === "bold",
      };
    }, cand.selector);

    const text = cand.text ?? computed?.text ?? "";
    const color = cand.color ?? computed?.color ?? "rgb(0, 0, 0)";
    const fontSize = cand.fontSize ?? computed?.fontSize ?? 16;
    const isBold = cand.isBold ?? computed?.isBold ?? false;

    const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && isBold);
    const requiredRatio = isLargeText ? 3.0 : 4.5;
    const textRgb = parseRgb(color);
    const textLum = relativeLuminance(textRgb[0], textRgb[1], textRgb[2]);

    let shotWithText: Buffer | undefined;
    let shotBgOnly: Buffer | undefined;

    const vp = page.viewportSize() ?? STANDARD_VIEWPORT;
    const dsf = await page.evaluate(() => window.devicePixelRatio || 1);

    try {
      shotWithText = await loc.screenshot();
    } catch {
      // bounding box not visible
      results.push({
        selector: cand.selector,
        text,
        fontSize,
        isBold,
        isLargeText,
        requiredRatio,
        measuredRatio: 1.0,
        meanRatio: 1.0,
        viewport: vp,
        deviceScaleFactor: dsf,
        textColorRgb: textRgb,
        bgAvgRgb: [0, 0, 0],
        usablePixels: 0,
        status: "uncertain",
      });
      continue;
    }

    // 2. Hide text (visibility: hidden) and take screenshot of the element's exact bounding box
    // This captures the real rendered pixels: background-size cover, positions, overlays, and gradients.
    const box = await loc.boundingBox();
    if (!box) continue;

    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) el.style.visibility = "hidden";
    }, cand.selector);

    try {
      shotBgOnly = await page.screenshot({ clip: box });
    } finally {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) el.style.visibility = "visible";
      }, cand.selector);
    }

    if (!shotBgOnly) continue;

    // Decode actual rendered background pixels from the screenshot via browser's native bitmap decoder
    const bgPixels = await page.evaluate(async (base64) => {
      const res = await fetch(`data:image/png;base64,${base64}`);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return [];
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const px: [number, number, number][] = [];
      for (let i = 0; i < data.length; i += 16) {
        px.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]);
      }
      return px;
    }, shotBgOnly.toString("base64"));

    const usablePixels = bgPixels.length;
    if (usablePixels < 50) {
      results.push({
        selector: cand.selector,
        text,
        fontSize,
        isBold,
        isLargeText,
        requiredRatio,
        measuredRatio: 1.0,
        meanRatio: 1.0,
        viewport: vp,
        deviceScaleFactor: dsf,
        textColorRgb: textRgb,
        bgAvgRgb: [0, 0, 0],
        usablePixels,
        status: "uncertain",
        screenshotWithText: shotWithText,
        screenshotBgOnly: shotBgOnly,
      });
      continue;
    }

    // Compute contrast ratio against every sampled pixel cluster
    const ratios = bgPixels.map(([r, g, b]) => contrastRatio(textLum, relativeLuminance(r, g, b)));
    const worstCaseRatio = parseFloat(Math.min(...ratios).toFixed(2));
    const meanRatio = parseFloat((ratios.reduce((sum, r) => sum + r, 0) / ratios.length).toFixed(2));

    let sumR = 0, sumG = 0, sumB = 0;
    for (const [r, g, b] of bgPixels) {
      sumR += r;
      sumG += g;
      sumB += b;
    }
    const avgR = Math.round(sumR / usablePixels);
    const avgG = Math.round(sumG / usablePixels);
    const avgB = Math.round(sumB / usablePixels);

    const status = worstCaseRatio < requiredRatio ? "fail" : "pass";

    results.push({
      selector: cand.selector,
      text,
      fontSize,
      isBold,
      isLargeText,
      requiredRatio,
      measuredRatio: worstCaseRatio,
      meanRatio,
      viewport: vp,
      deviceScaleFactor: dsf,
      textColorRgb: textRgb,
      bgAvgRgb: [avgR, avgG, avgB],
      usablePixels,
      status,
      screenshotWithText: shotWithText,
      screenshotBgOnly: shotBgOnly,
    });
  }

  return results;
}