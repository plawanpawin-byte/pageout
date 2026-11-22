'use strict';
// PDFout main process. Local-only: no network access, files only via user-chosen dialogs.
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TITLE = 'PDFout';
const granted = new Map(); // opaque id -> absolute path the user picked in a dialog
let win = null;

function grant(p) {
  const id = crypto.randomBytes(8).toString('hex');
  granted.set(id, p);
  return id;
}
function pathOf(id) {
  const p = granted.get(String(id));
  if (!p) throw new Error('Path was not granted by the user');
  return p;
}
module.exports = { grant, pathOf };

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: TITLE, backgroundColor: '#262626', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

const filters = (list) => (list || []).map((f) => ({ name: f[0], extensions: f[1] }));

// recent files: only paths the user picked in a dialog are ever remembered
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
function recentLoad() { try { const j = JSON.parse(fs.readFileSync(recentFile(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
function recentSave(list) { try { fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 60))); } catch {} }
function recentAdd(p) {
  const list = recentLoad(); const old = list.find((x) => x.p === p);
  const rest = list.filter((x) => x.p !== p);
  recentSave([{ p, star: old ? !!old.star : false, at: Date.now() }, ...rest]);
}
function readItem(p, opts = {}) {
  const st = fs.statSync(p);
  const item = { id: grant(p), name: path.basename(p), size: st.size };
  if (opts.read !== false && st.size <= (opts.maxBytes || 512 * 1024 * 1024)) item.data = fs.readFileSync(p);
  return item;
}
ipcMain.handle('recent:list', () => recentLoad().map((x) => {
  try { const st = fs.statSync(x.p); return { id: grant(x.p), name: path.basename(x.p), dir: path.dirname(x.p), size: st.size, mtime: st.mtimeMs, star: !!x.star }; } catch { return null; }
}).filter(Boolean));
ipcMain.handle('recent:open', (_e, id) => { const p = pathOf(id); recentAdd(p); return readItem(p); });
ipcMain.handle('recent:star', (_e, id) => { const p = pathOf(id); recentSave(recentLoad().map((x) => (x.p === p ? { ...x, star: !x.star } : x))); return true; });
ipcMain.handle('recent:clear', () => { recentSave(recentLoad().filter((x) => x.star)); return true; });

ipcMain.handle('file:open', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
    filters: filters(opts.filters),
  });
  if (r.canceled) return [];
  const out = [];
  for (const p of r.filePaths) { out.push(readItem(p, opts)); recentAdd(p); }
  return out;
});

function safeName(n) {
  const t = String(n || 'untitled').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(t) || !t ? '_' + t : t;
}

ipcMain.handle('file:save', async (_e, opts = {}) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: safeName(opts.name), filters: filters(opts.filters),
  });
  if (r.canceled || !r.filePath) return null;
  if (opts.data) fs.writeFileSync(r.filePath, Buffer.from(opts.data));
  return { id: grant(r.filePath), name: path.basename(r.filePath) };
});

ipcMain.handle('file:saveSeq', async (_e, opts = {}) => {
  const items = Array.isArray(opts.items) ? opts.items : [];
  const r = await dialog.showSaveDialog(win, { defaultPath: safeName(opts.name || 'page.png'), filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (r.canceled || !r.filePath || !items.length) return 0;
  const base = r.filePath.replace(/\.[^.\\/]+$/, '');
  items.forEach((b, i) => fs.writeFileSync(`${base}-${i + 1}.png`, Buffer.from(b)));
  return items.length;
});

ipcMain.handle('file:saveMany', async (_e, opts = {}) => {
  const items = Array.isArray(opts.items) ? opts.items : [];
  if (!items.length) return null;
  const r = await dialog.showOpenDialog(win, { title: opts.title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0]; let count = 0;
  for (const it of items) {
    let nm = safeName(it.name), full = path.join(dir, nm), k = 2;
    const ext = path.extname(nm), stem = nm.slice(0, nm.length - ext.length);
    while (fs.existsSync(full)) full = path.join(dir, `${stem} (${k++})${ext}`);
    fs.writeFileSync(full, Buffer.from(it.data)); count++;
  }
  return { dir: path.basename(dir), count };
});

// lists the files of a folder the user picked (nothing is read until the page asks for one file)
ipcMain.handle('file:openFolder', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { title: opts.title || 'Choose a folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const root = r.filePaths[0], exts = new Set((opts.exts || ['pdf']).map((x) => '.' + x.toLowerCase())), out = [];
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6 && out.length < 5000) walk(full, depth + 1); }
      else if (exts.has(path.extname(e.name).toLowerCase())) { try { const st = fs.statSync(full); out.push({ id: grant(full), name: e.name, rel: path.relative(root, full), size: st.size }); } catch {} }
    }
  };
  walk(root, 0);
  return { dir: path.basename(root), files: out };
});

ipcMain.handle('file:write', async (_e, id, data) => {
  fs.writeFileSync(pathOf(id), Buffer.from(data));
  return true;
});

ipcMain.handle('file:read', async (_e, id) => fs.readFileSync(pathOf(id)));

ipcMain.handle('app:info', () => ({ name: TITLE, version: app.getVersion() }));



app.whenReady().then(() => {
  // Hard network kill-switch: this app never talks to the internet.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_d, cb) => cb({ cancel: true }));
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(false));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
