// The exact pass over a contact like a figure's hands resting on a desk top (fizlet.com's day loop):
// boxes sunk a little into a slab, so the slab is cut into pieces every frame, and on the slab what is
// painted after it (a point pool with its own painter, a plain dot, a decal, the hands' blob shadows),
// painted again inside each piece. Warm up, then count young-generation GCs over FRAMES draws in one
// window (no best-of): `node --expose-gc tests/lib/exact-contact-gc.mjs [frames]` prints JSON.
import { PerformanceObserver, constants } from "node:perf_hooks";
const { diorama } = await import("../../src/diorama.ts");
const { exact } = await import("../../src/diorama-exact.ts");

const FRAMES = +process.argv[2] || 20000, WARM = 20000;
const noop = () => {};
const ctx = { globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "", globalCompositeOperation: "" };
for (const m of ["setTransform", "fillRect", "clearRect", "beginPath", "closePath", "moveTo", "lineTo", "arc", "fill", "stroke", "save", "restore", "clip"]) ctx[m] = noop;
const canvas = { clientWidth: 800, clientHeight: 500, width: 0, height: 0, getContext: () => ctx };
const x = exact(), d = diorama(canvas, { exact: x, background: "#000000" });
Object.assign(d.cam, { yaw: 0.4, pitch: 0.5, dist: 6, tx: 0, ty: 0.7, tz: 0, ox: 0, oy: 0, fov: 0.62 });
d.cluster("set", { at: [0, 0, 0] });
d.add({ id: "desk", size: [1.3, 0.05, 0.66], pos: [0, 0.61, 0], color: "#c08040", cluster: "set", layer: 0 });
// Two hands resting on the top, their undersides 4 mm into it; one tilted.
d.add({ size: [0.07, 0.04, 0.1], pos: [-0.12, 0.656, 0.2], color: "#f0c0a0", cluster: "set", layer: 2, shadow: 0.3 });
d.add({ size: [0.07, 0.04, 0.1], pos: [0.12, 0.656, 0.2], rot: [0, 0.4, 0.05], color: "#f0c0a0", cluster: "set", layer: 2, shadow: 0.3 });
// On the top, after it: a pool with a painter (a light), a plain dot, a decal.
let painted = 0;
const light = d.points({ cap: 1, cluster: "set", layer: 1, paint: (c) => { painted++; c.globalAlpha = 0.5; c.beginPath(); c.arc(400, 250, 80, 0, 6.283); c.fill(); } });
light.n = 1;
const dots = d.points({ cap: 2, cluster: "set", layer: 1, color: "#ffffff" });
dots.n = 2; dots.x[0] = -0.1; dots.y[0] = 0.66; dots.z[0] = 0.1; dots.r[0] = 0.02; dots.a[0] = 1; dots.x[1] = 0.1; dots.y[1] = 0.66; dots.z[1] = 0.1; dots.r[1] = 0.02; dots.a[1] = 1;
d.decal("set", 1, (c) => { c.beginPath(); c.moveTo(380, 240); c.lineTo(420, 260); c.stroke(); });
// More painters, each its own closure (as a scene has: the call that runs them sees many), and
// more decals: a busy part, as the day loop's desk top is.
const FX = new Float64Array([300, 340, 380, 420, 460, 500]);
for (let j = 0; j < 6; j++) {
  const pool = d.points({ cap: 1, cluster: "set", layer: 1, paint: [
    (c) => { c.globalAlpha = 0.3; c.fillRect(FX[0], 240, 30, 20); },
    (c) => { c.beginPath(); c.arc(FX[1], 250, 12, 0, 6.283); c.fill(); },
    (c) => { c.beginPath(); c.moveTo(FX[2], 240); c.lineTo(FX[2] + 20, 260); c.lineTo(FX[2] - 20, 260); c.closePath(); c.fill(); },
    (c) => { c.globalAlpha = 0.6; c.beginPath(); c.arc(FX[3], 250, 20, 0, 3.14); c.stroke(); },
    (c) => { c.fillRect(FX[4] - 5, 245, 10, 10); },
    (c) => { c.beginPath(); c.moveTo(FX[5], 250); c.lineTo(FX[5] + 30, 250); c.stroke(); },
  ][j] });
  pool.n = 1;
  d.decal("set", 1, (c) => { c.beginPath(); c.moveTo(FX[j], 230); c.lineTo(FX[j] + 10, 235); c.stroke(); });
}

const Y = new Float64Array(1);
function frame(k) { Y[0] = 0.4 + (k % 400) * 0.0157; d.cam.yaw = Y[0]; d.draw(); }
function run(n, from) { for (let i = 0; i < n; i++) frame(from + i); }
run(WARM, 0);
const p0 = painted, pieces = x.stats.pieces;
globalThis.gc();
let minor = 0;
const seen = new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.detail.kind === constants.NODE_PERFORMANCE_GC_MINOR) minor++; });
seen.observe({ entryTypes: ["gc"] });
run(FRAMES, WARM);
await new Promise((ok) => setTimeout(ok, 50));
seen.disconnect();
console.log(JSON.stringify({ frames: FRAMES, minor, pieces, paintsPerFrame: +((painted - p0) / FRAMES).toFixed(2) }));
