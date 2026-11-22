// Small helpers shared by the extra PDFout features.
export function modal(c, title, body, actions, cls = '') {
  let back;
  const close = () => back.remove();
  const acts = typeof actions === 'function' ? actions(close) : actions;
  back = c.h('div', { class: 'modal-back' }, c.h('div', { class: 'modal ' + cls }, c.h('h2', { text: title }), ...body.flat().filter(Boolean),
    c.h('div', { class: 'row', style: 'justify-content:flex-end;flex-wrap:wrap' }, ...acts.filter(Boolean))));
  document.body.append(back);
  return { back, close };
}
export const fld = (c, label, input) => c.h('label', { class: 'field' }, label, input);
export const note = (c, text) => c.h('div', { class: 'muted', text });
export const sel = (c, opts, value) => { const s = c.h('select', {}, opts.map(([v, n]) => c.h('option', { value: v, text: n }))); if (value != null) s.value = value; return s; };
export const num = (c, value, min, max, step = 1) => c.h('input', { type: 'number', value, min, max, step, style: 'width:100%' });
export const txt = (c, value = '', ph = '') => c.h('input', { type: 'text', value, placeholder: ph, style: 'width:100%' });

// "1-3, 5, 8-" -> [0,1,2,4,7,...] (zero based, in order, no repeats)
export function parseRange(str, n) {
  const seen = new Set(), out = [];
  const add = (i) => { if (i >= 1 && i <= n && !seen.has(i)) { seen.add(i); out.push(i - 1); } };
  for (const part of String(str || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)-(\d*)$/.exec(part);
    if (m) { const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : n; if (a <= b) for (let i = a; i <= b; i++) add(i); else for (let i = a; i >= b; i--) add(i); }
    else if (/^\d+$/.test(part)) add(+part);
  }
  return out;
}
export const baseName = (n) => String(n || 'document').replace(/\.[^.\\/]+$/, '');
export const todayStr = () => new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
export const bytesOf = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));
export async function imageToPngDataUrl(bytes, maxSide = 2000) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return { url: cv.toDataURL('image/png'), w: cv.width, h: cv.height };
}
export const blobBytes = async (cv, type = 'image/png', q) => new Uint8Array(await (await new Promise((r) => cv.toBlob(r, type, q))).arrayBuffer());
// maps an annotation through u' = ax*u + bx, v' = ay*v + by (sizes scale with ax, ay)
export function mapAnn(a, k) {
  if (a.x != null) { a.x = k.ax * a.x + k.bx; a.y = k.ay * a.y + k.by; }
  if (a.bw != null) { a.bw *= k.ax; a.bh *= k.ay; }
  if (a.pts) a.pts = a.pts.map(([u, v]) => [k.ax * u + k.bx, k.ay * v + k.by]);
  if (a.fs != null) a.fs *= k.ax;
}
