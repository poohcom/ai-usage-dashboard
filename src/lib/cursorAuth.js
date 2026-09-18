'use strict';
// Cursor 로그인: IDE 딥링크(cursor://) 대신 PKCE loginDeepControl + poll.
// CLI/에이전트와 동일한 흐름 — 승인 후 api2.cursor.sh/auth/poll 로 JWT 수령.
const crypto = require('crypto');
const { request } = require('./http');
const { decodeJwt } = require('./creds');

const LOGIN_URL = 'https://cursor.com/loginDeepControl';
const POLL_URL = 'https://api2.cursor.sh/auth/poll';

const POLL_MAX = 120;
const POLL_BASE_MS = 1000;
const POLL_MAX_MS = 8000;
const POLL_BACKOFF = 1.25;
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
  return `${userId}::${accessToken}`;
}

function generateAuthParams() {
  const { verifier, challenge } = generatePKCE();
  const uuid = crypto.randomUUID();
  // redirectTarget=cli → 승인 후 IDE가 아니라 poll 로 토큰 전달 (데스크톱 앱 유도 최소화)
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
 * 로그인 승인될 때까지 poll. 404=대기, 200=토큰.
 * @returns {{ accessToken: string, refreshToken?: string }}
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
  throw new Error('Cursor login timed out — approve the sign-in in the login window');
}

module.exports = {
  generateAuthParams,
  pollAuth,
  cookieFromAccessToken,
  userIdFromJwt,
};
