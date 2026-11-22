// Conversions: Word (with tables and pictures), Markdown, web page, CSV tables, embedded pictures, PDF/A, grey and clean copies.
import { modal, fld, note, sel as selectEl, num, baseName, todayStr, bytesOf, blobBytes } from './x-util.js';

export function initConvert(X, c) {
  const { h, btn, toast } = c;
  const { PDFDocument, StandardFonts, PDFName, PDFHexString, PDFString, PDFRawStream } = c.PDFLib;
  const need = () => { if (!c.pages.length) { toast('Open a PDF first'); return false; } return true; };
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

  // ---------- read the layout of the document as it is now ----------
  async function analyze(pdfBytes, wantImages = true, progress) {
    const doc = await c.pdfjs.getDocument({ data: pdfBytes.slice(), isEvalSupported: false }).promise, OPS = c.pdfjs.OPS, out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (progress) progress(n, doc.numPages);
      const pg = await doc.getPage(n), vp = pg.getViewport({ scale: 1 }), W = vp.width, H = vp.height;
      let ops = null; try { ops = await pg.getOperatorList(); } catch {}
      const tc = await pg.getTextContent(), items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue; const tr = it.transform, [x, y] = vp.convertToViewportPoint(tr[4], tr[5]), fs = Math.hypot(tr[2], tr[3]) || 10;
        let bold = false, italic = false; try { const f = pg.commonObjs.get(it.fontName), nm = (f && (f.name || f.loadedName)) || ''; bold = /bold|black|heavy|semibold|demi/i.test(nm); italic = /italic|oblique/i.test(nm); } catch {}
        items.push({ x, y, w: it.width, fs, s: it.str, bold, italic });
      }
      items.sort((a, b) => a.y - b.y || a.x - b.x);
      const lines = [];
      for (const it of items) { const l = lines.find((q) => Math.abs(q.y - it.y) < 0.45 * Math.max(q.fs, it.fs)); if (l) { l.items.push(it); l.fs = Math.max(l.fs, it.fs); } else lines.push({ y: it.y, fs: it.fs, items: [it] }); }
      lines.sort((a, b) => a.y - b.y);
      for (const l of lines) {
        l.items.sort((a, b) => a.x - b.x); l.cells = [];
        for (const it of l.items) { const last = l.cells[l.cells.length - 1]; if (last && it.x - last.x1 < 0.8 * l.fs) { last.t += (it.x - last.x1 > 0.15 * l.fs ? ' ' : '') + it.s; last.x1 = it.x + it.w; } else l.cells.push({ x0: it.x, x1: it.x + it.w, t: it.s }); }
        l.x0 = l.cells[0].x0; l.x1 = l.cells[l.cells.length - 1].x1; l.text = l.cells.map((q) => q.t).join(' '); l.bold = l.items[0].bold; l.italic = l.items[0].italic;
      }
      // tables: runs of lines that have several cells starting at the same columns
      const tol = 0.014 * W, blocks = []; let i = 0;
      while (i < lines.length) {
        if (lines[i].cells.length < 2) { i++; continue; }
        let j = i; while (j + 1 < lines.length && lines[j + 1].cells.length >= 2 && lines[j + 1].y - lines[j].y < 2.6 * lines[j].fs) j++;
        const run = lines.slice(i, j + 1), anchors = [];
        for (const r of run) for (const cl of r.cells) if (!anchors.some((a) => Math.abs(a - cl.x0) < tol)) anchors.push(cl.x0);
        anchors.sort((a, b) => a - b);
        const share = anchors.map((a) => run.filter((r) => r.cells.some((cl) => Math.abs(cl.x0 - a) < tol)).length), good = share.filter((k) => k >= Math.max(2, Math.ceil(run.length * 0.5)));
        if (run.length >= 2 && good.length >= 2 && anchors.length <= 12) {
          const cols = anchors.filter((_, k) => share[k] >= 2);
          const rows = run.map((r) => { const row = cols.map(() => ''); for (const cl of r.cells) { let k = 0; for (let q = 0; q < cols.length; q++) if (cl.x0 >= cols[q] - tol) k = q; row[k] = (row[k] ? row[k] + ' ' : '') + cl.t; } return row; });
          blocks.push({ k: 't', y: run[0].y, rows, cols, W, x1: Math.max(...run.map((r) => r.x1)) }); run.forEach((r) => { r.used = true; });
        }
        i = j + 1;
      }
      // paragraphs
      const sizes = lines.map((l) => l.fs).sort((a, b) => a - b), med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 11; let cur = null;
      const flush = () => { if (cur) { blocks.push({ k: 'p', y: cur.y, x0: cur.x0, x1: cur.x1, W, text: cur.text, fs: cur.fs, bold: cur.bold, italic: cur.italic, med }); cur = null; } };
      for (const l of lines) {
        if (l.used) { flush(); continue; }
        const bullet = /^\s*([•●▪‣\-*]|\d{1,3}[.)])\s/.test(l.text);
        if (cur && !bullet && l.y - cur.ly < 1.6 * l.fs && Math.abs(l.fs - cur.fs) < cur.fs * 0.2 && Math.abs(l.x0 - cur.x0) < 4 * l.fs && cur.text.length > 0 && l.x0 > cur.x0 - 2 * l.fs) { cur.text += (/[฀-๿]$/.test(cur.text) && /^[฀-๿]/.test(l.text) ? '' : ' ') + l.text; cur.ly = l.y; cur.x1 = Math.max(cur.x1, l.x1); }
        else { flush(); cur = { y: l.y, ly: l.y, x0: l.x0, x1: l.x1, text: l.text, fs: l.fs, bold: l.bold, italic: l.italic }; }
      }
      flush();
      // pictures
      let hasText = items.length > 0; const imgs = [];
      if (ops && wantImages) {
        let ctm = [1, 0, 0, 1, 0, 0]; const st = [];
        for (let k = 0; k < ops.fnArray.length; k++) {
          const fn = ops.fnArray[k], a = ops.argsArray[k];
          if (fn === OPS.save) st.push(ctm.slice()); else if (fn === OPS.restore) ctm = st.pop() || [1, 0, 0, 1, 0, 0]; else if (fn === OPS.transform) ctm = mul(a, ctm);
          else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
            const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => vp.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
            const x0 = Math.min(...pts.map((q) => q[0])), x1 = Math.max(...pts.map((q) => q[0])), y0 = Math.min(...pts.map((q) => q[1])), y1 = Math.max(...pts.map((q) => q[1]));
            if (x1 - x0 >= 24 && y1 - y0 >= 24 && !imgs.some((q) => Math.abs(q.x0 - x0) < 2 && Math.abs(q.y0 - y0) < 2 && Math.abs(q.x1 - x1) < 2)) imgs.push({ x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(W, x1), y1: Math.min(H, y1) });
          }
        }
      }
      const pageArea = W * H; let pageCv = null;
      const cropOf = async (r, scale) => { if (!pageCv) { const v2 = pg.getViewport({ scale }); pageCv = h('canvas'); pageCv.width = Math.round(v2.width); pageCv.height = Math.round(v2.height); const g = pageCv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, pageCv.width, pageCv.height); await pg.render({ canvasContext: g, viewport: v2 }).promise; pageCv._s = scale; }
        const s = pageCv._s, cv = h('canvas'); cv.width = Math.max(1, Math.round((r.x1 - r.x0) * s)); cv.height = Math.max(1, Math.round((r.y1 - r.y0) * s)); cv.getContext('2d').drawImage(pageCv, r.x0 * s, r.y0 * s, cv.width, cv.height, 0, 0, cv.width, cv.height); return blobBytes(cv); };
      if (!hasText && !imgs.length) imgs.push({ x0: 0, y0: 0, x1: W, y1: H });   // a scan with no text at all: keep the whole page as a picture
      for (const r of imgs) { const area = (r.x1 - r.x0) * (r.y1 - r.y0); if (hasText && area > 0.85 * pageArea) continue; blocks.push({ k: 'i', y: r.y0, x0: r.x0, w: r.x1 - r.x0, h: r.y1 - r.y0, W, png: await cropOf(r, 2.5) }); }
      blocks.sort((a, b) => a.y - b.y);
      out.push({ n, W, H, blocks, scanOnly: !hasText, lens: lines.map((l) => [l.fs, l.text.length]) });
    }
    try { doc.destroy(); } catch {}
    // body text size for the whole document (weighted by how much text uses it), so headings stand out on every page
    const all = out.flatMap((P) => P.lens).sort((a, b) => a[0] - b[0]), total = all.reduce((s, q) => s + q[1], 0); let acc = 0, med = 11;
    for (const [fs, n] of all) { acc += n; if (acc >= total / 2) { med = fs; break; } }
    out.forEach((P) => P.blocks.forEach((b) => { if (b.k === 'p') b.med = med; }));
    return out;
  }
  const docBytes = async (list) => c.buildPdf(list || c.pages);
  const headingLevel = (b) => (b.fs > b.med * 1.9 ? 1 : b.fs > b.med * 1.45 ? 2 : b.fs > b.med * 1.2 ? 3 : (b.fs > b.med * 1.08 && b.bold) ? 3 : 0);
  const progress = (label) => (n, t) => { if (n === 1 || n % 5 === 0) toast(`${label} ${n} of ${t}...`); };

  // ---------- Word ----------
  const esc = (t) => c.xmlEsc(String(t).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
  X.exportWord = async () => {
    if (!need()) return;
    try {
      toast('Preparing the Word file...');
      const pgs = await analyze(await docBytes(), true, progress('Reading page')), body = [], media = [];
      const TW = 9638, EMU = 12700; let rid = 1, did = 1, any = false;
      const run = (text, fs, bold, italic) => { const pt = Math.max(8, Math.min(36, Math.round(fs))); return `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Leelawadee UI"/>${bold ? '<w:b/><w:bCs/>' : ''}${italic ? '<w:i/><w:iCs/>' : ''}<w:sz w:val="${pt * 2}"/><w:szCs w:val="${pt * 2}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`; };
      pgs.forEach((P, pi) => {
        for (const b of P.blocks) {
          if (b.k === 'p') {
            any = true; const big = headingLevel(b) > 0, ctr = Math.abs((b.x0 + b.x1) / 2 - P.W / 2) < 0.03 * P.W && b.x0 > 0.15 * P.W && b.text.length < 90;
            body.push(`<w:p><w:pPr>${ctr ? '<w:jc w:val="center"/>' : ''}<w:spacing w:after="120"/></w:pPr>${run(b.text, b.fs, b.bold || big, b.italic)}</w:p>`);
          } else if (b.k === 't') {
            any = true; const right = b.x1, widths = b.cols.map((x, k) => Math.max(500, Math.round((((b.cols[k + 1] ?? right + 8) - x) / (right - b.cols[0] + 8)) * TW)));
            const bd = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('');
            body.push(`<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((s, v) => s + v, 0)}" w:type="dxa"/><w:tblBorders>${bd}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
              b.rows.map((r) => `<w:tr>${r.map((t, k) => `<w:tc><w:tcPr><w:tcW w:w="${widths[k]}" w:type="dxa"/></w:tcPr><w:p>${t ? run(t, 10, false, false) : ''}</w:p></w:tc>`).join('')}</w:tr>`).join('') + '</w:tbl><w:p/>');
          } else if (b.k === 'i') {
            any = true; const k = Math.min(1, 481 / b.w), cx = Math.round(b.w * k * EMU), cy = Math.round(b.h * k * EMU), id = 'rId' + (++rid), nm = `image${media.length + 1}.png`; media.push({ name: 'word/media/' + nm, data: b.png, rid: id, target: 'media/' + nm });
            body.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${did++}" name="Picture ${did}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${nm}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
          }
        }
        if (pi < pgs.length - 1) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      });
      if (!any) { toast('Nothing to save. Run OCR first for scans and pictures.'); return; }
      const enc = new TextEncoder(), NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
      const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
      const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
      const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
      const drels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.target}"/>`).join('') + '</Relationships>';
      const files = [{ name: '[Content_Types].xml', data: enc.encode(ct) }, { name: '_rels/.rels', data: enc.encode(rels) }, { name: 'word/document.xml', data: enc.encode(doc) }];
      if (media.length) { files.push({ name: 'word/_rels/document.xml.rels', data: enc.encode(drels) }); files.push(...media.map((m) => ({ name: m.name, data: m.data }))); }
      const r = await c.host.saveFile({ name: baseName(c.fileName || 'document') + '.docx', filters: [['Word document', ['docx']]], data: c.zipStore(files) });
      if (r) toast(`Saved ${r.name} (${media.length} picture${media.length === 1 ? '' : 's'}, ${pgs.reduce((s, P) => s + P.blocks.filter((b) => b.k === 't').length, 0)} table${''}s)`);
    } catch (e) { toast('Word export failed: ' + (e.message || e)); }
  };

  // ---------- Markdown and web page ----------
  X.exportMarkdown = async () => {
    if (!need()) return;
    try {
      const pgs = await analyze(await docBytes(), false, progress('Reading page')), out = [];
      for (const P of pgs) {
        for (const b of P.blocks) {
          if (b.k === 'p') { const lv = headingLevel(b); const t = b.text.replace(/^\s*[•●▪‣]\s/, '- ').replace(/([\\`*_{}\[\]#|])/g, '\\$1'); out.push(lv ? '#'.repeat(lv) + ' ' + t : t); }
          else if (b.k === 't') { const row = (r) => '| ' + r.map((t) => String(t).replace(/\|/g, '\\|')).join(' | ') + ' |'; out.push([row(b.rows[0]), '| ' + b.rows[0].map(() => '---').join(' | ') + ' |', ...b.rows.slice(1).map(row)].join('\n')); }
        }
        out.push('');
      }
      const r = await c.host.saveFile({ name: baseName(c.fileName || 'document') + '.md', filters: [['Markdown', ['md']]], data: new TextEncoder().encode(out.join('\n\n')) });
      if (r) toast('Saved ' + r.name + ' (text and tables, pictures are not included)');
    } catch (e) { toast('Export failed: ' + (e.message || e)); }
  };
  X.exportHtml = async () => {
    if (!need()) return;
    try {
      const pgs = await analyze(await docBytes(), true, progress('Reading page')), e = (t) => c.xmlEsc(t), out = [];
      const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s); };
      for (const P of pgs) {
        out.push(`<section class="page"><h6>Page ${P.n}</h6>`);
        for (const b of P.blocks) {
          if (b.k === 'p') { const lv = headingLevel(b); out.push(lv ? `<h${lv}>${e(b.text)}</h${lv}>` : `<p${b.bold ? ' style="font-weight:600"' : ''}>${e(b.text)}</p>`); }
          else if (b.k === 't') out.push('<table>' + b.rows.map((r, i) => '<tr>' + r.map((t) => `<${i ? 'td' : 'th'}>${e(t)}</${i ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>');
          else out.push(`<p><img alt="" style="max-width:100%" src="data:image/png;base64,${toB64(b.png)}"></p>`);
        }
        out.push('</section>');
      }
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${e(c.meta.title || baseName(c.fileName) || 'Document')}</title><style>body{font:16px/1.6 "Segoe UI","Leelawadee UI",Arial,sans-serif;max-width:860px;margin:30px auto;padding:0 18px;color:#222}.page{border-bottom:1px solid #ddd;padding-bottom:16px;margin-bottom:20px}h6{color:#999;margin:0 0 8px}table{border-collapse:collapse;margin:10px 0}td,th{border:1px solid #bbb;padding:4px 10px;text-align:left}th{background:#f2f2f2}</style></head><body>${out.join('\n')}</body></html>`;
      const r = await c.host.saveFile({ name: baseName(c.fileName || 'document') + '.html', filters: [['Web page', ['html']]], data: new TextEncoder().encode(html) });
      if (r) toast('Saved ' + r.name);
    } catch (e2) { toast('Export failed: ' + (e2.message || e2)); }
  };

  // ---------- tables to CSV ----------
  X.exportCsv = async () => {
    if (!need()) return;
    try {
      const pgs = await analyze(await docBytes(), false, progress('Reading page')), tables = [];
      pgs.forEach((P) => P.blocks.filter((b) => b.k === 't').forEach((b) => tables.push({ page: P.n, rows: b.rows })));
      if (!tables.length) { toast('No tables found. Tables need columns of text that line up.'); return; }
      const csv = (rows) => '﻿' + rows.map((r) => r.map((t) => (/[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t)).join(',')).join('\r\n');
      if (tables.length === 1) { const r = await c.host.saveFile({ name: baseName(c.fileName || 'table') + '.csv', filters: [['CSV spreadsheet', ['csv']]], data: new TextEncoder().encode(csv(tables[0].rows)) }); if (r) toast('Saved ' + r.name + '. Open it in Excel or Sheets.'); }
      else { const r = await c.host.saveMany({ items: tables.map((t, i) => ({ name: `${baseName(c.fileName || 'table')}-p${t.page}-table${i + 1}.csv`, data: new TextEncoder().encode(csv(t.rows)) })) }); if (r) toast(`Saved ${r.count} tables as CSV files`); }
    } catch (e) { toast('Export failed: ' + (e.message || e)); }
  };

  // ---------- pictures inside the PDF ----------
  X.extractPictures = async () => {
    if (!need()) return;
    try {
      const pgs = await analyze(await docBytes(), true, progress('Reading page')), items = [];
      pgs.forEach((P) => P.blocks.filter((b) => b.k === 'i').forEach((b, i) => items.push({ name: `${baseName(c.fileName || 'document')}-page${P.n}-picture${i + 1}.png`, data: b.png })));
      if (!items.length) { toast('No pictures found in this document'); return; }
      const r = await c.host.saveMany({ items }); if (r) toast(`Saved ${r.count} picture${r.count === 1 ? '' : 's'}`);
    } catch (e) { toast('Export failed: ' + (e.message || e)); }
  };

  // ---------- grey and clean copies ----------
  async function rasterCopy(label, fn, suffix, scale = 2) {
    if (!need()) return;
    try {
      const pdf = await c.pdfjs.getDocument({ data: (await docBytes()).slice(), isEvalSupported: false }).promise, out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        if (i === 1 || i % 4 === 0) toast(`${label} page ${i} of ${pdf.numPages}...`);
        const pg = await pdf.getPage(i), vp = pg.getViewport({ scale }), cv = h('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const g = cv.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); await pg.render({ canvasContext: g, viewport: vp }).promise;
        const id = g.getImageData(0, 0, cv.width, cv.height); fn(id.data, cv.width, cv.height); g.putImageData(id, 0, 0);
        const img = await out.embedJpg(await blobBytes(cv, 'image/jpeg', 0.85)), base = pg.getViewport({ scale: 1 });
        out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      }
      out.setProducer('PDFout'); if (c.meta.title) out.setTitle(c.meta.title);
      const bytes = new Uint8Array(await out.save()), r = await c.host.saveFile({ name: baseName(c.fileName || 'document') + suffix, filters: [['PDF', ['pdf']]], data: bytes });
      if (r) toast(`Saved ${r.name} (${Math.round(bytes.length / 1024)} KB). Pages are pictures, so the text can no longer be selected.`);
    } catch (e) { toast('Failed: ' + (e.message || e)); }
  }
  X.grayscale = () => rasterCopy('Making grey', (d) => { for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = y; } }, '-grey.pdf');
  X.cleanScan = () => rasterCopy('Cleaning', (d) => {
    const hist = new Uint32Array(256); let n = 0; for (let i = 0; i < d.length; i += 4) { hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++; n++; }
    const pct = (p) => { let s = 0; for (let v = 0; v < 256; v++) { s += hist[v]; if (s >= n * p) return v; } return 255; };
    const lo = pct(0.015), hi = Math.max(lo + 40, pct(0.55)), k = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) { let y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - lo) * k; y = y < 0 ? 0 : y > 255 ? 255 : y; y = 255 * Math.pow(y / 255, 1.35); d[i] = d[i + 1] = d[i + 2] = y > 235 ? 255 : y; }
  }, '-clean.pdf');

  // ---------- PDF/A archive copy ----------
  const fx = (v) => Math.round(v * 65536);
  function iccProfile() {
    const dv = (n) => new DataView(new ArrayBuffer(n)), tags = []; const parts = [];
    const ascii = (s, len) => { const a = new Uint8Array(len); for (let i = 0; i < s.length && i < len; i++) a[i] = s.charCodeAt(i); return a; };
    const text = (t) => { const b = new Uint8Array(8 + t.length + 1); b.set(ascii('text', 4), 0); b.set(ascii(t, t.length), 8); return b; };
    const desc = (t) => { const b = new Uint8Array(12 + t.length + 1 + 4 + 4 + 2 + 1 + 67); b.set(ascii('desc', 4), 0); new DataView(b.buffer).setUint32(8, t.length + 1); b.set(ascii(t, t.length), 12); return b; };
    const xyz = (x, y, z) => { const d = dv(20); d.setUint32(0, 0x58595A20); d.setInt32(8, fx(x)); d.setInt32(12, fx(y)); d.setInt32(16, fx(z)); return new Uint8Array(d.buffer); };
    const curv = () => { const d = dv(16); d.setUint32(0, 0x63757276); d.setUint32(8, 1); d.setUint16(12, Math.round(2.2 * 256)); return new Uint8Array(d.buffer); };
    const data = [['desc', desc('sRGB IEC61966-2.1 (PDFout)')], ['cprt', text('Public domain')], ['wtpt', xyz(0.9642, 1, 0.8249)], ['rXYZ', xyz(0.4360747, 0.2225045, 0.0139322)], ['gXYZ', xyz(0.3850649, 0.7168786, 0.0971045)], ['bXYZ', xyz(0.1430804, 0.0606169, 0.7141733)], ['rTRC', curv()], ['gTRC', curv()], ['bTRC', curv()]];
    const pad4 = (n) => (n + 3) & ~3; let off = 128 + 4 + data.length * 12; const table = dv(4 + data.length * 12); table.setUint32(0, data.length); const blobs = [];
    data.forEach(([sig, b], i) => { table.setUint32(4 + i * 12, sig.charCodeAt(0) << 24 | sig.charCodeAt(1) << 16 | sig.charCodeAt(2) << 8 | sig.charCodeAt(3)); table.setUint32(8 + i * 12, off); table.setUint32(12 + i * 12, b.length); const pb = new Uint8Array(pad4(b.length)); pb.set(b); blobs.push(pb); off += pb.length; });
    const head = dv(128); head.setUint32(0, off); head.setUint32(8, 0x02400000); head.setUint32(12, 0x6D6E7472); head.setUint32(16, 0x52474220); head.setUint32(20, 0x58595A20);
    head.setUint16(24, 2024); head.setUint16(26, 1); head.setUint16(28, 1); head.setUint32(36, 0x61637370); head.setUint32(40, 0x4D534654); head.setInt32(68, fx(0.9642)); head.setInt32(72, fx(1)); head.setInt32(76, fx(0.8249));
    const all = [new Uint8Array(head.buffer), new Uint8Array(table.buffer), ...blobs], o = new Uint8Array(off); let p = 0; for (const a of all) { o.set(a, p); p += a.length; } return o;
  }
  let latinBytes = null;
  const getLatin = async () => { if (!latinBytes) latinBytes = new Uint8Array(await (await fetch('./vendor/fonts/NotoSans-Regular.ttf')).arrayBuffer()); return latinBytes; };
  X.pdfa = () => {
    if (!need()) return;
    const dpi = selectEl(c, [['1.5', 'Good (about 110 dpi)'], ['2', 'Better (about 145 dpi)'], ['3', 'Best (about 215 dpi, large file)']], '2');
    modal(c, 'PDF/A archive copy', [note(c, 'Makes a copy for long term storage. Every page is stored as a picture so it always looks the same, with the words kept underneath so you can still search. It follows the PDF/A-2b rules. Forms, links, bookmarks and passwords are not kept in an archive copy.'), fld(c, 'Picture quality', dpi)], (close) => [btn('Cancel', close), btn('Make archive copy', async () => {
      close();
      try {
        toast('Making the archive copy...');
        const pdf = await c.pdfjs.getDocument({ data: (await docBytes()).slice(), isEvalSupported: false }).promise, now = new Date();
        const out = await PDFDocument.create({ updateMetadata: false }); out.registerFontkit(window.fontkit);
        const fLatin = await out.embedFont(await getLatin(), { subset: true }), fThai = await out.embedFont(await c.getThaiBytes(), { subset: true });
        const setL = new Set(fLatin.getCharacterSet()), setT = new Set(fThai.getCharacterSet());
        const drawInvisible = (page, s, x, y, size) => {
          for (const run of s.match(/[฀-๿]+|[^฀-๿]+/g) || []) {
            const thai = /[฀-๿]/.test(run), f = thai ? fThai : fLatin, set = thai ? setT : setL, t = [...run].filter((ch) => set.has(ch.codePointAt(0))).join(''); if (!t) continue;
            try { page.drawText(t, { x, y, size, font: f, opacity: 0 }); x += f.widthOfTextAtSize(t, size); } catch {}
          }
        };
        const scale = +dpi.value;
        for (let i = 1; i <= pdf.numPages; i++) {
          if (i === 1 || i % 3 === 0) toast(`Archiving page ${i} of ${pdf.numPages}...`);
          const pg = await pdf.getPage(i), vp = pg.getViewport({ scale }), cv = h('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
          const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); await pg.render({ canvasContext: g, viewport: vp }).promise;
          const img = await out.embedJpg(await blobBytes(cv, 'image/jpeg', 0.86)), base = pg.getViewport({ scale: 1 }), page = out.addPage([base.width, base.height]);
          page.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
          const tc = await pg.getTextContent();
          for (const it of tc.items) { if (!it.str || !it.str.trim()) continue; const [x, y] = base.convertToViewportPoint(it.transform[4], it.transform[5]); drawInvisible(page, it.str, x, base.height - y, Math.max(2, Math.hypot(it.transform[2], it.transform[3]))); }
        }
        const ctx = out.context, title = c.meta.title || baseName(c.fileName) || 'Document', author = c.meta.author || '';
        out.setTitle(title); if (author) out.setAuthor(author); out.setProducer('PDFout'); out.setCreator('PDFout'); out.setCreationDate(now); out.setModificationDate(now);
        const iso = now.toISOString().replace(/\.\d+Z$/, 'Z'), x = c.xmlEsc;
        const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${x(title)}</rdf:li></rdf:Alt></dc:title>${author ? `<dc:creator><rdf:Seq><rdf:li>${x(author)}</rdf:li></rdf:Seq></dc:creator>` : ''}</rdf:Description><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreatorTool>PDFout</xmp:CreatorTool><xmp:CreateDate>${iso}</xmp:CreateDate><xmp:ModifyDate>${iso}</xmp:ModifyDate></rdf:Description><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>PDFout</pdf:Producer></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
        const meta = ctx.register(ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' })); out.catalog.set(PDFName.of('Metadata'), meta);
        const icc = ctx.register(ctx.stream(iccProfile(), { N: 3, Alternate: 'DeviceRGB' }));
        const oi = ctx.register(ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB'), Info: PDFString.of('sRGB'), DestOutputProfile: icc })); out.catalog.set(PDFName.of('OutputIntents'), ctx.obj([oi]));
        const rid = () => PDFHexString.of(Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')), idv = rid(); ctx.trailerInfo.ID = ctx.obj([idv, idv]);
        const bytes = new Uint8Array(await out.save({ useObjectStreams: false })), r = await c.host.saveFile({ name: baseName(c.fileName || 'document') + '-PDFA.pdf', filters: [['PDF/A', ['pdf']]], data: bytes });
        if (r) toast(`Saved ${r.name} (${Math.round(bytes.length / 1024)} KB)`);
      } catch (e) { toast('Archive copy failed: ' + (e.message || e)); }
    }, 'primary')]);
  };
  X._analyze = analyze; X._icc = iccProfile;
}
