// onepager_render.mjs: print a one-pager to PDF and check it fits.
//
//   node onepager_render.mjs <page.html> <out.pdf> <dir with node_modules/playwright>
//
// Headless Chromium, from a Playwright you already have (nothing is downloaded). Prints the page
// on US Letter with its own @page margins, then reports, as one JSON line on stdout:
//   {pages, overflow_px, overflowing: [block names], phone_overflow_px, console_errors: [...]}
// `pages` is counted in the PDF itself. `overflowing` names the page's blocks (data-block) that end
// below the first sheet, measured at the printable width (7.5in = 720 CSS px, 10in = 960 px tall).
// `phone_overflow_px` is how far the page scrolls sideways at 390 px wide (0 is right).
// Exit 0 with the report; exit 2 on a usage error; exit 1 when the browser can't run.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const [page, out, pwDir] = process.argv.slice(2);
if (!page || !out || !pwDir) {
  console.error("usage: node onepager_render.mjs <page.html> <out.pdf> <playwright dir>");
  process.exit(2);
}
let chromium;
try {
  ({ chromium } = createRequire(path.join(pwDir, "package.json"))("playwright"));
} catch (e) {
  console.error(`no Playwright in ${pwDir}: ${e.message}`);
  process.exit(1);
}

const url = pathToFileURL(path.resolve(page)).href;
const PRINT_W = 720, PRINT_H = 960;
const report = { pages: 0, overflow_px: 0, overflowing: [], phone_overflow_px: 0, console_errors: [] };
let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: PRINT_W, height: PRINT_H } });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error") report.console_errors.push(m.text().slice(0, 300)); });
  p.on("pageerror", (e) => report.console_errors.push(String(e.message || e).slice(0, 300)));
  await p.goto(url, { waitUntil: "load" });
  await p.emulateMedia({ media: "print" });
  await p.evaluate(() => document.fonts && document.fonts.ready);
  const m = await p.evaluate((H) => {
    const h = document.documentElement.scrollHeight;
    const over = [...document.querySelectorAll("[data-block]")]
      .filter((el) => el.getBoundingClientRect().bottom + window.scrollY > H + 0.5)
      .map((el) => el.getAttribute("data-block"));
    return { h, over };
  }, PRINT_H);
  report.overflow_px = Math.max(0, Math.ceil(m.h - PRINT_H));
  report.overflowing = m.over;
  const buf = await p.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(out, buf);
  report.pages = (buf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length;

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const q = await phone.newPage();
  await q.goto(url, { waitUntil: "load" });
  report.phone_overflow_px = await q.evaluate(() =>
    Math.max(0, Math.ceil(document.documentElement.scrollWidth - document.documentElement.clientWidth)));
} catch (e) {
  console.error(`the browser failed: ${e.message}`);
  if (browser) await browser.close();
  process.exit(1);
}
await browser.close();
console.log(JSON.stringify(report));
