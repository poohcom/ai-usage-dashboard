'use strict';
// 서비스별 영구 세션(partition)을 가진 숨김 BrowserWindow 안에서 fetch 를 실행한다.
// 실제 Chromium 컨텍스트에서 같은 출처(origin)로 요청하므로 쿠키/Cloudflare/CSRF 조건을 브라우저와 동일하게 충족한다.
const { BrowserWindow, session, dialog } = require('electron');
const { t } = require('./i18n');

const hidden = new Map();
const loginWindows = new Map();

function partitionOf(id) { return `persist:${id}`; }

function tuneSession(ses) {
  if (ses.__tuned) return;
  ses.__tuned = true;
  // Electron 흔적을 지운 일반 Chrome UA (Google 로그인 등이 Electron UA 를 거부하는 문제 회피)
  const ua = ses.getUserAgent().replace(/ Electron\/[\d.]+/, '').replace(/ ai-usage-dashboard\/[\d.]+/i, '');
  ses.setUserAgent(ua);
}

function getSession(id) {
  const ses = session.fromPartition(partitionOf(id));
  tuneSession(ses);
  return ses;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

/**
 * OAuth 팝업은 같은 partition 에서 열고, cursor:// 같은 앱 딥링크는 차단한다.
 * (딥링크를 허용하면 Cursor IDE 등이 떠서 웹 세션 쿠키가 이 앱에 안 남는다)
 */
function guardAuthWindow(w, id) {
  const partition = partitionOf(id);
  const denyDeepLink = (event, url) => {
    if (!url || isHttpUrl(url) || url.startsWith('about:') || url.startsWith('blob:') || url.startsWith('data:')) return;
    event.preventDefault();
    try {
      dialog.showMessageBox(w, {
        type: 'info',
        title: t('login.window', { name: id }),
        message: t('login.deepLinkBlocked'),
        detail: String(url).slice(0, 200),
      }).catch(() => {});
    } catch { /* 창이 이미 닫힘 */ }
  };

  const openHandler = ({ url }) => {
    if (!isHttpUrl(url)) {
      try {
        dialog.showMessageBox(w, {
          type: 'info',
          title: t('login.window', { name: id }),
          message: t('login.deepLinkBlocked'),
          detail: String(url).slice(0, 200),
        }).catch(() => {});
      } catch { /* */ }
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 920,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    };
  };

  w.webContents.setWindowOpenHandler(openHandler);
  w.webContents.on('will-navigate', denyDeepLink);
  w.webContents.on('will-redirect', denyDeepLink);
  w.webContents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(openHandler);
    child.webContents.on('will-navigate', denyDeepLink);
    child.webContents.on('will-redirect', denyDeepLink);
    tuneSession(child.webContents.session);
  });
}

async function getHidden(id, origin) {
  let w = hidden.get(id);
  if (w && !w.isDestroyed()) return w;
  getSession(id);
  w = new BrowserWindow({
    show: false,
    webPreferences: { partition: partitionOf(id), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  w.webContents.setAudioMuted(true);
  hidden.set(id, w);
  return w;
}

/**
 * 서비스 출처의 가벼운 페이지(robots.txt)를 숨김 창에 띄운 뒤 그 안에서 script 를 실행한다.
 * script 는 Promise 를 반환하는 표현식이어야 한다.
 */
async function runInSite(id, origin, script, { timeoutMs = 45000, page = '/robots.txt' } = {}) {
  const w = await getHidden(id, origin);
  const url = origin + page;
  const current = w.webContents.getURL();
  if (!current.startsWith(origin)) {
    await Promise.race([
      w.loadURL(url).catch((e) => { throw new Error(t('err.pageLoad', { msg: e.message || e })); }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(t('err.pageTimeout'))), timeoutMs)),
    ]);
  }
  const title = w.webContents.getTitle() || '';
  if (/just a moment|attention required|access denied/i.test(title)) {
    const err = new Error(t('err.cloudflare'));
    err.needsLogin = true;
    throw err;
  }
  return Promise.race([
    w.webContents.executeJavaScript(script, true),
    new Promise((_, rej) => setTimeout(() => rej(new Error(t('err.reqTimeout'))), timeoutMs)),
  ]);
}

/** 페이지 안에서 쓸 공통 헬퍼: 같은 출처 fetch → {status, json|text} */
const PAGE_HELPERS = `
  const __req = async (url, init) => {
    const res = await fetch(url, Object.assign({ credentials: 'include' }, init || {}));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, text: json ? undefined : text.slice(0, 2000) };
  };
`;

function openLogin(id, url, onClosed, name) {
  let w = loginWindows.get(id);
  if (w && !w.isDestroyed()) { w.focus(); return w; }
  getSession(id);
  w = new BrowserWindow({
    width: 1000, height: 820, title: t('login.window', { name: name || id }),
    autoHideMenuBar: true,
    webPreferences: { partition: partitionOf(id), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  loginWindows.set(id, w);
  guardAuthWindow(w, id);
  w.loadURL(url);
  w.on('closed', () => {
    loginWindows.delete(id);
    // 숨김 창은 이전 상태를 캐시하고 있을 수 있으므로 버린다
    const h = hidden.get(id);
    if (h && !h.isDestroyed()) h.destroy();
    hidden.delete(id);
    if (onClosed) onClosed();
  });
  return w;
}

/**
 * Electron 세션에 httpOnly 쿠키를 심는다 (Cursor IDE 로컬 토큰 → 웹 API 용).
 */
async function setCookie(id, { url, name, value, expirationDate }) {
  const ses = getSession(id);
  await ses.cookies.set({
    url,
    name,
    value,
    expirationDate: expirationDate || Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    httpOnly: true,
    secure: true,
    sameSite: 'no_restriction',
  });
  const h = hidden.get(id);
  if (h && !h.isDestroyed()) { h.destroy(); hidden.delete(id); }
}

async function clearSession(id) {
  const h = hidden.get(id);
  if (h && !h.isDestroyed()) h.destroy();
  hidden.delete(id);
  const ses = getSession(id);
  await ses.clearStorageData();
  await ses.clearCache();
}

function destroyAll() {
  for (const w of hidden.values()) if (!w.isDestroyed()) w.destroy();
  hidden.clear();
}

module.exports = { runInSite, openLogin, clearSession, destroyAll, PAGE_HELPERS, setCookie, getSession };
