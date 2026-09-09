/**
 * Regenerate the README screenshots from tools/demo.html (synthetic data).
 *
 *   npx playwright@latest install chromium     # once
 *   node tools/make-screenshots.js
 *
 * Writes docs/day.png, docs/month.png, docs/year.png, docs/lifetime.png.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PERIODS = ["day", "month", "year", "lifetime"];
const OUT = path.join(__dirname, "..", "docs");
const DEMO = "file://" + path.join(__dirname, "demo.html").replace(/\\/g, "/");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  for (const period of PERIODS) {
    await page.goto(`${DEMO}?period=${period}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const card = page.locator("fusionsolar-statistics-card");
    const file = path.join(OUT, `${period}.png`);
    await card.screenshot({ path: file });
    console.log("wrote", file);
  }

  await browser.close();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
