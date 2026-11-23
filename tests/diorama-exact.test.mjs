// @fzlt/core/diorama-exact in Node (a fake canvas recording each fill): two slabs that cross in an X
// are each nearest on their own side of the crossing; the last fill at a point is the nearest face
// (by symmetry, at four yaws); faces that do not cross keep their order
// with no piece made; and a draw() with the pass allocates nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { minorGCs } from "./gc.mjs";

const { diorama } = await import("../src/diorama.ts");
const { exact } = await import("../src/diorama-exact.ts");

class FakeCtx {
  constructor(rec) { this.rec = rec; this.path = []; this.fillStyle = ""; this.strokeStyle = ""; this.globalAlpha = 1; this.lineWidth = 1; this.lineJoin = ""; }
  setTransform() {}
  fillRect() {}
  clearRect() {}
  beginPath() { if (this.rec) this.path = []; }
  moveTo(x, y) { if (this.rec) this.path.push([x, y]); }
  lineTo(x, y) { if (this.rec) this.path.push([x, y]); }
  closePath() {}
  fill() { if (this.rec) this.rec.push({ style: this.fillStyle, pts: this.path }); }
  stroke() {}
  save() { this.saved = (this.saved || 0) + 1; }
  clip() { this.clips = (this.clips || 0) + 1; }
  restore() {}
}
function scene(withExact, record = true) {
  const fills = [], ctx = new FakeCtx(record ? fills : null), canvas = { clientWidth: 400, clientHeight: 300, width: 0, height: 0, getContext: () => ctx };
  const x = withExact ? exact() : null;
  const d = diorama(canvas, { background: "#000000", edge: false, ...(x ? { exact: x } : {}) });
  Object.assign(d.cam, { yaw: 0, pitch: 0.3, dist: 20, tx: 0, ty: 1, tz: 0, ox: 0, oy: 0, fov: 0.8 });
  // An X seen from the front: red turned one way, blue the other, through the same centre.
  d.add({ id: "red", size: [6, 2, 0.2], rot: [0, 0.6, 0], color: "#ff0000", emissive: true });
  d.add({ id: "blue", size: [6, 2, 0.2], rot: [0, -0.6, 0], color: "#0000ff", emissive: true });
  return { d, fills, x };
}
const inside = (pts, px, py) => {
  let ins = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) ins = !ins;
  }
  return ins;
};
const top = (fills, px, py) => { let s = null; for (const f of fills) if (f.pts.length > 2 && inside(f.pts, px, py)) s = f.style; return s; };

test("crossing faces: each slab is on top on its own side of the crossing", () => {
  const { d, fills, x } = scene(true);
  for (const yaw of [0, 0.2, -0.2, Math.PI]) {
    d.cam.yaw = yaw;
    fills.length = 0;
    d.draw();
    const cx = 200, cy = 160, a = top(fills, cx - 40, cy), b = top(fills, cx + 40, cy);
    assert.ok(a && b, "both points covered");
    assert.notEqual(a, b, `yaw ${yaw}: a different slab is nearest left and right of the crossing`);
    assert.ok(x.stats.pieces > 0, "pieces were cut");
  }
});

test("a part's paints go on again over its pieces (a light or a shadow on it stays on top)", () => {
  const fills = [], ctx = new FakeCtx(fills), canvas = { clientWidth: 400, clientHeight: 300, width: 0, height: 0, getContext: () => ctx };
  const x = exact(), d = diorama(canvas, { exact: x, edge: false });
  Object.assign(d.cam, { yaw: 0, pitch: 0.3, dist: 20, tx: 0, ty: 1, tz: 0, ox: 0, oy: 0, fov: 0.8 });
  // Red first with a paint on it (layer 1), then blue, crossing red: red's pieces go over blue.
  d.cluster("c", { at: [0, 0, 0] });
  d.add({ id: "red", size: [6, 2, 0.2], rot: [0, 0.6, 0], color: "#ff0000", emissive: true, cluster: "c", layer: 0 });
  d.add({ id: "blue", size: [6, 2, 0.2], rot: [0, -0.6, 0], color: "#0000ff", emissive: true, cluster: "c", layer: 2 });
  let painted = 0;
  d.decal("c", 1, () => painted++);
  d.draw();
  assert.ok(x.stats.pieces > 0, "red was cut");
  assert.ok(painted >= 2, `the paint went on again (${painted})`);
  assert.equal(ctx.clips, painted - 1, "each time inside a piece");
});

test("faces that do not cross: no pieces, and boxes a plane parts: no pairs", () => {
  const fills = [], ctx = new FakeCtx(fills), canvas = { clientWidth: 400, clientHeight: 300, width: 0, height: 0, getContext: () => ctx };
  const x = exact(), d = diorama(canvas, { exact: x, edge: false });
  Object.assign(d.cam, { yaw: 0, pitch: 0.4, dist: 20, tx: 0, ty: 0, tz: 0, ox: 0, oy: 0, fov: 0.8 });
  d.add({ size: [2, 2, 2], pos: [0, 0, 3], color: "#ff0000" });
  d.add({ size: [4, 3, 2], pos: [0, 0, -3], color: "#0000ff" });
  d.draw();
  assert.equal(x.stats.pieces, 0);
  // A plane between their world boxes has the eye on the nearer one's side: no face pair is tested.
  assert.equal(x.stats.pairs, 0);
});

test("a draw with the exact pass allocates nothing", async () => {
  const { d } = scene(true, false);
  let t = 0;
  const frame = () => { d.cam.yaw = (t += 0.01); d.draw(); };
  for (let i = 0; i < 200; i++) frame();
  const n = await minorGCs(() => { for (let i = 0; i < 20000; i++) frame(); });
  assert.equal(n, 0, `${n} young GCs`);
});
