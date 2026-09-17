'use strict';
// Claude: 1) Claude Code 자격증명(OAuth) → api.anthropic.com/api/oauth/usage
//         2) 앱 내 claude.ai 로그인 세션 → claude.ai/api/organizations/{org}/usage
const creds = require('../lib/creds');
const { request, toMs, clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const { t } = require('../lib/i18n');

const ORIGIN = 'https://claude.ai';
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
  // 신형 응답: limits[] 에 세션/주간 전체/모델별 주간 한도가 모두 들어 있다
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
    // 구형 응답: five_hour / seven_day / seven_day_opus ... 객체
    for (const [key, val] of Object.entries(obj)) {
      if (!val || typeof val !== 'object' || typeof val.utilization !== 'number') continue;
      if (!WINDOW_KEYS[key] && !val.resets_at) continue; // 이름 없는 실험용 항목은 숨김
      windows.push({ key, label: WINDOW_KEYS[key] ? t(WINDOW_KEYS[key]) : key.replace(/_/g, ' '), usedPct: clampPct(val.utilization), resetAt: toMs(val.resets_at) });
    }
    const order = Object.keys(WINDOW_KEYS);
    windows.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  }
  // 주간 사용량의 용도별(Claude Code / 채팅 / Cowork) 비중
  const bd = obj.seven_day_breakdown;
  if (bd && Array.isArray(bd.rows) && bd.rows.some((r) => typeof r.percent === 'number' && r.percent > 0)) {
    windows.push({ key: 'breakdown', kind: 'section', label: t('claude.breakdown'), usedPct: null, resetAt: null });
    for (const r of bd.rows) {
      if (typeof r.percent !== 'number') continue;
      windows.push({ key: `bd:${r.key}`, kind: 'share', label: r.display_name || r.key, usedPct: clampPct(r.percent), resetAt: null, detail: '' });
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
      extra.push({ label: t('claude.extraMonthly'), value: limit != null ? `$${used.toFixed(2)} / $${limit.toFixed(2)}` : `$${used.toFixed(2)}` });
    }
  }
  return extra;
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

async function viaWeb() {
  const script = `${site.PAGE_HELPERS}
    (async () => {
      const orgs = await __req('/api/organizations');
      if (orgs.status === 401 || orgs.status === 403) return { needsLogin: true, status: orgs.status };
      if (!orgs.ok || !Array.isArray(orgs.json)) return { error: 'organizations ' + orgs.status, body: orgs.text };
      const org = orgs.json.find(o => (o.capabilities || []).includes('chat')) || orgs.json[0];
      if (!org) return { error: 'no-org' };
      const usage = await __req('/api/organizations/' + org.uuid + '/usage');
      if (usage.status === 401 || usage.status === 403) return { needsLogin: true, status: usage.status };
      let account = null;
      try { const a = await __req('/api/account'); account = a.json; } catch {}
      return { ok: usage.ok, status: usage.status, usage: usage.json, body: usage.text, org: { name: org.name, plan: org.rate_limit_tier || org.billing_type || null }, account };
    })()`;
  const r = await site.runInSite('claude', ORIGIN, script);
  if (r.needsLogin) return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'claude.ai' }) };
  if (r.error === 'no-org') return { ok: false, error: t('claude.noOrg') };
  if (!r.ok) return { ok: false, error: `claude.ai usage ${r.status}: ${r.error || r.body || ''}`.trim() };
  const windows = parseWindows(r.usage);
  if (!windows.length) return { ok: false, error: t('p.parseFail'), raw: r.usage };
  return {
    ok: true,
    source: t('claude.srcWeb'),
    account: r.account && r.account.email_address ? r.account.email_address : null,
    plan: r.org && r.org.plan ? String(r.org.plan).replace(/^default_/, '').toUpperCase() : null,
    windows,
    extra: parseExtra(r.usage),
    raw: r.usage,
  };
}

module.exports = {
  id: 'claude',
  nameKey: 'claude.name',
  color: '#d97757',
  loginUrl: 'https://claude.ai/login',
  hintKey: 'claude.hint',
  async fetch() {
    const notes = [];
    try {
      const o = await viaOAuth();
      if (o.ok) return o;
      if (o.skipped) notes.push(o.skipped);
    } catch (e) { notes.push(`OAuth: ${e.message}`); }
    const w = await viaWeb();
    if (!w.ok && notes.length) w.error = `${w.error} (${notes.join('; ')})`;
    return w;
  },
};
