'use strict';
// 메인 프로세스에서 토큰 기반 API 를 호출할 때 쓰는 얇은 fetch 래퍼
const { net } = require('electron');

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ok: res.ok, json, text: json ? undefined : text.slice(0, 2000) };
  } finally {
    clearTimeout(t);
  }
}

/** 다양한 형식의 시각 값을 epoch ms 로 정규화 */
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // 초 단위면 ms 로
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v)) return toMs(Number(v));
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

function clampPct(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

module.exports = { request, toMs, clampPct };
