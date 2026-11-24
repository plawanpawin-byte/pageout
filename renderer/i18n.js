// Interface language. English strings are the keys; Thai is looked up in th.js. Anything not found stays in English.
import { TH, RULES } from './th.js';
let lang = 'en';
try { lang = localStorage.getItem('pdfout.lang') || ((navigator.language || '').toLowerCase().startsWith('th') ? 'th' : 'en'); } catch {}
export const getLang = () => lang;
// main shows native prompts (close with unsaved changes) in this language
const tellHost = () => { try { window.host && window.host.setLang && window.host.setLang(lang); } catch {} };
tellHost();
export function setLang(l) { lang = l === 'th' ? 'th' : 'en'; try { localStorage.setItem('pdfout.lang', lang); } catch {} tellHost(); }
export function tr(s) {
  if (lang !== 'th' || typeof s !== 'string' || !s) return s;
  const v = TH[s]; if (v !== undefined) return v;
  for (const [re, fn] of RULES) { const m = re.exec(s); if (m) return fn(...m.slice(1)); }
  return s;
}
