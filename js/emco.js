/* emco.js — Emco Compact 5 CNC program format.
 *
 * A block is { n, g | m, x, z, f, h, i, k, t, l } with every numeric value already an
 * INTEGER in machine units: X = diameter in 1/100 mm, Z = 1/100 mm, I/K = radius offsets
 * in 1/100 mm, F = mm/min, H = cycle parameter. Comment lines are { comment: 'text' }.
 *
 * Text layout is the one Mike's Free Interface (MFI) writes and the lathe sends out:
 *   %
 *       N` G`   X `    Z `  F`  H
 *       00 92  2700    100
 *       01M03
 *       03 01  2310 - 3790 150
 *       32M99 I 678 K  212
 *      121M30
 *      M
 * Columns: N right-aligned in 6 | ' 'GG or MMM | X: sign + 5 | Z: ' ' + sign + 5 | F: ' ' + 3 | H: ' ' + 3, padded to 32.
 */
(function (global) {
  'use strict';

  const CONTROLLERS = {
    MK4: { label: 'Compact 5 CNC Mk3 / Mk4', endBlock: { m: 30 }, spindleOn: { m: 3 }, spindleOff: { m: 5 }, toolChange: 'M06', dwell: true, pause: { m: 0 } },
    MK2: { label: 'Compact 5 CNC Mk1 / Mk2', endBlock: { g: 22 }, spindleOn: null, spindleOff: null, toolChange: 'G26', dwell: false, pause: { g: 20 } }
  };
  const HEADER_LINE = '    N` G`   X `    Z `  F`  H ';
  const LINE_WIDTH = 32;

  function two(v) { return String(v).padStart(2, '0'); }
  function numField(v, w) { let s = String(Math.abs(Math.round(v))); if (s.length < 2) s = s.padStart(2, '0'); return s.padStart(w, ' '); }

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
    else if (b.kf != null) s += ' K' + numField(b.kf, 3);        // thread pitch in the F column (G33 / G78)
    else if (b.t != null) s += ' T' + numField(b.t, 2);
    else if (b.l != null) s += ' L' + numField(b.l, 2);
    else s += '    ';
    if (b.h != null) s += ' ' + numField(b.h, 3);
    return s.padEnd(LINE_WIDTH, ' ');
  }

  /** Assign block numbers (skipping comment lines) and return the numbered list. */
  function number(blocks) {
    let n = 0;
    return blocks.map(b => b.comment != null ? b : Object.assign({}, b, { n: n++ }));
  }

  function formatProgram(blocks, opts) {
    opts = opts || {};
    const eol = opts.eol || '\r\n';
    const out = ['%'];
    if (opts.header !== false) out.push(HEADER_LINE);
    for (const b of number(blocks)) if (b.comment == null) out.push(formatBlock(b));
    if (opts.trailer !== false) out.push('   M');
    return out.join(eol) + eol;
  }

  /** Human-readable listing with comments for the on-screen view. */
  function listing(blocks) {
    const rows = [];
    for (const b of number(blocks)) rows.push(b.comment != null ? { comment: b.comment } : { text: formatBlock(b), block: b });
    return rows;
  }

  /* ---------- parsing (files from MFI / the lathe, or free-format text) ---------- */

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

  function parseColumnLine(line) {
    const m = /^\s{2,4}(\d{2,3})(M(\d\d)| (\d\d))(.*)$/.exec(line);
    if (!m) return null;
    const b = {};
    if (m[3] != null) b.m = parseInt(m[3], 10); else b.g = parseInt(m[4], 10);
    const rest = m[5];
    // tokens: a letter or sign may be separated from its digits by spaces
    const toks = []; const re = /([-IKTL])?\s*(\d+)/g; let mm;
    while ((mm = re.exec(rest)) !== null) toks.push({ tag: mm[1] || '', v: parseInt(mm[2], 10), pos: mm.index });
    // position-based assignment: X-field ends before column 15, Z-field before 22, F before 26
    const colOf = (tok) => tok.pos + 9;   // rest starts at column 9
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

  /* ---------- simulation: blocks → moves (absolute mm, X = radius) ---------- */

  function blocksToMoves(blocks) {
    const moves = []; const warnings = [];
    let abs = true, pos = { z: 0, x: 0 }, known = false;
    const list = blocks.filter(b => b.comment == null);
    for (let idx = 0; idx < list.length; idx++) {
      const b = list[idx];
      if (b.g === 92) { pos = { z: (b.z || 0) / 100, x: (b.x || 0) / 200 }; abs = true; known = true; moves.push({ type: 'set', to: pos, block: b }); continue; }
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
            idx++;
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

  /** Resolve the arc centre from |I| (radial) and |K| (axial) offsets measured from the start point. */
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
