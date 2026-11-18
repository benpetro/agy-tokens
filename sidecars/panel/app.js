(() => {
  const params = new URLSearchParams(location.search);
  let selectedConvId = '';
  let activeTab = 'conv';
  let timerId = null;
  let lastDashData = null;
  let sortKey = 'updatedAt';
  let sortDir = 'desc';

  const el = {
    convTitleText: document.getElementById('conv-title-text'),
    convTitleLink: document.getElementById('conv-title-link'),
    convGradeWrap: document.getElementById('conv-grade-wrap'),
    convGrade: document.getElementById('conv-grade'),
    convGradeTooltip: document.getElementById('conv-grade-tooltip'),
    emptyState: document.getElementById('empty-state'),
    kpiTotal: document.getElementById('kpi-total'),
    kpiSteps: document.getElementById('kpi-steps'),
    kpiQuotaShare: document.getElementById('kpi-quota-share'),
    kpiQuotaSub: document.getElementById('kpi-quota-sub'),
    kpiInput: document.getElementById('kpi-input'),
    kpiInputSub: document.getElementById('kpi-input-sub'),
    kpiOutput: document.getElementById('kpi-output'),
    kpiContextSub: document.getElementById('kpi-context-sub'),
    cacheRateText: document.getElementById('cache-rate-text'),
    cacheRateBar: document.getElementById('cache-rate-bar'),
    turnsBody: document.getElementById('turns-body'),
    tabConv: document.getElementById('tab-conv'),
    tabDash: document.getElementById('tab-dash'),
    viewConv: document.getElementById('view-conv'),
    viewDash: document.getElementById('view-dash'),
    dashQuotaLeft: document.getElementById('dash-quota-left'),
    dashQuotaReset: document.getElementById('dash-quota-reset'),
    dashTotalTokens: document.getElementById('dash-total-tokens'),
    dashConvCount: document.getElementById('dash-conv-count'),
    dashBody: document.getElementById('dash-body'),
    infoQuote: document.getElementById('info-quote'),
  };

  const TIPS = Array.isArray(window.AGY_TOKEN_TIPS) ? window.AGY_TOKEN_TIPS : [];
  let tipIndex = TIPS.length > 0 ? Math.floor(Math.random() * TIPS.length) : 0;

  function renderTip() {
    if (el.infoQuote && TIPS.length > 0) {
      el.infoQuote.innerHTML = TIPS[tipIndex];
    }
  }

  function activeConvId() {
    return selectedConvId || window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  function canOpenConversation() {
    return typeof window.sidecar?.ui?.toggleConversation === 'function';
  }

  function openConversation(convId) {
    if (convId && canOpenConversation()) {
      window.sidecar.ui.toggleConversation(convId);
    }
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString();
  }

  function fmtCompact(n) {
    const num = Number(n || 0);
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 10_000) return `${(num / 1_000).toFixed(1)}k`;
    return fmt(num);
  }

  function fmtPct(fraction, prefix = '') {
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '—';
    return `${prefix}${(fraction * 100).toFixed(1)}%`;
  }

  function shortId(id) {
    return id ? id.slice(0, 8) : '—';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtReset(iso) {
    if (!iso) return 'reset time unknown';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'reset time unknown';
    const diffMin = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
    if (diffMin < 60) return `resets in ${diffMin}m`;
    const hrs = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return `resets in ${hrs}h ${mins}m`;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function switchTab(tab) {
    activeTab = tab;
    const isConv = tab === 'conv';
    el.tabConv.classList.toggle('active', isConv);
    el.tabDash.classList.toggle('active', !isConv);
    el.tabConv.setAttribute('aria-selected', String(isConv));
    el.tabDash.setAttribute('aria-selected', String(!isConv));
    el.viewConv.classList.toggle('hidden', !isConv);
    el.viewDash.classList.toggle('hidden', isConv);
    refresh();
  }

  function renderUsage(data) {
    const convId = data.conversationId || activeConvId();
    const title = data.title || 'Untitled conversation';
    el.convTitleText.textContent = title;
    el.convTitleText.title = title;
    el.convTitleLink.classList.toggle('hidden', !(convId && canOpenConversation()));

    const rating = data.totals?.rating;
    el.convGrade.classList.remove('grade-a', 'grade-b', 'grade-c', 'grade-d');
    if (rating?.grade) {
      el.convGrade.textContent = `Rating: ${rating.grade}`;
      el.convGrade.classList.add(`grade-${rating.grade.toLowerCase()}`);
      el.convGradeWrap.classList.remove('hidden');
      const cachePct = Math.round((data.totals.cacheHitRate || 0) * 100);
      const errPct = Math.round((rating.errorRate || 0) * 100);
      el.convGradeTooltip.innerHTML =
        `<strong>Efficiency ${rating.grade} (${rating.score}/100)</strong><br>` +
        `${rating.advice}<br>` +
        `<span style="opacity:0.75">${cachePct}% cache · ${errPct}% errors</span>`;
    } else {
      el.convGradeWrap.classList.add('hidden');
    }

    const t = data.totals || {};
    el.emptyState.classList.toggle('hidden', Boolean(data.found && t.stepCount > 0));

    el.kpiTotal.textContent = fmt(t.totalTokens);
    const msgCount = data.promptTurns?.length || 0;
    const msgLabel = `${fmt(msgCount)} ${msgCount === 1 ? 'message' : 'messages'}`;
    el.kpiSteps.textContent =
      t.subagentCount > 0
        ? `${msgLabel} · +${t.subagentCount} ${t.subagentCount === 1 ? 'subagent' : 'subagents'} (${fmtCompact(t.subagentTokens)})`
        : msgLabel;

    if (typeof data.estQuotaShare === 'number' && data.quota) {
      el.kpiQuotaShare.textContent = fmtPct(data.estQuotaShare, '~');
      el.kpiQuotaSub.textContent = `${fmtPct(data.quota.remainingFraction)} left · ${fmtReset(data.quota.resetTime)}`;
    } else if (data.quota) {
      el.kpiQuotaShare.textContent = '0.0%';
      el.kpiQuotaSub.textContent = `${fmtPct(data.quota.remainingFraction)} left · ${fmtReset(data.quota.resetTime)}`;
    } else {
      el.kpiQuotaShare.textContent = '—';
      el.kpiQuotaSub.textContent = 'quota API unavailable';
    }

    el.kpiInput.textContent = fmt(t.inputTokens);
    el.kpiInputSub.textContent = `${fmt(t.uncachedInputTokens)} uncached · ${fmt(t.cacheReadTokens)} cached`;
    el.kpiOutput.textContent = fmt(t.outputTokens);
    el.kpiContextSub.textContent = `${fmt(t.latestContextTokens)} last context`;

    const pct = ((t.cacheHitRate || 0) * 100).toFixed(1);
    el.cacheRateText.textContent = `${pct}%`;
    el.cacheRateBar.style.width = `${Math.min(100, Math.max(0, Number(pct)))}%`;

    const turns = Array.isArray(data.promptTurns) ? [...data.promptTurns].reverse() : [];
    el.turnsBody.innerHTML = '';
    for (const turn of turns) {
      const tr = document.createElement('tr');
      const tdPrompt = document.createElement('td');
      tdPrompt.className = 'prompt-cell';
      tdPrompt.textContent = turn.prompt || '—';
      tdPrompt.title = turn.prompt || '';
      tr.appendChild(tdPrompt);

      const tdModel = document.createElement('td');
      tdModel.className = 'model-cell';
      tdModel.textContent = turn.model || '—';
      tdModel.title = turn.model || 'Model unavailable (not in LS memory)';
      tr.appendChild(tdModel);

      const cells = [
        fmt(turn.uncachedInputTokens),
        fmt(turn.cacheReadTokens),
        fmt(turn.outputTokens),
        fmt(turn.toolCallCount),
        fmtTime(turn.createdAt),
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      el.turnsBody.appendChild(tr);
    }
  }

  function getSortValue(item, key) {
    switch (key) {
      case 'title':
        return (item.title || '').toLowerCase();
      case 'rating':
        return item.totals?.rating?.score ?? -1;
      case 'updatedAt':
        return item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
      case 'tokens':
        return item.totals?.totalTokens || 0;
      case 'cache':
        return item.totals?.cacheHitRate || 0;
      case 'share':
        return item.shareOfTotal || 0;
      case 'limit':
        return item.estQuotaShare ?? -1;
      default:
        return 0;
    }
  }

  function updateSortIndicators() {
    for (const th of document.querySelectorAll('.dash-table th.sortable')) {
      const ind = th.querySelector('.sort-ind');
      if (!ind) continue;
      if (th.dataset.sort === sortKey) {
        ind.textContent = sortDir === 'asc' ? '▲' : '▼';
      } else {
        ind.textContent = '';
      }
    }
  }

  function renderDashboard(data) {
    lastDashData = data;
    const agg = data.aggregate || {};
    if (data.quota) {
      el.dashQuotaLeft.textContent = fmtPct(data.quota.remainingFraction);
      el.dashQuotaReset.textContent = `${fmtPct(data.quota.usedFraction)} used · ${fmtReset(data.quota.resetTime)}`;
    } else {
      el.dashQuotaLeft.textContent = '—';
      el.dashQuotaReset.textContent = 'quota API unavailable';
    }

    el.dashTotalTokens.textContent = fmtCompact(agg.totalTokens);
    el.dashConvCount.textContent = `${fmt(agg.conversationCount)} conversations (last ${data.days || 7}d)`;

    updateSortIndicators();
    const current = activeConvId();
    const rawList = Array.isArray(data.conversations) ? [...data.conversations] : [];
    const dirMul = sortDir === 'asc' ? 1 : -1;
    const list = rawList.sort((a, b) => {
      const va = getSortValue(a, sortKey);
      const vb = getSortValue(b, sortKey);
      if (va < vb) return -1 * dirMul;
      if (va > vb) return 1 * dirMul;
      return 0;
    });

    el.dashBody.innerHTML = '';

    for (const item of list) {
      const tr = document.createElement('tr');
      tr.title = `Inspect ${item.title || item.conversationId}`;
      tr.addEventListener('click', () => {
        selectedConvId = item.conversationId;
        switchTab('conv');
      });

      const tdName = document.createElement('td');
      tdName.className = 'conv-title-cell';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'conv-title-text';
      titleSpan.textContent = item.title || 'Untitled conversation';
      const subSpan = document.createElement('span');
      subSpan.className = 'conv-id-sub';
      const ws = item.workspaceName || 'No workspace';
      const parts = [ws];
      if (item.conversationId === current) parts.push('active');
      if (item.totals?.subagentCount > 0) {
        parts.push(`${item.totals.subagentCount} ${item.totals.subagentCount === 1 ? 'subagent' : 'subagents'}`);
      }
      subSpan.textContent = parts.join(' · ');
      tdName.append(titleSpan, subSpan);

      const tdRating = document.createElement('td');
      const r = item.totals?.rating;
      if (r?.grade) {
        const badge = document.createElement('span');
        badge.className = `dash-grade-badge grade-${r.grade.toLowerCase()}`;
        badge.textContent = r.grade;
        badge.title = `Efficiency ${r.grade} (${r.score}/100)`;
        tdRating.appendChild(badge);
      } else {
        tdRating.textContent = '—';
      }

      const tdUpdated = document.createElement('td');
      tdUpdated.textContent = fmtDateShort(item.updatedAt);

      const tdTokens = document.createElement('td');
      tdTokens.textContent = fmtCompact(item.totals.totalTokens);

      const tdCache = document.createElement('td');
      tdCache.textContent = fmtPct(item.totals.cacheHitRate);

      const tdShare = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'share-bar-wrap';
      const pctLabel = document.createElement('span');
      pctLabel.textContent = fmtPct(item.shareOfTotal);
      const track = document.createElement('div');
      track.className = 'share-track';
      const fill = document.createElement('div');
      fill.className = 'share-fill';
      fill.style.width = `${Math.min(100, Math.round((item.shareOfTotal || 0) * 100))}%`;
      track.appendChild(fill);
      wrap.append(pctLabel, track);
      tdShare.appendChild(wrap);

      const tdLimit = document.createElement('td');
      tdLimit.textContent = fmtPct(item.estQuotaShare, '~');

      const tdAction = document.createElement('td');
      if (canOpenConversation()) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-xs';
        btn.textContent = 'View';
        btn.title = 'Open conversation in Antigravity';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openConversation(item.conversationId);
        });
        tdAction.appendChild(btn);
      }

      tr.append(tdName, tdRating, tdUpdated, tdTokens, tdCache, tdShare, tdLimit, tdAction);
      el.dashBody.appendChild(tr);
    }
  }

  async function refresh() {
    try {
      if (activeTab === 'dash') {
        const data = await fetchJson('/api/dashboard?days=7');
        renderDashboard(data);
      } else {
        const conv = activeConvId();
        const q = conv ? `?conversationId=${encodeURIComponent(conv)}` : '';
        const data = await fetchJson(`/api/usage${q}`);
        renderUsage(data);
      }
    } catch {
      // Polling will retry on the next interval.
    }
  }

  el.tabConv.addEventListener('click', () => switchTab('conv'));
  el.tabDash.addEventListener('click', () => switchTab('dash'));
  for (const th of document.querySelectorAll('.dash-table th.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = key === 'title' ? 'asc' : 'desc';
      }
      if (lastDashData) renderDashboard(lastDashData);
    });
  }
  el.convTitleLink.addEventListener('click', () => openConversation(activeConvId()));
  el.infoQuote?.addEventListener('click', () => {
    tipIndex = (tipIndex + 1) % TIPS.length;
    renderTip();
  });

  renderTip();
  refresh();
  timerId = setInterval(refresh, 10000);
})();
