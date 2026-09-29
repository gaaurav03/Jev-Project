(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  let loading = false;

  function setText(id, value) {
    const node = byId(id);
    if (node) node.textContent = value;
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function formatNumber(value) {
    return number(value) === null ? '—' : integer.format(value);
  }

  function formatPercent(value) {
    return number(value) === null ? '—' : `${decimal.format(value * 100)}%`;
  }

  function formatLatency(value) {
    return number(value) === null ? '—' : `${decimal.format(value)} ms`;
  }

  function formatCost(value) {
    if (number(value) === null) return 'unknown';
    return value === 0 ? '$0.00' : `$${value.toFixed(Math.max(2, Math.min(6, String(value).length - 2)))}`;
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date);
  }

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  async function fetchJson(path) {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('The server returned malformed dashboard data.');
    }
    if (!response.ok) {
      const message = object(body) && typeof body.error === 'string' ? body.error : 'Dashboard request failed.';
      throw new Error(message);
    }
    return body;
  }

  function validateSummary(value) {
    const summary = object(value);
    if (!summary || !object(summary.cards) || !object(summary.comparison) || !Array.isArray(summary.trends)) {
      throw new Error('The summary response has an unexpected shape.');
    }
    if (!object(summary.comparison.jev) || !object(summary.comparison.local)) {
      throw new Error('The comparison response has an unexpected shape.');
    }
    return summary;
  }

  function validateRunList(value) {
    const list = object(value);
    if (!list || !Array.isArray(list.runs) || number(list.returned) === null || number(list.available) === null) {
      throw new Error('The run-history response has an unexpected shape.');
    }
    return list;
  }

  function applyTheme(theme, save) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#141517' : '#eef0ea');
    byId('theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    if (save) {
      try { localStorage.setItem('jev-dashboard-theme', theme); } catch { /* private mode */ }
    }
  }

  function initialTheme() {
    try {
      const saved = localStorage.getItem('jev-dashboard-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* private mode */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function renderSummary(summary) {
    const cards = summary.cards;
    setText('tokens-saved', formatNumber(cards.estimatedTokensSaved));
    setText('average-reduction', formatPercent(cards.averageReduction));
    setText('critical-retention', formatPercent(cards.criticalRetention));
    setText('task-pass-rate', formatPercent(cards.taskPassRate));
    byId('overview-cards').setAttribute('aria-busy', 'false');

    renderMode('jev', summary.comparison.jev);
    renderMode('local', summary.comparison.local);
    setText('api-requests', formatNumber(cards.requests));
    setText('known-cost', formatCost(cards.knownCostUsd));
    setText('input-tokens', cards.apiUsage ? formatNumber(cards.apiUsage.inputTokens) : 'unknown');
    setText('output-tokens', cards.apiUsage ? formatNumber(cards.apiUsage.outputTokens) : 'unknown');

    const noRetention = number(cards.criticalRetention) === null;
    const noPassRate = number(cards.taskPassRate) === null;
    setText('benchmark-retention', noRetention ? 'No benchmark data yet' : formatPercent(cards.criticalRetention));
    setText('benchmark-pass-rate', noPassRate ? 'No benchmark data yet' : formatPercent(cards.taskPassRate));
    renderTrends(summary.trends);
    byId('page-empty').hidden = summary.totalRuns !== 0;
  }

  function renderMode(mode, values) {
    setText(`${mode}-runs`, `${formatNumber(values.runs)} ${values.runs === 1 ? 'run' : 'runs'}`);
    setText(`${mode}-reduction`, formatPercent(values.averageReduction));
    setText(`${mode}-latency`, formatLatency(values.averageLatencyMs));
    setText(`${mode}-saved`, formatNumber(values.estimatedTokensSaved));
  }

  function chartPath(values, selector) {
    if (values.length === 0) return '';
    return values.map((entry, index) => {
      const x = values.length === 1 ? 372 : 48 + (648 * index / (values.length - 1));
      const y = selector(entry);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  }

  function renderTrends(rawTrends) {
    const trends = rawTrends.filter((trend) => object(trend) && number(trend.estimatedReduction) !== null && number(trend.latencyMs) !== null);
    setText('trend-meta', `latest ${trends.length} measured ${trends.length === 1 ? 'run' : 'runs'}`);
    byId('trend-empty').hidden = trends.length !== 0;
    const reductionLine = byId('reduction-line');
    const latencyLine = byId('latency-line');
    const points = byId('trend-points');
    points.replaceChildren();
    if (trends.length === 0) {
      reductionLine.setAttribute('d', '');
      latencyLine.setAttribute('d', '');
      return;
    }
    const maxLatency = Math.max(...trends.map((trend) => trend.latencyMs), 1);
    const reductionY = (entry) => 256 - Math.min(1, Math.max(0, entry.estimatedReduction)) * 228;
    const latencyY = (entry) => 256 - Math.min(1, entry.latencyMs / maxLatency) * 228;
    reductionLine.setAttribute('d', chartPath(trends, reductionY));
    latencyLine.setAttribute('d', chartPath(trends, latencyY));
    trends.forEach((trend, index) => {
      const x = trends.length === 1 ? 372 : 48 + (648 * index / (trends.length - 1));
      [['reduction', reductionY(trend), formatPercent(trend.estimatedReduction)], ['latency', latencyY(trend), formatLatency(trend.latencyMs)]].forEach(([kind, y, label]) => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('class', `chart-point ${kind}`);
        circle.setAttribute('cx', x.toFixed(1));
        circle.setAttribute('cy', Number(y).toFixed(1));
        circle.setAttribute('r', '4');
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = `${formatTime(trend.timestamp)} · ${label}`;
        circle.append(title);
        points.append(circle);
      });
    });
  }

  function badge(value) {
    return element('span', `badge ${String(value).toLowerCase()}`, String(value));
  }

  function cell(row, value, className) {
    const td = element('td', className, value);
    row.append(td);
    return td;
  }

  function renderRuns(payload) {
    const body = byId('runs-body');
    body.replaceChildren();
    setText('runs-meta', `${payload.returned} shown · ${payload.available} matching`);
    setText('runs-hint', payload.runs.some((run) => typeof run.id === 'string')
      ? 'Select a row for local decision details'
      : 'Public rows omit IDs and decision details');
    if (payload.runs.length === 0) {
      const row = element('tr');
      const message = cell(row, 'No runs match these filters.', 'table-message');
      message.colSpan = 9;
      body.append(row);
      return;
    }
    payload.runs.forEach((run) => {
      const row = element('tr');
      if (typeof run.id === 'string') {
        row.className = 'has-detail';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', `Open details for ${run.id}`);
        row.addEventListener('click', () => openRun(run.id));
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openRun(run.id);
          }
        });
      }
      cell(row, formatTime(run.timestamp));
      cell(row, '').append(badge(run.mode));
      cell(row, run.metrics ? `${formatNumber(run.metrics.estimatedTokensBefore)} / ${formatNumber(run.metrics.estimatedTokensAfter)}` : '—');
      cell(row, run.metrics ? formatPercent(run.metrics.estimatedReduction) : '—');
      const critical = run.metrics && run.metrics.criticalRetention;
      const removed = critical ? critical.required - critical.retained : null;
      cell(row, removed === null ? '—' : `${removed} removed`, removed > 0 ? 'critical-risk' : 'critical-ok');
      cell(row, run.metrics ? formatNumber(run.metrics.requests) : '—');
      cell(row, run.metrics ? formatLatency(run.metrics.latencyMs) : '—');
      cell(row, run.metrics ? formatCost(run.metrics.costUsd) : '—');
      cell(row, '').append(badge(run.status));
      body.append(row);
    });
  }

  function filtersPath() {
    const data = new FormData(byId('run-filters'));
    const search = new URLSearchParams();
    for (const [key, value] of data.entries()) {
      if (typeof value === 'string' && value) search.set(key, value);
    }
    search.set('limit', '50');
    return `/api/runs?${search.toString()}`;
  }

  async function loadRuns() {
    setText('runs-meta', 'loading records…');
    const payload = validateRunList(await fetchJson(filtersPath()));
    renderRuns(payload);
  }

  async function loadAll() {
    if (loading) return;
    loading = true;
    const refresh = byId('refresh-button');
    refresh.disabled = true;
    byId('page-error').hidden = true;
    setText('sync-state', 'refreshing live metrics…');
    try {
      const [summary, runs] = await Promise.all([
        fetchJson('/api/summary').then(validateSummary),
        fetchJson(filtersPath()).then(validateRunList),
      ]);
      renderSummary(summary);
      renderRuns(runs);
      setText('sync-state', `synced ${formatTime(summary.generatedAt)} · ${formatNumber(summary.totalRuns)} total runs`);
    } catch (error) {
      byId('page-error').hidden = false;
      setText('page-error-message', error instanceof Error ? error.message : 'Unable to load dashboard data.');
      setText('sync-state', 'live metrics unavailable');
      const row = element('tr');
      const message = cell(row, 'Run history could not be loaded.', 'table-message');
      message.colSpan = 9;
      byId('runs-body').replaceChildren(row);
    } finally {
      refresh.disabled = false;
      loading = false;
    }
  }

  function detailField(label, value) {
    const wrapper = element('div');
    wrapper.append(element('span', '', label), element('strong', '', value));
    return wrapper;
  }

  async function openRun(id) {
    const dialog = byId('run-detail');
    setText('detail-title', id);
    byId('detail-body').replaceChildren(element('p', '', 'Loading decision metadata…'));
    if (!dialog.open) dialog.showModal();
    try {
      const payload = object(await fetchJson(`/api/runs/${encodeURIComponent(id)}`));
      const run = payload && object(payload.run);
      if (!run || !Array.isArray(run.decisions)) throw new Error('The run detail has an unexpected shape.');
      renderRunDetail(run);
    } catch (error) {
      byId('detail-body').replaceChildren(element('p', 'notice error', error instanceof Error ? error.message : 'Unable to load run detail.'));
    }
  }

  function renderRunDetail(run) {
    const body = byId('detail-body');
    const grid = element('div', 'detail-grid');
    grid.append(
      detailField('mode', String(run.mode)),
      detailField('status', String(run.status)),
      detailField('source', String(run.source)),
      detailField('time', formatTime(run.timestamp)),
    );
    body.replaceChildren(grid);
    if (run.metrics) {
      const metrics = element('div', 'detail-grid');
      metrics.append(
        detailField('before / after', `${formatNumber(run.metrics.estimatedTokensBefore)} / ${formatNumber(run.metrics.estimatedTokensAfter)}`),
        detailField('reduction', formatPercent(run.metrics.estimatedReduction)),
        detailField('latency', formatLatency(run.metrics.latencyMs)),
        detailField('cost', formatCost(run.metrics.costUsd)),
      );
      body.append(metrics);
    }
    if (run.benchmark) {
      body.append(element('p', '', `Benchmark: ${run.benchmark.caseId} · ${run.benchmark.category}`));
    }
    if (run.fallbackReason) body.append(element('p', '', `Fallback reason: ${run.fallbackReason.replaceAll('_', ' ')}`));
    const heading = element('div', 'decision-head');
    heading.append(element('h3', '', 'Tool decisions'), element('span', 'sync-state', `${run.decisions.length} total`));
    body.append(heading);
    if (run.decisions.length === 0) {
      body.append(element('p', 'notice', 'No individual tool decisions were recorded for this run.'));
      return;
    }
    const list = element('div', 'decision-list');
    run.decisions.forEach((decision) => {
      const row = element('div', 'decision');
      row.append(
        element('code', '', `${decision.id} · ${decision.tool}`),
        badge(decision.action === 'drop_call' ? 'removed' : decision.action === 'drop_result' ? 'truncated' : 'kept'),
        element('span', 'decision-reason', String(decision.reason).replaceAll('_', ' ')),
        element('span', 'decision-score', `call ${decimal.format(decision.keepCall)} · result ${decimal.format(decision.keepResult)}`),
      );
      list.append(row);
    });
    body.append(list);
  }

  applyTheme(initialTheme(), false);
  byId('theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });
  byId('refresh-button').addEventListener('click', loadAll);
  byId('run-filters').addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('page-error').hidden = true;
    try { await loadRuns(); } catch (error) {
      byId('page-error').hidden = false;
      setText('page-error-message', error instanceof Error ? error.message : 'Unable to filter runs.');
    }
  });
  byId('reset-filters').addEventListener('click', () => setTimeout(() => loadRuns().catch(() => {}), 0));
  byId('detail-close').addEventListener('click', () => byId('run-detail').close());
  byId('run-detail').addEventListener('click', (event) => {
    if (event.target === byId('run-detail')) byId('run-detail').close();
  });

  const menuButton = byId('menu-toggle');
  const mobileMenu = byId('mobile-menu');
  menuButton.addEventListener('click', () => {
    const open = mobileMenu.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  mobileMenu.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
    mobileMenu.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
  }));

  const desktopLinks = [...document.querySelectorAll('.nav-links a')];
  const sections = desktopLinks.map((link) => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    desktopLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
  }, { rootMargin: '-25% 0px -60%', threshold: [0, .25, .5] });
  sections.forEach((section) => observer.observe(section));

  window.setInterval(() => {
    if (!document.hidden) loadAll();
  }, 30_000);
  loadAll();
})();
