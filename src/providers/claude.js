'use strict';
// Claude: 1) Claude Code 자격증명(OAuth) → api.anthropic.com/api/oauth/usage
//         2) 앱 로그인 세션 → 같은 partition 의 session.fetch 로 claude.ai API
// (net.fetch + Cookie 헤더만으로는 Cloudflare 에 막히는 경우가 많음)
const creds = require('../lib/creds');
const { request, toMs, clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const { t } = require('../lib/i18n');

const ORIGIN = 'https://claude.ai';
const AUTH_COOKIE_NAMES = ['sessionKey', 'sessionKeyV2'];

const WINDOW_KEYS = {
  five_hour: 'claude.session',
  seven_day: 'claude.weeklyAll',
  seven_day_opus: 'claude.weeklyOpus',
  seven_day_sonnet: 'claude.weeklySonnet',
  seven_day_oauth_apps: 'claude.weeklyOauth',
  seven_day_cowork: 'claude.weeklyCowork',
};

function limitLabel(l) {
  const model = l.scope && l.scope.model && (l.scope.model.display_name || l.scope.model.id);
  const surface = l.scope && l.scope.surface && (l.scope.surface.display_name || l.scope.surface.id || l.scope.surface);
  const scope = [model, typeof surface === 'string' ? surface : null].filter(Boolean).join(' ');
  switch (l.kind) {
    case 'session': return t('claude.session');
    case 'weekly_all': return t('claude.weeklyAll');
    case 'weekly_scoped': return scope ? t('claude.weeklyScoped', { scope }) : t('claude.weeklyScopedUnknown');
    default: return `${l.group || l.kind}${scope ? ' ' + scope : ''}`;
  }
}

function parseWindows(obj) {
  const windows = [];
  if (!obj || typeof obj !== 'object') return windows;
  if (Array.isArray(obj.limits) && obj.limits.length) {
    for (const l of obj.limits) {
      if (typeof l.percent !== 'number') continue;
      windows.push({
        key: `${l.kind}:${(l.scope && l.scope.model && l.scope.model.display_name) || ''}`,
        label: limitLabel(l),
        usedPct: clampPct(l.percent),
        resetAt: toMs(l.resets_at),
        note: l.severity && l.severity !== 'normal' ? l.severity : null,
      });
    }
  } else {
    for (const [key, val] of Object.entries(obj)) {
      if (!val || typeof val !== 'object' || typeof val.utilization !== 'number') continue;
      if (!WINDOW_KEYS[key] && !val.resets_at) continue;
      windows.push({
        key,
        label: WINDOW_KEYS[key] ? t(WINDOW_KEYS[key]) : key.replace(/_/g, ' '),
        usedPct: clampPct(val.utilization),
        resetAt: toMs(val.resets_at),
      });
    }
    const order = Object.keys(WINDOW_KEYS);
    windows.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  }
  const bd = obj.seven_day_breakdown;
  if (bd && Array.isArray(bd.rows) && bd.rows.some((r) => typeof r.percent === 'number' && r.percent > 0)) {
    windows.push({ key: 'breakdown', kind: 'section', label: t('claude.breakdown'), usedPct: null, resetAt: null });
    for (const r of bd.rows) {
      if (typeof r.percent !== 'number') continue;
      windows.push({
        key: `bd:${r.key}`,
        kind: 'share',
        label: r.display_name || r.key,
        usedPct: clampPct(r.percent),
        resetAt: null,
        detail: '',
      });
    }
  }
  return windows;
}

function parseExtra(obj) {
  const extra = [];
  const eu = obj && obj.extra_usage;
  if (eu && typeof eu === 'object') {
    if (eu.is_enabled === false) extra.push({ label: t('claude.extraOff'), value: '' });
    else if (typeof eu.used_credits === 'number' || typeof eu.monthly_limit === 'number') {
      const used = (eu.used_credits ?? 0) / 100;
      const limit = eu.monthly_limit != null ? eu.monthly_limit / 100 : null;
      extra.push({
        label: t('claude.extraMonthly'),
        value: limit != null ? `$${used.toFixed(2)} / $${limit.toFixed(2)}` : `$${used.toFixed(2)}`,
      });
    }
  }
  return extra;
}

function pickOrg(list, lastActiveOrg) {
  if (!Array.isArray(list) || !list.length) return null;
  const chat = list.find((o) => (o.capabilities || []).includes('chat'));
  if (chat) return chat;
  if (lastActiveOrg) {
    const match = list.find((o) => o.uuid === lastActiveOrg || o.id === lastActiveOrg);
    if (match) return match;
  }
  return list[0];
}

function orgListFrom(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.organizations)) return json.organizations;
  if (json && Array.isArray(json.data)) return json.data;
  return null;
}

function planFromOrg(org) {
  if (!org) return null;
  if (org.rate_limit_tier) return String(org.rate_limit_tier).replace(/^default_/, '').toUpperCase();
  if (org.billing_type) return String(org.billing_type).toUpperCase();
  const caps = org.capabilities || [];
  const named = caps.find((c) => /^claude_/i.test(c));
  if (named) return String(named).replace(/^claude_/i, '').replace(/_/g, ' ').toUpperCase();
  return null;
}

function isClaudeAuthCookie(c) {
  if (!c || !c.value) return false;
  if (AUTH_COOKIE_NAMES.includes(c.name)) return true;
  // Anthropic 세션 키 (이름이 바뀌어도 sk-ant- 값이면 인정)
  if (/^sk-ant-/i.test(c.value) && /session/i.test(c.name || '')) return true;
  return false;
}

async function hasClaudeSession() {
  const cookies = await site.listCookies('claude', ORIGIN);
  return (cookies || []).some(isClaudeAuthCookie);
}

async function claudeGet(path) {
  return site.requestInSession('claude', `${ORIGIN}${path}`, {
    headers: {
      Accept: 'application/json',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    timeoutMs: 45000,
  });
}

async function viaOAuth() {
  const c = creds.claudeCode();
  if (!c || !c.accessToken) return { skipped: t('p.noCreds', { cli: 'Claude Code' }) };
  if (c.expiresAt && c.expiresAt < Date.now()) return { skipped: t('p.tokenExpired', { cli: 'Claude Code', cmd: 'claude' }) };
  const res = await request('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${c.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
      Accept: 'application/json',
    },
  });
  if (!res.ok) return { skipped: `OAuth usage API ${res.status}` };
  const windows = parseWindows(res.json);
  if (!windows.length) return { skipped: t('p.noWindows') };
  return {
    ok: true,
    source: t('claude.srcOauth'),
    plan: c.subscriptionType ? String(c.subscriptionType).toUpperCase() : null,
    windows,
    extra: parseExtra(res.json),
    raw: res.json,
  };
}

/** 로그인 partition 쿠키로 session.fetch (Cloudflare·세션 유지) */
async function viaSession() {
  if (!(await hasClaudeSession())) {
    return { skipped: t('p.needsLogin', { site: 'claude.ai' }) };
  }

  const orgsRes = await claudeGet('/api/organizations');
  const cfBlocked = orgsRes.text && /just a moment|cf-browser-verification|cloudflare/i.test(orgsRes.text);
  if (cfBlocked) {
    return { ok: false, needsLogin: true, error: t('err.cloudflare') };
  }
  if (orgsRes.status === 401 || orgsRes.status === 403) {
    return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'claude.ai' }) };
  }
  const list = orgListFrom(orgsRes.json);
  if (!list) {
    return {
      ok: false,
      error: t('claude.orgsFail', { status: orgsRes.status }),
      raw: orgsRes.json || orgsRes.text,
    };
  }

  let lastActiveOrg = null;
  try {
    lastActiveOrg = await site.getCookie('claude', { url: ORIGIN, name: 'lastActiveOrg' });
  } catch { /* 선택 */ }

  const org = pickOrg(list, lastActiveOrg);
  if (!org || !org.uuid) return { ok: false, error: t('claude.noOrg') };

  const usageRes = await claudeGet(`/api/organizations/${org.uuid}/usage`);
  if (usageRes.status === 401 || usageRes.status === 403) {
    return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'claude.ai' }) };
  }
  if (!usageRes.ok || !usageRes.json) {
    return {
      ok: false,
      error: t('claude.usageFail', { status: usageRes.status }),
      raw: usageRes.json || usageRes.text,
    };
  }

  let account = null;
  try {
    const a = await claudeGet('/api/account');
    if (a.ok && a.json) account = a.json;
  } catch { /* 선택 */ }

  const windows = parseWindows(usageRes.json);
  if (!windows.length) return { ok: false, error: t('p.parseFail'), raw: usageRes.json };

  return {
    ok: true,
    source: t('claude.srcWeb'),
    account: account && (account.email_address || account.email) ? (account.email_address || account.email) : null,
    plan: planFromOrg(org),
    windows,
    extra: parseExtra(usageRes.json),
    raw: usageRes.json,
  };
}

module.exports = {
  id: 'claude',
  nameKey: 'claude.name',
  color: '#d97757',
  loginUrl: 'https://claude.ai/login',
  hintKey: 'claude.hint',
  loginCookieNames: AUTH_COOKIE_NAMES,
  loginCookieUrl: ORIGIN,
  quietDeepLink: true,
  async fetch() {
    const notes = [];
    try {
      const o = await viaOAuth();
      if (o.ok) return o;
      if (o.skipped) notes.push(o.skipped);
    } catch (e) { notes.push(`OAuth: ${e.message}`); }

    try {
      const w = await viaSession();
      if (w.ok) return w;
      if (w.skipped) notes.push(w.skipped);
      else if (w.error) {
        if (notes.length) w.error = `${w.error} (${notes.join('; ')})`;
        return w;
      }
    } catch (e) {
      notes.push(e.message || String(e));
    }

    return {
      ok: false,
      needsLogin: true,
      error: notes.length ? notes.join('; ') : t('p.needsLogin', { site: 'claude.ai' }),
    };
  },
};
