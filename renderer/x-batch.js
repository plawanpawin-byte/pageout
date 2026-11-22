// Batch: one job on many PDFs, without opening them one by one.
import { modal, fld, note, sel as selectEl, num, txt, baseName, bytesOf } from './x-util.js';

export function initBatch(X, c) {
  const { h, btn, toast } = c;
  const { PDFDocument, degrees } = c.PDFLib;
  const OPS = [
    ['merge', 'Join them into one PDF'], ['compress', 'Make each one smaller'], ['lock', 'Put a password on each'], ['unlock', 'Remove the password from each'],
    ['clean', 'Remove hidden information (author, dates)'], ['rotate', 'Turn every page 90 degrees'], ['pdf2img', 'Save every page as a picture'], ['img2pdf', 'Turn pictures into PDFs (one each)'],
  ];
  X.batch = () => {
    let files = [], running = false;
    const op = selectEl(c, OPS, 'merge'), pw = h('input', { type: 'password', style: 'width:100%' }), pwBox = fld(c, 'Password', pw), listBox = h('div', { class: 'muted', style: 'max-height:140px;overflow:auto' }), q = num(c, 60, 20, 95);
    const qBox = fld(c, 'Picture quality (%) for smaller files', q);
    const sync = () => { pwBox.style.display = op.value === 'lock' || op.value === 'unlock' ? '' : 'none'; qBox.style.display = op.value === 'compress' ? '' : 'none'; pwBox.firstChild.textContent = c.tr(op.value === 'lock' ? 'Password to set' : 'Password the files have'); };
    op.onchange = sync; sync();
    const pick = async (isImg) => { const f = await c.host.openFiles({ multi: true, read: false, filters: isImg ? [['Pictures', ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']]] : [['PDF files', ['pdf']]] }); if (f.length) { files = f; listBox.textContent = f.map((x) => x.name).join('  ·  '); } };
    const bar = h('div', { class: 'progress', style: 'display:none' }, h('i')), msg = note(c, '');
    modal(c, 'Batch', [note(c, 'Choose the files, choose the job, then choose where to save the results. Your originals are never changed.'), fld(c, 'Job', op),
      h('div', { class: 'row' }, btn('Choose PDF files', () => pick(false)), btn('Choose pictures', () => pick(true))), listBox, pwBox, qBox, bar, msg],
    (close) => [btn('Close', close), btn('Start', async () => {
      if (running) return;
      if (!files.length) { toast('Choose some files first'); return; }
      const o = op.value; if ((o === 'lock') && !pw.value) { toast('Type a password'); return; }
      bar.style.display = ''; const out = [], failed = []; running = true;
      try {
        const get = async (f) => bytesOf(await c.host.readFile(f.id));
        if (o === 'merge') {
          const m = await PDFDocument.create();
          for (let i = 0; i < files.length; i++) { msg.textContent = `Joining ${i + 1} of ${files.length}`; bar.firstChild.style.width = Math.round((i / files.length) * 100) + '%'; try { const d = await PDFDocument.load(await get(files[i]), { ignoreEncryption: false }); (await m.copyPages(d, d.getPageIndices())).forEach((p) => m.addPage(p)); } catch (e) { failed.push(files[i].name); } }
          if (m.getPageCount()) out.push({ name: 'joined.pdf', data: new Uint8Array(await m.save()) });
        } else {
          for (let i = 0; i < files.length; i++) {
            const f = files[i]; msg.textContent = `${i + 1} of ${files.length}: ${f.name}`; bar.firstChild.style.width = Math.round((i / files.length) * 100) + '%';
            try {
              const b = await get(f), stem = baseName(f.name);
              if (o === 'img2pdf') out.push({ name: stem + '.pdf', data: await c.imageToPdf(b, /\.jpe?g$/i.test(f.name)) });
              else if (o === 'compress') out.push({ name: stem + '-small.pdf', data: await c.pdfToJpegPdf(b, q.value / 100, 1.4) });
              else if (o === 'pdf2img') {
                const doc = await c.pdfjs.getDocument({ data: b.slice(), isEvalSupported: false }).promise;
                for (let p = 1; p <= doc.numPages; p++) { const pg = await doc.getPage(p), vp = pg.getViewport({ scale: 2 }), cv = h('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height); const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); await pg.render({ canvasContext: g, viewport: vp }).promise; out.push({ name: `${stem}-page${p}.png`, data: new Uint8Array(await (await new Promise((r) => cv.toBlob(r, 'image/png'))).arrayBuffer()) }); }
                doc.destroy();
              } else {
                const d = await PDFDocument.load(b, o === 'unlock' ? { password: pw.value } : o === 'lock' ? {} : { ignoreEncryption: false, password: pw.value });
                if (o === 'rotate') d.getPages().forEach((p) => p.setRotation(degrees((p.getRotation().angle + 90) % 360)));
                if (o === 'clean') { d.setTitle(''); d.setAuthor(''); d.setSubject(''); d.setKeywords([]); d.setProducer(''); d.setCreator(''); }
                if (o === 'lock') d.encrypt({ userPassword: pw.value, ownerPassword: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''), permissions: { printing: 'highResolution', copying: true, modifying: false, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false } });
                const outDoc = (o === 'unlock' || o === 'clean') ? await (async () => { const n = await PDFDocument.create({ updateMetadata: o !== 'clean' }); (await n.copyPages(d, d.getPageIndices())).forEach((p) => n.addPage(p)); if (o === 'clean') { n.setProducer(''); n.setCreator(''); } return n; })() : d;
                out.push({ name: stem + (o === 'lock' ? '-locked' : o === 'unlock' ? '-unlocked' : o === 'rotate' ? '-rotated' : '-clean') + '.pdf', data: new Uint8Array(await outDoc.save()) });
              }
            } catch (e) { failed.push(f.name + (/password|encrypt/i.test(String(e.message)) ? ' (password?)' : '')); }
          }
        }
        bar.firstChild.style.width = '100%';
        if (!out.length) { msg.textContent = 'Nothing was made. ' + (failed.length ? 'Could not read: ' + failed.join(', ') : ''); return; }
        const r = await c.host.saveMany({ items: out, title: 'Choose a folder for the results' });
        msg.textContent = r ? `Saved ${r.count} file${r.count === 1 ? '' : 's'}.` + (failed.length ? ` Could not process: ${failed.join(', ')}` : '') : 'Cancelled.';
        if (r) toast(`Batch done: ${r.count} file${r.count === 1 ? '' : 's'} saved`);
      } catch (e) { msg.textContent = 'Failed: ' + (e.message || e); } finally { running = false; }
    }, 'primary')]);
  };
}
