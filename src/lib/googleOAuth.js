'use strict';
// Google OAuth (설치형 앱, 루프백 리디렉션) 로그인 + 토큰 저장/갱신.
// Antigravity 의 공개 OAuth 클라이언트를 사용해 Gemini(Code Assist) 쿼터 API 에 접근할 수 있는 토큰을 얻는다.
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
  try { fs.unlinkSync(storeFile(name)); } catch { /* 없음 */ }
}

async function exchange(client, params) {
  const body = new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...params }).toString();
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
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

/**
 * 시스템 브라우저로 Google 로그인 → 127.0.0.1 루프백으로 code 수신 → 토큰 교환.
 * 반환: { access_token, refresh_token, expiry_date, id_token, email }
 */
function login(client, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let done = false;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }
      const finish = (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
      try {
        if (u.searchParams.get('state') !== state) throw new Error(t('oauth.stateMismatch'));
        if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error'));
        const code = u.searchParams.get('code');
        if (!code) throw new Error(t('oauth.noCode'));
        const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
        const j = await exchange(client, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
        let email = null;
        try {
          const payload = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString('utf8'));
          email = payload.email || null;
        } catch { /* id_token 없음 */ }
        finish(`<html><body style="font-family:sans-serif;padding:40px"><h2>${t('oauth.doneTitle')}</h2><p>${t('oauth.doneBody')}</p></body></html>`);
        done = true;
        server.close();
        resolve({ access_token: j.access_token, refresh_token: j.refresh_token, expiry_date: Date.now() + (j.expires_in || 3600) * 1000, id_token: j.id_token, email });
      } catch (e) {
        finish(`<html><body style="font-family:sans-serif;padding:40px"><h2>${t('oauth.failTitle')}</h2><pre>${String(e.message).replace(/</g, '&lt;')}</pre></body></html>`);
        done = true;
        server.close();
        reject(e);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      shell.openExternal(url.toString());
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      server.close();
      reject(new Error(t('oauth.timeout')));
    }, timeoutMs);
  });
}

module.exports = { login, refresh, saveTokens, loadTokens, clearTokens, SCOPES };
