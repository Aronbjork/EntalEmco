/* cam.js — turns the stock + profile + operations into Emco blocks.
 * All geometry in mm with X as RADIUS; blocks get X as diameter in 1/100 mm.
 */
(function (global) {
  'use strict';
  const GRID = 0.02;          // z resolution of the material envelope (mm)

  const OP_DEFS = {
    face:   { label: 'Facing',           icon: '▭', defaults: { zStart: 1.0, zEnd: 0, doc: 0.5, feed: 100, xEnd: 0 } },
    rough:  { label: 'Rough turning',    icon: '≡', defaults: { doc: 1.0, allowX: 0.3, allowZ: 0.1, feed: 150, retract: 0.7, zEnd: null, arcsAsLines: false } },
    finish: { label: 'Finish contour',   icon: '∿', defaults: { feed: 50, retract: 0.7, arcsAsLines: false, arcTol: 0.01 } },
    groove: { label: 'Groove',           icon: '⊔', defaults: { z: -10, width: 3, dia: 10, toolWidth: 2, toolRef: 'right', feed: 30, dwell: 0, stepFactor: 0.75 } },
    part:   { label: 'Parting off',      icon: '⟂', defaults: { z: -40, toolWidth: 2, toolRef: 'right', finalDia: 0, feed: 25, dwell: 0 } },
    drill:  { label: 'Centre drilling',  icon: '⌀', defaults: { depth: 10, peck: 3, feed: 40, zTop: 0, retract: 0.5 } },
    thread: { label: 'Thread (G33)',     icon: '⌇', defaults: { dia: 10, pitch: 1.0, zStart: 2, zEnd: -15, depth: 0.61, passes: 6 } },
    tool:   { label: 'Tool change',      icon: '⚒', defaults: { tool: 1, dx: 0, dz: 0, pause: true } },
    custom: { label: 'Custom blocks',    icon: '✎', defaults: { text: 'G00 X2700 Z100' } }
  };

  function newOp(type) {
    const d = OP_DEFS[type];
    return Object.assign({ id: 'op' + Math.random().toString(36).slice(2, 8), type, name: d.label, enabled: true }, JSON.parse(JSON.stringify(d.defaults)));
  }

  /* ---------- emitter ---------- */
  class Emitter {
    constructor(ctx) {
      this.ctx = ctx; this.blocks = []; this.warnings = [];
      this.pos = { z: ctx.start.z, x: ctx.start.x };
      this.safeX = ctx.stock.diameter / 2 + ctx.clearX;
      this.env = ctx.env;            // raw material envelope for safe travel checks
    }
    dia(x) { return Math.round(x * 200); }
    zz(z) { return Math.round(z * 100); }
    _setPos(x, z) { this.pos = { z: this.zz(z) / 100, x: this.dia(x) / 200 }; }
    comment(t) { this.blocks.push({ comment: t }); }
    raw(b) { this.blocks.push(b); }
    rapid(x, z) { if (Math.abs(x - this.pos.x) < 0.0049 && Math.abs(z - this.pos.z) < 0.0049) return; this.blocks.push({ g: 0, x: this.dia(x), z: this.zz(z) }); this._setPos(x, z); }
    feed(x, z, f) { this.blocks.push({ g: 1, x: this.dia(x), z: this.zz(z), f: Math.round(f) }); this._setPos(x, z); }
    /** Arc from the current position to (x,z) with radius r. Splits at quadrant boundaries and emits G02/G03 + M99 I K. */
    arc(x, z, r, ccw, f, asLines, tol) {
      const arc = Geom.arcFromEndpoints(this.pos, { z, x }, r, ccw);
      if (!arc) { this.warnings.push('Arc to X' + (x * 2).toFixed(2) + ' Z' + z.toFixed(2) + ' is impossible with radius ' + r + '; a straight line was used.'); this.feed(x, z, f); return; }
      if (asLines) { const pts = Geom.sampleArc(arc, tol || 0.01); for (let i = 1; i < pts.length; i++) this.feed(pts[i].x, pts[i].z, f); return; }
      for (const sub of Geom.splitArcQuadrants(arc)) {
        const I = Math.round(Math.abs(sub.start.x - sub.cx) * 100), K = Math.round(Math.abs(sub.start.z - sub.cz) * 100);
        this.blocks.push({ g: ccw ? 3 : 2, x: this.dia(sub.end.x), z: this.zz(sub.end.z), f: Math.round(f) });
        this.blocks.push({ m: 99, i: I, k: K });
        this._setPos(sub.end.x, sub.end.z);
      }
    }
    /** Is a Z move at radius x between z1 and z2 free of material (using the raw envelope)? */
    zPathClear(x, z1, z2) {
      const E = this.env; if (!E) return x >= this.safeX - 1e-9;
      const lo = Math.min(z1, z2), hi = Math.max(z1, z2);
      let i0 = Math.max(0, Math.floor((lo - E.z0) / E.dz)), i1 = Math.min(E.env.length - 1, Math.ceil((hi - E.z0) / E.dz));
      if (hi > E.z0 + (E.env.length - 1) * E.dz + 1e-9 && x < this.safeX - 1e-9 && lo < E.z0 + (E.env.length - 1) * E.dz) { /* partly outside grid toward +Z: stock front is air */ }
      if (lo < E.z0 - 1e-9) return false;                 // beyond the -Z end of the grid: unknown → unsafe
      for (let i = i0; i <= i1; i++) if (!(E.env[i] < x - 1e-6)) return false;
      return true;
    }
    /** Rapid to (x,z) without ploughing through material. */
    travel(x, z) {
      const cur = this.pos;
      if (x > cur.x + 1e-9) {                               // going outward: X first is always safe
        this.rapid(x, cur.z);
        if (this.zPathClear(x, cur.z, z) || x >= this.safeX - 1e-9) { this.rapid(x, z); return; }
        this.rapid(this.safeX, cur.z); this.rapid(this.safeX, z); this.rapid(x, z); return;
      }
      if (this.zPathClear(cur.x, cur.z, z) || cur.x >= this.safeX - 1e-9) { this.rapid(cur.x, z); this.rapid(x, z); return; }
      this.rapid(this.safeX, cur.z); this.rapid(this.safeX, z); this.rapid(x, z);
    }
    retractSafe() { if (this.pos.x < this.safeX - 1e-9) this.rapid(this.safeX, this.pos.z); }
  }

  /* ---------- operations ---------- */
  const GEN = {};

  GEN.face = (em, op, ctx) => {
    const R0 = ctx.stock.diameter / 2, clearX = ctx.clearX, clearZ = ctx.clearZ;
    const zStart = num(op.zStart, 1), zEnd = num(op.zEnd, 0), doc = Math.max(0.05, num(op.doc, 0.5)), xEnd = Math.max(0, num(op.xEnd, 0)) / 2;
    if (zStart <= zEnd) { em.warnings.push('Facing: start Z must be in front of (greater than) end Z.'); return; }
    const passes = []; for (let z = zStart - doc; z > zEnd + 1e-6; z -= doc) passes.push(z); passes.push(zEnd);
    em.retractSafe();
    for (const z of passes) {
      em.rapid(R0 + clearX, z + clearZ);
      em.rapid(R0 + clearX, z);
      em.feed(xEnd, z, op.feed);
      em.rapid(xEnd, z + clearZ);
      em.rapid(R0 + clearX, z + clearZ);
    }
  };

  GEN.rough = (em, op, ctx) => {
    const R0 = ctx.stock.diameter / 2, clearX = ctx.clearX, clearZ = ctx.clearZ;
    const poly = ctx.poly; if (poly.length < 2) { em.warnings.push('Rough turning: draw a profile first.'); return; }
    const bb = Geom.bbox(poly);
    const zHigh = Math.max(ctx.stock.zFront, bb.zmax);
    const zLow = op.zEnd != null && op.zEnd !== '' ? Math.max(num(op.zEnd, bb.zmin), bb.zmin - 1e-9) : bb.zmin;
    const doc = Math.max(0.05, num(op.doc, 1)), allowX = Math.max(0, num(op.allowX, 0)), allowZ = Math.max(0, num(op.allowZ, 0));
    const E = Geom.dilateEnvelope(Geom.envelope(poly, zLow, zHigh, GRID), allowX, allowZ);
    const n = E.env.length, zAt = i => E.z0 + i * E.dz;
    let minEnv = Infinity; for (let i = 0; i < n; i++) if (E.env[i] < minEnv) minEnv = E.env[i];
    if (!(minEnv < R0 - 1e-6)) { em.warnings.push('Rough turning: nothing to remove (profile is not smaller than the stock).'); return; }
    const passes = []; for (let r = R0 - doc; r > minEnv + 1e-6; r -= doc) passes.push(r); passes.push(Math.max(0, minEnv));
    const step = Math.min(doc, Math.max(0.1, num(op.retract, 0.7)));
    const zApproach = zHigh + clearZ;
    em.retractSafe();
    em.travel(R0 + clearX, zApproach);
    let prevR = R0;
    for (const r of passes) {
      // runs of z (descending) where the dilated envelope is at or below r
      const runs = []; let i = n - 1;
      while (i >= 0) {
        if (E.env[i] <= r + 1e-9) { const top = i; while (i - 1 >= 0 && E.env[i - 1] <= r + 1e-9) i--; runs.push({ top, bot: i }); }
        i--;
      }
      for (const run of runs) {
        const topOpen = run.top === n - 1;
        const zA = zAt(run.top), zB = zAt(run.bot);
        if (!topOpen && zA - zB < 3 * GRID) continue;                      // too narrow to be worth a pass
        const entryZ = topOpen ? zApproach : zA;
        const entryX = topOpen ? r : Math.min(prevR + 0.1, R0 + clearX);
        em.travel(entryX, entryZ);
        if (!topOpen) em.feed(r, zA, op.feed);                              // plunge down the wall
        em.feed(r, zB, op.feed);
        const room = topOpen ? step : Math.min(step, zA - zB);
        if (room >= 0.05) em.feed(r + room, zB + room, op.feed);            // 45° pull-out into already-cut material
        else em.rapid(r + step, zB);
      }
      prevR = r;
    }
    em.retractSafe();
    em.rapid(em.safeX, zApproach);
  };

  GEN.finish = (em, op, ctx) => {
    const profile = ctx.profile; if (profile.length < 2) { em.warnings.push('Finish: draw a profile first.'); return; }
    const bb = Geom.bbox(ctx.poly); const clearZ = ctx.clearZ;
    const p0 = profile[0];
    em.retractSafe();
    em.travel(p0.x, Math.max(ctx.stock.zFront, bb.zmax) + clearZ);
    em.feed(p0.x, p0.z, op.feed);
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1], b = profile[i], seg = a.seg || { type: 'line' };
      if (seg.type === 'arc') em.arc(b.x, b.z, seg.r, !!seg.ccw, op.feed, !!op.arcsAsLines, num(op.arcTol, 0.01));
      else em.feed(b.x, b.z, op.feed);
    }
    const pe = profile[profile.length - 1]; const step = Math.max(0.1, num(op.retract, 0.7));
    em.feed(pe.x + step, pe.z + step, op.feed);
    em.retractSafe();
  };

  GEN.groove = (em, op, ctx) => {
    const R0 = ctx.stock.diameter / 2, clearX = ctx.clearX;
    const zR = num(op.z, 0), w = Math.max(0.1, num(op.width, 1)), tw = Math.max(0.1, num(op.toolWidth, 1)), xb = Math.max(0, num(op.dia, 0)) / 2;
    if (tw > w + 1e-9) { em.warnings.push('Groove: tool is wider than the groove.'); return; }
    const first = op.toolRef === 'left' ? zR - tw : zR;                 // programmed point = tool's reference edge
    const last = op.toolRef === 'left' ? zR - w : zR - w + tw;
    const stepw = tw * Math.min(0.95, Math.max(0.3, num(op.stepFactor, 0.75)));
    const positions = []; for (let z = first; z > last + 1e-6; z -= stepw) positions.push(z); positions.push(last);
    em.retractSafe();
    for (const z of positions) {
      em.rapid(R0 + clearX, z);
      em.feed(xb, z, op.feed);
      if (num(op.dwell, 0) > 0 && ctx.controller.dwell) em.raw({ g: 4, x: Math.round(num(op.dwell, 0) * 100) });
      em.rapid(R0 + clearX, z);
    }
  };

  GEN.part = (em, op, ctx) => {
    const R0 = ctx.stock.diameter / 2, clearX = ctx.clearX;
    const z = op.toolRef === 'left' ? num(op.z, 0) : num(op.z, 0) + num(op.toolWidth, 2);   // left tool edge cuts the part's end face at op.z
    em.retractSafe();
    em.rapid(R0 + clearX, z);
    em.feed(Math.max(0, num(op.finalDia, 0)) / 2, z, op.feed);
    if (num(op.dwell, 0) > 0 && ctx.controller.dwell) em.raw({ g: 4, x: Math.round(num(op.dwell, 0) * 100) });
    em.rapid(R0 + clearX, z);
  };

  GEN.drill = (em, op, ctx) => {
    const clearZ = ctx.clearZ, zTop = num(op.zTop, 0), depth = Math.max(0.1, num(op.depth, 5)), peck = num(op.peck, 0);
    em.retractSafe();
    em.travel(0, Math.max(ctx.stock.zFront, zTop) + clearZ);
    const zSafe = zTop + clearZ;
    em.rapid(0, zSafe);
    let d = 0;
    while (d < depth - 1e-9) {
      const next = peck > 0 ? Math.min(depth, d + peck) : depth;
      if (d > 0) em.rapid(0, zTop - d + Math.min(num(op.retract, 0.5), d));
      em.feed(0, zTop - next, op.feed);
      em.rapid(0, zSafe);
      d = next;
    }
  };

  GEN.thread = (em, op, ctx) => {
    const clearX = ctx.clearX, R = num(op.dia, 10) / 2, pitch = num(op.pitch, 1), depth = Math.max(0.05, num(op.depth, 0.6)), passes = Math.max(1, Math.round(num(op.passes, 5)));
    const zS = num(op.zStart, 2), zE = num(op.zEnd, -10);
    em.retractSafe();
    em.warnings.push('Thread: G33 needs the threading option on the lathe. The K (pitch) field layout is unverified; compare with a thread program from your machine before running it.');
    for (let i = 1; i <= passes; i++) {
      const x = R - depth * Math.sqrt(i / passes);
      em.travel(R + clearX, zS);
      em.rapid(x, zS);
      em.raw({ g: 33, z: em.zz(zE), kf: Math.round(pitch * 100) }); em._setPos(x, zE);
      em.rapid(R + clearX, zE);
      em.rapid(R + clearX, zS);
    }
  };

  GEN.tool = (em, op, ctx) => {
    em.retractSafe();
    em.rapid(em.safeX, ctx.start.z);
    if (op.pause) em.raw(Object.assign({}, ctx.controller.pause));
    if (ctx.controller.toolChange === 'M06') em.raw({ m: 6, x: Math.round(num(op.dx, 0) * 100), z: Math.round(num(op.dz, 0) * 100), t: Math.round(num(op.tool, 1)) });
    else em.raw({ g: 26, x: Math.round(num(op.dx, 0) * 100), z: Math.round(num(op.dz, 0) * 100), t: Math.round(num(op.tool, 1)) });
    em.warnings.push('Tool change: the M06/G26 offset block layout is unverified on your machine.');
  };

  GEN.custom = (em, op) => {
    for (const line of String(op.text || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const b = Emco.parseFreeLine(line);
      if (!b) { em.warnings.push('Custom block ignored (unreadable): "' + line + '"'); continue; }
      em.raw(b);
      if (b.g === 0 || b.g === 1) { const x = b.x != null ? b.x / 200 : em.pos.x, z = b.z != null ? b.z / 100 : em.pos.z; em._setPos(x, z); }
    }
  };

  function num(v, d) { const n = parseFloat(v); return isNaN(n) ? d : n; }

  /** Build the whole program. Returns { blocks, warnings }. */
  function buildProgram(project) {
    const stock = project.stock, settings = project.settings;
    const controller = Emco.CONTROLLERS[settings.controller] || Emco.CONTROLLERS.MK4;
    const profile = (project.profile || []).map(p => ({ z: num(p.z, 0), x: num(p.x, 0), seg: p.seg || { type: 'line' } }));
    const poly = Geom.profileToPolyline(profile, 0.005);
    const warnings = Geom.validateProfile(profile);
    const clearX = num(settings.clearX, 1), clearZ = num(settings.clearZ, 1);
    const start = { x: num(settings.startDia, stock.diameter + 2 * clearX) / 2, z: num(settings.startZ, num(stock.zFront, 0) + clearZ) };
    const bb = poly.length ? Geom.bbox(poly) : { zmin: -10, zmax: 0 };
    const zHigh = Math.max(num(stock.zFront, 0), bb.zmax) + clearZ + 5;
    const env = poly.length > 1 ? Geom.envelope(poly, bb.zmin, zHigh, GRID) : null;
    const ctx = { stock: Object.assign({}, stock, { zFront: num(stock.zFront, 0) }), profile, poly, env, clearX, clearZ, start, controller, settings };
    const em = new Emitter(ctx);
    em.raw({ g: 92, x: em.dia(start.x), z: em.zz(start.z) });
    if (settings.spindle && controller.spindleOn) em.raw(Object.assign({}, controller.spindleOn));
    for (const op of project.ops || []) {
      if (!op.enabled) continue;
      const gen = GEN[op.type]; if (!gen) continue;
      em.comment(op.name || OP_DEFS[op.type].label);
      const before = em.blocks.length;
      try { gen(em, op, ctx); } catch (e) { em.warnings.push((op.name || op.type) + ': ' + e.message); }
      if (em.blocks.length === before) em.blocks.pop();
    }
    em.comment('Return to start');
    em.retractSafe();
    em.rapid(em.safeX, start.z);
    em.rapid(start.x, start.z);
    if (settings.spindle && controller.spindleOff) em.raw(Object.assign({}, controller.spindleOff));
    em.raw(Object.assign({}, controller.endBlock));
    const blocks = Emco.number(em.blocks);
    return { blocks, warnings: warnings.concat(em.warnings, Emco.checkProgram(blocks, settings.controller)) };
  }

  global.CAM = { OP_DEFS, newOp, buildProgram, GRID };
})(typeof window !== 'undefined' ? window : globalThis);
