import * as pdfjs from './vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
const { PDFDocument, rgb, degrees, StandardFonts } = window.PDFLib;

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const svgNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const e = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const toast = (msg) => { const t = h('div', { class: 'toast', text: msg }); document.body.append(t); setTimeout(() => t.remove(), 2600); };

// ---------- state ----------
const sources = new Map();          // id -> {name, bytes, pdf}
let pages = [];                     // {id, src, index, rot, annots[], w, h, r0}
let sel = new Set();                // selected page ids (thumbnails)
let curPage = 0;
let zoom = 1.2;
let tool = 'select';
let color = '#e6c84a';
let strokeW = 3;
let fontSize = 0.022;               // fraction of page width
let selAnn = null;                  // {pageId, annId}
let undoStack = [], redoStack = [];
let fileName = '';
let lastSave = null;                // {id,name}
let meta = { title: '', author: '' };
let hits = [];

const TOOLS = [['select', 'Select'], ['highlight', 'Highlight'], ['text', 'Text'], ['rect', 'Box'], ['draw', 'Pen'], ['redact', 'Redact'], ['cover', 'Cover'], ['sign', 'Sign'], ['erase', 'Erase']];
const SWATCH = ['#e6c84a', '#d98a5f', '#d96c6c', '#6c9ad9', '#74b27c', '#111111', '#ffffff'];

// ---------- UI skeleton ----------
const app = $('#app');
const toolbar = h('div', { class: 'toolbar' });
const left = h('div', { class: 'sidebar' });
const stage = h('div', { class: 'stage' });
const right = h('div', { class: 'sidebar right' });
const status = h('div', { class: 'status' });
app.append(toolbar, h('div', { class: 'main' }, left, h('div', { style: 'flex:1;min-width:0;display:flex' }, stage), right), status);
stage.style.flex = '1';
stage.style.overflow = 'auto';

const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn, text: label });
const toolBtns = {};
const bOpen = btn('Open', () => openFiles(false), 'primary');
const bMerge = btn('Merge', () => openFiles(true));
const bSave = btn('Save as', () => save());
const bHome = btn('Home', () => {
  if (pages.length && snapshot() !== savedSnap && !confirm('Close this document without saving?')) return;
  pages = []; sources.clear(); undoStack = []; redoStack = []; fileName = ''; lastSave = null; sel.clear(); selAnn = null; savedSnap = null; fullRender();
});
const bUndo = btn('Undo', () => undo());
const bRedo = btn('Redo', () => redo());
const search = h('input', { 'aria-label': 'Search text', type: 'search', placeholder: 'Search text', style: 'width:150px', onkeydown: (e) => { if (e.key === 'Enter') doSearch(search.value); } });
const swatchBox = h('div', { class: 'swatches' }, SWATCH.map((c) => { const b = h('button', { style: `background:${c}`, title: c, onclick: () => { color = c; refreshSwatches(); if (selAnn) mutateSel((a) => { a.color = c; }); } }); b.dataset.c = c; return b; }));
const sizeIn = h('input', { type: 'range', min: 1, max: 14, value: strokeW, title: 'Line width', style: 'width:100%', oninput: () => { strokeW = +sizeIn.value; if (selAnn) mutateSel((a) => { if (a.type === 'rect' || a.type === 'draw') a.w = strokeW; }); } });
toolbar.append(bHome, bOpen, bMerge, bSave, h('span', { class: 'sep' }), ...TOOLS.map(([k, n]) => (toolBtns[k] = btn(n, () => setTool(k)))), h('span', { class: 'sep' }), bUndo, bRedo, h('span', { class: 'sep' }),
  btn('-', () => setZoom(zoom / 1.15), 'icon'), btn('+', () => setZoom(zoom * 1.15), 'icon'), btn('Fit', () => fitWidth()), h('span', { class: 'grow' }), search);
function refreshSwatches() { swatchBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === color)); }
refreshSwatches();
function setTool(t) {
  if (t === 'sign') { openSignature(); return; }
  tool = t;
  for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === t);
  stage.className = 'stage tool-' + t;
  if (t !== 'select') { selAnn = null; redrawOverlays(); }
}
setTool('select');


// ---------- home screen (shown when no document is open) ----------
const home = h('div', { class: 'home' });
app.append(home);
let homeTab = 'recent';
const IC = (d) => { const s = sv('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); s.innerHTML = d; return s; };
async function openThen(fn) { await openFiles(false); if (pages.length && fn) setTimeout(fn, 60); }
async function createBlank() {
  const d = await PDFDocument.create(); d.addPage([595.28, 841.89]);
  pages = []; sources.clear(); undoStack = []; redoStack = []; fileName = 'Untitled.pdf'; lastSave = null;
  const sid = await addSource('Untitled.pdf', new Uint8Array(await d.save()));
  pages.push(...await pagesOf(sid)); sel.clear(); curPage = 0; selAnn = null; meta = { title: '', author: '' };
  setTimeout(() => { savedSnap = snapshot(); }, 0); fullRender();
}
const QUICK = [
  ['Annotate', 'Highlight, draw and add notes.', '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>', () => openThen(() => setTool('highlight'))],
  ['Sign', 'Draw your signature and place it.', '<path d="M3 17c3-6 5-9 6-6s-2 7 1 6 4-5 5-3 3 2 6-1"/><path d="M3 21h18"/>', () => openThen(() => openSignature())],
  ['Redact', 'Remove private details for real.', '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M7 12h10" stroke-width="4"/>', () => openThen(() => setTool('redact'))],
  ['Organise pages', 'Rotate, move, delete or extract.', '<rect x="4" y="3" width="9" height="12" rx="1"/><rect x="11" y="9" width="9" height="12" rx="1"/>', () => openThen()],
  ['Combine files', 'Join several PDFs into one.', '<rect x="3" y="4" width="8" height="10" rx="1"/><rect x="13" y="10" width="8" height="10" rx="1"/><path d="M11 9h2"/>', async () => { await openFiles(false); }],
  ['Compress', 'Make the file smaller.', '<path d="M12 3v7m0 0l-3-3m3 3l3-3M12 21v-7m0 0l-3 3m3-3l3 3"/>', () => openThen(() => saveCompressed())],
  ['Export text', 'Copy out all the words.', '<path d="M5 6h14M12 6v13M9 19h6"/>', () => openThen(() => extractText())],
  ['Blank PDF', 'Start from an empty page.', '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>', () => createBlank()],
];
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtDate = (t) => { const d = new Date(t); return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
async function renderHome() {
  home.textContent = '';
  const nav = h('div', { class: 'home-nav' },
    h('div', { class: 'home-brand' }, h('img', { src: 'brand.svg', alt: '' }), h('span', { text: 'PDFout' })),
    btn('Open PDF', () => openFiles(false), 'primary big'),
    btn('Create PDF', () => createBlank(), 'big outline'),
    h('div', { class: 'home-links' },
      ...[['recent', 'Recent files'], ['starred', 'Starred files']].map(([k, n]) => h('button', { class: 'home-link' + (homeTab === k ? ' on' : ''), text: n, onclick: () => { homeTab = k; renderHome(); } }))),
    h('div', { class: 'home-note', text: 'Everything stays on this computer. Nothing is uploaded.' }));
  const quick = h('div', { class: 'quick' }, ...QUICK.map(([t, d, ic, fn]) => h('button', { class: 'qcard', onclick: fn }, IC(ic), h('div', {}, h('b', { text: t }), h('span', { text: d })))));
  let list = [];
  try { list = await window.host.recentList(); } catch {}
  if (homeTab === 'starred') list = list.filter((x) => x.star);
  const body = list.length ? h('table', { class: 'grid recent' },
    h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Name' }), h('th', { text: 'Folder' }), h('th', { text: 'Size' }))),
    h('tbody', {}, list.map((x) => h('tr', { onclick: async () => { try { await openFiles(false, [await window.host.recentOpen(x.id)]); } catch (e) { toast('Cannot open: ' + (e.message || e)); } } },
      h('td', {}, h('button', { class: 'star' + (x.star ? ' on' : ''), title: 'Star', text: x.star ? '\u2605' : '\u2606', onclick: async (e) => { e.stopPropagation(); await window.host.recentStar(x.id); renderHome(); } })),
      h('td', {}, h('b', { text: x.name }), h('div', { class: 'muted', text: fmtDate(x.mtime) })),
      h('td', { class: 'muted', text: x.dir }), h('td', { class: 'muted', text: fmtSize(x.size) })))))
    : h('div', { class: 'home-empty' }, h('b', { text: homeTab === 'starred' ? 'No starred files yet' : 'No recent files yet' }), h('span', { text: 'Files you open will appear here. Click the star to keep one handy.' }));
  home.append(nav, h('div', { class: 'home-main' },
    h('h2', { text: 'Quick tools' }), quick,
    h('div', { class: 'home-head' }, h('h2', { text: homeTab === 'starred' ? 'Starred files' : 'Recent files' }), list.length && homeTab === 'recent' ? btn('Clear list', async () => { await window.host.recentClear(); renderHome(); }) : null),
    body));
}

// ---------- page model ----------
async function addSource(name, bytes) {
  const id = uid();
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false }).promise;
  const ent = { name, bytes, pdf, fields: [], vals: {} };
  sources.set(id, ent);
  try {
    const d = await PDFDocument.load(bytes, { ignoreEncryption: true });
    ent.fields = d.getForm().getFields().map((f) => {
      const t = f.constructor.name;
      const kind = /TextField/.test(t) ? 'text' : /CheckBox/.test(t) ? 'check' : /Dropdown|OptionList/.test(t) ? 'choice' : /Radio/.test(t) ? 'radio' : null;
      return kind ? { name: f.getName(), kind, options: f.getOptions ? f.getOptions() : [] } : null;
    }).filter(Boolean);
  } catch {}
  return id;
}
async function pagesOf(srcId) {
  const { pdf } = sources.get(srcId);
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const [x0, y0, x1, y1] = pg.view;
    out.push({ id: uid(), src: srcId, index: i - 1, rot: 0, annots: [], w: x1 - x0, h: y1 - y0, r0: pg.rotate || 0 });
  }
  return out;
}
async function openFiles(merge, preset) {
  const files = preset || await window.host.openFiles({ multi: true, filters: [['PDF', ['pdf']]] });
  if (!files.length) return;
  if (!merge) { pages = []; sources.clear(); undoStack = []; redoStack = []; fileName = files[0].name; lastSave = null; }
  for (const f of files) {
    try {
      const sid = await addSource(f.name, new Uint8Array(f.data));
      pages.push(...await pagesOf(sid));
    } catch (e) { toast(`Cannot open ${f.name}: ${e.message || e}`); }
  }
  if (!merge && pages.length) { const first = [...sources.values()][0]; try { const m = await first.pdf.getMetadata(); meta = { title: m.info?.Title || '', author: m.info?.Author || '' }; } catch { meta = { title: '', author: '' }; } }
  sel.clear(); curPage = 0; selAnn = null; if (!merge) setTimeout(() => { savedSnap = snapshot(); }, 0);
  fullRender();
}

// ---------- undo ----------
const snapshot = () => JSON.stringify(pages.map((p) => ({ ...p })));
function commit() { undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; updateButtons(); }
function restore(s) { pages = JSON.parse(s); sel = new Set([...sel].filter((id) => pages.some((p) => p.id === id))); selAnn = null; fullRender(); }
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }
function updateButtons() { bUndo.disabled = !undoStack.length; bRedo.disabled = !redoStack.length; bSave.disabled = !pages.length; bMerge.disabled = !pages.length; }

// ---------- geometry ----------
const dispDims = (p) => { const sw = p.r0 % 180 !== 0; return sw ? [p.h, p.w] : [p.w, p.h]; };      // base display (user rot 0), in points
const rotFwd = (u, v, d) => (d === 90 ? [1 - v, u] : d === 180 ? [1 - u, 1 - v] : d === 270 ? [v, 1 - u] : [u, v]);
const rotInv = (u, v, d) => (d === 90 ? [v, 1 - u] : d === 180 ? [1 - u, 1 - v] : d === 270 ? [1 - v, u] : [u, v]);
function shownSize(p) { const [bw, bh] = dispDims(p); return p.rot % 180 ? [bh * zoom, bw * zoom] : [bw * zoom, bh * zoom]; }
function dispToPdf(p, u, v, box) {
  const { w, h } = p; let x, y;
  switch (p.r0) { case 90: y = u * h; x = v * w; break; case 180: x = w * (1 - u); y = v * h; break; case 270: y = h * (1 - u); x = w * (1 - v); break; default: x = u * w; y = h * (1 - v); }
  return [x + box.x, y + box.y];
}

// ---------- rendering ----------
const pageEls = new Map();
const thumbEls = new Map();
let scrollTimer = 0;
function renderVisible() {
  for (const p of pages) {
    const el = pageEls.get(p.id); if (!el) continue;
    const top = el.offsetTop - stage.scrollTop; const bot = top + el.offsetHeight;
    if (bot > -700 && top < stage.clientHeight + 700) renderPage(el, p); else if (el._rendered) unrender(el);
  }
}
function fullRender() {
  document.body.classList.toggle('is-home', !pages.length);
  if (!pages.length) renderHome();
  updateButtons();
  renderThumbs(); renderStage(); renderRight(); renderStatus();
}
function renderStage() {
  stage.textContent = '';
  pageEls.clear();
  if (!pages.length) {
    stage.append(h('div', { class: 'empty' }, h('div', { class: 'big', text: 'Open a PDF to start' }), h('div', { text: 'Use Open, or drop a file onto this window.' }), btn('Open PDF', () => openFiles(false), 'primary')));
    return;
  }
  pages.forEach((p, i) => {
    const [cw, ch] = shownSize(p);
    const el = h('div', { class: 'page', style: `width:${cw}px;height:${ch}px` });
    el.dataset.pid = p.id; el.dataset.i = i;
    pageEls.set(p.id, el); stage.append(el);
  });
  stage.onscroll = onScroll;
  setTimeout(renderVisible, 0);
}
function unrender(el) { el._rendered = false; el._task?.cancel?.(); el.textContent = ''; }
async function renderPage(el, p) {
  if (el._rendered) return;
  el._rendered = true;
  const src = sources.get(p.src); if (!src) return;
  const pg = await src.pdf.getPage(p.index + 1);
  const vp = pg.getViewport({ scale: zoom, rotation: (pg.rotate + p.rot) % 360 });
  const dpr = window.devicePixelRatio || 1;
  const cv = h('canvas'); cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
  cv.style.width = vp.width + 'px'; cv.style.height = vp.height + 'px';
  el.style.width = vp.width + 'px'; el.style.height = vp.height + 'px';
  el.textContent = ''; el.append(cv);
  const task = pg.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
  el._task = task;
  try { await task.promise; } catch { return; }
  const tl = h('div', { class: 'textLayer' }); tl.style.setProperty('--total-scale-factor', vp.scale);
  el.append(tl);
  try { await new pdfjs.TextLayer({ textContentSource: pg.streamTextContent(), container: tl, viewport: vp }).render(); } catch {}
  markHits(tl, p);
  el.append(makeOverlay(p));
}
function renderThumbs() {
  left.textContent = '';
  thumbEls.clear();
  const tools = h('div', { class: 'ptools' },
    btn('Rotate L', () => pageOp('rotL')), btn('Rotate R', () => pageOp('rotR')), btn('Delete', () => pageOp('del')), btn('Copy', () => pageOp('dup')),
    btn('Up', () => pageOp('up')), btn('Down', () => pageOp('down')), btn('Blank', () => pageOp('blank')), btn('Extract', () => extractSel()));
  left.append(h('h3', { text: 'Pages' }), tools);
  pages.forEach((p, i) => {
    const c = h('canvas');
    const t = h('div', { class: 'thumb' + (sel.has(p.id) ? ' sel' : ''), onclick: (e) => thumbClick(e, p, i) }, c, h('span', { text: String(i + 1) }));
    thumbEls.set(p.id, t); left.append(t);
    drawThumb(c, p);
  });
}
async function drawThumb(c, p) {
  const src = sources.get(p.src); if (!src) return;
  const pg = await src.pdf.getPage(p.index + 1);
  const base = pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rot) % 360 });
  const s = 140 / base.width; const vp = pg.getViewport({ scale: s, rotation: (pg.rotate + p.rot) % 360 });
  c.width = vp.width; c.height = vp.height;
  try { await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch {}
}
function thumbClick(e, p, i) {
  if (e.ctrlKey || e.metaKey) { sel.has(p.id) ? sel.delete(p.id) : sel.add(p.id); }
  else if (e.shiftKey && sel.size) { const last = pages.findIndex((x) => sel.has(x.id)); const [a, b] = [Math.min(last, i), Math.max(last, i)]; sel = new Set(pages.slice(a, b + 1).map((x) => x.id)); }
  else sel = new Set([p.id]);
  thumbEls.forEach((el, id) => el.classList.toggle('sel', sel.has(id)));
  scrollToPage(i);
}
function scrollToPage(i) { const el = pageEls.get(pages[i]?.id); if (el) stage.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' }); }
function onScroll() {
  clearTimeout(scrollTimer); scrollTimer = setTimeout(renderVisible, 40);
  const mid = stage.scrollTop + stage.clientHeight / 3;
  let best = 0; pages.forEach((p, i) => { const el = pageEls.get(p.id); if (el && el.offsetTop <= mid) best = i; });
  if (best !== curPage) { curPage = best; renderStatus(); }
}
function setZoom(z) { zoom = clamp(z, 0.25, 5); const top = stage.scrollTop / (stage.scrollHeight || 1); renderStage(); stage.scrollTop = top * stage.scrollHeight; renderStatus(); }
function fitWidth() { if (!pages.length) return; const [bw] = shownSize({ ...pages[curPage], rot: pages[curPage].rot }); setZoom(zoom * (stage.clientWidth - 48) / bw); }
function renderStatus() {
  status.textContent = '';
  status.append(h('span', { text: fileName || 'No file' }), h('span', { class: 'grow' }), h('span', { text: pages.length ? `Page ${curPage + 1} of ${pages.length}` : '' }), h('span', { text: Math.round(zoom * 100) + '%' }));
}

// ---------- page operations ----------
function pageOp(op) {
  if (!pages.length) return;
  const ids = sel.size ? sel : new Set([pages[curPage].id]);
  commit();
  if (op === 'rotL' || op === 'rotR') pages.forEach((p) => { if (ids.has(p.id)) p.rot = (p.rot + (op === 'rotR' ? 90 : 270)) % 360; });
  else if (op === 'del') { if (ids.size >= pages.length) { toast('A document needs at least one page'); undoStack.pop(); return; } pages = pages.filter((p) => !ids.has(p.id)); sel.clear(); }
  else if (op === 'dup') { const out = []; for (const p of pages) { out.push(p); if (ids.has(p.id)) out.push({ ...JSON.parse(JSON.stringify(p)), id: uid() }); } pages = out; }
  else if (op === 'up') { for (let i = 1; i < pages.length; i++) if (ids.has(pages[i].id) && !ids.has(pages[i - 1].id)) [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; }
  else if (op === 'down') { for (let i = pages.length - 2; i >= 0; i--) if (ids.has(pages[i].id) && !ids.has(pages[i + 1].id)) [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]]; }
  else if (op === 'blank') {
    const at = Math.max(...pages.map((p, i) => (ids.has(p.id) ? i : -1))) + 1; const ref = pages[Math.max(0, at - 1)];
    pages.splice(at, 0, { id: uid(), src: null, index: -1, rot: 0, annots: [], w: ref.w, h: ref.h, r0: 0 });
  }
  fullRender();
}
async function extractSel() {
  if (!pages.length) return;
  const ids = sel.size ? sel : new Set([pages[curPage].id]);
  const bytes = await buildPdf(pages.filter((p) => ids.has(p.id)));
  const r = await window.host.saveFile({ name: 'extract.pdf', filters: [['PDF', ['pdf']]], data: bytes });
  if (r) toast('Saved ' + r.name);
}

// ---------- overlay / annotations ----------
function makeOverlay(p) {
  const [cw, ch] = shownSize(p);
  const svg = sv('svg', { class: 'ov', viewBox: `0 0 ${cw} ${ch}` });
  svg.dataset.pid = p.id;
  for (const a of p.annots) svg.append(drawAnn(p, a, cw, ch));
  svg.addEventListener('pointerdown', (e) => onPointerDown(e, p, svg, cw, ch));
  return svg;
}
function redrawOverlays() {
  pageEls.forEach((el, id) => { const p = pages.find((x) => x.id === id); const old = el.querySelector('svg.ov'); if (old && p) old.replaceWith(makeOverlay(p)); });
}
const P = (p, u, v, cw, ch) => { const [a, b] = rotFwd(u, v, p.rot); return [a * cw, b * ch]; };
function drawAnn(p, a, cw, ch) {
  const g = sv('g'); g.dataset.aid = a.id;
  const sel_ = selAnn && selAnn.annId === a.id;
  if (a.type === 'rect' || a.type === 'highlight' || a.type === 'redact' || a.type === 'cover' || a.type === 'image') {
    const pts = [[a.x, a.y], [a.x + a.bw, a.y], [a.x + a.bw, a.y + a.bh], [a.x, a.y + a.bh]].map(([u, v]) => P(p, u, v, cw, ch));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, hh = Math.max(...ys) - y;
    if (a.type === 'image') g.append(sv('image', { href: a.data, x, y, width: w, height: hh, preserveAspectRatio: 'none' }));
    else g.append(sv('rect', { x, y, width: w, height: hh, fill: a.type === 'rect' ? 'none' : a.type === 'redact' ? '#000' : a.type === 'cover' ? '#fff' : a.color, 'fill-opacity': a.type === 'highlight' ? 0.4 : 1, stroke: a.type === 'rect' ? a.color : 'none', 'stroke-width': a.w || 2, style: a.type === 'highlight' ? 'mix-blend-mode:multiply' : '' }));
    if (sel_) { g.append(sv('rect', { x, y, width: w, height: hh, fill: 'none', stroke: '#888', 'stroke-dasharray': '4 3' })); const hd = sv('rect', { x: x + w - 5, y: y + hh - 5, width: 10, height: 10, fill: '#ddd', stroke: '#444', class: 'rs', style: 'cursor:nwse-resize' }); g.append(hd); }
  } else if (a.type === 'draw') {
    const d = a.pts.map(([u, v], i) => { const [x, y] = P(p, u, v, cw, ch); return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }).join(' ');
    g.append(sv('path', { d, fill: 'none', stroke: a.color, 'stroke-width': a.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    if (sel_) g.append(sv('path', { d, fill: 'none', stroke: '#888', 'stroke-width': a.w + 4, 'stroke-opacity': 0.35 }));
  } else if (a.type === 'text') {
    const [bw] = dispDims(p); const fs = a.fs * bw * zoom * (p.rot % 180 ? 1 : 1);
    const [x, y] = P(p, a.x, a.y, cw, ch);
    const t = sv('text', { x: 0, y: 0, fill: a.color, 'font-size': fs, 'font-family': 'Helvetica, Arial, sans-serif', 'dominant-baseline': 'hanging', transform: `translate(${x} ${y}) rotate(${p.rot})`, style: 'white-space:pre' });
    a.text.split('\n').forEach((ln, i) => { const s = sv('tspan', { x: 0, dy: i ? fs * 1.2 : 0 }); s.textContent = ln || ' '; t.append(s); });
    g.append(t);
    if (sel_) { requestAnimationFrame(() => { try { const b = t.getBBox(); const m = sv('rect', { x: b.x - 3, y: b.y - 3, width: b.width + 6, height: b.height + 6, fill: 'none', stroke: '#888', 'stroke-dasharray': '4 3', transform: t.getAttribute('transform') }); g.append(m); } catch {} }); }
  }
  g.style.cursor = tool === 'select' ? 'move' : 'default';
  return g;
}
const mkAnn = (o) => ({ id: uid(), color, w: strokeW, ...o });
function localUV(e, svg, p, cw, ch) {
  const r = svg.getBoundingClientRect();
  const [u, v] = rotInv(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1), p.rot);
  return [u, v];
}
function onPointerDown(e, p, svg, cw, ch) {
  if (e.button !== 0) return;
  const aEl = e.target.closest('[data-aid]');
  if (tool === 'erase') { if (aEl) { commit(); p.annots = p.annots.filter((a) => a.id !== aEl.dataset.aid); redrawOverlays(); } return; }
  if (tool === 'select') {
    if (!aEl) { if (selAnn) { selAnn = null; redrawOverlays(); renderRight(); } return; }
    const a = p.annots.find((x) => x.id === aEl.dataset.aid); if (!a) return;
    selAnn = { pageId: p.id, annId: a.id };
    const resize = e.target.classList.contains('rs');
    const [su, sv_] = localUV(e, svg, p, cw, ch);
    const orig = JSON.parse(JSON.stringify(a));
    commit();
    svg.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const [u, v] = localUV(ev, svg, p, cw, ch); const du = u - su, dv = v - sv_;
      if (resize && a.bw != null) { a.bw = Math.max(0.01, orig.bw + du); a.bh = Math.max(0.01, orig.bh + dv); }
      else if (a.pts) a.pts = orig.pts.map(([x, y]) => [x + du, y + dv]);
      else { a.x = orig.x + du; a.y = orig.y + dv; }
      redrawOverlays();
    };
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); renderRight(); };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up);
    redrawOverlays(); renderRight();
    return;
  }
  if (tool === 'text') {
    const [u, v] = localUV(e, svg, p, cw, ch);
    editText(p, null, u, v, e.clientX, e.clientY);
    return;
  }
  // drag-create tools
  const [u0, v0] = localUV(e, svg, p, cw, ch);
  svg.setPointerCapture(e.pointerId);
  let ann;
  if (tool === 'draw') ann = mkAnn({ type: 'draw', pts: [[u0, v0]] });
  else ann = mkAnn({ type: tool, x: u0, y: v0, bw: 0, bh: 0 });
  const tmp = drawAnn(p, ann, cw, ch); svg.append(tmp);
  const move = (ev) => {
    const [u, v] = localUV(ev, svg, p, cw, ch);
    if (ann.type === 'draw') ann.pts.push([u, v]);
    else { ann.x = Math.min(u0, u); ann.y = Math.min(v0, v); ann.bw = Math.abs(u - u0); ann.bh = Math.abs(v - v0); }
    const n = drawAnn(p, ann, cw, ch); tmp.replaceWith(n); Object.assign(tmp, {}); svg._tmp = n; svg.dataset.tmp = '1';
    tmpRef.el = n;
  };
  const tmpRef = { el: tmp };
  const mv = (ev) => { move(ev); };
  const up = () => {
    svg.removeEventListener('pointermove', mv); svg.removeEventListener('pointerup', up);
    const tiny = ann.type === 'draw' ? ann.pts.length < 2 : (ann.bw < 0.004 || ann.bh < 0.004);
    if (!tiny) { commit(); p.annots.push(ann); }
    tmpRef.el.remove(); redrawOverlays();
  };
  svg.addEventListener('pointermove', mv); svg.addEventListener('pointerup', up);
}
function editText(p, ann, u, v, cx, cy) {
  const ta = h('textarea', { rows: 3, style: 'width:300px', placeholder: 'Type text' });
  if (ann) ta.value = ann.text;
  const fsIn = h('input', { type: 'range', min: 10, max: 60, value: Math.round((ann ? ann.fs : fontSize) * 1000) });
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: ann ? 'Edit text' : 'Add text' }), ta, h('label', { class: 'field' }, 'Size', fsIn),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Cancel', () => back.remove()), btn('OK', () => {
      const text = ta.value.trimEnd(); back.remove(); if (!text.trim()) return;
      commit(); fontSize = fsIn.value / 1000;
      if (ann) { ann.text = text; ann.fs = fontSize; } else p.annots.push(mkAnn({ type: 'text', x: u, y: v, text, fs: fontSize }));
      redrawOverlays(); renderRight();
    }, 'primary'))));
  document.body.append(back); ta.focus();
}
function mutateSel(fn) {
  if (!selAnn) return; const p = pages.find((x) => x.id === selAnn.pageId); const a = p?.annots.find((x) => x.id === selAnn.annId); if (!a) return;
  commit(); fn(a); redrawOverlays();
}
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea')) return;
  if (document.querySelector('.modal-back') || (!e.ctrlKey && !e.metaKey && e.target.matches('select,button,[contenteditable]'))) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selAnn) { const p = pages.find((x) => x.id === selAnn.pageId); if (p) { commit(); p.annots = p.annots.filter((a) => a.id !== selAnn.annId); selAnn = null; redrawOverlays(); renderRight(); } }
  else if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') { redo(); e.preventDefault(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'o') { openFiles(false); e.preventDefault(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 's') { save(); e.preventDefault(); }
  else if (e.ctrlKey && (e.key === '=' || e.key === '+')) { setZoom(zoom * 1.15); e.preventDefault(); }
  else if (e.ctrlKey && e.key === '-') { setZoom(zoom / 1.15); e.preventDefault(); }
  else if (e.key === 'Escape') { selAnn = null; redrawOverlays(); }
});
stage.addEventListener('dblclick', (e) => {
  const aEl = e.target.closest('[data-aid]'); if (!aEl) return;
  const svg = e.target.closest('svg.ov'); const p = pages.find((x) => x.id === svg.dataset.pid); const a = p?.annots.find((x) => x.id === aEl.dataset.aid);
  if (a?.type === 'text') editText(p, a);
});
stage.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
// drag & drop
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const fl = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name)); if (!fl.length) return;
  const merge = pages.length > 0 && e.shiftKey;
  if (!merge) { pages = []; sources.clear(); undoStack = []; redoStack = []; fileName = fl[0].name; }
  for (const f of fl) { try { const sid = await addSource(f.name, new Uint8Array(await f.arrayBuffer())); pages.push(...await pagesOf(sid)); } catch (er) { toast('Cannot open ' + f.name); } }
  sel.clear(); curPage = 0; fullRender(); if (!merge) setTimeout(() => { savedSnap = snapshot(); }, 0);
});

// ---------- signature ----------
function openSignature() {
  if (!pages.length) { toast('Open a PDF first'); return; }
  let saved = null; try { saved = localStorage.getItem('pageout.signature'); } catch {}
  const cv = h('canvas', { class: 'sigpad', width: 420, height: 160 });
  const ctx = cv.getContext('2d'); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
  let down = false, any = false;
  cv.addEventListener('pointerdown', (e) => { down = true; any = true; cv.setPointerCapture(e.pointerId); const r = cv.getBoundingClientRect(); ctx.beginPath(); ctx.moveTo(e.clientX - r.left, e.clientY - r.top); });
  cv.addEventListener('pointermove', (e) => { if (!down) return; const r = cv.getBoundingClientRect(); ctx.lineTo(e.clientX - r.left, e.clientY - r.top); ctx.stroke(); });
  cv.addEventListener('pointerup', () => { down = false; });
  if (saved) { const im = new Image(); im.onload = () => { ctx.drawImage(im, 0, 0); any = true; }; im.src = saved; }
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Draw your signature' }), cv,
    h('div', { class: 'row', style: 'justify-content:space-between' }, btn('Clear', () => { ctx.clearRect(0, 0, 420, 160); any = false; try { localStorage.removeItem('pageout.signature'); } catch {} }),
      h('div', { class: 'row' }, btn('Cancel', () => back.remove()), btn('Place', () => {
        if (!any) return; const data = cv.toDataURL('image/png'); try { localStorage.setItem('pageout.signature', data); } catch {}
        back.remove(); const p = pages[curPage]; commit();
        p.annots.push(mkAnn({ type: 'image', x: 0.3, y: 0.7, bw: 0.3, bh: 0.3 * (160 / 420) * (dispDims(p)[0] / dispDims(p)[1]), data }));
        redrawOverlays(); setTool('select');
      }, 'primary')))));
  document.body.append(back);
}

// ---------- search ----------
async function doSearch(q) {
  hits = []; q = q.trim().toLowerCase();
  if (!q) { renderRight(); pageEls.forEach((el) => { el.querySelectorAll('.hit').forEach((n) => n.classList.remove('hit')); }); return; }
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]; if (!p.src) continue;
    const pg = await sources.get(p.src).pdf.getPage(p.index + 1);
    const tc = await pg.getTextContent(); const text = tc.items.map((it) => it.str).join(' ').toLowerCase();
    let n = 0, at = 0; while ((at = text.indexOf(q, at)) !== -1) { n++; at += q.length; }
    if (n) hits.push({ i, n, snippet: text.slice(Math.max(0, text.indexOf(q) - 20), text.indexOf(q) + 40) });
  }
  hits.q = q; renderRight();
  pageEls.forEach((el) => { const tl = el.querySelector('.textLayer'); const p = pages.find((x) => x.id === el.dataset.pid); if (tl && p) markHits(tl, p); });
  if (hits.length) scrollToPage(hits[0].i);
}
function markHits(tl, p) {
  const q = hits.q; if (!q) return;
  tl.querySelectorAll('span').forEach((s) => s.classList.toggle('hit', s.textContent.toLowerCase().includes(q)));
}

// ---------- right panel ----------
async function renderRight() {
  right.textContent = '';
  right.append(h('h3', { text: 'Document' }));
  const t = h('input', { type: 'text', value: meta.title, oninput: () => (meta.title = t.value) });
  const a = h('input', { type: 'text', value: meta.author, oninput: () => (meta.author = a.value) });
  right.append(h('div', { class: 'col' }, h('label', { class: 'field' }, 'Title', t), h('label', { class: 'field' }, 'Author', a), h('div', { class: 'muted', text: `${pages.length} pages` })));
  right.append(h('h3', { text: 'Ink' }), swatchBox, h('label', { class: 'field', style: 'margin-top:10px' }, 'Line width', sizeIn));
  right.append(h('h3', { text: 'Tools' }), h('div', { class: 'col' }, btn('Export page as PNG', () => exportPng()), btn('Extract all text', () => extractText()), btn('Save compressed', () => saveCompressed())));
  const cur = pages[curPage]; const ent = cur && cur.src ? sources.get(cur.src) : null;
  if (ent && ent.fields.length) {
    right.append(h('h3', { text: 'Form fields' }));
    const box = h('div', { class: 'col' });
    for (const f of ent.fields) {
      let inp;
      if (f.kind === 'check') inp = h('input', { type: 'checkbox', checked: !!ent.vals[f.name], onchange: () => { ent.vals[f.name] = inp.checked; } });
      else if (f.kind === 'text') inp = h('input', { type: 'text', value: ent.vals[f.name] || '', oninput: () => { ent.vals[f.name] = inp.value; } });
      else { inp = h('select', { onchange: () => { ent.vals[f.name] = inp.value; } }, h('option', { value: '', text: '-' }), f.options.map((o) => h('option', { value: o, text: o, selected: ent.vals[f.name] === o }))); }
      box.append(h('label', { class: 'field' }, f.name, inp));
    }
    box.append(btn('Fill form into page', () => applyForm(cur.src), 'primary'));
    right.append(box);
  }
  if (selAnn) {
    const p = pages.find((x) => x.id === selAnn.pageId); const an = p?.annots.find((x) => x.id === selAnn.annId);
    if (an) right.append(h('h3', { text: 'Selected ' + an.type }), h('div', { class: 'col' }, btn('Delete', () => { commit(); p.annots = p.annots.filter((x) => x.id !== an.id); selAnn = null; redrawOverlays(); renderRight(); }), an.type === 'text' ? btn('Edit text', () => editText(p, an)) : null));
  }
  if (hits.q) {
    right.append(h('h3', { text: `Search: ${hits.length} page${hits.length === 1 ? '' : 's'}` }));
    const list = h('div', { class: 'list hits' });
    hits.forEach((x) => list.append(h('div', { class: 'item', onclick: () => scrollToPage(x.i), text: `Page ${x.i + 1} (${x.n})` })));
    right.append(list);
  }
  right.append(h('h3', { text: 'Privacy' }), h('div', { class: 'muted', text: 'Files are processed on this computer only. Nothing is uploaded.' }));
}
async function applyForm(srcId) {
  const ent = sources.get(srcId);
  try {
    const d = await PDFDocument.load(ent.bytes, { ignoreEncryption: true });
    const form = d.getForm();
    for (const f of ent.fields) {
      const v = ent.vals[f.name]; if (v === undefined || v === '') continue;
      const fld = form.getField(f.name);
      if (f.kind === 'text') fld.setText(String(v));
      else if (f.kind === 'check') (v ? fld.check() : fld.uncheck());
      else fld.select(v);
    }
    form.flatten();
    const bytes = new Uint8Array(await d.save());
    ent.pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false }).promise;
    ent.bytes = bytes; ent.fields = []; ent.vals = {};
    fullRender(); toast('Form filled');
  } catch (e) { toast('Form fill failed: ' + (e.message || e)); }
}
async function pdfToJpegPdf(bytes, q, scale) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const out = await PDFDocument.create();
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i); const vp = pg.getViewport({ scale });
    const cv = h('canvas'); cv.width = vp.width; cv.height = vp.height;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const base = pg.getViewport({ scale: 1 });
    out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
  }
  out.setProducer('PDFout');
  return new Uint8Array(await out.save());
}
async function saveCompressed() {
  if (!pages.length) return;
  try {
    const raw = await buildPdf(pages);
    const small = await pdfToJpegPdf(raw, 0.6, 1.4);
    const name = (fileName ? fileName.replace(/\.pdf$/i, '') : 'document') + '-compressed.pdf';
    const r = await window.host.saveFile({ name, filters: [['PDF', ['pdf']]], data: small });
    if (r) toast(`Saved ${r.name}: ${(raw.length / 1024) | 0} KB to ${(small.length / 1024) | 0} KB (pages become images)`);
  } catch (e) { toast('Compress failed: ' + (e.message || e)); }
}
async function exportPng() {
  const p = pages[curPage]; if (!p?.src) return;
  const pg = await sources.get(p.src).pdf.getPage(p.index + 1);
  const vp = pg.getViewport({ scale: 2, rotation: (pg.rotate + p.rot) % 360 });
  const cv = h('canvas'); cv.width = vp.width; cv.height = vp.height;
  const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
  await pg.render({ canvasContext: cx, viewport: vp }).promise;
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const r = await window.host.saveFile({ name: `page-${curPage + 1}.png`, filters: [['PNG image', ['png']]], data: new Uint8Array(await blob.arrayBuffer()) });
  if (r) toast('Saved ' + r.name);
}
async function extractText() {
  let out = '';
  for (let i = 0; i < pages.length; i++) { const p = pages[i]; if (!p.src) continue; const pg = await sources.get(p.src).pdf.getPage(p.index + 1); const tc = await pg.getTextContent(); out += `--- Page ${i + 1} ---\n` + tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('') + '\n\n'; }
  const r = await window.host.saveFile({ name: 'text.txt', filters: [['Text', ['txt']]], data: new TextEncoder().encode(out) });
  if (r) toast('Saved ' + r.name);
}

// ---------- export ----------
const hex = (c) => { const n = parseInt(c.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
async function rasterPage(p, list, scale = 2.5) {
  const pg = await sources.get(p.src).pdf.getPage(p.index + 1);
  const vp = pg.getViewport({ scale, rotation: pg.rotate });
  const cv = h('canvas'); cv.width = vp.width; cv.height = vp.height;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  ctx.fillStyle = '#000';
  for (const a of list) ctx.fillRect(a.x * cv.width, a.y * cv.height, a.bw * cv.width, a.bh * cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
async function buildPdf(list) {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const cache = new Map();
  for (const p of list) {
    let page; let q = p;
    const redacts = p.annots.filter((a) => a.type === 'redact');
    if (!p.src) { page = out.addPage([p.w, p.h]); }
    else if (redacts.length) {
      const img = await out.embedPng(await rasterPage(p, redacts));
      // the raster is already in displayed orientation: size the page to it and drop the intrinsic rotation
      const [rw, rh] = dispDims(p);
      page = out.addPage([rw, rh]); page.drawImage(img, { x: 0, y: 0, width: rw, height: rh });
      q = { ...p, w: rw, h: rh, r0: 0 };
    } else {
      if (!cache.has(p.src)) cache.set(p.src, await PDFDocument.load(sources.get(p.src).bytes, { ignoreEncryption: true }));
      [page] = await out.copyPages(cache.get(p.src), [p.index]);
      out.addPage(page);
    }
    const base = page.getRotation().angle;
    const box = p.src && !redacts.length ? page.getCropBox() : { x: 0, y: 0, width: q.w, height: q.h };
    const [dw, dh] = dispDims(q);
    for (const a of p.annots) {
      if (a.type === 'redact') continue;
      const pt = (u, v) => dispToPdf({ ...q, w: box.width, h: box.height }, u, v, box);
      const svgPt = (u, v) => { const [x, y] = pt(u, v); return [x - box.x, box.y + box.height - y]; };
      const origin = { x: box.x, y: box.y + box.height };
      if (a.type === 'rect' || a.type === 'highlight' || a.type === 'cover') {
        const c = [[a.x, a.y], [a.x + a.bw, a.y], [a.x + a.bw, a.y + a.bh], [a.x, a.y + a.bh]].map(([u, v]) => svgPt(u, v));
        const d = 'M' + c.map((q) => q.join(' ')).join(' L') + ' Z';
        if (a.type === 'cover') page.drawSvgPath(d, { ...origin, color: rgb(1, 1, 1), opacity: 1, borderWidth: 0 });
        else if (a.type === 'highlight') page.drawSvgPath(d, { ...origin, color: hex(a.color), opacity: 0.4, borderWidth: 0 });
        else page.drawSvgPath(d, { ...origin, borderColor: hex(a.color), borderWidth: a.w * (dw / 800), color: undefined, opacity: 0, borderOpacity: 1 });
      } else if (a.type === 'draw') {
        const d = a.pts.map(([u, v], i) => (i ? 'L' : 'M') + svgPt(u, v).join(' ')).join(' ');
        page.drawSvgPath(d, { ...origin, borderColor: hex(a.color), borderWidth: a.w * (dw / 800), color: undefined, opacity: 0, borderOpacity: 1 });
      } else if (a.type === 'text') {
        const size = a.fs * dw; const lines = a.text.split('\n');
        lines.forEach((ln, i) => {
          const [x, y] = pt(a.x, a.y + (size * 0.8 + i * size * 1.2) / dh);
          page.drawText(ln, { x, y, size, font, color: hex(a.color), rotate: degrees(q.r0) });
        });
      } else if (a.type === 'image') {
        const img = await out.embedPng(a.data);
        const [x, y] = pt(a.x, a.y + a.bh);
        const wPt = a.bw * dw, hPt = a.bh * dh;
        // lower-left corner of the displayed box, rotated with the page
        page.drawImage(img, { x, y, width: wPt, height: hPt, rotate: degrees(q.r0) });
      }
    }
    page.setRotation(degrees((base + p.rot) % 360));
  }
  out.setProducer('PDFout'); out.setCreator('PDFout');
  if (meta.title) out.setTitle(meta.title); if (meta.author) out.setAuthor(meta.author);
  return await out.save();
}
async function save() {
  if (!pages.length) return;
  try {
    const bytes = await buildPdf(pages);
    const name = fileName ? fileName.replace(/\.pdf$/i, '') + '-edited.pdf' : 'document.pdf';
    const r = await window.host.saveFile({ name, filters: [['PDF', ['pdf']]], data: bytes });
    if (r) { savedSnap = snapshot(); lastSave = r; toast('Saved ' + r.name); }
  } catch (e) { toast('Save failed: ' + (e.message || e)); }
}

fullRender();

let savedSnap = null;
window.addEventListener('beforeunload', (e) => { if (pages.length && snapshot() !== savedSnap) { e.preventDefault(); e.returnValue = ''; } });
