/**
 * @fzlt/core/diorama-exact: an exact painter's order for a diorama, on a 2D canvas, opt-in:
 * `diorama(canvas, { exact: exact() })`. Prototype (fizlet/fzlt draft): it pays only where it is used.
 * - After the diorama's sort, each opaque face is checked against every face painted before it whose
 *   screen box it meets (a face's own object skipped: a convex mesh never hides itself). Where an
 *   earlier face is nearer, by more than `tol` in view depth, on part of their shared outline, that part
 *   is cut out (the shared outline, clipped where the two are equally near: 1/z is linear on screen,
 *   so that cut is a line) and painted again right after the later face. A piece is a face too, so it
 *   is checked the same way; when no earlier piece is nearer than a later one anywhere they overlap,
 *   the last paint at every pixel is the nearest face: exact, crossing faces included, with no order
 *   to find and no cycle to break.
 * - A piece is filled with its face's shade and stroked only along its face's own edges.
 * - Limits: convex faces of at most 32 vertices take part (others paint as they are); shadows, points
 *   and decals keep the diorama's order; a see-through face's piece blends twice (`alpha` leaves them out). `cap` pieces per frame (faces
 *   included); past it the rest keep the diorama's order (counted in `stats.full`).
 * - Pairs: a face is checked only against faces of other objects that could hide it: when a plane
 *   between the two objects' world boxes has the eye on the later one's side, every ray meets the
 *   later one first and the sort's order of the two is already exact (skipped). Each world box is
 *   taken from the object's vertices every frame.
 * - No allocation per draw (typed arrays sized once, grown with the scene). Cost: every pair of faces
 *   whose screen boxes meet and whose objects' boxes overlap (or are in the wrong order), each frame.
 */
import type { DioramaFaces, DioramaOptions, DioramaPass } from "./diorama";

/** Options for `exact`. */
export interface ExactOptions {
  /** Faces and pieces per frame (default 4096). */
  cap?: number;
  /** A face nearer by less than this (view depth, world units) is a tie, not a fix (default 0.001). */
  tol?: number;
  /** Faces under this alpha keep the diorama's order (default 0: all; a piece of a see-through face
   *  painted again blends twice). */
  alpha?: number;
}

const MV = 32;
/** The pass for `diorama(canvas, { exact: exact() })`. `.stats`: the last frame's pieces (cut and
 *  painted again), pairs (screen boxes that met) and full (faces left out past `cap`). */
export function exact(o: ExactOptions = {}) {
  const cap = o.cap ?? 4096, tol = o.tol ?? 1e-3, alpha = o.alpha ?? 0, stats = { pieces: 0, pairs: 0, full: 0 };
  // Pieces: vertices (x, y, edge-in flag), count, owner entry, object, 1/z plane (a, b, c), box, winding.
  const PX = new Float64Array(cap * MV), PY = new Float64Array(cap * MV), PE = new Uint8Array(cap * MV);
  const PN = new Uint8Array(cap), PO = new Int32Array(cap), PB = new Int32Array(cap), PL = new Float64Array(cap * 3), BB = new Float64Array(cap * 4), SG = new Float64Array(cap);
  // Clip buffers, ping-pong: x, y, flag.
  const U = new Float64Array(MV * 2 * 3 * 2);
  // Faces already painted, by 64 px screen tile (32 × 32, the edge tiles take the rest): a list per
  // tile (HEAD → NX, face in NF); a face over more than 16 tiles goes on BIG, checked by every face.
  const G = 32, NP = cap * 4, HEAD = new Int32Array(G * G), NX = new Int32Array(NP), NF = new Int32Array(NP), BIG = new Int32Array(cap), ST = new Int32Array(cap), TB = new Int32Array(4);
  let st = 0;
  /** TB = the tiles under piece g's box (x0, x1, y0, y1). */
  function tiles(g: number) {
    for (let k = 0; k < 4; k++) TB[k] = Math.max(0, Math.min(G - 1, Math.floor(BB[g * 4 + k]! / 64)));
  }
  let S0 = new Int32Array(0), S1 = S0, EA: ArrayLike<number> = S0, u = 0, m = 0;
  /** Keep a·x + b·y + c >= 0 of the polygon in U at u (m vertices); a new edge on the line gets flag 0. */
  function clip(a: number, b: number, c: number) {
    const s = u, d = u === 0 ? MV * 6 : 0;
    let k = 0;
    for (let i = 0; i < m; i++) {
      const p = s + ((i + m - 1) % m) * 3, q = s + i * 3, px = U[p]!, py = U[p + 1]!, qx = U[q]!, qy = U[q + 1]!;
      const fp = a * px + b * py + c, fq = a * qx + b * qy + c;
      if ((fp >= 0) !== (fq >= 0) && k < MV * 2) {
        const t = fp / (fp - fq), j = d + k++ * 3;
        U[j] = px + (qx - px) * t; U[j + 1] = py + (qy - py) * t; U[j + 2] = fq >= 0 ? 0 : U[q + 2]!;
      }
      if (fq >= 0 && k < MV * 2) {
        const j = d + k++ * 3;
        U[j] = qx; U[j + 1] = qy; U[j + 2] = U[q + 2]!;
      }
    }
    u = d;
    m = k;
  }
  /** Box, winding and plane of piece g from its vertices; false when it has no area. */
  function finish(g: number, fit: boolean) {
    const n = PN[g]!, o0 = g * MV;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, ar = 0;
    for (let k = 0; k < n; k++) {
      const x = PX[o0 + k]!, y = PY[o0 + k]!, k2 = o0 + ((k + 1) % n);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      ar += x * PY[k2]! - PX[k2]! * y;
    }
    BB[g * 4] = x0; BB[g * 4 + 1] = x1; BB[g * 4 + 2] = y0; BB[g * 4 + 3] = y1;
    SG[g] = ar > 0 ? 1 : -1;
    return Math.abs(ar) > (fit ? 1e-6 : 1);
  }
  const fn = ([SV, KIND, FOBJ, FIDX, FLVL, objs, shade, E]: DioramaFaces, d: DioramaOptions): DioramaPass => {
    const edge = d.edge !== false;
    // Each object's world box this frame (x0 y0 z0 x1 y1 z1), grown with the scene, never per draw.
    let WB = new Float64Array(0);
    /** Can object a, painted first, hide part of object b? Not when a plane between their world boxes
     *  has the eye on b's side (every ray meets b first): the sort's order of the two is exact. */
    function can(a: number, b: number) {
      for (let k = 0; k < 3; k++) {
        const a0 = WB[a * 6 + k]!, a1 = WB[a * 6 + 3 + k]!, b0 = WB[b * 6 + k]!, b1 = WB[b * 6 + 3 + k]!;
        if ((a1 <= b0 + tol && E[k]! > a1) || (b1 <= a0 + tol && E[k]! < a0)) return false;
      }
      return true;
    }
    /** Does earlier piece h hide part of later piece w? Then its piece goes at the end (np). */
    function test(h: number, w: number, np: number) {
      stats.pairs++;
      const ah = PL[h * 3]!, bh = PL[h * 3 + 1]!, chh = PL[h * 3 + 2]!, aw = PL[w * 3]!, bw = PL[w * 3 + 1]!, cw = PL[w * 3 + 2]!, da = ah - aw, db = bh - bw, dc = chh - cw;
      // 1/z(h) − 1/z(w) is linear: at most ≤ 0 on the boxes' overlap (its corners), h is behind w there.
      const x0 = Math.max(BB[h * 4]!, BB[w * 4]!), x1 = Math.min(BB[h * 4 + 1]!, BB[w * 4 + 1]!), y0 = Math.max(BB[h * 4 + 2]!, BB[w * 4 + 2]!), y1 = Math.min(BB[h * 4 + 3]!, BB[w * 4 + 3]!);
      if (Math.max(da * x0 + db * y0, da * x1 + db * y0, da * x0 + db * y1, da * x1 + db * y1) + dc <= 0) return 0;
      const oh = h * MV, ow = w * MV, nw = PN[w]!, sg = SG[w]!;
      u = 0; m = PN[h]!;
      for (let k = 0; k < m; k++) (U[k * 3] = PX[oh + k]!), (U[k * 3 + 1] = PY[oh + k]!), (U[k * 3 + 2] = PE[oh + k]!);
      for (let k = 0; k < nw && m > 2; k++) {
        const x1 = PX[ow + k]!, y1 = PY[ow + k]!, k2 = ow + ((k + 1) % nw), dx = PX[k2]! - x1, dy = PY[k2]! - y1;
        clip(-sg * dy, sg * dx, sg * (dy * x1 - dx * y1));
      }
      if (m < 3) return 0;
      clip(da, db, dc);
      if (m < 3 || m > MV || np >= cap) return np >= cap ? (stats.full++, 0) : 0;
      // Nearer by more than tol somewhere (z = 1/(a x + b y + c)), and more than a speck?
      let gap = 0;
      for (let k = 0; k < m; k++) {
        const x = U[u + k * 3]!, y = U[u + k * 3 + 1]!;
        gap = Math.max(gap, 1 / (aw * x + bw * y + cw) - 1 / (ah * x + bh * y + chh));
      }
      if (gap <= tol) return 0;
      const o0 = np * MV;
      for (let k = 0; k < m; k++) (PX[o0 + k] = U[u + k * 3]!), (PY[o0 + k] = U[u + k * 3 + 1]!), (PE[o0 + k] = U[u + k * 3 + 2]!);
      PN[np] = m; PO[np] = PO[h]!; PB[np] = PB[h]!;
      PL[np * 3] = ah; PL[np * 3 + 1] = bh; PL[np * 3 + 2] = chh;
      return finish(np, false) ? 1 : 0;
    }
    return {
      s(n, ord, ea) {
        if (S0.length < n) (S0 = new Int32Array(ord.length)), (S1 = new Int32Array(ord.length));
        if (objs.length * 6 > WB.length) WB = new Float64Array(objs.length * 12);
        // Each object's world box this frame, from its vertices under M (rows m[0..8], then the move).
        for (let i = 0; i < objs.length; i++) {
          const { mesh: me, M: m } = objs[i]!;
          for (let a = 0; a < 3; a++) {
            let lo = Infinity, hi = -Infinity;
            for (let v = 0; v < me.nv * 3; v += 3) { const x = m[9 + a]! + m[a * 3]! * me.v[v]! + m[a * 3 + 1]! * me.v[v + 1]! + m[a * 3 + 2]! * me.v[v + 2]!; (lo = Math.min(lo, x)), (hi = Math.max(hi, x)); }
            (WB[i * 6 + a] = lo), (WB[i * 6 + 3 + a] = hi);
          }
        }
        EA = ea;
        stats.pieces = stats.pairs = stats.full = 0;
        let np = 0, nn = 0, nb = 0;
        HEAD.fill(-1);
        for (let q = 0; q < n; q++) {
          const e = ord[q]!;
          S0[q] = S1[q] = 0;
          if (KIND[e] || ea[FOBJ[e]!]! < alpha) continue;
          if (np >= cap) { stats.full++; continue; }
          const ob = objs[FOBJ[e]!]!, me = ob.mesh, f = FIDX[e]!, s0 = me.fs[f]!, c = me.fc[f]!, base = ob.vb * 3, o0 = np * MV;
          if (c > MV) continue;
          let best = 0;
          for (let k = 0; k < c; k++) { const j = base + me.fv[s0 + k]! * 3; PX[o0 + k] = SV[j]!; PY[o0 + k] = SV[j + 1]!; PE[o0 + k] = 1; }
          // 1/z = a x + b y + c through the three vertices that span the most area.
          for (let k = 1; k + 1 < c; k++) {
            const ja = base + me.fv[s0]! * 3, jb = base + me.fv[s0 + k]! * 3, jc = base + me.fv[s0 + k + 1]! * 3;
            const xa = SV[ja]!, ya = SV[ja + 1]!, xb = SV[jb]! - xa, yb = SV[jb + 1]! - ya, xc = SV[jc]! - xa, yc = SV[jc + 1]! - ya;
            const det = xb * yc - xc * yb;
            if (Math.abs(det) <= Math.abs(best)) continue;
            best = det;
            const ia = 1 / SV[ja + 2]!, ib = 1 / SV[jb + 2]! - ia, ic = 1 / SV[jc + 2]! - ia, A = (ib * yc - ic * yb) / det, Bc = (xb * ic - xc * ib) / det;
            PL[np * 3] = A; PL[np * 3 + 1] = Bc; PL[np * 3 + 2] = ia - A * xa - Bc * ya;
          }
          PN[np] = c; PO[np] = e; PB[np] = FOBJ[e]!;
          if (!best || !finish(np, true)) continue;
          S0[q] = ++np;
          // This face, then each piece it makes, against every face painted before it (a face's pieces
          // lie inside it on its plane, so the face alone stands for them).
          for (let w = np - 1; w < np; w++) {
            const x0 = BB[w * 4]!, x1 = BB[w * 4 + 1]!, y0 = BB[w * 4 + 2]!, y1 = BB[w * 4 + 3]!, ow = PB[w]!;
            tiles(w);
            st++;
            // Its tiles' faces, then (one row past) BIG's.
            for (let ty = TB[2]!; ty <= TB[3]! + 1; ty++)
              for (let tx = TB[0]!; tx <= TB[1]!; tx++) {
                const big = ty > TB[3]!;
                if (big && tx > TB[0]!) break;
                for (let k = big ? nb - 1 : HEAD[ty * G + tx]!; k >= 0; k = big ? k - 1 : NX[k]!) {
                  const h = big ? BIG[k]! : NF[k]!, j = h * 4;
                  if (ST[h] === st) continue;
                  ST[h] = st;
                  if (PB[h] !== ow && BB[j]! < x1 && BB[j + 1]! > x0 && BB[j + 2]! < y1 && BB[j + 3]! > y0 && can(PB[h]!, ow)) np += test(h, w, np);
                }
              }
          }
          S1[q] = np;
          // Then the face goes in the tiles, for the faces after it.
          const g = S0[q]! - 1;
          tiles(g);
          const span = (TB[1]! - TB[0]! + 1) * (TB[3]! - TB[2]! + 1);
          if (span > 16 || nn + span > NP) BIG[nb++] = g;
          else for (let ty = TB[2]!; ty <= TB[3]!; ty++) for (let tx = TB[0]!; tx <= TB[1]!; tx++) (NF[nn] = g), (NX[nn] = HEAD[ty * G + tx]!), (HEAD[ty * G + tx] = nn++);
          stats.pieces += np - S0[q]!;
        }
      },
      p(ctx, q) {
        for (let g = S0[q]!; g < S1[q]!; g++) {
          const e = PO[g]!, ob = objs[FOBJ[e]!]!, col = ob.et || ob.color, lv = FLVL[e]!, n = PN[g]!, o0 = g * MV;
          ctx.globalAlpha = EA[FOBJ[e]!]!;
          ctx.beginPath();
          for (let k = 0; k < n; k++) k ? ctx.lineTo(PX[o0 + k]!, PY[o0 + k]!) : ctx.moveTo(PX[o0]!, PY[o0]!);
          ctx.closePath();
          ctx.fillStyle = shade(col, lv);
          ctx.fill();
          if (edge) {
            ctx.beginPath();
            for (let k = 0; k < n; k++) if (PE[o0 + k]) { const k1 = o0 + ((k + n - 1) % n); ctx.moveTo(PX[k1]!, PY[k1]!); ctx.lineTo(PX[o0 + k]!, PY[o0 + k]!); }
            ctx.strokeStyle = shade(col, lv > 5 ? lv - 5 : 0);
            ctx.lineWidth = 0.9;
            ctx.stroke();
          }
        }
      },
    };
  };
  return Object.assign(fn, { stats });
}
