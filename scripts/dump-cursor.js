'use strict';
// 디버그용: 앱과 같은 userData 의 cursor 세션으로 usage 관련 API 를 호출해 원본 JSON 을 출력한다.
// 실행: npx electron scripts/dump-cursor.js   (앱이 종료된 상태에서)
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.setName('AI Usage Dashboard');
app.setPath('userData', path.join(app.getPath('appData'), 'AI Usage Dashboard'));

const redact = (s) => String(s).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>').replace(/user_[A-Za-z0-9]+/g, '<userid>');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:cursor', sandbox: true } });
  await w.loadURL('https://cursor.com/robots.txt');
  const out = await w.webContents.executeJavaScript(`(async () => {
    const get = async (u, init) => { const r = await fetch(u, Object.assign({ credentials: 'include' }, init || {})); const t = await r.text(); return { status: r.status, body: t.startsWith('<') ? '<html>' : t.slice(0, 20000) }; };
    const post = (u, body) => get(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://cursor.com' }, body: JSON.stringify(body || {}) });
    const summary = await get('/api/usage-summary');
    let start = Date.now() - 30 * 86400000, end = Date.now();
    try { const j = JSON.parse(summary.body); start = Date.parse(j.billingCycleStart); end = Date.parse(j.billingCycleEnd); } catch {}
    return {
      summary,
      aggregated: await post('/api/dashboard/get-aggregated-usage-events', { teamId: 0, startDate: String(start), endDate: String(end) }),
      aggregatedNoTeam: await post('/api/dashboard/get-aggregated-usage-events', { startDate: String(start), endDate: String(end) }),
      events: await post('/api/dashboard/get-filtered-usage-events', { teamId: 0, startDate: String(start), endDate: String(end), page: 1, pageSize: 3 }),
      planUsage: await post('/api/dashboard/get-plan-usage', {}),
      sand: await post('/api/dashboard/get-sand-usage-status', {}),
    };
  })()`);
  for (const [k, v] of Object.entries(out)) {
    if (!v) continue;
    console.log(`\n===== ${k} (${v.status}) =====`);
    console.log(redact(v.body));
  }
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
