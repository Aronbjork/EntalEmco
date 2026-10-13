/* geom.js — 2D geometry helpers for the lathe profile.
 * Coordinates: {z, x} where z runs along the spindle axis (face at 0, chuck at -Z)
 * and x is the RADIUS (distance from the centreline). The plane is treated like a
 * normal math plane with z→right and x→up, so "ccw" means counter-clockwise in that
 * view, which is G03 on the Emco (G02 = clockwise).
 */
(function (global) {
  'use strict';
  const EPS = 1e-9;

  function dist(a, b) { return Math.hypot(b.z - a.z, b.x - a.x); }
  function norm(a) { return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); }

  /** Build an arc (minor arc, < 180°) from endpoints, radius and direction. Returns null if impossible. */
  function arcFromEndpoints(a, b, r, ccw) {
    const L = dist(a, b);
    if (L < 1e-6 || r <= 0) return null;
    if (L > 2 * r + 1e-6) return null;
    const h = Math.sqrt(Math.max(0, r * r - (L / 2) * (L / 2)));
    const dz = (b.z - a.z) / L, dx = (b.x - a.x) / L;
    const nz = -dx, nx = dz;                    // left normal of the chord direction
    const s = ccw ? 1 : -1;                     // ccw arc: centre lies to the left of the chord
    const cz = (a.z + b.z) / 2 + s * nz * h;
    const cx = (a.x + b.x) / 2 + s * nx * h;
    const a0 = Math.atan2(a.x - cx, a.z - cz);
    const a1 = Math.atan2(b.x - cx, b.z - cz);
    let sweep = ccw ? norm(a1 - a0) : norm(a0 - a1);
    if (sweep < 1e-9) sweep = 0;
    return { cz, cx, r, a0, a1, sweep, ccw, start: a, end: b };
  }

  /** Arc from centre + start + end + direction. */
  function arcFromCenter(c, a, b, ccw) {
    const r = dist(c, a);
    const a0 = Math.atan2(a.x - c.x, a.z - c.z);
    const a1 = Math.atan2(b.x - c.x, b.z - c.z);
    const sweep = ccw ? norm(a1 - a0) : norm(a0 - a1);
    return { cz: c.z, cx: c.x, r, a0, a1, sweep, ccw, start: a, end: b };
  }

  function pointOnArc(arc, t) {           // t in [0,1]
    const ang = arc.a0 + (arc.ccw ? 1 : -1) * arc.sweep * t;
    return { z: arc.cz + arc.r * Math.cos(ang), x: arc.cx + arc.r * Math.sin(ang) };
  }

  /** Sample an arc into points (including both ends). */
  function sampleArc(arc, tol) {
    tol = tol || 0.01;
    const n = Math.max(2, Math.ceil(arc.sweep / (2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / arc.r))))));
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(pointOnArc(arc, i / n));
    pts[0] = { z: arc.start.z, x: arc.start.x };
    pts[n] = { z: arc.end.z, x: arc.end.x };
    return pts;
  }

  /** Split an arc at quadrant boundaries (multiples of 90°) — the Compact 5 only takes arcs within one quadrant. */
  function splitArcQuadrants(arc) {
    const out = [];
    const dir = arc.ccw ? 1 : -1;
    let angCur = arc.a0, remaining = arc.sweep, pCur = arc.start;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 16) {
      const q = Math.PI / 2;
      let k = dir > 0 ? Math.floor(angCur / q + 1e-9) + 1 : Math.ceil(angCur / q - 1e-9) - 1;
      let boundary = k * q;
      let step = Math.abs(boundary - angCur);
      if (step < 1e-9) { boundary += dir * q; step = q; }
      let pEnd, sw;
      if (step >= remaining - 1e-9) { sw = remaining; pEnd = arc.end; }
      else { sw = step; pEnd = { z: arc.cz + arc.r * Math.cos(boundary), x: arc.cx + arc.r * Math.sin(boundary) }; }
      out.push({ cz: arc.cz, cx: arc.cx, r: arc.r, a0: angCur, a1: angCur + dir * sw, sweep: sw, ccw: arc.ccw, start: pCur, end: pEnd });
      angCur += dir * sw; remaining -= sw; pCur = pEnd;
    }
    return out;
  }

  /** Convert a profile (points + segment info) to a flat polyline (arcs sampled). */
  function profileToPolyline(profile, tol) {
    const pts = [];
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i];
      if (i === 0) { pts.push({ z: p.z, x: p.x }); continue; }
      const prev = profile[i - 1];
      const seg = prev.seg || { type: 'line' };
      if (seg.type === 'arc') {
        const arc = arcFromEndpoints(prev, p, seg.r, !!seg.ccw);
        if (arc) { const s = sampleArc(arc, tol); for (let j = 1; j < s.length; j++) pts.push(s[j]); continue; }
      }
      pts.push({ z: p.z, x: p.x });
    }
    return pts;
  }

  /** Validate every segment; returns list of problem strings. */
  function validateProfile(profile) {
    const problems = [];
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1], b = profile[i], seg = a.seg || { type: 'line' };
      if (b.x < -1e-9) problems.push('Point ' + (i + 1) + ': X (radius) is negative.');
      if (seg.type === 'arc') {
        if (!(seg.r > 0)) problems.push('Segment ' + i + ': arc radius must be > 0.');
        else if (dist(a, b) > 2 * seg.r + 1e-6) problems.push('Segment ' + i + ': radius ' + seg.r + ' is too small for the distance between the points (' + dist(a, b).toFixed(2) + ' mm). Needs at least ' + (dist(a, b) / 2).toFixed(2) + '.');
        else {
          const arc = arcFromEndpoints(a, b, seg.r, !!seg.ccw);
          if (arc) { const s = sampleArc(arc, 0.01); if (s.some(p => p.x < -1e-6)) problems.push('Segment ' + i + ': the arc dips below the centreline.'); }
        }
      }
      if (dist(a, b) < 1e-6) problems.push('Segment ' + i + ': zero length (two identical points).');
    }
    return problems;
  }

  /** Envelope: for a z-grid, the maximum profile radius at each z. env=Infinity beyond the profile's -Z end (part continues into the chuck), 0 in front of its +Z end. */
  function envelope(poly, zLow, zHigh, dz) {
    const n = Math.max(2, Math.round((zHigh - zLow) / dz) + 1);
    const env = new Float64Array(n).fill(0);
    if (!poly.length) return { z0: zLow, dz, env };
    let zminP = Infinity;
    for (const p of poly) zminP = Math.min(zminP, p.z);
    const idx = z => (z - zLow) / dz;
    for (let s = 0; s < poly.length - 1; s++) {
      const a = poly[s], b = poly[s + 1];
      const za = Math.min(a.z, b.z), zb = Math.max(a.z, b.z);
      const i0 = Math.max(0, Math.ceil(idx(za) - 1e-9)), i1 = Math.min(n - 1, Math.floor(idx(zb) + 1e-9));
      if (zb - za < 1e-9) {               // vertical segment: mark nearest grid cell
        const i = Math.round(idx(za)); const xm = Math.max(a.x, b.x);
        if (i >= 0 && i < n) env[i] = Math.max(env[i], xm);
        continue;
      }
      for (let i = i0; i <= i1; i++) {
        const z = zLow + i * dz; const t = (z - a.z) / (b.z - a.z);
        const x = a.x + t * (b.x - a.x);
        if (x > env[i]) env[i] = x;
      }
    }
    for (let i = 0; i < n; i++) { const z = zLow + i * dz; if (z < zminP - 1e-9) env[i] = Infinity; }
    return { z0: zLow, dz, env };
  }

  /** Dilate the envelope by allowance: +allowX radially and ±allowZ axially. */
  function dilateEnvelope(E, allowX, allowZ) {
    const n = E.env.length, w = Math.max(0, Math.round(allowZ / E.dz));
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) if (E.env[j] > m) m = E.env[j];
      out[i] = m === Infinity ? Infinity : m + allowX;
    }
    return { z0: E.z0, dz: E.dz, env: out };
  }

  /** Fillet the corner at profile index i (both adjacent segments must be lines). Returns a new profile or throws. */
  function filletAt(profile, i, r) {
    if (i <= 0 || i >= profile.length - 1) throw new Error('Pick an inner point (not the first or last).');
    const p = profile[i], a = profile[i - 1], b = profile[i + 1];
    if ((a.seg && a.seg.type === 'arc') || (p.seg && p.seg.type === 'arc')) throw new Error('Fillet needs two straight segments at the corner.');
    const u1 = { z: a.z - p.z, x: a.x - p.x }, u2 = { z: b.z - p.z, x: b.x - p.x };
    const l1 = Math.hypot(u1.z, u1.x), l2 = Math.hypot(u2.z, u2.x);
    u1.z /= l1; u1.x /= l1; u2.z /= l2; u2.x /= l2;
    const cosT = Math.max(-1, Math.min(1, u1.z * u2.z + u1.x * u2.x));
    const theta = Math.acos(cosT);
    if (theta < 1e-6 || Math.abs(theta - Math.PI) < 1e-6) throw new Error('Segments are collinear; nothing to fillet.');
    const t = r / Math.tan(theta / 2);
    if (t > l1 - 1e-9 || t > l2 - 1e-9) throw new Error('Radius ' + r + ' is too large for this corner (max about ' + (Math.min(l1, l2) * Math.tan(theta / 2)).toFixed(2) + ').');
    const A = { z: p.z + u1.z * t, x: p.x + u1.x * t };
    const B = { z: p.z + u2.z * t, x: p.x + u2.x * t };
    const cross = (p.z - a.z) * (b.x - p.x) - (p.x - a.x) * (b.z - p.z);   // >0: left turn → ccw arc
    const out = profile.slice();
    out.splice(i, 1, { z: A.z, x: A.x, seg: { type: 'arc', r: r, ccw: cross > 0 } }, { z: B.z, x: B.x, seg: p.seg ? Object.assign({}, p.seg) : { type: 'line' } });
    return out;
  }

  /** Chamfer the corner at index i with leg length c. */
  function chamferAt(profile, i, c) {
    if (i <= 0 || i >= profile.length - 1) throw new Error('Pick an inner point (not the first or last).');
    const p = profile[i], a = profile[i - 1], b = profile[i + 1];
    if ((a.seg && a.seg.type === 'arc') || (p.seg && p.seg.type === 'arc')) throw new Error('Chamfer needs two straight segments at the corner.');
    const l1 = dist(a, p), l2 = dist(p, b);
    if (c > l1 - 1e-9 || c > l2 - 1e-9) throw new Error('Chamfer is longer than the adjacent segment.');
    const A = { z: p.z + (a.z - p.z) / l1 * c, x: p.x + (a.x - p.x) / l1 * c };
    const B = { z: p.z + (b.z - p.z) / l2 * c, x: p.x + (b.x - p.x) / l2 * c };
    const out = profile.slice();
    out.splice(i, 1, { z: A.z, x: A.x, seg: { type: 'line' } }, { z: B.z, x: B.x, seg: p.seg ? Object.assign({}, p.seg) : { type: 'line' } });
    return out;
  }

  function bbox(pts) {
    let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity;
    for (const p of pts) { zmin = Math.min(zmin, p.z); zmax = Math.max(zmax, p.z); xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); }
    return { zmin, zmax, xmin, xmax };
  }

  global.Geom = { EPS, dist, arcFromEndpoints, arcFromCenter, pointOnArc, sampleArc, splitArcQuadrants, profileToPolyline, validateProfile, envelope, dilateEnvelope, filletAt, chamferAt, bbox };
})(typeof window !== 'undefined' ? window : globalThis);
