import * as pdfjs from './vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
import { tr, getLang, setLang } from './i18n.js';
import { initExtra } from './extra.js';
const { PDFDocument, rgb, degrees, StandardFonts, PDFName, PDFDict, PDFRef, PDFArray, PDFHexString, PDFObjectCopier } = window.PDFLib;

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') { const t = tr(String(v)); e.textContent = t; if (t !== String(v)) e.dataset.k = v; }
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : (k === 'title' || k === 'placeholder' || k === 'aria-label') ? tr(String(v)) : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(typeof c === 'string' ? tr(c) : c));
  return e;
};
const svgNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const e = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
// errors from the main process arrive as "Error invoking remote method 'x': Error: <message>": show only the message
const cleanErr = (s) => String(s).replace(/Error invoking remote method '[^']*': (?:\w*Error: )?/g, '');
const toast = (msg) => { const s = cleanErr(msg); const t = h('div', { class: 'toast', text: s }); document.body.append(t); setTimeout(() => t.remove(), Math.min(9000, Math.max(2600, s.length * 55))); };

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
let protectOpts = null;             // {user, owner, print, copy, edit} applied when saving
let hits = [];
let outline = [];                   // bookmarks: {id, title, pid, level}
const X = {};                       // features from extra.js, filled in by initExtra()

const TOOLS = [['select', 'Select'], ['highlight', 'Highlight'], ['text', 'Text'], ['rect', 'Box'], ['draw', 'Pen'], ['redact', 'Redact'], ['cover', 'Cover'], ['sign', 'Sign'], ['erase', 'Erase']];
const SWATCH = ['#e6c84a', '#d98a5f', '#d96c6c', '#6c9ad9', '#74b27c', '#111111', '#ffffff'];

// ---------- UI skeleton ----------
const app = $('#app');
const toolbar = h('div', { class: 'toolbar' });
const left = h('div', { class: 'sidebar' });
const stage = h('div', { class: 'stage' });
const right = h('div', { class: 'sidebar right' });
const status = h('div', { class: 'status' });
const ribbon = h('div', { class: 'ribbon', role: 'toolbar', 'aria-label': 'Tools' });
const modebar = h('div', { class: 'modebar' });
// order matters: the floating tool bar comes before the panels and the home screen comes last
app.append(toolbar, modebar, ribbon, h('div', { class: 'main' }, left, h('div', { class: 'center' }, stage), right), status);
stage.style.flex = '1';
stage.style.overflow = 'auto';

// Material outline icons (24px grid, filled paths) for the controls the Lookout kit has no icon for
const MI = {
  search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  minus: 'M19 13H5v-2h14v2z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  fit: 'M17 4h3c1.1 0 2 .9 2 2v2h-2V6h-3V4zM4 8V6h3V4H4c-1.1 0-2 .9-2 2v2h2zm16 8v2h-3v2h3c1.1 0 2-.9 2-2v-2h-2zM7 18H4v-2H2v2c0 1.1.9 2 2 2h3v-2zM18 8H6v8h12V8z',
  left: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  right: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  starO: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
  history: 'M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.95 8.95 0 0013 21a9 9 0 000-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
  folder: 'M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z',
  newdoc: 'M13 11h-2v3H8v2h3v3h2v-3h3v-2h-3zm1-9H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z',
  doc: 'M8 16h8v2H8zm0-4h8v2H8zm6-10H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z',
};
const mi = (name, size = 20) => { const s = sv('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', class: 'ms', 'aria-hidden': 'true', focusable: 'false' }); s.append(sv('path', { d: MI[name] })); return s; };
const vh = (t) => { const e = h('span', { class: 'vh' }); e.textContent = t; return e; };   // plain text kept for text lookups; aria-label names the control

const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn, text: label });
const bHome = btn('Home', () => {
  if (pages.length && stamp() !== savedSnap && !confirm(tr('Close this document without saving?'))) return;
  pages = []; sources.clear(); undoStack = []; redoStack = []; fileName = ''; lastSave = null; sel.clear(); selAnn = null; savedSnap = null; outline = []; protectOpts = null; leftMode = 'pages'; fullRender();
});
const bUndo = btn('Undo', () => undo());
const bRedo = btn('Redo', () => redo());
const search = h('input', { 'aria-label': 'Search text', type: 'search', placeholder: 'Search text', style: 'width:150px', onkeydown: (e) => { if (e.key === 'Enter') doSearch(search.value); } });
const swatchBox = h('div', { class: 'swatches' }, SWATCH.map((c) => { const b = h('button', { style: `background:${c}`, title: c, onclick: () => { color = c; refreshSwatches(); if (selAnn) mutateSel((a) => { a.color = c; }); } }); b.dataset.c = c; return b; }));
const sizeIn = h('input', { type: 'range', min: 1, max: 14, value: strokeW, title: 'Line width', style: 'width:100%', oninput: () => { strokeW = +sizeIn.value; if (selAnn) mutateSel((a) => { if (a.type === 'rect' || a.type === 'draw') a.w = strokeW; }); } });
const TABS = [['home', 'Home'], ['edit', 'Edit'], ['comment', 'Comment'], ['form', 'Form'], ['organise', 'Organise'], ['protect', 'Protect'], ['convert', 'Convert'], ['tools', 'Tools'], ['view', 'View']];
let ribbonTab = 'home', ribbonOpen = true;
const tabEls = {};
const tabBar = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, n]) => (tabEls[k] = h('button', { class: 'tab', role: 'tab', text: n,
  onclick: () => { if (ribbonTab === k) ribbonOpen = !ribbonOpen; else { ribbonTab = k; ribbonOpen = true; } drawRibbon(); } }))));
const bLang = h('button', { class: 'btn minor', title: 'Language', onclick: () => { setLang(getLang() === 'th' ? 'en' : 'th'); retranslate(); } });
const langLabel = () => { bLang.textContent = getLang() === 'th' ? 'EN' : 'ไทย'; bLang.dataset.k = 'Language'; bLang.title = tr('Language'); bLang.setAttribute('aria-label', tr('Language') + ': ' + bLang.textContent); };
langLabel();
// top app bar: home, brand, file name, search, then undo/redo, language and the two main actions
const bOpen = btn('Open', () => openFiles(false), 'primary tonal');
const bSave = btn('Save as', () => save(), 'primary');
const docName = h('div', { class: 'docname', role: 'status' });
const brandEl = h('div', { class: 'brand' }, h('img', { src: 'brand.svg', alt: '' }), h('span', { text: 'PDFout' }));
const sbox = h('label', { class: 'sbox' }, mi('search'), search);
search.style.width = '';
toolbar.append(bHome, brandEl, docName, h('span', { class: 'grow' }), sbox, h('div', { class: 'tend' }, bUndo, bRedo, bLang, bOpen, bSave));
// mode bar: the tool sets as chips, and a quick zoom control on the right
const zb = (key, icon, fn) => h('button', { class: 'zbtn', type: 'button', title: key, 'aria-label': key, onclick: fn }, mi(icon), vh({ 'Zoom out': '-', 'Zoom in': '+', 'Fit to width': 'Fit' }[key]));
const zOut = zb('Zoom out', 'minus', () => setZoom(zoom / 1.15));
const zPct = h('span', { class: 'zpct', 'aria-live': 'polite' });
const zIn = zb('Zoom in', 'plus', () => setZoom(zoom * 1.15));
const zFit = zb('Fit to width', 'fit', () => fitWidth());
const zoomBar = h('div', { class: 'zoombar', role: 'group', 'aria-label': 'Zoom' }, zOut, zPct, zIn, zFit);
modebar.append(tabBar, zoomBar);
function retranslate() {
  const set = (el, key) => { if (!el) return; el.dataset.k = key; el.textContent = tr(key); el.title = tr(key); };
  set(bHome, 'Home'); set(bUndo, 'Undo'); set(bRedo, 'Redo'); set(bOpen, 'Open'); set(bSave, 'Save as');
  TABS.forEach(([k, n]) => set(tabEls[k], n));
  search.placeholder = tr('Search text'); search.setAttribute('aria-label', tr('Search text'));
  for (const [b, k] of [[zOut, 'Zoom out'], [zIn, 'Zoom in'], [zFit, 'Fit to width']]) { b.title = tr(k); b.setAttribute('aria-label', tr(k)); }
  zoomBar.setAttribute('aria-label', tr('Zoom')); ribbon.setAttribute('aria-label', tr('Tools'));
  document.documentElement.lang = getLang();
  langLabel(); drawRibbon(); fullRender();
}
const rb = (label, fn, o = {}) => { const b = h('button', { class: 'btn rb' + (o.on ? ' on' : ''), onclick: fn, text: label, title: o.tip || label }); if (o.dis) b.disabled = true;
  const zi = { '-': 'minus', '+': 'plus' }[label]; // the kit has no icon for these labels; give them Material ones
  if (zi) { const s = mi(zi); s.classList.add('ic'); s.dataset.for = label; b.prepend(s); b.setAttribute('aria-label', tr(o.tip)); }
  return b; };
const rg = (...kids) => h('div', { class: 'rgroup' }, ...kids);
function drawRibbon() {
  const none = !pages.length;
  for (const [k, b] of Object.entries(tabEls)) { b.classList.toggle('on', k === ribbonTab && ribbonOpen); b.setAttribute('aria-selected', String(k === ribbonTab)); }
  ribbon.classList.toggle('closed', !ribbonOpen);
  ribbon.textContent = '';
  if (!ribbonOpen) return;
  const T = (k, n) => rb(n, () => setTool(k), { on: tool === k, dis: none });
  const sw = h('div', { class: 'rgroup rsw' }, swatchBox, h('div', { class: 'rw' }, h('span', { text: 'Line' }), sizeIn));
  const zoomG = rg(rb('Fit', () => fitWidth(), { dis: none, tip: 'Fit to width' }), rb('-', () => setZoom(zoom / 1.15), { dis: none, tip: 'Zoom out' }), rb('+', () => setZoom(zoom * 1.15), { dis: none, tip: 'Zoom in' }));
  const doc = (n, k, o = {}) => rb(n, () => X[k] && X[k](), { dis: none, ...o });
  const groups = {
    home: [rg(rb('Open', () => openFiles(false)), rb('Combine', () => openFiles(true), { dis: none, tip: 'Add another PDF or image to this one' }), rb('Save as', () => save(), { dis: none }), rb('Print', () => printDoc(), { dis: none })),
      rg(T('select', 'Select'), T('edittext', 'Edit text'), T('highlight', 'Highlight'), T('text', 'Text')), zoomG],
    edit: [rg(T('edittext', 'Edit text'), T('text', 'Text'), T('cover', 'Cover'), T('select', 'Select'), T('erase', 'Erase')),
      rg(rb('OCR', () => openOcr(), { dis: none, tip: 'First turn a scan or picture into text' }), doc('Replace text', 'replaceText', { tip: 'Find a word and change it everywhere' })),
      rg(doc('Image', 'insertImage', { tip: 'Place a picture on the page' }), doc('Marks', 'quickMarks', { tip: 'Tick, cross, dot and the date' }), T('link', 'Link'), doc('Stamp', 'stamp', { tip: 'Approved, Draft, Paid and more' }), doc('Header and footer', 'headerFooter', { tip: 'Text and numbers at the top or bottom of every page' }), rb('Page numbers', () => openPageNumbers(), { dis: none }))],
    comment: [rg(T('select', 'Select'), T('highlight', 'Highlight'), T('underline', 'Underline'), T('strike', 'Strikeout'), T('text', 'Text'), T('rect', 'Box'), T('ellipse', 'Ellipse'), T('line', 'Line'), T('arrow', 'Arrow'), T('draw', 'Pen'), T('erase', 'Erase'), rb('Sign', () => setTool('sign'), { dis: none })), sw],
    form: [rg(T('ftext', 'Text field'), T('fcheck', 'Checkbox'), T('fdrop', 'Dropdown'), T('select', 'Select'), T('erase', 'Erase')), rg(rb('Form data', () => openFormData(), { dis: none, tip: 'Fill the form from an FDF or XFDF file' }))],
    organise: [rg(...[['Rotate L', 'rotL'], ['Rotate R', 'rotR'], ['Delete', 'del'], ['Copy', 'dup'], ['Up', 'up'], ['Down', 'down'], ['Blank', 'blank']].map(([n, op]) => rb(n, () => pageOp(op), { dis: none, tip: n + ' (selected pages)' })), rb('Extract', () => extractSel(), { dis: none })),
      rg(doc('Crop', 'crop', { tip: 'Trim the margins of pages' }), doc('Page size', 'pageSize', { tip: 'Change the paper size' }), doc('Insert pages', 'insertPages', { tip: 'Add pages from another PDF or picture' }), doc('Split', 'split', { tip: 'Cut the document into several files' })),
      rg(doc('Reverse', 'reverse'), doc('Odd pages', 'selOdd'), doc('Even pages', 'selEven'), doc('Blank pages', 'findBlank', { tip: 'Find and remove empty pages' }))],
    protect: [rg(T('redact', 'Redact'), T('cover', 'Cover'), rb('Sign', () => setTool('sign'), { dis: none }), doc('Digital signature', 'certSign', { tip: 'Sign with a certificate so anyone can verify it' }), rb('Watermark', () => openWatermark(), { dis: none }), rb('Password', () => openProtect(), { dis: none, tip: 'Lock the saved PDF with a password' })),
      rg(doc('Redact words', 'redactWords', { tip: 'Find words and black them out everywhere' }), doc('Redact patterns', 'redactPatterns', { tip: 'Phone numbers, emails, ID numbers, cards' }), doc('Check signatures', 'verifySigs', { tip: 'See who signed this file and whether it was changed' }), doc('Clean metadata', 'sanitize', { tip: 'Remove hidden author, dates and notes' }), doc('Flatten', 'flatten', { tip: 'Turn form fields and notes into plain page content' }))],
    convert: [rg(rb('OCR', () => openOcr(), { dis: none, tip: 'Recognise text in scans and pictures' }), rb('Extract all text', () => extractText(), { dis: none }), doc('Word', 'exportWord', { tip: 'Save as a Word file with text, tables and pictures' }), doc('Markdown', 'exportMarkdown'), doc('Web page', 'exportHtml', { tip: 'Save as an HTML page' }), doc('Tables to CSV', 'exportCsv', { tip: 'Save the tables on the pages as a spreadsheet file' })),
      rg(rb('Export page as PNG', () => exportPng(), { dis: none }), rb('Export images', () => exportImages(), { dis: none, tip: 'Save every page as a PNG picture' }), doc('Embedded pictures', 'extractPictures', { tip: 'Save the pictures that are inside the PDF' }), rb('From images', () => createFromImages(), { tip: 'Create a PDF from pictures' })),
      rg(doc('PDF/A', 'pdfa', { tip: 'Archive copy for long term keeping' }), doc('Grey copy', 'grayscale', { tip: 'Save a black and white copy that prints cheaply' }), doc('Clean scan', 'cleanScan', { tip: 'Whiten the paper and sharpen the text of scans' }))],
    tools: [rg(rb('Combine', () => openFiles(true), { dis: none, tip: 'Add another PDF or image to this one' }), rb('Compress', () => saveCompressed(), { dis: none, tip: 'Save a smaller copy' }), rb('Watermark', () => openWatermark(), { dis: none }), rb('Page numbers', () => openPageNumbers(), { dis: none }), rb('Form data', () => openFormData(), { dis: none, tip: 'Fill form fields from an FDF or XFDF file' }), rb('Print', () => printDoc(), { dis: none })),
      rg(doc('Compare', 'compare', { tip: 'Show what changed between two PDFs' }), rb('Find in files', () => X.searchFiles && X.searchFiles(), { tip: 'Search many PDFs at once' }), doc('Bookmarks', 'bookmarks', { tip: 'Edit the bookmarks and contents' }), doc('Properties', 'properties', { tip: 'Title, author, subject and keywords' }), rb('Batch', () => X.batch && X.batch(), { tip: 'Do one job on many PDFs' }))],
    view: [zoomG, rg(rb('Fit page', () => X.fitPage && X.fitPage(), { dis: none }), rb('Dark pages', () => X.darkPages && X.darkPages(), { dis: none, on: X.isDark && X.isDark(), tip: 'Invert page colours for night reading' }), rb('Full screen', () => X.fullscreen && X.fullscreen(), { dis: none }), rb('Read aloud', () => X.readAloud && X.readAloud(), { dis: none, tip: 'Hear the page read out by this computer' }), rb('Shortcuts', () => X.shortcuts && X.shortcuts()))],
  };
  ribbon.append(...groups[ribbonTab].flatMap((g, i) => (i ? [h('span', { class: 'rsep' }), g] : [g])));
  placeDock();
}
// the tool bar floats over the bottom of the document; keep it centred on the page area and leave room to scroll past it
function placeDock() {
  for (const b of [zOut, zIn, zFit]) b.disabled = !pages.length;
  const r = stage.getBoundingClientRect();
  if (!ribbonOpen || !r.width) { stage.style.paddingBottom = ''; return; }
  ribbon.style.left = Math.round(r.left + r.width / 2) + 'px';
  ribbon.style.maxWidth = Math.max(200, Math.round(r.width - 24)) + 'px';
  ribbon.style.bottom = Math.max(8, Math.round(window.innerHeight - r.bottom + 12)) + 'px';
  stage.style.paddingBottom = (ribbon.offsetHeight + 28) + 'px';
}
window.addEventListener('resize', () => placeDock());
if (window.ResizeObserver) { const ro = new ResizeObserver(() => placeDock()); ro.observe(stage, { box: 'border-box' }); }
function refreshSwatches() { swatchBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === color)); }
refreshSwatches();
function setTool(t) {
  if (t === 'sign') { openSignature(); return; }
  tool = t;
  drawRibbon();
  stage.className = 'stage tool-' + t;
  if (t !== 'select') { selAnn = null; redrawOverlays(); }
  if (t === 'edittext') prepareEdit();
}
setTool('select');


// ---------- home screen (shown when no document is open) ----------
const home = h('div', { class: 'home' });
app.append(home);
let homeTab = 'recent', homeCat = 'popular';
// the quick tools are grouped into categories so the start screen shows a few at a time
const CATS = [
  ['popular', 'Popular', ['Edit text', 'Annotate', 'Sign', 'Redact', 'Combine files', 'Compress', 'Recognise text (OCR)', 'Password']],
  ['write', 'Write and fill', ['Edit text', 'Annotate', 'Sign', 'Fill form', 'Blank PDF', 'Page numbers']],
  ['pages', 'Pages', ['Organise pages', 'Crop pages', 'Split', 'Combine files', 'Batch', 'Bookmarks']],
  ['protect', 'Protect', ['Redact', 'Redact words', 'Password', 'Digital signature', 'Watermark']],
  ['convert', 'Convert', ['Save as Word', 'Export text', 'Recognise text (OCR)', 'Images to PDF', 'Export images', 'PDF/A archive', 'Compress']],
  ['tools', 'Tools', ['Compare', 'Find in files', 'Print', 'Batch']],
];
const IC = (d) => { const s = sv('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); s.innerHTML = d; return s; };
async function openThen(fn) { await openFiles(false); if (pages.length && fn) setTimeout(fn, 60); }
async function createBlank() {
  if (isDirty() && !confirm(tr('Close this document without saving?'))) return;
  const d = await PDFDocument.create(); d.addPage([595.28, 841.89]);
  pages = []; sources.clear(); undoStack = []; redoStack = []; fileName = 'Untitled.pdf'; lastSave = null; outline = []; protectOpts = null;
  const sid = await addSource('Untitled.pdf', new Uint8Array(await d.save()));
  pages.push(...await pagesOf(sid)); sel.clear(); curPage = 0; selAnn = null; meta = { title: '', author: '' };
  setTimeout(() => { savedSnap = stamp(); }, 0); fullRender();
}
const QUICK = [
  ['Edit text', 'Change the words already in a PDF.', '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M4 7h6M4 11h4"/>', () => openThen(() => setTool('edittext'))],
  ['Annotate', 'Highlight, draw and add notes.', '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>', () => openThen(() => setTool('highlight'))],
  ['Sign', 'Draw your signature and place it.', '<path d="M3 17c3-6 5-9 6-6s-2 7 1 6 4-5 5-3 3 2 6-1"/><path d="M3 21h18"/>', () => openThen(() => openSignature())],
  ['Redact', 'Remove private details for real.', '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M7 12h10" stroke-width="4"/>', () => openThen(() => setTool('redact'))],
  ['Organise pages', 'Rotate, move, delete or extract.', '<rect x="4" y="3" width="9" height="12" rx="1"/><rect x="11" y="9" width="9" height="12" rx="1"/>', () => openThen()],
  ['Combine files', 'Join several PDFs into one.', '<rect x="3" y="4" width="8" height="10" rx="1"/><rect x="13" y="10" width="8" height="10" rx="1"/><path d="M11 9h2"/>', async () => { await openFiles(false); }],
  ['Compress', 'Make the file smaller.', '<path d="M12 3v7m0 0l-3-3m3 3l3-3M12 21v-7m0 0l-3 3m3-3l3 3"/>', () => openThen(() => saveCompressed())],
  ['Export text', 'Copy out all the words.', '<path d="M5 6h14M12 6v13M9 19h6"/>', () => openThen(() => extractText())],
  ['Recognise text (OCR)', 'Turn scans and photos into real text.', '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 9h8M8 12h8M8 15h5"/>', () => openThen(() => openOcr())],
  ['Images to PDF', 'Make a PDF from pictures.', '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M5 18l5-5 3 3 3-3 3 3"/>', () => createFromImages()],
  ['Export images', 'Save every page as a picture.', '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>', () => openThen(() => exportImages())],
  ['Password', 'Lock the saved PDF with a password.', '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>', () => openThen(() => openProtect())],
  ['Watermark', 'Stamp text across the pages.', '<path d="M12 3c3 4 6 7 6 10a6 6 0 01-12 0c0-3 3-6 6-10z"/>', () => openThen(() => openWatermark())],
  ['Page numbers', 'Number every page.', '<path d="M6 4h12v16H6z"/><path d="M10 15h4"/>', () => openThen(() => openPageNumbers())],
  ['Print', 'Send the document to a printer.', '<path d="M7 8V3h10v5M7 17H4v-7h16v7h-3M7 14h10v7H7z"/>', () => openThen(() => printDoc())],
  ['Fill form', 'Open a PDF form, or load FDF / XFDF data.', '<path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h4"/>', () => openThen(() => openFormData())],
  ['Crop pages', 'Trim the margins of every page.', '<path d="M6 2v16h16M2 6h16v16"/>', () => openThen(() => X.crop && X.crop())],
  ['Split', 'Cut a PDF into several files.', '<path d="M12 3v18M8 7L4 12l4 5M16 7l4 5-4 5"/>', () => openThen(() => X.split && X.split())],
  ['Compare', 'See what changed between two PDFs.', '<path d="M4 4h7v16H4zM13 4h7v16h-7z"/>', () => openThen(() => X.compare && X.compare())],
  ['Find in files', 'Search many PDFs at once.', '<circle cx="10" cy="10" r="6"/><path d="M15 15l6 6"/>', () => X.searchFiles && X.searchFiles()],
  ['Bookmarks', 'Add a contents list to a long PDF.', '<path d="M6 3h12v18l-6-4-6 4z"/>', () => openThen(() => X.bookmarks && X.bookmarks())],
  ['Digital signature', 'Sign with a certificate that can be checked.', '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/>', () => openThen(() => X.certSign && X.certSign())],
  ['Redact words', 'Find words and black them out everywhere.', '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M7 10h6M7 14h10" stroke-width="3"/>', () => openThen(() => X.redactWords && X.redactWords())],
  ['PDF/A archive', 'A copy made for long term keeping.', '<path d="M6 3h8l4 4v14H6z"/><path d="M9 14l2 2 4-4"/>', () => openThen(() => X.pdfa && X.pdfa())],
  ['Save as Word', 'Text, tables and pictures in a .docx file.', '<path d="M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4"/>', () => openThen(() => X.exportWord && X.exportWord())],
  ['Batch', 'Do one job on many PDFs.', '<rect x="5" y="5" width="10" height="10"/><rect x="9" y="9" width="10" height="10"/>', () => X.batch && X.batch()],
  ['Blank PDF', 'Start from an empty page.', '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>', () => createBlank()],
];
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtDate = (t) => { const d = new Date(t); return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
async function renderHome() {
  home.textContent = '';
  const nb = (cls, icon, key, fn) => h('button', { class: cls, type: 'button', onclick: fn }, mi(icon, 22), h('span', { class: 'hl', text: key }));
  const tabs = [['recent', 'Recent files', 'history'], ['starred', 'Starred files', 'starO']];
  const nav = h('nav', { class: 'home-nav', 'aria-label': 'PDFout' },
    h('div', { class: 'home-brand' }, h('img', { src: 'brand.svg', alt: '' }), h('span', { text: 'PDFout' })),
    nb('hnew', 'folder', 'Open PDF', () => openFiles(false)),
    nb('hnew alt', 'newdoc', 'Create PDF', () => createBlank()),
    h('div', { class: 'home-links' }, ...tabs.map(([k, n, ic]) => { const b = nb('htab home-link' + (homeTab === k ? ' on' : ''), ic, n, () => { homeTab = k; renderHome(); }); b.title = tr(n); if (homeTab === k) b.setAttribute('aria-current', 'page'); return b; })));
  nav.querySelectorAll('.hnew').forEach((b) => { b.title = b.textContent; });
  const cat = CATS.find((x) => x[0] === homeCat) || CATS[0], shown = cat[2].map((n) => QUICK.find((q) => q[0] === n)).filter(Boolean);
  const chip = (k, n) => h('button', { class: 'chip' + (k === homeCat ? ' on' : ''), 'aria-pressed': String(k === homeCat), text: n, onclick: () => { homeCat = k; renderHome(); } });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Quick tools' }, ...CATS.map(([k, n]) => chip(k, n)), chip('all', 'All'));
  const list_ = homeCat === 'all' ? QUICK : shown;
  const quick = h('div', {}, chips, h('div', { class: 'quick' }, ...list_.map(([t, d, ic, fn]) => h('button', { class: 'qcard', onclick: fn }, IC(ic), h('div', {}, h('b', { text: t }), h('span', { text: d }))))));
  let list = [];
  try { list = await window.host.recentList(); } catch {}
  if (homeTab === 'starred') list = list.filter((x) => x.star);
  const body = list.length ? h('table', { class: 'grid recent' },
    h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Name' }), h('th', { text: 'Folder' }), h('th', { text: 'Size' }))),
    h('tbody', {}, list.map((x) => h('tr', { onclick: async () => { try { await openFiles(false, [await window.host.recentOpen(x.id)]); } catch (e) { toast('Cannot open: ' + (e.message || e)); } } },
      h('td', {}, h('button', { class: 'star' + (x.star ? ' on' : ''), title: 'Star', 'aria-label': 'Star', 'aria-pressed': String(!!x.star), onclick: async (e) => { e.stopPropagation(); await window.host.recentStar(x.id); renderHome(); } }, mi(x.star ? 'star' : 'starO'))),
      h('td', {}, h('button', { class: 'rname', type: 'button', onclick: (e) => { e.stopPropagation(); e.currentTarget.closest('tr').click(); } }, h('b', { text: x.name })), h('div', { class: 'muted', text: fmtDate(x.mtime) })),
      h('td', { class: 'muted', text: x.dir }), h('td', { class: 'muted', text: fmtSize(x.size) })))))
    : h('div', { class: 'home-empty' }, mi('doc', 40), h('b', { text: homeTab === 'starred' ? 'No starred files yet' : 'No recent files yet' }), h('span', { text: 'Files you open will appear here. Click the star to keep one handy.' }));
  home.append(nav, h('main', { class: 'home-main' }, h('div', { class: 'home-in' },
    h('div', { class: 'home-hero' }, h('h1', { text: 'What would you like to do with a PDF?' }), h('p', { class: 'hlead', text: 'Everything stays on this computer. Nothing is uploaded.' })),
    h('div', { class: 'home-head' }, h('h2', { text: homeTab === 'starred' ? 'Starred files' : 'Recent files' }), list.length && homeTab === 'recent' ? btn('Clear list', async () => { await window.host.recentClear(); renderHome(); }) : null),
    body,
    h('div', { class: 'home-head' }, h('h2', { text: 'Quick tools' })), quick)));
}

// ---------- page model ----------
async function askPassword(name, wrong) {
  return new Promise((res) => {
    const pw = h('input', { type: 'password', style: 'width:100%' });
    let back;
    const done = (v) => { back.remove(); res(v); };
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(pw.value); if (e.key === 'Escape') done(null); });
    back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'This PDF is locked' }),
      h('div', { class: 'muted', text: name }),
      wrong ? h('div', { style: 'color:#f28b82;margin:6px 0', text: 'That password is not right. Try again.' }) : h('div', { class: 'muted', style: 'margin:6px 0', text: 'Type the password to open it. It stays on this computer.' }),
      h('label', { class: 'field' }, 'Password', pw),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Cancel', () => done(null)), btn('Unlock', () => done(pw.value), 'primary'))));
    document.body.append(back); setTimeout(() => pw.focus(), 50);
  });
}
async function addSource(name, bytes) {
  const id = uid();
  const open = (b, password) => pdfjs.getDocument({ data: b.slice(), password: password || '', isEvalSupported: false, enableXfa: false }).promise;
  let pdf = null, pw = '', wrong = false, locked = false;
  for (;;) {
    try { pdf = await open(bytes, pw); break; }
    catch (e) {
      if (!e || e.name !== 'PasswordException') throw e;
      locked = true; wrong = e.code === 2;
      const v = await askPassword(name, wrong);
      if (v === null) throw new Error('The PDF was not unlocked');
      pw = v;
    }
  }
  const ent = { name, bytes, pdf, fields: [], vals: {} };
  sources.set(id, ent);
  let d = null;
  try { d = await PDFDocument.load(bytes); }
  catch (e) {
    if (/encrypt/i.test(String((e && e.message) || ''))) {
      // pdf-lib cannot read protected files, so keep a plain copy of the unlocked document for every later step
      try {
        d = await PDFDocument.load(bytes, { password: pw });
        const plain = new Uint8Array(await d.save());
        ent.bytes = plain; ent.pdf = await open(plain, '');
        toast(locked ? 'Unlocked. Saving makes a copy without the password; add one in Protect > Password.' : 'This PDF had restrictions; the copy you save has none.');
      } catch (e2) { sources.delete(id); throw new Error('Could not unlock this PDF: ' + ((e2 && e2.message) || e2)); }
    } else { try { d = await PDFDocument.load(bytes, { ignoreEncryption: true }); } catch {} }
  }
  try {
    if (d) ent.fields = d.getForm().getFields().map((f) => {
      const t = f.constructor.name;
      // the bundled pdf-lib is minified, so class names are unreliable: detect the field type by what it can do
      const kind = typeof f.setText === 'function' ? 'text' : typeof f.check === 'function' ? 'check' : typeof f.isOffToggleable === 'function' ? 'radio' : (typeof f.isEditable === 'function' || typeof f.isMultiselect === 'function') ? 'choice' : (/TextField/.test(t) ? 'text' : /CheckBox/.test(t) ? 'check' : null);
      if (!kind) return null;
      // the value already in the file, so the panel shows it and Save as keeps it
      let v;
      try { v = kind === 'text' ? (f.getText() || '') : kind === 'check' ? f.isChecked() : [].concat(f.getSelected() || [])[0] || ''; } catch { v = kind === 'check' ? false : ''; }
      ent.vals[f.getName()] = v;
      return { name: f.getName(), kind, options: f.getOptions ? f.getOptions() : [] };
    }).filter(Boolean);
  } catch {}
  ent.vals0 = { ...ent.vals };
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
const IMG_RE = /\.(png|jpe?g|webp|bmp|gif)$/i, FORM_RE = /\.(xfdf|fdf)$/i;
const OPEN_FILTERS = [['Common files', ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'fdf', 'xfdf']], ['PDF files', ['pdf']], ['Images', ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']], ['FDF / XFDF form data', ['fdf', 'xfdf']]];
const toBytes = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));
async function imageToPdf(bytes, isJpg) {
  const d = await PDFDocument.create();
  let im, w, hh;
  if (isJpg) { try { im = await d.embedJpg(bytes); w = im.width; hh = im.height; } catch { im = null; } }
  if (!im) {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const cv = h('canvas'); cv.width = bmp.width; cv.height = bmp.height; cv.getContext('2d').drawImage(bmp, 0, 0);
    const png = new Uint8Array(await (await new Promise((r) => cv.toBlob(r, 'image/png'))).arrayBuffer());
    im = await d.embedPng(png); w = bmp.width; hh = bmp.height;
  }
  const k = Math.min(1, 1100 / Math.max(w, hh)) * 0.75; // pixels to points, capped to a sensible page size
  const pg = d.addPage([w * k, hh * k]); pg.drawImage(im, { x: 0, y: 0, width: w * k, height: hh * k });
  return new Uint8Array(await d.save());
}
const unPdf = (s) => s.replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n');
function parseFormData(name, bytes) {
  const text = new TextDecoder('utf-8').decode(bytes), out = {};
  if (/\.xfdf$/i.test(name)) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const walk = (el, prefix) => {
      for (const f of [...el.children].filter((c) => c.localName === 'field')) {
        const nm = prefix ? prefix + '.' + f.getAttribute('name') : f.getAttribute('name');
        const v = [...f.children].find((c) => c.localName === 'value');
        if (v) out[nm] = v.textContent; walk(f, nm);
      }
    };
    for (const root of [...doc.getElementsByTagName('fields')]) walk(root, '');
  } else {
    const re1 = /\/T\s*\(((?:\\.|[^)\\])*)\)\s*\/V\s*(\((?:\\.|[^)\\])*\)|\/[^\s/>\]]+)/g, re2 = /\/V\s*(\((?:\\.|[^)\\])*\)|\/[^\s/>\]]+)\s*\/T\s*\(((?:\\.|[^)\\])*)\)/g;
    const val = (s) => (s[0] === '(' ? unPdf(s.slice(1, -1)) : s.slice(1));
    let m; while ((m = re1.exec(text))) out[unPdf(m[1])] = val(m[2]);
    while ((m = re2.exec(text))) out[unPdf(m[2])] = val(m[1]);
  }
  return out;
}
function applyFormData(map) {
  const ent = [...sources.values()][0]; if (!ent) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(map)) {
    const f = ent.fields.find((x) => x.name === k) || ent.fields.find((x) => k.endsWith('.' + x.name) || x.name.endsWith('.' + k));
    if (!f) continue;
    ent.vals[f.name] = f.kind === 'check' ? /^(yes|on|true|1)$/i.test(v) : v; n++;
  }
  return n;
}
async function loadFiles(files, merge) {
  if (!files || !files.length) return;
  const forms = files.filter((f) => FORM_RE.test(f.name)), docs = files.filter((f) => !FORM_RE.test(f.name));
  if (!docs.length) {
    if (!pages.length) { toast('Open a PDF first, then load its form data (FDF / XFDF)'); return; }
    let n = 0; for (const f of forms) n += applyFormData(parseFormData(f.name, toBytes(f.data)));
    toast(n ? `Filled ${n} form field${n > 1 ? 's' : ''} from the file` : 'No matching form fields were found'); renderRight(); return;
  }
  // replacing the open document: ask first when it has unsaved changes
  if (!merge && isDirty() && !confirm(tr('Open this file and close the current one without saving?'))) return;
  // load into new sources first; the open document is only replaced once at least one file opened
  const before = new Set(sources.keys()), added = []; let firstName = '';
  for (const f of docs) {
    try {
      let bytes = toBytes(f.data);
      if (IMG_RE.test(f.name)) bytes = await imageToPdf(bytes, /\.jpe?g$/i.test(f.name));
      const sid = await addSource(f.name.replace(IMG_RE, '.pdf'), bytes);
      added.push(...await pagesOf(sid)); if (!firstName) firstName = f.name.replace(IMG_RE, '.pdf');
    } catch (e) { toast(`Cannot open ${f.name}: ${e.message || e}`); }
  }
  if (!added.length) { for (const k of [...sources.keys()]) if (!before.has(k)) sources.delete(k); return; }
  if (merge) { commit(); pages.push(...added); }
  else { for (const k of before) sources.delete(k); pages = added; undoStack = []; redoStack = []; fileName = firstName; lastSave = null; outline = []; protectOpts = null; }
  if (!merge && pages.length) { const first = [...sources.values()][0]; try { const m = await first.pdf.getMetadata(); meta = { title: m.info?.Title || '', author: m.info?.Author || '', subject: m.info?.Subject || '', keywords: m.info?.Keywords || '' }; } catch { meta = { title: '', author: '' }; } if (X.loadOutline) { try { await X.loadOutline(); } catch {} } }
  sel.clear(); curPage = 0; selAnn = null; if (!merge) setTimeout(() => { savedSnap = stamp(); }, 0);
  for (const f of forms) applyFormData(parseFormData(f.name, toBytes(f.data)));
  fullRender();
}
async function openFiles(merge, preset) {
  const files = preset || await window.host.openFiles({ multi: true, filters: OPEN_FILTERS });
  await loadFiles(files, merge);
}

// ---------- undo ----------
// Big picture strings are stored once and snapshots only hold a short id, so 80 undo steps do not copy every image 80 times.
const BLOB_MIN = 2000, blobIds = new Map(), blobList = [];
const snapReplacer = (k, v) => {
  if (typeof v !== 'string' || v.length < BLOB_MIN || !v.startsWith('data:')) return v;
  let id = blobIds.get(v); if (id === undefined) { id = blobList.length; blobList.push(v); blobIds.set(v, id); }
  return '\u0001blob:' + id;
};
const snapReviver = (k, v) => (typeof v === 'string' && v.startsWith('\u0001blob:') ? blobList[+v.slice(6)] : v);
const snapshot = () => JSON.stringify(pages.map((p) => ({ ...p })), snapReplacer);
const stamp = () => snapshot() + JSON.stringify([outline, meta, [...sources.values()].map((e) => e.vals), protectOpts]);   // what counts as unsaved work (pages, bookmarks, properties, form values, password)
const isDirty = () => pages.length > 0 && stamp() !== savedSnap;
function commit() { undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; updateButtons(); }
function restore(s) { pages = JSON.parse(s, snapReviver); sel = new Set([...sel].filter((id) => pages.some((p) => p.id === id))); selAnn = null; fullRender(); }
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }
function updateButtons() { bUndo.disabled = !undoStack.length; bRedo.disabled = !redoStack.length; drawRibbon(); }

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
  curPage = Math.max(0, Math.min(curPage, pages.length - 1));   // pages may have been deleted or undone
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
  const src = sources.get(p.src);
  if (!src) { el.textContent = ''; el.append(makeOverlay(p)); return; }   // a page added with Blank: nothing to draw, but it still takes marks
  const pg = await src.pdf.getPage(p.index + 1);
  const vp = pg.getViewport({ scale: zoom, rotation: (pg.rotate + p.rot) % 360 });
  // pixels per CSS pixel; capped so a very large page or zoom never asks for a canvas the browser cannot make (it would stay blank)
  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(16e6 / (vp.width * vp.height)), 16000 / Math.max(vp.width, vp.height));
  const cv = h('canvas'); cv.width = Math.max(1, Math.floor(vp.width * dpr)); cv.height = Math.max(1, Math.floor(vp.height * dpr));
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
let leftMode = 'pages';
// panel header: a title and a button that hides the panel (the grip beside it, now focused, brings it back)
function panelHead(side, title) {
  const b = h('button', { class: 'pbtn', type: 'button', title: 'Hide panel', 'aria-label': 'Hide panel', onclick: () => {
    const wb = document.querySelector('.wbs .wb[data-id=' + side + ']'); if (wb) wb.click();
    requestAnimationFrame(() => requestAnimationFrame(() => { const g = document.querySelector('.grip[data-side=' + side + ']'); if (g) g.focus(); }));
  } }, mi(side === 'left' ? 'left' : 'right'));
  return h('div', { class: 'phead' }, h('h2', { class: 'ptitle', text: title }), b);
}
function renderThumbs() {
  left.textContent = '';
  thumbEls.clear();
  left.append(panelHead('left', leftMode === 'marks' ? 'Bookmarks' : 'Pages'));
  left.append(h('div', { class: 'ptools modes', role: 'group' }, h('button', { class: 'btn' + (leftMode === 'pages' ? ' on' : ''), 'aria-pressed': String(leftMode === 'pages'), text: 'Pages', onclick: () => { leftMode = 'pages'; renderThumbs(); } }), h('button', { class: 'btn' + (leftMode === 'marks' ? ' on' : ''), 'aria-pressed': String(leftMode === 'marks'), text: 'Bookmarks', onclick: () => { leftMode = 'marks'; renderThumbs(); } })));
  if (leftMode === 'marks' && X.marksPanel) { X.marksPanel(left); return; }
  const tools = h('div', { class: 'ptools' },
    btn('Rotate L', () => pageOp('rotL')), btn('Rotate R', () => pageOp('rotR')), btn('Delete', () => pageOp('del')), btn('Copy', () => pageOp('dup')),
    btn('Up', () => pageOp('up')), btn('Down', () => pageOp('down')), btn('Blank', () => pageOp('blank')), btn('Extract', () => extractSel()));
  left.append(tools);
  pages.forEach((p, i) => {
    const c = h('canvas');
    const t = h('div', { class: 'thumb' + (sel.has(p.id) ? ' sel' : ''), onclick: (e) => thumbClick(e, p, i) }, c, h('span', { text: String(i + 1) }));
    t.draggable = true;
    t.addEventListener('dragstart', (e) => { const ids = sel.has(p.id) ? pages.filter((x) => sel.has(x.id)).map((x) => x.id) : [p.id]; e.dataTransfer.setData('text/x-pdfout-pages', JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'move'; });
    t.addEventListener('dragover', (e) => { if (![...e.dataTransfer.types].includes('text/x-pdfout-pages')) return; e.preventDefault(); const r = t.getBoundingClientRect(), after = e.clientY >= r.top + r.height / 2; t.classList.toggle('dropafter', after); t.classList.toggle('dropbefore', !after); });
    t.addEventListener('dragleave', () => t.classList.remove('dropbefore', 'dropafter'));
    t.addEventListener('drop', (e) => { const raw = e.dataTransfer.getData('text/x-pdfout-pages'); t.classList.remove('dropbefore', 'dropafter'); if (!raw) return; e.preventDefault(); e.stopPropagation(); const r = t.getBoundingClientRect(); movePages(JSON.parse(raw), p.id, e.clientY >= r.top + r.height / 2); });
    thumbEls.set(p.id, t); left.append(t);
    drawThumb(c, p);
  });
}
async function drawThumb(c, p) {
  const src = sources.get(p.src); if (!src) return;
  const pg = await src.pdf.getPage(p.index + 1);
  const base = pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rot) % 360 });
  const s = Math.min(140 / base.width, 600 / base.height); const vp = pg.getViewport({ scale: s, rotation: (pg.rotate + p.rot) % 360 });
  c.width = vp.width; c.height = vp.height;
  try { await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch {}
}
function thumbClick(e, p, i) {
  if (e.ctrlKey || e.metaKey) { sel.has(p.id) ? sel.delete(p.id) : sel.add(p.id); }
  else if (e.shiftKey && sel.size) { const last = pages.findIndex((x) => sel.has(x.id)); const [a, b] = [Math.min(last, i), Math.max(last, i)]; sel = new Set(pages.slice(a, b + 1).map((x) => x.id)); }
  else sel = new Set([p.id]);
  thumbEls.forEach((el, id) => el.classList.toggle('sel', sel.has(id)));
  // the clicked page becomes the current one even when the document fits on screen and nothing scrolls
  if (curPage !== i) { curPage = i; renderStatus(); }
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
  docName.textContent = fileName || ''; docName.title = fileName || '';
  zPct.textContent = pages.length ? Math.round(zoom * 100) + '%' : '';
  status.append(h('span', { text: fileName || 'No file' }), h('span', { class: 'grow' }), h('span', { text: pages.length ? `Page ${curPage + 1} of ${pages.length}` : '' }), h('span', { text: Math.round(zoom * 100) + '%' }));
}

// ---------- page operations ----------
function movePages(ids, targetId, after) {
  if (ids.includes(targetId)) return;
  const moving = pages.filter((x) => ids.includes(x.id)), rest = pages.filter((x) => !ids.includes(x.id)), at = rest.findIndex((x) => x.id === targetId);
  if (!moving.length || at < 0) return;
  commit(); rest.splice(at + (after ? 1 : 0), 0, ...moving); pages = rest; fullRender();
}
function pageOp(op) {
  if (!pages.length) return;
  const ids = sel.size ? sel : new Set([pages[curPage].id]);
  if (op === 'del' && pages.every((p) => ids.has(p.id))) { toast('A document needs at least one page'); return; }   // refuse before commit() so Redo survives
  commit();
  if (op === 'rotL' || op === 'rotR') pages.forEach((p) => { if (ids.has(p.id)) p.rot = (p.rot + (op === 'rotR' ? 90 : 270)) % 360; });
  else if (op === 'del') { pages = pages.filter((p) => !ids.has(p.id)); sel.clear(); }
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
  if (tool === 'edittext' && p.src && lineCache.has(p.src + ':' + p.index)) for (const l of lineCache.get(p.src + ':' + p.index)) { const q1 = P(p, l.u0, l.v0, cw, ch), q2 = P(p, l.u1, l.v1, cw, ch); svg.prepend(sv('rect', { class: 'eline', x: Math.min(q1[0], q2[0]), y: Math.min(q1[1], q2[1]), width: Math.abs(q1[0] - q2[0]), height: Math.abs(q1[1] - q2[1]), fill: 'rgba(168,199,250,.10)', stroke: '#a8c7fa', 'stroke-dasharray': '3 3', 'stroke-width': 1 })); }
  svg.addEventListener('pointerdown', (e) => onPointerDown(e, p, svg, cw, ch));
  return svg;
}
function redrawOverlays() {
  pageEls.forEach((el, id) => { const p = pages.find((x) => x.id === id); const old = el.querySelector('svg.ov'); if (old && p) old.replaceWith(makeOverlay(p)); });
}
const P = (p, u, v, cw, ch) => { const [a, b] = rotFwd(u, v, p.rot); return [a * cw, b * ch]; };
const FIELD_TYPES = ['ftext', 'fcheck', 'fdrop'];
const isField = (a) => FIELD_TYPES.includes(a.type);
function drawAnn(p, a, cw, ch) {
  const g = sv('g'); g.dataset.aid = a.id;
  const sel_ = selAnn && selAnn.annId === a.id;
  if (isField(a)) {
    const pts = [[a.x, a.y], [a.x + a.bw, a.y], [a.x + a.bw, a.y + a.bh], [a.x, a.y + a.bh]].map(([u, v]) => P(p, u, v, cw, ch));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, hh = Math.max(...ys) - y;
    g.append(sv('rect', { x, y, width: w, height: hh, fill: 'rgba(168,199,250,.28)', stroke: '#6b9be8', 'stroke-width': 1.5, 'stroke-dasharray': sel_ ? '4 3' : '' }));
    const lab = sv('text', { x: x + 4, y: y + Math.min(hh - 3, 13), fill: '#1b3a6b', 'font-size': 11, 'font-family': 'Segoe UI, Arial', style: 'pointer-events:none' });
    lab.textContent = (a.type === 'fcheck' ? '☑ ' : a.type === 'fdrop' ? '▾ ' : '') + (a.fname || '');
    g.append(lab);
    if (sel_) { const hd = sv('rect', { x: x + w - 5, y: y + hh - 5, width: 10, height: 10, fill: '#ddd', stroke: '#444', class: 'rs', style: 'cursor:nwse-resize' }); g.append(hd); }
    g.style.cursor = tool === 'select' ? 'move' : 'default';
    return g;
  }
  if (a.type === 'ellipse' || a.type === 'link' || a.type === 'markline') {
    const pts = [[a.x, a.y], [a.x + a.bw, a.y], [a.x + a.bw, a.y + a.bh], [a.x, a.y + a.bh]].map(([u, v]) => P(p, u, v, cw, ch));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, hh = Math.max(...ys) - y;
    if (a.type === 'ellipse') g.append(sv('ellipse', { cx: x + w / 2, cy: y + hh / 2, rx: Math.max(0.5, w / 2), ry: Math.max(0.5, hh / 2), fill: 'rgba(0,0,0,0.001)', stroke: a.color, 'stroke-width': a.w }));
    else { g.append(sv('rect', { x, y, width: w, height: hh, fill: a.type === 'link' ? 'rgba(108,154,217,.16)' : 'none', stroke: '#6c9ad9', 'stroke-dasharray': '4 3', 'stroke-width': 1.5 })); if (a.type === 'link') g.append(Object.assign(sv('title'), { textContent: a.url || ('Page ' + ((pages.findIndex((q) => q.id === a.pid) + 1) || '?')) })); }
    if (sel_) { g.append(sv('rect', { x, y, width: w, height: hh, fill: 'none', stroke: '#888', 'stroke-dasharray': '4 3' })); g.append(sv('rect', { x: x + w - 5, y: y + hh - 5, width: 10, height: 10, fill: '#ddd', stroke: '#444', class: 'rs', style: 'cursor:nwse-resize' })); }
    g.style.cursor = tool === 'select' ? 'move' : 'default';
    return g;
  }
  if (a.type === 'line') {
    const q = a.pts.map(([u, v]) => P(p, u, v, cw, ch));
    g.append(sv('line', { x1: q[0][0], y1: q[0][1], x2: q[1][0], y2: q[1][1], stroke: 'rgba(0,0,0,0.001)', 'stroke-width': Math.max(a.w, 12), 'stroke-linecap': 'round' }));
    g.append(sv('line', { x1: q[0][0], y1: q[0][1], x2: q[1][0], y2: q[1][1], stroke: a.color, 'stroke-width': a.w, 'stroke-linecap': 'round', style: 'pointer-events:none' }));
    if (a.arrow) {
      const ang = Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]), L = Math.max(10, a.w * 4.5);
      for (const k of [-1, 1]) g.append(sv('line', { x1: q[1][0], y1: q[1][1], x2: q[1][0] - L * Math.cos(ang + k * 0.45), y2: q[1][1] - L * Math.sin(ang + k * 0.45), stroke: a.color, 'stroke-width': a.w, 'stroke-linecap': 'round', style: 'pointer-events:none' }));
    }
    if (sel_) g.append(sv('line', { x1: q[0][0], y1: q[0][1], x2: q[1][0], y2: q[1][1], stroke: '#888', 'stroke-width': a.w + 6, 'stroke-opacity': 0.3, 'stroke-linecap': 'round', style: 'pointer-events:none' }));
    g.style.cursor = tool === 'select' ? 'move' : 'default';
    return g;
  }
  if (a.type === 'rect' || a.type === 'highlight' || a.type === 'redact' || a.type === 'cover' || a.type === 'image') {
    const pts = [[a.x, a.y], [a.x + a.bw, a.y], [a.x + a.bw, a.y + a.bh], [a.x, a.y + a.bh]].map(([u, v]) => P(p, u, v, cw, ch));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, hh = Math.max(...ys) - y;
    if (a.type === 'image') g.append(sv('image', { href: a.data, x, y, width: w, height: hh, preserveAspectRatio: 'none' }));
    else g.append(sv('rect', { x, y, width: w, height: hh, fill: a.type === 'rect' ? 'none' : a.type === 'redact' ? '#000' : a.type === 'cover' ? (a.fillc || '#fff') : a.color, 'fill-opacity': a.type === 'highlight' ? 0.4 : 1, stroke: a.type === 'rect' ? a.color : 'none', 'stroke-width': a.w || 2, style: a.type === 'highlight' ? 'mix-blend-mode:multiply' : '' }));
    if (sel_) { g.append(sv('rect', { x, y, width: w, height: hh, fill: 'none', stroke: '#888', 'stroke-dasharray': '4 3' })); const hd = sv('rect', { x: x + w - 5, y: y + hh - 5, width: 10, height: 10, fill: '#ddd', stroke: '#444', class: 'rs', style: 'cursor:nwse-resize' }); g.append(hd); }
  } else if (a.type === 'draw') {
    const d = a.pts.map(([u, v], i) => { const [x, y] = P(p, u, v, cw, ch); return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }).join(' ');
    g.append(sv('path', { d, fill: 'none', stroke: a.color, 'stroke-width': a.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    if (sel_) g.append(sv('path', { d, fill: 'none', stroke: '#888', 'stroke-width': a.w + 4, 'stroke-opacity': 0.35 }));
  } else if (a.type === 'text') {
    const [bw] = dispDims(p); const fs = a.fs * bw * zoom * (p.rot % 180 ? 1 : 1);
    const [x, y] = P(p, a.x, a.y, cw, ch);
    const t = sv('text', { x: 0, y: 0, fill: a.color, 'fill-opacity': a.op == null ? 1 : a.op, 'font-size': fs, 'font-weight': a.bold ? 700 : 400, 'font-family': '"Noto Sans Thai", Helvetica, Arial, sans-serif', 'dominant-baseline': 'hanging', 'text-anchor': a.mid ? 'middle' : a.al === 'r' ? 'end' : 'start', transform: `translate(${x} ${y}) rotate(${p.rot + (a.ang || 0)})`, style: 'white-space:pre' });
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
    const curSvg = () => (pageEls.get(p.id) && pageEls.get(p.id).querySelector('svg.ov')) || svg;
    const [su, sv_] = localUV(e, svg, p, cw, ch);
    const orig = JSON.parse(JSON.stringify(a));
    let moved = false;
    // redrawOverlays() swaps the overlay <svg> while dragging, so listen on the window and
    // measure against whichever overlay is current (the old one was being detached after the first move)
    const move = (ev) => {
      const [u, v] = localUV(ev, curSvg(), p, cw, ch); const du = u - su, dv = v - sv_;
      if (!moved) { if (Math.abs(du) + Math.abs(dv) < 0.002) return; moved = true; commit(); }
      if (resize && a.bw != null) { a.bw = Math.max(0.01, orig.bw + du); a.bh = Math.max(0.01, orig.bh + dv); }
      else if (a.pts) a.pts = orig.pts.map(([x, y]) => [x + du, y + dv]);
      else { a.x = orig.x + du; a.y = orig.y + dv; }
      redrawOverlays();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); renderRight(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    redrawOverlays(); renderRight();
    return;
  }
  if (tool === 'edittext') {
    if (aEl) { const an = p.annots.find((x) => x.id === aEl.dataset.aid); if (an && an.type === 'text') editText(p, an, 0, 0, e.clientX, e.clientY); return; }
    const [u, v] = localUV(e, svg, p, cw, ch); editExisting(p, u, v); return;
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
  else if (tool === 'line' || tool === 'arrow') ann = mkAnn({ type: 'line', arrow: tool === 'arrow', pts: [[u0, v0], [u0, v0]] });
  else if (tool === 'underline' || tool === 'strike') ann = mkAnn({ type: 'markline', kind: tool, x: u0, y: v0, bw: 0, bh: 0 });
  else ann = mkAnn({ type: tool, x: u0, y: v0, bw: 0, bh: 0 });
  const tmp = drawAnn(p, ann, cw, ch); svg.append(tmp);
  const move = (ev) => {
    const [u, v] = localUV(ev, svg, p, cw, ch);
    if (ann.type === 'draw') ann.pts.push([u, v]);
    else if (ann.type === 'line') ann.pts[1] = [u, v];
    else { ann.x = Math.min(u0, u); ann.y = Math.min(v0, v); ann.bw = Math.abs(u - u0); ann.bh = Math.abs(v - v0); }
    const n = drawAnn(p, ann, cw, ch); tmp.replaceWith(n); Object.assign(tmp, {}); svg._tmp = n; svg.dataset.tmp = '1';
    tmpRef.el = n;
  };
  const tmpRef = { el: tmp };
  const mv = (ev) => { move(ev); };
  const up = () => {
    svg.removeEventListener('pointermove', mv); svg.removeEventListener('pointerup', up);
    const tiny = ann.type === 'draw' ? ann.pts.length < 2 : ann.type === 'line' ? Math.hypot(ann.pts[1][0] - ann.pts[0][0], ann.pts[1][1] - ann.pts[0][1]) < 0.006 : (ann.bw < 0.004 || (ann.bh < 0.004 && ann.type !== 'markline'));
    let made = ann;
    if (!tiny && ann.type === 'markline') { const yy = ann.kind === 'strike' ? ann.y + ann.bh / 2 : ann.y + ann.bh; made = mkAnn({ type: 'line', pts: [[ann.x, yy], [ann.x + ann.bw, yy]], w: Math.max(1.5, strokeW * 0.6) }); }
    if (!tiny) { commit(); if (isField(made)) { made.fname = nextFieldName(made.type); } p.annots.push(made); }
    tmpRef.el.remove(); redrawOverlays();
    if (!tiny && isField(made)) editField(made);
    if (!tiny && made.type === 'link') { if (X.editLink) X.editLink(made, p); else p.annots = p.annots.filter((q) => q !== made); }
  };
  svg.addEventListener('pointermove', mv); svg.addEventListener('pointerup', up);
}
function nextFieldName(type) {
  const base = type === 'fcheck' ? 'Check' : type === 'fdrop' ? 'Choice' : 'Text';
  const used = new Set(pages.flatMap((q) => q.annots.filter(isField).map((x) => x.fname)));
  let n = 1; while (used.has(base + n)) n++;
  return base + n;
}
function editField(ann) {
  const nm = h('input', { type: 'text', value: ann.fname || '', style: 'width:100%' });
  const opts = ann.type === 'fdrop' ? h('textarea', { rows: 4, style: 'width:100%', placeholder: 'One choice per line' }) : null;
  if (opts) opts.value = (ann.opts || ['Option 1', 'Option 2', 'Option 3']).join('\n');
  let back;
  back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: ann.type === 'fcheck' ? 'Checkbox' : ann.type === 'fdrop' ? 'Dropdown' : 'Text field' }),
    h('label', { class: 'field' }, 'Field name', nm), opts ? h('label', { class: 'field' }, 'Choices', opts) : null,
    h('div', { class: 'muted', style: 'margin:4px 0', text: 'Saved as a real fill-in field. Anyone can click it and type in any PDF reader.' }),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Delete field', () => { commit(); pages.forEach((q) => { q.annots = q.annots.filter((x) => x.id !== ann.id); }); redrawOverlays(); back.remove(); }),
      btn('OK', () => {
        const name = nm.value.trim(); if (!name) return;
        const clash = pages.some((q) => q.annots.some((x) => isField(x) && x.id !== ann.id && x.fname === name));
        if (clash) { toast('Another field already has that name'); return; }
        commit(); ann.fname = name; if (opts) ann.opts = opts.value.split('\n').map((x) => x.trim()).filter(Boolean);
        redrawOverlays(); back.remove();
      }, 'primary'))));
  document.body.append(back); setTimeout(() => { nm.focus(); nm.select(); }, 50);
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
  const fl = [...e.dataTransfer.files].filter((f) => /\.(pdf|png|jpe?g|webp|bmp|gif|xfdf|fdf)$/i.test(f.name)); if (!fl.length) return;
  const files = []; for (const f of fl) files.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
  await loadFiles(files, pages.length > 0 && e.shiftKey);
});


// ---------- OCR (text recognition, runs fully offline) ----------
let ocrWorker = null, ocrLangNow = '', ocrKeep = true, ocrStop = false;
const OCR_BASE = () => new URL('./vendor/ocr', location.href).href;
async function getOcr(lang, onLog) {
  if (ocrWorker && ocrLangNow === lang) { ocrWorker._log = onLog; return ocrWorker; }
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch {} ocrWorker = null; }
  const base = OCR_BASE(); let holder;
  const w = await Tesseract.createWorker(lang, 1, { workerPath: base + '/worker.min.js', corePath: base, langPath: base, gzip: false, workerBlobURL: false, cacheMethod: 'none', logger: (m) => { if (holder && holder._log) holder._log(m); } });
  holder = w; w._log = onLog; ocrWorker = w; ocrLangNow = lang; return w;
}
async function pageCanvas(p, scale = 2) {
  const cv = h('canvas');
  if (!p.src) { const [bw, bh] = dispDims(p); const [dw, dh] = p.rot % 180 ? [bh, bw] : [bw, bh]; cv.width = Math.round(dw * scale); cv.height = Math.round(dh * scale); const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); return cv; }
  const pg = await sources.get(p.src).pdf.getPage(p.index + 1);
  const vp = pg.getViewport({ scale, rotation: (pg.rotate + p.rot) % 360 });
  cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  await pg.render({ canvasContext: g, viewport: vp }).promise;
  return cv;
}
const linesOf = (data) => {
  if (data.lines && data.lines.length) return data.lines;
  const out = []; for (const b of data.blocks || []) for (const pa of b.paragraphs || []) for (const l of pa.lines || []) out.push(l);
  return out;
};
const cleanOcr = (t, lang) => { let s = t.replace(/\s+/g, ' ').trim(); if (/tha/.test(lang)) s = s.replace(/(?<=[฀-๿])\s+(?=[฀-๿])/g, ''); return s; };
async function ocrPage(p, lang, onLog) {
  const w = await getOcr(lang, onLog);
  const cv = await pageCanvas(p, 2);
  const res = await w.recognize(cv, {}, { blocks: true });
  const lines = [];
  for (const l of linesOf(res.data)) {
    const t = cleanOcr(l.text || '', lang); const b = l.bbox; if (!t || !b || (l.confidence != null && l.confidence < 25)) continue;
    lines.push({ t, x0: b.x0 / cv.width, y0: b.y0 / cv.height, x1: b.x1 / cv.width, y1: b.y1 / cv.height, conf: Math.round(l.confidence || 0) });
  }
  return { lang, lines };
}
const ocrText = (idx) => idx.map((i) => `--- Page ${i + 1} ---\n` + ((pages[i].ocr && pages[i].ocr.lines.map((l) => l.t).join('\n')) || '')).join('\n\n');
function openOcr() {
  if (!pages.length) { toast('Open a PDF or an image first'); return; }
  const lang = h('select', {}, h('option', { value: 'eng+tha', text: 'English + Thai' }), h('option', { value: 'eng', text: 'English' }), h('option', { value: 'tha', text: 'Thai (ไทย)' }));
  const scope = h('select', {}, h('option', { value: 'all', text: 'All pages' }), h('option', { value: 'cur', text: 'Current page only' }));
  const bar = h('div', { class: 'progress' }, h('i')); const msg = h('div', { class: 'muted', text: 'Recognition runs on this computer. Nothing is uploaded. The first run takes a few seconds to start.' });
  let back; let busy = false;
  const close = () => { ocrStop = true; back.remove(); };
  const go = btn('Start OCR', async () => {
    if (busy) return; busy = true; ocrStop = false; go.disabled = true;
    const idx = scope.value === 'cur' ? [curPage] : pages.map((_, i) => i);
    // the undo step is made only when a page really changes, so a scan with no text (or a failed run) adds none
    const done = []; let changed = false;
    try {
      for (let k = 0; k < idx.length; k++) {
        if (ocrStop) break;
        msg.textContent = `Reading page ${idx[k] + 1} (${k + 1} of ${idx.length})...`;
        bar.firstChild.style.width = Math.round((k / idx.length) * 100) + '%';
        const r = await ocrPage(pages[idx[k]], lang.value, (m) => { if (m.status === 'recognizing text') bar.firstChild.style.width = Math.round(((k + m.progress) / idx.length) * 100) + '%'; });
        const pg = pages[idx[k]];
        if ((r && r.lines.length) || pg.ocr) { if (!changed) { commit(); changed = true; } pg.ocr = r; }
        done.push(idx[k]);
      }
    } catch (e) { toast('OCR failed: ' + (e.message || e)); }
    busy = false; if (back.isConnected) { back.remove(); } if (done.length) { renderStatus(); showOcrResult(done); }
  }, 'primary');
  back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Recognise text (OCR)' }),
    h('div', { class: 'muted', text: 'Turns pictures of text, such as scans and photos, into real text that you can search, copy and edit.' }),
    h('label', { class: 'field' }, 'Language', lang), h('label', { class: 'field' }, 'Pages', scope), bar, msg,
    h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Close', close), go)));
  document.body.append(back);
}
function showOcrResult(idx) {
  const total = idx.reduce((s, i) => s + (pages[i].ocr ? pages[i].ocr.lines.length : 0), 0);
  const ta = h('textarea', { rows: 14, style: 'width:560px;font-family:inherit' }); ta.value = total ? ocrText(idx) : 'No text was found. Try another language, or a sharper picture.';
  const keep = h('input', { type: 'checkbox', checked: ocrKeep, onchange: () => { ocrKeep = keep.checked; } });
  let back;
  back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: `Recognised ${total} line${total === 1 ? '' : 's'} on ${idx.length} page${idx.length === 1 ? '' : 's'}` }),
    ta,
    h('label', { class: 'row' }, keep, h('span', { text: 'Keep this text inside the PDF when I save (makes it searchable)' })),
    h('div', { class: 'row', style: 'flex-wrap:wrap' },
      btn('Copy text', async () => { try { await navigator.clipboard.writeText(ta.value); toast('Copied'); } catch { ta.select(); document.execCommand('copy'); toast('Copied'); } }),
      btn('Save as .txt', async () => { const r = await window.host.saveFile({ name: (fileName || 'document').replace(/\.pdf$/i, '') + '-text.txt', filters: [['Text', ['txt']]], data: new TextEncoder().encode(ta.value) }); if (r) toast('Saved ' + r.name); }),
      btn('Edit as text boxes', () => { ocrToBoxes(idx); back.remove(); }, 'primary'),
      h('span', { class: 'grow' }), btn('Done', () => back.remove()))));
  document.body.append(back);
}
// replaces the picture of each recognised line with a white patch plus an editable text box
function ocrToBoxes(idx) {
  commit(); let n = 0;
  for (const i of idx) {
    const p = pages[i]; if (!p.ocr) continue;
    const [bw, bh] = dispDims(p); const dispH = p.rot % 180 ? bw : bh;
    for (const l of p.ocr.lines) {
      const c1 = rotInv(l.x0, l.y0, p.rot), c2 = rotInv(l.x1, l.y1, p.rot);
      const x = Math.min(c1[0], c2[0]), y = Math.min(c1[1], c2[1]), w = Math.abs(c1[0] - c2[0]), hh = Math.abs(c1[1] - c2[1]);
      const padU = 0.002;
      p.annots.push(mkAnn({ type: 'cover', x: x - padU, y: y - padU, bw: w + padU * 2, bh: hh + padU * 2, color: '#ffffff' }));
      const fs = ((l.y1 - l.y0) * dispH * 0.8) / bw;
      p.annots.push(mkAnn({ type: 'text', x: c1[0] < c2[0] ? x : x + w, y: c1[1] < c2[1] ? y : y + hh, text: l.t, fs, color: '#000000' }));
      n++;
    }
  }
  redrawOverlays(); renderRight(); toast(`${n} text box${n === 1 ? '' : 'es'} added. Double-click one to edit it.`);
}

// ---------- print, export images, watermark, page numbers ----------
async function renderedPdfCanvases(scale) {
  const pdf = await pdfjs.getDocument({ data: (await buildPdf(pages)).slice(), isEvalSupported: false }).promise; const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i); const vp = pg.getViewport({ scale });
    const cv = h('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise; out.push(cv);
  }
  return out;
}
async function printDoc(dry) {
  if (!pages.length) { toast('Open a PDF first'); return 0; }
  toast('Preparing to print...');
  const cvs = await renderedPdfCanvases(1.6);
  const root = h('div', { id: 'printroot' }, cvs.map((c) => h('img', { src: c.toDataURL('image/jpeg', 0.92) })));
  document.body.append(root); document.body.classList.add('printing');
  const clean = () => { root.remove(); document.body.classList.remove('printing'); };
  if (dry) { clean(); return cvs.length; }
  window.addEventListener('afterprint', clean, { once: true }); setTimeout(() => window.print(), 50); setTimeout(clean, 120000);
  return cvs.length;
}
async function exportImages() {
  if (!pages.length) { toast('Open a PDF first'); return; }
  try {
    const cvs = await renderedPdfCanvases(2); const items = [];
    for (const c of cvs) items.push(new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()));
    const n = await window.host.saveSeq({ name: (fileName || 'document').replace(/\.pdf$/i, '') + '.png', items });
    if (n) toast(`Saved ${n} image${n === 1 ? '' : 's'}`);
  } catch (e) { toast('Export failed: ' + (e.message || e)); }
}
function openWatermark() {
  if (!pages.length) { toast('Open a PDF first'); return; }
  const txt = h('input', { type: 'text', value: 'CONFIDENTIAL', style: 'width:100%' });
  const size = h('input', { type: 'range', min: 3, max: 16, value: 6 }), op = h('input', { type: 'range', min: 8, max: 70, value: 22 });
  const col = h('select', {}, [['#d96c6c', 'Red'], ['#808080', 'Grey'], ['#6c9ad9', 'Blue'], ['#111111', 'Black']].map(([v, n]) => h('option', { value: v, text: n })));
  const ang = h('select', {}, h('option', { value: '-45', text: 'Diagonal' }), h('option', { value: '0', text: 'Straight' }));
  const scope = h('select', {}, h('option', { value: 'all', text: 'All pages' }), h('option', { value: 'cur', text: 'Current page only' }));
  let back;
  back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Watermark' }),
    h('label', { class: 'field' }, 'Text', txt), h('label', { class: 'field' }, 'Size', size), h('label', { class: 'field' }, 'Strength', op),
    h('label', { class: 'field' }, 'Colour', col), h('label', { class: 'field' }, 'Direction', ang), h('label', { class: 'field' }, 'Pages', scope),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Remove watermarks', () => { commit(); pages.forEach((p) => { p.annots = p.annots.filter((x) => x.tag !== 'wm'); }); redrawOverlays(); back.remove(); toast('Watermarks removed'); }), btn('Cancel', () => back.remove()),
      btn('Add', () => {
        const text = txt.value.trim(); if (!text) return; commit();
        const idx = scope.value === 'cur' ? [curPage] : pages.map((_, i) => i);
        for (const i of idx) { const p = pages[i]; const [bw, bh] = dispDims(p); const fs = size.value / 100; p.annots = p.annots.filter((x) => x.tag !== 'wm'); p.annots.push(mkAnn({ type: 'text', tag: 'wm', mid: true, text, fs, x: 0.5, y: 0.5 - (fs * bw * 0.5) / bh, color: col.value, op: op.value / 100, ang: +ang.value })); }
        redrawOverlays(); back.remove(); toast('Watermark added');
      }, 'primary'))));
  document.body.append(back);
}
function openProtect() {
  if (!pages.length) { toast('Open a PDF first'); return; }
  const cur = protectOpts || { user: '', owner: '', print: true, copy: true, edit: true };
  const u = h('input', { type: 'password', value: cur.user, style: 'width:100%' }), o = h('input', { type: 'password', value: cur.owner, style: 'width:100%' });
  const cb = (k, t) => { const i = h('input', { type: 'checkbox' }); i.checked = !!cur[k]; i._k = k; return [i, h('label', { class: 'field', style: 'flex-direction:row;gap:8px;align-items:center' }, i, t)]; };
  const [ip, lp] = cb('print', 'Allow printing'), [ic, lc] = cb('copy', 'Allow copying text'), [ie, le] = cb('edit', 'Allow editing and notes');
  let back;
  back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Password for the saved PDF' }),
    h('div', { class: 'muted', style: 'margin-bottom:6px', text: 'Applied when you save. Strong 256-bit encryption, made on this computer. If you forget the password nobody can recover the file, so keep it somewhere safe.' }),
    h('label', { class: 'field' }, 'Password to open', u), h('label', { class: 'field' }, 'Password to change the limits below (optional)', o), lp, lc, le,
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      btn('Remove password', () => { protectOpts = null; back.remove(); toast('The next save will have no password'); }), btn('Cancel', () => back.remove()),
      btn('Set', () => {
        if (!u.value && !o.value && ip.checked && ic.checked && ie.checked) { protectOpts = null; back.remove(); toast('No password set'); return; }
        protectOpts = { user: u.value, owner: o.value, print: ip.checked, copy: ic.checked, edit: ie.checked };
        back.remove(); toast('Done. Save the file to apply it.');
      }, 'primary'))));
  document.body.append(back); setTimeout(() => u.focus(), 50);
}
function openPageNumbers() {
  if (!pages.length) { toast('Open a PDF first'); return; }
  const fmt = h('select', {}, h('option', { value: 'n', text: '1, 2, 3' }), h('option', { value: 'pn', text: 'Page 1' }), h('option', { value: 'nn', text: '1 / 4' }), h('option', { value: 'pnn', text: 'Page 1 of 4' }));
  const pos = h('select', {}, h('option', { value: 'bc', text: 'Bottom centre' }), h('option', { value: 'br', text: 'Bottom right' }), h('option', { value: 'tc', text: 'Top centre' }), h('option', { value: 'tr', text: 'Top right' }));
  const start = h('input', { type: 'number', value: 1, min: 0, style: 'width:100%' });
  const size = h('input', { type: 'range', min: 1, max: 4, step: 0.5, value: 2 });
  let back;
  back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Page numbers' }),
    h('label', { class: 'field' }, 'Format', fmt), h('label', { class: 'field' }, 'Position', pos), h('label', { class: 'field' }, 'First number', start), h('label', { class: 'field' }, 'Size', size),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Remove numbers', () => { commit(); pages.forEach((p) => { p.annots = p.annots.filter((x) => x.tag !== 'pn'); }); redrawOverlays(); back.remove(); toast('Page numbers removed'); }), btn('Cancel', () => back.remove()),
      btn('Add', () => {
        commit(); const s0 = +start.value || 0, N = pages.length;
        pages.forEach((p, i) => {
          p.annots = p.annots.filter((x) => x.tag !== 'pn');
          const n = s0 + i, text = { n: `${n}`, pn: `Page ${n}`, nn: `${n} / ${N - 1 + s0}`, pnn: `Page ${n} of ${N - 1 + s0}` }[fmt.value];
          const [bw, bh] = dispDims(p); const fs = size.value / 100; const top = pos.value[0] === 't';
          const x = pos.value[1] === 'c' ? 0.5 : 0.93; const y = top ? 0.03 : 0.97 - (fs * bw) / bh;
          p.annots.push(mkAnn({ type: 'text', tag: 'pn', mid: true, text, fs, x, y, color: '#333333' }));
        });
        redrawOverlays(); back.remove(); toast('Page numbers added');
      }, 'primary'))));
  document.body.append(back);
}
const openFormData = async () => { const f = await window.host.openFiles({ multi: true, filters: [['FDF / XFDF form data', ['fdf', 'xfdf']]] }); if (f.length) await loadFiles(f, true); };
const createFromImages = async () => { const f = await window.host.openFiles({ multi: true, filters: [['Images', ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']]] }); if (f.length) await loadFiles(f, false); };


// ---------- edit the text that is already in a PDF ----------
const lineCache = new Map();
async function linesFor(p) {
  if (!p.src) return [];
  const key = p.src + ':' + p.index; if (lineCache.has(key)) return lineCache.get(key);
  const pg = await sources.get(p.src).pdf.getPage(p.index + 1);
  const vp = pg.getViewport({ scale: 1, rotation: pg.rotate });
  const tc = await pg.getTextContent();
  const lines = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tr = it.transform, fs = Math.hypot(tr[2], tr[3]) || it.height || 10, x = tr[4], y = tr[5];
    const l = lines.find((q) => Math.abs(q.y - y) < 0.35 * fs && x >= q.x1 - 0.3 * fs && x - q.x1 < 1.5 * fs);
    if (l) { l.text += (x - l.x1 > 0.15 * fs ? ' ' : '') + it.str; l.x1 = x + it.width; l.fs = Math.max(l.fs, fs); }
    else lines.push({ text: it.str, x0: x, x1: x + it.width, y, fs, fn: it.fontName });
  }
  const out = lines.map((l) => {
    const a1 = vp.convertToViewportPoint(l.x0, l.y + 0.9 * l.fs), a2 = vp.convertToViewportPoint(l.x1, l.y - 0.25 * l.fs), bl = vp.convertToViewportPoint(l.x0, l.y);
    return { text: l.text, fs: l.fs, fn: l.fn, u0: Math.min(a1[0], a2[0]) / vp.width, u1: Math.max(a1[0], a2[0]) / vp.width, v0: Math.min(a1[1], a2[1]) / vp.height, v1: Math.max(a1[1], a2[1]) / vp.height, vb: bl[1] / vp.height };
  });
  lineCache.set(key, out); return out;
}
async function prepareEdit() { await Promise.all(pages.map((p) => linesFor(p))); if (tool === 'edittext') redrawOverlays(); }
const toHex = (r, g, b) => '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
// looks at the picture of the page behind a line to pick the patch colour (background) and the text colour
// `cache` (optional Map) keeps the rendered page so many lines on one page cost a single render
async function sampleColors(p, l, cache) {
  try {
    let ent = cache && cache.get(p.id);
    if (!ent) {
      const pg0 = await sources.get(p.src).pdf.getPage(p.index + 1);
      const vp0 = pg0.getViewport({ scale: 1.5, rotation: pg0.rotate });
      const cv0 = h('canvas'); cv0.width = Math.round(vp0.width); cv0.height = Math.round(vp0.height);
      const g0 = cv0.getContext('2d', { willReadFrequently: true }); g0.fillStyle = '#fff'; g0.fillRect(0, 0, cv0.width, cv0.height);
      await pg0.render({ canvasContext: g0, viewport: vp0 }).promise;
      ent = { pg: pg0, cv: cv0, g: g0 }; if (cache) cache.set(p.id, ent);
    }
    const { pg, cv, g } = ent;
    let bold = false; try { const f = pg.commonObjs.get(l.fn); bold = !!(f && (f.bold || /bold|black|heavy|semibold|demi/i.test(f.loadedName || f.name || ''))); } catch {}
    const x0 = Math.max(0, Math.floor((l.u0 - 0.004) * cv.width)), x1 = Math.min(cv.width, Math.ceil((l.u1 + 0.004) * cv.width));
    const y0 = Math.max(0, Math.floor((l.v0 - 0.004) * cv.height)), y1 = Math.min(cv.height, Math.ceil((l.v1 + 0.004) * cv.height));
    const w = x1 - x0, hh = y1 - y0; if (w < 2 || hh < 2) return { bg: '#ffffff', fg: '#000000', bold };
    const d = g.getImageData(x0, y0, w, hh).data, cnt = new Map();
    const at = (x, y) => (y * w + x) * 4;
    for (let x = 0; x < w; x++) for (const y of [0, hh - 1]) { const i = at(x, y), k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4); cnt.set(k, (cnt.get(k) || 0) + 1); }
    for (let y = 0; y < hh; y++) for (const x of [0, w - 1]) { const i = at(x, y), k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4); cnt.set(k, (cnt.get(k) || 0) + 1); }
    const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // average the real pixels that fall in the winning bucket
    let br = 0, bgc = 0, bb = 0, bn = 0;
    for (let i = 0; i < d.length; i += 4) if ((((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)) === top) { br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; bn++; }
    const B = [br / bn, bgc / bn, bb / bn];
    let far = [];
    for (let i = 0; i < d.length; i += 4) { const dist = Math.abs(d[i] - B[0]) + Math.abs(d[i + 1] - B[1]) + Math.abs(d[i + 2] - B[2]); far.push([dist, d[i], d[i + 1], d[i + 2]]); }
    far.sort((a, b) => b[0] - a[0]); const best = far.slice(0, Math.max(5, Math.floor(far.length * 0.01)));
    const F = best.reduce((s, q) => [s[0] + q[1], s[1] + q[2], s[2] + q[3]], [0, 0, 0]).map((v) => v / best.length);
    const fg = best[0][0] < 90 ? '#000000' : toHex(F[0], F[1], F[2]);
    return { bg: toHex(B[0], B[1], B[2]), fg, bold };
  } catch { return { bg: '#ffffff', fg: '#000000', bold: false }; }
}
async function editExisting(p, u, v) {
  const lines = await linesFor(p); const pad = 0.004;
  const hit = lines.filter((l) => u >= l.u0 - pad && u <= l.u1 + pad && v >= l.v0 - pad && v <= l.v1 + pad).sort((x, y) => (x.u1 - x.u0) * (x.v1 - x.v0) - (y.u1 - y.u0) * (y.v1 - y.v0))[0];
  if (!hit) { toast(p.src ? 'No text here. If this page is a picture, use Convert > OCR first.' : 'This page has no text to edit'); return; }
  const col = await sampleColors(p, hit);
  const ta = h('textarea', { rows: 2, style: 'width:420px;font-family:inherit' }); ta.value = hit.text;
  const perm = h('input', { type: 'checkbox' });
  let back;
  const apply = (removeOnly) => {
    const text = ta.value.trim(); const [bw, bh] = dispDims(p);
    commit();
    p.annots.push(mkAnn({ type: 'cover', x: hit.u0 - 0.002, y: hit.v0 - 0.002, bw: hit.u1 - hit.u0 + 0.004, bh: hit.v1 - hit.v0 + 0.004, fillc: col.bg, perm: perm.checked }));
    if (text && !removeOnly) p.annots.push(mkAnn({ type: 'text', x: hit.u0, y: hit.vb - (0.8 * hit.fs) / bh, text, fs: hit.fs / bw, color: col.fg, bold: col.bold }));
    back.remove(); redrawOverlays(); renderRight(); toast(removeOnly ? 'Text removed' : 'Text changed');
  };
  back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Edit text' }),
    h('div', { class: 'muted', text: 'The new words use a standard font (Helvetica, or Noto Sans Thai for Thai), not the original one.' }), ta,
    h('label', { class: 'row' }, perm, h('span', { text: 'Remove the original text permanently (this page is then saved as a picture with your new text on top)' })),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, btn('Delete this text', () => apply(true)), btn('Cancel', () => back.remove()), btn('OK', () => apply(false), 'primary'))));
  document.body.append(back); ta.focus(); ta.select();
}

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
    const tc = await pg.getTextContent(); const text = (tc.items.map((it) => it.str).join(' ') + (p.ocr ? ' ' + p.ocr.lines.map((l) => l.t).join(' ') : '')).toLowerCase();
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
  right.append(panelHead('right', 'Details'), h('h3', { text: 'Document' }));
  const t = h('input', { type: 'text', value: meta.title, oninput: () => (meta.title = t.value) });
  const a = h('input', { type: 'text', value: meta.author, oninput: () => (meta.author = a.value) });
  right.append(h('div', { class: 'col' }, h('label', { class: 'field' }, 'Title', t), h('label', { class: 'field' }, 'Author', a), h('div', { class: 'muted', text: `${pages.length} pages` })));
  right.append(h('h3', { text: 'Ink' }), swatchBox, h('label', { class: 'field', style: 'margin-top:10px' }, 'Line width', sizeIn));
  right.append(h('h3', { text: 'Tools' }), h('div', { class: 'col' }, btn('Recognise text (OCR)', () => openOcr()), btn('Save as Word', () => exportWord()), btn('Password', () => openProtect()), btn('Export page as PNG', () => exportPng()), btn('Export all pages as images', () => exportImages()), btn('Extract all text', () => extractText()), btn('Save compressed', () => saveCompressed()), btn('Watermark', () => openWatermark()), btn('Page numbers', () => openPageNumbers()), btn('Print', () => printDoc())));
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
  const ent = sources.get(srcId); formFails = [];
  try {
    const d = (await withFormValues(ent)) || await PDFDocument.load(ent.bytes, { ignoreEncryption: true });
    await fillMissingAppearances(d);
    d.getForm().flatten({ updateFieldAppearances: false });
    const bytes = new Uint8Array(await d.save({ updateFieldAppearances: false }));
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false }).promise;
    // the filled pages come from a new source, so Undo brings the fillable form back
    const nid = uid(); commit();
    sources.set(nid, { name: ent.name, bytes, pdf, fields: [], vals: {}, vals0: {} });
    for (const p of pages) if (p.src === srcId) p.src = nid;
    fullRender(); toast('Form filled' + failNote());
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

// ---------- zip + xml helpers (used by the Word export) ----------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), d = f.data, crc = crc32(d);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nm, d);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    cen.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + d.length;
  }
  const cenLen = cen.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cenLen, true); end.setUint32(16, off, true);
  const all = [...parts, ...cen, new Uint8Array(end.buffer)]; const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of all) { out.set(b, o); o += b.length; }
  return out;
}
const xmlEsc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function exportWord() { if (X.exportWord) return X.exportWord(); }

// ---------- export ----------
const hex = (c) => { const n = parseInt(c.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
async function rasterPage(p, list, scale = 2.5) {
  const pg = await sources.get(p.src).pdf.getPage(p.index + 1);
  const vp = pg.getViewport({ scale, rotation: pg.rotate });
  const cv = h('canvas'); cv.width = vp.width; cv.height = vp.height;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  ctx.fillStyle = '#000';
  for (const a of list) { ctx.fillStyle = a.perm ? (a.fillc || '#fff') : '#000'; ctx.fillRect(a.x * cv.width, a.y * cv.height, a.bw * cv.width, a.bh * cv.height); }
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
let thaiBytes = null;
async function getThaiBytes() { if (!thaiBytes) thaiBytes = new Uint8Array(await (await fetch('./vendor/fonts/NotoSansThai-Regular.ttf')).arrayBuffer()); return thaiBytes; }
const THAI = /[฀-๿]/;
const winAnsi = (s) => s.replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—•€…]/g, '?');
// draws text left to right from (x,y) (PDF points, baseline); Thai runs use the embedded Noto Sans Thai, everything else Helvetica
function drawMixed(page, F, text, x, y, size, color, deg = 0, opacity = 1) {
  const th = (deg * Math.PI) / 180; let cx = x, cy = y;
  for (const run of text.match(/[฀-๿]+|[^฀-๿]+/g) || []) {
    const isTh = THAI.test(run) && F.thai, f = isTh ? F.thai : F.latin, t = isTh ? run : winAnsi(run);
    if (!t) continue;
    page.drawText(t, { x: cx, y: cy, size, font: f, color, rotate: degrees(deg), opacity });
    const w = f.widthOfTextAtSize(t, size); cx += w * Math.cos(th); cy += w * Math.sin(th);
  }
}
const mixedWidth = (F, text, size) => (text.match(/[฀-๿]+|[^฀-๿]+/g) || []).reduce((s, r) => { const isTh = THAI.test(r) && F.thai; return s + (isTh ? F.thai : F.latin).widthOfTextAtSize(isTh ? r : winAnsi(r), size); }, 0);
function addLinksAndOutline(out, list, outPages, linkJobs) {
  const { PDFName, PDFString, PDFHexString } = window.PDFLib, c = out.context;
  const refOf = (pid) => { const o = outPages.find((x) => x.id === pid); return o ? o.page.ref : null; };
  for (const { page, rect, a } of linkJobs) {
    const d = { Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0] };
    if (a.url) d.A = c.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(a.url) });
    else { const r = refOf(a.pid); if (!r) continue; d.Dest = c.obj([r, PDFName.of('Fit')]); }
    page.node.addAnnot(c.register(c.obj(d)));
  }
  const items = outline.map((o) => ({ ...o, ref: refOf(o.pid) })).filter((o) => o.ref);
  if (!items.length) return;
  const root = c.nextRef(); const nodes = items.map((o) => ({ o, ref: c.nextRef(), kids: [], parent: null }));
  const stack = [], top = [];
  nodes.forEach((n) => { while (stack.length && stack[stack.length - 1].o.level >= n.o.level) stack.pop(); n.parent = stack.length ? stack[stack.length - 1] : null; (n.parent ? n.parent.kids : top).push(n); stack.push(n); });
  const count = (n) => n.kids.reduce((s, k) => s + 1 + count(k), 0);
  const put = (n, siblings, i) => {
    const d = { Title: PDFHexString.fromText(n.o.title || ' '), Parent: n.parent ? n.parent.ref : root, Dest: c.obj([n.o.ref, PDFName.of('Fit')]) };
    if (i > 0) d.Prev = siblings[i - 1].ref; if (i < siblings.length - 1) d.Next = siblings[i + 1].ref;
    if (n.kids.length) { d.First = n.kids[0].ref; d.Last = n.kids[n.kids.length - 1].ref; d.Count = count(n); }
    c.assign(n.ref, c.obj(d)); n.kids.forEach((k, j) => put(k, n.kids, j));
  };
  top.forEach((n, i) => put(n, top, i));
  c.assign(root, c.obj({ Type: 'Outlines', First: top[0].ref, Last: top[top.length - 1].ref, Count: top.length + top.reduce((s, n) => s + count(n), 0) }));
  out.catalog.set(PDFName.of('Outlines'), root);
}
// form values edited in the panel, written into a copy of the source; the fields stay fillable
// a font that can draw s in a field picture of d: Thai -> Noto Sans Thai, other non-Latin -> Noto Sans, else null (use Helvetica)
const fieldFonts = (d) => {
  const fonts = {};
  return async (s) => {
    const k = THAI.test(s) ? 'thai' : winAnsi(s) !== s ? 'uni' : null;
    if (!k) return null;
    if (!fonts[k]) {
      d.registerFontkit(window.fontkit);
      const b = k === 'thai' ? await getThaiBytes() : new Uint8Array(await (await fetch('./vendor/fonts/NotoSans-Regular.ttf')).arrayBuffer());
      fonts[k] = await d.embedFont(b, { subset: false });
    }
    return fonts[k];
  };
};
// Fields whose widgets have no picture (/AP) rely on the viewer to draw the answer (NeedAppearances).
// Flattening keeps only pictures, so build one for those fields first, with a font that has the characters.
// Fields that already have a picture keep it.
async function fillMissingAppearances(d) {
  const form = d.getForm(), fontFor = fieldFonts(d); let latin = null;
  const font = async (s) => (await fontFor(s)) || (latin = latin || await d.embedFont(StandardFonts.Helvetica));
  for (const fld of form.getFields()) {
    const ws = fld.acroField.getWidgets();
    if (!ws.length || ws.every((w) => w.dict.get(PDFName.of('AP')))) continue;
    try {
      if (fld.getText) fld.updateAppearances(await font(fld.getText() || ''));
      else if (fld.getSelected) fld.updateAppearances(await font(fld.getSelected().join(' ')));
      else if (fld.check || fld.select) fld.updateAppearances();
    } catch (e) { console.warn('form field picture not made', fld.getName(), e); }
  }
}
// names of form fields whose edited value could not be written by the last buildPdf / applyForm
let formFails = [];
const failNote = () => (formFails.length ? '. These form fields could not be written: ' + formFails.join(', ') : '');
async function withFormValues(ent) {
  const changed = (ent.fields || []).filter((f) => ent.vals[f.name] !== (ent.vals0 || {})[f.name]);
  if (!changed.length) return null;
  const d = await PDFDocument.load(ent.bytes, { ignoreEncryption: true });
  const form = d.getForm(); const fonts = {};
  const fontFor = fieldFonts(d);
  for (const f of changed) {
    const v = ent.vals[f.name];
    try {
      const fld = form.getField(f.name);
      if (f.kind === 'text') {
        const s = String(v == null ? '' : v); fld.setText(s);
        fld.updateAppearances((await fontFor(s)) || (fonts.latin = fonts.latin || await d.embedFont(StandardFonts.Helvetica)));
        // a UTF-16 value, so Thai and other non-Latin text reads back correctly in every viewer
        fld.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(s));
      } else if (f.kind === 'check') { if (v) fld.check(); else fld.uncheck(); fld.updateAppearances(); }
      else {
        if (v) fld.select(v); else if (fld.clear) fld.clear();
        if (f.kind === 'radio') fld.updateAppearances();
        else fld.updateAppearances((await fontFor(String(v || ''))) || (fonts.latin = fonts.latin || await d.embedFont(StandardFonts.Helvetica)));
      }
    } catch (e) { console.warn('form value not saved', f.name, e); if (!formFails.includes(f.name)) formFails.push(f.name); }
  }
  // only the changed fields get new appearances; the others keep the ones in the file
  return PDFDocument.load(await d.save({ updateFieldAppearances: false }), { ignoreEncryption: true });
}
// copyPages brings the field widgets but not the document's form list: add their fields to the output /AcroForm
function keepFormFields(out, page, src) {
  const annots = page.node.Annots(); if (!annots) return;
  const roots = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i); const a = ref instanceof PDFRef ? out.context.lookup(ref, PDFDict) : null;
    if (!a || a.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue;
    let top = ref, cur = a;
    for (let k = 0; k < 32; k++) { const par = cur.get(PDFName.of('Parent')); if (!(par instanceof PDFRef)) break; top = par; cur = out.context.lookup(par, PDFDict); if (!cur) break; }
    if (cur && cur.get(PDFName.of('T')) && !roots.includes(top)) roots.push(top);
  }
  if (!roots.length) return;
  const af = out.getForm().acroForm, have = af.dict.lookupMaybe(PDFName.of('Fields'), PDFArray);
  for (const r of roots) if (!have || !have.asArray().includes(r)) af.addField(r);
  const srcAF = src.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (srcAF) {
    const cp = PDFObjectCopier.for(src.context, out.context);
    // NeedAppearances too: fields without a picture still show their answers in other viewers
    for (const k of ['DA', 'DR', 'Q', 'NeedAppearances']) { const v = srcAF.get(PDFName.of(k)); if (v && !af.dict.get(PDFName.of(k))) af.dict.set(PDFName.of(k), cp.copy(v)); }
  }
}
async function buildPdf(list, enc, opts) {
  formFails = [];
  const out = await PDFDocument.create(opts && opts.noMeta ? { updateMetadata: false } : undefined);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const F = { latin: font, thai: null, bold: await out.embedFont(StandardFonts.HelveticaBold) };
  const needThai = list.some((p) => p.annots.some((an) => an.type === 'text' && THAI.test(an.text)) || (p.ocr && p.ocr.lines.some((l) => THAI.test(l.t))));
  if (needThai && window.fontkit) { out.registerFontkit(window.fontkit); F.thai = await out.embedFont(await getThaiBytes(), { subset: true }); }
  const cache = new Map(), linkJobs = [], outPages = [];
  for (const p of list) {
    let page; let q = p;
    const redacts = p.annots.filter((a) => a.type === 'redact' || a.perm);
    if (!p.src) { page = out.addPage([p.w, p.h]); }
    else if (redacts.length) {
      const img = await out.embedPng(await rasterPage(p, redacts));
      // the raster is already in displayed orientation: size the page to it and drop the intrinsic rotation
      const [rw, rh] = dispDims(p);
      page = out.addPage([rw, rh]); page.drawImage(img, { x: 0, y: 0, width: rw, height: rh });
      q = { ...p, w: rw, h: rh, r0: 0 };
    } else {
      if (!cache.has(p.src)) { const ent = sources.get(p.src); cache.set(p.src, (await withFormValues(ent)) || await PDFDocument.load(ent.bytes, { ignoreEncryption: true })); }
      [page] = await out.copyPages(cache.get(p.src), [p.index]);
      out.addPage(page);
      keepFormFields(out, page, cache.get(p.src));
    }
    const base = page.getRotation().angle;
    const box = p.src && !redacts.length ? page.getCropBox() : { x: 0, y: 0, width: q.w, height: q.h };
    const [dw, dh] = dispDims(q);
    for (const a of p.annots) {
      if (a.type === 'redact' || a.perm) continue;
      const pt = (u, v) => dispToPdf({ ...q, w: box.width, h: box.height }, u, v, box);
      const svgPt = (u, v) => { const [x, y] = pt(u, v); return [x - box.x, box.y + box.height - y]; };
      const origin = { x: box.x, y: box.y + box.height };
      if (isField(a)) {
        try {
          const form = out.getForm(); const cs = [[a.x, a.y], [a.x + a.bw, a.y + a.bh]].map(([u, v]) => pt(u, v));
          const x = Math.min(cs[0][0], cs[1][0]), y = Math.min(cs[0][1], cs[1][1]), width = Math.abs(cs[1][0] - cs[0][0]), height = Math.abs(cs[1][1] - cs[0][1]);
          const o = { x, y, width, height, borderWidth: 1, borderColor: rgb(0.35, 0.5, 0.85), backgroundColor: rgb(0.93, 0.96, 1) };
          let nm = a.fname || 'Field'; const taken = new Set(form.getFields().map((f) => f.getName())); while (taken.has(nm)) nm += '_';
          if (a.type === 'fcheck') form.createCheckBox(nm).addToPage(page, o);
          else if (a.type === 'fdrop') { const dd = form.createDropdown(nm); dd.addOptions(a.opts && a.opts.length ? a.opts : ['Option 1']); dd.addToPage(page, o); }
          else form.createTextField(nm).addToPage(page, { ...o, textColor: rgb(0, 0, 0) });
        } catch (e) { console.warn('form field not saved', e); }
      } else if (a.type === 'rect' || a.type === 'highlight' || a.type === 'cover') {
        const c = [[a.x, a.y], [a.x + a.bw, a.y], [a.x + a.bw, a.y + a.bh], [a.x, a.y + a.bh]].map(([u, v]) => svgPt(u, v));
        const d = 'M' + c.map((q) => q.join(' ')).join(' L') + ' Z';
        if (a.type === 'cover') page.drawSvgPath(d, { ...origin, color: hex(a.fillc || '#ffffff'), opacity: 1, borderWidth: 0 });
        else if (a.type === 'highlight') page.drawSvgPath(d, { ...origin, color: hex(a.color), opacity: 0.4, borderWidth: 0 });
        else page.drawSvgPath(d, { ...origin, borderColor: hex(a.color), borderWidth: a.w * (dw / 800), color: undefined, opacity: 0, borderOpacity: 1 });
      } else if (a.type === 'draw') {
        const d = a.pts.map(([u, v], i) => (i ? 'L' : 'M') + svgPt(u, v).join(' ')).join(' ');
        page.drawSvgPath(d, { ...origin, borderColor: hex(a.color), borderWidth: a.w * (dw / 800), color: undefined, opacity: 0, borderOpacity: 1 });
      } else if (a.type === 'text') {
        const size = a.fs * dw; const lines = a.text.split('\n');
        const ang = a.ang || 0;
        lines.forEach((ln, i) => {
          let [x, y] = pt(a.x, a.y + (size * 0.8 + i * size * 1.2) / dh);
          const th = ((q.r0 - ang) * Math.PI) / 180;
          if (a.mid || a.al === 'r') { const w = mixedWidth(a.bold ? { ...F, latin: F.bold } : F, ln, size) / (a.mid ? 2 : 1); x -= w * Math.cos(th); y -= w * Math.sin(th); }
          drawMixed(page, a.bold ? { ...F, latin: F.bold } : F, ln, x, y, size, hex(a.color), q.r0 - ang, a.op == null ? 1 : a.op);
        });
      } else if (a.type === 'ellipse') {
        const c = []; for (let i = 0; i < 48; i++) { const t = (i / 48) * Math.PI * 2; c.push(svgPt(a.x + a.bw / 2 + Math.cos(t) * a.bw / 2, a.y + a.bh / 2 + Math.sin(t) * a.bh / 2)); }
        page.drawSvgPath('M' + c.map((q) => q.join(' ')).join(' L') + ' Z', { ...origin, borderColor: hex(a.color), borderWidth: a.w * (dw / 800), color: undefined, opacity: 0, borderOpacity: 1 });
      } else if (a.type === 'line') {
        const [[x1, y1], [x2, y2]] = a.pts.map(([u, v]) => svgPt(u, v));
        let d = `M${x1} ${y1} L${x2} ${y2}`;
        if (a.arrow) { const ang = Math.atan2(y2 - y1, x2 - x1), L = Math.max(8, a.w * (dw / 800) * 4.5); for (const k of [-1, 1]) d += ` M${x2} ${y2} L${x2 - L * Math.cos(ang + k * 0.45)} ${y2 - L * Math.sin(ang + k * 0.45)}`; }
        page.drawSvgPath(d, { ...origin, borderColor: hex(a.color), borderWidth: a.w * (dw / 800), color: undefined, opacity: 0, borderOpacity: 1 });
      } else if (a.type === 'link') {
        const cs = [[a.x, a.y], [a.x + a.bw, a.y + a.bh]].map(([u, v]) => pt(u, v));
        const rect = [Math.min(cs[0][0], cs[1][0]), Math.min(cs[0][1], cs[1][1]), Math.max(cs[0][0], cs[1][0]), Math.max(cs[0][1], cs[1][1])];
        linkJobs.push({ page, rect, a });
      } else if (a.type === 'image') {
        const img = await out.embedPng(a.data);
        const [x, y] = pt(a.x, a.y + a.bh);
        const wPt = a.bw * dw, hPt = a.bh * dh;
        // lower-left corner of the displayed box, rotated with the page
        page.drawImage(img, { x, y, width: wPt, height: hPt, rotate: degrees(q.r0) });
      }
    }
    if (ocrKeep && p.ocr && p.src && !redacts.length && p.rot === 0) {
      const dhPt = dispDims(q)[1];
      for (const l of p.ocr.lines) {
        const lh = (l.y1 - l.y0), size = Math.max(4, lh * dhPt * 0.85);
        const [x, y] = dispToPdf({ ...q, w: box.width, h: box.height }, l.x0, l.y1 - lh * 0.15, box);
        try { drawMixed(page, F, l.t, x, y, size, rgb(0, 0, 0), q.r0, 0); } catch {}
      }
    }
    page.setRotation(degrees((base + p.rot) % 360));
    outPages.push({ id: p.id, page });
  }
  addLinksAndOutline(out, list, outPages, linkJobs);
  if (opts && opts.noMeta) { out.setProducer(''); out.setCreator(''); }
  else { out.setProducer('PDFout'); out.setCreator('PDFout'); }
  if (meta.title) out.setTitle(meta.title); if (meta.author) out.setAuthor(meta.author);
  if (meta.subject) out.setSubject(meta.subject); if (meta.keywords) out.setKeywords(String(meta.keywords).split(/[,;]+/).map((k) => k.trim()).filter(Boolean));
  if (opts && opts.post) await opts.post(out);
  if (enc && (enc.user || enc.owner || !enc.print || !enc.copy || !enc.edit)) {
    const rnd = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    out.encrypt({ userPassword: enc.user || '', ownerPassword: enc.owner || rnd,
      permissions: { printing: enc.print ? 'highResolution' : false, copying: !!enc.copy, modifying: !!enc.edit, annotating: !!enc.edit, fillingForms: !!enc.edit, contentAccessibility: true, documentAssembly: !!enc.edit } });
  }
  // never regenerate appearances of fields copied from the source (that would fail on Thai values and change their look)
  return await out.save({ updateFieldAppearances: false, ...(opts && opts.save ? opts.save : {}) });
}
async function save() {
  if (!pages.length) return;
  try {
    const bytes = await buildPdf(pages, protectOpts);
    const name = fileName ? fileName.replace(/\.pdf$/i, '') + '-edited.pdf' : 'document.pdf';
    const r = await window.host.saveFile({ name, filters: [['PDF', ['pdf']]], data: bytes });
    if (r) { savedSnap = stamp(); lastSave = r; toast('Saved ' + r.name + failNote()); }
  } catch (e) { const m = cleanErr(e.message || e); toast(/^(Cannot save|บันทึก)/.test(m) ? m : 'Save failed: ' + m); }
}

let savedSnap = null;
initExtra(X, {
  h, btn, toast, uid, clamp, sv, pdfjs, PDFLib: window.PDFLib, tr, getLang, sources, host: window.host, stage, left,
  get pages() { return pages; }, set pages(v) { pages = v; },
  get curPage() { return curPage; }, get sel() { return sel; }, set sel(v) { sel = v; },
  get fileName() { return fileName; }, set fileName(v) { fileName = v; },
  get meta() { return meta; }, set meta(v) { meta = v; },
  get outline() { return outline; }, set outline(v) { outline = v; },
  get zoom() { return zoom; }, get tool() { return tool; }, get color() { return color; }, get strokeW() { return strokeW; },
  commit, fullRender, redrawOverlays, renderRight, renderStatus, renderThumbs, renderStage, drawRibbon, mkAnn, dispDims, dispToPdf, rotFwd, rotInv,
  buildPdf, withFormValues, keepFormFields, fillMissingAppearances, failNote, linesFor, lineCache, pageCanvas, addSource, pagesOf, loadFiles, openFiles, scrollToPage, setTool, setZoom, fitWidth, getThaiBytes,
  drawMixed, mixedWidth, hex, THAI, winAnsi, zipStore, crc32, xmlEsc, pdfToJpegPdf, snapshot, stamp, openOcr, shownSize, askPassword, imageToPdf, sampleColors, rasterPage, dropCommit() { undoStack.pop(); updateButtons(); }, get protectOpts() { return protectOpts; },
  markSaved() { savedSnap = stamp(); }, savedSnap: () => savedSnap, printDoc, showLeft(m) { leftMode = m; renderThumbs(); }, gotoPage(i) { scrollToPage(i); },
});
fullRender();
// a file chosen with "Open with" (or named on the command line) opens straight away
if (window.host.launchFiles) window.host.launchFiles().then((f) => { if (f && f.length) loadFiles(f); }).catch(() => {});

window.addEventListener('beforeunload', (e) => { if (pages.length && stamp() !== savedSnap) { e.preventDefault(); e.returnValue = ''; } });
