/* app.js — UI, canvas editor, simulation and glue. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const LS_PROJECT = 'c5cam.project', LS_SERIAL = 'c5cam.serial', LS_UI = 'c5cam.ui';

  function defaultProject() {
    return { name: 'New part', stock: { diameter: 25, length: 50, zFront: 0 }, settings: { controller: 'MK4', clearX: 1, clearZ: 1, startDia: 27, startZ: 1, spindle: true }, profile: [], ops: [], dxfText: null, dxfMapping: null };
  }
  const defaultSerial = { baud: 300, dataBits: 8, stopBits: 1, parity: 'none', flow: 'none', eol: 'crlf', lineDelay: 50, charDelay: 0, dtr: true, rts: true, header: true, trailer: true };

  const state = {
    project: defaultProject(), dxf: null,
    view: { scale: 8, ox: 100, oy: 300 }, mode: 'select', selected: -1, selectedOp: null,
    program: { blocks: [], warnings: [] }, moves: [], simWarnings: [], loaded: null, source: 'generated',
    sim: { t: 1, playing: false, raf: null, last: 0 }, undo: [], redo: [], drag: null, cursor: null, hoverPt: -1,
    snap: 0.5, showDxf: true, showPath: true, mirror: true, serial: Object.assign({}, defaultSerial), received: ''
  };

  /* ---------- helpers ---------- */
  const fmt = (v, d) => (Math.round(v * Math.pow(10, d == null ? 2 : d)) / Math.pow(10, d == null ? 2 : d)).toString();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(msg, ms) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms || 2200); }
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  function numv(id, d) { const v = parseFloat($(id).value); return isNaN(v) ? d : v; }
  function safeName() { return (state.project.name || 'part').replace(/[^\w\-]+/g, '_'); }

  /* ---------- undo / commit ---------- */
  function snapshot() { const p = state.project; return JSON.stringify({ stock: p.stock, settings: p.settings, profile: p.profile, ops: p.ops }); }
  function pushUndo() { state.undo.push(snapshot()); if (state.undo.length > 80) state.undo.shift(); state.redo.length = 0; }
  function restore(snap) { const o = JSON.parse(snap); Object.assign(state.project, o); state.selected = Math.min(state.selected, state.project.profile.length - 1); }
  function undo() { if (!state.undo.length) return; state.redo.push(snapshot()); restore(state.undo.pop()); commit(false); }
  function redo() { if (!state.redo.length) return; state.undo.push(snapshot()); restore(state.redo.pop()); commit(false); }

  let saveTimer = null;
  function commit(push) {
    if (push) pushUndo();
    rebuild();
    renderAll();
    clearTimeout(saveTimer); saveTimer = setTimeout(autosave, 400);
  }
  function autosave() { try { localStorage.setItem(LS_PROJECT, JSON.stringify(state.project)); } catch (e) { /* storage full or blocked */ } }

  /* ---------- program ---------- */
  function rebuild() {
    if (state.source === 'file' && state.loaded) {
      state.program = { blocks: state.loaded.blocks, warnings: state.loaded.warnings.concat(Emco.checkProgram(Emco.number(state.loaded.blocks), state.project.settings.controller)) };
    } else {
      try { state.program = CAM.buildProgram(state.project); }
      catch (e) { state.program = { blocks: [], warnings: ['Program generation failed: ' + e.message] }; console.error(e); }
    }
    const sim = Emco.blocksToMoves(state.program.blocks);
    state.moves = sim.moves; state.simWarnings = sim.warnings;
  }
  function programText(forFile) {
    const s = state.serial;
    const eol = forFile ? '\r\n' : (s.eol === 'cr' ? '\r' : s.eol === 'lf' ? '\n' : '\r\n');
    return Emco.formatProgram(state.program.blocks, { eol, header: forFile ? true : s.header, trailer: forFile ? true : s.trailer });
  }

  /* ---------- rendering: sidebar ---------- */
  function renderAll() { renderSetup(); renderProfileTable(); renderOps(); renderProgram(); updateStatus(); draw(); }

  function renderSetup() {
    const p = state.project;
    $('projName').value = p.name;
    $('stockDia').value = p.stock.diameter; $('stockLen').value = p.stock.length; $('stockFront').value = p.stock.zFront;
    $('controller').value = p.settings.controller; $('clearX').value = p.settings.clearX; $('clearZ').value = p.settings.clearZ;
    $('startDia').value = p.settings.startDia; $('startZ').value = p.settings.startZ; $('spindle').checked = !!p.settings.spindle;
  }
  function bindSetup() {
    $('projName').addEventListener('change', () => { state.project.name = $('projName').value; commit(false); });
    const map = { stockDia: ['stock', 'diameter'], stockLen: ['stock', 'length'], stockFront: ['stock', 'zFront'], clearX: ['settings', 'clearX'], clearZ: ['settings', 'clearZ'], startDia: ['settings', 'startDia'], startZ: ['settings', 'startZ'] };
    for (const id in map) $(id).addEventListener('change', () => { const [o, k] = map[id]; const v = parseFloat($(id).value); if (!isNaN(v)) { state.project[o][k] = v; commit(true); } });
    $('controller').addEventListener('change', () => { state.project.settings.controller = $('controller').value; commit(true); });
    $('spindle').addEventListener('change', () => { state.project.settings.spindle = $('spindle').checked; commit(true); });
    $('btnQuickOps').addEventListener('click', () => { state.project.ops.push(CAM.newOp('rough'), CAM.newOp('finish')); commit(true); showTab('ops'); toast('Added Rough turning + Finish contour'); });
  }

  function renderProfileTable() {
    const tb = $('ptsBody'); const prof = state.project.profile;
    $('profileCount').textContent = prof.length ? prof.length + ' points' : '';
    let html = '';
    prof.forEach((p, i) => {
      const seg = p.seg || { type: 'line' }; const last = i === prof.length - 1;
      html += `<tr data-i="${i}" class="${i === state.selected ? 'sel' : ''}"><td class="idx">${i + 1}</td>` +
        `<td><input type="number" step="0.01" data-k="z" value="${fmt(p.z, 3)}"></td>` +
        `<td><input type="number" step="0.01" data-k="x" value="${fmt(p.x, 3)}"></td>` +
        `<td><input type="number" step="0.01" data-k="d" value="${fmt(p.x * 2, 3)}"></td>` +
        `<td class="segcell">${last ? '<span class="muted">end</span>' : `<select data-k="type"><option value="line"${seg.type === 'line' ? ' selected' : ''}>Line</option><option value="arc"${seg.type === 'arc' ? ' selected' : ''}>Arc</option></select>` +
          (seg.type === 'arc' ? `<div class="arcctl">R<input type="number" step="0.1" min="0.01" data-k="r" value="${seg.r != null ? seg.r : 1}" style="width:52px"><select data-k="ccw"><option value="1"${seg.ccw ? ' selected' : ''}>G03 ↺</option><option value="0"${!seg.ccw ? ' selected' : ''}>G02 ↻</option></select></div>` : '')}</td>` +
        `<td><button class="small" data-act="ins" title="Insert point after">+</button><button class="small" data-act="del" title="Delete">×</button></td></tr>`;
    });
    tb.innerHTML = html;
  }
  function bindProfileTable() {
    const tb = $('ptsBody');
    tb.addEventListener('change', e => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const i = +tr.dataset.i, k = e.target.dataset.k, p = state.project.profile[i];
      pushUndo();
      if (k === 'z') p.z = parseFloat(e.target.value) || 0;
      else if (k === 'x') p.x = Math.max(0, parseFloat(e.target.value) || 0);
      else if (k === 'd') p.x = Math.max(0, (parseFloat(e.target.value) || 0) / 2);
      else if (k === 'type') { p.seg = e.target.value === 'arc' ? { type: 'arc', r: Math.max(0.5, Geom.dist(p, state.project.profile[i + 1]) / 2 + 0.5), ccw: true } : { type: 'line' }; }
      else if (k === 'r') p.seg.r = Math.max(0.01, parseFloat(e.target.value) || 1);
      else if (k === 'ccw') p.seg.ccw = e.target.value === '1';
      state.selected = i;
      commit(false);
    });
    tb.addEventListener('click', e => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const i = +tr.dataset.i; const act = e.target.dataset.act;
      if (act === 'del') { pushUndo(); state.project.profile.splice(i, 1); state.selected = Math.min(i, state.project.profile.length - 1); commit(false); return; }
      if (act === 'ins') { pushUndo(); const a = state.project.profile[i], b = state.project.profile[i + 1]; const np = b ? { z: (a.z + b.z) / 2, x: (a.x + b.x) / 2, seg: { type: 'line' } } : { z: a.z - 5, x: a.x, seg: { type: 'line' } }; state.project.profile.splice(i + 1, 0, np); state.selected = i + 1; commit(false); return; }
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') { state.selected = i; renderProfileTable(); draw(); }
    });
    $('btnAddPoint').addEventListener('click', () => { pushUndo(); const prof = state.project.profile; const last = prof[prof.length - 1]; prof.push(last ? { z: last.z - 5, x: last.x, seg: { type: 'line' } } : { z: 0, x: 0, seg: { type: 'line' } }); state.selected = prof.length - 1; commit(false); });
    $('btnProfileClear').addEventListener('click', () => { if (!state.project.profile.length || confirm('Clear the whole profile?')) { pushUndo(); state.project.profile = []; state.selected = -1; commit(false); } });
    $('btnProfileFromStock').addEventListener('click', () => {
      const R = state.project.stock.diameter / 2, L = state.project.stock.length;
      pushUndo();
      state.project.profile = [
        { z: 0, x: 0, seg: { type: 'line' } }, { z: 0, x: R * 0.5, seg: { type: 'line' } }, { z: -L * 0.3, x: R * 0.5, seg: { type: 'line' } },
        { z: -L * 0.35, x: R * 0.8, seg: { type: 'line' } }, { z: -L * 0.7, x: R * 0.8, seg: { type: 'line' } }, { z: -L * 0.7, x: R, seg: { type: 'line' } }
      ].map(p => ({ z: Math.round(p.z * 10) / 10, x: Math.round(p.x * 10) / 10, seg: p.seg }));
      state.selected = -1; commit(false); fitView();
    });
    $('btnFillet').addEventListener('click', () => cornerOp('fillet'));
    $('btnChamfer').addEventListener('click', () => cornerOp('chamfer'));
  }
  function cornerOp(kind) {
    const v = numv('cornerVal', 1), i = state.selected;
    if (i < 0) { toast('Select a corner point first'); return; }
    try {
      const np = kind === 'fillet' ? Geom.filletAt(state.project.profile, i, v) : Geom.chamferAt(state.project.profile, i, v);
      pushUndo(); state.project.profile = np; state.selected = i; commit(false);
    } catch (e) { toast(e.message, 3500); }
  }

  /* ---------- operations ---------- */
  const FIELDS = {
    face: [['zStart', 'Start Z (front of material)', 'mm'], ['zEnd', 'End Z (finished face)', 'mm'], ['doc', 'Depth per pass', 'mm'], ['feed', 'Feed', 'mm/min'], ['xEnd', 'End diameter (0 = centre)', 'mm']],
    rough: [['doc', 'Depth of cut (radial)', 'mm'], ['allowX', 'Finish allowance X (radial)', 'mm'], ['allowZ', 'Finish allowance Z', 'mm'], ['feed', 'Feed', 'mm/min'], ['retract', 'Pull-out step (45°)', 'mm'], ['zEnd', 'Stop at Z (empty = profile end)', 'mm']],
    finish: [['feed', 'Feed', 'mm/min'], ['retract', 'Pull-out step', 'mm'], ['arcsAsLines', 'Arcs as short lines (Mk1/Mk2)', 'bool'], ['arcTol', 'Line tolerance', 'mm']],
    groove: [['z', 'Groove right edge Z', 'mm'], ['width', 'Width', 'mm'], ['dia', 'Bottom diameter', 'mm'], ['toolWidth', 'Tool width', 'mm'], ['toolRef', 'Programmed tool edge', 'select:right=Right (+Z) edge,left=Left (−Z) edge'], ['feed', 'Feed', 'mm/min'], ['dwell', 'Dwell at bottom (Mk4)', 's'], ['stepFactor', 'Step (fraction of tool width)', '']],
    part: [['z', 'Part end face Z (= −length)', 'mm'], ['toolWidth', 'Tool width', 'mm'], ['toolRef', 'Programmed tool edge', 'select:right=Right (+Z) edge,left=Left (−Z) edge'], ['finalDia', 'Stop at diameter', 'mm'], ['feed', 'Feed', 'mm/min'], ['dwell', 'Dwell at bottom (Mk4)', 's']],
    drill: [['depth', 'Depth', 'mm'], ['peck', 'Peck depth (0 = none)', 'mm'], ['feed', 'Feed', 'mm/min'], ['zTop', 'Surface Z', 'mm'], ['retract', 'Re-entry gap', 'mm']],
    thread: [['dia', 'Major diameter', 'mm'], ['pitch', 'Pitch', 'mm'], ['zStart', 'Start Z (in the air)', 'mm'], ['zEnd', 'End Z', 'mm'], ['depth', 'Total depth (radial)', 'mm'], ['passes', 'Passes', '']],
    tool: [['tool', 'Tool number', ''], ['dx', 'X offset', 'mm'], ['dz', 'Z offset', 'mm'], ['pause', 'Pause before (M00 / G20)', 'bool']],
    custom: [['text', 'Blocks, one per line (e.g. G01 X1200 Z-500 F100)', 'textarea']]
  };
  function renderOps() {
    const menu = $('addMenu');
    if (!menu.children.length) for (const t in CAM.OP_DEFS) { const b = document.createElement('button'); b.textContent = CAM.OP_DEFS[t].icon + ' ' + CAM.OP_DEFS[t].label; b.dataset.type = t; menu.appendChild(b); }
    const ops = state.project.ops; const list = $('opList');
    $('opsHint').hidden = ops.length > 0;
    list.innerHTML = ops.map((op, i) => `<div class="op ${op.id === state.selectedOp ? 'sel' : ''} ${op.enabled ? '' : 'off'}" data-id="${op.id}">` +
      `<input type="checkbox" data-act="en" ${op.enabled ? 'checked' : ''} title="Enable"><span class="ico">${CAM.OP_DEFS[op.type].icon}</span><span class="nm">${esc(op.name)}</span>` +
      `<span class="ctl"><button class="small" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button><button class="small" data-act="down" ${i === ops.length - 1 ? 'disabled' : ''} title="Move down">↓</button><button class="small" data-act="dup" title="Duplicate">⧉</button><button class="small" data-act="del" title="Delete">×</button></span></div>`).join('');
    renderOpForm();
  }
  function renderOpForm() {
    const form = $('opForm'); const op = state.project.ops.find(o => o.id === state.selectedOp);
    if (!op) { form.hidden = true; form.innerHTML = ''; return; }
    form.hidden = false;
    let html = `<label class="field"><span class="name">Name</span><input type="text" data-k="name" value="${esc(op.name)}" style="width:200px"></label>`;
    for (const [k, label, unit] of FIELDS[op.type]) {
      const v = op[k];
      if (unit === 'bool') html += `<label class="field"><span class="name">${label}</span><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}></label>`;
      else if (unit === 'textarea') html += `<label class="field" style="flex-direction:column;align-items:stretch"><span class="name">${label}</span><textarea data-k="${k}">${esc(v || '')}</textarea></label>`;
      else if (unit.startsWith('select:')) html += `<label class="field"><span class="name">${label}</span><select data-k="${k}">${unit.slice(7).split(',').map(o => { const [val, lab] = o.split('='); return `<option value="${val}"${v === val ? ' selected' : ''}>${lab}</option>`; }).join('')}</select></label>`;
      else html += `<label class="field"><span class="name">${label}${unit ? ` <small>${unit}</small>` : ''}</span><input type="number" step="any" data-k="${k}" value="${v == null ? '' : v}"></label>`;
    }
    const notes = { rough: 'Cuts parallel to Z from the stock down to the profile plus allowance, entering walls from above. Pull-out is a 45° move into already-cut material, like the original Emco examples.', finish: 'Follows the profile exactly with G01 / G02 / G03. Tool nose radius is not compensated.', thread: 'Needs the threading option. Verify the K-field layout on your machine.', tool: 'Block layout for M06 / G26 offsets is unverified. Retracts to the start Z first.', custom: 'Values are in machine units (X diameter and Z in 1/100 mm) unless written with a decimal point (12.5 = 12.50 mm).', face: 'Passes from the front of the material down to End Z, cutting toward the centre.', groove: 'Repeated plunges with the grooving tool; width must be at least the tool width.', part: 'Single plunge at the part end face. Use a slow feed; 0 stops exactly at the centre.', drill: 'Centre drill / drill mounted in the tool holder at X0, pecking with full retract.' };
    html += `<p class="hint">${notes[op.type] || ''}</p>`;
    form.innerHTML = html;
  }
  function bindOps() {
    $('addMenu').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const op = CAM.newOp(b.dataset.type); pushUndo(); state.project.ops.push(op); state.selectedOp = op.id; commit(false); });
    $('opList').addEventListener('click', e => {
      const row = e.target.closest('.op'); if (!row) return;
      const id = row.dataset.id; const ops = state.project.ops; const i = ops.findIndex(o => o.id === id); const act = e.target.dataset.act;
      if (act === 'en') { pushUndo(); ops[i].enabled = e.target.checked; commit(false); return; }
      if (act === 'up' && i > 0) { pushUndo(); [ops[i - 1], ops[i]] = [ops[i], ops[i - 1]]; commit(false); return; }
      if (act === 'down' && i < ops.length - 1) { pushUndo(); [ops[i + 1], ops[i]] = [ops[i], ops[i + 1]]; commit(false); return; }
      if (act === 'dup') { pushUndo(); const c = JSON.parse(JSON.stringify(ops[i])); c.id = 'op' + Math.random().toString(36).slice(2, 8); c.name += ' copy'; ops.splice(i + 1, 0, c); state.selectedOp = c.id; commit(false); return; }
      if (act === 'del') { pushUndo(); ops.splice(i, 1); if (state.selectedOp === id) state.selectedOp = null; commit(false); return; }
      state.selectedOp = id; renderOps();
    });
    $('opForm').addEventListener('change', e => {
      const op = state.project.ops.find(o => o.id === state.selectedOp); if (!op) return;
      const k = e.target.dataset.k; if (!k) return;
      pushUndo();
      if (e.target.type === 'checkbox') op[k] = e.target.checked;
      else if (e.target.type === 'number') op[k] = e.target.value === '' ? null : parseFloat(e.target.value);
      else op[k] = e.target.value;
      rebuild(); renderOps(); renderProgram(); updateStatus(); draw(); clearTimeout(saveTimer); saveTimer = setTimeout(autosave, 400);
    });
  }

  /* ---------- program panel ---------- */
  function renderProgram() {
    const rows = Emco.listing(state.program.blocks);
    $('listing').innerHTML = rows.map(r => r.comment != null ? `<span class="c">( ${esc(r.comment)} )</span>` : esc(r.text)).join('\n');
    const warns = (state.program.warnings || []).concat(state.simWarnings || []);
    const wbox = $('warnings'); wbox.hidden = !warns.length; wbox.innerHTML = warns.map(w => '⚠ ' + esc(w)).join('<br>');
    const n = state.program.blocks.filter(b => b.comment == null).length;
    let feedLen = 0, feedTime = 0, rapidLen = 0;
    for (const m of state.moves) {
      if (m.type === 'feed' || m.type === 'arc') { const L = m.type === 'arc' ? m.arc.r * m.arc.sweep : Geom.dist(m.from, m.to); feedLen += L; if (m.f > 0) feedTime += L / m.f; }
      else if (m.type === 'rapid') rapidLen += Geom.dist(m.from, m.to);
    }
    $('progStats').textContent = `${n} blocks · cutting ${feedLen.toFixed(0)} mm ≈ ${Math.floor(feedTime)} min ${Math.round((feedTime % 1) * 60)} s at feed · rapids ${rapidLen.toFixed(0)} mm`;
    $('progSource').textContent = state.source === 'file' ? 'Loaded: ' + (state.loaded ? state.loaded.name : '') : 'Generated from operations';
    $('btnUseGenerated').hidden = state.source !== 'file';
    $('stBlocks').textContent = n + ' blocks';
  }
  function bindProgram() {
    $('btnCopy').addEventListener('click', () => navigator.clipboard.writeText(programText(true)).then(() => toast('Program copied'), () => toast('Clipboard blocked')));
    $('btnDownload').addEventListener('click', () => download(safeName() + '.CNC', programText(true)));
    $('btnExport').addEventListener('click', () => download(safeName() + '.CNC', programText(true)));
    $('btnUseGenerated').addEventListener('click', () => { state.source = 'generated'; commit(false); });
  }

  /* ---------- serial ---------- */
  function loadSerial() { try { Object.assign(state.serial, JSON.parse(localStorage.getItem(LS_SERIAL) || '{}')); } catch (e) { /* ignore */ } }
  function renderSerial() {
    const s = state.serial;
    $('serBaud').value = s.baud; $('serData').value = s.dataBits; $('serStop').value = s.stopBits; $('serParity').value = s.parity; $('serFlow').value = s.flow; $('serEol').value = s.eol;
    $('serLineDelay').value = s.lineDelay; $('serCharDelay').value = s.charDelay; $('serDtr').checked = s.dtr; $('serRts').checked = s.rts; $('serHeader').checked = s.header; $('serTrailer').checked = s.trailer;
  }
  function bindSerial() {
    const ids = { serBaud: ['baud', 'int'], serData: ['dataBits', 'int'], serStop: ['stopBits', 'int'], serParity: ['parity', 'str'], serFlow: ['flow', 'str'], serEol: ['eol', 'str'], serLineDelay: ['lineDelay', 'num'], serCharDelay: ['charDelay', 'num'], serDtr: ['dtr', 'bool'], serRts: ['rts', 'bool'], serHeader: ['header', 'bool'], serTrailer: ['trailer', 'bool'] };
    for (const id in ids) $(id).addEventListener('change', () => {
      const [k, t] = ids[id]; const el = $(id);
      state.serial[k] = t === 'bool' ? el.checked : t === 'str' ? el.value : (parseFloat(el.value) || 0);
      try { localStorage.setItem(LS_SERIAL, JSON.stringify(state.serial)); } catch (e) { /* ignore */ }
    });
    Serial.onStatus = st => { const p = $('serialStatus'); p.textContent = st; p.className = 'pill ' + (st === 'connected' ? 'ok' : ''); $('btnConnect').textContent = st === 'connected' ? 'Disconnect' : 'Connect…'; $('btnSerialSend').disabled = st !== 'connected'; };
    Serial.onData = (text, bytes, err) => {
      if (err) { log('[read error] ' + err.message); return; }
      state.received += text; const el = $('serialLog'); el.textContent += text; el.scrollTop = el.scrollHeight;
    };
    $('btnConnect').addEventListener('click', async () => {
      if (Serial.port) { await Serial.disconnect(); return; }
      try { await Serial.connect(state.serial); log('[connected] ' + describeSerial()); }
      catch (e) { if (e.name !== 'NotFoundError') toast(e.message, 5000); log('[connect failed] ' + e.message); }
    });
    $('btnSerialSend').addEventListener('click', sendProgram);
    $('btnSend').addEventListener('click', async () => { showTab('program'); if (!Serial.port) { try { await Serial.connect(state.serial); log('[connected] ' + describeSerial()); } catch (e) { if (e.name !== 'NotFoundError') toast(e.message, 5000); return; } } sendProgram(); });
    $('btnCancelSend').addEventListener('click', () => Serial.cancel());
    $('btnClearLog').addEventListener('click', () => { state.received = ''; $('serialLog').textContent = ''; });
    $('btnUseReceived').addEventListener('click', () => {
      const r = Emco.parseProgram(state.received);
      if (!r.blocks.length) { toast('Nothing readable was received yet'); return; }
      state.loaded = { blocks: r.blocks, warnings: r.warnings, name: 'received from lathe' }; state.source = 'file'; commit(false); fitView(); toast('Received program loaded (' + r.blocks.length + ' blocks)');
    });
    if (!Serial.supported) { $('serialStatus').textContent = 'Web Serial unavailable — use Chrome or Edge'; $('serialStatus').className = 'pill err'; $('btnConnect').disabled = true; }
  }
  function describeSerial() { const s = state.serial; return `${s.baud} baud ${s.dataBits}${s.parity[0].toUpperCase()}${s.stopBits}, handshake ${s.flow}`; }
  function log(msg) { const el = $('serialLog'); el.textContent += (el.textContent && !el.textContent.endsWith('\n') ? '\n' : '') + msg + '\n'; el.scrollTop = el.scrollHeight; }
  async function sendProgram() {
    if (!Serial.port) { toast('Connect to the lathe first'); return; }
    if (!state.program.blocks.length) { toast('Nothing to send'); return; }
    const text = programText(false); const lines = text.split(/\r\n|\r|\n/).filter(l => l.length).length;
    if (!confirm(`Send ${lines} lines to the lathe at ${describeSerial()}?\n\nThe lathe must already be in receive mode (G66 INP INP → "A LO" → START).`)) return;
    $('btnSerialSend').disabled = true; $('btnCancelSend').hidden = false; const bar = $('sendProgress'); bar.style.width = '0%';
    log('[sending ' + lines + ' lines]');
    try {
      await Serial.send(text, { charDelay: state.serial.charDelay, lineDelay: state.serial.lineDelay }, (i, n) => { bar.style.width = (100 * i / n).toFixed(1) + '%'; });
      log('[done]'); toast('Program sent');
    } catch (e) { log('[send failed] ' + e.message); toast(e.message, 4000); }
    finally { $('btnSerialSend').disabled = !Serial.port; $('btnCancelSend').hidden = true; }
  }

  /* ---------- files ---------- */
  function bindFiles() {
    $('btnNew').addEventListener('click', () => { if (confirm('Start a new project? Unsaved changes are kept only in this browser.')) { state.project = defaultProject(); state.dxf = null; state.loaded = null; state.source = 'generated'; state.selected = -1; state.selectedOp = null; state.undo.length = 0; commit(false); fitView(); } });
    $('btnSave').addEventListener('click', () => download(safeName() + '.c5cam.json', JSON.stringify(state.project, null, 1)));
    $('btnOpen').addEventListener('click', () => $('fileProj').click());
    $('fileProj').addEventListener('change', e => readFile(e.target.files[0], text => {
      try { const p = JSON.parse(text); if (!p.stock || !p.profile) throw new Error('not a project file'); state.project = Object.assign(defaultProject(), p); state.selected = -1; state.selectedOp = null; state.source = 'generated'; state.loaded = null; state.undo.length = 0; restoreDxfRef(); commit(false); fitView(); toast('Project loaded'); }
      catch (err) { toast('Could not open project: ' + err.message, 4000); }
    }));
    $('btnImportDxf').addEventListener('click', () => $('fileDxf').click());
    $('fileDxf').addEventListener('change', e => readFile(e.target.files[0], text => openDxfDialog(text, e.target.files[0].name)));
    $('btnOpenCnc').addEventListener('click', () => $('fileCnc').click());
    $('fileCnc').addEventListener('change', e => readFile(e.target.files[0], text => {
      const r = Emco.parseProgram(text);
      if (!r.blocks.length) { toast('No blocks found in that file', 3000); return; }
      state.loaded = { blocks: r.blocks, warnings: r.warnings, name: e.target.files[0].name }; state.source = 'file'; commit(false); showTab('program'); fitView(); toast('Loaded ' + r.blocks.length + ' blocks — simulation shows this file');
    }));
  }
  function readFile(file, cb) { if (!file) return; const r = new FileReader(); r.onload = () => cb(r.result); r.readAsText(file, 'latin1'); document.querySelectorAll('input[type=file]').forEach(i => { i.value = ''; }); }
  function restoreDxfRef() {
    const p = state.project; state.dxf = null;
    if (p.dxfText && p.dxfMapping) { try { const parsed = DXF.parse(p.dxfText); state.dxf = { parsed, mapping: p.dxfMapping, result: DXF.toProfile(parsed, p.dxfMapping, { chainIndex: p.dxfMapping.chainIndex || 0 }) }; } catch (e) { /* ignore */ } }
  }

  /* ---------- DXF dialog ---------- */
  let dxfCtx = null;
  function openDxfDialog(text, name) {
    let parsed;
    try { parsed = DXF.parse(text); } catch (e) { toast('Could not read DXF: ' + e.message, 4000); return; }
    if (!parsed.entities.length) { toast('No LINE / ARC / POLYLINE entities found in ' + name, 4000); return; }
    dxfCtx = { text, name, parsed, mapping: DXF.suggestMapping(parsed), chainIndex: 0 };
    fillDxfForm(); updateDxfPreview();
    $('dlgDxf').showModal();
  }
  function fillDxfForm() {
    const m = dxfCtx.mapping;
    $('dxfZAxis').value = m.zAxis; $('dxfFlip').checked = m.flipZ; $('dxfSide').value = String(m.side); $('dxfAxisPos').value = fmt(m.axisPos, 4); $('dxfZZero').value = fmt(m.zZero, 4); $('dxfScale').value = String(m.scale); $('dxfRemoveAxis').checked = m.removeAxis !== false;
  }
  function readDxfForm() {
    dxfCtx.mapping = { zAxis: $('dxfZAxis').value, flipZ: $('dxfFlip').checked, side: parseInt($('dxfSide').value, 10), axisPos: numv('dxfAxisPos', 0), zZero: numv('dxfZZero', 0), scale: parseFloat($('dxfScale').value) || 1, removeAxis: $('dxfRemoveAxis').checked };
    dxfCtx.chainIndex = parseInt($('dxfChain').value, 10) || 0;
  }
  function updateDxfPreview() {
    const res = DXF.toProfile(dxfCtx.parsed, dxfCtx.mapping, { chainIndex: dxfCtx.chainIndex });
    dxfCtx.result = res;
    const sel = $('dxfChain'); const cur = dxfCtx.chainIndex;
    sel.innerHTML = res.chains.map((c, i) => `<option value="${i}"${i === cur ? ' selected' : ''}>#${i + 1}: ${c.length} segments, ${DXF.chainLength(c).toFixed(1)} mm</option>`).join('') || '<option value="0">none</option>';
    $('dxfInfo').innerHTML = `${dxfCtx.parsed.entities.length} entities in ${dxfCtx.name}${dxfCtx.parsed.units === 1 ? ' (drawing units: inch)' : ''}. Profile: ${res.profile.length} points.` + (res.warnings.length ? '<br>' + res.warnings.map(esc).join('<br>') : '');
    const cv = $('dxfPreview'); const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth || 700, H = cv.clientHeight || 260;
    cv.width = W * dpr; cv.height = H * dpr; const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const pts = []; for (const s of res.all) { pts.push(s.a, s.b); }
    if (!pts.length) return;
    const bb = Geom.bbox(pts); bb.xmin = Math.min(bb.xmin, -1); bb.xmax = Math.max(bb.xmax, 1);
    const sc = Math.min((W - 40) / Math.max(1e-6, bb.zmax - bb.zmin), (H - 30) / Math.max(1e-6, bb.xmax - bb.xmin));
    const ox = 20 - bb.zmin * sc, oy = H - 15 + bb.xmin * sc;
    const S = p => [ox + p.z * sc, oy - p.x * sc];
    const css = getComputedStyle(document.documentElement);
    ctx.strokeStyle = css.getPropertyValue('--axis'); ctx.setLineDash([8, 4, 2, 4]); ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(W, oy); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = css.getPropertyValue('--dxf'); ctx.lineWidth = 1;
    for (const s of res.all) drawSeg(ctx, s, S);
    ctx.strokeStyle = css.getPropertyValue('--accent'); ctx.lineWidth = 2.5;
    const poly = Geom.profileToPolyline(res.profile, 0.05);
    ctx.beginPath(); poly.forEach((p, i) => { const [x, y] = S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.fillStyle = css.getPropertyValue('--accent'); for (const p of res.profile) { const [x, y] = S(p); ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); }
    // face marker
    const [fx] = S({ z: 0, x: 0 }); ctx.strokeStyle = css.getPropertyValue('--ok'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, H); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = css.getPropertyValue('--muted'); ctx.font = '11px sans-serif'; ctx.fillText('Z0 (face)', fx + 4, 12); ctx.fillText('centreline', 4, oy - 4);
  }
  function drawSeg(ctx, s, S) {
    ctx.beginPath();
    if (s.type === 'line') { const [x1, y1] = S(s.a), [x2, y2] = S(s.b); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    else { const arc = Geom.arcFromEndpoints(s.a, s.b, s.r, s.ccw); if (!arc) { const [x1, y1] = S(s.a), [x2, y2] = S(s.b); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); } else Geom.sampleArc(arc, 0.05).forEach((p, i) => { const [x, y] = S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); }
    ctx.stroke();
  }
  function bindDxfDialog() {
    for (const id of ['dxfZAxis', 'dxfFlip', 'dxfSide', 'dxfAxisPos', 'dxfZZero', 'dxfScale', 'dxfChain', 'dxfRemoveAxis']) $(id).addEventListener('change', () => { readDxfForm(); updateDxfPreview(); });
    $('dxfAuto').addEventListener('click', () => { dxfCtx.mapping = DXF.suggestMapping(dxfCtx.parsed, $('dxfZAxis').value); dxfCtx.chainIndex = 0; fillDxfForm(); updateDxfPreview(); });
    $('dxfCancel').addEventListener('click', () => $('dlgDxf').close());
    $('dxfOk').addEventListener('click', () => {
      readDxfForm(); const res = DXF.toProfile(dxfCtx.parsed, dxfCtx.mapping, { chainIndex: dxfCtx.chainIndex });
      if (res.profile.length < 2) { toast('No usable profile in this chain', 3000); return; }
      pushUndo();
      state.project.profile = res.profile; state.project.dxfText = dxfCtx.text; state.project.dxfMapping = Object.assign({}, dxfCtx.mapping, { chainIndex: dxfCtx.chainIndex });
      state.dxf = { parsed: dxfCtx.parsed, mapping: dxfCtx.mapping, result: res }; state.selected = -1; state.source = 'generated';
      const bb = Geom.bbox(Geom.profileToPolyline(res.profile, 0.1)); const dia = Math.ceil(bb.xmax * 2);
      if (dia > state.project.stock.diameter) { state.project.stock.diameter = dia; toast('Stock diameter raised to Ø' + dia + ' to fit the profile', 3500); }
      if (-bb.zmin > state.project.stock.length) state.project.stock.length = Math.ceil(-bb.zmin + 10);
      $('dlgDxf').close(); commit(false); fitView(); showTab('profile');
    });
  }

  /* ---------- canvas ---------- */
  const cv = () => $('cv');
  function toScreen(p) { return { x: state.view.ox + p.z * state.view.scale, y: state.view.oy - p.x * state.view.scale }; }
  function toWorld(sx, sy) { return { z: (sx - state.view.ox) / state.view.scale, x: (state.view.oy - sy) / state.view.scale }; }
  function fitView() {
    const c = cv(); const W = c.clientWidth || 800, H = c.clientHeight || 500;
    const p = state.project; const R = p.stock.diameter / 2;
    let zmin = -p.stock.length, zmax = Math.max(p.stock.zFront, 0) + 2, xmax = R;
    const pts = Geom.profileToPolyline(p.profile.map(q => ({ z: +q.z || 0, x: +q.x || 0, seg: q.seg })), 0.5);
    if (pts.length) { const bb = Geom.bbox(pts); zmin = Math.min(zmin, bb.zmin); zmax = Math.max(zmax, bb.zmax); xmax = Math.max(xmax, bb.xmax); }
    for (const m of state.moves) { const q = m.to || m.at; if (q) { zmin = Math.min(zmin, q.z); zmax = Math.max(zmax, q.z); xmax = Math.max(xmax, q.x); } }
    const xmin = state.mirror ? -xmax : -2;
    const sc = Math.min((W - 80) / Math.max(1, zmax - zmin), (H - 60) / Math.max(1, xmax - xmin));
    state.view.scale = sc; state.view.ox = (W - (zmax + zmin) * sc) / 2; state.view.oy = (H + (xmax + xmin) * sc) / 2;
    draw();
  }
  function niceStep(pxMin) { const raw = pxMin / state.view.scale; for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200]) if (s >= raw) return s; return 500; }

  function draw() {
    const c = cv(); const dpr = window.devicePixelRatio || 1; const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement); const col = n => css.getPropertyValue(n).trim();
    ctx.fillStyle = col('--canvas-bg'); ctx.fillRect(0, 0, W, H);
    const v = state.view; const p = state.project; const R = p.stock.diameter / 2;
    // grid
    const step = niceStep(45); const z0 = Math.floor(toWorld(0, 0).z / step) * step, z1 = toWorld(W, 0).z; const x0 = Math.floor(toWorld(0, H).x / step) * step, x1 = toWorld(0, 0).x;
    ctx.lineWidth = 1; ctx.font = '11px ' + css.getPropertyValue('--sans'); ctx.fillStyle = col('--muted');
    for (let z = z0; z <= z1; z += step) { const sx = Math.round(v.ox + z * v.scale) + 0.5; ctx.strokeStyle = Math.abs(z) < 1e-9 ? col('--grid-strong') : col('--grid'); ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke(); ctx.fillText(fmt(z, 2), sx + 3, H - 6); }
    for (let x = x0; x <= x1; x += step) { const sy = Math.round(v.oy - x * v.scale) + 0.5; ctx.strokeStyle = col('--grid'); ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke(); if (Math.abs(x) > 1e-9) ctx.fillText(fmt(x, 2), 4, sy - 3); }
    // stock
    const zF = p.stock.zFront, zB = -p.stock.length;
    const s1 = toScreen({ z: zB, x: R }), s2 = toScreen({ z: zF, x: 0 });
    ctx.fillStyle = col('--stock'); ctx.fillRect(s1.x, s1.y, s2.x - s1.x, s2.y - s1.y);
    ctx.strokeStyle = col('--stock-line'); ctx.setLineDash([4, 3]); ctx.strokeRect(s1.x + 0.5, s1.y + 0.5, s2.x - s1.x, s2.y - s1.y); ctx.setLineDash([]);
    if (state.mirror) { const m1 = toScreen({ z: zB, x: -R }); ctx.globalAlpha = 0.5; ctx.fillStyle = col('--stock'); ctx.fillRect(s1.x, s2.y, s2.x - s1.x, m1.y - s2.y); ctx.globalAlpha = 1; }
    // centreline
    const cy = Math.round(v.oy) + 0.5; ctx.strokeStyle = col('--axis'); ctx.setLineDash([10, 4, 2, 4]); ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke(); ctx.setLineDash([]);
    // face line Z0
    const fx = Math.round(v.ox) + 0.5; ctx.strokeStyle = col('--grid-strong'); ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, H); ctx.stroke();
    // DXF reference
    if (state.showDxf && state.dxf && state.dxf.result) { ctx.strokeStyle = col('--dxf'); ctx.lineWidth = 1; const S = q => { const s = toScreen(q); return [s.x, s.y]; }; for (const s of state.dxf.result.all) drawSeg(ctx, s, S); }
    // toolpath
    if (state.showPath && state.moves.length) drawToolpath(ctx, col);
    // profile
    const prof = p.profile.map(q => ({ z: +q.z || 0, x: +q.x || 0, seg: q.seg }));
    if (prof.length) {
      const poly = Geom.profileToPolyline(prof, 0.5 / v.scale);
      const strokePoly = (mirror) => { ctx.beginPath(); poly.forEach((q, i) => { const s = toScreen({ z: q.z, x: mirror ? -q.x : q.x }); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.stroke(); };
      if (state.mirror) { ctx.strokeStyle = col('--profile'); ctx.globalAlpha = 0.25; ctx.lineWidth = 1.5; strokePoly(true); ctx.globalAlpha = 1; }
      ctx.strokeStyle = col('--profile'); ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; strokePoly(false);
      prof.forEach((q, i) => {
        const s = toScreen(q); const sel = i === state.selected, hov = i === state.hoverPt;
        ctx.beginPath(); ctx.arc(s.x, s.y, sel ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = sel ? col('--accent') : col('--panel'); ctx.fill(); ctx.lineWidth = hov || sel ? 2 : 1.5; ctx.strokeStyle = col('--profile-pt'); ctx.stroke();
        if (sel || hov || v.scale > 12) { ctx.fillStyle = col('--muted'); ctx.font = '10.5px ' + css.getPropertyValue('--mono'); ctx.fillText(`${i + 1}`, s.x + 7, s.y - 6); }
      });
    }
    // cursor snap marker
    if (state.cursor && state.mode === 'add') { const s = toScreen(state.cursor); ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s.x - 8, s.y); ctx.lineTo(s.x + 8, s.y); ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x, s.y + 8); ctx.stroke(); }
    // start position marker
    const st = toScreen({ z: +p.settings.startZ || 0, x: (+p.settings.startDia || 0) / 2 });
    ctx.strokeStyle = col('--tool'); ctx.lineWidth = 1; ctx.beginPath(); ctx.rect(st.x - 4, st.y - 4, 8, 8); ctx.stroke();
  }

  function drawToolpath(ctx, col) {
    const moves = state.moves; const n = moves.length; const t = state.sim.t; const cutoff = t * n;
    const seg = (m, alpha, done) => {
      if (m.type !== 'rapid' && m.type !== 'feed' && m.type !== 'arc') return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = m.type === 'rapid' ? col('--rapid') : (done ? col('--feed-done') : col('--feed'));
      ctx.setLineDash(m.type === 'rapid' ? [5, 4] : []); ctx.lineWidth = m.type === 'rapid' ? 1 : 1.6;
      ctx.beginPath();
      const a = toScreen(m.from); ctx.moveTo(a.x, a.y);
      if (m.type === 'arc') Geom.sampleArc(m.arc, 0.5 / state.view.scale).forEach((q, i) => { if (i) { const s = toScreen(q); ctx.lineTo(s.x, s.y); } });
      else { const b = toScreen(m.to); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
    };
    for (let i = 0; i < n; i++) {
      const m = moves[i];
      if (t >= 1) { seg(m, m.type === 'rapid' ? 0.75 : 0.9, false); continue; }
      if (i + 1 <= cutoff) seg(m, m.type === 'rapid' ? 0.6 : 0.95, true);
      else if (i < cutoff) { // partial
        const f = cutoff - i; const partial = partialMove(m, f); if (partial) seg(partial, 0.95, true);
        seg(m, 0.18, false);
      } else seg(m, 0.18, false);
    }
    ctx.globalAlpha = 1; ctx.setLineDash([]);
    if (t < 1 || state.sim.playing) {
      const pos = toolPosition(); if (pos) { const s = toScreen(pos); ctx.fillStyle = col('--tool'); ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + 6, s.y + 14); ctx.lineTo(s.x + 14, s.y + 6); ctx.closePath(); ctx.fill(); ctx.strokeStyle = col('--panel'); ctx.lineWidth = 1; ctx.stroke(); }
    }
  }
  function partialMove(m, f) {
    if (m.type === 'arc') { const sub = Object.assign({}, m.arc, { sweep: m.arc.sweep * f, end: Geom.pointOnArc(m.arc, f) }); return { type: 'arc', from: m.from, to: sub.end, arc: sub }; }
    if (m.type === 'rapid' || m.type === 'feed') return { type: m.type, from: m.from, to: { z: m.from.z + (m.to.z - m.from.z) * f, x: m.from.x + (m.to.x - m.from.x) * f } };
    return null;
  }
  function toolPosition() {
    const moves = state.moves; const n = moves.length; if (!n) return null;
    const cutoff = Math.min(n, state.sim.t * n); const i = Math.min(n - 1, Math.floor(cutoff)); const f = cutoff - i;
    const m = moves[i];
    if (m.type === 'arc') return Geom.pointOnArc(m.arc, Math.min(1, f));
    if (m.to) return { z: m.from.z + (m.to.z - m.from.z) * Math.min(1, f), x: m.from.x + (m.to.x - m.from.x) * Math.min(1, f) };
    return m.at || null;
  }
  function currentBlockInfo() {
    const n = state.moves.length; if (!n || state.sim.t >= 1) return '';
    const i = Math.min(n - 1, Math.floor(state.sim.t * n)); const m = state.moves[i]; const b = m.block;
    return b ? 'N' + String(b.n).padStart(2, '0') + ' ' + (b.m != null ? 'M' + String(b.m).padStart(2, '0') : 'G' + String(b.g).padStart(2, '0')) : '';
  }

  /* ---------- canvas interaction ---------- */
  function snapWorld(w) {
    let q = { z: w.z, x: w.x };
    if (state.snap > 0) { q.z = Math.round(q.z / state.snap) * state.snap; q.x = Math.round(q.x / state.snap) * state.snap; }
    if (state.showDxf && state.dxf && state.dxf.result) {
      const tolPx = 10 / state.view.scale; let best = null, bd = tolPx;
      for (const s of state.dxf.result.all) for (const e of [s.a, s.b]) { const d = Math.hypot(e.z - w.z, e.x - w.x); if (d < bd) { bd = d; best = e; } }
      if (best) q = { z: best.z, x: best.x };
    }
    if (Math.abs(q.x) < (state.snap || 0.05)) q.x = 0;
    q.x = Math.max(0, q.x);
    return q;
  }
  function hitPoint(sx, sy) {
    let best = -1, bd = 9;
    state.project.profile.forEach((p, i) => { const s = toScreen({ z: +p.z || 0, x: +p.x || 0 }); const d = Math.hypot(s.x - sx, s.y - sy); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function bindCanvas() {
    const c = cv();
    let rebuildTimer = null;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => {
      e.preventDefault(); const rect = c.getBoundingClientRect(); const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const w = toWorld(sx, sy); const k = e.deltaY < 0 ? 1.15 : 1 / 1.15; state.view.scale = Math.min(400, Math.max(0.5, state.view.scale * k));
      state.view.ox = sx - w.z * state.view.scale; state.view.oy = sy + w.x * state.view.scale; draw();
    }, { passive: false });
    c.addEventListener('pointerdown', e => {
      const rect = c.getBoundingClientRect(); const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      c.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2 || state.mode === 'pan') { state.drag = { kind: 'pan', sx, sy, ox: state.view.ox, oy: state.view.oy }; c.classList.add('dragging'); return; }
      if (state.mode === 'add') {
        const q = snapWorld(toWorld(sx, sy)); pushUndo();
        const prof = state.project.profile; const at = state.selected >= 0 ? state.selected + 1 : prof.length;
        prof.splice(at, 0, { z: q.z, x: q.x, seg: { type: 'line' } }); state.selected = at; commit(false); return;
      }
      const hit = hitPoint(sx, sy);
      if (hit >= 0) { state.selected = hit; pushUndo(); state.drag = { kind: 'point', idx: hit, moved: false }; renderProfileTable(); draw(); return; }
      state.selected = -1; state.drag = { kind: 'pan', sx, sy, ox: state.view.ox, oy: state.view.oy }; c.classList.add('dragging'); renderProfileTable(); draw();
    });
    c.addEventListener('pointermove', e => {
      const rect = c.getBoundingClientRect(); const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const w = toWorld(sx, sy);
      state.cursor = state.mode === 'add' ? snapWorld(w) : w;
      updateStatus();
      if (state.drag && state.drag.kind === 'pan') { state.view.ox = state.drag.ox + (sx - state.drag.sx); state.view.oy = state.drag.oy + (sy - state.drag.sy); draw(); return; }
      if (state.drag && state.drag.kind === 'point') {
        const q = snapWorld(w); const p = state.project.profile[state.drag.idx]; p.z = q.z; p.x = q.x; state.drag.moved = true;
        draw(); clearTimeout(rebuildTimer); rebuildTimer = setTimeout(() => { rebuild(); renderProgram(); draw(); }, 120); return;
      }
      const h = hitPoint(sx, sy); if (h !== state.hoverPt) { state.hoverPt = h; draw(); } else if (state.mode === 'add') draw();
    });
    const end = e => {
      if (!state.drag) return;
      const d = state.drag; state.drag = null; c.classList.remove('dragging');
      if (d.kind === 'point') { if (d.moved) commit(false); else state.undo.pop(); }
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { state.cursor = null; state.hoverPt = -1; updateStatus(); draw(); });
    new ResizeObserver(() => draw()).observe(c);
    // toolbar
    const setMode = m => { state.mode = m; ['modeSelect', 'modeAdd', 'modePan'].forEach(id => $(id).classList.toggle('active', id === 'mode' + m[0].toUpperCase() + m.slice(1))); c.className = m === 'pan' ? 'pan' : ''; $('stHint').textContent = m === 'add' ? 'Click to add a point after the selected one (or at the end). Esc = select mode.' : m === 'pan' ? 'Drag to pan.' : 'Drag points to move them. Wheel = zoom, drag empty space = pan.'; };
    $('modeSelect').addEventListener('click', () => setMode('select')); $('modeAdd').addEventListener('click', () => setMode('add')); $('modePan').addEventListener('click', () => setMode('pan'));
    $('snapSel').addEventListener('change', () => { state.snap = parseFloat($('snapSel').value); });
    $('chkDxf').addEventListener('change', () => { state.showDxf = $('chkDxf').checked; draw(); });
    $('chkPath').addEventListener('change', () => { state.showPath = $('chkPath').checked; draw(); });
    $('chkMirror').addEventListener('change', () => { state.mirror = $('chkMirror').checked; draw(); });
    $('btnFit').addEventListener('click', fitView);
    $('simRange').addEventListener('input', () => { stopSim(); state.sim.t = $('simRange').value / 1000; draw(); updateStatus(); });
    $('btnPlay').addEventListener('click', () => { if (state.sim.playing) stopSim(); else startSim(); });
    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || tag === 'select' || document.querySelector('dialog[open]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (e.key === 'Escape') { setMode('select'); return; }
      if (e.key.toLowerCase() === 'a') setMode('add'); else if (e.key.toLowerCase() === 's') setMode('select'); else if (e.key.toLowerCase() === 'p') setMode('pan'); else if (e.key.toLowerCase() === 'f') fitView();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) { pushUndo(); state.project.profile.splice(state.selected, 1); state.selected = Math.min(state.selected, state.project.profile.length - 1); commit(false); }
      else if (e.key === ' ') { e.preventDefault(); state.sim.playing ? stopSim() : startSim(); }
    });
    setMode('select');
  }
  function startSim() {
    if (!state.moves.length) return;
    if (state.sim.t >= 1) state.sim.t = 0;
    state.sim.playing = true; $('btnPlay').textContent = '❚❚ Pause'; state.sim.last = performance.now();
    const step = now => {
      if (!state.sim.playing) return;
      const dt = (now - state.sim.last) / 1000; state.sim.last = now;
      state.sim.t = Math.min(1, state.sim.t + dt / Math.max(4, state.moves.length * 0.08));
      $('simRange').value = Math.round(state.sim.t * 1000); draw(); updateStatus();
      if (state.sim.t >= 1) { stopSim(); return; }
      state.sim.raf = requestAnimationFrame(step);
    };
    state.sim.raf = requestAnimationFrame(step);
  }
  function stopSim() { state.sim.playing = false; $('btnPlay').textContent = '▶ Simulate'; if (state.sim.raf) cancelAnimationFrame(state.sim.raf); draw(); }
  function updateStatus() {
    const c = state.cursor;
    $('stZ').textContent = c ? fmt(c.z, 2) : '–'; $('stX').textContent = c ? fmt(c.x, 2) : '–'; $('stD').textContent = c ? fmt(c.x * 2, 2) : '–';
    $('simInfo').textContent = state.sim.t < 1 ? currentBlockInfo() : '';
  }

  /* ---------- tabs, theme, resizer, help ---------- */
  function showTab(name) { document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name)); document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name)); }
  function bindChrome() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    let ui = {}; try { ui = JSON.parse(localStorage.getItem(LS_UI) || '{}'); } catch (e) { /* ignore */ }
    const applyTheme = t => { document.documentElement.dataset.theme = t; ui.theme = t; try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch (e) { /* ignore */ } draw(); };
    applyTheme(ui.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    $('btnTheme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    if (ui.sidebar) $('sidebar').style.width = ui.sidebar + 'px';
    const rz = $('resizer'); let rs = null;
    rz.addEventListener('pointerdown', e => { rs = { x: e.clientX, w: $('sidebar').offsetWidth }; rz.setPointerCapture(e.pointerId); });
    rz.addEventListener('pointermove', e => { if (!rs) return; const w = Math.max(300, Math.min(window.innerWidth * 0.6, rs.w + e.clientX - rs.x)); $('sidebar').style.width = w + 'px'; ui.sidebar = w; });
    rz.addEventListener('pointerup', () => { rs = null; try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch (e) { /* ignore */ } draw(); });
    $('btnHelp').addEventListener('click', () => $('dlgHelp').showModal());
    $('helpClose').addEventListener('click', () => $('dlgHelp').close());
  }

  /* ---------- init ---------- */
  function init() {
    try { const saved = localStorage.getItem(LS_PROJECT); if (saved) state.project = Object.assign(defaultProject(), JSON.parse(saved)); } catch (e) { /* ignore */ }
    loadSerial();
    bindSetup(); bindProfileTable(); bindOps(); bindProgram(); bindSerial(); bindFiles(); bindDxfDialog(); bindCanvas(); bindChrome();
    renderSerial(); restoreDxfRef(); rebuild(); renderAll();
    requestAnimationFrame(fitView);
  }
  document.addEventListener('DOMContentLoaded', init);
})();
