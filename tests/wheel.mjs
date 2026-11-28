// A wheel (a trackpad, a mouse) over an animation or a game on a page always scrolls the page
// (owner, 2026-11-22: "make sure the heroes and other animations don't block scrolling from the
// trackpad"). In Chromium with the Board UI kit's CSS: a wheel over a clipping slot (overflow:
// hidden, as every slot is), a game host and a turntable moves window.scrollY; on a phone a vertical
// swipe over the slot and the turntable scrolls the page too. The control: the same page with the
// kit's old `overscroll-behavior: none` on the surfaces keeps the wheel, so the check can fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";
import { launchOptions } from "./chromium.mjs";

const bundle = (await build({
  stdin: { contents: 'export { createEngine } from "./src/index.ts"; export * from "./src/turntable.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "iife", globalName: "fz", write: false, logLevel: "silent",
})).outputFiles[0].text;
const KIT = readFileSync("src/ui/board-ui.css", "utf8");
const OLD = ".bui :is([data-fizlet-host],.ae-slot,[data-fizlet-slot]){overscroll-behavior:none}";

const PAGE = (css) => `<!doctype html><html class="bui"><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style><style>body{margin:0}.box{position:relative;display:block;margin:16px;height:360px;overflow:hidden;background:#123}</style></head><body>
<figure class="ae-slot box" id="slot"><div data-fizlet-slot="home#hero" style="position:absolute;inset:0;overflow:hidden"><div style="height:900px"></div></div></figure>
<div data-fizlet-host="game" class="box" id="host"></div>
<div class="box" id="tt"></div>
${"<p>Filler so the page scrolls.</p>".repeat(120)}
<script>${bundle}</script><script>const e = fz.createEngine(); fz.turntable(e, document.getElementById("tt"), { label: "Turn" }); e.start();</script></body></html>`;

const browser = await chromium.launch(launchOptions());
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok" : "FAIL"}  ${what}`); if (!ok) fails++; };
try {
  for (const [css, want] of [[KIT, true], [KIT + OLD, false]]) {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await p.setContent(PAGE(css));
    for (const id of want ? ["slot", "host", "tt"] : ["slot", "host"]) {
      await p.evaluate((id) => document.getElementById(id).scrollIntoView({ block: "center" }), id);
      const y0 = await p.evaluate(() => scrollY), b = await (await p.$(`#${id}`)).boundingBox();
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      // The box under the pointer, not beside it.
      assert.equal(await p.evaluate(([x, y]) => document.elementFromPoint(x, y).closest(".box")?.id, [b.x + b.width / 2, b.y + b.height / 2]), id);
      await p.mouse.wheel(0, 240);
      await p.waitForTimeout(300);
      const y = await p.evaluate(() => scrollY);
      check(want ? y > y0 : y === y0, `${want ? "kit" : "control (old overscroll rule)"}: a wheel over #${id} ${want ? "scrolls" : "is kept by"} the page (scrollY ${y0} → ${y})`);
    }
    await p.close();
  }
  // A phone: a vertical swipe over the slot and the turntable scrolls the page.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.setContent(PAGE(KIT));
  const cdp = await ctx.newCDPSession(p);
  for (const id of ["slot", "tt"]) {
    await p.evaluate((id) => document.getElementById(id).scrollIntoView({ block: "center" }), id);
    const y0 = await p.evaluate(() => scrollY), b = await (await p.$(`#${id}`)).boundingBox();
    const x = b.x + b.width / 2, y1 = b.y + b.height / 2 + 100, touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
    await touch("touchStart", [{ x, y: y1, id: 0 }]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [{ x, y: y1 - i * 20, id: 0 }]), await p.waitForTimeout(16);
    await touch("touchEnd", []);
    await p.waitForTimeout(300);
    const y = await p.evaluate(() => scrollY);
    check(y > y0 + 50, `phone: a vertical swipe over #${id} scrolls the page (scrollY ${y0} → ${y})`);
  }
  await ctx.close();
} finally {
  await browser.close();
}
if (fails) (console.error(`${fails} failed`), process.exit(1));
console.log("wheel: every surface gives the page its scroll");
