'use strict';
// Cursor: 앱 내 cursor.com 로그인 세션 →
//   /api/usage-summary                          플랜 포함분(Auto 모델 / 지정 모델 API / 전체), 온디맨드, 결제 주기
//   /api/dashboard/get-sand-usage-status        Grok Bot 주간 한도
//   /api/dashboard/get-aggregated-usage-events  모델별 사용량(토큰/비용) 집계
const { toMs, clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const { t } = require('../lib/i18n');

const ORIGIN = 'https://cursor.com';

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

/** 모델별 집계 → 비용 비중 막대 */
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

module.exports = {
  id: 'cursor',
  nameKey: 'cursor.name',
  color: '#a78bfa',
  loginUrl: 'https://cursor.com/dashboard',
  hintKey: 'cursor.hint',
  async fetch() {
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
    const r = await site.runInSite('cursor', ORIGIN, script);
    if (r.needsLogin) return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'cursor.com' }) };
    let windows = [], extra = [];
    if (r.summary && r.summary.ok) ({ windows, extra } = parseSummary(r.summary.json));
    const sand = r.sand && r.sand.ok ? parseSand(r.sand.json) : null;
    if (sand) windows.push(sand);
    const models = r.agg && r.agg.ok ? parseAggregated(r.agg.json) : [];
    if (models.length) {
      windows.push({ key: 'sep', kind: 'section', label: t('cursor.models'), usedPct: null, resetAt: null });
      windows.push(...models);
      const total = num(r.agg.json.totalCostCents);
      if (total != null) extra.push({ label: t('cursor.cycleCost'), value: usd(total) });
    }
    if (!windows.length) {
      return { ok: false, error: t('p.parseFailStatus', { info: `usage-summary ${r.summary && r.summary.status}` }), raw: { summary: r.summary && (r.summary.json || r.summary.text) } };
    }
    return {
      ok: true,
      source: t('cursor.src'),
      account: r.me && r.me.email ? r.me.email : null,
      plan: r.summary && r.summary.json && r.summary.json.membershipType ? String(r.summary.json.membershipType).toUpperCase() : null,
      windows, extra,
      raw: { summary: r.summary && r.summary.json, sand: r.sand && r.sand.json, aggregated: r.agg && r.agg.json },
    };
  },
};
