// Extra PDFout features. app.js hands over what these modules need; each module adds its tools to X.
import { initPages } from './x-pages.js';
import { initDoc } from './x-doc.js';
import { initSecure } from './x-secure.js';
import { initConvert } from './x-convert.js';
import { initBatch } from './x-batch.js';

export function initExtra(X, c) {
  for (const [name, init] of [['pages', initPages], ['doc', initDoc], ['secure', initSecure], ['convert', initConvert], ['batch', initBatch]]) {
    try { init(X, c); } catch (e) { console.error('extra module failed:', name, e); }
  }
}
