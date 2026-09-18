'use strict';
// Google OAuth (설치형 앱, 루프백 리디렉션) 로그인 + 토큰 저장/갱신.
// Antigravity 공개 OAuth 클라이언트는 고정 redirect 를 쓴다:
//   http://127.0.0.1:51121/oauth-callback
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, shell, safeStorage } = require('electron');
const { request } = require('./http');
const { t } = require('./i18n');

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/** Antigravity / Code Assist 가 요구하는 추가 스코프 */
const ANTIGRAVITY_SCOPES = [
  ...SCOPES,
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

const ANTIGRAVITY_REDIRECT = { port: 51121, path: '/oauth-callback' };

/** 진행 중 루프백 서버 — 재로그인/로그아웃 시 포트를 비운다 */
let activeServer = null;
let activeReject = null;

function closeServer(server) {
  if (!server) return;
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch { /* Node 버전 */ }
  try { server.close(); } catch { /* */ }
}

/** 진행 중 OAuth 리스너를 끊어 51121 등을 해제 (세션 삭제·재로그인 전) */
function cancelPendingLogin() {
  const reject = activeReject;
  const server = activeServer;
  activeReject = null;
  activeServer = null;
  closeServer(server);
  if (reject) {
    try {
      reject(Object.assign(new Error(t('oauth.cancelled')), { cancelled: true }));
    } catch { /* */ }
  }
}

function storeFile(name) { return path.join(app.getPath('userData'), `${name}.oauth`); }

function saveTokens(name, tokens) {
  const json = JSON.stringify(tokens);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
  fs.writeFileSync(storeFile(name), buf);
}

function loadTokens(name) {
  try {
    const buf = fs.readFileSync(storeFile(name));
    let json;
    try { json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'); }
    catch { json = buf.toString('utf8'); }
    return JSON.parse(json);
  } catch { return null; }
}

function clearTokens(name) {
  cancelPendingLogin();
  try { fs.unlinkSync(storeFile(name)); } catch { /* 없음 */ }
}

async function exchange(client, params) {
  const body = new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...params }).toString();
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'google-api-nodejs-client/9.15.1',
    },
    body,
  });
  if (!res.ok || !res.json || !res.json.access_token) {
    const msg = (res.json && (res.json.error_description || res.json.error)) || res.text || String(res.status);
    const err = new Error(t('oauth.tokenFail', { status: res.status, msg }));
    err.code = res.json && res.json.error;
    throw err;
  }
  return res.json;
}

/** refresh_token 으로 access_token 갱신 (Google 은 refresh_token 을 회전시키지 않음) */
async function refresh(client, tokens) {
  const j = await exchange(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  return {
    ...tokens,
    access_token: j.access_token,
    expiry_date: Date.now() + (j.expires_in || 3600) * 1000,
    id_token: j.id_token || tokens.id_token,
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.removeListener('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 시스템 브라우저로 Google 로그인 → 127.0.0.1 루프백으로 code 수신 → 토큰 교환.
 * options:
 *   redirectPort / redirectPath — Antigravity 는 51121 + /oauth-callback 고정
 *   scopes — 기본 SCOPES, Antigravity 는 ANTIGRAVITY_SCOPES
 */
async function login(client, {
  timeoutMs = 5 * 60 * 1000,
  redirectPort = 0,
  redirectPath = '/oauth2callback',
  scopes = SCOPES,
} = {}) {
  // 이전 시도가 포트를 붙잡고 있으면 먼저 해제
  cancelPendingLogin();
  // Windows 에서 close 직후 바인드가 바로 안 될 수 있어 짧게 대기
  if (redirectPort) await new Promise((r) => setTimeout(r, 150));

  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let done = false;
    let redirectUri = null;
    let timer = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (activeServer === server) activeServer = null;
      if (activeReject === finishErr) activeReject = null;
      closeServer(server);
    };

    const finishErr = (e) => {
      if (done) return;
      done = true;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== redirectPath) { res.writeHead(404); res.end(); return; }
      const finish = (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
      try {
        if (u.searchParams.get('state') !== state) throw new Error(t('oauth.stateMismatch'));
        if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error'));
        const code = u.searchParams.get('code');
        if (!code) throw new Error(t('oauth.noCode'));
        const j = await exchange(client, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        });
        let email = null;
        try {
          const payload = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString('utf8'));
          email = payload.email || null;
        } catch { /* id_token 없음 */ }
        if (!email && j.access_token) {
          try {
            const ui = await request('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
              headers: { Authorization: `Bearer ${j.access_token}`, 'User-Agent': 'google-api-nodejs-client/9.15.1' },
            });
            email = (ui.json && ui.json.email) || null;
          } catch { /* 무시 */ }
        }
        finish(`<html><body style="font-family:sans-serif;padding:40px"><h2>${t('oauth.doneTitle')}</h2><p>${t('oauth.doneBody')}</p></body></html>`);
        done = true;
        cleanup();
        resolve({
          access_token: j.access_token,
          refresh_token: j.refresh_token,
          expiry_date: Date.now() + (j.expires_in || 3600) * 1000,
          id_token: j.id_token,
          email,
        });
      } catch (e) {
        finish(`<html><body style="font-family:sans-serif;padding:40px"><h2>${t('oauth.failTitle')}</h2><pre>${String(e.message).replace(/</g, '&lt;')}</pre></body></html>`);
        finishErr(e);
      }
    });

    activeServer = server;
    activeReject = finishErr;

    listen(server, redirectPort, '127.0.0.1').then(() => {
      if (done) return;
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}${redirectPath}`;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      shell.openExternal(url.toString()).catch(() => {});
    }).catch((e) => {
      if (e && e.code === 'EADDRINUSE') {
        finishErr(new Error(t('oauth.portInUse', { port: redirectPort || '?' })));
      } else {
        finishErr(e);
      }
    });

    timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(t('oauth.timeout')));
    }, timeoutMs);
  });
}

/** Antigravity 고정 루프백으로 로그인 */
function loginAntigravity(client, opts = {}) {
  return login(client, {
    ...opts,
    redirectPort: ANTIGRAVITY_REDIRECT.port,
    redirectPath: ANTIGRAVITY_REDIRECT.path,
    scopes: ANTIGRAVITY_SCOPES,
  });
}

module.exports = {
  login,
  loginAntigravity,
  cancelPendingLogin,
  refresh,
  saveTokens,
  loadTokens,
  clearTokens,
  SCOPES,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_REDIRECT,
};
