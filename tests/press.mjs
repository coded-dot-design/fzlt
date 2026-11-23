// @fzlt/core/ui's press() on a 390 x 844 touch phone in Chromium (owner, 2026-11-22: a section of a
// page never blocks scrolling). A swipe that starts on a page key scrolls the page and presses
// nothing; a tap on it presses it once; a key in a game surface (a game host, the pad) keeps the
// instant touchstart press and the finger: a swipe that starts there does not scroll the page.
// The control is the old press (preventDefault on every touchstart): there the swipe from the
// page key keeps the page still, so the check can fail.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { launchOptions } from "./chromium.mjs";

const js = (await build({ entryPoints: ["src/ui/board-ui.ts"], bundle: true, format: "iife", globalName: "ui", write: false, logLevel: "silent" })).outputFiles[0].text;
const OLD = `window.oldPress = (el, fn, signal) => { let touched = 0;
  el.addEventListener("touchstart", (e) => { if (e.cancelable) e.preventDefault(); else touched = performance.now(); fn(); }, { passive: false, signal });
  el.addEventListener("click", () => { if (!touched || performance.now() - touched > 800) fn(); touched = 0; }, { signal }); };`;

const PAGE = `<!doctype html><html class="bui"><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font:16px/1.5 sans-serif}p{margin:16px}.bui-key{display:block;margin:16px;width:300px;height:160px;touch-action:manipulation}
[data-fizlet-host]{margin:16px;height:240px;background:#321;touch-action:none}</style></head><body>
<p>A page with keys on it.</p>
<button type="button" class="bui-key" id="page">Page key</button>
<div data-fizlet-host="game"><button type="button" class="bui-key" id="game">Game key</button></div>
${"<p>Filler so the page scrolls.</p>".repeat(80)}</body></html>`;

const browser = await chromium.launch(launchOptions());
let failed = 0;
const ok = (name, fn) => fn().then(() => console.log(`ok  ${name}`), (e) => { failed++; console.log(`not ok  ${name}\n  ${e.message}`); });

async function phone(old) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.setContent(PAGE);
  await page.addScriptTag({ content: old ? OLD : js });
  await page.evaluate((old) => {
    window.hits = { page: 0, game: 0 };
    const p = old ? window.oldPress : ui.press, ac = new AbortController();
    for (const id of ["page", "game"]) p(document.getElementById(id), () => hits[id]++, ac.signal);
  }, old);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
  const at = (id) => page.$eval(`#${id}`, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  /** A one-finger swipe up from the middle of `id`: how far the page moved. */
  const swipe = async (id) => {
    await page.evaluate(() => scrollTo(0, 0));
    const { x, y } = await at(id), y0 = await page.evaluate(() => scrollY);
    await touch("touchStart", x, y);
    for (let i = 1; i <= 8; i++) await touch("touchMove", x, y - i * 20), await page.waitForTimeout(16);
    await touch("touchEnd");
    await page.waitForTimeout(400);
    return (await page.evaluate(() => scrollY)) - y0;
  };
  return { ctx, page, swipe, at, hits: () => page.evaluate(() => ({ ...hits })) };
}

await ok("a swipe that starts on a page key scrolls the page and presses nothing", async () => {
  const t = await phone(false);
  const moved = await t.swipe("page");
  assert.ok(moved > 50, `the page moved ${moved} px`);
  assert.equal((await t.hits()).page, 0, "the key was not pressed");
  await t.ctx.close();
});
await ok("a tap on a page key presses it once", async () => {
  const t = await phone(false);
  const { x, y } = await t.at("page");
  await t.page.touchscreen.tap(x, y);
  await t.page.waitForTimeout(200);
  assert.equal((await t.hits()).page, 1);
  await t.ctx.close();
});
await ok("a key in a game host presses on touchstart and keeps the finger", async () => {
  const t = await phone(false);
  const moved = await t.swipe("game");
  assert.equal(moved, 0, "the page stays");
  assert.equal((await t.hits()).game, 1, "pressed once, at touchstart");
  const { x, y } = await t.at("game");
  await t.page.touchscreen.tap(x, y);
  await t.page.waitForTimeout(200);
  assert.equal((await t.hits()).game, 2, "a tap presses it once more (the click after it is skipped)");
  await t.ctx.close();
});
await ok("control (the old press): a swipe from the page key keeps the page still", async () => {
  const t = await phone(true);
  assert.equal(await t.swipe("page"), 0);
  await t.ctx.close();
});
await browser.close();
if (failed) process.exit(1);
