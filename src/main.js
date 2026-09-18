'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, shell } = require('electron');
const path = require('path');
const settings = require('./lib/settings');
const site = require('./lib/siteSession');
const i18n = require('./lib/i18n');
const { makeIcon } = require('./lib/icon');
const { providers, byId, meta, nameOf } = require('./providers');

app.setName('AI Usage Dashboard');
if (process.platform === 'win32') app.setAppUserModelId('com.poohc.ai-usage-dashboard');

let mainWindow = null;
let tray = null;
let timer = null;
let quitting = false;
const state = {}; // providerId -> 마지막 결과
const inflight = new Map();

function applyLanguage() {
  i18n.setLocale(settings.load().language, app.getLocale());
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function summarize(result) {
  if (!result || !result.ok || !result.windows) return null;
  return result.windows.reduce((m, w) => (w.kind !== 'share' && typeof w.usedPct === 'number' ? Math.max(m, w.usedPct) : m), 0);
}

function updateTray() {
  if (!tray) return;
  const parts = [];
  let worst = 0;
  for (const p of providers) {
    const r = state[p.id];
    if (!r) continue;
    if (r.ok) {
      const m = summarize(r);
      worst = Math.max(worst, m || 0);
      const first = r.windows.find((w) => typeof w.usedPct === 'number' && w.kind !== 'share');
      parts.push(`${nameOf(p)}: ${first ? first.usedPct + '%' : '-'}`);
    } else if (r.needsLogin) parts.push(`${nameOf(p)}: ${i18n.t('tray.needsLogin')}`);
  }
  tray.setToolTip([i18n.t('app.title'), ...parts].join('\n'));
  tray.setImage(makeIcon(process.platform === 'darwin' ? 22 : 32, worst / 100));
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: i18n.t('tray.open'), click: showMain },
    { label: i18n.t('tray.refresh'), click: () => refreshAll().catch(() => {}) },
    { type: 'separator' },
    { label: i18n.t('tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

async function refreshOne(id) {
  const p = byId[id];
  if (!p) return null;
  if (inflight.has(id)) return inflight.get(id);
  const task = (async () => {
    broadcast('provider:loading', { id });
    let result;
    try {
      result = await p.fetch();
    } catch (e) {
      result = { ok: false, needsLogin: !!e.needsLogin, error: e.message || String(e) };
    }
    result.fetchedAt = Date.now();
    state[id] = result;
    if (process.env.AIUSAGE_DEBUG) {
      const { raw, ...rest } = result;
      console.log(`[${id}]`, JSON.stringify(rest));
      if (process.env.AIUSAGE_DEBUG === '2') console.log(`[${id}] raw`, JSON.stringify(raw));
    }
    broadcast('provider:update', { id, result });
    updateTray();
    return result;
  })();
  inflight.set(id, task);
  try { return await task; } finally { inflight.delete(id); }
}

async function refreshAll() {
  const s = settings.load();
  const ids = providers.filter((p) => s.enabled[p.id] !== false).map((p) => p.id);
  await Promise.all(ids.map((id) => refreshOne(id)));
}

function schedule() {
  if (timer) clearInterval(timer);
  const sec = Math.max(60, Number(settings.load().refreshIntervalSec) || 300);
  timer = setInterval(() => { refreshAll().catch(() => {}); }, sec * 1000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 820, minWidth: 720, minHeight: 520,
    title: i18n.t('app.title'),
    backgroundColor: '#0b1020',
    icon: makeIcon(256),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url || '')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (e) => {
    // 창을 닫아도 트레이에 남겨 두고, 트레이 메뉴의 종료로만 완전히 종료
    if (!quitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

function createTray() {
  tray = new Tray(makeIcon(process.platform === 'darwin' ? 22 : 32));
  buildTrayMenu();
  tray.on('click', showMain);
  updateTray();
}

// ---- IPC ----
ipcMain.handle('providers:meta', () => meta());
ipcMain.handle('i18n:get', () => i18n.dictionary());
ipcMain.handle('state:get', () => ({ state, settings: settings.load() }));
ipcMain.handle('refresh:all', () => refreshAll());
ipcMain.handle('refresh:one', (_e, id) => refreshOne(id));
ipcMain.handle('login:open', async (_e, id) => {
  const p = byId[id];
  if (!p) return false;
  if (typeof p.login === 'function') {
    broadcast('provider:loading', { id });
    try { await p.login(); }
    catch (e) {
      const result = { ok: false, needsLogin: true, error: i18n.t('login.failed', { msg: e.message || e }), fetchedAt: Date.now() };
      state[id] = result;
      broadcast('provider:update', { id, result });
      return false;
    }
    refreshOne(id).catch(() => {});
    return true;
  }
  if (!p.loginUrl) return false;
  const opts = {};
  if (p.loginCookieName && p.loginCookieUrl) {
    opts.cookieName = p.loginCookieName;
    opts.cookieUrl = p.loginCookieUrl;
  }
  if (p.quietDeepLink) opts.quietDeepLink = true;
  site.openLogin(id, p.loginUrl, () => refreshOne(id).catch(() => {}), nameOf(p), opts);
  return true;
});
ipcMain.handle('login:clear', async (_e, id) => {
  const p = byId[id];
  if (p && typeof p.logout === 'function') { try { await p.logout(); } catch { /* 무시 */ } }
  await site.clearSession(id);
  delete state[id];
  broadcast('provider:update', { id, result: null });
  return true;
});
ipcMain.handle('settings:set', (_e, patch) => {
  const before = settings.load().language;
  const s = settings.save(patch || {});
  schedule();
  if (patch && patch.language !== undefined && patch.language !== before) {
    // 언어 변경: 번역된 문자열이 결과 안에 들어 있으므로 화면을 다시 띄우고 재조회
    applyLanguage();
    buildTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setTitle(i18n.t('app.title')); mainWindow.webContents.reload(); }
    refreshAll().catch(() => {});
  }
  return s;
});
ipcMain.handle('open:external', (_e, url) => {
  if (/^https?:\/\//i.test(url || '')) shell.openExternal(url);
});

// ---- lifecycle ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.whenReady().then(() => {
    applyLanguage();
    if (process.platform === 'darwin') app.dock.setIcon(makeIcon(256));
    createWindow();
    createTray();
    schedule();
    refreshAll().catch(() => {});
    if (process.env.AIUSAGE_SCREENSHOT) {
      // 디버그용: N초 뒤 메인 창을 캡처해 파일로 저장
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          require('fs').writeFileSync(process.env.AIUSAGE_SCREENSHOT, img.toPNG());
        } catch (e) { console.error('screenshot failed', e); }
      }, 20000);
    }
  });
  app.on('activate', showMain);
  app.on('before-quit', () => { quitting = true; site.destroyAll(); });
  app.on('window-all-closed', () => { /* 트레이 상주: 아무것도 하지 않음 */ });
}
