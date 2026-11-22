// Document tools: bookmarks and contents, properties, compare, search in many files, view helpers.
import { modal, fld, note, sel as selectEl, num, txt, baseName, bytesOf } from './x-util.js';

export function initDoc(X, c) {
  const { h, btn, toast } = c;
  const need = () => { if (!c.pages.length) { toast('Open a PDF first'); return false; } return true; };
  const dirty = () => c.pages.length && c.stamp() !== c.savedSnap();

  // ---------- bookmarks ----------
  X.loadOutline = async () => {
    const sid = [...c.sources.keys()][0]; if (!sid) return;
    const pdf = c.sources.get(sid).pdf; let tree = null; try { tree = await pdf.getOutline(); } catch {}
    const out = []; let budget = 2000;
    const walk = async (items, level) => {
      for (const it of items || []) {
        if (budget-- <= 0) return;
        let idx = -1;
        try {
          let dest = it.dest; if (typeof dest === 'string') dest = await pdf.getDestination(dest);
          if (Array.isArray(dest)) idx = typeof dest[0] === 'object' && dest[0] ? await pdf.getPageIndex(dest[0]) : Number.isInteger(dest[0]) ? dest[0] : -1;
        } catch {}
        const pg = c.pages.find((p) => p.src === sid && p.index === idx);
        if (pg) out.push({ id: c.uid(), title: String(it.title || '').trim() || 'Untitled', pid: pg.id, level });
        await walk(it.items, level + 1);
      }
    };
    await walk(tree, 0);
    c.outline = out;
  };
  const pageNo = (pid) => c.pages.findIndex((p) => p.id === pid) + 1;
  const levelFix = (list) => { let prev = -1; for (const o of list) { o.level = Math.max(0, Math.min(o.level, prev + 1)); prev = o.level; } };
  const renameDlg = (o) => { const t = txt(c, o.title); modal(c, 'Bookmark name', [fld(c, 'Name', t)], (close) => [btn('Cancel', close), btn('OK', () => { const v = t.value.trim(); if (v) { o.title = v; X.refreshMarks(); } close(); }, 'primary')]); setTimeout(() => t.select(), 40); };
  X.refreshMarks = () => { c.renderThumbs(); };
  X.bookmarks = () => { if (!need()) return; c.showLeft('marks'); };
  X.marksPanel = (box) => {
    const list = c.outline;
    const head = h('div', { class: 'ptools' },
      btn('Add here', () => {
        const t = txt(c, `Page ${c.curPage + 1}`); const pid = c.pages[c.curPage].id;
        modal(c, 'New bookmark', [note(c, `Points to page ${c.curPage + 1}`), fld(c, 'Name', t)], (close) => [btn('Cancel', close), btn('Add', () => {
          const v = t.value.trim(); if (!v) return; let at = list.length; for (let i = list.length - 1; i >= 0; i--) { if (pageNo(list[i].pid) <= c.curPage + 1) { at = i + 1; break; } if (i === 0) at = 0; }
          list.splice(at, 0, { id: c.uid(), title: v, pid, level: at > 0 ? list[at - 1].level : 0 }); close(); X.refreshMarks();
        }, 'primary')]); setTimeout(() => t.select(), 40);
      }),
      btn('Headings', () => X.autoMarks()), btn('Contents page', () => X.makeContents()), btn('Clear', () => { if (list.length && confirm(c.tr('Remove all bookmarks?'))) { c.outline = []; X.refreshMarks(); } }));
    box.append(h('h3', { text: 'Bookmarks' }), head);
    if (!list.length) box.append(h('div', { class: 'muted', style: 'padding:6px', text: 'No bookmarks yet. Add one for the page you are on, or let PDFout find the headings for you.' }));
    list.forEach((o, i) => {
      const n = pageNo(o.pid);
      const row = h('div', { class: 'mark', style: `padding-left:${6 + o.level * 14}px`, onclick: () => { if (n) c.gotoPage(n - 1); } },
        h('span', { text: o.title, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + (n ? '' : 'opacity:.5') }), h('span', { class: 'pg', text: n ? String(n) : '?' }),
        ...[['←', 'Move out', () => { o.level = Math.max(0, o.level - 1); }], ['→', 'Move in', () => { o.level = Math.min((list[i - 1] ? list[i - 1].level + 1 : 0), o.level + 1); }], ['✎', 'Rename', () => renameDlg(o)], ['✕', 'Remove', () => { list.splice(i, 1); }]]
          .map(([t, tip, fn]) => h('button', { class: 'btn', style: 'padding:0 6px;min-width:0;height:22px', title: tip, text: t, onclick: (e) => { e.stopPropagation(); fn(); levelFix(list); X.refreshMarks(); } })));
      box.append(row);
    });
  };
  X.autoMarks = async () => {
    if (!need()) return; toast('Looking for headings...');
    const all = [];
    for (const [i, p] of c.pages.entries()) { if (!p.src) continue; for (const l of await c.linesFor(p)) if (l.text.trim().length > 2 && l.text.length < 90 && !/^[\d\s.,/-]+$/.test(l.text)) all.push({ i, t: l.text.trim(), fs: l.fs, v: l.v0 }); }
    if (!all.length) { toast('No text found. Run OCR first for scans.'); return; }
    const sizes = all.map((a) => a.fs).sort((a, b) => a - b), med = sizes[Math.floor(sizes.length / 2)];
    const big = all.filter((a) => a.fs > med * 1.25).sort((a, b) => a.i - b.i || a.v - b.v);
    if (!big.length) { toast('No headings stand out in this document'); return; }
    const levels = [...new Set(big.map((a) => Math.round(a.fs)))].sort((a, b) => b - a).slice(0, 3);
    const out = []; const seen = new Set();
    for (const a of big) { const lv = levels.indexOf(Math.round(a.fs)); if (lv < 0) continue; const key = a.i + a.t; if (seen.has(key)) continue; seen.add(key); out.push({ id: c.uid(), title: a.t, pid: c.pages[a.i].id, level: lv }); }
    levelFix(out); c.outline = out.slice(0, 300); X.refreshMarks(); toast(`Found ${out.length} heading${out.length === 1 ? '' : 's'}. Check them, then save.`);
  };
  X.makeContents = () => {
    if (!need()) return; if (!c.outline.length) { toast('Add some bookmarks first'); return; }
    const per = 26, entries = c.outline.filter((o) => pageNo(o.pid)), nPages = Math.ceil(entries.length / per), made = [];
    if (!nPages) { toast('None of the bookmarks point to a page'); return; }
    c.commit();
    if (c.pages[0].toc) c.pages = c.pages.filter((p) => !p.toc);
    const ref = c.pages[0], [W, H] = [ref.r0 % 180 ? ref.h : ref.w, ref.r0 % 180 ? ref.w : ref.h];
    for (let k = 0; k < nPages; k++) made.push({ id: c.uid(), src: null, index: -1, rot: 0, annots: [], w: W, h: H, r0: 0, toc: true });
    entries.forEach((o, i) => {
      const pg = made[Math.floor(i / per)], row = i % per, y = 0.13 + row * 0.033, target = c.pages.find((p) => p.id === o.pid), n = pageNo(o.pid) + nPages;
      pg.annots.push(c.mkAnn({ type: 'text', text: o.title, fs: 0.02, x: 0.08 + o.level * 0.035, y, color: '#111111', bold: o.level === 0 }));
      pg.annots.push(c.mkAnn({ type: 'text', text: String(n), fs: 0.02, x: 0.92, y, al: 'r', color: '#111111' }));
      pg.annots.push(c.mkAnn({ type: 'link', x: 0.07, y: y - 0.004, bw: 0.86, bh: 0.03, pid: target.id }));
    });
    made[0].annots.push(c.mkAnn({ type: 'text', text: c.tr('Contents'), fs: 0.04, x: 0.08, y: 0.05, color: '#111111', bold: true }));
    c.pages = [...made, ...c.pages]; c.fullRender(); toast('Contents page added at the front');
  };

  // ---------- properties ----------
  X.properties = () => {
    if (!need()) return; const m = c.meta;
    const t = txt(c, m.title || ''), a = txt(c, m.author || ''), s = txt(c, m.subject || ''), k = txt(c, m.keywords || '', 'separate with commas');
    modal(c, 'Document properties', [note(c, `${c.fileName || 'Untitled'}  ·  ${c.pages.length} pages`), fld(c, 'Title', t), fld(c, 'Author', a), fld(c, 'Subject', s), fld(c, 'Keywords', k)], (close) => [btn('Cancel', close), btn('OK', () => { Object.assign(c.meta, { title: t.value, author: a.value, subject: s.value, keywords: k.value }); close(); c.renderRight(); toast('Saved with the next save'); }, 'primary')]);
  };

  // ---------- compare two documents ----------
  async function pageLines(doc, i) {
    const pg = await doc.getPage(i), tc = await pg.getTextContent(), rows = [];
    for (const it of tc.items) { if (!it.str || !it.str.trim()) continue; const y = it.transform[5], x = it.transform[4]; let r = rows.find((q) => Math.abs(q.y - y) < 3); if (!r) rows.push(r = { y, parts: [] }); r.parts.push([x, it.str]); }
    return rows.sort((a, b) => b.y - a.y).map((r) => r.parts.sort((a, b) => a[0] - b[0]).map((q) => q[1]).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  function lcsDiff(a, b) {
    const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]); }
    while (i < n) out.push(['-', a[i++]]); while (j < m) out.push(['+', b[j++]]);
    return out;
  }
  X.compare = async () => {
    if (!need()) return;
    const f = await c.host.openFiles({ multi: false, filters: [['PDF files', ['pdf']]] }); if (!f.length) return;
    toast('Comparing...');
    let A, B;
    try {
      A = await c.pdfjs.getDocument({ data: (await c.buildPdf(c.pages)).slice(), isEvalSupported: false }).promise;
      B = await c.pdfjs.getDocument({ data: bytesOf(f[0].data).slice(), isEvalSupported: false }).promise;
    } catch (e) { toast('Cannot compare: ' + (e.message || e)); return; }
    const N = Math.max(A.numPages, B.numPages), text = [];
    for (let i = 1; i <= N; i++) {
      const la = i <= A.numPages ? await pageLines(A, i) : [], lb = i <= B.numPages ? await pageLines(B, i) : [];
      text.push({ i, diff: lcsDiff(la, lb).filter(Boolean), onlyA: i > B.numPages, onlyB: i > A.numPages });
    }
    const changed = text.filter((t) => t.diff.length);
    const body = h('div', { style: 'max-height:56vh;overflow:auto;display:flex;flex-direction:column;gap:10px' });
    const tabText = btn('Words', () => show('t')), tabVis = btn('Pictures', () => show('v'));
    const pageIn = num(c, changed.length ? changed[0].i : 1, 1, N); pageIn.style.width = '80px';
    const show = (mode) => {
      body.textContent = '';
      tabText.classList.toggle('primary', mode === 't'); tabVis.classList.toggle('primary', mode === 'v');
      if (mode === 't') {
        if (!changed.length) { body.append(note(c, 'No difference in the words.')); return; }
        for (const t of changed) {
          body.append(h('div', {}, h('b', { text: `Page ${t.i}` + (t.onlyA ? ' (only in this document)' : t.onlyB ? ' (only in the other file)' : '') }),
            ...t.diff.map(([k, s]) => h('div', { style: `padding:2px 8px;border-radius:6px;font-size:13px;background:${k === '-' ? 'rgba(217,108,108,.18)' : 'rgba(116,178,124,.2)'}`, text: (k === '-' ? '− ' : '+ ') + s }))));
        }
      } else visual();
    };
    async function renderTo(doc, i, w) { const pg = await doc.getPage(i), vp0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: w / vp0.width }); const cv = h('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height); const g = cv.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); await pg.render({ canvasContext: g, viewport: vp }).promise; return cv; }
    async function visual() {
      body.textContent = ''; const i = Math.min(N, Math.max(1, +pageIn.value || 1));
      const ctl = h('div', { class: 'row' }, btn('Previous', () => { pageIn.value = Math.max(1, i - 1); visual(); }), pageIn, h('span', { class: 'muted', text: `of ${N}` }), btn('Next', () => { pageIn.value = Math.min(N, i + 1); visual(); }), btn('Go', () => visual()));
      body.append(ctl);
      if (i > A.numPages || i > B.numPages) { body.append(note(c, 'This page exists in only one of the two documents.')); return; }
      const w = 420, ca = await renderTo(A, i, w), cb = await renderTo(B, i, w), cd = h('canvas'); cd.width = ca.width; cd.height = ca.height;
      const ga = ca.getContext('2d').getImageData(0, 0, ca.width, ca.height), gb = cb.getContext('2d').getImageData(0, 0, Math.min(cb.width, ca.width), Math.min(cb.height, ca.height)), out = cd.getContext('2d').createImageData(ca.width, ca.height);
      let diff = 0;
      for (let y = 0; y < ca.height; y++) for (let x = 0; x < ca.width; x++) {
        const k = (y * ca.width + x) * 4, inB = x < gb.width && y < gb.height, kb = (y * gb.width + x) * 4;
        const da = inB ? Math.abs(ga.data[k] - gb.data[kb]) + Math.abs(ga.data[k + 1] - gb.data[kb + 1]) + Math.abs(ga.data[k + 2] - gb.data[kb + 2]) : 765;
        if (da > 90) { out.data[k] = 217; out.data[k + 1] = 60; out.data[k + 2] = 60; out.data[k + 3] = 255; diff++; } else { const g = 255 - (255 - (ga.data[k] + ga.data[k + 1] + ga.data[k + 2]) / 3) * 0.35; out.data[k] = out.data[k + 1] = out.data[k + 2] = g; out.data[k + 3] = 255; }
      }
      cd.getContext('2d').putImageData(out, 0, 0);
      body.append(note(c, diff ? `${(100 * diff / (ca.width * ca.height)).toFixed(2)}% of this page looks different (shown in red).` : 'This page looks identical.'),
        h('div', { class: 'diff-grid', style: 'grid-template-columns:1fr 1fr 1fr' }, ca, cb, cd));
      [ca, cb, cd].forEach((e) => { e.style.cssText = 'width:100%;border-radius:6px'; });
    }
    modal(c, `Compare with ${f[0].name}`, [note(c, changed.length ? `${changed.length} page${changed.length === 1 ? '' : 's'} with different words.${A.numPages !== B.numPages ? ` The documents have ${A.numPages} and ${B.numPages} pages.` : ''}` : 'The words are the same on every page.'),
      h('div', { class: 'row' }, tabText, tabVis), body], (close) => [btn('Close', () => { close(); try { A.destroy(); B.destroy(); } catch {} })], 'wide');
    show('t');
  };

  // ---------- search in many files ----------
  X.searchFiles = async () => {
    const q = txt(c, '', 'word or phrase'), res = h('div', { style: 'max-height:42vh;overflow:auto' }), bar = h('div', { class: 'progress' }, h('i')), msg = note(c, 'Pick a folder or some files, then search. Nothing leaves this computer.');
    let list = null, stop = false, busy = false;
    const info = note(c, 'No files chosen yet.');
    const set = (l, label) => { list = l; info.textContent = `${label}: ${l.length} PDF file${l.length === 1 ? '' : 's'}`; };
    const run = async () => {
      if (busy || !list || !q.value.trim()) { if (!list) toast('Choose a folder or files first'); return; }
      busy = true; stop = false; res.textContent = ''; const needle = q.value.trim().toLowerCase(); let hits = 0, skipped = 0;
      for (let k = 0; k < list.length && !stop && hits < 3000; k++) {
        const f = list[k]; msg.textContent = `Searching ${k + 1} of ${list.length}: ${f.rel || f.name}`; bar.firstChild.style.width = Math.round((k / list.length) * 100) + '%';
        let doc;
        try { const data = bytesOf(await c.host.readFile(f.id)); doc = await c.pdfjs.getDocument({ data, isEvalSupported: false }).promise; } catch { skipped++; continue; }
        try {
          for (let i = 1; i <= doc.numPages && !stop; i++) {
            const pgx = await doc.getPage(i), tc = await pgx.getTextContent(); pgx.cleanup(); const t = tc.items.map((it) => it.str).join(' '), low = t.toLowerCase(); let at = low.indexOf(needle), n = 0, first = at;
            while (at !== -1) { n++; at = low.indexOf(needle, at + needle.length); }
            if (n) { hits++; res.append(h('div', { class: 'hitrow', onclick: async () => {
              if (dirty() && !confirm(c.tr('Open this file and close the current one without saving?'))) return;
              try { stop = true; const item = { name: f.name, data: bytesOf(await c.host.readFile(f.id)) }; document.querySelector('.modal-back') && document.querySelectorAll('.modal-back').forEach((e) => e.remove()); await c.loadFiles([item], false); setTimeout(() => c.gotoPage(i - 1), 400); } catch (e) { toast('Cannot open: ' + (e.message || e)); }
            } }, h('b', { text: `${f.rel || f.name}  ·  page ${i}${n > 1 ? ` (${n} matches)` : ''}` }), h('span', { text: '…' + t.slice(Math.max(0, first - 40), first + needle.length + 60).replace(/\s+/g, ' ') + '…' }))); }
          }
        } catch { skipped++; }
        try { doc.destroy(); } catch {}
      }
      bar.firstChild.style.width = '100%'; busy = false;
      msg.textContent = `${hits} match${hits === 1 ? '' : 'es'} in ${list.length} file${list.length === 1 ? '' : 's'}.` + (skipped ? ` ${skipped} could not be read (locked or damaged).` : '') + (stop ? ' Stopped.' : '');
      if (!hits) res.append(note(c, 'Nothing found. Scanned pages without OCR have no text to search.'));
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    modal(c, 'Find in files', [fld(c, 'Find', q), h('div', { class: 'row' }, btn('Choose folder', async () => { const r = await c.host.openFolder({ exts: ['pdf'] }); if (r) set(r.files, r.dir); }), btn('Choose files', async () => { const f = await c.host.openFiles({ multi: true, read: false, filters: [['PDF files', ['pdf']]] }); if (f.length) set(f.map((x) => ({ id: x.id, name: x.name })), `${f.length} chosen`); })), info, bar, msg, res],
    (close) => [btn('Close', () => { stop = true; close(); }), btn('Search', run, 'primary')], 'wide');
    setTimeout(() => q.focus(), 60);
  };

  // ---------- view helpers ----------
  X.fitPage = () => { if (!need()) return; const [w, hh] = c.shownSize(c.pages[c.curPage]); c.setZoom(c.zoom * Math.min((c.stage.clientWidth - 48) / w, (c.stage.clientHeight - 32) / hh)); };
  X.isDark = () => document.body.classList.contains('pdfdark');
  X.darkPages = () => { document.body.classList.toggle('pdfdark'); try { localStorage.setItem('pdfout.dark', X.isDark() ? '1' : ''); } catch {} c.drawRibbon(); };
  try { if (localStorage.getItem('pdfout.dark')) document.body.classList.add('pdfdark'); } catch {}
  X.fullscreen = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); };
  let reading = false;
  X.readAloud = async () => {
    if (!need()) return; const ss = window.speechSynthesis; if (!ss) { toast('This computer cannot read aloud'); return; }
    if (reading) { reading = false; ss.cancel(); toast('Stopped reading'); return; }
    reading = true; toast('Reading aloud. Press Read aloud again to stop.');
    for (let i = c.curPage; i < c.pages.length && reading; i++) {
      const p = c.pages[i]; const lines = p.src ? await c.linesFor(p) : []; const text = lines.map((l) => l.text).join('. ') || (p.ocr ? p.ocr.lines.map((l) => l.t).join('. ') : '');
      if (!text.trim()) continue; c.gotoPage(i);
      const th = /[฀-๿]/.test(text), u = new SpeechSynthesisUtterance(text); u.lang = th ? 'th-TH' : 'en-US';
      const v = ss.getVoices().find((x) => x.lang.toLowerCase().startsWith(th ? 'th' : 'en')); if (v) u.voice = v; else if (th) { toast('No Thai voice is installed. Add one in Windows Settings > Time and language > Speech.'); reading = false; return; }
      await new Promise((res) => { u.onend = res; u.onerror = res; ss.speak(u); });
    }
    reading = false;
  };
  X.shortcuts = () => {
    const rows = [['Ctrl + O', 'Open a file'], ['Ctrl + S', 'Save as'], ['Ctrl + P', 'Print'], ['Ctrl + F', 'Search the text'], ['Ctrl + Z', 'Undo'], ['Ctrl + Y', 'Redo'], ['Ctrl + plus / minus', 'Zoom in or out'], ['Ctrl + mouse wheel', 'Zoom'], ['Page Up / Page Down', 'Previous or next page'], ['Home / End', 'First or last page'], ['Delete', 'Delete the selected mark'], ['Esc', 'Deselect, or close a window'], ['F11', 'Full screen']];
    modal(c, 'Keyboard shortcuts', rows.map(([k, d]) => h('div', {}, h('span', { class: 'kbd', text: k }), h('span', { text: d }))), (close) => [btn('Close', close, 'primary')]);
  };
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-back') || e.target.matches('input,textarea,select')) { if (e.ctrlKey && e.key.toLowerCase() === 'f' && !document.querySelector('.modal-back')) { e.preventDefault(); const s = document.querySelector('input[type=search]'); if (s) { s.focus(); s.select(); } } return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); const s = document.querySelector('input[type=search]'); if (s) { s.focus(); s.select(); } }
    else if (e.ctrlKey && e.key.toLowerCase() === 'p' && c.pages.length) { e.preventDefault(); c.printDoc(); }
    else if (e.key === 'F11') { e.preventDefault(); X.fullscreen(); }
    else if (c.pages.length && !e.ctrlKey && !e.altKey) {
      if (e.key === 'PageDown') { c.gotoPage(Math.min(c.pages.length - 1, c.curPage + 1)); e.preventDefault(); }
      else if (e.key === 'PageUp') { c.gotoPage(Math.max(0, c.curPage - 1)); e.preventDefault(); }
      else if (e.key === 'Home' && !e.target.matches('button')) { c.gotoPage(0); e.preventDefault(); }
      else if (e.key === 'End' && !e.target.matches('button')) { c.gotoPage(c.pages.length - 1); e.preventDefault(); }
    }
  });
}
