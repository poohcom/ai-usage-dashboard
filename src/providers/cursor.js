'use strict';
// Cursor: ① Cursor IDE/agent 로컬 토큰 ② PKCE 로그인(poll) 세션 쿠키 ③ 숨김 창 스크립트
//   /api/usage-summary · /api/dashboard/get-sand-usage-status · get-aggregated-usage-events
const creds = require('../lib/creds');
const cursorAuth = require('../lib/cursorAuth');
const { request, toMs, clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const { t } = require('../lib/i18n');

const ORIGIN = 'https://cursor.com';
const COOKIE = 'WorkosCursorSessionToken';

function num(v) {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}
const usd = (cents) => (cents == null ? '?' : `$${(cents / 100).toFixed(2)}`);
const tok = (n) => (n == null ? '0' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n));

function parseSummary(json) {
  const windows = [], extra = [];
  if (!json || typeof json !== 'object') return { windows, extra };
  const cycleEnd = toMs(json.billingCycleEnd);
  const plan = json.individualUsage && json.individualUsage.plan;
  if (plan && typeof plan === 'object') {
    const used = num(plan.used), limit = num(plan.limit);
    const bd = plan.breakdown || {};
    if (num(plan.autoPercentUsed) != null) {
      windows.push({ key: 'auto', label: t('cursor.auto'), usedPct: clampPct(plan.autoPercentUsed), resetAt: cycleEnd, detail: json.autoModelSelectedDisplayMessage || '' });
    }
    if (num(plan.apiPercentUsed) != null) {
      windows.push({ key: 'api', label: t('cursor.api'), usedPct: clampPct(plan.apiPercentUsed), resetAt: cycleEnd, detail: limit != null ? `${usd(used)} / ${usd(limit)}` : json.namedModelSelectedDisplayMessage || '' });
    }
    if (num(plan.totalPercentUsed) != null) {
      const parts = [];
      if (num(bd.included) != null) parts.push(t('cursor.included', { v: usd(bd.included) }));
      if (num(bd.bonus) != null && bd.bonus > 0) parts.push(t('cursor.bonus', { v: usd(bd.bonus) }));
      if (num(bd.total) != null) parts.push(t('cursor.sum', { v: usd(bd.total) }));
      windows.push({ key: 'total', label: t('cursor.total'), usedPct: clampPct(plan.totalPercentUsed), resetAt: cycleEnd, detail: parts.join(' · ') });
    }
    if (!windows.length && (used != null || limit != null)) {
      windows.push({ key: 'plan', label: t('cursor.plan'), usedPct: limit ? clampPct((used / limit) * 100) : null, resetAt: cycleEnd, detail: `${usd(used)} / ${limit != null ? usd(limit) : t('cursor.unlimited')}` });
    }
  }
  const od = json.individualUsage && json.individualUsage.onDemand;
  if (od && od.enabled) {
    const used = num(od.used), limit = num(od.limit);
    windows.push({ key: 'ondemand', label: t('cursor.onDemand'), usedPct: limit ? clampPct((used / limit) * 100) : null, resetAt: cycleEnd, detail: `${usd(used)} / ${limit != null ? usd(limit) : t('cursor.noLimit')}` });
  }
  if (json.membershipType) extra.push({ label: t('p.plan'), value: String(json.membershipType) });
  if (json.isUnlimited) extra.push({ label: t('cursor.unlimited'), value: t('cursor.yes') });
  return { windows, extra };
}

function parseSand(json) {
  if (!json || typeof json !== 'object' || num(json.usagePercent) == null) return null;
  return {
    key: 'grokbot', label: t('cursor.grokWeekly', { label: json.grokPlanLabel || 'Grok Bot' }),
    usedPct: clampPct(json.usagePercent), resetAt: toMs(json.nextResetTimestampUtc), detail: '',
  };
}

function parseAggregated(json) {
  const rows = Array.isArray(json && json.aggregations) ? json.aggregations : [];
  const total = num(json && json.totalCostCents) || rows.reduce((s, r) => s + (num(r.totalCents) || 0), 0);
  return rows
    .map((r) => ({ model: r.modelIntent || 'unknown', cents: num(r.totalCents) || 0, inTok: num(r.inputTokens) || 0, outTok: num(r.outputTokens) || 0, cacheTok: (num(r.cacheReadTokens) || 0) + (num(r.cacheWriteTokens) || 0) }))
    .sort((a, b) => b.cents - a.cents)
    .map((r) => ({
      key: `model:${r.model}`, kind: 'share',
      label: r.model === 'default' ? 'Auto (default)' : r.model,
      usedPct: total ? clampPct((r.cents / total) * 100) : null,
      resetAt: null,
      detail: t('cursor.tokens', { cost: usd(r.cents), i: tok(r.inTok), o: tok(r.outTok) }) + (r.cacheTok ? t('cursor.cache', { c: tok(r.cacheTok) }) : ''),
    }));
}

function assemble(me, summary, sand, agg, source) {
  let windows = [], extra = [];
  if (summary) ({ windows, extra } = parseSummary(summary));
  const sandWin = sand ? parseSand(sand) : null;
  if (sandWin) windows.push(sandWin);
  const models = agg ? parseAggregated(agg) : [];
  if (models.length) {
    windows.push({ key: 'sep', kind: 'section', label: t('cursor.models'), usedPct: null, resetAt: null });
    windows.push(...models);
    const total = num(agg.totalCostCents);
    if (total != null) extra.push({ label: t('cursor.cycleCost'), value: usd(total) });
  }
  if (!windows.length) return null;
  return {
    ok: true,
    source,
    account: me && me.email ? me.email : null,
    plan: summary && summary.membershipType ? String(summary.membershipType).toUpperCase() : null,
    windows, extra,
    raw: { summary, sand, aggregated: agg },
  };
}

/** raw → JWT 와 후보 user id 목록 */
function splitCookieParts(raw) {
  if (!raw) return { jwt: null, ids: [] };
  let jwt = raw;
  const ids = [];
  const push = (id) => {
    if (!id) return;
    const s = String(id);
    if (!ids.includes(s)) ids.push(s);
  };
  if (/%3A%3A/i.test(raw)) {
    const i = raw.search(/%3A%3A/i);
    push(decodeURIComponent(raw.slice(0, i)));
    jwt = raw.slice(i).replace(/^%3A%3A/i, '');
  } else if (raw.includes('::')) {
    const i = raw.indexOf('::');
    push(raw.slice(0, i));
    jwt = raw.slice(i + 2);
  }
  const payload = creds.decodeJwt(jwt);
  if (payload && payload.sub != null) {
    const full = String(payload.sub);
    push(full);
    push(cursorAuth.userIdFromJwt(jwt));
  }
  return { jwt, ids: ids.filter(Boolean), payload };
}

/**
 * WorkosCursorSessionToken 후보들.
 * auth/me 는 sub::jwt 형태. bare JWT / 잘못된 id 는 204.
 * %3A%3A 인코딩·원문 :: · full sub / user_… 모두 시도.
 */
function cookieHeaderVariants(raw) {
  const { jwt, ids } = splitCookieParts(raw);
  if (!jwt) return [];
  const out = [];
  const add = (v) => { if (v && !out.includes(v)) out.push(v); };
  for (const id of ids) {
    add(`${id}%3A%3A${jwt}`);
    add(`${id}::${jwt}`);
    if (/[^A-Za-z0-9_.-]/.test(id)) {
      add(`${encodeURIComponent(id)}%3A%3A${jwt}`);
      add(`${encodeURIComponent(id)}::${jwt}`);
    }
  }
  if (/%3A%3A/i.test(raw) || raw.includes('::')) {
    add(cookieHeaderValue(raw));
    // jar 에 인코딩돼 저장된 값을 디코드해 원문도 시도
    try {
      if (/%3A%3A/i.test(raw)) add(decodeURIComponent(raw));
    } catch { /* */ }
  }
  return out;
}

function cookieHeaderValue(raw) {
  if (!raw) return null;
  if (raw.includes('%3A%3A') || raw.includes('%3a%3a')) return raw;
  if (raw.includes('::')) {
    const i = raw.indexOf('::');
    return `${raw.slice(0, i)}%3A%3A${raw.slice(i + 2)}`;
  }
  const payload = creds.decodeJwt(raw);
  if (payload && payload.sub) {
    const uid = cursorAuth.userIdFromJwt(raw) || payload.sub;
    return `${uid}%3A%3A${raw}`;
  }
  return raw;
}

function cookieStorageValue(accessToken) {
  // Electron 쿠키 jar 에는 :: 원문 저장 (브라우저 DevTools 와 동일)
  const uid = cursorAuth.userIdFromJwt(accessToken);
  if (!uid || !accessToken) return null;
  return `${uid}::${accessToken}`;
}

function isUsableSessionJwt(payload) {
  if (!payload || !payload.sub) return false;
  // type 이 있으면 session 이어야 웹 쿠키로 쓸 수 있음. 없으면 aud 로 완화.
  if (payload.type && payload.type !== 'session') return false;
  if (payload.aud) {
    const aud = Array.isArray(payload.aud) ? payload.aud.join(' ') : String(payload.aud);
    if (aud && !/cursor\.com/i.test(aud)) return false;
  }
  return true;
}

async function fetchWithCookie(rawCookie, source) {
  const variants = cookieHeaderVariants(rawCookie);
  if (!variants.length) return { skipped: 'no cookie' };
  const baseHeaders = {
    Origin: ORIGIN,
    Referer: `${ORIGIN}/dashboard`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json',
  };

  let lastSkip = null;
  for (const encoded of variants) {
    const headers = { ...baseHeaders, Cookie: `${COOKIE}=${encoded}` };
    const me = await request(`${ORIGIN}/api/auth/me`, { headers });
    // 204 = bare/잘못된 쿠키 형식. 다음 후보 시도.
    if (me.status === 204 || me.status === 404) {
      lastSkip = `auth/me ${me.status}`;
      continue;
    }
    if (me.status === 401 || me.status === 403) {
      lastSkip = `auth/me ${me.status}`;
      continue;
    }

    const summary = await request(`${ORIGIN}/api/usage-summary`, { headers });
    if (summary.status === 401 || summary.status === 403) {
      lastSkip = `usage-summary ${summary.status}`;
      continue;
    }
    // auth/me 가 비어 있어도 usage-summary 가 오면 성공으로 처리
    if (!summary.json && !(me.json && me.status === 200)) {
      lastSkip = `auth/me ${me.status} (no usage)`;
      continue;
    }

    let start = Date.now() - 30 * 86400000, end = Date.now();
    if (summary.json) {
      const s = Date.parse(summary.json.billingCycleStart), e = Date.parse(summary.json.billingCycleEnd);
      if (s) start = s; if (e) end = e;
    }
    const postHeaders = { ...headers, 'Content-Type': 'application/json' };
    let sand = null, agg = null;
    const userId = me.json && (me.json.id != null ? me.json.id : null);
    try {
      const r = await request(`${ORIGIN}/api/dashboard/get-sand-usage-status`, { method: 'POST', headers: postHeaders, body: '{}' });
      if (r.ok) sand = r.json;
    } catch { /* 선택 */ }
    try {
      const body = { teamId: 0, startDate: String(start), endDate: String(end) };
      if (userId != null) body.userId = userId;
      const r = await request(`${ORIGIN}/api/dashboard/get-aggregated-usage-events`, {
        method: 'POST', headers: postHeaders, body: JSON.stringify(body),
      });
      if (r.ok) agg = r.json;
    } catch { /* 선택 */ }

    const result = assemble(me.json || {}, summary.json, sand, agg, source);
    if (!result) {
      lastSkip = t('p.noWindows');
      continue;
    }
    return result;
  }
  return { skipped: lastSkip || 'auth/me failed' };
}

/** partition 쿠키 jar + session.fetch (수동 Cookie 헤더보다 브라우저와 동일) */
async function fetchWithSessionJar(source) {
  const raw = await site.getCookie('cursor', { url: ORIGIN, name: COOKIE });
  if (!raw) return { skipped: t('p.needsLogin', { site: 'cursor.com' }) };
  // jar 값이 인코딩/비인코딩 어느 쪽이든 후보를 다시 심어 본다
  const variants = cookieHeaderVariants(raw);
  for (const v of variants.slice(0, 4)) {
    const store = /%3A%3A/i.test(v) ? (() => { try { return decodeURIComponent(v); } catch { return v; } })() : v;
    try {
      await site.setCookie('cursor', { url: ORIGIN, name: COOKIE, value: store });
    } catch { /* */ }
    try {
      const me = await site.requestInSession('cursor', `${ORIGIN}/api/auth/me`, {
        headers: {
          Accept: 'application/json',
          Origin: ORIGIN,
          Referer: `${ORIGIN}/dashboard`,
        },
        timeoutMs: 30000,
      });
      if (me.status === 204 || me.status === 404 || me.status === 401 || me.status === 403) continue;
      const summary = await site.requestInSession('cursor', `${ORIGIN}/api/usage-summary`, {
        headers: {
          Accept: 'application/json',
          Origin: ORIGIN,
          Referer: `${ORIGIN}/dashboard`,
        },
        timeoutMs: 30000,
      });
      if (summary.status === 401 || summary.status === 403) continue;
      if (!summary.json && !(me.json && me.status === 200)) continue;
      let sand = null, agg = null;
      let start = Date.now() - 30 * 86400000, end = Date.now();
      if (summary.json) {
        const s = Date.parse(summary.json.billingCycleStart), e = Date.parse(summary.json.billingCycleEnd);
        if (s) start = s; if (e) end = e;
      }
      const userId = me.json && (me.json.id != null ? me.json.id : null);
      try {
        const r = await site.requestInSession('cursor', `${ORIGIN}/api/dashboard/get-sand-usage-status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Referer: `${ORIGIN}/dashboard` },
          body: '{}',
        });
        if (r.ok) sand = r.json;
      } catch { /* */ }
      try {
        const body = { teamId: 0, startDate: String(start), endDate: String(end) };
        if (userId != null) body.userId = userId;
        const r = await site.requestInSession('cursor', `${ORIGIN}/api/dashboard/get-aggregated-usage-events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Referer: `${ORIGIN}/dashboard` },
          body,
        });
        if (r.ok) agg = r.json;
      } catch { /* */ }
      const result = assemble(me.json || {}, summary.json, sand, agg, source);
      if (result) return result;
    } catch { /* 다음 변형 */ }
  }
  // session.fetch 실패 시 기존 수동 Cookie 경로
  return fetchWithCookie(raw, source);
}

async function viaIdeToken() {
  const tok = creds.cursorIdeToken();
  if (!tok) return { skipped: t('p.noCreds', { cli: 'Cursor IDE' }) };
  const result = await fetchWithCookie(tok.cookie, t(tok.sourceKey || 'cursor.srcIde'));
  if (result.ok) {
    try {
      await site.setCookie('cursor', { url: ORIGIN, name: COOKIE, value: tok.cookie });
    } catch { /* 무시 */ }
  }
  return result;
}

async function viaSessionCookie() {
  const raw = await site.getCookie('cursor', { url: ORIGIN, name: COOKIE });
  if (!raw) return { skipped: t('p.needsLogin', { site: 'cursor.com' }) };
  return fetchWithCookie(raw, t('cursor.src'));
}

/**
 * PKCE: 시스템 브라우저에서 로그인 + Yes/Approve → poll 로 JWT → 세션 쿠키.
 * Electron 안 cursor.com 로드는 Cloudflare/지연으로 "페이지 로드 시간 초과"가 자주 나서 쓰지 않음.
 */
async function loginPkce() {
  const { shell } = require('electron');
  const { verifier, uuid, loginUrl } = cursorAuth.generateAuthParams();
  const ac = new AbortController();
  let finished = false;
  site.openLoginWait('cursor', {
    title: t('login.window', { name: t('cursor.name') }),
    message: t('cursor.loginWaiting'),
    detail: t('cursor.loginWaitingDetail'),
    onClosed: () => {
      if (finished) return;
      try { ac.abort(); } catch { /* */ }
    },
  });
  try {
    await shell.openExternal(loginUrl);
  } catch (e) {
    finished = true;
    site.closeLogin('cursor');
    throw new Error(`${t('cursor.loginOpenFail')}: ${e.message || e}`);
  }

  try {
    const { accessToken } = await cursorAuth.pollAuth(uuid, verifier, ac.signal);
    const payload = creds.decodeJwt(accessToken);
    if (!payload || !payload.sub) {
      throw new Error(t('cursor.loginNoToken'));
    }
    // 세션 JWT 가 아니면 대시보드 쿠키로 쓸 수 없음 (auth/me 204)
    if (payload.type && payload.type !== 'session') {
      throw new Error(t('cursor.loginNotSession'));
    }
    const cookie = cookieStorageValue(accessToken) || cursorAuth.cookieFromAccessToken(accessToken);
    if (!cookie) throw new Error(t('cursor.loginNoToken'));
    await site.setCookie('cursor', { url: ORIGIN, name: COOKIE, value: cookie });
    const check = await fetchWithCookie(cookie, t('cursor.src'));
    if (!check.ok) {
      const why = check.skipped || check.error || '';
      if (/auth\/me\s*204/i.test(why)) throw new Error(t('cursor.loginAuthMe204'));
      throw new Error(why || t('cursor.loginNoToken'));
    }
    finished = true;
    site.closeLogin('cursor');
    return true;
  } catch (e) {
    const cancelled = !!(e && (e.cancelled || ac.signal.aborted));
    finished = true;
    site.closeLogin('cursor');
    if (cancelled) throw new Error(t('cursor.loginCancelled'));
    throw e;
  }
}

module.exports = {
  id: 'cursor',
  nameKey: 'cursor.name',
  color: '#a78bfa',
  loginUrl: 'https://cursor.com/loginDeepControl',
  hintKey: 'cursor.hint',
  loginCookieName: COOKIE,
  loginCookieUrl: ORIGIN,
  quietDeepLink: true,
  async login() {
    return loginPkce();
  },
  async fetch() {
    const notes = [];
    // Electron 숨김 창으로 cursor.com 을 열지 않음 (페이지 로드 시간 초과 / Cloudflare)
    for (const step of [
      () => viaIdeToken(),
      () => viaSessionCookie(),
    ]) {
      try {
        const r = await step();
        if (r.ok) return r;
        if (r.skipped) notes.push(r.skipped);
      } catch (e) { notes.push(e.message || String(e)); }
    }
    return {
      ok: false,
      needsLogin: true,
      error: notes.length ? notes.join('; ') : t('p.needsLogin', { site: 'cursor.com' }),
    };
  },
};
