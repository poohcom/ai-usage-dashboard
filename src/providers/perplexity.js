'use strict';
// Perplexity: 앱 내 perplexity.ai 로그인 세션 → /rest/rate-limit/all, /rest/user/settings, /rest/billing/credits
const { toMs, clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const { t } = require('../lib/i18n');

const ORIGIN = 'https://www.perplexity.ai';
const Q = 'version=2.18&source=default';

const KNOWN = [
  { key: 'remaining_pro', labelKey: 'perplexity.pro', total: 'pro' },
  { key: 'remaining_research', labelKey: 'perplexity.research', total: 'research' },
  { key: 'remaining_agentic_research', labelKey: 'perplexity.agentic', total: 'agentic_research' },
  { key: 'remaining_labs', labelKey: 'perplexity.labs', total: 'labs' },
];
// Pro 플랜의 알려진 월 한도 (응답에 total 이 없을 때 추정치로만 사용)
const PRO_DEFAULT_TOTALS = { pro: 200, research: 20, labs: 25 };

function num(v) { return typeof v === 'number' && !Number.isNaN(v) ? v : null; }

function findReset(json) {
  if (!json || typeof json !== 'object') return null;
  for (const [k, v] of Object.entries(json)) {
    if (/reset|renew|refresh/i.test(k)) { const ms = toMs(v); if (ms) return ms; }
  }
  return null;
}

function parseLimits(json, isPro) {
  const windows = [];
  if (!json || typeof json !== 'object') return windows;
  const reset = findReset(json);
  const fq = json.free_queries;
  if (fq && typeof fq === 'object') {
    const rem = fq.remaining_detail && num(fq.remaining_detail.remaining);
    windows.push({ key: 'free', label: t('perplexity.free'), usedPct: null, resetAt: reset, detail: rem != null ? t('p.remaining', { n: rem }) : (fq.available ? t('perplexity.available') : t('perplexity.exhausted')) });
  }
  for (const k of KNOWN) {
    const remaining = num(json[k.key]);
    if (remaining == null) continue;
    let total = num(json[`total_${k.total}`] ?? json[`${k.total}_limit`] ?? json[`limit_${k.total}`] ?? (json.limits && json.limits[k.total]));
    let est = false;
    if (total == null && isPro && PRO_DEFAULT_TOTALS[k.total]) { total = PRO_DEFAULT_TOTALS[k.total]; est = true; }
    windows.push({
      key: k.key, label: t(k.labelKey),
      usedPct: total ? clampPct(((total - remaining) / total) * 100) : null,
      resetAt: reset,
      detail: total ? t('p.remainingOf', { n: remaining, total }) + (est ? t('perplexity.estimated') : '') : t('p.remaining', { n: remaining }),
    });
  }
  // 모델별 한도: { "<model>": number | { remaining, limit|total, reset_at } }
  const msl = json.model_specific_limits;
  if (msl && typeof msl === 'object' && Object.keys(msl).length) {
    windows.push({ key: 'msl', kind: 'section', label: t('perplexity.models'), usedPct: null, resetAt: null });
    for (const [model, v] of Object.entries(msl)) {
      const remaining = num(typeof v === 'object' ? (v.remaining ?? (v.remaining_detail && v.remaining_detail.remaining)) : v);
      const total = typeof v === 'object' ? num(v.limit ?? v.total ?? v.max) : null;
      windows.push({
        key: `model:${model}`, label: model,
        usedPct: total ? clampPct(((total - (remaining ?? 0)) / total) * 100) : null,
        resetAt: typeof v === 'object' ? (findReset(v) || reset) : reset,
        detail: total ? t('p.remainingOf', { n: remaining ?? '?', total }) : remaining != null ? t('p.remaining', { n: remaining }) : JSON.stringify(v).slice(0, 60),
      });
    }
  }
  // 알려지지 않은 remaining_* 키도 표시
  for (const [k, v] of Object.entries(json)) {
    if (/^remaining_/.test(k) && !KNOWN.some((x) => x.key === k) && num(v) != null) {
      windows.push({ key: k, label: k.replace(/^remaining_/, '').replace(/_/g, ' '), usedPct: null, resetAt: reset, detail: t('p.remaining', { n: v }) });
    }
  }
  return windows;
}

function parseSettings(json) {
  const windows = [];
  if (!json || typeof json !== 'object') return windows;
  const pairs = [
    ['gpt4_limit', 'query_count', 'perplexity.gpt4'],
    ['opus_limit', 'query_count_opus', 'perplexity.opus'],
    ['upload_limit', 'upload_count', 'perplexity.upload'],
  ];
  for (const [lim, cnt, labelKey] of pairs) {
    const limit = num(json[lim]), used = num(json[cnt]);
    if (limit == null || used == null) continue;
    windows.push({ key: lim, label: t(labelKey), usedPct: limit ? clampPct((used / limit) * 100) : null, resetAt: null, detail: `${used} / ${limit}` });
  }
  return windows;
}

module.exports = {
  id: 'perplexity',
  nameKey: 'perplexity.name',
  color: '#20b8cd',
  loginUrl: 'https://www.perplexity.ai/',
  hintKey: 'perplexity.hint',
  async fetch() {
    const script = `${site.PAGE_HELPERS}
      (async () => {
        const h = { 'x-app-apiclient': 'default', 'x-app-apiversion': '2.18', Accept: 'application/json' };
        const settings = await __req('/rest/user/settings?skip_connector_picker_credentials=true&${Q}', { headers: h });
        if (settings.status === 401 || settings.status === 403) return { needsLogin: true, status: settings.status };
        const acc = settings.json && (settings.json.account_id || settings.json.id || settings.json.uuid);
        if (acc) h['x-pplx-account'] = String(acc);
        const limits = await __req('/rest/rate-limit/all?${Q}', { headers: h });
        let credits = null;
        try { credits = await __req('/rest/billing/credits?${Q}', { headers: Object.assign({ Referer: '${ORIGIN}/account/usage' }, h) }); } catch {}
        return { ok: true, settings, limits, credits };
      })()`;
    const r = await site.runInSite('perplexity', ORIGIN, script);
    if (r.needsLogin) return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'perplexity.ai' }) };
    const s = r.settings && r.settings.json;
    if (!s || (!s.username && !s.email && !s.subscription_status && !s.plan)) {
      return { ok: false, needsLogin: true, error: t('perplexity.noAccount'), raw: { settings: s || (r.settings && r.settings.text) } };
    }
    const tier = String(s.subscription_tier || s.plan || s.subscription_status || '').toLowerCase();
    const isPro = /pro|max|enterprise/.test(tier);
    let windows = [];
    if (r.limits && r.limits.ok) windows = parseLimits(r.limits.json, isPro);
    windows = windows.concat(parseSettings(s));
    const extra = [];
    if (s.subscription_status || s.plan || s.subscription_tier) {
      extra.push({ label: t('p.plan'), value: String(s.subscription_tier || s.plan || (s.subscription_status === 'none' ? t('perplexity.freePlan') : s.subscription_status)) });
    }
    const c = r.credits && r.credits.json;
    if (c && typeof c === 'object' && !c.detail) {
      const bal = num(c.balance ?? c.credits ?? c.remaining_credits);
      if (bal != null) extra.push({ label: t('perplexity.credits'), value: String(bal) });
      const renew = findReset(c);
      if (renew) extra.push({ label: t('perplexity.creditsRenew'), value: new Date(renew).toLocaleString() });
    }
    if (!windows.length) {
      return { ok: false, error: t('p.parseFailStatus', { info: `rate-limit ${r.limits && r.limits.status}` }), raw: { settings: s, limits: r.limits && (r.limits.json || r.limits.text) } };
    }
    return {
      ok: true, source: t('perplexity.src'),
      account: s.email || s.username || null,
      windows, extra,
      raw: { settings: s, limits: r.limits && r.limits.json, credits: c },
    };
  },
};
