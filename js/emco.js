/* emco.js — everything about the Emco Compact 5 CNC program format.
 *
 * BLOCKS
 *   A program is a list of blocks. A block is a plain object
 *     { n, g | m, x, z, f, h, i, k, kf, t, l }
 *   where every numeric value is already an INTEGER in machine units:
 *     x   diameter in 1/100 mm (X2700 = Ø27.00)        z   position in 1/100 mm
 *     i,k arc centre offsets in 1/100 mm, radial / axial, always positive (M99 block)
 *     f   feed in mm/min                                h   cycle parameter / dwell / tool
 *     kf  thread pitch in 1/100 mm written in the F column (G33 / G78)
 *     t   tool number (M06 / G26)                      l   jump / subroutine label (G25 / G27)
 *   Comment lines are { comment: 'text' }; they are shown on screen but never sent.
 *
 * TEXT LAYOUT
 *   This is the fixed-column layout that the lathe transmits and that Mike's Free
 *   Interface (MFI) saves. It was taken from the MK4 sample programs:
 *     %
 *         N` G`   X `    Z `  F`  H
 *         00 92  2700    100
 *         01M03
 *         03 01  2310 - 3790 150
 *         32M99 I 678 K  212
 *        121M30
 *        M
 *   Column by column (0-based):
 *     0-5   block number, right-aligned, at least two digits ("00")
 *     6-8   " GG" for a G-code or "MMM" for an M-code (no space before M)
 *     9-14  X field: sign (space or '-') + value right-aligned in 5      — or " I" + value in 4 for M99
 *     15-21 Z field: space + sign + value right-aligned in 5             — or " K" + value in 5 for M99
 *     22-25 F field: space + value right-aligned in 3                    — or K/T/L + value
 *     26-29 H field: space + value right-aligned in 3
 *   Lines are padded with spaces to 32 characters and end with CR LF. Numbers are
 *   written with at least two digits, so zero becomes "00".
 */
(function (global) {
  'use strict';

  /** Differences between the two controller generations that matter for program generation. */
  const CONTROLLERS = {
    MK4: { label: 'Compact 5 CNC Mk3 / Mk4', endBlock: { m: 30 }, spindleOn: { m: 3 }, spindleOff: { m: 5 }, toolChange: 'M06', dwell: true, pause: { m: 0 } },
    MK2: { label: 'Compact 5 CNC Mk1 / Mk2', endBlock: { g: 22 }, spindleOn: null, spindleOff: null, toolChange: 'G26', dwell: false, pause: { g: 20 } }
  };
  const HEADER_LINE = '    N` G`   X `    Z `  F`  H ';
  const LINE_WIDTH = 32;

  /** Two-digit zero padded number ("05"). */
  function two(v) { return String(v).padStart(2, '0'); }
  /** Absolute value, at least two digits, right-aligned in a field of width w. */
  function numField(v, w) { let s = String(Math.abs(Math.round(v))); if (s.length < 2) s = s.padStart(2, '0'); return s.padStart(w, ' '); }

  /** Format one numbered block as a 32-character line (see the layout table above). */
  function formatBlock(b) {
    let s = String(two(b.n)).padStart(6, ' ');
    if (b.m != null) s += 'M' + two(b.m); else s += ' ' + two(b.g);
    if (b.i != null) s += ' I' + numField(b.i, 4);
    else if (b.x != null) s += (b.x < 0 ? '-' : ' ') + numField(b.x, 5);
    else s += '      ';
    if (b.k != null) s += ' K' + numField(b.k, 5);
    else if (b.z != null) s += ' ' + (b.z < 0 ? '-' : ' ') + numField(b.z, 5);
    else s += '       ';
    if (b.f != null) s += ' ' + numField(b.f, 3);
    else if (b.kf != null) s += ' K' + numField(b.kf, 3);
    else if (b.t != null) s += ' T' + numField(b.t, 2);
    else if (b.l != null) s += ' L' + numField(b.l, 2);
    else s += '    ';
    if (b.h != null) s += ' ' + numField(b.h, 3);
    return s.padEnd(LINE_WIDTH, ' ');
  }

  /** Give every non-comment block a sequential number N starting at 0. Returns a new list. */
  function number(blocks) {
    let n = 0;
    return blocks.map(b => b.comment != null ? b : Object.assign({}, b, { n: n++ }));
  }

  /**
   * Render the whole program as text ready to send or save.
   * opts: { eol: '\r\n', header: true (the N` G` … line), trailer: true (the final "   M" line) }
   */
  function formatProgram(blocks, opts) {
    opts = opts || {};
    const eol = opts.eol || '\r\n';
    const out = ['%'];
    if (opts.header !== false) out.push(HEADER_LINE);
    for (const b of number(blocks)) if (b.comment == null) out.push(formatBlock(b));
    if (opts.trailer !== false) out.push('   M');
    return out.join(eol) + eol;
  }

  /** Rows for the on-screen listing: { comment } or { text, block }. */
  function listing(blocks) {
    const rows = [];
    for (const b of number(blocks)) rows.push(b.comment != null ? { comment: b.comment } : { text: formatBlock(b), block: b });
    return rows;
  }

  /* ---------- parsing (files from MFI / the lathe, or free-format text) ---------- */

  /**
   * Parse program text into blocks. Accepts both the fixed-column layout (files from
   * MFI or received from the lathe) and free text such as "N01 G01 X1200 Z-500 F150".
   * Lines starting with '(' or ';' become comments. Returns { blocks, warnings }.
   */
  function parseProgram(text) {
    const blocks = []; const warnings = [];
    const lines = text.split(/\r?\n/);
    for (let raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      const t = line.trim();
      if (t === '%' || t === 'M' || /^N`/.test(t) || t.startsWith('(') || t.startsWith(';')) { if (t.startsWith('(') || t.startsWith(';')) blocks.push({ comment: t.replace(/^[(;]\s*|\)$/g, '') }); continue; }
      const col = parseColumnLine(line);
      if (col) { blocks.push(col); continue; }
      const free = parseFreeLine(line);
      if (free) blocks.push(free); else warnings.push('Could not read line: "' + line + '"');
    }
    return { blocks, warnings };
  }

  /**
   * Parse a fixed-column line. The block number and G/M code are matched with a
   * regular expression; the remaining numbers are assigned to X, Z, F and H by the
   * column where they appear (a letter I/K/T/L in front of a number overrides that).
   * Returns null if the line is not in column format.
   */
  function parseColumnLine(line) {
    const m = /^\s{2,4}(\d{2,3})(M(\d\d)| (\d\d))(.*)$/.exec(line);
    if (!m) return null;
    const b = {};
    if (m[3] != null) b.m = parseInt(m[3], 10); else b.g = parseInt(m[4], 10);
    const rest = m[5];
    const toks = []; const re = /([-IKTL])?\s*(\d+)/g; let mm;
    while ((mm = re.exec(rest)) !== null) toks.push({ tag: mm[1] || '', v: parseInt(mm[2], 10), pos: mm.index });
    const colOf = (tok) => tok.pos + 9;        // `rest` starts at column 9 of the line
    let seenX = false, seenZ = false, seenF = false;
    for (const tok of toks) {
      const c = colOf(tok);
      const val = tok.tag === '-' ? -tok.v : tok.v;
      if (tok.tag === 'I') b.i = tok.v; else if (tok.tag === 'K') { if (c < 22) b.k = tok.v; else b.kf = tok.v; }
      else if (tok.tag === 'T') b.t = tok.v; else if (tok.tag === 'L') b.l = tok.v;
      else if (!seenX && c < 15) { b.x = val; seenX = true; }
      else if (!seenZ && c < 22) { b.z = val; seenZ = true; }
      else if (!seenF && c < 26) { b.f = val; seenF = true; }
      else b.h = val;
    }
    return b;
  }

  /**
   * Parse a free-format line ("G01 X1200 Z-500 F150"). Values with a decimal point are
   * taken as millimetres and converted to 1/100 mm (X12.5 → 1250); values without one
   * are taken as machine units as-is. Returns null if no G or M code is present.
   */
  function parseFreeLine(line) {
    const b = {}; let any = false;
    const re = /([NGMXZFHIKTL])\s*(-?\d+(?:\.\d+)?)/gi; let m;
    while ((m = re.exec(line)) !== null) {
      const L = m[1].toUpperCase(); const raw = m[2]; const dec = raw.includes('.');
      const val = dec ? Math.round(parseFloat(raw) * 100) : parseInt(raw, 10);
      any = true;
      switch (L) {
        case 'N': break;
        case 'G': b.g = parseInt(raw, 10); break;
        case 'M': b.m = parseInt(raw, 10); break;
        case 'X': b.x = val; break;
        case 'Z': b.z = val; break;
        case 'F': b.f = parseInt(raw, 10); break;
        case 'H': b.h = parseInt(raw, 10); break;
        case 'I': b.i = Math.abs(val); break;
        case 'K': if (b.g === 33 || b.g === 78) b.kf = Math.abs(val); else b.k = Math.abs(val); break;
        case 'T': b.t = parseInt(raw, 10); break;
        case 'L': b.l = parseInt(raw, 10); break;
      }
    }
    if (!any || (b.g == null && b.m == null)) return null;
    return b;
  }

  /* ---------- simulation: blocks → moves ---------- */

  /**
   * Walk through the blocks the way the controller would and produce MOVES in
   * absolute millimetres with X as radius:
   *   { type: 'set',   from, to, block }            G92: defines where the tool is
   *   { type: 'rapid', from, to, block }            G00
   *   { type: 'feed',  from, to, block, f }         G01 (and cycles, drawn as one move)
   *   { type: 'arc',   from, to, arc, block, f }    G02/G03 with the following M99 resolved
   *   { type: 'other', at, block }                  everything else (M-codes, G04 …)
   * Handles G90 (absolute, X = diameter) and G91 (incremental, X = radius movement).
   * Returns { moves, warnings }.
   */
  function blocksToMoves(blocks) {
    const moves = []; const warnings = [];
    let abs = true, pos = { z: 0, x: 0 }, known = false;
    const list = blocks.filter(b => b.comment == null);
    for (let idx = 0; idx < list.length; idx++) {
      const b = list[idx];
      if (b.g === 92) { const np = { z: (b.z || 0) / 100, x: (b.x || 0) / 200 }; moves.push({ type: 'set', from: pos, to: np, block: b }); pos = np; abs = true; known = true; continue; }
      if (b.g === 90) { abs = true; continue; }
      if (b.g === 91) { abs = false; continue; }
      if (b.g === 0 || b.g === 1 || b.g === 2 || b.g === 3 || b.g === 33 || b.g === 84 || b.g === 88) {
        const target = { z: pos.z, x: pos.x };
        if (abs) { if (b.x != null) target.x = b.x / 200; if (b.z != null) target.z = b.z / 100; }
        else { if (b.x != null) target.x = pos.x + b.x / 100; if (b.z != null) target.z = pos.z + b.z / 100; }
        if (b.g === 2 || b.g === 3) {
          const nx = list[idx + 1];
          if (nx && nx.m === 99 && nx.i != null && nx.k != null) {
            const arc = resolveArc(pos, target, nx.i / 100, nx.k / 100, b.g === 3);
            if (arc) moves.push({ type: 'arc', from: pos, to: target, arc, block: b, f: b.f });
            else { warnings.push('Block ' + (b.n != null ? b.n : idx) + ': could not resolve arc centre; drawn as a line.'); moves.push({ type: 'feed', from: pos, to: target, block: b, f: b.f }); }
            idx++;                                   // the M99 block has been consumed
          } else { warnings.push('Block ' + (b.n != null ? b.n : idx) + ': G0' + b.g + ' without a following M99 I K block.'); moves.push({ type: 'feed', from: pos, to: target, block: b, f: b.f }); }
        } else if (b.g === 0) moves.push({ type: 'rapid', from: pos, to: target, block: b });
        else { if (b.g === 84 || b.g === 88) warnings.push('Block ' + (b.n != null ? b.n : idx) + ': cycle G' + b.g + ' is shown as a single move only.'); moves.push({ type: 'feed', from: pos, to: target, block: b, f: b.f, cycle: b.g >= 33 }); }
        pos = target; continue;
      }
      moves.push({ type: 'other', at: pos, block: b });
    }
    if (!known) warnings.push('Program has no G92 start position; backplot starts at X0 Z0.');
    return { moves, warnings };
  }

  /**
   * Find the arc centre from the M99 values. I and K are unsigned distances from the
   * start point, so the centre is one of four candidates (start ± I, start ± K). The
   * right one is the candidate for which the end point lies on the same circle and the
   * arc stays within ~90°. Returns an arc object or null if nothing fits.
   */
  function resolveArc(s, e, I, K, ccw) {
    let best = null;
    for (const si of [1, -1]) for (const sk of [1, -1]) {
      const c = { z: s.z + sk * K, x: s.x + si * I };
      const r1 = Math.hypot(s.z - c.z, s.x - c.x), r2 = Math.hypot(e.z - c.z, e.x - c.x);
      if (r1 < 1e-9) continue;
      const arc = Geom.arcFromCenter(c, s, e, ccw);
      const score = Math.abs(r1 - r2) + (arc.sweep > Math.PI / 2 + 0.05 ? 1000 : 0);
      if (!best || score < best.score) best = { score, arc };
    }
    return best && best.score < 0.5 ? best.arc : null;
  }

  /** Sanity checks on a finished program: block count, field overflow, feed range, codes the controller lacks. */
  function checkProgram(blocks, controller) {
    const w = [];
    const list = blocks.filter(b => b.comment == null);
    if (list.length > 221) w.push('Program has ' + list.length + ' blocks. Early Compact 5 controllers hold only about 220 blocks; check that yours accepts it.');
    for (const b of list) {
      if (b.x != null && Math.abs(b.x) > 9999) w.push('Block ' + b.n + ': X value ' + b.x + ' exceeds 4 digits (99.99 mm diameter).');
      if (b.z != null && Math.abs(b.z) > 99999) w.push('Block ' + b.n + ': Z value exceeds 5 digits.');
      if (b.f != null && (b.f < 2 || b.f > 499)) w.push('Block ' + b.n + ': feed ' + b.f + ' mm/min is outside the usual 2-499 range.');
      if (b.g === 4 && controller === 'MK2') w.push('Block ' + b.n + ': G04 dwell is not available on Mk1/Mk2 controllers.');
      if (b.m != null && controller === 'MK2') w.push('Block ' + b.n + ': M-codes are not available on Mk1/Mk2 controllers (use G20/G22/G26).');
    }
    return w;
  }

  global.Emco = { CONTROLLERS, HEADER_LINE, formatBlock, formatProgram, number, listing, parseProgram, parseFreeLine, blocksToMoves, checkProgram };
})(typeof window !== 'undefined' ? window : globalThis);
