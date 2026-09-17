'use strict';
// 디버그/문서용: 목업 데이터 HTML 을 띄워 레이아웃 지표와 스크린샷을 얻는다.
// 실행: npx electron scripts/mock-shot.js <out.png> [ko|en]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/lib/i18n');

app.whenReady().then(async () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-') && !/mock-shot\.js$/.test(a));
  const out = args[0] || 'mock.png';
  i18n.setLocale(args[1] || 'auto', app.getLocale());
  const w = new BrowserWindow({ width: 1180, height: 820, show: false, webPreferences: { sandbox: true } });
  w.webContents.on('dom-ready', () => {
    w.webContents.executeJavaScript(`window.__setDict(${JSON.stringify(i18n.dictionary())})`).catch(() => {});
  });
  await w.loadFile(path.join(__dirname, 'mock.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const info = await w.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('.card')].map(c => ({ id: c.dataset.id, h: c.offsetHeight, top: Math.round(c.getBoundingClientRect().top) }));
    const g = document.getElementById('grid');
    return { cards, gridH: g.offsetHeight, rows: getComputedStyle(g).gridTemplateRows };
  })()`);
  console.log(JSON.stringify(info));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
