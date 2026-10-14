/* mesh.js — 3D model import (STL / OBJ) and extraction of the turned profile.
 *
 * A lathe part is a body of revolution, so everything the CAM needs is its silhouette:
 * the largest radius of the model at every position along the turning axis. This file
 *   1. parses STL (binary or ASCII) and OBJ into a flat triangle array,
 *   2. guesses which coordinate axis is the axis of rotation,
 *   3. slices the model with planes perpendicular to that axis and keeps the largest
 *      radius found in each slice (steps are located exactly by bisection),
 *   4. fits straight lines and circular arcs to that curve, giving profile points in
 *      the same { z, x, seg } format the DXF import produces (X is the radius,
 *      Z = 0 at the face and negative toward the chuck),
 *   5. looks for a centre hole starting at the face (a drilling candidate).
 *
 * Triangles are stored as Float64Array, 9 numbers per triangle (x, y, z of 3 vertices).
 * After orientation they are rewritten as (d, u, v) per vertex: d = distance from the
 * face along the axis, (u, v) = position relative to the axis.
 */
(function (global) {
  'use strict';

  /* ---------- parsing ---------- */

  /** Parse a file (ArrayBuffer) by its extension. Returns { tris, count, min:[x,y,z], max:[x,y,z], name }. */
  function parse(buf, name) {
    const ext = (/\.([^.]+)$/.exec(name || '') || [, ''])[1].toLowerCase();
    const tris = ext === 'obj' ? parseObj(buf) : parseStl(buf);
    if (!tris.length) throw new Error('no triangles found');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) { const v = tris[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    if (!isFinite(min[0] + max[0] + min[1] + max[1] + min[2] + max[2])) throw new Error('model contains invalid numbers');
    return { tris, count: tris.length / 9, min, max, name: name || '' };
  }

  /** Binary STL is recognised by its size (84 + 50 bytes per triangle); everything else is read as ASCII. */
  function parseStl(buf) {
    if (buf.byteLength >= 84) {
      const dv = new DataView(buf), n = dv.getUint32(80, true);
      if (84 + 50 * n === buf.byteLength) {
        const out = new Float64Array(n * 9);
        for (let t = 0; t < n; t++) { const off = 84 + 50 * t + 12; for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(off + 4 * k, true); }
        return out;
      }
    }
    const text = new TextDecoder('latin1').decode(buf), re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g, vals = [];
    let m; while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
    return Float64Array.from(vals.slice(0, vals.length - vals.length % 9));
  }

  /** OBJ: "v x y z" vertices and "f a b c ..." faces (polygons are fanned, negative indices are relative). */
  function parseObj(buf) {
    const lines = new TextDecoder('latin1').decode(buf).split(/\r?\n/), verts = [], out = [];
    for (const raw of lines) {
      const l = raw.trim();
      if (l.startsWith('v ')) { const p = l.split(/\s+/); verts.push(+p[1], +p[2], +p[3]); }
      else if (l.startsWith('f ')) {
        const idx = l.split(/\s+/).slice(1).map(t => { const i = parseInt(t, 10); return i < 0 ? verts.length / 3 + i : i - 1; });
        for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) { if (!(i >= 0 && i * 3 + 2 < verts.length)) throw new Error('face refers to a missing vertex'); out.push(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]); }
      }
    }
    return Float64Array.from(out);
  }

  /* ---------- axis detection ---------- */

  /**
   * Decide which of X / Y / Z is the axis of rotation. For each candidate the model is
   * sliced at 41 positions along the axis; in a body of revolution all points of one
   * slice are at the same distance from the axis, so the radial spread is near zero.
   * The median spread over the slices is the score (the median ignores a few slices
   * through a hole, groove or flat). Returns 'x' | 'y' | 'z'.
   */
  function suggestAxis(mesh) {
    const S = mesh.tris, maxLen = Math.max(mesh.max[0] - mesh.min[0], mesh.max[1] - mesh.min[1], mesh.max[2] - mesh.min[2]);
    let best = null;
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3, c = (a + 2) % 3, len = mesh.max[a] - mesh.min[a];
      if (!(len > 0)) continue;
      const cb = (mesh.min[b] + mesh.max[b]) / 2, cc = (mesh.min[c] + mesh.max[c]) / 2, SL = 41;
      const lo = new Float64Array(SL).fill(Infinity), hi = new Float64Array(SL), cnt = new Uint32Array(SL);
      for (let o = 0; o < S.length; o += 9) {
        const mn = Math.min(S[o + a], S[o + 3 + a], S[o + 6 + a]), mx = Math.max(S[o + a], S[o + 3 + a], S[o + 6 + a]);
        const s0 = Math.max(0, Math.ceil((mn - mesh.min[a]) / len * SL - 0.5)), s1 = Math.min(SL - 1, Math.floor((mx - mesh.min[a]) / len * SL - 0.5));
        for (let s = s0; s <= s1; s++) {
          const d = mesh.min[a] + (s + 0.5) / SL * len;
          for (let e = 0; e < 3; e++) {
            const i = o + e * 3, j = o + ((e + 1) % 3) * 3, da = S[i + a], db = S[j + a];
            if (Math.abs(da - db) < 1e-12 || (da - d) * (db - d) > 0) continue;
            const t = (d - da) / (db - da), r = Math.hypot(S[i + b] + t * (S[j + b] - S[i + b]) - cb, S[i + c] + t * (S[j + c] - S[i + c]) - cc);
            if (r < lo[s]) lo[s] = r; if (r > hi[s]) hi[s] = r; cnt[s]++;
          }
        }
      }
      let R = 0; const spreads = [];
      for (let s = 0; s < SL; s++) if (cnt[s] >= 3) { spreads.push((hi[s] - lo[s]) / Math.max(hi[s], 1e-9)); if (hi[s] > R) R = hi[s]; }
      if (!spreads.length) continue;
      spreads.sort((p, q) => p - q);
      const score = spreads[spreads.length >> 1];
      const rank = score - 1e-3 * len / maxLen;                              // longer axis wins a tie
      if (!best || rank < best.rank) best = { axis: 'xyz'[a], rank };
    }
    return best ? best.axis : 'z';
  }

  /* ---------- slicing ---------- */

  /**
   * Re-express the triangles as (d, u, v) per vertex for the chosen axis. faceEnd 'min'
   * puts the face at the smallest coordinate along the axis, 'max' at the largest.
   * Returns { T, L } with L the length along the axis in mm.
   */
  function orient(mesh, axis, faceEnd, scale) {
    const a = 'xyz'.indexOf(axis), b = (a + 1) % 3, c = (a + 2) % 3, S = mesh.tris, T = new Float64Array(S.length);
    const cb = (mesh.min[b] + mesh.max[b]) / 2, cc = (mesh.min[c] + mesh.max[c]) / 2, L = (mesh.max[a] - mesh.min[a]) * scale;
    for (let i = 0; i < S.length; i += 3) {
      const d = (S[i + a] - mesh.min[a]) * scale;
      T[i] = faceEnd === 'max' ? L - d : d; T[i + 1] = (S[i + b] - cb) * scale; T[i + 2] = (S[i + c] - cc) * scale;
    }
    return { T, L };
  }

  /** Radii (from the axis) of the points where triangle `o` crosses the plane d = const; written to out[], returns the count. */
  function planeRadii(T, o, d, out) {
    let n = 0;
    for (let e = 0; e < 3; e++) {
      const i = o + e * 3, j = o + ((e + 1) % 3) * 3, da = T[i], db = T[j];
      if (Math.abs(da - db) < 1e-9) { if (Math.abs(da - d) < 1e-6) { out[n++] = Math.hypot(T[i + 1], T[i + 2]); out[n++] = Math.hypot(T[j + 1], T[j + 2]); } }
      else if ((da - d) * (db - d) <= 0) { const t = (d - da) / (db - da); out[n++] = Math.hypot(T[i + 1] + t * (T[j + 1] - T[i + 1]), T[i + 2] + t * (T[j + 2] - T[i + 2])); }
    }
    return n;
  }
  /** Largest radius of the whole model at plane d (full scan; used for bisection). */
  function sliceMax(T, d) {
    const out = new Float64Array(6); let m = 0;
    for (let o = 0; o < T.length; o += 9) { const n = planeRadii(T, o, d, out); for (let k = 0; k < n; k++) if (out[k] > m) m = out[k]; }
    return m;
  }
  /** All crossing radii of the model at plane d (for the centre-hole probe). */
  function sliceAll(T, d) {
    const out = new Float64Array(6), res = [];
    for (let o = 0; o < T.length; o += 9) { const n = planeRadii(T, o, d, out); for (let k = 0; k < n; k++) res.push(out[k]); }
    return res;
  }

  /**
   * Largest radius at N + 2 positions along the part: the two end faces exactly, and the
   * centres of N equal bins in between (so a step between bins is never sampled on its
   * own plane). Triangles are visited once and update only the samples they span.
   */
  function sampleSilhouette(T, L, N) {
    const pitch = L / N, r = new Float64Array(N + 2), d = new Float64Array(N + 2), out = new Float64Array(6);
    d[0] = 0; d[N + 1] = L; for (let s = 1; s <= N; s++) d[s] = (s - 0.5) * pitch;
    const upd = (s, o) => { const n = planeRadii(T, o, d[s], out); for (let k = 0; k < n; k++) if (out[k] > r[s]) r[s] = out[k]; };
    for (let o = 0; o < T.length; o += 9) {
      const lo = Math.min(T[o], T[o + 3], T[o + 6]), hi = Math.max(T[o], T[o + 3], T[o + 6]);
      if (lo <= 1e-6) upd(0, o);
      if (hi >= L - 1e-6) upd(N + 1, o);
      const s0 = Math.max(1, Math.ceil(lo / pitch + 0.5 - 1e-9)), s1 = Math.min(N, Math.floor(hi / pitch + 0.5 + 1e-9));
      for (let s = s0; s <= s1; s++) upd(s, o);
    }
    return { d, r };
  }

  /**
   * Silhouette as a polyline of {z, r}. Where the radius jumps between two neighbouring
   * samples (a shoulder), the exact plane of the step is found by bisection and two
   * points with the same Z are inserted so the step comes out vertical.
   */
  function silhouette(T, L, N) {
    const { d, r } = sampleSilhouette(T, L, N), pts = [];
    for (let s = 0; s < d.length; s++) {
      pts.push({ z: -d[s], r: r[s] });
      if (s + 1 < d.length) {
        const dd = d[s + 1] - d[s], dr = Math.abs(r[s + 1] - r[s]);
        if (dr > Math.max(0.25, 6 * dd)) {
          let lo = d[s], hi = d[s + 1]; const mid = (r[s] + r[s + 1]) / 2, rising = r[s + 1] > r[s];
          for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2; if ((sliceMax(T, m) > mid) === rising) hi = m; else lo = m; }
          const dm = (lo + hi) / 2;
          pts.push({ z: -dm, r: r[s] }, { z: -dm, r: r[s + 1] });
        }
      }
    }
    return pts;
  }

  /* ---------- line / arc fitting ---------- */

  /** Douglas–Peucker: indices of the vertices that keep the polyline within tol (iterative, keeps both ends). */
  function simplify(P, tol) {
    const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1;
    const stack = [[0, P.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); let worst = -1, wd = tol;
      const dz = P[b].z - P[a].z, dr = P[b].r - P[a].r, len = Math.hypot(dz, dr);
      for (let i = a + 1; i < b; i++) {
        const d = len < 1e-12 ? Math.hypot(P[i].z - P[a].z, P[i].r - P[a].r) : Math.abs(dz * (P[i].r - P[a].r) - dr * (P[i].z - P[a].z)) / len;
        if (d > wd) { wd = d; worst = i; }
      }
      if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
    }
    const idx = []; for (let i = 0; i < P.length; i++) if (keep[i]) idx.push(i);
    return idx;
  }

  /**
   * Try to describe the samples P[a..b] with one circular arc (minor arc, up to about
   * 170°) through P[a], the middle sample and P[b]. Returns { r, ccw } when every sample
   * lies within tol of the circle, otherwise null.
   */
  function fitArc(P, a, b, tol) {
    const A = P[a], B = P[b], M = P[(a + b) >> 1];
    const d = 2 * (A.z * (M.r - B.r) + M.z * (B.r - A.r) + B.z * (A.r - M.r));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = A.z * A.z + A.r * A.r, m2 = M.z * M.z + M.r * M.r, b2 = B.z * B.z + B.r * B.r;
    const cz = (a2 * (M.r - B.r) + m2 * (B.r - A.r) + b2 * (A.r - M.r)) / d, cr = (a2 * (B.z - M.z) + m2 * (A.z - B.z) + b2 * (M.z - A.z)) / d;
    const R = Math.hypot(A.z - cz, A.r - cr);
    if (R < 0.1 || R > 300) return null;
    const chord = Math.hypot(B.z - A.z, B.r - A.r); if (chord > 1.97 * R) return null;
    const cross = (B.z - A.z) * (M.r - A.r) - (B.r - A.r) * (M.z - A.z), crossC = (B.z - A.z) * (cr - A.r) - (B.r - A.r) * (cz - A.z);
    if (cross * crossC >= 0) return null;                                  // centre must lie on the far side of the chord
    const off = (z, r) => Math.abs(Math.hypot(z - cz, r - cr) - R);
    for (let k = a; k <= b; k++) {
      if (off(P[k].z, P[k].r) > tol) return null;
      if (k === b) break;
      // a step has only two samples; test along the straight piece between samples too
      const gz = P[k + 1].z - P[k].z, gr = P[k + 1].r - P[k].r, n = Math.ceil(Math.hypot(gz, gr) / 0.05);
      for (let q = 1; q < n; q++) if (off(P[k].z + gz * q / n, P[k].r + gr * q / n) > tol) return null;
    }
    return { r: R, ccw: cross < 0 };
  }

  const round = v => Math.round(v * 1000) / 1000;

  /** Silhouette samples → profile points with line and arc segments. */
  function fitProfile(P, tol) {
    const V = simplify(P, tol), prof = [];
    let i = 0;
    while (i < V.length - 1) {
      let best = null;
      for (let j = i + 2; j < V.length; j++) { const arc = fitArc(P, V[i], V[j], tol * 1.5); if (arc) best = { j, arc }; else break; }
      const p = P[V[i]];
      if (best) { prof.push({ z: round(p.z), x: round(Math.max(0, p.r)), seg: { type: 'arc', r: round(best.arc.r), ccw: best.arc.ccw } }); i = best.j; }
      else { prof.push({ z: round(p.z), x: round(Math.max(0, p.r)), seg: { type: 'line' } }); i++; }
    }
    const q = P[V[V.length - 1]]; prof.push({ z: round(q.z), x: round(Math.max(0, q.r)), seg: { type: 'line' } });
    return prof;
  }

  /* ---------- centre hole ---------- */

  /**
   * Is there a round bore at plane d? Yes when the crossing points split into an outer
   * ring and an inner ring of constant radius (a flat or keyway only has a few points at
   * its smallest radius). Returns the bore radius or 0.
   */
  function boreAt(T, d) {
    const rs = sliceAll(T, d); if (rs.length < 8) return 0;
    let lo = Infinity, hi = 0; for (const r of rs) { if (r < lo) lo = r; if (r > hi) hi = r; }
    if (lo < 0.3 || hi < lo + 0.5) return 0;
    const ring = rs.filter(r => r <= lo + Math.max(0.05, 0.03 * lo));
    return ring.length / rs.length >= 0.2 ? ring.reduce((s, r) => s + r, 0) / ring.length : 0;
  }
  /** Look for a straight bore starting at the face. Returns { dia, depth } (mm) or null. */
  function findCentreHole(T, L) {
    const step = 0.25; let r0 = boreAt(T, step * 2); if (!r0) return null;
    let depth = step * 2;
    for (let d = step * 3; d < L - step && d < 200; d += step) { const r = boreAt(T, d); if (!r || Math.abs(r - r0) > 0.1) break; depth = d; }
    return { dia: Math.round(r0 * 2 * 10) / 10, depth: Math.round((depth + step / 2) * 10) / 10 };
  }

  /* ---------- top level ---------- */

  /**
   * Build the lathe profile from a parsed model.
   *   o = { axis: 'auto'|'x'|'y'|'z', faceEnd: 'auto'|'min'|'max', scale (mm per model unit), tol (mm), hole (bool) }
   * Returns { profile, raw, info:{ axis, faceEnd, length, maxDia, hole }, warnings }.
   * 'auto' face end puts Z0 at the end with the smaller radius.
   */
  function toProfile(mesh, o) {
    o = o || {};
    const warnings = [], scale = o.scale > 0 ? o.scale : 1, tol = o.tol > 0 ? o.tol : 0.03;
    const axis = o.axis && o.axis !== 'auto' ? o.axis : suggestAxis(mesh);
    let faceEnd = o.faceEnd === 'max' ? 'max' : 'min', or = orient(mesh, axis, faceEnd, scale);
    if (!(or.L > 0.1)) return { profile: [], raw: [], info: { axis, faceEnd, length: or.L, maxDia: 0, hole: null }, warnings: ['The model has no length along the ' + axis.toUpperCase() + ' axis.'] };
    if (!o.faceEnd || o.faceEnd === 'auto') {
      if (sliceMax(or.T, or.L) < sliceMax(or.T, 0) - 1e-6) { faceEnd = 'max'; or = orient(mesh, axis, 'max', scale); }
    }
    const N = Math.max(40, Math.min(3000, Math.round(or.L / 0.05)));
    const raw = silhouette(or.T, or.L, N);
    let maxR = 0; for (const p of raw) if (p.r > maxR) maxR = p.r;
    const profile = fitProfile(raw, tol);
    if (profile[0].x > 0.01) profile.unshift({ z: profile[0].z, x: 0, seg: { type: 'line' } });
    const hole = o.hole === false ? null : findCentreHole(or.T, or.L);
    if (or.L > 1000 || maxR * 2 > 500) warnings.push('The model is ' + or.L.toFixed(0) + ' mm long and Ø' + (maxR * 2).toFixed(0) + ' mm. Check the unit scale (inch / metre models).');
    if (maxR * 2 > 80) warnings.push('Larger than the Compact 5 chucks (about Ø80 mm); check the unit scale.');
    if (profile.length > 200) warnings.push('The profile has ' + profile.length + ' points; raise the tolerance to simplify it.');
    return { profile, raw, info: { axis, faceEnd, length: or.L, maxDia: maxR * 2, hole }, warnings };
  }

  global.Mesh = { parse, suggestAxis, toProfile };
})(window);
