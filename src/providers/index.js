'use strict';
const { t } = require('../lib/i18n');

const providers = [
  require('./claude'),
  require('./chatgpt'),
  require('./cursor'),
  require('./gemini'),
  require('./perplexity'),
  require('./grok'),
  require('./higgsfield'),
  ...require('./extras'),
];

const byId = Object.fromEntries(providers.map((p) => [p.id, p]));

function nameOf(p) { return t(p.nameKey); }

/** 렌더러용 메타 (현재 언어로 번역된 문자열 포함) */
function meta() {
  return providers.map((p) => ({
    id: p.id,
    name: nameOf(p),
    color: p.color,
    loginUrl: p.loginUrl,
    loginHint: t(p.hintKey),
    canLogin: !!(p.loginUrl || typeof p.login === 'function'),
    loginLabel: p.loginLabelKey ? t(p.loginLabelKey) : t('ui.login'),
    beta: !!p.beta,
  }));
}

module.exports = { providers, byId, meta, nameOf };
