'use strict';
// Grok: 앱 내 grok.com 로그인 세션 → POST /rest/rate-limits {requestKind, modelName}
const { clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const settings = require('../lib/settings');
const { t } = require('../lib/i18n');

const ORIGIN = 'https://grok.com';

function windowFor(model, kind, r) {
  if (!r || typeof r !== 'object' || typeof r.totalQueries !== 'number') return null;
  const total = r.totalQueries, remaining = typeof r.remainingQueries === 'number' ? r.remainingQueries : total;
  const secs = r.windowSizeSeconds;
  const win = secs ? (secs % 3600 === 0 ? t('grok.hours', { n: secs / 3600 }) : t('grok.minutes', { n: Math.round(secs / 60) })) : '';
  let resetAt = null;
  if (typeof r.waitTimeSeconds === 'number' && r.waitTimeSeconds > 0) resetAt = Date.now() + r.waitTimeSeconds * 1000;
  return {
    key: `${model}:${kind}`,
    label: `${model}${kind === 'DEFAULT' ? '' : ' ' + kind.toLowerCase()}${win ? t('grok.window', { w: win }) : ''}`,
    usedPct: total ? clampPct(((total - remaining) / total) * 100) : null,
    resetAt,
    detail: t('p.remainingOf', { n: remaining, total }),
    note: resetAt ? null : (secs ? t('grok.rolling', { w: win }) : null),
  };
}

module.exports = {
  id: 'grok',
  nameKey: 'grok.name',
  color: '#e5e7eb',
  loginUrl: 'https://grok.com/',
  hintKey: 'grok.hint',
  async fetch() {
    const models = settings.load().grokModels || ['grok-4', 'grok-3'];
    const script = `${site.PAGE_HELPERS}
      (async () => {
        const models = ${JSON.stringify(models)};
        const out = [];
        for (const m of models) {
          for (const kind of ['DEFAULT', 'REASONING', 'DEEPSEARCH']) {
            const r = await __req('/rest/rate-limits', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ requestKind: kind, modelName: m }),
            });
            if (r.status === 401 || r.status === 403) return { needsLogin: true, status: r.status, body: r.text };
            out.push({ model: m, kind, status: r.status, json: r.json, text: r.text });
            if (kind === 'DEFAULT' && !r.ok) break; // 모델 자체가 없으면 나머지 종류는 건너뜀
          }
        }
        return { ok: true, out };
      })()`;
    const r = await site.runInSite('grok', ORIGIN, script);
    if (r.needsLogin) return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'grok.com' }) };
    const windows = [];
    const raw = {};
    for (const o of r.out || []) {
      raw[`${o.model}/${o.kind}`] = o.json || o.text || o.status;
      const w = windowFor(o.model, o.kind, o.json);
      if (w) windows.push(w);
      if (o.json && o.json.lowEffortRateLimits) { const x = windowFor(o.model, `${o.kind} low`, o.json.lowEffortRateLimits); if (x) windows.push(x); }
      if (o.json && o.json.highEffortRateLimits) { const x = windowFor(o.model, `${o.kind} high`, o.json.highEffortRateLimits); if (x) windows.push(x); }
    }
    if (!windows.length) {
      const statuses = (r.out || []).map((o) => `${o.model}/${o.kind}=${o.status}`).join(', ');
      return { ok: false, error: t('p.parseFailStatus', { info: statuses }), raw };
    }
    return { ok: true, source: t('grok.src'), windows, extra: [], raw };
  },
};
