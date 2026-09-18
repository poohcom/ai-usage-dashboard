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

function cookieHeaderValue(raw) {
  if (!raw) return null;
  // 이미 URL-encoded 이거나 sub::jwt 형태
  if (raw.includes('%3A%3A') || raw.includes('%3a%3a')) return raw;
  if (raw.includes('::')) {
    const [sub, ...rest] = raw.split('::');
    return `${sub}%3A%3A${rest.join('::')}`;
  }
  const payload = creds.decodeJwt(raw);
  if (payload && payload.sub) {
    const uid = cursorAuth.userIdFromJwt(raw) || payload.sub;
    return `${uid}%3A%3A${raw}`;
  }
  return raw;
}

async function fetchWithCookie(rawCookie, source) {
  const encoded = cookieHeaderValue(rawCookie);
  if (!encoded) return { skipped: 'no cookie' };
  const headers = {
    Cookie: `${COOKIE}=${encoded}`,
    Origin: ORIGIN,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json',
  };
  const me = await request(`${ORIGIN}/api/auth/me`, { headers });
  if (me.status === 401 || me.status === 403 || !me.json) {
    return { skipped: `auth/me ${me.status}` };
  }
  const summary = await request(`${ORIGIN}/api/usage-summary`, { headers });
  if (summary.status === 401 || summary.status === 403) {
    return { skipped: `usage-summary ${summary.status}` };
  }
  let start = Date.now() - 30 * 86400000, end = Date.now();
  if (summary.json) {
    const s = Date.parse(summary.json.billingCycleStart), e = Date.parse(summary.json.billingCycleEnd);
    if (s) start = s; if (e) end = e;
  }
  const postHeaders = { ...headers, 'Content-Type': 'application/json' };
  let sand = null, agg = null;
  try {
    const r = await request(`${ORIGIN}/api/dashboard/get-sand-usage-status`, { method: 'POST', headers: postHeaders, body: '{}' });
    if (r.ok) sand = r.json;
  } catch { /* 선택 */ }
  try {
    const r = await request(`${ORIGIN}/api/dashboard/get-aggregated-usage-events`, {
      method: 'POST', headers: postHeaders,
      body: JSON.stringify({ teamId: 0, startDate: String(start), endDate: String(end) }),
    });
    if (r.ok) agg = r.json;
  } catch { /* 선택 */ }
  const result = assemble(me.json, summary.json, sand, agg, source);
  if (!result) return { skipped: t('p.noWindows') };
  return result;
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

async function viaWeb() {
  // Script failed 회피: 매번 새 숨김 창에서 강제 로드
  site.destroyHidden('cursor');
  const script = `${site.PAGE_HELPERS}
    (async () => {
      const me = await __req('/api/auth/me');
      if (me.status === 401 || me.status === 403 || !me.json) return { needsLogin: true, status: me.status };
      const summary = await __req('/api/usage-summary');
      if (summary.status === 401 || summary.status === 403) return { needsLogin: true, status: summary.status };
      const post = (u, body) => __req(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: '${ORIGIN}' }, body: JSON.stringify(body || {}) });
      let start = Date.now() - 30 * 86400000, end = Date.now();
      if (summary.json) { const s = Date.parse(summary.json.billingCycleStart), e = Date.parse(summary.json.billingCycleEnd); if (s) start = s; if (e) end = e; }
      let sand = null, agg = null;
      try { sand = await post('/api/dashboard/get-sand-usage-status', {}); } catch {}
      try { agg = await post('/api/dashboard/get-aggregated-usage-events', { teamId: 0, startDate: String(start), endDate: String(end) }); } catch {}
      return { ok: true, me: me.json, summary, sand, agg };
    })()`;
  const r = await site.runInSite('cursor', ORIGIN, script, { forceReload: true });
  if (r.needsLogin) return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'cursor.com' }) };
  const result = assemble(
    r.me,
    r.summary && r.summary.json,
    r.sand && r.sand.ok ? r.sand.json : null,
    r.agg && r.agg.ok ? r.agg.json : null,
    t('cursor.src'),
  );
  if (!result) {
    return { ok: false, error: t('p.parseFailStatus', { info: `usage-summary ${r.summary && r.summary.status}` }), raw: { summary: r.summary && (r.summary.json || r.summary.text) } };
  }
  return result;
}

/**
 * 앱 창에서 cursor.com 웹 로그인 → WorkosCursorSessionToken 쿠키 감지.
 * cursor:// 는 조용히 막고, 쿠키만 있으면 성공.
 */
function loginWebSession() {
  return new Promise((resolve, reject) => {
    let settled = false;
    site.openLogin(
      'cursor',
      `${ORIGIN}/settings`,
      async () => {
        if (settled) return;
        settled = true;
        try {
          const raw = await site.getCookie('cursor', { url: ORIGIN, name: COOKIE });
          if (raw) resolve(true);
          else reject(Object.assign(new Error(t('cursor.loginCancelled')), { cancelled: true }));
        } catch (e) {
          reject(e);
        }
      },
      t('cursor.name'),
      { cookieName: COOKIE, cookieUrl: ORIGIN, quietDeepLink: true },
    );
  });
}

module.exports = {
  id: 'cursor',
  nameKey: 'cursor.name',
  color: '#a78bfa',
  loginUrl: `${ORIGIN}/settings`,
  hintKey: 'cursor.hint',
  loginCookieName: COOKIE,
  loginCookieUrl: ORIGIN,
  quietDeepLink: true,
  async login() {
    return loginWebSession();
  },
  async fetch() {
    const notes = [];
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
    try {
      const w = await viaWeb();
      if (!w.ok && notes.length) w.error = `${w.error || t('p.needsLogin', { site: 'cursor.com' })} (${notes.join('; ')})`;
      return w;
    } catch (e) {
      return {
        ok: false,
        needsLogin: /401|403|login|로그인/i.test(e.message || ''),
        error: `${e.message || e}${notes.length ? ` (${notes.join('; ')})` : ''}`,
      };
    }
  },
};
