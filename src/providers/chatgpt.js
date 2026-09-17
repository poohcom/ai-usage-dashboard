'use strict';
// ChatGPT: ChatGPT 플랜의 Codex 사용량 한도(5시간/주간)를 보여준다.
//   1) Codex CLI 자격증명(~/.codex/auth.json) → chatgpt.com/backend-api/wham/usage
//   2) 앱 내 chatgpt.com 로그인 세션 → /api/auth/session 으로 access token 을 얻어 같은 API 호출
const creds = require('../lib/creds');
const { request, toMs, clampPct } = require('../lib/http');
const site = require('../lib/siteSession');
const { t } = require('../lib/i18n');

const ORIGIN = 'https://chatgpt.com';

function windowFrom(w, fallbackLabel) {
  if (!w || typeof w !== 'object') return null;
  const used = typeof w.used_percent === 'number' ? w.used_percent : null;
  let resetAt = toMs(w.reset_at);
  if (resetAt == null && typeof w.reset_after_seconds === 'number') resetAt = Date.now() + w.reset_after_seconds * 1000;
  const secs = w.limit_window_seconds;
  const label = secs
    ? (secs >= 6 * 86400 ? t('chatgpt.weekly') : secs >= 3600 ? t('chatgpt.hours', { n: Math.round(secs / 3600) }) : t('chatgpt.minutes', { n: Math.round(secs / 60) }))
    : fallbackLabel;
  return { key: fallbackLabel, label, usedPct: clampPct(used), resetAt };
}

function parse(json) {
  const rl = json && json.rate_limit;
  const windows = [];
  const p = windowFrom(rl && rl.primary_window, t('chatgpt.fiveHour'));
  const s = windowFrom(rl && rl.secondary_window, t('chatgpt.weekly'));
  if (p) windows.push(p);
  if (s) windows.push(s);
  const extra = [];
  if (json && json.plan_type) extra.push({ label: t('p.plan'), value: String(json.plan_type) });
  const cr = json && json.credits;
  if (cr && typeof cr === 'object') {
    if (cr.unlimited) extra.push({ label: t('chatgpt.credits'), value: t('chatgpt.creditsUnlimited') });
    else if (cr.balance != null) extra.push({ label: t('chatgpt.creditBalance'), value: String(cr.balance) });
  }
  const crr = json && json.code_review_rate_limit;
  if (crr && crr.primary_window) {
    const w = windowFrom(crr.primary_window, 'code-review');
    if (w) windows.push({ ...w, label: t('chatgpt.codeReview', { win: w.label }) });
  }
  return { windows, extra };
}

async function viaCodex() {
  const tk = creds.codex();
  if (!tk) return { skipped: t('p.noCreds', { cli: 'Codex' }) };
  const claims = creds.decodeJwt(tk.access_token) || {};
  if (claims.exp && claims.exp * 1000 < Date.now()) return { skipped: t('p.tokenExpired', { cli: 'Codex', cmd: 'codex' }) };
  const auth = claims['https://api.openai.com/auth'] || {};
  const accountId = tk.account_id || auth.chatgpt_account_id;
  const headers = { Authorization: `Bearer ${tk.access_token}`, Accept: 'application/json', 'User-Agent': 'codex_cli_rs/0.60.0' };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const res = await request(`${ORIGIN}/backend-api/wham/usage`, { headers });
  if (!res.ok) return { skipped: `wham/usage ${res.status}` };
  const { windows, extra } = parse(res.json);
  if (!windows.length) return { skipped: t('p.noWindows') };
  const profile = claims['https://api.openai.com/profile'] || {};
  return { ok: true, source: t('chatgpt.srcCodex'), account: profile.email || null, plan: auth.chatgpt_plan_type || null, windows, extra, raw: res.json };
}

async function viaWeb() {
  const script = `${site.PAGE_HELPERS}
    (async () => {
      const s = await __req('/api/auth/session');
      if (!s.ok || !s.json || !s.json.accessToken) return { needsLogin: true, status: s.status };
      const token = s.json.accessToken;
      let accountId = (s.json.account && s.json.account.id) || null;
      try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const a = payload['https://api.openai.com/auth'] || {};
        accountId = accountId || a.chatgpt_account_id || null;
      } catch {}
      const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
      if (accountId) headers['ChatGPT-Account-Id'] = accountId;
      const u = await __req('/backend-api/wham/usage', { headers });
      if (u.status === 401 || u.status === 403) return { needsLogin: true, status: u.status };
      return { ok: u.ok, status: u.status, usage: u.json, body: u.text, email: s.json.user && s.json.user.email };
    })()`;
  const r = await site.runInSite('chatgpt', ORIGIN, script);
  if (r.needsLogin) return { ok: false, needsLogin: true, error: t('p.needsLogin', { site: 'chatgpt.com' }) };
  if (!r.ok) return { ok: false, error: `wham/usage ${r.status}: ${r.body || ''}`.trim() };
  const { windows, extra } = parse(r.usage);
  if (!windows.length) return { ok: false, error: t('p.parseFail'), raw: r.usage };
  return { ok: true, source: t('chatgpt.srcWeb'), account: r.email || null, windows, extra, raw: r.usage };
}

module.exports = {
  id: 'chatgpt',
  nameKey: 'chatgpt.name',
  color: '#10a37f',
  loginUrl: 'https://chatgpt.com/auth/login',
  hintKey: 'chatgpt.hint',
  async fetch() {
    const notes = [];
    try {
      const o = await viaCodex();
      if (o.ok) return o;
      if (o.skipped) notes.push(o.skipped);
    } catch (e) { notes.push(`Codex: ${e.message}`); }
    const w = await viaWeb();
    if (!w.ok && notes.length) w.error = `${w.error} (${notes.join('; ')})`;
    return w;
  },
};
