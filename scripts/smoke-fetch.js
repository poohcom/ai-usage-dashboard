'use strict';
// 헤드리스 스모크: 모든 provider fetch 후 요약 출력하고 종료
process.env.AIUSAGE_DEBUG = process.env.AIUSAGE_DEBUG || '1';

const { app } = require('electron');
const path = require('path');

// main 과 동일하게 userData 아래에서 settings 로드되도록
app.setName('ai-usage-dashboard-smoke');

app.whenReady().then(async () => {
  const { providers } = require('../src/providers');
  const site = require('../src/lib/siteSession');
  const results = [];

  // 동시성 제한 (숨김 창이 너무 많이 뜨지 않게)
  const queue = [...providers];
  const workers = 4;
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const started = Date.now();
      let result;
      try {
        result = await p.fetch();
      } catch (e) {
        result = { ok: false, needsLogin: !!e.needsLogin, error: e.message || String(e) };
      }
      results.push({
        id: p.id,
        beta: !!p.beta,
        ok: !!result.ok,
        needsLogin: !!result.needsLogin,
        error: result.error || null,
        windows: (result.windows && result.windows.length) || 0,
        ms: Date.now() - started,
      });
      console.log(`[smoke] ${p.id}: ok=${!!result.ok} login=${!!result.needsLogin} win=${(result.windows||[]).length} ${result.error || ''}`);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));

  console.log('\n=== SMOKE SUMMARY ===');
  for (const r of results) {
    const tag = r.ok ? 'OK' : (r.needsLogin ? 'LOGIN' : 'FAIL');
    console.log(`${r.beta ? 'BETA' : '    '} ${r.id.padEnd(14)} ${tag.padEnd(6)} ${r.ms}ms  ${r.error || (r.windows + ' windows')}`);
  }
  site.destroyAll();
  app.exit(0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
