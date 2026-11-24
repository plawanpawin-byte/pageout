// Page tools: crop, paper size, insert, split, order, blank pages, picture, stamp, header and footer, link, replace text.
import { modal, fld, note, sel as selectEl, num, txt, parseRange, baseName, todayStr, imageToPngDataUrl, mapAnn, blobBytes } from './x-util.js';

export function initPages(X, c) {
  const { h, btn, toast } = c;
  const { PDFDocument, degrees } = c.PDFLib;
  const PAPER = { A3: [841.89, 1190.55], A4: [595.28, 841.89], A5: [419.53, 595.28], A6: [297.64, 419.53], B5: [498.9, 708.66], Letter: [612, 792], Legal: [612, 1008], Tabloid: [792, 1224] };

  const scopeUI = () => {
    const s = selectEl(c, [['all', 'All pages'], ['cur', 'Current page'], ['sel', 'Selected pages'], ['odd', 'Odd pages'], ['even', 'Even pages'], ['range', 'Page range']], 'all');
    const r = txt(c, '', 'for example 1-3, 7'); r.style.display = 'none';
    s.onchange = () => { r.style.display = s.value === 'range' ? '' : 'none'; };
    const get = () => {
      const n = c.pages.length;
      if (s.value === 'cur') return [c.curPage];
      if (s.value === 'sel') { const ix = c.pages.map((p, i) => (c.sel.has(p.id) ? i : -1)).filter((i) => i >= 0); return ix.length ? ix : [c.curPage]; }
      if (s.value === 'odd') return c.pages.map((_, i) => i).filter((i) => i % 2 === 0);
      if (s.value === 'even') return c.pages.map((_, i) => i).filter((i) => i % 2 === 1);
      if (s.value === 'range') return parseRange(r.value, n);
      return c.pages.map((_, i) => i);
    };
    return { els: [fld(c, 'Pages', s), r], get, select: s };
  };
  const need = () => { if (!c.pages.length) { toast('Open a PDF first'); return false; } return true; };

  // builds a new source document that holds the given pages after `perPage` changed each copy; swaps the pages over to it
  // The other pages of the same files move to the new document too, unchanged: a form field can sit on several
  // pages, and pages left on the old file would keep their own copy of it (values typed there were lost on save).
  async function swapSource(entries, build, after) {
    const out = await PDFDocument.create(); const cache = new Map(); const info = []; const keyMap = new Map();
    const srcs = new Set(entries.map((p) => p.src)), chosen = new Set(entries);
    const all = c.pages.filter((p) => p.src && srcs.has(p.src) && !chosen.has(p)).concat(entries);
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      if (!cache.has(p.src)) { const ent = c.sources.get(p.src); cache.set(p.src, c.markSource((await c.withFormValues(ent)) || await PDFDocument.load(ent.bytes, { ignoreEncryption: true }), p.src)); }
      const n0 = out.getPageCount();
      if (chosen.has(p)) info[i] = await build(out, cache.get(p.src), p, i);
      else out.addPage(await c.copyPage(out, cache.get(p.src), p.index));
      const made = out.getPages().slice(n0);
      if (made.length && !keyMap.has(p.src + ':' + p.index)) keyMap.set(p.src + ':' + p.index, made[0].ref);
      // keep form fields (and their current values) on the rebuilt pages
      for (const pg of made) c.keepFormFields(out, pg, cache.get(p.src));
    }
    c.pruneCopies(out, keyMap);
    const bytes = new Uint8Array(await out.save({ updateFieldAppearances: false }));
    const id = await c.addSource(c.fileName || 'document.pdf', bytes); const ps = await c.pagesOf(id);
    all.forEach((p, i) => { if (chosen.has(p)) after(p, info[i]); p.src = id; p.index = i; p.w = ps[i].w; p.h = ps[i].h; p.r0 = ps[i].r0; });
  }
  const remapOcr = (p, k) => {
    if (!p.ocr) return;
    for (const l of p.ocr.lines) {
      const a = c.rotInv(l.x0, l.y0, p.rot), b = c.rotInv(l.x1, l.y1, p.rot);
      const m = (q) => [k.ax * q[0] + k.bx, k.ay * q[1] + k.by];
      const a2 = c.rotFwd(...m(a), p.rot), b2 = c.rotFwd(...m(b), p.rot);
      l.x0 = Math.min(a2[0], b2[0]); l.x1 = Math.max(a2[0], b2[0]); l.y0 = Math.min(a2[1], b2[1]); l.y1 = Math.max(a2[1], b2[1]);
    }
  };

  // ---------- crop ----------
  const baseMargins = (p, m) => {
    const a = c.rotInv(m.l, m.t, p.rot), b = c.rotInv(1 - m.r, 1 - m.b, p.rot);
    return { l: Math.min(a[0], b[0]), r: 1 - Math.max(a[0], b[0]), t: Math.min(a[1], b[1]), b: 1 - Math.max(a[1], b[1]) };
  };
  async function applyCrop(idx, m) {
    const entries = idx.map((i) => c.pages[i]).filter((p) => p && p.src);
    if (!entries.length) { toast('Nothing to crop'); return 0; }
    c.commit();
    await swapSource(entries, async (out, src, p) => {
      const pg = await c.copyPage(out, src, p.index); out.addPage(pg);
      const cb = pg.getCropBox(), k = baseMargins(p, m);
      const A = c.dispToPdf({ w: cb.width, h: cb.height, r0: p.r0 }, k.l, k.t, cb), B = c.dispToPdf({ w: cb.width, h: cb.height, r0: p.r0 }, 1 - k.r, 1 - k.b, cb);
      pg.setCropBox(Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]));
      return k;
    }, (p, k) => {
      const fx = 1 - k.l - k.r, fy = 1 - k.t - k.b, map = { ax: 1 / fx, bx: -k.l / fx, ay: 1 / fy, by: -k.t / fy };
      p.annots.forEach((a) => mapAnn(a, map)); remapOcr(p, map);
    });
    c.fullRender(); return entries.length;
  }
  async function autoTrim(p) {
    const cv = await c.pageCanvas(p, 0.7), g = cv.getContext('2d', { willReadFrequently: true }), W = cv.width, H = cv.height, d = g.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 690) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    if (x1 < 0) return null;
    const pad = 0.012;
    return { l: Math.max(0, x0 / W - pad), t: Math.max(0, y0 / H - pad), r: Math.max(0, 1 - (x1 + 1) / W - pad), b: Math.max(0, 1 - (y1 + 1) / H - pad) };
  }
  X.crop = async () => {
    if (!need()) return;
    const p0 = c.pages[c.curPage]; if (!p0.src) { toast('This page is blank, there is nothing to crop'); return; }
    const cv = await c.pageCanvas(p0, 0.55); const view = h('canvas', { style: 'max-width:100%;max-height:34vh;align-self:center;border-radius:6px;background:#fff' }); view.width = cv.width; view.height = cv.height;
    const inp = {}; const m = { l: 0, t: 0, r: 0, b: 0 };
    const draw = () => {
      const g = view.getContext('2d'); g.drawImage(cv, 0, 0); g.fillStyle = 'rgba(20,30,50,.55)';
      const W = view.width, H = view.height;
      g.fillRect(0, 0, W, m.t * H); g.fillRect(0, H - m.b * H, W, m.b * H); g.fillRect(0, m.t * H, m.l * W, H - (m.t + m.b) * H); g.fillRect(W - m.r * W, m.t * H, m.r * W, H - (m.t + m.b) * H);
      g.strokeStyle = '#a8c7fa'; g.lineWidth = 2; g.strokeRect(m.l * W, m.t * H, W - (m.l + m.r) * W, H - (m.t + m.b) * H);
    };
    const mk = (k, name) => { inp[k] = num(c, 0, 0, 45, 0.5); inp[k].oninput = () => { m[k] = Math.min(0.45, Math.max(0, (+inp[k].value || 0) / 100)); draw(); }; return fld(c, name + ' (%)', inp[k]); };
    const sc = scopeUI();
    const setAll = () => { for (const k of ['l', 't', 'r', 'b']) inp[k].value = Math.round(m[k] * 1000) / 10; draw(); };
    modal(c, 'Crop pages', [note(c, 'Trim the margins. The page shows only what is left, but the trimmed part can still be inside the file. To hide private details for good, use Redact. Form fields on cropped pages become flat.'), view,
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' }, mk('t', 'Top'), mk('b', 'Bottom'), mk('l', 'Left'), mk('r', 'Right')),
      btn('Trim white edges automatically', async () => { const a = await autoTrim(p0); if (!a) { toast('This page has no content to trim around'); return; } Object.assign(m, a); setAll(); }), ...sc.els],
    (close) => [btn('Cancel', close), btn('Crop', async () => {
      if (!(m.l || m.t || m.r || m.b)) { toast('Set at least one margin first'); return; }
      close(); try { const n = await applyCrop(sc.get(), m); if (n) toast(`Cropped ${n} page${n === 1 ? '' : 's'}`); } catch (e) { toast('Crop failed: ' + (e.message || e)); }
    }, 'primary')]);
    draw();
  };
  X._crop = applyCrop;

  // ---------- paper size ----------
  X.pageSize = () => {
    if (!need()) return;
    const paper = selectEl(c, [...Object.keys(PAPER).map((k) => [k, k]), ['custom', 'Custom size']], 'A4');
    const orient = selectEl(c, [['keep', 'Keep each page upright or sideways'], ['portrait', 'Upright (portrait)'], ['landscape', 'Sideways (landscape)']], 'keep');
    const cw = num(c, 210, 20, 2000), ch = num(c, 297, 20, 2000); const cust = h('div', { style: 'display:none;grid-template-columns:1fr 1fr;gap:8px' }, fld(c, 'Width (mm)', cw), fld(c, 'Height (mm)', ch));
    paper.onchange = () => { cust.style.display = paper.value === 'custom' ? 'grid' : 'none'; };
    const sc = scopeUI();
    modal(c, 'Paper size', [note(c, 'Each page is shrunk or grown to fit the new paper and centred. Form fields and links on resized pages become flat.'), fld(c, 'Paper', paper), cust, fld(c, 'Direction', orient), ...sc.els], (close) => [btn('Cancel', close), btn('Resize', async () => {
      const mm = (v) => (v * 72) / 25.4; const dims = paper.value === 'custom' ? [mm(+cw.value || 210), mm(+ch.value || 297)] : PAPER[paper.value];
      const idx = sc.get(); close();
      try {
        const entries = idx.map((i) => c.pages[i]); c.commit();
        const withSrc = entries.filter((p) => p.src);
        const fit = (p) => { const [wd, hd] = (p.r0 % 180) ? [p.h, p.w] : [p.w, p.h]; let [a, b] = [Math.min(...dims), Math.max(...dims)]; const land = orient.value === 'landscape' || (orient.value === 'keep' && wd > hd); const [Wd, Hd] = land ? [b, a] : [a, b]; return { wd, hd, Wd, Hd, s: Math.min(Wd / wd, Hd / hd) }; };
        if (withSrc.length) await swapSource(withSrc, async (out, src, p) => {
          const sp = src.getPage(p.index), cb = sp.getCropBox(), f = fit(p);
          const emb = await out.embedPage(sp, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
          const [Wu, Hu] = (p.r0 % 180) ? [f.Hd, f.Wd] : [f.Wd, f.Hd];
          const pg = out.addPage([Wu, Hu]); pg.drawPage(emb, { x: (Wu - cb.width * f.s) / 2, y: (Hu - cb.height * f.s) / 2, xScale: f.s, yScale: f.s });
          if (p.r0) pg.setRotation(degrees(p.r0));
          return f;
        }, (p, f) => {
          const map = { ax: (f.wd * f.s) / f.Wd, bx: (f.Wd - f.wd * f.s) / 2 / f.Wd, ay: (f.hd * f.s) / f.Hd, by: (f.Hd - f.hd * f.s) / 2 / f.Hd };
          p.annots.forEach((a) => mapAnn(a, map)); remapOcr(p, map);
        });
        for (const p of entries.filter((q) => !q.src)) { const f = fit(p); p.w = f.Wd; p.h = f.Hd; p.r0 = 0; }
        c.fullRender(); toast(`Resized ${entries.length} page${entries.length === 1 ? '' : 's'}`);
      } catch (e) { toast('Resize failed: ' + (e.message || e)); }
    }, 'primary')]);
  };

  // ---------- insert pages ----------
  X.insertPages = async () => {
    if (!need()) return;
    const files = await c.host.openFiles({ multi: true, filters: [['PDF files and pictures', ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']]] });
    if (!files.length) return;
    const where = selectEl(c, [['after', 'After the current page'], ['before', 'Before the current page'], ['start', 'At the start'], ['end', 'At the end'], ['num', 'After page number']], 'after');
    const n = num(c, c.curPage + 1, 1, c.pages.length); n.style.display = 'none'; where.onchange = () => { n.style.display = where.value === 'num' ? '' : 'none'; };
    modal(c, 'Insert pages', [note(c, files.map((f) => f.name).join(', ')), fld(c, 'Put them', where), n], (close) => [btn('Cancel', close), btn('Insert', async () => {
      close(); c.commit(); const add = [];
      for (const f of files) { try { let b = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data); if (/\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)) b = await c.imageToPdf(b, /\.jpe?g$/i.test(f.name)); const id = await c.addSource(f.name.replace(/\.[^.]+$/, '.pdf'), b); add.push(...await c.pagesOf(id)); } catch (e) { toast(`Cannot add ${f.name}: ${e.message || e}`); } }
      if (!add.length) return;
      const at = where.value === 'after' ? c.curPage + 1 : where.value === 'before' ? c.curPage : where.value === 'start' ? 0 : where.value === 'end' ? c.pages.length : Math.min(c.pages.length, Math.max(0, (+n.value || 0)));
      const list = c.pages.slice(); list.splice(at, 0, ...add); c.pages = list; c.fullRender(); toast(`Added ${add.length} page${add.length === 1 ? '' : 's'}`);
    }, 'primary')]);
  };

  // ---------- split ----------
  X.split = () => {
    if (!need()) return;
    const mode = selectEl(c, [['every', 'Every N pages'], ['ranges', 'Page ranges'], ['each', 'One file per page'], ['marks', 'At each top level bookmark']], 'every');
    const nIn = num(c, 5, 1, 9999), rg = txt(c, '1-3, 4-6, 7-'); const nBox = fld(c, 'Pages in each file', nIn), rBox = fld(c, 'Ranges, separated by commas', rg); rBox.style.display = 'none';
    mode.onchange = () => { nBox.style.display = mode.value === 'every' ? '' : 'none'; rBox.style.display = mode.value === 'ranges' ? '' : 'none'; };
    modal(c, 'Split into several files', [note(c, 'You choose a folder next. Each part is saved there as its own PDF.'), fld(c, 'Split by', mode), nBox, rBox], (close) => [btn('Cancel', close), btn('Split', async () => {
      const N = c.pages.length; let parts = [];
      if (mode.value === 'every') { const k = Math.max(1, +nIn.value || 1); for (let i = 0; i < N; i += k) parts.push(Array.from({ length: Math.min(k, N - i) }, (_, j) => i + j)); }
      else if (mode.value === 'each') parts = c.pages.map((_, i) => [i]);
      else if (mode.value === 'ranges') parts = rg.value.split(',').map((s) => parseRange(s, N)).filter((a) => a.length);
      else { const at = c.outline.filter((o) => o.level === 0).map((o) => c.pages.findIndex((p) => p.id === o.pid)).filter((i) => i >= 0).sort((a, b) => a - b); const cuts = [...new Set([0, ...at])]; cuts.forEach((s, j) => { const e = (cuts[j + 1] ?? N); parts.push(Array.from({ length: e - s }, (_, q) => s + q)); }); }
      if (!parts.length) { toast('Nothing to split. Check the ranges.'); return; }
      close();
      try {
        const items = [];
        for (let k = 0; k < parts.length; k++) { const ix = parts[k]; items.push({ name: `${baseName(c.fileName)}-part${k + 1}-p${ix[0] + 1}${ix.length > 1 ? '-' + (ix[ix.length - 1] + 1) : ''}.pdf`, data: await c.buildPdf(ix.map((i) => c.pages[i])) }); }
        const r = await c.host.saveMany({ items });
        if (r) toast(`Saved ${r.count} file${r.count === 1 ? '' : 's'}`);
      } catch (e) { toast('Split failed: ' + (e.message || e)); }
    }, 'primary')]);
  };

  // ---------- order and selection ----------
  X.reverse = () => { if (!need()) return; c.commit(); c.pages = c.pages.slice().reverse(); c.fullRender(); toast('Page order reversed'); };
  X.selOdd = () => { if (!need()) return; c.sel = new Set(c.pages.filter((_, i) => i % 2 === 0).map((p) => p.id)); c.renderThumbs(); toast('Odd pages selected. Use Delete, Copy or Extract.'); };
  X.selEven = () => { if (!need()) return; c.sel = new Set(c.pages.filter((_, i) => i % 2 === 1).map((p) => p.id)); c.renderThumbs(); toast('Even pages selected. Use Delete, Copy or Extract.'); };
  X.findBlank = async () => {
    if (!need()) return;
    toast('Looking for empty pages...');
    const blanks = [];
    for (let i = 0; i < c.pages.length; i++) {
      const p = c.pages[i]; if (p.annots.length || p.ocr) continue;
      const cv = await c.pageCanvas(p, 0.35), d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data; let dark = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] + d[k + 1] + d[k + 2] < 640) dark++;
      if (dark / (d.length / 4) < 0.0006) blanks.push(i);
    }
    if (!blanks.length) { toast('No empty pages found'); return; }
    modal(c, `${blanks.length} empty page${blanks.length === 1 ? '' : 's'} found`, [note(c, 'Page ' + blanks.map((i) => i + 1).join(', '))], (close) => [btn('Close', close),
      btn('Select them', () => { c.sel = new Set(blanks.map((i) => c.pages[i].id)); c.renderThumbs(); close(); }),
      btn('Delete them', () => { if (blanks.length >= c.pages.length) { toast('A document needs at least one page'); return; } c.commit(); const gone = new Set(blanks.map((i) => c.pages[i].id)); c.pages = c.pages.filter((p) => !gone.has(p.id)); c.sel = new Set(); close(); c.fullRender(); toast('Empty pages deleted'); }, 'primary')]);
  };

  // ---------- picture, stamp ----------
  const placeImage = (url, iw, ih, widthFrac) => {
    const p = c.pages[c.curPage], [dw, dh] = c.dispDims(p), bw = widthFrac, bh = bw * (ih / iw) * (dw / dh);
    c.commit(); const k = bh > 0.95 ? 0.95 / bh : 1; p.annots.push(c.mkAnn({ type: 'image', x: Math.max(0, 0.5 - (bw * k) / 2), y: Math.max(0, 0.5 - (bh * k) / 2), bw: bw * k, bh: bh * k, data: url }));
    c.redrawOverlays(); c.setTool('select');
  };
  X.insertImage = async () => {
    if (!need()) return;
    const f = await c.host.openFiles({ multi: false, filters: [['Pictures', ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']]] }); if (!f.length) return;
    try { const im = await imageToPngDataUrl(f[0].data instanceof Uint8Array ? f[0].data : new Uint8Array(f[0].data)); placeImage(im.url, im.w, im.h, 0.35); toast('Picture added. Drag it, or drag the corner to resize.'); } catch (e) { toast('Cannot read that picture: ' + (e.message || e)); }
  };
  const STAMPS = ['APPROVED', 'DRAFT', 'CONFIDENTIAL', 'PAID', 'RECEIVED', 'VOID', 'COPY', 'ORIGINAL', 'URGENT', 'REVIEWED', 'อนุมัติแล้ว', 'ชำระเงินแล้ว', 'สำเนา', 'ลับ', 'ด่วน', 'ต้นฉบับ'];
  X.stamp = () => {
    if (!need()) return;
    const pick = selectEl(c, STAMPS.map((s) => [s, s]), 'APPROVED'), own = txt(c, '', 'or type your own words');
    const col = selectEl(c, [['#c0392b', 'Red'], ['#1e7a46', 'Green'], ['#1f5fbf', 'Blue'], ['#333333', 'Black']], '#c0392b');
    const dt = h('input', { type: 'checkbox' }); dt.checked = true;
    const prev = h('canvas', { style: 'max-width:100%;background:#fff;border-radius:6px;padding:8px' });
    const render = () => {
      const text = (own.value.trim() || pick.value), sub = dt.checked ? todayStr() : '';
      const f1 = '700 64px "Segoe UI","Leelawadee UI",Arial,sans-serif', f2 = '500 30px "Segoe UI","Leelawadee UI",Arial,sans-serif';
      const m = document.createElement('canvas').getContext('2d'); m.font = f1; const w1 = m.measureText(text).width; m.font = f2; const w2 = sub ? m.measureText(sub).width : 0;
      const W = Math.ceil(Math.max(w1, w2)) + 70, H = sub ? 160 : 120, ang = (-10 * Math.PI) / 180;
      const cvW = Math.ceil(Math.abs(W * Math.cos(ang)) + Math.abs(H * Math.sin(ang))) + 12, cvH = Math.ceil(Math.abs(W * Math.sin(ang)) + Math.abs(H * Math.cos(ang))) + 12;
      prev.width = cvW; prev.height = cvH; const g = prev.getContext('2d'); g.clearRect(0, 0, cvW, cvH); g.translate(cvW / 2, cvH / 2); g.rotate(ang);
      g.strokeStyle = col.value; g.fillStyle = col.value; g.lineWidth = 7; g.beginPath(); g.roundRect(-W / 2, -H / 2, W, H, 16); g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = f1; g.fillText(text, 0, sub ? -20 : 0); if (sub) { g.font = f2; g.fillText(sub, 0, 36); }
    };
    [pick, own, col, dt].forEach((e) => { e.oninput = render; e.onchange = render; });
    modal(c, 'Stamp', [fld(c, 'Stamp', pick), own, fld(c, 'Colour', col), h('label', { class: 'row' }, dt, h('span', { text: 'Add today\'s date' })), prev], (close) => [btn('Cancel', close), btn('Place on page', () => {
      render(); const url = prev.toDataURL('image/png'); close(); placeImage(url, prev.width, prev.height, Math.min(0.5, Math.max(0.18, prev.width / 1000))); toast('Stamp placed. Drag it where you want it.');
    }, 'primary')]);
    render();
  };

  // ---------- quick marks: tick, cross, dot, date ----------
  X.quickMarks = () => {
    if (!need()) return;
    const MARKS = [['✓', 'Tick'], ['✗', 'Cross'], ['●', 'Dot'], ['○', 'Circle'], ['★', 'Star'], ['→', 'Arrow'], [todayStr(), 'The date']];
    const col = selectEl(c, [['#111111', 'Black'], ['#c0392b', 'Red'], ['#1e7a46', 'Green'], ['#1f5fbf', 'Blue']], '#111111');
    const row = h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' });
    const make = (ch, color) => {
      const date = ch.length > 1, cv = document.createElement('canvas'), g = cv.getContext('2d'), font = (date ? '500 54px' : '700 96px') + ' "Segoe UI Symbol","Segoe UI","Leelawadee UI",Arial,sans-serif';
      g.font = font; const w = Math.ceil(g.measureText(ch).width) + 16, hh = date ? 80 : 130; cv.width = w; cv.height = hh;
      const g2 = cv.getContext('2d'); g2.font = font; g2.fillStyle = color; g2.textBaseline = 'middle'; g2.textAlign = 'center'; g2.fillText(ch, w / 2, hh / 2 + 4);
      return { url: cv.toDataURL('image/png'), w, h: hh, date };
    };
    let dlg;
    for (const [ch, name] of MARKS) row.append(h('button', { class: 'btn', title: name, style: 'min-width:48px;font-size:' + (ch.length > 1 ? '13px' : '20px'), text: ch, onclick: () => { const m = make(ch, col.value); dlg.close(); placeImage(m.url, m.w, m.h, m.date ? 0.2 : 0.035); toast('Placed. Drag it where you want it.'); } }));
    dlg = modal(c, 'Marks', [note(c, 'Pick a mark, then drag it onto the page. Good for forms that have no fill-in fields.'), fld(c, 'Colour', col), row], (close) => [btn('Close', close)]);
  };

  // ---------- header, footer, Bates ----------
  X.headerFooter = () => {
    if (!need()) return;
    const f = {}; const mk = (k, name, v = '') => { f[k] = txt(c, v); return fld(c, name, f[k]); };
    const size = num(c, 2.2, 1, 6, 0.1), colr = selectEl(c, [['#333333', 'Dark grey'], ['#000000', 'Black'], ['#808080', 'Grey'], ['#1f5fbf', 'Blue'], ['#c0392b', 'Red']], '#333333');
    const pre = txt(c, '', 'for example CASE-'), st = num(c, 1, 0, 99999999), dg = num(c, 6, 1, 10);
    const grid = (...e) => h('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px' }, ...e);
    modal(c, 'Header and footer', [note(c, 'Use {page}, {pages}, {date}, {file} and {bates} inside the text. Leave a box empty to skip it.'),
      h('b', { text: 'Header' }), grid(mk('hl', 'Left'), mk('hc', 'Centre'), mk('hr', 'Right')), h('b', { text: 'Footer' }), grid(mk('fl', 'Left'), mk('fc', 'Centre', 'Page {page} of {pages}'), mk('fr', 'Right')),
      grid(fld(c, 'Size', size), fld(c, 'Colour', colr), fld(c, 'Bates prefix', pre)), grid(fld(c, 'Bates first number', st), fld(c, 'Bates digits', dg), h('span'))],
    (close) => [btn('Remove', () => { c.commit(); c.pages.forEach((p) => { p.annots = p.annots.filter((a) => a.tag !== 'hf'); }); c.redrawOverlays(); close(); toast('Header and footer removed'); }), btn('Cancel', close), btn('Add', () => {
      c.commit(); const N = c.pages.length, fs = (+size.value || 2.2) / 100, date = todayStr(), file = baseName(c.fileName);
      c.pages.forEach((p, i) => {
        p.annots = p.annots.filter((a) => a.tag !== 'hf'); const [bw, bh] = c.dispDims(p);
        const bates = (pre.value || '') + String((+st.value || 0) + i).padStart(+dg.value || 6, '0');
        for (const [k, y, al] of [['hl', 0.03, 'l'], ['hc', 0.03, 'c'], ['hr', 0.03, 'r'], ['fl', 0.97 - (fs * bw) / bh, 'l'], ['fc', 0.97 - (fs * bw) / bh, 'c'], ['fr', 0.97 - (fs * bw) / bh, 'r']]) {
          const t = f[k].value.trim(); if (!t) continue;
          const text = t.replace(/\{page\}/g, i + 1).replace(/\{pages\}/g, N).replace(/\{date\}/g, date).replace(/\{file\}/g, () => file).replace(/\{bates\}/g, () => bates);
          p.annots.push(c.mkAnn({ type: 'text', tag: 'hf', text, fs, x: al === 'l' ? 0.06 : al === 'c' ? 0.5 : 0.94, y, mid: al === 'c', al: al === 'r' ? 'r' : undefined, color: colr.value }));
        }
      });
      c.redrawOverlays(); close(); toast('Header and footer added');
    }, 'primary')]);
  };

  // ---------- link ----------
  X.editLink = (ann, p) => {
    const url = txt(c, ann.url || '', 'https://example.com'), pg = num(c, 1, 1, c.pages.length); const kind = selectEl(c, [['url', 'A web address'], ['page', 'A page in this document']], 'url');
    const uBox = fld(c, 'Web address', url), pBox = fld(c, 'Go to page', pg); pBox.style.display = 'none';
    kind.onchange = () => { uBox.style.display = kind.value === 'url' ? '' : 'none'; pBox.style.display = kind.value === 'page' ? '' : 'none'; };
    const drop = () => { p.annots = p.annots.filter((q) => q !== ann); c.redrawOverlays(); };
    const m = modal(c, 'Link', [fld(c, 'This link opens', kind), uBox, pBox], (close) => [btn('Cancel', () => { drop(); close(); }), btn('OK', () => {
      if (kind.value === 'url') { let u = url.value.trim(); if (!u) return; if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u; if (!/^(https?|mailto|tel):/i.test(u)) { toast('Use a web, mail or phone address'); return; } ann.url = u; delete ann.pid; }
      else { const t = c.pages[(+pg.value || 1) - 1]; if (!t) return; ann.pid = t.id; delete ann.url; }
      c.redrawOverlays(); close(); c.setTool('select');
    }, 'primary')]);
    return m;
  };

  // ---------- find and replace ----------
  X.replaceText = () => {
    if (!need()) return;
    const find = txt(c, '', 'word or phrase'), rep = txt(c, '', 'replace with'), cs = h('input', { type: 'checkbox' }), perm = h('input', { type: 'checkbox' });
    modal(c, 'Replace text', [note(c, 'Every line that contains the words is rewritten with a standard font (Helvetica, or Noto Sans Thai). Pictures of text need OCR first.'), fld(c, 'Find', find), fld(c, 'Replace with', rep), h('label', { class: 'row' }, cs, h('span', { text: 'Match capital letters exactly' })),
      h('label', { class: 'row' }, perm, h('span', { text: 'Remove the old words from the file for good (each changed page is then saved as a picture with the new text on top)' }))], (close) => [btn('Cancel', close), btn('Replace all', async () => {
      const q = find.value; if (!q) return; close();
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), re = new RegExp(esc, cs.checked ? 'g' : 'gi');
      let n = 0, lines = 0; c.commit();
      const test = new RegExp(esc, cs.checked ? '' : 'i');
      for (const p of c.pages) {
        if (!p.src) continue; const [bw, bh] = c.dispDims(p);
        const cache = new Map();   // one render per page, dropped before the next page
        for (const l of await c.linesFor(p)) {
          if (!test.test(l.text)) continue;
          n += (l.text.match(re) || []).length; lines++;
          const col = await c.sampleColors(p, l, cache), text = l.text.replace(re, () => rep.value);
          p.annots.push(c.mkAnn({ type: 'cover', x: l.u0 - 0.002, y: l.v0 - 0.002, bw: l.u1 - l.u0 + 0.004, bh: l.v1 - l.v0 + 0.004, fillc: col.bg, perm: perm.checked }));
          if (text.trim()) p.annots.push(c.mkAnn({ type: 'text', x: l.u0, y: l.vb - (0.8 * l.fs) / bh, text, fs: l.fs / bw, color: col.fg, bold: col.bold }));
        }
      }
      if (!n) { c.dropCommit(); toast('Nothing found'); return; }
      c.redrawOverlays(); toast(`Changed ${n} place${n === 1 ? '' : 's'} on ${lines} line${lines === 1 ? '' : 's'}`);
    }, 'primary')]);
  };
}
