/* dxf.js — minimal ASCII DXF reader (LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE, SPLINE)
 * plus mapping of the drawing onto lathe coordinates (Z along the axis, X = radius)
 * and chaining of the entities into one continuous profile.
 */
(function (global) {
  'use strict';

  function parse(text) {
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      if (isNaN(code)) continue;
      pairs.push([code, lines[i + 1].trim()]);
    }
    let units = 0;                       // $INSUNITS: 1 = inch, 4 = mm, 0 = unitless
    const entities = [];
    let section = null, i = 0;
    while (i < pairs.length) {
      const [c, v] = pairs[i];
      if (c === 0 && v === 'SECTION') { section = pairs[i + 1] ? pairs[i + 1][1] : null; i += 2; continue; }
      if (c === 0 && v === 'ENDSEC') { section = null; i++; continue; }
      if (section === 'HEADER' && c === 9 && v === '$INSUNITS') { const n = pairs[i + 1]; if (n && n[0] === 70) units = parseInt(n[1], 10) || 0; i += 2; continue; }
      if (section === 'ENTITIES' && c === 0) {
        const type = v; const props = [];
        let j = i + 1;
        while (j < pairs.length && pairs[j][0] !== 0) { props.push(pairs[j]); j++; }
        // POLYLINE: gather VERTEX records until SEQEND
        if (type === 'POLYLINE') {
          const verts = [];
          while (j < pairs.length && pairs[j][0] === 0 && pairs[j][1] === 'VERTEX') {
            const vp = []; let k = j + 1;
            while (k < pairs.length && pairs[k][0] !== 0) { vp.push(pairs[k]); k++; }
            verts.push(vp); j = k;
          }
          if (j < pairs.length && pairs[j][0] === 0 && pairs[j][1] === 'SEQEND') { let k = j + 1; while (k < pairs.length && pairs[k][0] !== 0) k++; j = k; }
          entities.push(...polylineFromVertices(verts.map(vp => ({ x: num(vp, 10), y: num(vp, 20), b: num(vp, 42) || 0 })), (num(props, 70) || 0) & 1, 'POLYLINE'));
          i = j; continue;
        }
        const ents = convertEntity(type, props);
        if (ents) entities.push(...ents);
        i = j; continue;
      }
      i++;
    }
    return { entities, units };
  }

  function num(props, code) { const p = props.find(q => q[0] === code); return p ? parseFloat(p[1]) : undefined; }
  function nums(props, code) { return props.filter(q => q[0] === code).map(q => parseFloat(q[1])); }

  function convertEntity(type, props) {
    const layer = (props.find(q => q[0] === 8) || [8, '0'])[1];
    switch (type) {
      case 'LINE':
        return [{ type: 'line', layer, a: { x: num(props, 10), y: num(props, 20) }, b: { x: num(props, 11), y: num(props, 21) } }];
      case 'ARC': {
        const c = { x: num(props, 10), y: num(props, 20) }, r = num(props, 40);
        const a0 = (num(props, 50) || 0) * Math.PI / 180, a1 = (num(props, 51) || 0) * Math.PI / 180;
        return [arcEnt(c, r, a0, a1, layer)];
      }
      case 'CIRCLE': {
        const c = { x: num(props, 10), y: num(props, 20) }, r = num(props, 40);
        return [Object.assign(arcEnt(c, r, 0, Math.PI, layer), { circle: true }), Object.assign(arcEnt(c, r, Math.PI, 2 * Math.PI, layer), { circle: true })];
      }
      case 'LWPOLYLINE': {
        const verts = []; let cur = null;
        for (const [c, v] of props) {
          if (c === 10) { cur = { x: parseFloat(v), y: 0, b: 0 }; verts.push(cur); }
          else if (c === 20 && cur) cur.y = parseFloat(v);
          else if (c === 42 && cur) cur.b = parseFloat(v);
        }
        return polylineFromVertices(verts, (num(props, 70) || 0) & 1, layer);
      }
      case 'SPLINE': {
        let xs = nums(props, 11), ys = nums(props, 21);          // fit points
        if (xs.length < 2) { xs = nums(props, 10); ys = nums(props, 20); }   // fall back to control points
        const out = [];
        for (let k = 0; k + 1 < xs.length; k++) out.push({ type: 'line', layer, a: { x: xs[k], y: ys[k] }, b: { x: xs[k + 1], y: ys[k + 1] }, approx: true });
        return out;
      }
      default: return null;
    }
  }

  function arcEnt(c, r, a0, a1, layer) {
    let sweep = a1 - a0; while (sweep <= 0) sweep += 2 * Math.PI; while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
    return { type: 'arc', layer, c, r, a0, sweep, ccw: true,
      a: { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) },
      b: { x: c.x + r * Math.cos(a0 + sweep), y: c.y + r * Math.sin(a0 + sweep) } };
  }

  function polylineFromVertices(verts, closed, layer) {
    const out = [];
    const n = verts.length;
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const p = verts[k], q = verts[(k + 1) % n];
      if (!p || !q || isNaN(p.x) || isNaN(q.x)) continue;
      if (Math.abs(p.b) < 1e-12) { out.push({ type: 'line', layer, a: { x: p.x, y: p.y }, b: { x: q.x, y: q.y } }); continue; }
      const theta = 4 * Math.atan(Math.abs(p.b));
      const L = Math.hypot(q.x - p.x, q.y - p.y);
      if (L < 1e-12) continue;
      const r = L / (2 * Math.sin(theta / 2));
      const d = r * Math.cos(theta / 2) * (p.b > 0 ? 1 : -1);        // signed distance from chord mid to centre (left side positive)
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const nx = -(q.y - p.y) / L, ny = (q.x - p.x) / L;             // left normal
      const c = { x: mx + nx * d, y: my + ny * d };
      const ccw = p.b > 0;
      const a0 = Math.atan2(p.y - c.y, p.x - c.x), a1 = Math.atan2(q.y - c.y, q.x - c.x);
      let sweep = ccw ? a1 - a0 : a0 - a1; while (sweep < 0) sweep += 2 * Math.PI;
      out.push({ type: 'arc', layer, c, r, a0: ccw ? a0 : a1, sweep, ccw, a: { x: p.x, y: p.y }, b: { x: q.x, y: q.y }, bulgeCcw: ccw });
    }
    return out;
  }

  /* ---------- mapping to lathe coordinates ---------- */

  /** mapping = { zAxis:'x'|'y', flipZ:bool, axisPos:number, side:+1|-1, zZero:number, scale:number, removeAxis:bool } */
  function mapPoint(p, m) {
    const along = m.zAxis === 'x' ? p.x : p.y;
    const perp = m.zAxis === 'x' ? p.y : p.x;
    return { z: (along - m.zZero) * (m.flipZ ? -1 : 1) * m.scale, x: (perp - m.axisPos) * m.side * m.scale };
  }

  /** Map all entities into lathe segments {type, a:{z,x}, b:{z,x}, r, ccw, c:{z,x}} (arcs may be split so each is < 180°). */
  function mapEntities(entities, m) {
    const segs = [];
    for (const e of entities) {
      if (e.type === 'line') { segs.push({ type: 'line', a: mapPoint(e.a, m), b: mapPoint(e.b, m), src: e }); continue; }
      // arcs: split into pieces of at most 90° in the source plane so each piece is a minor arc after mapping
      const pieces = Math.max(1, Math.ceil(e.sweep / (Math.PI / 2) - 1e-9));
      for (let k = 0; k < pieces; k++) {
        const t0 = e.a0 + (e.ccw ? 1 : -1) * e.sweep * (k / pieces), t1 = e.a0 + (e.ccw ? 1 : -1) * e.sweep * ((k + 1) / pieces), tm = (t0 + t1) / 2;
        // for bulge arcs stored with a0 as the ccw start we always walk ccw from a0
        const A = { x: e.c.x + e.r * Math.cos(e.a0 + e.sweep * (k / pieces)), y: e.c.y + e.r * Math.sin(e.a0 + e.sweep * (k / pieces)) };
        const B = { x: e.c.x + e.r * Math.cos(e.a0 + e.sweep * ((k + 1) / pieces)), y: e.c.y + e.r * Math.sin(e.a0 + e.sweep * ((k + 1) / pieces)) };
        const M = { x: e.c.x + e.r * Math.cos(e.a0 + e.sweep * ((k + 0.5) / pieces)), y: e.c.y + e.r * Math.sin(e.a0 + e.sweep * ((k + 0.5) / pieces)) };
        const a = mapPoint(A, m), b = mapPoint(B, m), mid = mapPoint(M, m), c = mapPoint(e.c, m);
        const cross = (mid.z - a.z) * (b.x - mid.x) - (mid.x - a.x) * (b.z - mid.z);
        segs.push({ type: 'arc', a, b, c, r: e.r * m.scale, ccw: cross > 0, src: e });
        void t0; void t1; void tm;
      }
    }
    return segs;
  }

  function reverseSeg(s) { return Object.assign({}, s, { a: s.b, b: s.a, ccw: s.type === 'arc' ? !s.ccw : s.ccw }); }
  function segLen(s) {
    if (s.type === 'line') return Math.hypot(s.b.z - s.a.z, s.b.x - s.a.x);
    const chord = Math.hypot(s.b.z - s.a.z, s.b.x - s.a.x);
    const half = Math.min(1, chord / (2 * s.r));
    return 2 * s.r * Math.asin(half);
  }

  /** Chain segments by shared endpoints. Returns array of chains (arrays of oriented segments). */
  function chainSegments(segs, tol) {
    const used = new Array(segs.length).fill(false);
    const near = (p, q) => Math.abs(p.z - q.z) <= tol && Math.abs(p.x - q.x) <= tol;
    const chains = [];
    const findNext = (pt, excludeIdx) => {
      for (let i = 0; i < segs.length; i++) {
        if (used[i] || i === excludeIdx) continue;
        if (near(segs[i].a, pt)) return { i, rev: false };
        if (near(segs[i].b, pt)) return { i, rev: true };
      }
      return null;
    };
    for (let s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      used[s] = true;
      let chain = [segs[s]];
      // extend forward
      for (;;) { const nx = findNext(chain[chain.length - 1].b, -1); if (!nx) break; used[nx.i] = true; chain.push(nx.rev ? reverseSeg(segs[nx.i]) : segs[nx.i]); if (near(chain[chain.length - 1].b, chain[0].a)) break; }
      // extend backward
      for (;;) { const nx = findNext(chain[0].a, -1); if (!nx) break; used[nx.i] = true; chain.unshift(nx.rev ? segs[nx.i] : reverseSeg(segs[nx.i])); }
      chains.push(chain);
    }
    return chains;
  }

  function chainLength(ch) { return ch.reduce((s, g) => s + segLen(g), 0); }

  /** Suggest a mapping for a parsed drawing. */
  function suggestMapping(parsed, zAxis) {
    const scale = parsed.units === 1 ? 25.4 : 1;
    const ents = parsed.entities;
    const tryAxis = (za) => {
      const m0 = { zAxis: za, flipZ: false, axisPos: 0, side: 1, zZero: 0, scale: 1, removeAxis: false };
      const segs = mapEntities(ents, m0);
      if (!segs.length) return null;
      const chains = chainSegments(segs, 1e-3).sort((p, q) => chainLength(q) - chainLength(p));
      const best = chains[0];
      const pts = []; for (const g of best) { pts.push(g.a); pts.push(g.b); if (g.type === 'arc') { const mid = { z: (g.a.z + g.b.z) / 2, x: (g.a.x + g.b.x) / 2 }; pts.push(mid); } }
      const E1 = best[0].a, E2 = best[best.length - 1].b;
      const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
      const xmin = Math.min(...xs), xmax = Math.max(...xs);
      const tol = 1e-3 * Math.max(1, xmax - xmin);
      let axisPos = null, side = 1, tip = null;
      for (const E of [E1, E2]) {
        if (Math.abs(E.x - xmin) <= tol) { axisPos = E.x; side = 1; tip = E; break; }
        if (Math.abs(E.x - xmax) <= tol) { axisPos = E.x; side = -1; tip = E; break; }
      }
      let score = 2;
      if (axisPos === null) { axisPos = xmin; side = 1; score = 1; tip = (E1.z > E2.z ? E1 : E2); }
      const other = tip === E1 ? E2 : E1;
      const flipZ = other.z > tip.z;           // part must extend toward -Z from the face
      return { mapping: { zAxis: za, flipZ, axisPos, side, zZero: tip.z, scale, removeAxis: true }, score, span: Math.max(...zs) - Math.min(...zs), chains: chains.length };
    };
    const cand = zAxis ? [tryAxis(zAxis)] : [tryAxis('x'), tryAxis('y')];
    const ok = cand.filter(Boolean);
    if (!ok.length) return { zAxis: 'x', flipZ: false, axisPos: 0, side: 1, zZero: 0, scale, removeAxis: true };
    ok.sort((p, q) => (q.score - p.score) || (q.span - p.span));
    return ok[0].mapping;
  }

  /** Build the lathe profile from a parsed drawing with a mapping. */
  function toProfile(parsed, m, opts) {
    opts = opts || {};
    const tol = opts.tol || 0.02;
    let segs = mapEntities(parsed.entities, m);
    const all = segs.slice();
    const warnings = [];
    if (m.removeAxis) {
      const before = segs.length;
      segs = segs.filter(s => !(Math.abs(s.a.x) < tol && Math.abs(s.b.x) < tol));
      if (segs.length !== before) warnings.push((before - segs.length) + ' segment(s) lying on the centreline were dropped.');
    }
    const belowBefore = segs.length;
    segs = segs.filter(s => !(s.a.x < -tol && s.b.x < -tol));
    if (segs.length !== belowBefore) warnings.push((belowBefore - segs.length) + ' segment(s) below the centreline were ignored (mirror half).');
    segs = segs.filter(s => segLen(s) > 1e-6);
    const chains = chainSegments(segs, tol).sort((p, q) => chainLength(q) - chainLength(p));
    if (!chains.length) return { profile: [], chains: [], all, warnings: warnings.concat(['No usable geometry found.']) };
    const idx = Math.min(opts.chainIndex || 0, chains.length - 1);
    let chain = chains[idx];
    if (chain[0].a.z < chain[chain.length - 1].b.z) chain = chain.slice().reverse().map(reverseSeg);
    const profile = [];
    chain.forEach((g, i) => {
      const seg = g.type === 'arc' ? { type: 'arc', r: round(g.r), ccw: g.ccw } : { type: 'line' };
      profile.push({ z: round(g.a.z), x: round(Math.max(0, g.a.x)), seg });
      if (i === chain.length - 1) profile.push({ z: round(g.b.z), x: round(Math.max(0, g.b.x)), seg: { type: 'line' } });
    });
    if (chains.length > 1) warnings.push('Drawing contains ' + chains.length + ' separate chains; the longest one was used. Pick another one in the import dialog if needed.');
    if (profile.some(p => p.x < 0)) warnings.push('Some points are below the centreline.');
    return { profile, chains, all, warnings };
  }

  function round(v) { return Math.round(v * 1000) / 1000; }

  global.DXF = { parse, suggestMapping, toProfile, mapEntities, chainSegments, chainLength };
})(typeof window !== 'undefined' ? window : globalThis);
