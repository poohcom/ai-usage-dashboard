'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  refreshIntervalSec: 300,
  enabled: { claude: true, chatgpt: true, cursor: true, gemini: true, perplexity: true, grok: true },
  grokModels: ['grok-4', 'grok-3'],
  language: 'auto', // auto | ko | en
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { ...DEFAULTS, ...raw, enabled: { ...DEFAULTS.enabled, ...(raw.enabled || {}) } };
  } catch {
    cache = { ...DEFAULTS, enabled: { ...DEFAULTS.enabled } };
  }
  return cache;
}

function save(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  if (patch.enabled) next.enabled = { ...cur.enabled, ...patch.enabled };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('settings save failed', e);
  }
  return cache;
}

module.exports = { load, save, DEFAULTS };
