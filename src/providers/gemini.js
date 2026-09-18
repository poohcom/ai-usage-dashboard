'use strict';
// Gemini (Antigravity / Gemini Code Assist 쿼터)
//   토큰 출처(우선순위): ① 이 앱에서 Google 로그인한 토큰(Antigravity 공개 OAuth 클라이언트)
//                       ② agy CLI / Antigravity 가 저장한 토큰   ③ Gemini CLI 토큰(구형, 서버가 거부할 수 있음)
//   API: cloudcode-pa loadCodeAssist → (onboardUser) → retrieveUserQuotaSummary / retrieveUserQuota
//   OAuth 클라이언트 값은 소스에 없고, 설치된 agy / Antigravity IDE 실행파일에서 런타임에 추출한다.
const creds = require('../lib/creds');
const oauth = require('../lib/googleOAuth');
const { request, toMs, clampPct } = require('../lib/http');
const { t } = require('../lib/i18n');

const API = 'https://cloudcode-pa.googleapis.com/v1internal';
const STORE = 'gemini-antigravity';
const memRefreshed = new Map(); // source -> {access_token, expiry}
let clientCache = null;

// Cloud Code 백엔드는 OS별 enum(WINDOWS_AMD64 등)을 거부하는 경우가 있어 PLATFORM_UNSPECIFIED 사용
const METADATA = { ideType: 'ANTIGRAVITY', pluginType: 'GEMINI', platform: 'PLATFORM_UNSPECIFIED' };

function antigravityUserAgent() {
  if (process.platform === 'win32') return 'antigravity/1.18.3 windows/amd64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'antigravity/1.18.3 darwin/arm64' : 'antigravity/1.18.3 darwin/amd64';
  return 'antigravity/1.18.3 linux/amd64';
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': antigravityUserAgent(),
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify(METADATA),
  };
}

/** id/secret 짝 확인: 가짜 refresh_token 으로 토큰 endpoint 를 찔러 invalid_client(짝 아님) 와 invalid_grant(짝) 를 구분 */
async function isPair(id, secret) {
  const body = new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: '1//x', grant_type: 'refresh_token' }).toString();
  const res = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  return !!(res.json && res.json.error === 'invalid_grant');
}

/** Antigravity OAuth 클라이언트 목록 [{id, secret}] — 로컬 실행파일에서 추출, 메모리만 캐시(디스크 평문 저장 금지) */
async function antigravityClients() {
  if (clientCache) return clientCache;
  const cand = creds.antigravityOauthCandidates();
  if (!cand.ids.length || !cand.secrets.length) return [];
  if (cand.paired) return (clientCache = [{ id: cand.ids[0], secret: cand.secrets[0] }]);
  const pairs = [];
  for (const id of cand.ids) {
    for (const secret of cand.secrets) {
      try { if (await isPair(id, secret)) { pairs.push({ id, secret }); break; } } catch { /* 네트워크 오류: 다음 */ }
    }
  }
  if (!pairs.length && cand.ids.length === 1 && cand.secrets.length === 1) pairs.push({ id: cand.ids[0], secret: cand.secrets[0] });
  if (pairs.length) clientCache = pairs;
  return pairs;
}

/** 토큰 출처 목록 */
async function sources() {
  const list = [];
  const clients = await antigravityClients();
  const own = oauth.loadTokens(STORE);
  if (own) {
    const c = clients.find((x) => x.id === own.clientId) || clients[0];
    list.push({ name: t('gemini.srcOwn'), tokens: own, clients: c ? [c] : [], own: true });
  }
  const agy = creds.antigravity();
  if (agy) list.push({ name: t(agy.sourceKey), tokens: agy.tokens, clients });
  const cli = creds.geminiCli();
  const cliClient = cli ? creds.geminiOauthClient() : null;
  if (cli) list.push({ name: t('gemini.srcCli'), tokens: creds.normalizeGoogleTokens(cli), clients: cliClient ? [cliClient] : [], legacy: true });
  return list;
}

/** 만료됐으면 메모리에서만 갱신 (CLI 가 저장한 파일은 건드리지 않음) */
async function freshToken(src) {
  const tk = src.tokens;
  if (tk.expiry_date && tk.expiry_date > Date.now() + 60000) return tk.access_token;
  const cached = memRefreshed.get(src.name);
  if (cached && cached.expiry > Date.now() + 60000) return cached.access_token;
  if (!tk.refresh_token) throw new Error(t('gemini.expiredNoRefresh'));
  let lastErr = null;
  for (const client of src.clients) {
    try {
      const nt = await oauth.refresh(client, tk);
      memRefreshed.set(src.name, { access_token: nt.access_token, expiry: nt.expiry_date });
      if (src.own) oauth.saveTokens(STORE, { ...tk, ...nt, clientId: client.id });
      return nt.access_token;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(t('gemini.refreshFail'));
}

function projectId(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s || null;
  }
  if (typeof v === 'object') {
    const id = v.id || v.projectId || v.name;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

async function loadCodeAssist(token, projectHint) {
  const body = { metadata: METADATA };
  const hint = projectId(projectHint);
  if (hint) body.cloudaicompanionProject = hint;
  const res = await request(`${API}:loadCodeAssist`, { method: 'POST', headers: headers(token), body });
  if (!res.ok) {
    const msg = (res.json && res.json.error && res.json.error.message) || res.text || '';
    const err = new Error(`loadCodeAssist ${res.status}: ${msg}`.trim());
    err.status = res.status;
    throw err;
  }
  return res.json || {};
}

/** currentTier 가 없으면 onboardUser 로 프로젝트/티어를 만든다 (Gemini CLI 와 같은 절차) */
async function onboard(token, load) {
  const tier = (load.allowedTiers || []).find((x) => x.isDefault) || (load.allowedTiers || [])[0];
  if (!tier) return null;
  const body = { tierId: tier.id, metadata: METADATA };
  const hint = projectId(creds.geminiProjectHint());
  if (!tier.userDefinedCloudaicompanionProject && hint) body.cloudaicompanionProject = hint;
  for (let i = 0; i < 5; i++) {
    const res = await request(`${API}:onboardUser`, { method: 'POST', headers: headers(token), body });
    if (!res.ok) return null;
    const op = res.json || {};
    if (op.done) {
      const proj = op.response && op.response.cloudaicompanionProject;
      return { project: projectId(proj), tier: tier.name || tier.id };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

function bucketsFromSummary(json) {
  const out = [];
  const groups = Array.isArray(json && json.groups) ? json.groups : [];
  for (const g of groups) {
    for (const b of (g.buckets || [])) {
      const rem = b.remaining && typeof b.remaining === 'object' ? b.remaining : b;
      const frac = typeof rem.remainingFraction === 'number' ? rem.remainingFraction : (typeof b.remainingFraction === 'number' ? b.remainingFraction : null);
      const win = windowLabel(b.window || rem.window || b.bucketId || b.displayName);
      out.push({
        label: [g.displayName, win].filter(Boolean).join(' · ') || 'quota',
        remaining: frac,
        resetAt: toMs(rem.resetTime || b.resetTime || rem.resetsAt || b.resetsAt),
        note: b.description || null,
        kind: 'summary',
      });
    }
  }
  return out;
}

function windowLabel(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return '';
  if (/week|weekly|7\s*d|주간/.test(s)) return t('gemini.weekly');
  if (/5\s*h|5h|five.?hour|300\s*m|5시간/.test(s)) return t('gemini.fiveHour');
  if (/day|daily|24\s*h|일일/.test(s)) return t('gemini.daily');
  return String(raw);
}

function bucketsFromQuota(json) {
  const list = Array.isArray(json && json.buckets) ? json.buckets : [];
  const out = [];
  for (const b of list) {
    const model = String(b.modelId || b.displayName || 'all').replace(/^models\//, '');
    const remaining = typeof b.remainingFraction === 'number'
      ? b.remainingFraction
      : (b.remainingAmount === undefined ? null : null);
    const win = windowLabel(b.window || b.quotaWindow || b.bucketId);
    out.push({
      label: [model !== 'all' ? model : null, win || null].filter(Boolean).join(' · ') || model,
      remaining,
      resetAt: toMs(b.resetTime || b.resetsAt),
      kind: 'quota',
    });
  }
  return out;
}

function bucketsFromModels(json) {
  const models = (json && json.models) || {};
  const out = [];
  for (const [id, info] of Object.entries(models)) {
    if (!info || typeof info !== 'object') continue;
    if (info.isInternal) continue;
    const label = info.displayName || String(id).replace(/^models\//, '');
    if (!label || /^(tab_|chat_)/i.test(id)) continue;
    const q = info.quotaInfo || {};
    // 모델 응답에 창(5h/weekly)별 항목이 있으면 펼친다
    const nested = Array.isArray(q.buckets) ? q.buckets
      : Array.isArray(info.quotaBuckets) ? info.quotaBuckets
      : Array.isArray(q.windows) ? q.windows
      : null;
    if (nested && nested.length) {
      for (const b of nested) {
        const frac = typeof b.remainingFraction === 'number' ? b.remainingFraction : null;
        if (frac == null) continue;
        const win = windowLabel(b.window || b.name || b.id);
        out.push({
          label: [label, win].filter(Boolean).join(' · '),
          remaining: frac,
          resetAt: toMs(b.resetTime || b.resetsAt),
          kind: 'model',
        });
      }
      continue;
    }
    const frac = typeof q.remainingFraction === 'number' ? q.remainingFraction
      : (typeof info.remainingFraction === 'number' ? info.remainingFraction : null);
    if (frac == null) continue;
    const win = windowLabel(q.window || info.window);
    out.push({
      label: [label, win].filter(Boolean).join(' · '),
      remaining: frac,
      resetAt: toMs(q.resetTime || info.resetTime),
      note: null,
      kind: 'model',
    });
  }
  return out;
}

function toWindows(buckets) {
  return buckets.map((b) => ({
    key: b.label,
    label: b.label,
    usedPct: b.remaining == null ? null : clampPct((1 - b.remaining) * 100),
    resetAt: b.resetAt,
    note: b.note || null,
  }));
}

async function fetchWithSource(src) {
  const token = await freshToken(src);
  const load = await loadCodeAssist(token, creds.geminiProjectHint());
  const unsupported = (load.ineligibleTiers || []).find((x) => x.reasonCode === 'UNSUPPORTED_CLIENT');
  let tier = load.currentTier ? (load.currentTier.name || load.currentTier.id) : null;
  let project = projectId(load.cloudaicompanionProject) || projectId(creds.geminiProjectHint());
  if (!tier && unsupported && !(load.allowedTiers || []).some((x) => x.id === 'free-tier' || x.id === 'standard-tier')) {
    const err = new Error(unsupported.reasonMessage || t('gemini.unsupported'));
    err.unsupportedClient = true;
    throw err;
  }
  // currentTier 가 없어도 allowedTiers 가 있으면 온보딩 시도 (project 가 비어 있어도 모델 쿼터는 조회 가능)
  if (!tier) {
    const ob = await onboard(token, load);
    if (ob) {
      project = projectId(ob.project) || project;
      tier = ob.tier || tier;
    }
    if (!tier) {
      const allowed = (load.allowedTiers || []).find((x) => x.isDefault) || (load.allowedTiers || [])[0];
      if (allowed) tier = allowed.name || allowed.id;
    }
  }
  const h = headers(token);
  // API 는 project 를 문자열 스칼라로 요구한다 (객체를내면 400 Invalid value)
  const body = project ? { project: String(project) } : {};
  const windows = [];
  const raw = { load, project };
  const extra = [];
  let usedSummary = false;

  // 1) 요약 API — 그룹별 5시간/주간 창이 여기 있음
  const summary = await request(`${API}:retrieveUserQuotaSummary`, { method: 'POST', headers: h, body });
  raw.summary = summary.json || summary.text;
  raw.summaryStatus = summary.status;
  if (summary.ok) {
    const fromSummary = bucketsFromSummary(summary.json);
    if (fromSummary.length) {
      windows.push(...toWindows(fromSummary));
      usedSummary = true;
    }
  }

  // 2) 요약이 비었거나 403 등이면 상세 쿼터 → 모델 폴백
  if (!windows.length) {
    const q = await request(`${API}:retrieveUserQuota`, { method: 'POST', headers: h, body });
    raw.quota = q.json || q.text;
    raw.quotaStatus = q.status;
    if (q.ok) windows.push(...toWindows(bucketsFromQuota(q.json)));
  }
  if (!windows.length) {
    const m = await request(`${API}:fetchAvailableModels`, { method: 'POST', headers: h, body });
    raw.models = m.json || m.text;
    raw.modelsStatus = m.status;
    if (m.ok) windows.push(...toWindows(bucketsFromModels(m.json)));
    if (!windows.length) {
      const msg = (summary.json && summary.json.error && summary.json.error.message)
        || (m.json && m.json.error && m.json.error.message)
        || '';
      const err = new Error(t('gemini.quotaFail', { s1: summary.status, s2: m.status, msg }));
      err.raw = raw;
      throw err;
    }
  }

  windows.sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1));
  if (!windows.length) {
    const err = new Error(t('gemini.empty'));
    err.raw = raw;
    throw err;
  }
  if (tier) extra.push({ label: t('gemini.tier'), value: tier });
  if (project) extra.push({ label: t('gemini.project'), value: String(project) });
  // 요약 API 가 막혀 모델%만 보일 때 안내
  if (!usedSummary) {
    const why = summary.status === 403 ? t('gemini.summaryBlocked')
      : summary.status && summary.status !== 200 ? t('gemini.summaryFail', { status: summary.status })
      : t('gemini.summaryEmpty');
    extra.push({ label: t('gemini.summaryNote'), value: why });
  }
  let account = src.tokens.email || null;
  if (!account && src.tokens.id_token) { const c = creds.decodeJwt(src.tokens.id_token); account = (c && c.email) || null; }
  return { ok: true, source: src.name, account, plan: tier, windows, extra, raw };
}

module.exports = {
  id: 'gemini',
  nameKey: 'gemini.name',
  color: '#4285f4',
  loginUrl: null,
  hintKey: 'gemini.hint',
  loginLabelKey: 'gemini.loginLabel',

  /** 브라우저 Google 로그인. Antigravity 고정 루프백(127.0.0.1:51121/oauth-callback) 사용 */
  async login() {
    const clients = await antigravityClients();
    if (!clients.length) throw new Error(t('gemini.noClient'));
    let lastErr = null;
    for (const client of clients) {
      const tk = await oauth.loginAntigravity(client);
      if (!tk.refresh_token) throw new Error(t('gemini.noRefresh'));
      oauth.saveTokens(STORE, { ...tk, clientId: client.id });
      try {
        await fetchWithSource({ name: t('gemini.srcOwn'), tokens: { ...tk, clientId: client.id }, clients: [client], own: true });
        return true;
      } catch (e) {
        lastErr = e;
        if (!e.unsupportedClient) return true; // 로그인은 됐고 조회 오류는 카드에 표시됨
      }
    }
    throw lastErr || new Error(t('gemini.loginFail'));
  },
  async logout() { oauth.clearTokens(STORE); memRefreshed.clear(); },

  async fetch() {
    const list = await sources();
    if (!list.length) return { ok: false, needsLogin: true, error: t('gemini.noSources') };
    const errors = [];
    for (const src of list) {
      try { return await fetchWithSource(src); }
      catch (e) { errors.push(`${src.name}: ${e.message}`); if (e.raw) errors.raw = e.raw; }
    }
    const legacyOnly = list.every((s) => s.legacy);
    return {
      ok: false,
      needsLogin: legacyOnly || errors.some((m) => /UNSUPPORTED|no longer supported|지원되지 않|401|403/.test(m)),
      error: errors.join(' | '),
      raw: errors.raw,
    };
  },
};
