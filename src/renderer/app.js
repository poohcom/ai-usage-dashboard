'use strict';
(async () => {
  const grid = document.getElementById('grid');
  const tpl = document.getElementById('cardTpl');
  const cards = new Map(); // id -> { el, meta, result }
  let settings = null;

  // ---- i18n ----
  const { locale, dict } = await window.api.i18n();
  const fmt = (s, p) => String(s).replace(/\{(\w+)\}/g, (_, k) => (p && p[k] !== undefined && p[k] !== null ? p[k] : ''));
  const t = (key, p) => fmt(dict[key] ?? key, p);
  const LANG = locale === 'ko' ? 'ko-KR' : 'en-US';
  document.documentElement.lang = locale;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('#interval option')) el.textContent = t('ui.min', { n: el.dataset.min });

  const providersRaw = await window.api.providers();
  const init = await window.api.getState();
  settings = init.settings;

  // 저장된 순서대로 정렬 (목록에 없는 새 provider 는 뒤에 붙임)
  const savedOrder = Array.isArray(settings.order) ? settings.order : [];
  const providers = [...providersRaw].sort((a, b) => {
    const ia = savedOrder.indexOf(a.id), ib = savedOrder.indexOf(b.id);
    return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
  });

  // ---- 드래그로 카드 순서 바꾸기 ----
  let dragId = null;
  function clearDropMarks() {
    for (const c of grid.querySelectorAll('.card')) c.classList.remove('drop-before', 'drop-after');
  }
  function dropSide(target, e) {
    // 같은 줄이면 좌/우, 다른 줄이면 위/아래 기준으로 앞/뒤 판정
    const r = target.getBoundingClientRect();
    const dragEl = grid.querySelector(`.card[data-id="${dragId}"]`);
    const sameRow = dragEl && Math.abs(dragEl.getBoundingClientRect().top - r.top) < r.height / 2;
    if (sameRow) return e.clientX < r.left + r.width / 2 ? 'before' : 'after';
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
  }
  async function saveOrder() {
    const order = [...grid.querySelectorAll('.card')].map((c) => c.dataset.id);
    settings = await window.api.setSettings({ order });
  }
  function attachDrag(el) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      // 버튼/입력 요소에서 시작한 드래그는 무시 (카드 머리글이나 빈 영역에서만)
      if (e.target.closest('button, input, select, label, pre')) { e.preventDefault(); return; }
      dragId = el.dataset.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch { /* 일부 환경 */ }
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearDropMarks();
      dragId = null;
    });
    el.addEventListener('dragover', (e) => {
      if (!dragId || dragId === el.dataset.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      el.classList.add(dropSide(el, e) === 'before' ? 'drop-before' : 'drop-after');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      if (!dragId || dragId === el.dataset.id) return;
      e.preventDefault();
      const dragEl = grid.querySelector(`.card[data-id="${dragId}"]`);
      if (!dragEl) return;
      const side = dropSide(el, e);
      grid.insertBefore(dragEl, side === 'before' ? el : el.nextSibling);
      clearDropMarks();
      saveOrder();
    });
  }
  grid.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
  grid.addEventListener('drop', (e) => {
    // 카드 밖(빈 공간)에 놓으면 맨 뒤로
    if (!dragId || e.target.closest('.card')) return;
    e.preventDefault();
    const dragEl = grid.querySelector(`.card[data-id="${dragId}"]`);
    if (dragEl) { grid.appendChild(dragEl); saveOrder(); }
    clearDropMarks();
  });

  document.getElementById('interval').value = String(settings.refreshIntervalSec || 300);
  document.getElementById('interval').addEventListener('change', async (e) => {
    settings = await window.api.setSettings({ refreshIntervalSec: Number(e.target.value) });
  });
  document.getElementById('language').value = settings.language || 'auto';
  document.getElementById('language').addEventListener('change', async (e) => {
    settings = await window.api.setSettings({ language: e.target.value }); // 메인이 화면을 다시 불러온다
  });
  document.getElementById('refreshAll').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await window.api.refreshAll(); } finally { e.target.disabled = false; }
  });

  // ---- 설정 패널 ----
  const overlay = document.getElementById('settingsOverlay');
  const providerToggles = document.getElementById('providerToggles');
  function isEnabled(id) { return settings.enabled?.[id] !== false; }
  function applyVisibility() {
    for (const [id, card] of cards) {
      card.el.hidden = !isEnabled(id);
    }
  }
  function openSettings() { overlay.hidden = false; }
  function closeSettings() { overlay.hidden = true; }
  document.getElementById('openSettings').addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeSettings();
  });

  function buildProviderToggles() {
    providerToggles.innerHTML = '';
    for (const p of providers) {
      const row = document.createElement('label');
      row.className = 'provider-toggle';
      const left = document.createElement('span');
      left.className = 'left';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      left.append(dot, name);
      if (p.beta) {
        const badge = document.createElement('span');
        badge.className = 'beta-badge';
        badge.textContent = t('ui.beta');
        left.appendChild(badge);
      }
      const toggle = document.createElement('span');
      toggle.className = 'toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.id = p.id;
      input.checked = isEnabled(p.id);
      const knob = document.createElement('span');
      toggle.append(input, knob);
      row.append(left, toggle);
      input.addEventListener('change', async () => {
        settings = await window.api.setSettings({ enabled: { [p.id]: input.checked } });
        applyVisibility();
        if (input.checked) window.api.refreshOne(p.id);
      });
      providerToggles.appendChild(row);
    }
  }

  function fmtDuration(ms) {
    if (ms <= 0) return t('ui.reset');
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (d > 0) return t('ui.d', { d, h, m });
    if (h > 0) return t('ui.h', { h, m, s: pad(sec) });
    return t('ui.m', { m, s: pad(sec) });
  }
  function fmtTime(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
    return sameDay ? time : `${d.toLocaleDateString(LANG, { month: 'numeric', day: 'numeric' })} ${time}`;
  }
  function fmtAgo(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return t('ui.secAgo', { n: s });
    if (s < 3600) return t('ui.minAgo', { n: Math.floor(s / 60) });
    return fmtTime(ms);
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function makeCard(meta) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = meta.id;
    el.querySelector('.name').textContent = meta.name;
    el.querySelector('.dot').style.background = meta.color;
    if (meta.beta) {
      const badge = document.createElement('span');
      badge.className = 'beta-badge';
      badge.textContent = t('ui.beta');
      el.querySelector('.title').insertBefore(badge, el.querySelector('.badge.plan'));
    }
    el.querySelector('.card-head').title = t('ui.dragTitle');
    el.querySelector('.refresh').title = t('ui.refreshTitle');
    el.querySelector('.logout').textContent = t('ui.logout');
    el.querySelector('.raw').textContent = t('ui.raw');
    el.hidden = !isEnabled(meta.id);
    el.querySelector('.refresh').addEventListener('click', () => window.api.refreshOne(meta.id));
    const login = el.querySelector('.login');
    login.textContent = meta.loginLabel || t('ui.login');
    if (!meta.canLogin) login.hidden = true;
    login.addEventListener('click', () => window.api.openLogin(meta.id));
    el.querySelector('.logout').addEventListener('click', async () => {
      if (confirm(t('ui.confirmClear', { name: meta.name }))) await window.api.clearLogin(meta.id);
    });
    el.querySelector('.raw').addEventListener('click', () => {
      const box = el.querySelector('.rawbox');
      box.hidden = !box.hidden;
    });
    attachDrag(el);
    grid.appendChild(el);
    return { el, meta, result: null };
  }

  function render(card) {
    const { el, meta, result } = card;
    const body = el.querySelector('.body');
    const extra = el.querySelector('.extra');
    const plan = el.querySelector('.plan');
    const account = el.querySelector('.account');
    const source = el.querySelector('.source');
    const fetched = el.querySelector('.fetched');
    const raw = el.querySelector('.rawbox');
    body.innerHTML = ''; extra.innerHTML = '';
    body.classList.remove('show-all');
    plan.textContent = ''; account.textContent = ''; source.textContent = '';
    el.classList.remove('loading');

    if (!result) {
      body.innerHTML = `<div class="msg">${escape(meta.loginHint || '')}</div>`;
      fetched.textContent = '';
      raw.textContent = '';
      return;
    }
    fetched.textContent = result.fetchedAt ? t('ui.fetched', { ago: fmtAgo(result.fetchedAt) }) : '';
    raw.textContent = result.raw ? JSON.stringify(result.raw, null, 2) : t('ui.noRaw');

    if (!result.ok) {
      const cls = result.needsLogin ? 'login' : 'err';
      body.innerHTML = `<div class="msg ${cls}">${escape(result.error || t('ui.unknownError'))}</div>` +
        (result.needsLogin && meta.canLogin ? `<div class="msg">${escape(t('ui.loginHintBtn', { btn: meta.loginLabel || t('ui.login') }))}</div>` : '') +
        (!result.needsLogin && meta.loginHint ? `<div class="msg">${escape(meta.loginHint)}</div>` : '');
      return;
    }
    if (result.plan) plan.textContent = result.plan;
    if (result.account) account.textContent = result.account;
    if (result.source) source.textContent = result.source;

    const SHOW_MAX = 5; // 섹션 아래 비중 행은 상위 5개만 기본 표시
    let shareCount = 0;
    let moreBtn = null;
    for (const w of result.windows) {
      if (w.kind === 'section') {
        const h = document.createElement('div');
        h.className = 'section';
        h.textContent = w.label;
        body.appendChild(h);
        shareCount = 0;
        moreBtn = null;
        continue;
      }
      if (w.kind === 'share') {
        shareCount++;
        if (shareCount > SHOW_MAX) {
          if (!moreBtn) {
            moreBtn = document.createElement('button');
            moreBtn.className = 'link more';
            body.appendChild(moreBtn);
            const btn = moreBtn;
            btn.addEventListener('click', () => {
              const open = body.classList.toggle('show-all');
              btn.textContent = open ? t('ui.less') : btn.dataset.label;
            });
          }
          moreBtn.dataset.label = t('ui.more', { n: shareCount - SHOW_MAX });
          moreBtn.textContent = moreBtn.dataset.label;
        }
      }
      const row = document.createElement('div');
      row.className = 'row' + (w.kind === 'share' ? ' share' : '') + (w.kind === 'share' && shareCount > SHOW_MAX ? ' overflow' : '');
      row.dataset.reset = w.resetAt || '';
      const pct = typeof w.usedPct === 'number' ? w.usedPct : null;
      const level = w.kind === 'share' ? 'share' : pct == null ? 'unknown' : pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : '';
      const pctText = pct == null ? (w.detail ? '' : '-') : w.kind === 'share' ? t('ui.share', { pct }) : t('ui.used', { pct });
      row.innerHTML = `
        <div class="top"><span class="label">${escape(w.label)}</span><span class="pct">${pctText}</span></div>
        <div class="bar ${level}"><i style="width:${pct == null ? 100 : pct}%"></i></div>
        <div class="bottom"><span class="detail">${escape(w.detail || '')}</span><span class="reset"></span></div>`;
      if (moreBtn && row.classList.contains('overflow')) body.insertBefore(row, moreBtn);
      else body.appendChild(row);
      row._note = w.note || '';
    }
    for (const x of result.extra || []) {
      const s = document.createElement('span');
      s.textContent = x.value ? `${x.label}: ${x.value}` : x.label;
      extra.appendChild(s);
    }
    tick();
  }

  // 1초마다 리셋 카운트다운 갱신
  function tick() {
    const now = Date.now();
    for (const row of document.querySelectorAll('.row')) {
      const reset = Number(row.dataset.reset);
      const el = row.querySelector('.reset');
      if (!reset) { el.textContent = row._note || ''; continue; }
      const left = reset - now;
      el.textContent = left <= 0 ? t('ui.resetRefresh') : t('ui.resetIn', { dur: fmtDuration(left), time: fmtTime(reset) });
      el.classList.toggle('soon', left > 0 && left < 15 * 60 * 1000);
    }
    let latest = 0;
    for (const c of cards.values()) if (c.result && c.result.fetchedAt) latest = Math.max(latest, c.result.fetchedAt);
    document.getElementById('lastRefresh').textContent = latest ? t('ui.lastFetched', { ago: fmtAgo(latest) }) : t('ui.fetching');
    for (const c of cards.values()) {
      const f = c.el.querySelector('.fetched');
      if (c.result && c.result.fetchedAt) f.textContent = t('ui.fetched', { ago: fmtAgo(c.result.fetchedAt) });
    }
  }
  setInterval(tick, 1000);

  for (const p of providers) {
    const card = makeCard(p);
    card.result = init.state[p.id] || null;
    cards.set(p.id, card);
    render(card);
  }
  buildProviderToggles();
  applyVisibility();

  window.api.onLoading(({ id }) => {
    const c = cards.get(id);
    if (c) c.el.classList.add('loading');
  });
  window.api.onUpdate(({ id, result }) => {
    const c = cards.get(id);
    if (!c) return;
    c.result = result;
    render(c);
  });
})();
