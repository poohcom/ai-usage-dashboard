'use strict';
const { app } = require('electron');
app.setName('AI Usage Dashboard');
app.whenReady().then(async () => {
  const site = require('../src/lib/siteSession');
  const ses = site.getSession('higgsfield');
  const all = await ses.cookies.get({});
  const hf = all.filter((c) => /higgsfield|clerk/i.test(c.domain || '') || /session|client|datadome|clerk/i.test(c.name));
  console.log('userData', app.getPath('userData'));
  console.log('count', hf.length);
  for (const c of hf) {
    console.log(JSON.stringify({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, prefix: String(c.value || '').slice(0, 12) }));
  }
  const p = require('../src/providers/higgsfield');
  const r = await p.fetch();
  console.log('result', JSON.stringify({ ok: r.ok, needsLogin: r.needsLogin, error: r.error, windows: (r.windows || []).length, account: r.account, plan: r.plan }));
  if (r.windows) console.log('windows', JSON.stringify(r.windows.slice(0, 6)));
  if (r.raw) console.log('raw', JSON.stringify(r.raw).slice(0, 800));
  site.destroyAll();
  app.exit(r.ok ? 0 : 2);
}).catch((e) => { console.error(e); app.exit(1); });
