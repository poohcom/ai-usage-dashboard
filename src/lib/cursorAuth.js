'use strict';
// Cursor 로그인: IDE 딥링크(cursor://) 대신 PKCE loginDeepControl + poll.
// CLI 와 동일 — 시스템 브라우저에서 승인 후 GET api2.cursor.sh/auth/poll 로 JWT 수령.
const crypto = require('crypto');
const { request } = require('./http');
const { decodeJwt } = require('./creds');

const LOGIN_URL = 'https://cursor.com/loginDeepControl';
const POLL_URL = 'https://api2.cursor.sh/auth/poll';

const POLL_MAX = 150;
const POLL_BASE_MS = 1000;
const POLL_MAX_MS = 10000;
const POLL_BACKOFF = 1.2;
const TERMINAL = new Set([400, 401, 403, 410]);

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function generatePKCE() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** JWT sub → WorkosCursorSessionToken 앞부분 (user_… ) */
function userIdFromJwt(jwt) {
  const payload = decodeJwt(jwt);
  if (!payload || payload.sub == null) return null;
  const sub = String(payload.sub);
  const pipe = sub.lastIndexOf('|');
  if (pipe >= 0) {
    const rest = sub.slice(pipe + 1);
    if (rest) return rest;
  }
  return sub;
}

function cookieFromAccessToken(accessToken) {
  const userId = userIdFromJwt(accessToken);
  if (!userId || !accessToken) return null;
  // jar/저장용은 :: 원문. Cookie 헤더는 호출측에서 %3A%3A 로 인코딩.
  return `${userId}::${accessToken}`;
}

function generateAuthParams() {
  const { verifier, challenge } = generatePKCE();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'cli',
  });
  return { verifier, challenge, uuid, loginUrl: `${LOGIN_URL}?${params}` };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 로그인 승인될 때까지 GET poll. 404=대기, 200=토큰.
 * (공개 CLI/SDK 구현과 동일 — POST 는 pending 404 와 혼동되기 쉬워 GET 사용)
 */
async function pollAuth(uuid, verifier, signal) {
  let delay = POLL_BASE_MS;
  let streak = 0;

  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(delay, signal);
    let res;
    try {
      const url = `${POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
      res = await request(url, { timeoutMs: 20000 });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      streak++;
      if (streak >= 5) throw new Error(`Cursor auth poll network error: ${e.message || e}`);
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
      continue;
    }

    if (res.status === 404) {
      streak = 0;
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
      continue;
    }
    if (res.ok && res.json && res.json.accessToken) {
      return {
        accessToken: res.json.accessToken,
        refreshToken: res.json.refreshToken || null,
      };
    }
    if (TERMINAL.has(res.status)) {
      const err = new Error(`Cursor login rejected (HTTP ${res.status})`);
      err.terminal = true;
      throw err;
    }
    streak++;
    if (streak >= 5) throw new Error(`Cursor auth poll failed: HTTP ${res.status}`);
    delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
  }
  throw new Error('Cursor login timed out — click Yes / Approve in the browser after signing in');
}

module.exports = {
  generateAuthParams,
  pollAuth,
  cookieFromAccessToken,
  userIdFromJwt,
};
