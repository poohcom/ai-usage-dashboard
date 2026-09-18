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

function isBenignUrl(url) {
  return !url
    || isHttpUrl(url)
    || url.startsWith('about:')
    || url.startsWith('blob:')
    || url.startsWith('data:')
    || url.startsWith('devtools:');
}

/** 앱 딥링크(cursor:// 등)만 true. 상대경로·http·about:blank 는 false */
function isAppDeepLink(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (isBenignUrl(u)) return false;
  // /path, ./x, ?q, #hash, javascript: void 등은 페이지 내부 동작
  if (u.startsWith('/') || u.startsWith('.') || u.startsWith('?') || u.startsWith('#') || u.startsWith('javascript:')) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(u);
}

function notifyDeepLinkBlocked(w, id, url, { quiet = false } = {}) {
  if (quiet) return;
  try {
    dialog.showMessageBox(w && !w.isDestroyed() ? w : undefined, {
      type: 'info',
      title: t('login.window', { name: id }),
      message: t('login.deepLinkBlocked'),
      detail: String(url || '').slice(0, 200),
    }).catch(() => {});
  } catch { /* 창이 이미 닫힘 */ }
}

/**
 * OAuth 팝업은 같은 partition 에서 열고, cursor:// 같은 앱 딥링크는 차단한다.
 * Google 로그인은 보통 window.open('about:blank') 후 리다이렉트하므로 about:blank 는 허용한다.
 */
function guardAuthWindow(w, id, { quietDeepLink = false } = {}) {
  const partition = partitionOf(id);
  let warned = false;
  const denyDeepLink = (event, url) => {
    if (!isAppDeepLink(url)) return;
    event.preventDefault();
    if (!warned) {
      warned = true;
      notifyDeepLinkBlocked(w, id, url, { quiet: quietDeepLink });
    }
  };

  const openHandler = ({ url }) => {
    // about:blank / 빈 URL = OAuth 팝업 관례. cursor:// 만 거부.
    if (isAppDeepLink(url)) {
      denyDeepLink({ preventDefault() {} }, url);
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

  // 세션 단위로 앱 딥링크만 취소 (OS 가 Cursor.exe 를 띄우기 전)
  try {
    const ses = w.webContents.session;
    if (!ses.__deepLinkFilter) {
      ses.__deepLinkFilter = true;
      ses.webRequest.onBeforeRequest((details, callback) => {
        const u = details.url || '';
        if (/^(cursor|vscode|antigravity):/i.test(u)) {
          callback({ cancel: true });
          return;
        }
        callback({});
      });
    }
  } catch { /* 일부 Electron 버전 */ }

  const attach = (contents) => {
    contents.setWindowOpenHandler(openHandler);
    contents.on('will-navigate', denyDeepLink);
    contents.on('will-redirect', denyDeepLink);
    contents.on('will-frame-navigate', (event, url) => denyDeepLink(event, url));
    // cursor:// 만 가로채기 — 상대경로/http 네비게이션은 절대 막지 않음 (Google 로그인 깨짐 방지)
    contents.on('dom-ready', () => {
      contents.executeJavaScript(`(() => {
        try {
          const isAppLink = (u) => {
            if (typeof u !== 'string') return false;
            const s = u.trim();
            if (!s) return false;
            if (/^https?:/i.test(s) || s.startsWith('about:') || s.startsWith('blob:') || s.startsWith('data:')) return false;
            if (s.startsWith('/') || s.startsWith('.') || s.startsWith('?') || s.startsWith('#') || s.startsWith('javascript:')) return false;
            return /^[a-z][a-z0-9+.-]*:/i.test(s);
          };
          const wrap = (obj, key) => {
            try {
              const desc = Object.getOwnPropertyDescriptor(obj, key);
              if (!desc || !desc.set) return;
              Object.defineProperty(obj, key, {
                configurable: true,
                enumerable: desc.enumerable,
                get: desc.get,
                set(v) { if (isAppLink(String(v))) return; return desc.set.call(this, v); },
              });
            } catch {}
          };
          wrap(window.Location.prototype, 'href');
          const assign = window.location.assign.bind(window.location);
          const replace = window.location.replace.bind(window.location);
          window.location.assign = (u) => { if (isAppLink(String(u))) return; return assign(u); };
          window.location.replace = (u) => { if (isAppLink(String(u))) return; return replace(u); };
          document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('a[href]');
            if (!a) return;
            const href = a.getAttribute('href') || '';
            if (isAppLink(href)) { e.preventDefault(); e.stopPropagation(); }
          }, true);
        } catch {}
      })()`, true).catch(() => {});
    });
  };

  attach(w.webContents);
  w.webContents.on('did-create-window', (child) => {
    attach(child.webContents);
    tuneSession(child.webContents.session);
  });
}

async function getHidden(id) {
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

function destroyHidden(id) {
  const h = hidden.get(id);
  if (h && !h.isDestroyed()) h.destroy();
  hidden.delete(id);
}

/**
 * 서비스 출처의 가벼운 페이지(robots.txt)를 숨김 창에 띄운 뒤 그 안에서 script 를 실행한다.
 * script 는 Promise 를 반환하는 표현식이어야 한다.
 */
async function runInSite(id, origin, script, { timeoutMs = 45000, page = '/robots.txt', forceReload = false } = {}) {
  const w = await getHidden(id);
  const url = origin + page;
  const current = w.webContents.getURL();
  const needLoad = forceReload || !current.startsWith(origin) || current === 'about:blank';
  if (needLoad) {
    await Promise.race([
      w.loadURL(url).catch((e) => { throw new Error(t('err.pageLoad', { msg: e.message || e })); }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(t('err.pageTimeout'))), timeoutMs)),
    ]);
  }
  // 네비게이션이 끝난 뒤에만 스크립트 실행 (Script failed 방지)
  if (w.webContents.isLoadingMainFrame && w.webContents.isLoadingMainFrame()) {
    await Promise.race([
      new Promise((resolve) => w.webContents.once('did-finish-load', resolve)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(t('err.pageTimeout'))), timeoutMs)),
    ]);
  }
  const title = w.webContents.getTitle() || '';
  if (/just a moment|attention required|access denied/i.test(title)) {
    const err = new Error(t('err.cloudflare'));
    err.needsLogin = true;
    throw err;
  }
  try {
    return await Promise.race([
      w.webContents.executeJavaScript(script, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error(t('err.reqTimeout'))), timeoutMs)),
    ]);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 컨텍스트가 죽은 경우 창을 버리고 한 번 재시도
    if (/script failed|context|destroyed|navigat/i.test(msg)) {
      destroyHidden(id);
      const w2 = await getHidden(id);
      await Promise.race([
        w2.loadURL(url).catch((err) => { throw new Error(t('err.pageLoad', { msg: err.message || err })); }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(t('err.pageTimeout'))), timeoutMs)),
      ]);
      return Promise.race([
        w2.webContents.executeJavaScript(script, true),
        new Promise((_, rej) => setTimeout(() => rej(new Error(t('err.reqTimeout'))), timeoutMs)),
      ]);
    }
    throw e;
  }
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

/**
 * 로그인 창. cookieName 이 세션에 생기면 자동으로 닫고 onClosed 호출.
 * quietDeepLink: cursor:// 차단 시 알림 생략 (PKCE poll 로그인은 승인 직후 딥링크가 흔함)
 */
function openLogin(id, url, onClosed, name, { cookieName = null, cookieUrl = null, quietDeepLink = false } = {}) {
  let w = loginWindows.get(id);
  if (w && !w.isDestroyed()) { w.focus(); return w; }
  const ses = getSession(id);
  w = new BrowserWindow({
    width: 1000, height: 820, title: t('login.window', { name: name || id }),
    autoHideMenuBar: true,
    webPreferences: { partition: partitionOf(id), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  loginWindows.set(id, w);
  guardAuthWindow(w, id, { quietDeepLink });

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (poll) clearInterval(poll);
    destroyHidden(id);
    if (onClosed) onClosed();
  };

  let poll = null;
  if (cookieName && cookieUrl) {
    poll = setInterval(async () => {
      try {
        const list = await ses.cookies.get({ url: cookieUrl, name: cookieName });
        if (list && list.length && list[0].value) {
          if (!w.isDestroyed()) w.close();
          else finish();
        }
      } catch { /* 무시 */ }
    }, 800);
  }

  w.loadURL(url);
  w.on('closed', () => {
    loginWindows.delete(id);
    finish();
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
  destroyHidden(id);
}

async function getCookie(id, { url, name }) {
  const ses = getSession(id);
  const list = await ses.cookies.get({ url, name });
  return list && list[0] ? list[0].value : null;
}

async function clearSession(id) {
  destroyHidden(id);
  const ses = getSession(id);
  await ses.clearStorageData();
  await ses.clearCache();
}

function closeLogin(id) {
  const w = loginWindows.get(id);
  if (w && !w.isDestroyed()) w.close();
}

/**
 * 시스템 브라우저에서 OAuth 할 때 쓰는 대기 창 (닫으면 onClosed).
 * Cursor PKCE 등 — Electron 안에서 loginDeepControl 을 열면 승인 완료가 깨질 수 있음.
 */
function openLoginWait(id, { title, message, detail, onClosed } = {}) {
  let w = loginWindows.get(id);
  if (w && !w.isDestroyed()) { w.focus(); return w; }
  const safe = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w = new BrowserWindow({
    width: 460,
    height: 240,
    title: title || t('login.window', { name: id }),
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  loginWindows.set(id, w);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Segoe UI,system-ui,sans-serif;margin:0;padding:28px 28px 20px;background:#111;color:#eee}
    h1{font-size:16px;font-weight:600;margin:0 0 10px}
    p{font-size:13px;line-height:1.45;margin:0 0 8px;color:#bbb}
    .d{font-size:12px;color:#888}
  </style></head><body>
    <h1>${safe(message || title)}</h1>
    <p>${safe(detail || '')}</p>
    <p class="d">${safe(t('cursor.loginWaitClose'))}</p>
  </body></html>`;
  w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  let settled = false;
  w.on('closed', () => {
    loginWindows.delete(id);
    if (settled) return;
    settled = true;
    if (onClosed) onClosed();
  });
  return w;
}

function destroyAll() {
  for (const w of hidden.values()) if (!w.isDestroyed()) w.destroy();
  hidden.clear();
  for (const w of loginWindows.values()) if (w && !w.isDestroyed()) w.destroy();
  loginWindows.clear();
}

module.exports = {
  runInSite, openLogin, openLoginWait, closeLogin, clearSession, destroyAll, PAGE_HELPERS,
  setCookie, getCookie, getSession, destroyHidden,
};
