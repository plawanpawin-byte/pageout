// Privacy and trust: clean metadata, flatten, redact by words or patterns, digital signature with a certificate.
import { modal, fld, note, sel as selectEl, txt, baseName, todayStr, bytesOf } from './x-util.js';

export function initSecure(X, c) {
  const { h, btn, toast } = c;
  const need = () => { if (!c.pages.length) { toast('Open a PDF first'); return false; } return true; };
  const saveBytes = async (suffix, bytes) => { const r = await c.host.saveFile({ name: baseName(c.fileName || 'document') + suffix, filters: [['PDF', ['pdf']]], data: bytes }); if (r) toast('Saved ' + r.name); return r; };

  // ---------- clean metadata ----------
  X.sanitize = () => {
    if (!need()) return;
    const marks = h('input', { type: 'checkbox' });
    modal(c, 'Clean hidden information', [note(c, 'Saves a copy with no title, author, subject, keywords, creator, producer or dates. Text covered by Redact is removed for good.'), h('label', { class: 'row' }, marks, h('span', { text: 'Also remove the bookmarks' }))],
    (close) => [btn('Cancel', close), btn('Save clean copy', async () => {
      close(); const m = { ...c.meta }, o = c.outline;
      try {
        c.meta = {}; if (marks.checked) c.outline = [];
        const bytes = await c.buildPdf(c.pages, null, { noMeta: true });
        await saveBytes('-clean.pdf', bytes);
      } catch (e) { toast('Failed: ' + (e.message || e)); } finally { c.meta = m; c.outline = o; }
    }, 'primary')]);
  };
  X.flatten = () => {
    if (!need()) return;
    modal(c, 'Flatten', [note(c, 'Saves a copy where every form field becomes plain text on the page. Nobody can change the answers afterwards.')], (close) => [btn('Cancel', close), btn('Save flattened copy', async () => {
      close(); try { const bytes = await c.buildPdf(c.pages, null, { post: async (out) => { try { out.getForm().flatten(); } catch (e) { toast('Some form fields could not be flattened: ' + (e.message || e)); } } }); await saveBytes('-flat.pdf', bytes); } catch (e) { toast('Failed: ' + (e.message || e)); }
    }, 'primary')]);
  };

  // ---------- redact by words or patterns ----------
  const meas = document.createElement('canvas').getContext('2d'); meas.font = '100px Arial, "Leelawadee UI", sans-serif';
  const mw = (s) => meas.measureText(s).width;
  let skippedRot = 0;
  // finds the places on a page where a regular expression matches; text split over several runs is joined first
  async function matchesOnPage(p, res) {
    const out = [];
    if (p.src) {
      const pg = await c.sources.get(p.src).pdf.getPage(p.index + 1), vp = pg.getViewport({ scale: 1, rotation: pg.rotate }), tc = await pg.getTextContent();
      const segs = []; let T = '', prevEnd = null, prevY = null;
      for (const it of tc.items) { if (!it.str) continue; const fs0 = Math.hypot(it.transform[2], it.transform[3]) || 10; if (T && !(prevY !== null && Math.abs(it.transform[5] - prevY) < 0.3 * fs0 && Math.abs(it.transform[4] - prevEnd) < 0.2 * fs0)) T += ' '; segs.push({ it, s: T.length, e: T.length + it.str.length }); T += it.str; prevEnd = it.transform[4] + it.width; prevY = it.transform[5]; }
      for (const re of res) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(T))) {
          if (!m[0]) { re.lastIndex++; continue; }
          if (re.check && !re.check(m[0])) continue;
          for (const sg of segs) {
            const a = Math.max(m.index, sg.s), b = Math.min(m.index + m[0].length, sg.e); if (b <= a) continue;
            const it = sg.it, tr = it.transform; if (Math.abs(tr[1]) > 0.01 || Math.abs(tr[2]) > 0.01) { skippedRot++; continue; }
            const fs = Math.hypot(tr[2], tr[3]) || 10, full = mw(it.str) || 1, pre = mw(it.str.slice(0, a - sg.s)), part = mw(it.str.slice(a - sg.s, b - sg.s));
            const x0 = tr[4] + it.width * (pre / full), x1 = x0 + it.width * (part / full), y = tr[5];
            const A = vp.convertToViewportPoint(x0 - fs * 0.1, y + 1.0 * fs), B = vp.convertToViewportPoint(x1 + fs * 0.1, y - 0.38 * fs);
            out.push({ x: Math.min(A[0], B[0]) / vp.width, y: Math.min(A[1], B[1]) / vp.height, bw: Math.abs(A[0] - B[0]) / vp.width, bh: Math.abs(A[1] - B[1]) / vp.height });
          }
        }
      }
    }
    if (p.ocr) {
      for (const l of p.ocr.lines) for (const re of res) {
        re.lastIndex = 0; let m; const full = mw(l.t) || 1;
        while ((m = re.exec(l.t))) {
          if (!m[0]) { re.lastIndex++; continue; } if (re.check && !re.check(m[0])) continue;
          const f0 = mw(l.t.slice(0, m.index)) / full, f1 = mw(l.t.slice(0, m.index + m[0].length)) / full, xa = l.x0 + (l.x1 - l.x0) * f0, xb = l.x0 + (l.x1 - l.x0) * f1;
          const a = c.rotInv(xa, l.y0, p.rot), b = c.rotInv(xb, l.y1, p.rot);
          out.push({ x: Math.min(a[0], b[0]) - 0.002, y: Math.min(a[1], b[1]) - 0.002, bw: Math.abs(a[0] - b[0]) + 0.004, bh: Math.abs(a[1] - b[1]) + 0.004 });
        }
      }
    }
    return out;
  }
  async function redactWith(res) {
    c.commit(); let n = 0, pgs = 0; skippedRot = 0;
    for (const p of c.pages) { const ms = await matchesOnPage(p, res); if (ms.length) pgs++; for (const m of ms) { p.annots.push(c.mkAnn({ type: 'redact', ...m })); n++; } }
    if (!n) { c.dropCommit(); toast('Nothing found to redact'); return; }
    c.redrawOverlays(); toast(`Blacked out ${n} place${n === 1 ? '' : 's'} on ${pgs} page${pgs === 1 ? '' : 's'}. The text is removed for good when you save.`);
    if (skippedRot) setTimeout(() => toast(`${skippedRot} sideways or upside-down pieces of text were not checked. Look at the pages yourself.`), 2800);
    else if (c.outline.length || c.meta.title || c.meta.author || c.meta.subject || c.meta.keywords) setTimeout(() => toast('Bookmarks and document properties may still contain these words. Check them, or use Clean metadata.'), 2800);
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  X.redactWords = () => {
    if (!need()) return;
    const ta = h('textarea', { rows: 5, style: 'width:100%', placeholder: 'One word or phrase on each line' }), cs = h('input', { type: 'checkbox' });
    modal(c, 'Redact words', [note(c, 'Every place these words appear is covered with a black box. When you save, the covered text is removed from the file, not just hidden.'), ta, h('label', { class: 'row' }, cs, h('span', { text: 'Match capital letters exactly' }))], (close) => [btn('Cancel', close), btn('Black them out', async () => {
      const words = ta.value.split('\n').map((s) => s.trim()).filter(Boolean); if (!words.length) return; close();
      await redactWith(words.map((w) => new RegExp(esc(w), cs.checked ? 'g' : 'gi')));
    }, 'primary')]);
    setTimeout(() => ta.focus(), 50);
  };
  const luhn = (s) => { const d = s.replace(/\D/g, ''); if (d.length < 13 || d.length > 19) return false; let sum = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; };
  const PATTERNS = [
    ['email', 'Email addresses', () => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
    ['thaiid', 'Thai ID card numbers (13 digits)', () => /(?<!\d)\d[ -]?\d{4}[ -]?\d{5}[ -]?\d{2}[ -]?\d(?!\d)/g],
    ['phone', 'Phone numbers', () => /(?<![\d])(?:\+\d{1,3}[ -]?)?\(?0?\d{1,3}\)?[ -]?\d{3,4}[ -]?\d{3,4}(?!\d)/g],
    ['card', 'Bank card numbers', () => { const r = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g; r.check = luhn; return r; }],
    ['long', 'Any number with 9 or more digits', () => /(?<!\d)\d(?:[ -]?\d){8,}(?!\d)/g],
    ['url', 'Web addresses', () => /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/gi],
  ];
  X.redactPatterns = () => {
    if (!need()) return;
    const boxes = PATTERNS.map(([k, name]) => { const i = h('input', { type: 'checkbox' }); i.dataset.k = k; if (k === 'email' || k === 'thaiid' || k === 'card') i.checked = true; return [i, h('label', { class: 'row' }, i, h('span', { text: name }))]; });
    modal(c, 'Redact patterns', [note(c, 'Finds personal details by their shape and covers them with black boxes. Look through the result before you save: a pattern can miss one or catch an ordinary number.'), ...boxes.map((b) => b[1])], (close) => [btn('Cancel', close), btn('Find and black out', async () => {
      const on = boxes.filter(([i]) => i.checked).map(([i]) => PATTERNS.find((p) => p[0] === i.dataset.k)[2]()); if (!on.length) return; close(); await redactWith(on);
    }, 'primary')]);
  };

  // ---------- digital signature ----------
  const forge = () => window.forge;
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  const IDKEY = 'pdfout.signid';
  const loadId = () => { try { return JSON.parse(localStorage.getItem(IDKEY) || 'null'); } catch { return null; } };
  async function wrapKey(pass, salt) { const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
  async function makeId(name, email, org, pass) {
    const F = forge(), keys = await new Promise((res, rej) => F.pki.rsa.generateKeyPair({ bits: 2048 }, (e, k) => (e ? rej(e) : res(k))));
    const cert = F.pki.createCertificate(); cert.publicKey = keys.publicKey; cert.serialNumber = '01' + F.util.bytesToHex(F.random.getBytesSync(8));
    cert.validity.notBefore = new Date(Date.now() - 86400000); cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 86400000);
    const attrs = [{ name: 'commonName', value: name }]; if (email) attrs.push({ name: 'emailAddress', value: email }); if (org) attrs.push({ name: 'organizationName', value: org });
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true }]);
    cert.sign(keys.privateKey, F.md.sha256.create());
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(pass, salt), new TextEncoder().encode(F.pki.privateKeyToPem(keys.privateKey))));
    const rec = { name, cert: F.pki.certificateToPem(cert), salt: b64(salt), iv: b64(iv), key: b64(enc), made: Date.now() };
    try { localStorage.setItem(IDKEY, JSON.stringify(rec)); } catch { toast('The signing ID could not be remembered. It works for this signature only.'); }
    return rec;
  }
  async function openId(rec, pass) {
    const F = forge();
    try { const pem = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, await wrapKey(pass, unb64(rec.salt)), unb64(rec.key))); return { key: F.pki.privateKeyFromPem(pem), cert: F.pki.certificateFromPem(rec.cert) }; }
    catch { throw new Error('That passphrase is not right'); }
  }
  function openPfx(bytes, pass) {
    const F = forge(); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    let p12; try { p12 = F.pkcs12.pkcs12FromAsn1(F.asn1.fromDer(F.util.createBuffer(bin)), pass || ''); } catch (e) { throw new Error('Cannot open the certificate file. Check the password. (' + (e.message || e) + ')'); }
    const kb = [...(p12.getBags({ bagType: F.pki.oids.pkcs8ShroudedKeyBag })[F.pki.oids.pkcs8ShroudedKeyBag] || []), ...(p12.getBags({ bagType: F.pki.oids.keyBag })[F.pki.oids.keyBag] || [])];
    const cb = p12.getBags({ bagType: F.pki.oids.certBag })[F.pki.oids.certBag] || [];
    if (!kb.length || !cb.length) throw new Error('The file has no signing key and certificate');
    const key = kb[0].key; if (!key || !key.n) throw new Error('Only RSA certificates are supported');
    const cert = (cb.find((b) => b.cert.publicKey.n && b.cert.publicKey.n.compareTo(key.n) === 0) || cb[0]).cert;
    return { key, cert, chain: cb.map((b) => b.cert) };
  }
  const pdfDate = (d = new Date()) => { const z = (n, l = 2) => String(n).padStart(l, '0'); return `D:${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`; };
  const SIGLEN = 16384;
  // adds an empty signature field to the document being built; returns the widget rectangle
  function addSigField(out, page, rect, info) {
    const { PDFName, PDFString, PDFHexString } = c.PDFLib, ctx = out.context;
    const sig = ctx.register(ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 9999999999, 9999999999, 9999999999], Contents: PDFHexString.of('0'.repeat(SIGLEN)),
      M: PDFString.of(pdfDate()), Name: PDFHexString.fromText(info.name), ...(info.reason ? { Reason: PDFHexString.fromText(info.reason) } : {}), ...(info.location ? { Location: PDFHexString.fromText(info.location) } : {}), ...(info.contact ? { ContactInfo: PDFHexString.fromText(info.contact) } : {}) }));
    const w = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), F: 132, Rect: rect, V: sig, P: page.ref }));
    page.node.addAnnot(w);
    const af = out.catalog.lookup(PDFName.of('AcroForm'));
    if (af && af.get) { const f = af.lookup(PDFName.of('Fields')); if (f && f.push) f.push(w); else af.set(PDFName.of('Fields'), ctx.obj([w])); af.set(PDFName.of('SigFlags'), ctx.obj(3)); }
    else out.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [w], SigFlags: 3 }));
  }
  async function signBytes(pdf, ident, info) {
    const F = forge(), txt_ = new TextDecoder('latin1').decode(pdf);
    const m = /\/ByteRange\s*\[\s*0\s+9999999999\s+9999999999\s+9999999999\s*\]/.exec(txt_); if (!m) throw new Error('Signature placeholder not found');
    const cs = txt_.indexOf('<' + '0'.repeat(64)), ce = txt_.indexOf('>', cs) + 1; if (cs < 0 || ce - cs !== SIGLEN + 2) throw new Error('Signature space not found');
    const br = [0, cs, ce, pdf.length - ce], pad = (n) => String(n).padStart(10, '0');
    const vals = br.slice(1), patched = m[0].replace(/9999999999/g, () => pad(vals.shift())), at = m.index;
    const bytes = pdf.slice(); for (let i = 0; i < patched.length; i++) bytes[at + i] = patched.charCodeAt(i);
    if (patched.length !== m[0].length) throw new Error('ByteRange length changed');
    const part = new Uint8Array(cs + (pdf.length - ce)); part.set(bytes.subarray(0, cs), 0); part.set(bytes.subarray(ce), cs);
    // forge hashes the content itself, so hand it the signed byte ranges as a binary string
    let bin = ''; for (let i = 0; i < part.length; i += 16384) bin += String.fromCharCode.apply(null, part.subarray(i, i + 16384));
    const p7 = F.pkcs7.createSignedData(); p7.content = F.util.createBuffer(bin); p7.addCertificate(ident.cert); (ident.chain || []).forEach((cc) => { if (cc !== ident.cert) p7.addCertificate(cc); });
    p7.addSigner({ key: ident.key, certificate: ident.cert, digestAlgorithm: F.pki.oids.sha256, authenticatedAttributes: [{ type: F.pki.oids.contentType, value: F.pki.oids.data }, { type: F.pki.oids.messageDigest }, { type: F.pki.oids.signingTime, value: new Date() }] });
    p7.sign({ detached: true });
    const der = F.asn1.toDer(p7.toAsn1()).getBytes(); const hex = F.util.bytesToHex(der).toUpperCase();
    if (hex.length > SIGLEN) throw new Error('The certificate chain is too large to fit in the signature');
    const full = hex + '0'.repeat(SIGLEN - hex.length); for (let i = 0; i < full.length; i++) bytes[cs + 1 + i] = full.charCodeAt(i);
    return bytes;
  }
  const subjectName = (cert) => { const f = cert.subject.getField('CN'); return f ? f.value : 'Signer'; };
  function stampImage(name, reason, location) {
    const cv = document.createElement('canvas'); const W = 560, H = 190; cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, 0, W, H); g.strokeStyle = '#1f5fbf'; g.lineWidth = 4; g.strokeRect(2, 2, W - 4, H - 4);
    g.fillStyle = '#1f3d7a'; g.font = '600 30px "Segoe UI","Leelawadee UI",Arial,sans-serif'; g.fillText('Digitally signed by', 18, 42);
    g.fillStyle = '#111'; g.font = '700 36px "Segoe UI","Leelawadee UI",Arial,sans-serif'; g.fillText(name.length > 28 ? name.slice(0, 27) + '…' : name, 18, 88);
    g.fillStyle = '#333'; g.font = '24px "Segoe UI","Leelawadee UI",Arial,sans-serif'; g.fillText('Date: ' + new Date().toLocaleString(), 18, 124);
    const line3 = [reason && 'Reason: ' + reason, location && 'Place: ' + location].filter(Boolean).join('   '); if (line3) g.fillText(line3.slice(0, 48), 18, 158);
    return { url: cv.toDataURL('image/png'), w: W, h: H };
  }
  X.certSign = () => {
    if (!need()) return;
    if (!forge()) { toast('The signing library did not load'); return; }
    if (c.protectOpts) { toast('Remove the password first (Protect > Password). A signed file cannot be locked at the same time.'); return; }
    const rec = loadId();
    const mode = selectEl(c, [...(rec ? [['mine', `My signing ID: ${rec.name}`]] : []), ['new', 'Create a new signing ID'], ['file', 'Use a certificate file (.pfx or .p12)']], rec ? 'mine' : 'new');
    const pass = h('input', { type: 'password', style: 'width:100%' }), passFile = h('input', { type: 'password', style: 'width:100%' }), pass2 = h('input', { type: 'password', style: 'width:100%' }), nm = txt(c, ''), em = txt(c, ''), org = txt(c, '');
    let pfx = null; const pfxInfo = note(c, 'No file chosen'), pfxBtn = btn('Choose certificate file', async () => { const f = await c.host.openFiles({ multi: false, filters: [['Certificate', ['pfx', 'p12']]] }); if (f.length) { pfx = bytesOf(f[0].data); pfxInfo.textContent = f[0].name; } });
    const rows = { mine: [fld(c, 'Your passphrase', pass)], new: [fld(c, 'Name', nm), fld(c, 'Email (optional)', em), fld(c, 'Organisation (optional)', org), fld(c, 'Choose a passphrase', pass2)], file: [pfxBtn, pfxInfo, fld(c, 'Certificate password', passFile)] };
    const holder = h('div', { class: 'col', style: 'gap:8px' }), show = () => { holder.textContent = ''; const set = rows[mode.value]; holder.append(...set); }; mode.onchange = show; show();
    const reason = txt(c, '', 'for example I approve this document'), place = txt(c, ''), pos = selectEl(c, [['brLast', 'Bottom right of the last page'], ['blFirst', 'Bottom left of the first page'], ['cCur', 'Centre of this page'], ['none', 'Not visible']], 'brLast');
    modal(c, 'Digital signature', [note(c, 'Signs the whole document with a certificate. Anyone can check that it is yours and that nothing changed afterwards. Changing the saved file breaks the signature, so sign last.'),
      fld(c, 'Sign with', mode), holder, fld(c, 'Reason (optional)', reason), fld(c, 'Place (optional)', place), fld(c, 'Where to show it', pos),
      note(c, 'A signing ID you create here is trusted by you only. Other people see it as "not verified" until they trust your certificate. For signatures that others trust automatically, use a certificate from a certificate authority in a .pfx file.')],
    (close) => [btn('Cancel', close), btn('Sign and save', async () => {
      try {
        let ident;
        if (mode.value === 'mine') ident = await openId(rec, pass.value);
        else if (mode.value === 'new') { if (rec && !confirm(c.tr('This replaces your saved signing ID. Files you signed with the old one stay valid, but you can no longer sign as it. Continue?'))) return; if (!nm.value.trim()) { toast('Type your name'); return; } if (pass2.value.length < 6) { toast('Use a passphrase of at least 6 characters'); return; } toast('Creating your signing ID, this takes a few seconds...'); const r = await makeId(nm.value.trim(), em.value.trim(), org.value.trim(), pass2.value); ident = await openId(r, pass2.value); }
        else { if (!pfx) { toast('Choose a certificate file'); return; } ident = openPfx(pfx, passFile.value); }
        close(); toast('Signing...');
        const who = subjectName(ident.cert), N = c.pages.length, ti = pos.value === 'cCur' ? c.curPage : pos.value === 'blFirst' ? 0 : N - 1;
        const list = c.pages.map((p) => ({ ...p, annots: p.annots.slice() })); const target = list[ti];
        const sp = pos.value === 'none' ? null : { x: pos.value === 'blFirst' ? 0.05 : pos.value === 'cCur' ? 0.3 : 0.6, y: pos.value === 'cCur' ? 0.45 : 0.88 };
        if (sp) { const im = stampImage(who, reason.value.trim(), place.value.trim()), [dw, dh] = c.dispDims(target), bw = 0.35, bh = bw * (im.h / im.w) * (dw / dh); target.annots.push(c.mkAnn({ type: 'image', x: sp.x, y: Math.min(sp.y, 0.97 - bh), bw, bh, data: im.url, tag: 'sigstamp' })); }
        const info = { name: who, reason: reason.value.trim(), location: place.value.trim() };
        const raw = await c.buildPdf(list, null, { save: { useObjectStreams: false, addDefaultPage: false }, post: async (out) => {
          const pg = out.getPage(ti), box = pg.getCropBox(); let rect = [0, 0, 0, 0];
          const st = target.annots.find((a) => a.tag === 'sigstamp');
          if (st) { const rast = target.annots.some((a) => a.type === 'redact' || a.perm), q = { w: box.width, h: box.height, r0: rast ? 0 : target.r0 }, A = c.dispToPdf(q, st.x, st.y, box), B = c.dispToPdf(q, st.x + st.bw, st.y + st.bh, box); rect = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])]; }
          addSigField(out, pg, rect, info);
        } });
        const signed = await signBytes(raw, ident, info);
        await saveBytes('-signed.pdf', signed);
      } catch (e) { toast('Signing failed: ' + (e.message || e)); }
    }, 'primary')]);
  };
  X._sig = { signBytes, addSigField, makeId, openId };

  // ---------- check the signatures of the open file ----------
  X.verifySigs = async () => {
    if (!need()) return; const F = forge();
    const ent = [...c.sources.values()][0]; const bytes = ent.bytes, txt_ = new TextDecoder('latin1').decode(bytes), found = [];
    const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g; let m;
    while ((m = re.exec(txt_))) {
      const br = m.slice(1, 5).map(Number), rest = txt_.slice(br[1], br[2]), hx = /^\s*<([0-9A-Fa-f\s]+)>/.exec(rest); if (!hx) continue;
      const row = { ok: false, text: '' };
      const covers = br[0] === 0 && br[1] <= br[2] && br[2] + br[3] === bytes.length && /^\s*<[0-9A-Fa-f\s]+>\s*$/.test(txt_.slice(br[1], br[2]));
      try {
        const der = F.util.hexToBytes(hx[1].replace(/\s+/g, '').replace(/(00)+$/i, '')), msg = F.pkcs7.messageFromAsn1(F.asn1.fromDer(F.util.createBuffer(der)));
        const part = new Uint8Array(br[1] + br[3]); part.set(bytes.subarray(br[0], br[0] + br[1]), 0); part.set(bytes.subarray(br[2], br[2] + br[3]), br[1]);
        const cert = msg.certificates[0], sgn = msg.rawCapture, name = cert ? subjectName(cert) : 'Unknown';
        const alg = F.asn1.derToOid(sgn.digestAlgorithm), md = /2\.16\.840\.1\.101\.3\.4\.2\.1$/.test(alg) ? 'SHA-256' : /\.2\.3$/.test(alg) ? 'SHA-512' : /\.2\.2$/.test(alg) ? 'SHA-384' : 'SHA-1';
        const digest = new Uint8Array(await crypto.subtle.digest(md, part)); let dbin = ''; for (const b of digest) dbin += String.fromCharCode(b);
        const attrs = sgn.authenticatedAttributes; let docOk = true, sigOk = false;
        if (attrs) {
          const mdAttr = attrs.find((a) => F.asn1.derToOid(a.value[0].value) === F.pki.oids.messageDigest); docOk = !!mdAttr && mdAttr.value[1].value[0].value === dbin;
          const set = F.asn1.create(F.asn1.Class.UNIVERSAL, F.asn1.Type.SET, true, attrs), h2 = F.md[md === 'SHA-256' ? 'sha256' : md === 'SHA-512' ? 'sha512' : md === 'SHA-384' ? 'sha384' : 'sha1'].create(); h2.update(F.asn1.toDer(set).getBytes());
          sigOk = cert.publicKey.verify(h2.digest().getBytes(), sgn.signature);
        }
        const self = cert && cert.isIssuer(cert);
        row.ok = docOk && sigOk && covers; row.text = `${name}: ${!covers ? 'THE FILE WAS CHANGED OR EXTENDED after signing (the signature does not cover the whole file)' : docOk ? 'the document is unchanged since signing' : 'THE DOCUMENT WAS CHANGED after signing'}; ${sigOk ? 'the signature itself is genuine' : 'the signature does not match'}. ${self ? 'Self-signed, so you must decide whether to trust this person.' : 'The certificate was not checked against a list of trusted authorities.'}`;
      } catch (e) { row.text = 'A signature is present but cannot be read: ' + (e.message || e); }
      found.push(row);
    }
    modal(c, 'Signatures in this file', found.length ? found.map((r) => h('div', { style: `padding:8px 10px;border-radius:8px;background:${r.ok ? 'rgba(116,178,124,.18)' : 'rgba(217,108,108,.18)'}`, text: (r.ok ? '✔ ' : '✖ ') + r.text })) : [note(c, 'This file has no digital signature.')], (close) => [btn('Close', close, 'primary')]);
  };
}
