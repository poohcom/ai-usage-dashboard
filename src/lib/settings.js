'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  refreshIntervalSec: 300,
  enabled: {
    claude: true, chatgpt: true, cursor: true, gemini: true, perplexity: true, grok: true,
    copilot: true, midjourney: true, deepseek: true, openrouter: true, elevenlabs: true,
    runway: true, kling: true, veo: true, higgsfield: true, suno: true,
    luma: true, pika: true, hailuo: true, seedance: true,
  },
  grokModels: ['grok-4', 'grok-3'],
  language: 'auto', // auto | ko | en
  order: [], // 카드 표시 순서 (provider id 배열, 비어 있으면 기본 순서)
};

/** 디스크에 쓰지 않는 키 (비밀·캐시) */
const DENY_PERSIST = new Set(['antigravityClients']);

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function scrub(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of DENY_PERSIST) delete out[k];
  return out;
}

function persist(data) {
  const safe = scrub(data);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(safe, null, 2));
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const hadSecrets = !!raw.antigravityClients;
    cache = scrub({ ...DEFAULTS, ...raw, enabled: { ...DEFAULTS.enabled, ...(raw.enabled || {}) } });
    // 예전 평문 client_secret 이 남아 있으면 파일에서 제거
    if (hadSecrets) {
      try { persist(cache); } catch { /* */ }
    }
  } catch {
    cache = { ...DEFAULTS, enabled: { ...DEFAULTS.enabled } };
  }
  return cache;
}

function save(patch) {
  const cur = load();
  const next = scrub({ ...cur, ...patch });
  if (patch && patch.enabled) next.enabled = { ...cur.enabled, ...patch.enabled };
  cache = next;
  try {
    persist(next);
  } catch (e) {
    console.error('settings save failed', e);
  }
  return cache;
}

module.exports = { load, save, DEFAULTS };
