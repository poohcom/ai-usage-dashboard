'use strict';
// 추가 AI 서비스 (대부분 웹 세션 탐색 — 안정화 전 beta)
const { createWebBeta, extractWindows, num, clampPct } = require('./_webBeta');
const { t } = require('../lib/i18n');

function openRouterParse(r) {
  const windows = [];
  const extra = [];
  let account = null;
  for (const [path, res] of Object.entries(r.results || {})) {
    const j = res && res.json;
    if (!j) continue;
    if (j.data && typeof j.data === 'object') {
      const d = j.data;
      const total = num(d.total_credits ?? d.total);
      const used = num(d.total_usage ?? d.usage);
      if (total != null || used != null) {
        const rem = total != null && used != null ? Math.max(0, total - used) : null;
        windows.push({
          key: 'credits',
          label: t('openrouter.credits'),
          usedPct: total && used != null ? clampPct((used / total) * 100) : null,
          resetAt: null,
          detail: rem != null && total != null ? t('p.remainingOf', { n: rem, total }) : (used != null ? String(used) : String(total)),
        });
      }
    }
    if (j.limit != null || j.usage != null || j.limit_remaining != null) {
      const limit = num(j.limit);
      const usage = num(j.usage);
      const rem = num(j.limit_remaining);
      if (limit != null && usage != null) {
        windows.push({
          key: 'key',
          label: t('openrouter.keyLimit'),
          usedPct: clampPct((usage / limit) * 100),
          resetAt: null,
          detail: `${usage} / ${limit}`,
        });
      } else if (rem != null) {
        windows.push({ key: 'keyRem', label: t('openrouter.keyLimit'), usedPct: null, resetAt: null, detail: t('p.remaining', { n: rem }) });
      }
    }
    if (j.label || j.name) account = j.label || j.name;
    windows.push(...extractWindows(j, path));
  }
  if (!windows.length) return null;
  return { windows: windows.slice(0, 10), account, extra, raw: r.results };
}

function elevenParse(r) {
  const windows = [];
  let account = null;
  let plan = null;
  for (const res of Object.values(r.results || {})) {
    const j = res && res.json;
    if (!j) continue;
    if (j.subscription || j.character_count != null || j.character_limit != null) {
      const sub = j.subscription || j;
      const used = num(sub.character_count ?? j.character_count);
      const limit = num(sub.character_limit ?? j.character_limit);
      plan = sub.tier || sub.plan || j.tier || null;
      if (used != null && limit != null) {
        windows.push({
          key: 'chars',
          label: t('elevenlabs.chars'),
          usedPct: limit ? clampPct((used / limit) * 100) : null,
          resetAt: null,
          detail: `${used} / ${limit}`,
        });
      }
    }
    if (j.email || j.first_name) account = j.email || [j.first_name, j.last_name].filter(Boolean).join(' ');
    windows.push(...extractWindows(j));
  }
  if (!windows.length) return null;
  return { windows: windows.slice(0, 10), account, plan, raw: r.results };
}

module.exports = [
  createWebBeta({
    id: 'copilot',
    nameKey: 'copilot.name',
    color: '#7ee787',
    loginUrl: 'https://github.com/login',
    hintKey: 'copilot.hint',
    origin: 'https://github.com',
    probes: [
      '/settings/copilot',
      '/account/settings/billing',
      '/settings/billing/summary',
    ],
  }),
  createWebBeta({
    id: 'midjourney',
    nameKey: 'midjourney.name',
    color: '#a78bfa',
    loginUrl: 'https://www.midjourney.com/home',
    hintKey: 'midjourney.hint',
    origin: 'https://www.midjourney.com',
    probes: ['/api/app/users/current', '/account', '/'],
  }),
  createWebBeta({
    id: 'deepseek',
    nameKey: 'deepseek.name',
    color: '#4f6bed',
    loginUrl: 'https://chat.deepseek.com/',
    hintKey: 'deepseek.hint',
    origin: 'https://chat.deepseek.com',
    probes: [
      '/api/v0/users/current',
      '/api/v0/users/balance',
      '/api/v0/quota',
    ],
  }),
  createWebBeta({
    id: 'openrouter',
    nameKey: 'openrouter.name',
    color: '#f97316',
    loginUrl: 'https://openrouter.ai/sign-in',
    hintKey: 'openrouter.hint',
    origin: 'https://openrouter.ai',
    probes: [
      '/api/v1/credits',
      '/api/v1/key',
      '/api/v1/auth/key',
    ],
    parse: openRouterParse,
  }),
  createWebBeta({
    id: 'elevenlabs',
    nameKey: 'elevenlabs.name',
    color: '#1a1a2e',
    loginUrl: 'https://elevenlabs.io/app/sign-in',
    hintKey: 'elevenlabs.hint',
    origin: 'https://elevenlabs.io',
    probes: [
      '/v1/user/subscription',
      '/v1/user',
      'https://api.elevenlabs.io/v1/user/subscription',
      'https://api.elevenlabs.io/v1/user',
    ],
    parse: elevenParse,
  }),
  createWebBeta({
    id: 'runway',
    nameKey: 'runway.name',
    color: '#00c2a8',
    loginUrl: 'https://app.runwayml.com/login',
    hintKey: 'runway.hint',
    origin: 'https://app.runwayml.com',
    probes: ['/api/profile', '/api/account', '/api/credits', '/dashboard'],
  }),
  createWebBeta({
    id: 'kling',
    nameKey: 'kling.name',
    color: '#6366f1',
    loginUrl: 'https://klingai.com/',
    hintKey: 'kling.hint',
    origin: 'https://klingai.com',
    probes: ['/api/user', '/api/account', '/api/credit', '/app/account'],
  }),
  createWebBeta({
    id: 'veo',
    nameKey: 'veo.name',
    color: '#4285f4',
    loginUrl: 'https://labs.google/fx/tools/flow',
    hintKey: 'veo.hint',
    origin: 'https://labs.google',
    probes: ['/fx/api/trpc/user', '/fx/tools/flow', '/'],
    hostLabel: 'labs.google',
  }),
  createWebBeta({
    id: 'suno',
    nameKey: 'suno.name',
    color: '#22c55e',
    loginUrl: 'https://suno.com/',
    hintKey: 'suno.hint',
    origin: 'https://suno.com',
    probes: ['/api/billing/info', '/api/session', '/api/me'],
  }),
  createWebBeta({
    id: 'luma',
    nameKey: 'luma.name',
    color: '#38bdf8',
    loginUrl: 'https://lumalabs.ai/dream-machine',
    hintKey: 'luma.hint',
    origin: 'https://lumalabs.ai',
    probes: ['/api/user', '/api/credits', '/dream-machine/api/usage'],
  }),
  createWebBeta({
    id: 'pika',
    nameKey: 'pika.name',
    color: '#fbbf24',
    loginUrl: 'https://pika.art/login',
    hintKey: 'pika.hint',
    origin: 'https://pika.art',
    probes: ['/api/user', '/api/credits', '/api/account'],
  }),
  createWebBeta({
    id: 'hailuo',
    nameKey: 'hailuo.name',
    color: '#f472b6',
    loginUrl: 'https://hailuoai.video/',
    hintKey: 'hailuo.hint',
    origin: 'https://hailuoai.video',
    probes: ['/api/user', '/api/credit', '/v1/api/user/info'],
  }),
  createWebBeta({
    id: 'seedance',
    nameKey: 'seedance.name',
    color: '#a3e635',
    loginUrl: 'https://www.capcut.com/dreamina',
    hintKey: 'seedance.hint',
    origin: 'https://www.capcut.com',
    probes: ['/dreamina', '/api/user', '/'],
    hostLabel: 'capcut.com / Dreamina',
  }),
];
