const API_BASE = String(window.__API_BASE__ ?? '/api').replace(/\/+$/, '');
const REQUEST_TIMEOUT = 12_000;
const JOB_POLL_INTERVAL = 1_500;
const JOB_POLL_TIMEOUT = 120_000;

const view = document.querySelector('#app-view');
const body = document.body;
const menuButton = document.querySelector('[data-menu-toggle]');
const notificationButton = document.querySelector('[data-notifications-toggle]');
const notificationPanel = document.querySelector('[data-notifications-panel]');
const notificationContent = document.querySelector('[data-notifications-content]');
const notificationCount = document.querySelector('[data-notification-count]');
const projectDialog = document.querySelector('[data-project-dialog]');
const projectForm = document.querySelector('[data-project-form]');
const projectChannels = document.querySelector('[data-project-channels]');
const projectError = document.querySelector('[data-project-error]');
const jobStatus = document.querySelector('[data-job-status]');
const toastRegion = document.querySelector('[data-toast-region]');

const routes = new Set(['dashboard', 'content', 'hook-tests', 'calendar', 'analytics', 'channels', 'templates', 'brand', 'settings', 'plan']);
const state = {
  route: '',
  navigationId: 0,
  controller: null,
  channels: [],
  notifications: [],
  dashboardRange: '7',
  analyticsRange: '7',
  contentFilters: { q: '', channel: '', status: '' },
};

const thumbnails = [
  'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=640&q=82',
  'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=640&q=82',
  'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=640&q=82',
  'https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=640&q=82',
];

class ApiError extends Error {
  constructor(message, { status = 0, code = '', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function apiUrl(path, query) {
  const cleanPath = String(path).replace(/^\/+/, '');
  const base = /^https?:\/\//i.test(API_BASE) ? API_BASE : `${location.origin}${API_BASE.startsWith('/') ? '' : '/'}${API_BASE}`;
  const url = new URL(`${base}/${cleanPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== '' && value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function request(path, { method = 'GET', query, body: payload, timeout = REQUEST_TIMEOUT, signal } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException('요청 시간이 초과되었습니다.', 'TimeoutError')), timeout);
  const abort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
  }

  try {
    const response = await fetch(apiUrl(path, query), {
      method,
      headers: payload === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    let parsed = null;
    if (raw && contentType.includes('application/json')) {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    if (!response.ok) {
      const backendError = parsed?.error;
      const exactMessage = typeof backendError === 'string'
        ? backendError
        : backendError?.message ?? parsed?.message ?? raw ?? `${response.status} ${response.statusText}`;
      throw new ApiError(exactMessage, {
        status: response.status,
        code: backendError?.code ?? parsed?.code ?? '',
        details: backendError?.details ?? parsed?.details ?? null,
      });
    }
    if (!raw) return null;
    if (!contentType.includes('application/json')) throw new ApiError('서버가 JSON이 아닌 응답을 반환했습니다.', { status: response.status });
    if (parsed === null) throw new ApiError('서버 응답을 해석할 수 없습니다.', { status: response.status });
    return parsed;
  } catch (error) {
    if (error instanceof ApiError || error?.name === 'AbortError') throw error;
    if (error?.name === 'TimeoutError' || controller.signal.reason?.name === 'TimeoutError') {
      throw new ApiError('요청 시간이 초과되었습니다. 다시 시도해 주세요.', { code: 'REQUEST_TIMEOUT' });
    }
    throw new ApiError(error?.message || '네트워크 요청에 실패했습니다.', { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function unwrap(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in payload ? payload.data : payload;
}

function listFrom(payload, ...keys) {
  const value = unwrap(payload);
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function objectFrom(payload, ...keys) {
  const value = unwrap(payload);
  for (const key of keys) if (value?.[key] && typeof value[key] === 'object') return value[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function safeImage(value, index = 0) {
  const fallback = thumbnails[index % thumbnails.length];
  if (!value) return fallback;
  try {
    const url = new URL(value, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : fallback;
  } catch { return fallback; }
}

function formatNumber(value) {
  if (value === undefined || value === null || value === '') return '0';
  if (typeof value === 'string' && /[^\d.,-]/.test(value)) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return new Intl.NumberFormat('ko-KR', { notation: number >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(number);
}

function formatDate(value, includeTime = true) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ko-KR', includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
}

function platformKind(channel = {}) {
  const source = `${channel.platform ?? ''} ${channel.kind ?? ''} ${channel.name ?? ''}`.toLowerCase();
  if (source.includes('youtube') || source.includes('shorts')) return 'youtube';
  if (source.includes('instagram') || source.includes('reels')) return 'instagram';
  return 'tiktok';
}

function platformSymbol(kind) {
  return kind === 'youtube' ? 'YT' : kind === 'instagram' ? 'IG' : 'TT';
}

function statusMeta(value) {
  const raw = String(value ?? '대기').toLowerCase();
  if (['connected', 'active', 'completed', 'complete', 'success', 'published', 'ready', 'enabled'].some((key) => raw.includes(key))) return ['success', statusLabel(value)];
  if (['running', 'processing', 'testing', 'queued', 'scheduled', 'pending'].some((key) => raw.includes(key))) return ['info', statusLabel(value)];
  if (['failed', 'error', 'disconnected', 'disabled'].some((key) => raw.includes(key))) return ['danger', statusLabel(value)];
  return ['warning', statusLabel(value)];
}

function statusLabel(value) {
  const labels = { connected: '연결됨', active: '활성', completed: '완료', complete: '완료', success: '완료', published: '게시됨', ready: '준비됨', enabled: '활성', running: '진행 중', processing: '처리 중', testing: '테스트 중', queued: '대기 중', scheduled: '예약됨', pending: '대기 중', failed: '실패', error: '오류', disconnected: '연결 안 됨', disabled: '비활성', draft: '초안' };
  const key = String(value ?? '').toLowerCase();
  return labels[key] ?? String(value ?? '대기');
}

function iconRefresh() {
  if (window.lucide?.createIcons) window.lucide.createIcons();
}

function toast(message, type = '') {
  while (toastRegion.children.length >= 3) toastRegion.firstElementChild.remove();
  const element = document.createElement('div');
  element.className = `toast ${type}`.trim();
  element.textContent = message;
  toastRegion.append(element);
  window.setTimeout(() => element.remove(), 3500);
}

function setBusy(button, busy, label = '처리 중') {
  if (!button) return;
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
    delete button.dataset.originalHtml;
    iconRefresh();
  }
}

function viewHeader(title, description, actions = '') {
  return `<header class="view-header"><div><p class="eyebrow">SHORTIFY HUB</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${actions ? `<div class="view-actions">${actions}</div>` : ''}</header>`;
}

function loadingView(label = '데이터를 불러오는 중입니다.') {
  return `<section class="view-shell"><div class="state-view"><div class="state-content"><span class="spinner" aria-hidden="true"></span><p>${escapeHtml(label)}</p></div></div></section>`;
}

function emptyState(title, message, action = '') {
  return `<div class="state-view"><div class="state-content"><i data-lucide="inbox"></i><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${action}</div></div>`;
}

function errorState(error, route) {
  const message = error?.message || '데이터를 불러오지 못했습니다.';
  return `<section class="view-shell"><div class="state-view"><div class="state-content"><i data-lucide="circle-alert"></i><h2>요청을 완료하지 못했습니다</h2><p>${escapeHtml(message)}</p><button class="button button-secondary" type="button" data-retry-route="${escapeHtml(route)}"><i data-lucide="refresh-cw"></i>다시 시도</button></div></div></section>`;
}

function thumbnailMarkup(src, alt, index = 0, badge = '') {
  return `<div class="thumbnail"><img src="${escapeHtml(safeImage(src, index))}" alt="${escapeHtml(alt)}" loading="lazy" data-image-fallback>${badge ? `<span class="thumbnail-badge">${escapeHtml(badge)}</span>` : ''}<span class="thumbnail-fallback" hidden><i data-lucide="image-off"></i><span class="sr-only">이미지를 불러오지 못했습니다</span></span></div>`;
}

function getRoute() {
  const route = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  return routes.has(route) ? route : 'dashboard';
}

function setActiveRoute(route) {
  document.querySelectorAll('[data-route]').forEach((link) => {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  closeMenu();
  closeNotifications();
}

async function navigate({ focus = true } = {}) {
  const route = getRoute();
  state.route = route;
  state.navigationId += 1;
  const navigationId = state.navigationId;
  state.controller?.abort();
  state.controller = new AbortController();
  setActiveRoute(route);
  view.innerHTML = loadingView();
  iconRefresh();
  if (focus) view.focus({ preventScroll: true });
  try {
    await renderers[route]({ signal: state.controller.signal, navigationId });
  } catch (error) {
    if (error?.name === 'AbortError' || navigationId !== state.navigationId) return;
    view.innerHTML = errorState(error, route);
    iconRefresh();
  }
}

function commitView(navigationId, html) {
  if (navigationId !== state.navigationId) return false;
  view.innerHTML = html;
  iconRefresh();
  return true;
}

function dashboardChannels(payload) {
  const root = unwrap(payload) ?? {};
  return listFrom(root.channels ?? [], 'channels').map((channel, index) => ({
    ...channel,
    id: channel.id ?? channel.channelId ?? channel.slug ?? `channel-${index}`,
    name: channel.name ?? channel.displayName ?? channel.platform ?? `채널 ${index + 1}`,
  }));
}

function metricEntries(source) {
  if (Array.isArray(source)) return source.map((item) => ({ label: item.label ?? item.name ?? item.key, value: item.value ?? item.total ?? 0, change: item.change ?? item.delta ?? '' }));
  return Object.entries(source ?? {}).map(([key, value]) => {
    if (value && typeof value === 'object') return { label: value.label ?? labelForMetric(key), value: value.value ?? value.total ?? 0, change: value.change ?? value.delta ?? '' };
    return { label: labelForMetric(key), value, change: '' };
  });
}

function labelForMetric(key) {
  const labels = { views: '총 조회수', totalViews: '총 조회수', likes: '총 좋아요', totalLikes: '총 좋아요', subscribers: '구독자', viewRate: '평균 조회율', rate: '평균 조회율', averageViewRate: '평균 조회율', followers: '팔로워', newFollowers: '신규 팔로워', posts: '게시물', reach: '도달', watchTime: '시청 시간', averageWatchSeconds: '평균 시청 시간', engagement: '참여율' };
  return labels[key] ?? String(key).replace(/([A-Z])/g, ' $1');
}

function channelMetrics(channel) {
  const rangeMetrics = channel.metrics?.[state.dashboardRange] ?? channel.metrics?.[Number(state.dashboardRange)];
  const metrics = metricEntries(rangeMetrics ?? channel.metrics ?? channel.stats ?? {});
  return (metrics.length ? metrics : [
    { label: '팔로워', value: channel.followers ?? 0, change: channel.followersChange ?? '' },
    { label: '조회수', value: channel.views ?? 0, change: channel.viewsChange ?? '' },
    { label: '조회율', value: channel.viewRate ?? 0, change: channel.viewRateChange ?? '' },
    { label: '게시물', value: channel.posts ?? 0, change: channel.postsChange ?? '' },
  ]).slice(0, 4);
}

function hookVariants(channel) {
  const test = channel.hookTest ?? channel.hook_test ?? channel.test ?? {};
  const variants = test.variants ?? channel.hooks ?? [];
  return Array.isArray(variants) ? variants.slice(0, 3) : [];
}

function channelCard(channel, index, { editable = false } = {}) {
  const kind = platformKind(channel);
  const connected = channel.connected ?? channel.isConnected ?? String(channel.status).toLowerCase() === 'connected';
  const status = statusMeta(connected ? 'connected' : channel.status ?? 'disconnected');
  const variants = hookVariants(channel);
  const metrics = channelMetrics(channel);
  return `<article class="channel-card">
    <header class="channel-header"><div class="channel-identity"><span class="channel-logo ${kind}">${platformSymbol(kind)}</span><strong>${escapeHtml(channel.name)}</strong><span class="status-pill ${status[0]}">${escapeHtml(status[1])}</span></div>
    <div class="channel-controls">${editable ? `<button class="button button-secondary button-compact" type="button" data-channel-toggle="${escapeHtml(channel.id)}" data-connected="${connected}">${connected ? '연결 해제' : '연결'}</button>` : `<a class="button button-secondary button-compact" href="#channels">채널 관리</a>`}</div></header>
    <div class="channel-body">
      <div class="hook-preview">${thumbnailMarkup(channel.thumbnailUrl ?? channel.thumbnail, `${channel.name} 콘텐츠`, index)}
        <div><strong>훅 캡션 테스트</strong>${variants.length ? `<ol class="hook-results">${variants.map((variant) => { const score = Number(variant.score ?? variant.percent ?? variant.rate ?? 0); return `<li><div class="result-row"><span>${escapeHtml(variant.text ?? variant.caption ?? variant.name ?? '변형')}</span><em>${formatNumber(score)}%</em></div><progress max="100" value="${Math.max(0, Math.min(100, score))}"><span class="sr-only">${score}%</span></progress></li>`; }).join('')}</ol>` : '<p class="muted-text">진행 중인 테스트가 없습니다.</p>'}</div>
      </div>
      <div class="channel-metrics">${metrics.map((metric) => `<div><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(formatNumber(metric.value))}</strong><small class="positive">${escapeHtml(metric.change)}</small></div>`).join('')}</div>
    </div>
  </article>`;
}

function recentContentTable(items) {
  if (!items.length) return emptyState('최근 콘텐츠가 없습니다', '프로젝트를 만들면 처리된 콘텐츠가 여기에 표시됩니다.', '<button class="button button-primary" type="button" data-open-project>새 영상 만들기</button>');
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>콘텐츠</th><th>채널</th><th>상태</th><th>업데이트</th><th><span class="sr-only">작업</span></th></tr></thead><tbody>${items.map((item, index) => {
    const platforms = item.channels ?? item.platforms ?? (item.channelName ? [item.channelName] : []);
    const status = statusMeta(item.status);
    return `<tr><td><div class="content-cell"><div class="content-thumb"><img src="${escapeHtml(safeImage(item.thumbnailUrl ?? item.thumbnail, index + 1))}" alt="" loading="lazy" data-image-fallback></div><div class="content-title"><strong>${escapeHtml(item.title ?? item.name ?? '제목 없음')}</strong><small>${escapeHtml(item.description ?? item.projectName ?? '')}</small></div></div></td><td><div class="platform-list">${(Array.isArray(platforms) ? platforms : [platforms]).map((platform) => { const kind = platformKind(typeof platform === 'string' ? { name: platform } : platform); return `<span class="platform-dot ${kind}" title="${escapeHtml(typeof platform === 'string' ? platform : platform.name ?? kind)}">${platformSymbol(kind)}</span>`; }).join('')}</div></td><td><span class="status-pill ${status[0]}">${escapeHtml(status[1])}</span></td><td>${escapeHtml(formatDate(item.updatedAt ?? item.createdAt))}</td><td><a class="button button-secondary button-compact" href="#calendar">예약</a></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

async function renderDashboard({ signal, navigationId }) {
  const payload = await request('dashboard', { query: { range: state.dashboardRange }, signal });
  const root = objectFrom(payload, 'dashboard');
  const runningTests = listFrom(root.hookTests ?? [], 'hookTests', 'tests');
  const channels = dashboardChannels(root).map((channel) => ({
    ...channel,
    hookTest: runningTests.find((test) => String(test.channelId) === String(channel.id)),
  }));
  state.channels = channels;
  updateProjectChannels();
  updatePlanSummary(root.plan ?? root.subscription ?? {});
  const items = listFrom(root.recentContent ?? root.content ?? [], 'items', 'content');
  const analytics = root.analytics ?? {};
  const metrics = metricEntries({
    views: { value: analytics.views, change: analytics.changes?.views },
    likes: { value: analytics.likes, change: analytics.changes?.likes },
    averageViewRate: { value: analytics.averageViewRate, change: analytics.changes?.averageViewRate },
    newFollowers: { value: analytics.newFollowers, change: analytics.changes?.newFollowers },
  }).slice(0, 4);
  const rangeControl = `<label class="field"><span class="sr-only">대시보드 기간</span><select data-dashboard-range><option value="7" ${state.dashboardRange === '7' ? 'selected' : ''}>최근 7일</option><option value="30" ${state.dashboardRange === '30' ? 'selected' : ''}>최근 30일</option></select></label>`;
  commitView(navigationId, `<div class="dashboard-view">
    <section class="dashboard-hero"><div><p class="eyebrow">MULTI-CHANNEL STUDIO</p><h1>YouTube · Instagram · TikTok<br>통합 제작 허브</h1><p class="subtitle">한 번 만든 영상으로 모든 숏폼 채널을 운영하세요.</p><div class="benefits"><div class="benefit"><span class="benefit-icon purple"><i data-lucide="zap"></i></span><div><strong>한 번 제작</strong><small>여러 플랫폼 동시 최적화</small></div></div><div class="benefit"><span class="benefit-icon green"><i data-lucide="trending-up"></i></span><div><strong>성과 확인</strong><small>데이터 기반 훅 테스트</small></div></div><div class="benefit"><span class="benefit-icon blue"><i data-lucide="users-round"></i></span><div><strong>채널 관리</strong><small>한곳에서 연결 상태 관리</small></div></div></div></div><div class="hero-art" aria-hidden="true"><div class="ghost-card editor-ghost"><span class="skeleton short"></span><span class="skeleton"></span><span class="skeleton"></span></div><div class="ghost-card chart-ghost"><span></span><span></span><span></span><span></span><span></span></div><div class="play-orb"><i data-lucide="play"></i></div><div class="social-stack"><span class="social-chip youtube">YT</span><span class="social-chip instagram">IG</span><span class="social-chip">TT</span></div></div></section>
    <div class="dashboard-body"><div class="view-header"><div><h2>채널 현황</h2><p>연결된 채널의 최근 성과와 훅 테스트를 확인합니다.</p></div><div class="view-actions">${rangeControl}</div></div>
    ${channels.length ? `<section class="channel-grid" aria-label="채널 현황">${channels.map((channel, index) => channelCard(channel, index)).join('')}</section>` : emptyState('연결된 채널이 없습니다', '채널 화면에서 사용할 채널을 연결하세요.', '<a class="button button-primary" href="#channels">채널 관리</a>')}
    <section class="dashboard-lower"><article class="panel"><div class="panel-title-row"><h2>최근 콘텐츠</h2><a class="button button-secondary button-compact" href="#content">전체 보기</a></div>${recentContentTable(items)}</article><article class="panel"><div class="panel-title-row"><h2>성과 요약</h2><a class="button button-secondary button-compact" href="#analytics">상세 분석</a></div>${metrics.length ? `<div class="summary-grid">${metrics.map((metric) => `<div><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(formatNumber(metric.value))}</strong><small class="positive">${escapeHtml(metric.change)}</small></div>`).join('')}</div>` : emptyState('성과 데이터가 없습니다', '선택한 기간에 집계된 성과가 없습니다.')}</article></section></div>
  </div>`);
}

async function renderContent({ signal, navigationId }) {
  const payload = await request('content', { query: { search: state.contentFilters.q, channel: state.contentFilters.channel, status: state.contentFilters.status }, signal });
  const items = listFrom(payload, 'items', 'content', 'results');
  const channelOptions = state.channels.length ? state.channels : listFrom(objectFrom(payload), 'channels');
  const filters = `<form class="toolbar" data-content-filters><label class="field field-grow"><span>검색</span><input name="q" type="search" value="${escapeHtml(state.contentFilters.q)}" placeholder="제목 또는 프로젝트 검색"></label><label class="field"><span>채널</span><select name="channel"><option value="">전체 채널</option>${channelOptions.map((channel) => `<option value="${escapeHtml(channel.id ?? channel.name)}" ${String(state.contentFilters.channel) === String(channel.id ?? channel.name) ? 'selected' : ''}>${escapeHtml(channel.name)}</option>`).join('')}</select></label><label class="field"><span>상태</span><select name="status"><option value="">전체 상태</option>${[['draft','초안'],['testing','테스트 중'],['scheduled','예약됨'],['published','게시됨']].map(([value,label]) => `<option value="${value}" ${state.contentFilters.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button class="button button-primary" type="submit"><i data-lucide="search"></i>조회</button><button class="button button-secondary" type="button" data-clear-content-filters>초기화</button></form>`;
  commitView(navigationId, `<section class="view-shell">${viewHeader('콘텐츠', '제작된 콘텐츠를 채널과 처리 상태별로 찾습니다.', '<button class="button button-primary" type="button" data-open-project><i data-lucide="plus"></i>새 영상 만들기</button>')}${filters}${items.length ? recentContentTable(items) : emptyState('조건에 맞는 콘텐츠가 없습니다', '필터를 바꾸거나 새 프로젝트를 만들어 보세요.', '<button class="button button-primary" type="button" data-open-project>새 영상 만들기</button>')}</section>`);
}

async function renderHookTests({ signal, navigationId }) {
  const payload = await request('hook-tests', { signal });
  const tests = listFrom(payload, 'items', 'tests', 'hookTests');
  const content = tests.length ? `<div class="hook-list">${tests.map((test, index) => {
    const variants = test.variants ?? test.results ?? [];
    const status = statusMeta(test.status);
    return `<article class="hook-row">${thumbnailMarkup(test.thumbnailUrl ?? test.thumbnail, test.title ?? '훅 테스트', index)}<div><div class="panel-title-row"><h3>${escapeHtml(test.title ?? test.name ?? '훅 테스트')}</h3><span class="status-pill ${status[0]}">${escapeHtml(status[1])}</span></div><div class="bar-list">${(Array.isArray(variants) ? variants : []).map((variant) => { const score = Math.max(0, Math.min(100, Number(variant.score ?? variant.percent ?? 0))); return `<div class="bar-row"><span>${escapeHtml(variant.text ?? variant.caption ?? variant.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${score}%"></span></span><strong>${score}%</strong></div>`; }).join('') || '<p>아직 집계된 변형 결과가 없습니다.</p>'}</div></div><div><small class="muted-text">${escapeHtml(formatDate(test.updatedAt ?? test.createdAt))}</small></div></article>`;
  }).join('')}</div>` : emptyState('훅 테스트가 없습니다', '프로젝트 처리가 시작되면 채널별 훅 변형 결과가 표시됩니다.', '<button class="button button-primary" type="button" data-open-project>프로젝트 만들기</button>');
  commitView(navigationId, `<section class="view-shell">${viewHeader('훅 테스트', '캡션 변형별 반응 데이터를 비교합니다.', '<button class="button button-secondary" type="button" data-refresh-route><i data-lucide="refresh-cw"></i>새로고침</button>')}${content}</section>`);
}

async function renderCalendar({ signal, navigationId }) {
  const payload = await request('schedules', { signal });
  const schedules = listFrom(payload, 'items', 'schedules', 'events');
  const content = schedules.length ? `<div class="schedule-grid">${schedules.map((schedule) => {
    const platforms = schedule.channels ?? schedule.platforms ?? (schedule.channelName ? [schedule.channelName] : []);
    const status = statusMeta(schedule.status ?? 'scheduled');
    return `<article class="schedule-card"><time datetime="${escapeHtml(schedule.scheduledAt ?? schedule.publishAt ?? '')}">${escapeHtml(formatDate(schedule.scheduledAt ?? schedule.publishAt))}</time><h3>${escapeHtml(schedule.title ?? schedule.contentTitle ?? schedule.name ?? '예약 콘텐츠')}</h3><p>${escapeHtml(schedule.description ?? schedule.caption ?? '')}</p><footer><div class="platform-list">${(Array.isArray(platforms) ? platforms : [platforms]).map((platform) => { const kind = platformKind(typeof platform === 'string' ? { name: platform } : platform); return `<span class="platform-dot ${kind}">${platformSymbol(kind)}</span>`; }).join('')}<span class="status-pill ${status[0]}">${escapeHtml(status[1])}</span></div><button class="icon-button" type="button" aria-label="${escapeHtml(schedule.title ?? '예약')} 삭제" data-delete-schedule="${escapeHtml(schedule.id)}"><i data-lucide="trash-2"></i></button></footer></article>`;
  }).join('')}</div>` : emptyState('예약된 콘텐츠가 없습니다', '새 일정을 추가하면 이곳에서 게시 계획을 관리할 수 있습니다.');
  commitView(navigationId, `<section class="view-shell">${viewHeader('캘린더', '채널별 콘텐츠 게시 일정을 관리합니다.', '<button class="button button-primary" type="button" data-toggle-schedule-form><i data-lucide="plus"></i>일정 추가</button>')}<form class="toolbar" data-schedule-form hidden><label class="field field-grow"><span>콘텐츠 제목</span><input name="title" type="text" required maxlength="120"></label><label class="field"><span>게시 일시</span><input name="scheduledAt" type="datetime-local" required></label><label class="field"><span>채널</span><select name="channelId" required><option value="">선택</option>${state.channels.map((channel) => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.name)}</option>`).join('')}</select></label><button class="button button-primary" type="submit">저장</button><button class="button button-secondary" type="button" data-toggle-schedule-form>취소</button></form>${content}</section>`);
}

async function renderAnalytics({ signal, navigationId }) {
  const payload = await request('analytics', { query: { range: state.analyticsRange }, signal });
  const root = objectFrom(payload, 'analytics');
  const metrics = metricEntries({
    views: { value: root.views, change: root.changes?.views },
    likes: { value: root.likes, change: root.changes?.likes },
    averageViewRate: { value: root.averageViewRate, change: root.changes?.averageViewRate },
    newFollowers: { value: root.newFollowers, change: root.changes?.newFollowers },
  });
  const breakdown = listFrom(root.channels ?? root.breakdown ?? [], 'items', 'channels');
  const actions = `<label class="field"><span class="sr-only">분석 기간</span><select data-analytics-range><option value="7" ${state.analyticsRange === '7' ? 'selected' : ''}>최근 7일</option><option value="30" ${state.analyticsRange === '30' ? 'selected' : ''}>최근 30일</option></select></label>`;
  const metricContent = metrics.length ? `<div class="metric-grid">${metrics.map((metric) => `<article class="metric-tile"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(formatNumber(metric.value))}</strong><small>${escapeHtml(metric.change)}</small></article>`).join('')}</div>` : emptyState('분석 데이터가 없습니다', '선택한 기간에 집계할 데이터가 없습니다.');
  const breakdownContent = breakdown.length ? `<section class="panel" style="margin-top:12px"><div class="panel-title-row"><h2>채널별 성과</h2></div><div class="bar-list">${breakdown.map((item) => { const value = Number(item.value ?? item.views ?? item.total ?? 0); const max = Math.max(...breakdown.map((entry) => Number(entry.value ?? entry.views ?? entry.total ?? 0)), 1); return `<div class="bar-row"><span>${escapeHtml(item.name ?? item.channelName ?? item.platform)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, (value / max) * 100)}%"></span></span><strong>${escapeHtml(formatNumber(value))}</strong></div>`; }).join('')}</div></section>` : '';
  commitView(navigationId, `<section class="view-shell">${viewHeader('분석', '모든 채널의 성과를 같은 기준으로 비교합니다.', actions)}${metricContent}${breakdownContent}</section>`);
}

async function renderChannels({ signal, navigationId }) {
  const payload = await request('dashboard', { query: { range: state.dashboardRange }, signal });
  const channels = dashboardChannels(objectFrom(payload, 'dashboard'));
  state.channels = channels;
  updateProjectChannels();
  const content = channels.length ? `<div class="channel-grid">${channels.map((channel, index) => channelCard(channel, index, { editable: true })).join('')}</div>` : emptyState('등록된 채널이 없습니다', '백엔드에 채널을 등록한 후 연결 상태를 관리할 수 있습니다.');
  commitView(navigationId, `<section class="view-shell">${viewHeader('채널', '제작에 사용할 채널의 연결 상태를 관리합니다.', '<button class="button button-secondary" type="button" data-refresh-route><i data-lucide="refresh-cw"></i>새로고침</button>')}${content}</section>`);
}

async function renderTemplates({ signal, navigationId }) {
  const payload = await request('templates', { signal });
  const templates = listFrom(payload, 'items', 'templates');
  const content = templates.length ? `<div class="template-grid">${templates.map((template) => `<article class="template-card"><header><div><span class="status-pill">${escapeHtml(template.category ?? '숏폼')}</span><h3>${escapeHtml(template.name ?? '템플릿')}</h3></div><button class="icon-button" type="button" aria-label="${escapeHtml(template.name ?? '템플릿')} 삭제" data-delete-template="${escapeHtml(template.id)}"><i data-lucide="trash-2"></i></button></header><p>${escapeHtml(template.body ?? '')}</p><footer><span>${escapeHtml(formatDate(template.updatedAt ?? template.createdAt, false))}</span><span>${template.isDefault ? '기본 템플릿' : '사용자 템플릿'}</span></footer></article>`).join('')}</div>` : emptyState('저장된 템플릿이 없습니다', '반복해서 사용할 영상 구조를 템플릿으로 추가하세요.');
  commitView(navigationId, `<section class="view-shell">${viewHeader('템플릿', '반복 제작에 사용할 영상 구조와 프롬프트를 관리합니다.', '<button class="button button-primary" type="button" data-toggle-template-form><i data-lucide="plus"></i>템플릿 추가</button>')}<form class="toolbar" data-template-form hidden><label class="field field-grow"><span>이름</span><input name="name" required maxlength="100"></label><label class="field"><span>카테고리</span><input name="category" required maxlength="60" placeholder="예: 레시피"></label><label class="field field-grow"><span>템플릿 본문</span><input name="body" required maxlength="2000"></label><label class="checkbox-label"><input name="isDefault" type="checkbox">기본 템플릿</label><button class="button button-primary" type="submit">저장</button><button class="button button-secondary" type="button" data-toggle-template-form>취소</button></form>${content}</section>`);
}

async function renderBrand({ signal, navigationId }) {
  const payload = await request('brand', { signal });
  const brand = objectFrom(payload, 'brand');
  commitView(navigationId, `<section class="view-shell">${viewHeader('브랜드', '콘텐츠 전반에 적용할 브랜드 언어와 스타일을 관리합니다.')}<form data-brand-form><section class="setting-section"><h2>브랜드 프로필</h2><div class="form-grid"><label class="field"><span>브랜드 이름</span><input name="name" required maxlength="100" value="${escapeHtml(brand.name ?? '')}"></label><label class="field"><span>주요 색상</span><input name="primaryColor" type="color" value="${escapeHtml(validColor(brand.primaryColor) ?? '#6541d8')}"><span class="color-preview" data-color-preview style="background:${escapeHtml(validColor(brand.primaryColor) ?? '#6541d8')}"></span></label><label class="field full-span"><span>로고 URL</span><input name="logoUrl" type="url" maxlength="1000" value="${escapeHtml(brand.logoUrl ?? '')}" placeholder="https://example.com/logo.png"></label><label class="field full-span"><span>말투와 표현</span><textarea name="voice" maxlength="300" placeholder="예: 간결하고 친근하게, 과장 표현은 사용하지 않음">${escapeHtml(brand.voice ?? '')}</textarea></label></div><div class="form-actions"><button class="button button-primary" type="submit"><i data-lucide="save"></i>저장</button></div></section></form></section>`);
}

async function renderSettings({ signal, navigationId }) {
  const payload = await request('settings', { signal });
  const settings = objectFrom(payload, 'settings');
  commitView(navigationId, `<section class="view-shell">${viewHeader('설정', '지역 형식과 자동화 및 알림 기본값을 관리합니다.')}<form data-settings-form><section class="setting-section"><h2>지역 설정</h2><div class="form-grid"><label class="field"><span>언어 및 지역</span><select name="locale"><option value="ko-KR" ${(settings.locale ?? 'ko-KR') === 'ko-KR' ? 'selected' : ''}>한국어 (대한민국)</option><option value="en-US" ${settings.locale === 'en-US' ? 'selected' : ''}>English (United States)</option></select></label><label class="field"><span>시간대</span><select name="timezone"><option value="Asia/Seoul" ${(settings.timezone ?? 'Asia/Seoul') === 'Asia/Seoul' ? 'selected' : ''}>Asia/Seoul</option><option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option></select></label></div></section><section class="setting-section"><h2>자동화 및 알림</h2><div class="checkbox-list"><label class="switch-label"><input name="emailNotifications" type="checkbox" ${settings.emailNotifications ? 'checked' : ''}>이메일 알림</label><label class="switch-label"><input name="autoSchedule" type="checkbox" ${settings.autoSchedule ? 'checked' : ''}>완료된 콘텐츠 자동 예약</label></div><div class="form-actions"><button class="button button-primary" type="submit"><i data-lucide="save"></i>설정 저장</button></div></section></form></section>`);
}

async function renderPlan({ signal, navigationId }) {
  const payload = await request('plan', { signal });
  const plan = objectFrom(payload, 'plan');
  updatePlanSummary(plan);
  commitView(navigationId, `<section class="view-shell">${viewHeader('플랜 관리', '프로젝트 한도와 사용량 정보를 관리합니다.')}<form data-plan-form><section class="setting-section"><h2>현재 사용량</h2><div class="metric-grid"><article class="metric-tile"><span>현재 플랜</span><strong>${escapeHtml(plan.name ?? '-')}</strong><small>${escapeHtml(plan.daysRemaining ? `${plan.daysRemaining}일 남음` : '')}</small></article><article class="metric-tile"><span>사용량</span><strong>${escapeHtml(`${plan.usagePercent ?? 0}%`)}</strong><small>전체 프로젝트 한도 대비</small></article><article class="metric-tile"><span>프로젝트 한도</span><strong>${escapeHtml(formatNumber(plan.projectLimit ?? 0))}</strong><small>현재 플랜 기준</small></article></div></section><section class="setting-section"><h2>플랜 정보 변경</h2><div class="form-grid"><label class="field"><span>플랜 이름</span><input name="name" required maxlength="100" value="${escapeHtml(plan.name ?? '')}"></label><label class="field"><span>남은 일수</span><input name="daysRemaining" type="number" min="0" max="3650" required value="${escapeHtml(plan.daysRemaining ?? 0)}"></label><label class="field"><span>사용률 (%)</span><input name="usagePercent" type="number" min="0" max="100" required value="${escapeHtml(plan.usagePercent ?? 0)}"></label><label class="field"><span>프로젝트 한도</span><input name="projectLimit" type="number" min="1" max="1000000" required value="${escapeHtml(plan.projectLimit ?? 1)}"></label></div><div class="form-actions"><button class="button button-primary" type="submit">플랜 저장</button></div></section></form></section>`);
}

const renderers = {
  dashboard: renderDashboard,
  content: renderContent,
  'hook-tests': renderHookTests,
  calendar: renderCalendar,
  analytics: renderAnalytics,
  channels: renderChannels,
  templates: renderTemplates,
  brand: renderBrand,
  settings: renderSettings,
  plan: renderPlan,
};

function validColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? value : null;
}

function updatePlanSummary(plan = {}) {
  const used = Number(plan.used ?? plan.usage ?? 0);
  const limit = Number(plan.limit ?? plan.quota ?? 0);
  const percent = Number(plan.percent ?? plan.usagePercent ?? (limit > 0 ? (used / limit) * 100 : 0));
  document.querySelector('[data-plan-name]').textContent = plan.displayName ?? plan.name ?? plan.tier ?? '플랜';
  document.querySelector('[data-plan-description]').textContent = plan.daysRemaining ? `사용 기간 ${plan.daysRemaining}일 남음` : (plan.description ?? '사용량을 확인하세요.');
  document.querySelector('[data-plan-usage]').value = Math.max(0, Math.min(100, percent || 0));
  document.querySelector('[data-plan-percent]').textContent = `${Math.round(percent || 0)}%`;
}

function updateProjectChannels() {
  projectChannels.innerHTML = state.channels.length ? state.channels.map((channel) => `<label class="checkbox-label"><input type="checkbox" name="channelIds" value="${escapeHtml(channel.id)}" ${(channel.connected ?? channel.isConnected ?? true) ? 'checked' : ''}>${escapeHtml(channel.name)}</label>`).join('') : '<p class="muted-text">사용 가능한 채널이 없습니다.</p>';
}

function openProjectDialog() {
  projectError.hidden = true;
  updateProjectChannels();
  if (typeof projectDialog.showModal === 'function') projectDialog.showModal();
  projectDialog.querySelector('input[name="title"]')?.focus();
}

function closeProjectDialog() {
  if (projectDialog.open) projectDialog.close();
}

function openMenu() {
  body.classList.add('menu-open');
  menuButton.setAttribute('aria-expanded', 'true');
  document.querySelector('.nav-list a[aria-current="page"]')?.focus();
}

function closeMenu() {
  body.classList.remove('menu-open');
  menuButton.setAttribute('aria-expanded', 'false');
}

function closeNotifications({ focus = false } = {}) {
  notificationPanel.hidden = true;
  notificationButton.setAttribute('aria-expanded', 'false');
  if (focus) notificationButton.focus();
}

async function toggleNotifications() {
  if (!notificationPanel.hidden) {
    closeNotifications({ focus: true });
    return;
  }
  notificationPanel.hidden = false;
  notificationButton.setAttribute('aria-expanded', 'true');
  notificationContent.innerHTML = '<div class="state-content"><span class="spinner" aria-hidden="true"></span><p>알림을 불러오는 중입니다.</p></div>';
  try {
    const payload = await request('notifications');
    state.notifications = listFrom(payload, 'items', 'notifications');
    renderNotifications();
  } catch (error) {
    notificationContent.innerHTML = `<div class="state-content"><p>${escapeHtml(error.message)}</p><button class="button button-secondary button-compact" type="button" data-retry-notifications>다시 시도</button></div>`;
  }
  iconRefresh();
  notificationPanel.querySelector('button')?.focus();
}

function renderNotifications() {
  const unread = state.notifications.filter((item) => !(item.read ?? item.isRead)).length;
  notificationCount.textContent = String(unread);
  notificationCount.hidden = unread === 0;
  notificationButton.setAttribute('aria-label', unread ? `읽지 않은 알림 ${unread}개` : '알림');
  notificationContent.innerHTML = state.notifications.length ? state.notifications.map((item) => {
    const isRead = item.read ?? item.isRead;
    return `<article class="notification-item ${isRead ? 'is-read' : ''}"><span class="unread-dot" aria-hidden="true"></span><div><strong>${escapeHtml(item.title ?? '알림')}</strong><p>${escapeHtml(item.message ?? item.body ?? '')}</p><time datetime="${escapeHtml(item.createdAt ?? '')}">${escapeHtml(formatDate(item.createdAt))}</time></div>${isRead ? '' : `<button class="icon-button" type="button" aria-label="읽음으로 표시" data-read-notification="${escapeHtml(item.id)}"><i data-lucide="check"></i></button>`}</article>`;
  }).join('') : emptyState('새 알림이 없습니다', '새로운 작업 상태가 생기면 여기에 표시됩니다.');
  iconRefresh();
}

async function markNotificationRead(id, button) {
  setBusy(button, true, '');
  try {
    await request(`notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
    const item = state.notifications.find((notification) => String(notification.id) === String(id));
    if (item) { item.read = true; item.isRead = true; }
    renderNotifications();
  } catch (error) {
    setBusy(button, false);
    toast(error.message, 'error');
  }
}

async function submitProject(event) {
  event.preventDefault();
  const submit = projectForm.querySelector('[data-project-submit]');
  const data = new FormData(projectForm);
  const channelIds = data.getAll('channelIds');
  if (!channelIds.length) {
    projectError.textContent = '제작 채널을 하나 이상 선택해 주세요.';
    projectError.hidden = false;
    return;
  }
  projectError.hidden = true;
  setBusy(submit, true, '생성 중');
  try {
    const response = unwrap(await request('projects', { method: 'POST', body: { title: data.get('title'), channelIds } })) ?? {};
    const jobId = response.jobId ?? response.job?.id ?? response.id;
    if (!jobId) throw new ApiError('프로젝트 응답에 작업 ID가 없습니다.', { code: 'MISSING_JOB_ID' });
    closeProjectDialog();
    projectForm.reset();
    toast('프로젝트 작업을 시작했습니다.', 'success');
    pollJob(jobId);
  } catch (error) {
    projectError.textContent = error.message;
    projectError.hidden = false;
  } finally {
    setBusy(submit, false);
  }
}

async function pollJob(jobId) {
  const startedAt = Date.now();
  jobStatus.hidden = false;
  jobStatus.innerHTML = '<strong>영상 변형 제작 중</strong><p>비동기 작업 상태를 확인하고 있습니다.</p>';
  while (Date.now() - startedAt < JOB_POLL_TIMEOUT) {
    try {
      const job = objectFrom(await request(`jobs/${encodeURIComponent(jobId)}`, { timeout: REQUEST_TIMEOUT }), 'job');
      const status = String(job.status ?? '').toLowerCase();
      const progress = Math.max(0, Math.min(100, Number(job.progress ?? 0)));
      jobStatus.innerHTML = `<strong>${escapeHtml(job.message ?? '영상 변형 제작 중')}</strong><p>${progress ? `${progress}% 완료` : '작업 상태를 확인하고 있습니다.'}</p>`;
      if (['success', 'succeeded', 'completed', 'complete'].includes(status)) {
        jobStatus.hidden = true;
        toast(job.message ?? '프로젝트 처리가 완료되었습니다.', 'success');
        if (state.route === 'dashboard' || state.route === 'content' || state.route === 'hook-tests') navigate({ focus: false });
        return;
      }
      if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
        jobStatus.hidden = true;
        toast(job.error?.message ?? job.error ?? job.message ?? '프로젝트 처리에 실패했습니다.', 'error');
        return;
      }
    } catch (error) {
      jobStatus.hidden = true;
      toast(error.message, 'error');
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, JOB_POLL_INTERVAL));
  }
  jobStatus.hidden = true;
  toast('작업 상태 확인 시간이 초과되었습니다. 콘텐츠 화면에서 상태를 확인해 주세요.', 'error');
}

function valuesFromForm(form) {
  const result = {};
  for (const [key, value] of new FormData(form).entries()) result[key] = value;
  for (const checkbox of form.querySelectorAll('input[type="checkbox"][name]')) result[checkbox.name] = checkbox.checked;
  return result;
}

async function submitMutation(form, path, { method = 'PATCH', successMessage, transform = valuesFromForm } = {}) {
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, '저장 중');
  try {
    const result = await request(path, { method, body: transform(form) });
    toast(successMessage, 'success');
    return result;
  } catch (error) {
    toast(error.message, 'error');
    throw error;
  } finally {
    setBusy(button, false);
  }
}

async function deleteResource(kind, id, button) {
  const labels = { schedule: '이 일정을 삭제하시겠습니까?', template: '이 템플릿을 삭제하시겠습니까?' };
  if (!window.confirm(labels[kind])) return;
  setBusy(button, true, '삭제 중');
  const endpoint = kind === 'schedule' ? `schedules/${encodeURIComponent(id)}` : `templates/${encodeURIComponent(id)}`;
  try {
    await request(endpoint, { method: 'DELETE' });
    toast(kind === 'schedule' ? '일정을 삭제했습니다.' : '템플릿을 삭제했습니다.', 'success');
    navigate({ focus: false });
  } catch (error) {
    setBusy(button, false);
    toast(error.message, 'error');
  }
}

view.addEventListener('click', async (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;
  if (target.matches('[data-open-project]')) openProjectDialog();
  if (target.matches('[data-retry-route], [data-refresh-route]')) navigate({ focus: false });
  if (target.matches('[data-clear-content-filters]')) {
    state.contentFilters = { q: '', channel: '', status: '' };
    navigate({ focus: false });
  }
  if (target.matches('[data-toggle-schedule-form]')) {
    const form = view.querySelector('[data-schedule-form]');
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input')?.focus();
  }
  if (target.matches('[data-toggle-template-form]')) {
    const form = view.querySelector('[data-template-form]');
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input')?.focus();
  }
  if (target.matches('[data-delete-schedule]')) await deleteResource('schedule', target.dataset.deleteSchedule, target);
  if (target.matches('[data-delete-template]')) await deleteResource('template', target.dataset.deleteTemplate, target);
  if (target.matches('[data-channel-toggle]')) {
    const connected = target.dataset.connected === 'true';
    if (connected && !window.confirm('이 채널의 연결을 해제하시겠습니까?')) return;
    setBusy(target, true, connected ? '해제 중' : '연결 중');
    try {
      await request(`channels/${encodeURIComponent(target.dataset.channelToggle)}`, { method: 'PATCH', body: { connected: !connected } });
      toast(connected ? '채널 연결을 해제했습니다.' : '채널을 연결했습니다.', 'success');
      navigate({ focus: false });
    } catch (error) {
      setBusy(target, false);
      toast(error.message, 'error');
    }
  }
});

view.addEventListener('change', (event) => {
  if (event.target.matches('[data-dashboard-range]')) {
    state.dashboardRange = event.target.value;
    navigate({ focus: false });
  }
  if (event.target.matches('[data-analytics-range]')) {
    state.analyticsRange = event.target.value;
    navigate({ focus: false });
  }
  if (event.target.matches('input[name="primaryColor"]')) {
    view.querySelector('[data-color-preview]').style.background = event.target.value;
  }
});

view.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.matches('[data-content-filters]')) {
      const data = new FormData(form);
      state.contentFilters = { q: data.get('q').trim(), channel: data.get('channel'), status: data.get('status') };
      navigate({ focus: false });
    } else if (form.matches('[data-schedule-form]')) {
      await submitMutation(form, 'schedules', {
        method: 'POST',
        successMessage: '일정을 추가했습니다.',
        transform: (node) => {
          const values = valuesFromForm(node);
          return {
            ...values,
            scheduledAt: new Date(values.scheduledAt).toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul',
          };
        },
      });
      navigate({ focus: false });
    } else if (form.matches('[data-template-form]')) {
      await submitMutation(form, 'templates', { method: 'POST', successMessage: '템플릿을 추가했습니다.' });
      navigate({ focus: false });
    } else if (form.matches('[data-brand-form]')) {
      await submitMutation(form, 'brand', {
        successMessage: '브랜드 설정을 저장했습니다.',
        transform: (node) => {
          const values = valuesFromForm(node);
          return { ...values, logoUrl: values.logoUrl.trim() || null };
        },
      });
    } else if (form.matches('[data-settings-form]')) {
      await submitMutation(form, 'settings', { successMessage: '설정을 저장했습니다.' });
    } else if (form.matches('[data-plan-form]')) {
      await submitMutation(form, 'plan', { successMessage: '플랜을 변경했습니다.', transform: (node) => { const values = valuesFromForm(node); return { name: values.name, daysRemaining: Number(values.daysRemaining), usagePercent: Number(values.usagePercent), projectLimit: Number(values.projectLimit) }; } });
      navigate({ focus: false });
    }
  } catch {
    // submitMutation has already surfaced the exact API error.
  }
});

document.addEventListener('click', (event) => {
  const failedImage = event.target.closest('[data-image-fallback]');
  if (failedImage) return;
  const path = event.composedPath();
  if (!notificationPanel.hidden && !path.includes(notificationPanel) && !path.includes(notificationButton)) closeNotifications();
});

document.addEventListener('error', (event) => {
  if (!event.target.matches?.('[data-image-fallback]')) return;
  const fallback = event.target.nextElementSibling;
  event.target.hidden = true;
  if (fallback?.classList.contains('thumbnail-fallback')) fallback.hidden = false;
  else event.target.parentElement?.classList.add('image-unavailable');
  iconRefresh();
}, true);

menuButton.addEventListener('click', () => body.classList.contains('menu-open') ? closeMenu() : openMenu());
document.querySelector('[data-menu-close]').addEventListener('click', () => { closeMenu(); menuButton.focus(); });
notificationButton.addEventListener('click', toggleNotifications);
document.querySelector('[data-notifications-close]').addEventListener('click', () => closeNotifications({ focus: true }));
notificationContent.addEventListener('click', (event) => {
  const readButton = event.target.closest('[data-read-notification]');
  if (readButton) markNotificationRead(readButton.dataset.readNotification, readButton);
  if (event.target.closest('[data-retry-notifications]')) toggleNotifications().then(toggleNotifications);
});
document.querySelectorAll('[data-open-project]').forEach((button) => button.addEventListener('click', openProjectDialog));
document.querySelectorAll('[data-project-close]').forEach((button) => button.addEventListener('click', closeProjectDialog));
projectForm.addEventListener('submit', submitProject);
projectDialog.addEventListener('click', (event) => {
  if (event.target === projectDialog) closeProjectDialog();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (body.classList.contains('menu-open')) { closeMenu(); menuButton.focus(); }
  else if (!notificationPanel.hidden) closeNotifications({ focus: true });
});

window.addEventListener('hashchange', () => navigate());
window.addEventListener('load', iconRefresh, { once: true });

async function bootstrap() {
  iconRefresh();
  try {
    const [notifications, plan, channels] = await Promise.allSettled([
      request('notifications'),
      request('plan'),
      request('channels'),
    ]);
    if (notifications.status === 'fulfilled') {
      state.notifications = listFrom(notifications.value, 'items', 'notifications');
      renderNotifications();
    }
    if (plan.status === 'fulfilled') updatePlanSummary(objectFrom(plan.value, 'plan'));
    if (channels.status === 'fulfilled') {
      state.channels = listFrom(channels.value, 'channels');
      updateProjectChannels();
    }
  } catch {
    // Route rendering remains usable when optional shell data is unavailable.
  }
  navigate({ focus: false });
}

bootstrap();
