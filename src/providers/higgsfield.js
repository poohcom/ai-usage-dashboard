'use strict';
// Higgsfield: Clerk 세션(JWT) → fnf.higgsfield.ai /user · /workspaces/wallet
const { request, toMs, clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const { decodeJwt } = require('../lib/creds');
const { t } = require('../lib/i18n');

const ORIGIN = 'https://higgsfield.ai';
const FNF = 'https://fnf.higgsfield.ai';
const CLERK = 'https://clerk.higgsfield.ai';

function num(v) {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function jwtFresh(token) {
  const p = decodeJwt(token);
  if (!p || typeof p.exp !== 'number') return !!token;
  return Date.now() < p.exp * 1000 - 5000;
}

async function cookieValue(url, name) {
  try {
    return await site.getCookie('higgsfield', { url, name });
  } catch {
    return null;
  }
}

async function findCookie(name, urls) {
  for (const url of urls) {
    const v = await cookieValue(url, name);
    if (v) return v;
  }
  // 도메인 전체 스캔
  try {
    const ses = site.getSession('higgsfield');
    const all = await ses.cookies.get({});
    const hit = all.find((c) => c.name === name && /higgsfield/i.test(c.domain || ''));
    if (hit && hit.value) return hit.value;
  } catch { /* */ }
  return null;
}

/** Electron 세션 쿠키에서 Clerk JWT 확보 (만료 시 __client 로 갱신) */
async function getClerkJwt() {
  const sessionJwt = await findCookie('__session', [
    ORIGIN, `${ORIGIN}/`, 'https://www.higgsfield.ai', CLERK,
  ]);
  if (sessionJwt && sessionJwt.startsWith('eyJ') && jwtFresh(sessionJwt)) return sessionJwt;

  let sessionId = null;
  if (sessionJwt && sessionJwt.startsWith('eyJ')) {
    const p = decodeJwt(sessionJwt);
    sessionId = p && p.sid ? String(p.sid) : null;
  }
  const active = await findCookie('clerk_active_context', [ORIGIN, CLERK]);
  if (!sessionId && active) sessionId = String(active).replace(/:+$/, '').split(':')[0];

  const client = await findCookie('__client', [CLERK, ORIGIN]);
  if (client && sessionId) {
    try {
      const r = await request(`${CLERK}/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens`, {
        method: 'POST',
        headers: {
          Cookie: `__client=${client}`,
          Origin: ORIGIN,
          Referer: `${ORIGIN}/`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: '',
        timeoutMs: 15000,
      });
      const jwt = r.json && (r.json.jwt || r.json.token);
      if (jwt && String(jwt).startsWith('eyJ')) return String(jwt);
    } catch { /* fall through */ }
  }
  if (sessionJwt && sessionJwt.startsWith('eyJ')) return sessionJwt; // 만료여도 한번 시도
  return null;
}

function parseUser(json) {
  if (!json || typeof json !== 'object') return { windows: [], extra: [], account: null, plan: null };
  const windows = [];
  const extra = [];
  const sub = num(json.subscription_credits);
  const pack = num(json.package_credits);
  const daily = num(json.daily_credits);
  const totalPlan = num(json.total_plan_credits);
  if (sub != null) {
    windows.push({
      key: 'sub',
      label: t('higgsfield.subCredits'),
      usedPct: totalPlan != null && totalPlan > 0 ? clampPct(((totalPlan - sub) / totalPlan) * 100) : null,
      resetAt: toMs(json.plan_ends_at),
      detail: totalPlan != null ? t('p.remainingOf', { n: sub, total: totalPlan }) : t('p.remaining', { n: sub }),
    });
  }
  if (pack != null && pack > 0) {
    windows.push({ key: 'pack', label: t('higgsfield.packCredits'), usedPct: null, resetAt: null, detail: t('p.remaining', { n: pack }) });
  }
  if (daily != null && daily > 0) {
    windows.push({ key: 'daily', label: t('higgsfield.dailyCredits'), usedPct: null, resetAt: null, detail: t('p.remaining', { n: daily }) });
  }
  const extras = [
    ['soul_credits', 'higgsfield.soulCredits'],
    ['face_swap_credits', 'higgsfield.faceSwap'],
    ['character_swap_credits', 'higgsfield.charSwap'],
    ['wan2_5_video_credits', 'higgsfield.wanVideo'],
    ['text2keyframes_credits', 'higgsfield.keyframes'],
    ['qwen_camera_control_credits', 'higgsfield.camera'],
  ];
  for (const [field, labelKey] of extras) {
    const v = num(json[field]);
    if (v != null && v > 0) {
      windows.push({ key: field, label: t(labelKey), usedPct: null, resetAt: null, detail: t('p.remaining', { n: v }) });
    }
  }
  const account = json.email || json.username || json.name || null;
  // user 응답에 email 이 없을 수 있음 — id 만 있으면 생략
  const plan = json.plan_type || json.plan || null;
  if (json.billing_period) extra.push({ label: t('higgsfield.billing'), value: String(json.billing_period) });
  if (json.has_unlim) extra.push({ label: t('higgsfield.unlimited'), value: t('cursor.yes') });
  return { windows, extra, account, plan };
}

function parseWallet(json) {
  if (!json || typeof json !== 'object') return [];
  const windows = [];
  // subscription_balance / credits_balance 는 센티크레딧(÷100)인 경우가 많음
  const subBal = num(json.subscription_balance);
  const credBal = num(json.credits_balance);
  const total = num(json.total_credits);
  const asDisplay = (v) => (v != null && v >= 100 && Number.isInteger(v) ? v / 100 : v);

  if (subBal != null) {
    const rem = asDisplay(subBal);
    windows.push({
      key: 'wallet-sub',
      label: t('higgsfield.subCredits'),
      usedPct: null,
      resetAt: null,
      detail: t('p.remaining', { n: rem }),
    });
  }
  if (credBal != null && credBal > 0) {
    windows.push({
      key: 'wallet-pack',
      label: t('higgsfield.packCredits'),
      usedPct: null,
      resetAt: null,
      detail: t('p.remaining', { n: asDisplay(credBal) }),
    });
  }
  if (total != null && windows.length === 0) {
    windows.push({
      key: 'wallet-total',
      label: t('higgsfield.credits'),
      usedPct: null,
      resetAt: null,
      detail: t('p.remaining', { n: asDisplay(total) }),
    });
  }
  // ProfileCredits 형태
  const avail = num(json.totalAvailableCredits ?? json.availableCredits ?? json.total_available_credits);
  if (avail != null && !windows.length) {
    windows.push({ key: 'avail', label: t('higgsfield.credits'), usedPct: null, resetAt: null, detail: t('p.remaining', { n: avail }) });
  }
  return windows;
}

async function fetchWithBearer(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  const user = await request(`${FNF}/user`, { headers });
  if (user.status === 401 || user.status === 403) {
    return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'higgsfield.ai' }), raw: { status: user.status } };
  }
  if (!user.ok || !user.json) {
    return { ok: false, error: t('p.parseFailStatus', { info: `user ${user.status}` }), raw: user.json || user.text };
  }

  let wallet = null;
  try {
    const w = await request(`${FNF}/workspaces/wallet`, { headers });
    if (w.ok) wallet = w.json;
  } catch { /* optional */ }

  let freeGens = null;
  try {
    const f = await request(`${FNF}/user/free-gens`, { headers });
    if (f.ok) freeGens = f.json;
  } catch { /* optional */ }

  const fromUser = parseUser(user.json);
  let windows = fromUser.windows.length ? fromUser.windows : parseWallet(wallet);
  if (!windows.length && wallet) windows = parseWallet(wallet);

  // free-gens: { model: count } 형태면 섹션으로
  if (freeGens && typeof freeGens === 'object') {
    const entries = Object.entries(freeGens).filter(([, v]) => num(v) != null).slice(0, 8);
    if (entries.length) {
      windows.push({ key: 'fg', kind: 'section', label: t('higgsfield.freeGens'), usedPct: null, resetAt: null });
      for (const [k, v] of entries) {
        windows.push({ key: `fg:${k}`, label: k, usedPct: null, resetAt: null, detail: t('p.remaining', { n: num(v) }) });
      }
    }
  }

  if (!windows.length) {
    return {
      ok: false,
      error: t('p.noWindows'),
      raw: { user: user.json, wallet, freeGens },
    };
  }

  return {
    ok: true,
    source: t('higgsfield.src'),
    account: fromUser.account,
    plan: fromUser.plan ? String(fromUser.plan).toUpperCase() : null,
    windows,
    extra: fromUser.extra,
    raw: { user: user.json, wallet, freeGens },
  };
}

/** 페이지 안 Clerk.getToken() 폴백 (쿠키 JWT 가 httpOnly/만료일 때) */
async function viaPageClerk() {
  site.destroyHidden('higgsfield');
  const script = `${site.PAGE_HELPERS}
    (async () => {
      let token = null;
      try {
        if (window.Clerk) {
          if (typeof window.Clerk.load === 'function') await window.Clerk.load();
          const sess = window.Clerk.session || (window.Clerk.client && window.Clerk.client.activeSessions && window.Clerk.client.activeSessions[0]);
          if (sess && typeof sess.getToken === 'function') token = await sess.getToken();
        }
      } catch (e) {}
      if (!token) {
        try {
          const m = document.cookie.match(/(?:^|;\\s*)__session=([^;]+)/);
          if (m) token = decodeURIComponent(m[1]);
        } catch {}
      }
      if (!token) return { needsLogin: true };
      const h = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
      const user = await fetch('${FNF}/user', { headers: h }).then(async (r) => ({ status: r.status, ok: r.ok, json: await r.json().catch(() => null) }));
      if (user.status === 401 || user.status === 403) return { needsLogin: true, status: user.status };
      const wallet = await fetch('${FNF}/workspaces/wallet', { headers: h }).then(async (r) => ({ status: r.status, ok: r.ok, json: await r.json().catch(() => null) })).catch(() => null);
      const freeGens = await fetch('${FNF}/user/free-gens', { headers: h }).then(async (r) => ({ status: r.status, ok: r.ok, json: await r.json().catch(() => null) })).catch(() => null);
      return { ok: true, token, user, wallet, freeGens };
    })()`;
  const r = await site.runInSite('higgsfield', ORIGIN, script, { page: '/', forceReload: true, timeoutMs: 60000 });
  if (r.needsLogin) return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'higgsfield.ai' }) };
  if (r.token) {
    // 쿠키 경로와 동일 파서로 맞춤
    const fake = await fetchWithBearer(r.token);
    return fake;
  }
  return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'higgsfield.ai' }), raw: r };
}

module.exports = {
  id: 'higgsfield',
  nameKey: 'higgsfield.name',
  color: '#ec4899',
  loginUrl: 'https://higgsfield.ai/',
  hintKey: 'higgsfield.hint',
  async fetch() {
    const notes = [];
    try {
      const jwt = await getClerkJwt();
      if (jwt) {
        const r = await fetchWithBearer(jwt);
        if (r.ok) return r;
        if (r.needsLogin) notes.push('jwt-auth-failed');
        else if (r.error) notes.push(r.error);
      } else {
        notes.push('no-clerk-jwt');
      }
    } catch (e) {
      notes.push(e.message || String(e));
    }

    try {
      const page = await viaPageClerk();
      if (page.ok) return page;
      if (page.needsLogin) {
        return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'higgsfield.ai' }), raw: { notes } };
      }
      if (notes.length && page.error) page.error = `${page.error} (${notes.join('; ')})`;
      return page;
    } catch (e) {
      return {
        ok: false,
        needsLogin: /login|401|403|로그인/i.test(e.message || ''),
        error: `${e.message || e}${notes.length ? ` (${notes.join('; ')})` : ''}`,
      };
    }
  },
};
