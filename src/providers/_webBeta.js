'use strict';
// 세션 쿠키로 사용량 API를 탐색하는 베타 프로바이더 팩토리.
// 엔드포인트가 안정적이지 않거나 파싱이 불확실하면 beta: true 로 두고 설정에 Beta 배지를 표시한다.
const { clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const { t } = require('../lib/i18n');

function num(v) {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function pushWindow(windows, key, label, used, total, detail) {
  if (windows.some((w) => w.key === key)) return;
  const u = num(used);
  const tot = num(total);
  let usedPct = null;
  if (u != null && tot != null && tot > 0) usedPct = clampPct((u / tot) * 100);
  else if (u == null && tot != null && detail && /left|남음|remaining/i.test(detail)) {
    // remaining/total 형태는 호출측에서 usedPct 계산
  }
  windows.push({
    key,
    label,
    usedPct,
    resetAt: null,
    detail: detail || (u != null && tot != null ? `${u} / ${tot}` : u != null ? String(u) : tot != null ? String(tot) : ''),
  });
}

/** JSON 트리에서 usage/credit/quota 비슷한 숫자 필드를 느슨하게 추출 */
function extractWindows(json, prefix = '') {
  const windows = [];
  if (!json || typeof json !== 'object') return windows;

  const walk = (obj, path, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    if (Array.isArray(obj)) {
      obj.slice(0, 8).forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    const entries = Object.entries(obj);
    const used = num(obj.used ?? obj.usage ?? obj.consumed ?? obj.spent);
    const remaining = num(obj.remaining ?? obj.left ?? obj.balance ?? obj.credits_remaining);
    const total = num(obj.total ?? obj.limit ?? obj.max ?? obj.quota ?? obj.credits_total ?? obj.amount);
    const label = obj.name || obj.label || obj.model || obj.plan || path || 'usage';

    if (remaining != null && total != null && total > 0) {
      pushWindow(windows, path || label, String(label), total - remaining, total, t('p.remainingOf', { n: remaining, total }));
      windows[windows.length - 1].usedPct = clampPct(((total - remaining) / total) * 100);
    } else if (used != null && total != null && total > 0) {
      pushWindow(windows, path || label, String(label), used, total, `${used} / ${total}`);
      windows[windows.length - 1].usedPct = clampPct((used / total) * 100);
    } else if (remaining != null) {
      pushWindow(windows, path || label, String(label), null, null, t('p.remaining', { n: remaining }));
    } else if (total != null && /credit|balance|quota|limit/i.test(path + JSON.stringify(Object.keys(obj)))) {
      pushWindow(windows, path || label, String(label), null, total, String(total));
    }

    for (const [k, v] of entries) {
      if (/^(id|uuid|email|token|password|hash|url|href|created|updated)$/i.test(k)) continue;
      if (typeof v === 'object') walk(v, path ? `${path}.${k}` : k, depth + 1);
      else if (typeof v === 'number' && /usage|quota|limit|credit|remaining|balance|token/i.test(k)) {
        pushWindow(windows, path ? `${path}.${k}` : k, k.replace(/_/g, ' '), null, null, String(v));
      }
    }
  };

  walk(json, prefix, 0);
  return windows.slice(0, 12);
}

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.nameKey
 * @param {string} opts.color
 * @param {string} opts.loginUrl
 * @param {string} opts.hintKey
 * @param {string} opts.origin
 * @param {string[]} [opts.probes] relative or absolute paths to probe
 * @param {boolean} [opts.beta=true]
 * @param {(r: object) => object|null} [opts.parse] custom parser returning { windows, account, extra, plan } or null
 */
function createWebBeta(opts) {
  const {
    id, nameKey, color, loginUrl, hintKey, origin,
    probes = [], beta = true, parse = null, hostLabel = null,
  } = opts;
  const host = hostLabel || (() => { try { return new URL(origin).hostname; } catch { return id; } })();

  return {
    id, nameKey, color, loginUrl, hintKey, beta,
    async fetch() {
      const script = `${site.PAGE_HELPERS}
        (async () => {
          const probes = ${JSON.stringify(probes)};
          const results = {};
          let authed = false;
          for (const p of probes) {
            try {
              const r = await __req(p);
              results[p] = { status: r.status, ok: r.ok, json: r.json, text: r.text };
              if (r.status === 401 || r.status === 403) continue;
              if (r.ok) authed = true;
            } catch (e) {
              results[p] = { error: String(e && e.message || e) };
            }
          }
          const hasCookie = (document.cookie || '').length > 8;
          let loggedInHint = false;
          try {
            const body = (document.body && document.body.innerText || '').slice(0, 800).toLowerCase();
            loggedInHint = /sign out|log out|로그아웃|account|settings|billing|usage|dashboard/.test(body)
              && !/sign in|log in|로그인|create account/.test(body.slice(0, 200));
          } catch {}
          return {
            ok: true,
            needsLogin: !authed && !hasCookie && !loggedInHint,
            hasCookie, loggedInHint, authed,
            href: location.href,
            results,
          };
        })()`;

      let r;
      try {
        r = await site.runInSite(id, origin, script);
      } catch (e) {
        return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: host }), raw: { error: String(e && e.message || e) } };
      }

      if (r.needsLogin) {
        return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: host }), raw: r.results || r };
      }

      if (typeof parse === 'function') {
        try {
          const custom = parse(r);
          if (custom && custom.windows && custom.windows.length) {
            return {
              ok: true,
              source: t(`${id}.src`),
              account: custom.account || null,
              plan: custom.plan || null,
              windows: custom.windows,
              extra: custom.extra || [],
              raw: custom.raw || r.results,
            };
          }
        } catch { /* fall through */ }
      }

      let windows = [];
      for (const [path, res] of Object.entries(r.results || {})) {
        if (res && res.json) windows = windows.concat(extractWindows(res.json, path));
      }
      // 중복 제거
      const seen = new Set();
      windows = windows.filter((w) => {
        const k = w.key + '|' + w.detail;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      if (windows.length) {
        return {
          ok: true,
          source: t(`${id}.src`),
          account: null,
          windows,
          extra: beta ? [{ label: t('ui.beta'), value: t('p.betaPartial') }] : [],
          raw: r.results,
        };
      }

      // 세션은 있으나 사용량 파싱 실패 → 베타 안내
      return {
        ok: false,
        needsLogin: false,
        error: t('p.betaNoUsage', { site: host }),
        raw: { href: r.href, hasCookie: r.hasCookie, results: r.results },
      };
    },
  };
}

module.exports = { createWebBeta, extractWindows, clampPct, num };
