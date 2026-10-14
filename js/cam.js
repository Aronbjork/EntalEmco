/* cam.js — turns stock + profile + operations into Emco blocks.
 *
 * All geometry here is in millimetres with X as RADIUS. The Emitter converts to
 * machine units (X as diameter in 1/100 mm) when it creates blocks.
 *
 * SAFETY MODEL
 *   The only thing the generator knows about the material is the ENVELOPE of the
 *   finished profile (see geom.js). Every rapid move is checked against it: a Z move
 *   at radius x is only allowed where the envelope is below x; otherwise the tool first
 *   retracts to the safe radius (stock radius + clearance). Nothing is known about
 *   what previous operations have already removed, so the checks are conservative:
 *   they may add a retract that was not strictly necessary, but never a collision
 *   with the finished part. Collisions with un-roughed STOCK are avoided by convention:
 *   every operation starts and ends at the safe radius or in front of the stock.
 */
(function (global) {
  'use strict';
  const GRID = 0.02;          // z resolution of the material envelope (mm)

  /** Operation catalogue: label, icon and default parameters for the UI. */
  const OP_DEFS = {
    face:   { label: 'Facing',           icon: '▭', defaults: { zStart: 1.0, zEnd: 0, doc: 0.5, feed: 100, xEnd: 0 } },
    rough:  { label: 'Rough turning',    icon: '≡', defaults: { doc: 1.0, allowX: 0.3, allowZ: 0.1, feed: 150, retract: 0.7, zEnd: null, arcsAsLines: false } },
    finish: { label: 'Finish contour',   icon: '∿', defaults: { feed: 50, retract: 0.7, arcsAsLines: false, arcTol: 0.01 } },
    groove: { label: 'Groove',           icon: '⊔', defaults: { z: -10, width: 3, dia: 10, toolWidth: 2, toolRef: 'right', feed: 30, dwell: 0, stepFactor: 0.75 } },
    part:   { label: 'Parting off',      icon: '⟂', defaults: { z: -40, toolWidth: 2, toolRef: 'right', finalDia: 0, feed: 25, dwell: 0 } },
    drill:  { label: 'Centre drilling',  icon: '⌀', defaults: { dia: 3, depth: 10, peck: 3, feed: 40, zTop: 0, retract: 0.5, manual: true } },
    thread: { label: 'Thread (G33)',     icon: '⌇', defaults: { dia: 10, pitch: 1.0, zStart: 2, zEnd: -15, depth: 0.61, passes: 6 } },
    tool:   { label: 'Tool change',      icon: '⚒', defaults: { tool: 1, dx: 0, dz: 0, pause: true } },
    custom: { label: 'Custom blocks',    icon: '✎', defaults: { text: 'G00 X2700 Z100' } }
  };

  /**
   * Create a new operation object of the given type with default parameters and a
   * unique id. When cutting data `cd` (from cuttingData()) is given, feeds, depth of
   * cut, allowance and peck are taken from it instead of the generic defaults.
   */
  function newOp(type, cd) {
    const d = OP_DEFS[type];
    const op = Object.assign({ id: 'op' + Math.random().toString(36).slice(2, 8), type, name: d.label, enabled: true }, JSON.parse(JSON.stringify(d.defaults)));
    if (cd) applyCutting(op, cd);
    return op;
  }

  /* ---------- cutting data ----------
   * Starting values for a 440 W bench lathe (Compact 5: 50–3200 rpm by belt, feed in
   * mm/min, rapid about 700 mm/min). They are deliberately on the gentle side; raise
   * them once the machine and tooling are known to cope. Feeds are per revolution and
   * get multiplied by the spindle speed; vc is the surface speed in m/min.
   *   fRough/fFinish  turning feed (mm/rev)        doc      radial depth of cut (mm)
   *   allowX          finish allowance (mm)        fDrill   drill feed (mm/rev)
   *   peck            peck depth as a multiple of the drill diameter
   *   fGroove/fPart   plunge feeds (mm/rev)
   */
  const MATERIALS = {
    alu:       { label: 'Aluminium alloy (6082 / 6061 / 2007)', vc: { hss: 120, carbide: 250 }, fRough: 0.07, fFinish: 0.03, doc: 1.0, allowX: 0.3, fDrill: 0.04, peck: 1.0, fGroove: 0.035, fPart: 0.025,
      notes: 'A sharp, polished edge and a drop of WD-40 or paraffin stop the chip welding to the tool. Emco\'s own chess-set programs ran 1 mm cuts at F150 with 2300 rpm in aluminium.' },
    aluSoft:   { label: 'Aluminium, soft / pure (1050 / 1100)', vc: { hss: 100, carbide: 200 }, fRough: 0.06, fFinish: 0.03, doc: 0.8, allowX: 0.3, fDrill: 0.05, peck: 0.75, fGroove: 0.03, fPart: 0.025,
      notes: 'Gummy: keep the tool very sharp, use lubricant, and avoid dwelling at the bottom of grooves.' },
    brass:     { label: 'Brass (CuZn39Pb3 / 360)', vc: { hss: 90, carbide: 200 }, fRough: 0.08, fFinish: 0.04, doc: 1.0, allowX: 0.25, fDrill: 0.05, peck: 1.0, fGroove: 0.04, fPart: 0.03,
      notes: 'Zero or slightly negative rake stops the tool grabbing. Drills grab too, so keep pecking and dull the drill\'s cutting edges slightly.' },
    freeSteel: { label: 'Free-cutting steel (11SMn30 / 12L14)', vc: { hss: 35, carbide: 120 }, fRough: 0.06, fFinish: 0.03, doc: 0.5, allowX: 0.2, fDrill: 0.04, peck: 0.5, fGroove: 0.025, fPart: 0.02,
      notes: 'Cutting oil helps. Keep the finish feed at 0.03 mm/rev or more; slower only rubs and glazes the surface.' },
    mildSteel: { label: 'Mild steel (S235 / 1018)', vc: { hss: 25, carbide: 100 }, fRough: 0.05, fFinish: 0.025, doc: 0.4, allowX: 0.2, fDrill: 0.03, peck: 0.5, fGroove: 0.02, fPart: 0.015,
      notes: 'The 440 W motor is the limit: take more passes rather than deeper ones, and listen for the motor slowing down.' },
    stainless: { label: 'Stainless steel (303 / 304)', vc: { hss: 18, carbide: 80 }, fRough: 0.05, fFinish: 0.03, doc: 0.3, allowX: 0.2, fDrill: 0.03, peck: 0.4, fGroove: 0.02, fPart: 0.015,
      notes: 'Work-hardens: never let the tool rub, keep the feed up and every pass cutting. 303 is fine on this lathe, 304 is marginal.' },
    pom:       { label: 'POM / Delrin / acetal', vc: { hss: 150, carbide: 300 }, fRough: 0.10, fFinish: 0.05, doc: 1.5, allowX: 0.3, fDrill: 0.08, peck: 1.5, fGroove: 0.05, fPart: 0.04,
      notes: 'Sharp HSS gives the best finish; no coolant needed. Chips come off in long strings, keep them away from the chuck.' },
    acrylic:   { label: 'Acrylic / PMMA / polycarbonate', vc: { hss: 100, carbide: 200 }, fRough: 0.06, fFinish: 0.03, doc: 0.8, allowX: 0.3, fDrill: 0.05, peck: 1.0, fGroove: 0.03, fPart: 0.025,
      notes: 'Melts when the chip cannot escape: peck drilling and an air blast help. A slow finish feed gives a clear surface.' },
    nylon:     { label: 'Nylon / PA6', vc: { hss: 120, carbide: 250 }, fRough: 0.10, fFinish: 0.05, doc: 1.0, allowX: 0.3, fDrill: 0.08, peck: 1.0, fGroove: 0.04, fPart: 0.03,
      notes: 'Very sharp tool; nylon pushes away from a dull edge and springs back. A light spring pass improves the diameter.' }
  };
  const RPM_MIN = 50, RPM_MAX = 3200, FEED_MIN = 2, FEED_MAX = 400;

  /** Spindle speed (rpm) for a surface speed vc (m/min) on diameter D (mm), clamped to the lathe's range. */
  function suggestRpm(vc, D) {
    if (!(D > 0)) return RPM_MAX;
    return Math.round(Math.min(RPM_MAX, Math.max(RPM_MIN, vc * 1000 / (Math.PI * D))) / 10) * 10;
  }
  /** mm/rev × rpm → mm/min, clamped to what the Compact 5 accepts and rounded to a tidy value. */
  function feedMmMin(fRev, rpm) {
    const f = fRev * rpm;
    const r = f >= 60 ? Math.round(f / 10) * 10 : f >= 20 ? Math.round(f / 5) * 5 : Math.round(f);
    return Math.min(FEED_MAX, Math.max(FEED_MIN, r));
  }
  /**
   * Compute concrete parameters for the project's cutting setup.
   *   cut = { material, tool: 'hss'|'carbide', rpm (null = use the suggested speed) }
   *   stockDia = stock diameter for the rpm suggestion, drillDia for the peck depth.
   */
  function cuttingData(cut, stockDia, drillDia) {
    cut = cut || {};
    const m = MATERIALS[cut.material] || MATERIALS.alu;
    const tool = cut.tool === 'hss' ? 'hss' : 'carbide';
    const vc = m.vc[tool];
    const rpmSuggested = suggestRpm(vc, stockDia);
    const rpm = cut.rpm > 0 ? cut.rpm : rpmSuggested;
    const dd = drillDia > 0 ? drillDia : 3;
    return {
      material: cut.material in MATERIALS ? cut.material : 'alu', label: m.label, tool, vc, rpmSuggested, rpm,
      doc: m.doc, allowX: m.allowX, allowZ: Math.min(0.1, m.allowX / 2),
      feedRough: feedMmMin(m.fRough, rpm), feedFinish: feedMmMin(m.fFinish, rpm), feedFace: feedMmMin(m.fRough * 0.8, rpm),
      feedDrill: feedMmMin(m.fDrill, rpm), peck: Math.round(m.peck * dd * 10) / 10, peckFactor: m.peck,
      feedGroove: feedMmMin(m.fGroove, rpm), feedPart: feedMmMin(m.fPart, rpm),
      fRough: m.fRough, fFinish: m.fFinish, fDrill: m.fDrill, fGroove: m.fGroove, fPart: m.fPart, notes: m.notes
    };
  }
  /** Write the cutting data into an operation (feeds, depth of cut, allowance, peck); geometry is left alone. */
  function applyCutting(op, cd) {
    switch (op.type) {
      case 'face': op.feed = cd.feedFace; op.doc = Math.max(0.2, cd.doc / 2); break;
      case 'rough': op.feed = cd.feedRough; op.doc = cd.doc; op.allowX = cd.allowX; op.allowZ = cd.allowZ; break;
      case 'finish': op.feed = cd.feedFinish; break;
      case 'groove': op.feed = cd.feedGroove; break;
      case 'part': op.feed = cd.feedPart; break;
      case 'drill': op.feed = cd.feedDrill; op.peck = Math.round(cd.peckFactor * (op.dia > 0 ? op.dia : 3) * 10) / 10; break;
      default: break;
    }
    return op;
  }

  /* ---------- tool library ----------
   * A tool is { id, number, name, type, size, dx, dz }: `number` is the T value written
   * to the tool-change block, `size` the width of a grooving / parting tool or the
   * diameter of a drill (mm), dx / dz the offsets of its tip from the tool that is
   * mounted when the program starts (mm). Every operation either names a tool
   * (op.toolId) or gets the first library tool of the kind it needs.
   */
  const TOOL_TYPES = { turn: 'Turning', groove: 'Grooving', part: 'Parting', drill: 'Drill', thread: 'Threading' };
  const OP_TOOL_TYPE = { face: 'turn', rough: 'turn', finish: 'turn', groove: 'groove', part: 'part', drill: 'drill', thread: 'thread' };
  /** A new library tool of the given type with a unique id. */
  function newTool(type, number, size) {
    type = type in TOOL_TYPES ? type : 'turn';
    return { id: 'tl' + Math.random().toString(36).slice(2, 8), number: number || 1, name: TOOL_TYPES[type] + (size ? ' ' + size + ' mm' : ''), type, size: size || 0, dx: 0, dz: 0 };
  }
  /** The starter set for a new project. */
  function defaultTools() { return [newTool('turn', 1, 0), newTool('groove', 2, 2), newTool('part', 3, 2), newTool('drill', 4, 3)]; }
  /** The library tool an operation runs with, or null (no tool change is made for it). */
  function toolForOp(op, tools) {
    if (!tools || !tools.length) return null;
    const named = op.toolId && tools.find(t => t.id === op.toolId); if (named) return named;
    const type = OP_TOOL_TYPE[op.type];
    return type ? tools.find(t => t.type === type) || null : null;
  }
  /**
   * Tool change: retract to the safe radius at the start Z. With the hand-changed
   * toolpost the spindle is stopped and the program pauses (M00 / G20) so the tool can
   * be swapped; with the automatic turret (settings.changer === 'turret') there is
   * nothing to wait for. Then the offset block (M06 on Mk4, G26 on Mk2) is written with
   * the station number and the offsets relative to the tool the program started with,
   * and the spindle is restarted if it was stopped.
   */
  function emitToolChange(em, ctx, tool, ref) {
    const c = ctx.controller, turret = ctx.settings.changer === 'turret', spin = ctx.settings.spindle && !turret;
    em.retractSafe();
    em.rapid(em.safeX, ctx.start.z);
    if (spin && c.spindleOff) em.raw(Object.assign({}, c.spindleOff));
    if (!turret) em.raw(Object.assign({}, c.pause));
    const dx = Math.round(((tool.dx || 0) - (ref.dx || 0)) * 100), dz = Math.round(((tool.dz || 0) - (ref.dz || 0)) * 100), t = Math.round(num(tool.number, 1));
    em.raw(c.toolChange === 'M06' ? { m: 6, x: dx, z: dz, t } : { g: 26, x: dx, z: dz, t });
    if (spin && c.spindleOn) em.raw(Object.assign({}, c.spindleOn));
  }

  /* ---------- emitter ---------- */

  /**
   * The Emitter collects blocks and tracks where the tool is. Operations call its
   * rapid / feed / arc / travel methods instead of writing blocks directly, so every
   * block gets consistent rounding and the position stays correct.
   *   ctx: { stock, profile, poly, env, clearX, clearZ, start, controller, settings }
   */
  class Emitter {
    constructor(ctx) {
      this.ctx = ctx; this.blocks = []; this.warnings = [];
      this.pos = { z: ctx.start.z, x: ctx.start.x };          // current tool position (mm, radius)
      this.safeX = ctx.stock.diameter / 2 + ctx.clearX;        // radius at which Z moves are always safe
      this.env = ctx.env;                                      // raw material envelope for safe-travel checks
      this.zMaterial = ctx.zMaterial;                          // everything at Z greater than this is air (in front of the stock)
    }
    /** mm radius → machine X (diameter in 1/100 mm). */
    dia(x) { return Math.round(x * 200); }
    /** mm → 1/100 mm. */
    zz(z) { return Math.round(z * 100); }
    /** Remember the position the machine will actually reach (after rounding). */
    _setPos(x, z) { this.pos = { z: this.zz(z) / 100, x: this.dia(x) / 200 }; }
    /** Insert a comment line (shown on screen, never sent). */
    comment(t) { this.blocks.push({ comment: t }); }
    /** Append a hand-made block without position tracking. */
    raw(b) { this.blocks.push(b); }
    /** G00 to (x, z). Skipped if the tool is already there. */
    rapid(x, z) { if (Math.abs(x - this.pos.x) < 0.0049 && Math.abs(z - this.pos.z) < 0.0049) return; this.blocks.push({ g: 0, x: this.dia(x), z: this.zz(z) }); this._setPos(x, z); }
    /** G01 to (x, z) at feed f (mm/min). */
    feed(x, z, f) { this.blocks.push({ g: 1, x: this.dia(x), z: this.zz(z), f: Math.round(f) }); this._setPos(x, z); }
    /**
     * Arc from the current position to (x, z) with radius r. Splits at quadrant
     * boundaries and emits G02/G03 + M99 I K per piece. With asLines the arc is sent as
     * short G01 segments instead (for Mk1/Mk2 controllers with fixed-radius arcs).
     */
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
    /**
     * True if a Z move at radius x between z1 and z2 stays above the finished profile
     * everywhere. The region in front of the stock (Z > zMaterial) is always air, so a
     * move there is clear even at X = 0 (a drill on the centreline).
     */
    zPathClear(x, z1, z2) {
      const lo = Math.min(z1, z2), hi = Math.max(z1, z2);
      if (lo >= this.zMaterial - 1e-6) return true;        // whole path at or in front of the face plane: air
      const E = this.env; if (!E) return x >= this.safeX - 1e-9;
      const i0 = Math.max(0, Math.floor((lo - E.z0) / E.dz)), i1 = Math.min(E.env.length - 1, Math.ceil((hi - E.z0) / E.dz));
      if (lo < E.z0 - 1e-9) return false;                 // beyond the -Z end of the grid: unknown → unsafe
      for (let i = i0; i <= i1; i++) {
        if (E.z0 + i * E.dz >= this.zMaterial - 1e-6) continue;
        if (!(E.env[i] < x - 1e-6)) return false;
      }
      return true;
    }
    /**
     * Rapid to (x, z) without ploughing through the finished part.
     * Going outward in X is always safe, so that is done first. The Z move is then made
     * at the larger of the two radii if the envelope allows it; otherwise the tool goes
     * out to the safe radius, moves in Z there, and comes back down.
     */
    travel(x, z) {
      const cur = this.pos;
      if (x > cur.x + 1e-9) {
        this.rapid(x, cur.z);
        if (this.zPathClear(x, cur.z, z) || x >= this.safeX - 1e-9) { this.rapid(x, z); return; }
        this.rapid(this.safeX, cur.z); this.rapid(this.safeX, z); this.rapid(x, z); return;
      }
      if (this.zPathClear(cur.x, cur.z, z) || cur.x >= this.safeX - 1e-9) { this.rapid(cur.x, z); this.rapid(x, z); return; }
      this.rapid(this.safeX, cur.z); this.rapid(this.safeX, z); this.rapid(x, z);
    }
    /** Rapid straight out to the safe radius if not already there. */
    retractSafe() { if (this.pos.x < this.safeX - 1e-9) this.rapid(this.safeX, this.pos.z); }
  }

  /* ---------- operations ---------- */
  const GEN = {};

  /**
   * FACING: cut the end of the bar flat. Passes start at zStart (front of the extra
   * material) and step toward zEnd (the finished face). Each pass: rapid to the safe
   * radius just in front of the pass, drop to the pass Z, feed in to the centre (xEnd),
   * back off in Z, rapid out again.
   */
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

  /**
   * ROUGH TURNING: remove the bulk of the material with passes parallel to Z.
   *
   * 1. Build the envelope of the profile on a fine Z grid and grow it by the finish
   *    allowance. Everything above the grown envelope may be cut.
   * 2. Pass radii go from (stock radius − doc) downward in steps of doc; the last pass
   *    is at the smallest envelope value so the deepest region is reached.
   * 3. For each pass radius r, find the RUNS of Z where the envelope is ≤ r. A run that
   *    starts at the front of the stock is entered from the air; a run that starts at a
   *    shoulder is entered from above (rapid down to the previous pass level, then feed
   *    the last bit down the wall). The tool then feeds along Z to the end of the run.
   * 4. The pull-out is a 45° move toward +X/+Z into material that this pass has just
   *    removed, exactly as the original Emco sample programs do. If the run is too
   *    short for that, the tool retracts radially instead.
   * The result leaves a staircase of at most one depth-of-cut plus allowance for the
   * finish pass.
   */
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
      // runs of grid indices (scanned from +Z to -Z) where the grown envelope is at or below r
      const runs = []; let i = n - 1;
      while (i >= 0) {
        if (E.env[i] <= r + 1e-9) { const top = i; while (i - 1 >= 0 && E.env[i - 1] <= r + 1e-9) i--; runs.push({ top, bot: i }); }
        i--;
      }
      for (const run of runs) {
        const topOpen = run.top === n - 1;                                   // run starts at the front of the stock
        const zA = zAt(run.top), zB = zAt(run.bot);
        if (!topOpen && zA - zB < 3 * GRID) continue;                      // too narrow to be worth a pass
        const entryZ = topOpen ? zApproach : zA;
        const entryX = topOpen ? r : Math.min(prevR + 0.1, R0 + clearX);    // shoulder: come down from the previous pass level
        em.travel(entryX, entryZ);
        if (!topOpen) em.feed(r, zA, op.feed);                              // plunge the last bit down the wall
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

  /**
   * FINISH CONTOUR: one pass exactly along the profile. The tool approaches the first
   * point from in front of the stock at the first point's radius, feeds onto it, then
   * follows every segment with G01 or G02/G03 (+ M99). At the end it pulls out at 45°
   * and retracts to the safe radius. Tool nose radius is NOT compensated.
   */
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

  /**
   * GROOVE: repeated plunges with a grooving tool. The groove spans from op.z (its +Z
   * edge) to op.z − width. The programmed point of the tool is one of its edges
   * (toolRef), so the plunge positions are offset accordingly; plunges step by a
   * fraction of the tool width and the last one is placed exactly at the far wall.
   * An optional dwell (G04) at the bottom cleans up the diameter on Mk4 controllers.
   */
  GEN.groove = (em, op, ctx) => {
    const R0 = ctx.stock.diameter / 2, clearX = ctx.clearX;
    const zR = num(op.z, 0), w = Math.max(0.1, num(op.width, 1)), tw = Math.max(0.1, num(op.toolWidth, 1)), xb = Math.max(0, num(op.dia, 0)) / 2;
    if (tw > w + 1e-9) { em.warnings.push('Groove: tool is wider than the groove.'); return; }
    const first = op.toolRef === 'left' ? zR - tw : zR;
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

  /**
   * PARTING OFF: one plunge that separates the part. op.z is the finished end face of
   * the part. The slot lies behind it (toward the chuck, −Z): with the tool's right
   * (+Z) edge programmed the plunge is at op.z, with the left (−Z) edge it is shifted
   * by the tool width, so the part keeps its full length. finalDia 0 cuts to the centre.
   */
  GEN.part = (em, op, ctx) => {
    const R0 = ctx.stock.diameter / 2, clearX = ctx.clearX;
    const z = op.toolRef === 'left' ? num(op.z, 0) - num(op.toolWidth, 2) : num(op.z, 0);
    em.retractSafe();
    em.rapid(R0 + clearX, z);
    em.feed(Math.max(0, num(op.finalDia, 0)) / 2, z, op.feed);
    if (num(op.dwell, 0) > 0 && ctx.controller.dwell) em.raw({ g: 4, x: Math.round(num(op.dwell, 0) * 100) });
    em.rapid(R0 + clearX, z);
  };

  /**
   * CENTRE DRILLING: a drill in the tool holder. Pecks `peck` mm at a time with a full
   * retract to the clearance position after each peck and a rapid back to just above
   * the previous depth (retract gap) before the next one.
   *
   * Two ways to get the drill onto the centreline:
   *   manual = true  The drill was centred BY HAND before START and the program start
   *                  position is X Ø0. The operation then moves in Z only and never
   *                  touches X, so the drill stays exactly where you put it. This is
   *                  the normal way on a Compact 5 without tool offsets.
   *   manual = false The drill shares the X zero of the turning tool (e.g. after a
   *                  Tool change block with offsets): the tool first retracts to the
   *                  safe radius, moves in front of the stock and rapids to X = 0.
   */
  GEN.drill = (em, op, ctx) => {
    const clearZ = ctx.clearZ, zTop = num(op.zTop, 0), depth = Math.max(0.1, num(op.depth, 5)), peck = num(op.peck, 0);
    const zSafe = zTop + clearZ;
    let x;
    if (op.manual !== false) {
      x = em.pos.x;
      if (Math.abs(x) > 0.005) em.warnings.push('Centre drilling: the drill is centred by hand, but the tool is at Ø' + (x * 2).toFixed(2) + ' when the operation starts. Set the start position X to Ø0 (Setup tab) or put a Tool change before it.');
      if (em.pos.z < zSafe - 1e-9) em.warnings.push('Centre drilling: the tool starts at Z' + em.pos.z.toFixed(2) + ', behind the drilling start. It is moved straight to Z' + zSafe.toFixed(2) + ' in Z only.');
      em.rapid(x, zSafe);
    } else {
      x = 0;
      em.retractSafe();
      em.travel(0, Math.max(ctx.stock.zFront, zTop) + clearZ);
      em.rapid(0, zSafe);
    }
    let d = 0;
    while (d < depth - 1e-9) {
      const next = peck > 0 ? Math.min(depth, d + peck) : depth;
      if (d > 0) em.rapid(x, zTop - d + Math.min(num(op.retract, 0.5), d));
      em.feed(x, zTop - next, op.feed);
      em.rapid(x, zSafe);
      d = next;
    }
  };

  /**
   * THREAD (G33): several spindle-synchronised passes. The infeed follows a square-root
   * law so every pass removes a similar chip area. Each pass: rapid to the start Z in
   * the air, down to the pass diameter, G33 to the end Z with the pitch in the K field,
   * rapid out and back. Requires the lathe's threading option; the K layout is unverified.
   */
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

  /**
   * TOOL CHANGE: retract to the safe radius at the start Z, optionally pause (M00 /
   * G20) so the tool can be swapped by hand, then write the offset block
   * (M06 on Mk4, G26 on Mk2) with the X/Z offsets and tool number. Layout unverified.
   */
  GEN.tool = (em, op, ctx) => {
    em.retractSafe();
    em.rapid(em.safeX, ctx.start.z);
    if (op.pause) em.raw(Object.assign({}, ctx.controller.pause));
    if (ctx.controller.toolChange === 'M06') em.raw({ m: 6, x: Math.round(num(op.dx, 0) * 100), z: Math.round(num(op.dz, 0) * 100), t: Math.round(num(op.tool, 1)) });
    else em.raw({ g: 26, x: Math.round(num(op.dx, 0) * 100), z: Math.round(num(op.dz, 0) * 100), t: Math.round(num(op.tool, 1)) });
    em.warnings.push('Tool change: the M06/G26 offset block layout is unverified on your machine.');
  };

  /**
   * CUSTOM BLOCKS: free text, one block per line, parsed by Emco.parseFreeLine. G00 and
   * G01 lines update the tracked position so the following operation starts correctly.
   */
  GEN.custom = (em, op) => {
    for (const line of String(op.text || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const b = Emco.parseFreeLine(line);
      if (!b) { em.warnings.push('Custom block ignored (unreadable): "' + line + '"'); continue; }
      em.raw(b);
      if (b.g === 0 || b.g === 1) { const x = b.x != null ? b.x / 200 : em.pos.x, z = b.z != null ? b.z / 100 : em.pos.z; em._setPos(x, z); }
    }
  };

  /** parseFloat with a default for empty / invalid input. */
  function num(v, d) { const n = parseFloat(v); return isNaN(n) ? d : n; }

  /**
   * Build the whole program for a project { stock, settings, profile, ops }.
   * Frame: G92 at the start position, optional M03, the enabled operations in order
   * (each preceded by a comment line), rapid back to the start position, optional M05,
   * and the end block (M30 or G22). Returns { blocks, warnings }.
   */
  function buildProgram(project) {
    const stock = project.stock, settings = project.settings;
    const controller = Emco.CONTROLLERS[settings.controller] || Emco.CONTROLLERS.MK4;
    const profile = (project.profile || []).map(p => ({ z: num(p.z, 0), x: num(p.x, 0), seg: p.seg || { type: 'line' } }));
    const poly = Geom.profileToPolyline(profile, 0.005);
    const warnings = Geom.validateProfile(profile);
    const clearX = num(settings.clearX, 1), clearZ = num(settings.clearZ, 1);
    const start = { x: num(settings.startDia, stock.diameter + 2 * clearX) / 2, z: num(settings.startZ, num(stock.zFront, 0) + clearZ) };
    const bb = poly.length ? Geom.bbox(poly) : { zmin: -10, zmax: 0 };
    const zMaterial = Math.max(num(stock.zFront, 0), bb.zmax);
    const zHigh = zMaterial + clearZ + 5;
    const env = poly.length > 1 ? Geom.envelope(poly, bb.zmin, zHigh, GRID) : null;
    const ctx = { stock: Object.assign({}, stock, { zFront: num(stock.zFront, 0) }), profile, poly, env, zMaterial, clearX, clearZ, start, controller, settings };
    const em = new Emitter(ctx);
    em.raw({ g: 92, x: em.dia(start.x), z: em.zz(start.z) });
    if (settings.spindle && controller.spindleOn) em.raw(Object.assign({}, controller.spindleOn));
    const tools = Array.isArray(project.tools) ? project.tools : [];
    let curTool = null, firstTool = null, changes = 0;
    for (const op0 of project.ops || []) {
      if (!op0.enabled) continue;
      const gen = GEN[op0.type]; if (!gen) continue;
      let op = op0;
      const tool = toolForOp(op0, tools);
      if (tool) {
        if (!curTool) curTool = firstTool = tool;
        else if (tool.id !== curTool.id) {
          em.comment('Tool change: T' + tool.number + ' ' + tool.name);
          emitToolChange(em, ctx, tool, firstTool); curTool = tool; changes++;
          // the drill's X zero follows the tool offsets now, so it no longer has to be centred by hand
          if (tool.type === 'drill') op = Object.assign({}, op0, { manual: false });
        }
      }
      em.comment(op.name || OP_DEFS[op.type].label);
      const before = em.blocks.length;
      try { gen(em, op, ctx); } catch (e) { em.warnings.push((op.name || op.type) + ': ' + e.message); }
      if (em.blocks.length === before) em.blocks.pop();          // operation produced nothing: drop its comment
    }
    if (changes && settings.changer === 'turret') {
      const used = [...new Set((project.ops || []).filter(o => o.enabled).map(o => toolForOp(o, tools)).filter(Boolean))];
      em.warnings.unshift('Turret: the program starts with station ' + firstTool.number + ' "' + firstTool.name + '" in working position; index the turret to it before START. Tool changes are automatic (' + changes + ' in this program). The M06 / G26 block layout is unverified on your machine.');
      for (const t of used) if (!(t.number >= 1 && t.number <= 6)) em.warnings.push('Tool "' + t.name + '" is T' + t.number + ' but the turret has stations 1–6.');
      const seen = {}; for (const t of used) { if (seen[t.number]) em.warnings.push('T' + t.number + ' is used by two different tools ("' + seen[t.number] + '" and "' + t.name + '").'); seen[t.number] = t.name; }
    } else if (changes) {
      em.warnings.unshift('Tool changes: mount T' + firstTool.number + ' "' + firstTool.name + '" before pressing START. At each change the program ' + (settings.spindle ? 'stops the spindle and ' : '') + 'pauses (M00 / G20): ' + (settings.spindle ? '' : 'switch the spindle off by hand, ') + 'swap the tool, ' + (settings.spindle ? '' : 'switch the spindle on again, ') + 'then press START. Offsets are measured from T' + firstTool.number + '. The M06 / G26 offset block layout is unverified on your machine.');
    }
    em.comment('Return to start');
    // travel() picks the shortest safe way back: straight along Z when the path is in
    // the air (e.g. a drill on the centreline), otherwise out to the safe radius first.
    em.travel(start.x, start.z);
    if (settings.spindle && controller.spindleOff) em.raw(Object.assign({}, controller.spindleOff));
    em.raw(Object.assign({}, controller.endBlock));
    const blocks = Emco.number(em.blocks);
    return { blocks, warnings: warnings.concat(em.warnings, Emco.checkProgram(blocks, settings.controller)) };
  }

  global.CAM = { OP_DEFS, MATERIALS, TOOL_TYPES, OP_TOOL_TYPE, newTool, defaultTools, toolForOp, newOp, applyCutting, cuttingData, suggestRpm, buildProgram, GRID };
})(typeof window !== 'undefined' ? window : globalThis);
