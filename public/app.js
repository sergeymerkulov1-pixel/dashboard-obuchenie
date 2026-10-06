// Клиентская логика дашборда учебного отдела в стиле Dashboards V3

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let currentSnapshotId = null;
let currentSnapshotData = null;
let historyChart = null;
let historyChartTicket = 0;
let chartMode = 'abs'; // 'abs' (в чел.) или 'pct' (% от плана)
let isMeetingMode = false;
let isAdminLoggedIn = false;
let authToken = null;
let chatHistory = [];

// Цвета для серий графика в стиле SaaS
const INDICATOR_COLORS = {
  total: { border: '#4f46e5', bg: 'rgba(79, 70, 229, 0.1)' },
  gz: { border: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.1)' },
  mfc: { border: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' },
  kvc: { border: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' },
  omsu: { border: '#a855f7', bg: 'rgba(168, 85, 247, 0.1)' }
};

document.addEventListener('DOMContentLoaded', async () => {
  installAuthFetchGuard();
  setupEventListeners();
  setupChatWidget();
  if (window.lucide) lucide.createIcons();
  if (await checkAuthStatus()) startApp();
  else showLoginScreen();
});

// --- ВХОД, РОЛИ И СЕССИЯ (HTTP-ONLY COOKIE + API CHECK) ---
// Без входа дашборд не загружается: показывается экран входа с Борисом.
// Что видно и доступно, определяет роль (can('право')); те же права проверяет сервер.

let currentUser = null;
let userPerms = [];

function can(perm) {
  return userPerms.includes(perm);
}

function applyAuth(payload) {
  currentUser = payload && payload.authenticated ? payload.user : null;
  userPerms = payload && payload.authenticated ? (payload.permissions || []) : [];
  if (currentUser) currentUser.roleDescription = payload.roleDescription || '';
  isAdminLoggedIn = can('edit'); // «может править данные»; прежние проверки в коде опираются на этот флаг
  authToken = isAdminLoggedIn ? 'cookie-session' : null;
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/check');
    applyAuth(await res.json());
  } catch (e) {
    applyAuth(null);
  }
  return Boolean(currentUser);
}

// Окна «войдите» из старого кода теперь означают отказ по правам: пользователь уже вошёл
// Если сессия истекла (401) на любом запросе, возвращаем на экран входа
function installAuthFetchGuard() {
  const orig = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await orig(...args);
    const url = String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');
    if (res.status === 401 && !url.includes('/api/auth/')) {
      applyAuth(null);
      showLoginScreen('Сессия истекла. Войдите снова');
    }
    return res;
  };
}

function borisGreeting() {
  const h = new Date().getHours();
  const part = h >= 5 && h < 12 ? 'Доброе утро' : h >= 12 && h < 18 ? 'Добрый день' : h >= 18 && h < 23 ? 'Добрый вечер' : 'Доброй ночи';
  return part + '! Мурр, я Учёный кот Борис AI. Назовитесь, пожалуйста, — и я открою дашборд учебного отдела с теми разделами, что доступны вашей роли.';
}

function showLoginScreen(message) {
  const screen = document.getElementById('loginScreen');
  if (!screen) return;
  closeAllModals();
  screen.classList.remove('hidden');
  const speech = document.getElementById('loginBorisSpeech');
  if (speech) speech.textContent = borisGreeting();
  const card = document.getElementById('loginCard');
  if (card) requestAnimationFrame(() => card.classList.remove('opacity-0'));
  const errEl = document.getElementById('loginError');
  if (errEl) {
    errEl.textContent = message || '';
    errEl.classList.toggle('hidden', !message);
  }
  const pass = document.getElementById('loginPassword');
  if (pass) pass.value = '';
  const user = document.getElementById('loginUsername');
  if (user) setTimeout(() => (user.value ? pass : user).focus(), 100);
  if (window.lucide) lucide.createIcons();
}

function hideLoginScreen() {
  const screen = document.getElementById('loginScreen');
  if (screen) screen.classList.add('hidden');
}

// Показывает только то, что доступно роли пользователя
function applyPermissionsUI() {
  const show = (sel, ok) => document.querySelectorAll(sel).forEach(el => el.classList.toggle('hidden', !ok));
  show('[data-tab="schedule"], [data-target="schedule"], #blockSchedule', can('programs'));
  show('[data-tab="rating"], [data-target="rating"], #blockRating', can('programs'));
  show('[data-tab="curators"], #blockCurators', can('curators'));
  show('#railBtnAudit, #btnOpenAuditLog', can('audit'));
  show('#railBtnUpload, #btnTopNewSnapshot, #btnOpenNewSnapshotHero, #btnDashCollect', can('edit'));
  show('#aiChatWidget, #railBtnChat', can('chat'));

  const adminBar = document.getElementById('adminBar');
  if (adminBar) adminBar.classList.toggle('hidden', !can('edit'));
  const adminDot = document.getElementById('adminIndicatorDot');
  if (adminDot) adminDot.classList.toggle('hidden', !currentUser);
  const tooltipText = document.getElementById('adminTooltipText');
  if (tooltipText && currentUser) tooltipText.textContent = currentUser.name + ' · ' + currentUser.roleLabel;
  if (typeof rerenderPrograms === 'function') rerenderPrograms();
}

// совместимость: прежние вызовы после правок
function updateAuthUI() {
  applyPermissionsUI();
}

// Запуск дашборда после успешного входа
function startApp() {
  hideLoginScreen();
  applyPermissionsUI();
  loadSnapshot();
  loadHistoryChart();
  document.dispatchEvent(new CustomEvent('app:ready'));
  if (window.lucide) lucide.createIcons();
  let fresh = false;
  try { fresh = sessionStorage.getItem('justLoggedIn') === '1'; sessionStorage.removeItem('justLoggedIn'); } catch (e) { /* без хранилища просто без приветствия */ }
  if (fresh && currentUser) showToast('Борис: «Мурр, ' + currentUser.name + '! Рад вас видеть.»');
}

async function loginUser(username, password) {
  const btn = document.getElementById('loginSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Проверяю…'; }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка входа');
    // перезагрузка даёт чистое состояние: данные прежнего пользователя не остаются в памяти страницы
    try { sessionStorage.setItem('justLoggedIn', '1'); } catch (e) { /* ок */ }
    location.reload();
  } catch (err) {
    const errEl = document.getElementById('loginError');
    if (errEl) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Войти'; }
  }
}

async function logoutUser() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) { /* выход всё равно продолжаем */ }
  location.reload();
}

// --- ПРОФИЛЬ И УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ ---

const ROLE_SECTIONS = [
  ['view', 'Показатели, динамика, таблица'],
  ['programs', 'План-график и рейтинг программ'],
  ['curators', 'Кураторы: нагрузка и рейтинг'],
  ['audit', 'Журнал правок'],
  ['chat', 'Помощник Борис'],
  ['programsEdit', 'Загрузка план-графика и анкет'],
  ['edit', 'Правка данных, срезы, загрузка Excel'],
  ['users', 'Управление пользователями']
];

function openAccountModal() {
  const body = document.getElementById('accountBody');
  if (!body || !currentUser) return;
  const rows = ROLE_SECTIONS.map(([perm, label]) => '<li class="flex items-center gap-2 ' + (can(perm) ? 'text-slate-700' : 'text-slate-300 line-through') + '"><span>' + (can(perm) ? '✓' : '✕') + '</span><span>' + escapeHtml(label) + '</span></li>').join('');
  body.innerHTML = '<div class="flex items-center gap-3 mb-4">'
    + '<img src="assets/boris-face-sm.webp?v=2" alt="" class="boris-avatar w-12 h-12 rounded-full object-cover ring-2 ring-indigo-200">'
    + '<div><div class="text-sm font-extrabold text-slate-900">' + escapeHtml(currentUser.name) + '</div>'
    + '<div class="text-xs text-slate-500">' + escapeHtml(currentUser.username) + ' · <span class="font-bold text-indigo-600">' + escapeHtml(currentUser.roleLabel) + '</span></div></div></div>'
    + (currentUser.roleDescription ? '<p class="text-xs text-slate-500 mb-3">' + escapeHtml(currentUser.roleDescription) + '</p>' : '')
    + '<ul class="text-xs space-y-1.5 mb-5">' + rows + '</ul>'
    + '<div class="flex flex-wrap gap-2">'
    + (can('users') ? '<button type="button" id="btnOpenUsers" class="px-3 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold border border-indigo-200 transition">Пользователи и роли</button>' : '')
    + '<button type="button" id="btnLogoutUser" class="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-700 text-white text-xs font-bold transition">Выйти</button></div>';
  openModal('modalAccount');
  const bu = document.getElementById('btnOpenUsers');
  if (bu) bu.onclick = openUsersModal;
  document.getElementById('btnLogoutUser').onclick = logoutUser;
}

let usersState = null;

async function usersApi(url, method, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
  return data;
}

async function openUsersModal() {
  openModal('modalUsers');
  await reloadUsers();
}

async function reloadUsers() {
  const body = document.getElementById('usersBody');
  try {
    usersState = await usersApi('/api/users', 'GET');
    renderUsers();
  } catch (e) {
    body.innerHTML = '<p class="text-xs text-rose-700 font-semibold">' + escapeHtml(e.message) + '</p>';
  }
}

function renderUsers() {
  const body = document.getElementById('usersBody');
  const { users, roles } = usersState;
  const roleOpts = (sel) => roles.map(r => '<option value="' + escapeHtml(r.key) + '"' + (r.key === sel ? ' selected' : '') + '>' + escapeHtml(r.label) + '</option>').join('');
  const inputCls = 'w-full px-3 py-2 text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none';
  const rows = users.map(u => {
    const self = currentUser && u.username === currentUser.username;
    return '<tr class="border-t border-slate-100">'
      + '<td class="px-3 py-2"><div class="font-bold text-slate-800">' + escapeHtml(u.name) + (self ? ' <span class="text-[10px] text-indigo-600">(вы)</span>' : '') + '</div><div class="text-[11px] text-slate-400">' + escapeHtml(u.username) + '</div></td>'
      + '<td class="px-3 py-2"><select data-user-role="' + escapeHtml(u.username) + '" class="px-2 py-1 border border-slate-200 rounded-lg text-xs bg-white">' + roleOpts(u.role) + '</select></td>'
      + '<td class="px-3 py-2 text-right whitespace-nowrap"><button type="button" data-user-pass="' + escapeHtml(u.username) + '" class="text-indigo-600 hover:underline font-bold mr-3">Пароль</button>'
      + (self ? '' : '<button type="button" data-user-del="' + escapeHtml(u.username) + '" class="text-rose-600 hover:underline font-bold">Удалить</button>') + '</td></tr>';
  }).join('');
  const legend = roles.map(r => '<li><span class="font-bold text-slate-700">' + escapeHtml(r.label) + '</span> — ' + escapeHtml(r.description) + '</li>').join('');
  body.innerHTML = '<div class="overflow-x-auto rounded-2xl border border-slate-200 mb-5"><table class="w-full text-left text-xs text-slate-700"><thead class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400"><tr><th class="px-3 py-2">Пользователь</th><th class="px-3 py-2">Роль</th><th class="px-3 py-2"></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<form id="userAddForm" class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">'
    + '<div class="sm:col-span-2 text-xs font-extrabold uppercase tracking-wider text-slate-400">Новый пользователь</div>'
    + '<input name="name" required placeholder="Имя (как показывать)" class="' + inputCls + '" autocomplete="off">'
    + '<input name="username" required placeholder="Логин (латиница, цифры)" pattern="[a-z0-9._\\-]{3,32}" class="' + inputCls + '" autocomplete="off">'
    + '<select name="role" class="' + inputCls + ' bg-white">' + roleOpts('viewer') + '</select>'
    + '<input name="password" type="password" required minlength="6" placeholder="Пароль (от 6 символов)" class="' + inputCls + '" autocomplete="new-password">'
    + '<div id="userAddError" class="hidden sm:col-span-2 text-xs text-rose-600 font-semibold bg-rose-50 p-2.5 rounded-xl border border-rose-200"></div>'
    + '<button type="submit" class="sm:col-span-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs transition">Добавить</button></form>'
    + '<ul class="text-[11px] text-slate-500 space-y-1">' + legend + '</ul>';

  body.querySelectorAll('[data-user-role]').forEach(sel => sel.onchange = async () => {
    try {
      await usersApi('/api/users/' + encodeURIComponent(sel.getAttribute('data-user-role')), 'POST', { role: sel.value });
      showToast('Роль изменена');
    } catch (e) { alert(e.message); }
    reloadUsers();
  });
  body.querySelectorAll('[data-user-pass]').forEach(btn => btn.onclick = async () => {
    const p = window.prompt('Новый пароль для «' + btn.getAttribute('data-user-pass') + '» (от 6 символов):');
    if (!p) return;
    try {
      await usersApi('/api/users/' + encodeURIComponent(btn.getAttribute('data-user-pass')), 'POST', { password: p });
      showToast('Пароль изменён');
    } catch (e) { alert(e.message); }
  });
  body.querySelectorAll('[data-user-del]').forEach(btn => btn.onclick = async () => {
    const u = btn.getAttribute('data-user-del');
    if (!confirm('Удалить пользователя «' + u + '»?')) return;
    try {
      await usersApi('/api/users/' + encodeURIComponent(u), 'DELETE');
      showToast('Пользователь удалён');
    } catch (e) { alert(e.message); }
    reloadUsers();
  });
  document.getElementById('userAddForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = document.getElementById('userAddError');
    try {
      await usersApi('/api/users', 'POST', { name: f.get('name'), username: f.get('username'), role: f.get('role'), password: f.get('password') });
      showToast('Пользователь добавлен');
      reloadUsers();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  };
}

// --- ЗАГРУЗКА И ОТОБРАЖЕНИЕ СРЕЗА ---

async function loadSnapshot(snapshotId = null) {
  const cardsContainer = document.getElementById('cardsContainer');
  if (cardsContainer && !currentSnapshotData) {
    cardsContainer.innerHTML = `
      ${'<div class="skeleton h-[230px]" aria-hidden="true"></div>'.repeat(5)}
      <span class="sr-only">Загрузка показателей дашборда...</span>
    `;
  }

  try {
    const url = snapshotId ? `/api/snapshot?id=${encodeURIComponent(snapshotId)}` : '/api/snapshot';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Не удалось получить срез данных (код ' + res.status + ')');

    const data = await res.json();
    currentSnapshotData = data;
    currentSnapshotId = data.snapshot.id;

    // Ссылки экспорта
    const expCur = document.getElementById('exportCurrentLink');
    if (expCur) expCur.href = `/api/export/current?id=${currentSnapshotId}`;
    const expHist = document.getElementById('exportHistoryLink');
    if (expHist) expHist.href = `/api/export/history`;
    const tableExp = document.getElementById('tableExportBtn');
    if (tableExp) tableExp.href = `/api/export/current?id=${currentSnapshotId}`;

    // Селектор срезов
    renderSnapshotSelector(data.availableSnapshots, currentSnapshotId);

    // Метаданные шапки
    const noteEl = document.getElementById('snapshotNoteText');
    if (noteEl) {
      noteEl.innerHTML = `
        Мониторинг исполнения государственного задания, МФЦ, КВЦ и платных программ на <strong id="currentSnapshotDateTitle" class="text-slate-800">${escapeHtml(data.snapshot.date)}</strong>.
        ${data.snapshot.virtual ? `<span class="block mt-2 text-[11px] font-semibold text-teal-700 bg-teal-50 border border-teal-200 rounded-lg px-2 py-1">Срез по данным источников (${escapeHtml((data.availableSnapshots.find(x => x.id === data.snapshot.id)?.sources || []).join(' + ') || 'внешние')}). ${(() => { const obs = data.cards.filter(c => !c.noData && !c.carried).map(c => c.shortTitle); const car = data.cards.filter(c => c.carried); const missing = data.cards.filter(c => c.noData).map(c => c.shortTitle); const parts = []; if (obs.length) parts.push(`Есть в источниках: ${escapeHtml(obs.join(', '))}.`); if (car.length) parts.push(`${car.every(c => c.carriedSrc === 'презентация') ? 'Из презентации планёрки (в статусах нет)' : 'Перенесено с предыдущих дат'}: ${escapeHtml(car.map(c => c.shortTitle + ' — от ' + String(c.carriedFrom).slice(0, 5)).join(', '))}.`); if (missing.length) parts.push(`Нет данных: ${escapeHtml(missing.join(', '))}.`); return parts.join(' '); })()}</span>` : ''}
      `;
    } else {
      const dateTitleEl = document.getElementById('currentSnapshotDateTitle');
      if (dateTitleEl) dateTitleEl.textContent = data.snapshot.date;
    }

    const compNote = document.getElementById('comparisonNote');
    if (compNote) {
      compNote.textContent = data.previousDate ? `Неделя от ${escapeHtml(data.previousDate)}` : 'Базовый период';
    }

    const meetingModeTitle = document.getElementById('meetingModeTitle');
    if (meetingModeTitle) {
      meetingModeTitle.textContent = `Учебный отдел — Срез ${escapeHtml(data.snapshot.date)}`;
    }

    // Сводный охват (индиго-карточка)
    const totalCard = data.cards.find(c => c.key === 'total');
    if (totalCard) {
      const heroTotalEl = document.getElementById('heroTotalCount');
      if (heroTotalEl) heroTotalEl.textContent = formatNumber(totalCard.fact);
      const deltaEl = document.getElementById('heroTotalDelta');
      if (deltaEl) {
        if (totalCard.carried) {
          deltaEl.textContent = totalCard.carriedSrc === 'презентация' ? 'из презентации' : 'без изменений';
          deltaEl.className = 'text-xs font-bold px-2 py-0.5 rounded-lg bg-white/20 text-indigo-100 border border-white/20 flex items-center gap-1';
        } else if (totalCard.delta !== null) {
          const sign = totalCard.delta >= 0 ? '+' : '';
          const daysText = totalCard.deltaDays ? ` за ${totalCard.deltaDays} дн.` : '';
          deltaEl.textContent = `${sign}${formatNumber(totalCard.delta)}${daysText}`;
          deltaEl.className = totalCard.delta >= 0
            ? 'text-xs font-bold px-2 py-0.5 rounded-lg bg-emerald-400/20 text-emerald-300 border border-emerald-400/30 flex items-center gap-1'
            : 'text-xs font-bold px-2 py-0.5 rounded-lg bg-rose-400/20 text-rose-300 border border-rose-400/30 flex items-center gap-1';
        } else {
          deltaEl.textContent = totalCard.noData ? 'нет данных' : 'База';
          deltaEl.className = 'text-xs font-bold px-2 py-0.5 rounded-lg bg-white/20 text-indigo-100 border border-white/20 flex items-center gap-1';
        }
      }
    }

    const heroState = document.getElementById('heroSnapshotState');
    if (heroState) heroState.textContent = data.snapshot.virtual ? 'Срез по данным источников' : 'Снимок недели зафиксирован';

    renderYearProgress(data.yearMetrics);

    // Блок "Требует внимания"
    renderAttentionSection(data.attentionList, data.yearMetrics);

    // Обновление круговых индикаторов
    updateCircularRings(data.cards);

    // Обновление интерактивных чипов календаря срезов
    renderTimelineChips(data.availableSnapshots, data.snapshot.id);

    // Рендер KPI карточек и таблицы
    renderCards(data.cards);
    renderTable(data.cards);

    if (typeof statusWeekOnOrBefore === 'function') {
      const w = statusWeekOnOrBefore(data.snapshot.id);
      selectedStatusDate = w ? w.date : null;
      renderStatusPanel();
    }
    if (typeof loadStructure === 'function') loadStructure(data.snapshot.id);

    if (window.lucide) lucide.createIcons();

  } catch (err) {
    console.error('Ошибка загрузки данных среза:', err);
    if (cardsContainer) {
      cardsContainer.innerHTML = `
        <div class="col-span-full py-12 px-6 bg-white rounded-2xl border border-rose-200 text-center shadow-xs">
          <div class="w-12 h-12 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <i data-lucide="alert-triangle" class="w-6 h-6"></i>
          </div>
          <h4 class="text-sm font-bold text-slate-800 mb-1">Не удалось загрузить данные</h4>
          <p class="text-xs text-slate-500 mb-4">${escapeHtml(err.message)}</p>
          <button onclick="loadSnapshot(currentSnapshotId)" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl shadow-sm transition">
            Повторить попытку
          </button>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
    }
  }
}

function renderSnapshotSelector(snapshots, activeId) {
  const select = document.getElementById('snapshotSelect');
  if (!select) return;
  select.innerHTML = '';

  snapshots.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.virtual
      ? `${s.date} (${(s.sources || ['источники']).join(' + ')})`
      : `${s.date} ${s.isAutomatic ? '(авто)' : '(ручной)'}`;
    if (s.id === activeId) opt.selected = true;
    select.appendChild(opt);
  });
}

function isVirtualTitle(snap) {
  return snap.virtual
    ? `Срез по данным источников (${(snap.sources || []).join(' + ')}) ${snap.date}`
    : `Срез ${snap.date}`;
}

function renderTimelineChips(snapshots, activeId) {
  // statuses.js хранит ленту: срезы + недели еженедельных статусов
  if (snapshots) timelineSnapshots = snapshots;
  timelineActiveId = activeId;

  const container = document.getElementById('timelineChips');
  if (!container) return;
  container.innerHTML = '';

  const dayOfWeekNames = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
  const monthNames = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  // даты срезов и даты недельных статусов — одной лентой, последние 7
  const byDate = new Map();
  timelineSnapshots.forEach(s => {
    const iso = snapshotIso(s);
    byDate.set(iso, { iso, snap: s });
  });
  statusWeeks.forEach(w => {
    const e = byDate.get(w.date) || { iso: w.date };
    e.week = w;
    byDate.set(w.date, e);
  });
  const entries = [...byDate.values()].sort((a, b) => a.iso.localeCompare(b.iso)).slice(-7);

  entries.forEach(e => {
    const [y, m, dd] = e.iso.split('-').map(Number);
    const d = new Date(y, m - 1, dd);
    const dayOfWeek = dayOfWeekNames[d.getDay()];
    const dayOfMonth = String(dd).padStart(2, '0');
    const monthLabel = monthNames[m - 1] || '';

    const isSnapActive = Boolean(e.snap) && e.snap.id === activeId;
    const isStatusActive = !e.snap && e.week && e.iso === selectedStatusDate;
    const dot = e.week ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-teal-500 align-middle ml-0.5"></span>' : '';

    const chip = document.createElement('div');
    if (e.snap) chip.setAttribute('data-snap', e.snap.id);
    chip.title = e.snap
      ? (isVirtualTitle(e.snap) + ` (${dayOfWeek})${e.week ? ' · есть статусы по программам' : ''}`)
      : `Статусы по программам на ${statusFmtFull(e.iso)} (${dayOfWeek})`;

    const isVirtual = Boolean(e.snap && e.snap.virtual);
    let cls;
    let top;
    let bottom;
    if (isSnapActive && !isVirtual) {
      cls = 'border-2 border-indigo-600 bg-indigo-50 text-indigo-700 shadow-xs';
      top = 'text-indigo-500'; bottom = 'font-black text-indigo-700';
    } else if (isSnapActive || isStatusActive) {
      cls = 'border-2 border-teal-500 bg-teal-50 text-teal-800 shadow-xs';
      top = 'text-teal-600'; bottom = 'font-black text-teal-800';
    } else if (!e.snap || isVirtual) {
      cls = 'border border-teal-200 bg-teal-50/40 text-slate-700 hover:border-teal-400';
      top = 'text-teal-600/80'; bottom = 'font-extrabold text-slate-700';
    } else {
      cls = 'border border-slate-200 bg-white text-slate-700 hover:border-indigo-400 hover:shadow-2xs';
      top = 'text-slate-400'; bottom = 'font-extrabold text-slate-700';
    }
    chip.className = `p-2 rounded-2xl text-xs cursor-pointer snap-chip transition transform hover:scale-105 ${cls}`;
    chip.innerHTML = `
      <div class="text-[9px] font-bold uppercase ${top}">${escapeHtml(dayOfMonth)} ${escapeHtml(monthLabel)}${dot}</div>
      <div class="text-sm ${bottom}">${escapeHtml(dayOfWeek)}</div>`;

    chip.onclick = () => {
      if (e.snap) {
        const w = statusWeekOnOrBefore(e.iso);
        selectedStatusDate = w ? w.date : null;
        loadSnapshot(e.snap.id);
        renderStatusPanel();
      } else {
        selectStatusDate(e.iso);
      }
    };
    container.appendChild(chip);
  });

  // Кнопка ближайшего автосреза (вторник после 16:00)
  const nowD = new Date();
  const nextD = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
  let addDays = (2 - nextD.getDay() + 7) % 7;
  if (addDays === 0 && (nowD.getHours() > 16 || (nowD.getHours() === 16 && nowD.getMinutes() >= 5))) addDays = 7;
  nextD.setDate(nextD.getDate() + addDays);
  const nextDay = String(nextD.getDate()).padStart(2, '0');
  const nextMonthShort = monthNames[nextD.getMonth()];
  const nextIso = `${nextD.getFullYear()}-${String(nextD.getMonth() + 1).padStart(2, '0')}-${nextDay}`;
  const nextNote = document.getElementById('nextMeetingNote');
  if (nextNote) nextNote.innerHTML = `Ближайший срез: <strong>вторник ${nextDay}.${String(nextD.getMonth() + 1).padStart(2, '0')}</strong> после <strong>16:00 МСК</strong>. Планёрка — в среду.`;
  const nextBtn = document.createElement('div');
  nextBtn.id = 'btnNextWednesday';
  nextBtn.className = 'p-2 rounded-2xl border border-dashed border-indigo-300 bg-indigo-50/40 text-indigo-600 text-xs cursor-pointer hover:border-indigo-500 hover:bg-indigo-50 transition transform hover:scale-105';
  nextBtn.title = `Ближайший срез: вторник ${nextDay}.${String(nextD.getMonth() + 1).padStart(2, '0')} (автоматически после 16:00)`;
  nextBtn.innerHTML = `
    <div class="text-[9px] font-bold text-indigo-400 uppercase">${nextDay} ${nextMonthShort}</div>
    <div class="font-black text-xs text-indigo-600">ВТ 16:05</div>
  `;
  nextBtn.onclick = () => {
    if (!isAdminLoggedIn) {
      showToast('Для фиксации нового среза войдите как администратор');
      openModal('modalLogin');
    } else {
      document.getElementById('newSnapshotDate').value = nextIso;
      openModal('modalNewSnapshot');
    }
  };
  container.appendChild(nextBtn);
}

// --- СПАРКЛАЙН ОБЩЕГО ИТОГА В ИНДИГО-КАРТОЧКЕ ---

function renderHeroSparkline(values, isoDates) {
  const wrap = document.getElementById('heroSparkWrap');
  const svg = document.getElementById('heroSparkline');
  if (!wrap || !svg) return;
  const pts = values.map((v, i) => ({ v, d: isoDates[i] })).filter(p => p.v !== null && p.v !== undefined);
  if (pts.length < 2) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const W = Math.round(svg.getBoundingClientRect().width) || 300, H = 80, PAD = 6;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const t = pts.map(p => Date.parse(p.d));
  const t0 = t[0], t1 = t[t.length - 1];
  const vMin = Math.min(...pts.map(p => p.v)), vMax = Math.max(...pts.map(p => p.v));
  const x = i => PAD + ((t[i] - t0) / Math.max(1, t1 - t0)) * (W - PAD * 2);
  const y = v => H - PAD - ((v - vMin) / Math.max(1, vMax - vMin)) * (H - PAD * 2);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;
  const lx = x(pts.length - 1), ly = y(pts[pts.length - 1].v);
  svg.innerHTML = `
    <defs><linearGradient id="heroSparkFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient></defs>
    <path class="spark-area" d="${area}" fill="url(#heroSparkFill)"/>
    <path class="spark-line" d="${line}" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
    <circle class="spark-dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" fill="#ffffff"/>`;
  const fmtD = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  document.getElementById('heroSparkFrom').textContent = `${fmtD(pts[0].d)} · ${formatNumber(pts[0].v)}`;
  document.getElementById('heroSparkTo').textContent = `${fmtD(pts[pts.length - 1].d)} · ${formatNumber(pts[pts.length - 1].v)}`;
}

// --- ПРОГРЕСС ГОДА (основа нормы «должны быть сегодня») ---

function renderYearProgress(ym) {
  if (!ym || !ym.totalDaysInYear) return;
  const pct = Math.round((ym.passedDays / ym.totalDaysInYear) * 100);
  const pctEl = document.getElementById('yearProgressPct');
  if (pctEl) pctEl.textContent = `${pct}%`;
  const bar = document.getElementById('yearProgressBar');
  if (bar) bar.style.width = `${pct}%`;
  const days = document.getElementById('yearProgressDays');
  if (days) days.textContent = `${formatNumber(ym.passedDays)} из ${formatNumber(ym.totalDaysInYear)} дней`;
  const left = document.getElementById('yearProgressLeft');
  if (left) left.textContent = `до 31.12 — ${(Math.round(ym.remainingWeeks * 10) / 10).toLocaleString('ru-RU')} нед.`;
}

// --- БЛОК "ТРЕБУЕТ ВНИМАНИЯ" ---

function renderAttentionSection(attentionList, yearMetrics) {
  const section = document.getElementById('attentionSection');
  const grid = document.getElementById('attentionCardsGrid');
  const badge = document.getElementById('attentionNormBadge');
  if (!section || !grid) return;

  if (!attentionList || attentionList.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  const expectedPct = yearMetrics?.expectedPercent || 76;
  if (badge) badge.textContent = `Норма на сегодня: ${expectedPct}%`;

  grid.innerHTML = '';

  attentionList.forEach(item => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl p-4 border border-rose-200/90 shadow-2xs flex flex-col justify-between';

    const shortageText = item.shortage > 0 ? `Дефицит к норме: −${formatNumber(item.shortage)} чел.` : '';
    const paceLag = (item.requiredPace || 0) - (item.currentPace || 0);

    let commentPreview = '';
    if (item.comments?.reason || item.comments?.solution) {
      commentPreview = `
        <div class="mt-2.5 p-2 rounded-xl bg-slate-50 border border-slate-200/70 text-[10px] space-y-0.5">
          ${item.comments.reason ? `<div class="text-slate-600"><strong class="text-slate-800">Причина:</strong> ${escapeHtml(item.comments.reason)}</div>` : ''}
          ${item.comments.solution ? `<div class="text-indigo-700"><strong class="text-indigo-900">Решение:</strong> ${escapeHtml(item.comments.solution)}</div>` : ''}
          ${item.comments.assignee ? `<div class="text-slate-400">Отв.: ${escapeHtml(item.comments.assignee)}${item.comments.deadline ? ` (до ${escapeHtml(item.comments.deadline)})` : ''}</div>` : ''}
        </div>
      `;
    }

    card.innerHTML = `
      <div>
        <div class="flex items-start justify-between gap-2 mb-1.5">
          <h4 class="text-xs font-extrabold text-slate-900">${escapeHtml(item.title)}</h4>
          <span class="px-2 py-0.5 rounded-lg text-[10px] font-black bg-rose-100 text-rose-700 border border-rose-200">
            −${item.lagPercent} п.п.
          </span>
        </div>

        <div class="flex items-baseline justify-between text-xs mb-2">
          <span class="font-extrabold text-slate-800">${formatNumber(item.fact)} из ${formatNumber(item.plan)} чел.</span>
          <span class="font-black text-rose-600 text-sm">${item.percent}% <span class="text-[10px] text-slate-400 font-medium">/ норма ${item.expectedPercent}%</span></span>
        </div>

        <div class="text-[11px] text-slate-600 space-y-1 bg-rose-50/60 p-2.5 rounded-xl border border-rose-100">
          <div class="flex justify-between font-medium">
            <span>Нужный темп:</span>
            <strong class="text-rose-700">+${formatNumber(item.requiredPace)}/нед</strong>
          </div>
          <div class="flex justify-between font-medium">
            <span>Текущий темп <span class="text-slate-400">(в среднем за 4 нед.)</span>:</span>
            <strong class="text-slate-700">+${formatNumber(item.currentPace)}/нед</strong>
          </div>
          <div class="flex justify-between text-[10px] text-slate-500 pt-1 border-t border-rose-200/50">
            <span>Прогноз на 31.12:</span>
            <strong class="text-slate-800 font-bold">${formatNumber(item.forecast3112)} чел. (${item.forecastPercent}%)</strong>
          </div>
        </div>

        ${commentPreview}
      </div>

      <div class="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between">
        <span class="text-[10px] font-bold text-rose-600">${shortageText}</span>
        <button class="action-plan-btn text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1" data-key="${escapeHtml(item.key)}">
          <i data-lucide="edit-3" class="w-3 h-3"></i>
          <span>План действий</span>
        </button>
      </div>
    `;

    grid.appendChild(card);
  });

  grid.querySelectorAll('.action-plan-btn').forEach(btn => {
    btn.onclick = (e) => {
      const key = e.currentTarget.getAttribute('data-key');
      openActionPlanModal(key);
    };
  });
}
function updateCircularRings(cards) {
  const circumference = 163; // 2 * pi * 26

  [['gz', 'circleGz', 'circleGzVal'], ['kvc', 'circleKvc', 'circleKvcVal'], ['mfc', 'circleMfc', 'circleMfcVal']].forEach(([key, circleId, valId]) => {
    const card = cards.find(c => c.key === key);
    const has = Boolean(card) && card.percent !== null;
    const circle = document.getElementById(circleId);
    if (circle) circle.style.strokeDashoffset = has ? Math.max(0, circumference - (circumference * card.percent) / 100) : circumference;
    const val = document.getElementById(valId);
    if (val) val.textContent = has ? card.percent + '%' : '—';
  });

  const omsu = cards.find(c => c.key === 'omsu');
  const omsuVal = document.getElementById('circleOmsuVal');
  if (omsuVal) omsuVal.textContent = omsu ? formatNumber(omsu.fact) : '—';
}

function isVirtualSnapshot() {
  return Boolean(currentSnapshotData && currentSnapshotData.snapshot && currentSnapshotData.snapshot.virtual);
}

// «на ДД.ММ», если значение показателя наблюдалось раньше даты среза (например, КВЦ из статусов прошлой недели)
function observedLabel(card) {
  if (!card.observedAt) return '';
  const [, m, d] = String(card.observedAt).split('-');
  return `на ${d}.${m}`;
}

function renderCards(cards) {
  const container = document.getElementById('cardsContainer');
  if (!container) return;
  container.innerHTML = '';

  cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'kpi-bento-card flex flex-col justify-between';
    cardEl.setAttribute('data-title', card.title.toLowerCase());

    if (card.noData) {
      cardEl.innerHTML = `
        <div class="w-full">
          <span class="text-[10px] font-bold tracking-wider uppercase text-slate-400">${escapeHtml(card.category)}</span>
          <h4 class="text-xs font-bold text-slate-500 leading-snug mt-0.5">${escapeHtml(card.title)}</h4>
          <div class="mt-3 text-2xl font-black text-slate-300 tracking-tight">—</div>
          <div class="mt-1.5 text-[11px] text-slate-400">Нет данных на эту дату</div>
          ${card.plan ? `<div class="mt-2.5 pt-2.5 border-t border-slate-100 text-[11px] text-slate-400">План: ${formatNumber(card.plan)}</div>` : ''}
        </div>
        <div class="w-full mt-2 text-[10px] text-slate-400 pt-1 border-t border-slate-100/60">В источниках этой даты показателя нет</div>`;
      container.appendChild(cardEl);
      return;
    }

    // Бейдж ручной правки
    let overrideBadge = '';
    if (card.isOverridden) {
      overrideBadge = `
        <div class="mb-2 badge-override-pill flex items-center justify-between text-[10px]">
          <span>⚠️ Ручная правка: ${formatNumber(card.fact)} (в табл. ${formatNumber(card.originalFact)})</span>
          ${isAdminLoggedIn ? `<button class="text-amber-900 underline font-bold ml-1 revert-btn" data-key="${escapeHtml(card.key)}">Сброс</button>` : ''}
        </div>
      `;
    }

    // Дельта периода (с указанием дней)
    let deltaHtml = '<span class="text-[11px] text-slate-400 font-semibold">—</span>';
    if (card.delta !== null) {
      const isPositive = card.delta >= 0;
      const color = isPositive ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-rose-700 bg-rose-50 border-rose-200';
      const arrow = isPositive ? '▲' : '▼';
      const sign = isPositive ? '+' : '';
      const daysText = card.deltaDays ? `за ${card.deltaDays} дн.` : '';
      const obs = observedLabel(card);
      const obsTitle = obs ? ` (последние данные ${obs}${card.carried && card.carriedSrc === 'презентация' ? ', из презентации планёрки' : ''})` : '';

      deltaHtml = `
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] sm:text-[11px] font-bold border ${color}" title="Прирост ${sign}${formatNumber(card.delta)} ${daysText}${obsTitle}">
          ${arrow} ${sign}${formatNumber(card.delta)} ${daysText}${obs ? ` <span class="font-normal opacity-80">${obs}</span>` : ''}
        </span>
      `;
    }

    if (card.carried && card.delta === null) {
      const shortFrom = String(card.carriedFrom || '').slice(0, 5);
      const fromPres = card.carriedSrc === 'презентация';
      deltaHtml = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold border ${fromPres ? 'border-teal-200 bg-teal-50 text-teal-700' : 'border-slate-200 bg-slate-50 text-slate-500'}" title="${fromPres ? 'В статусах на эту дату показателя нет: показана презентация планёрки от ' : 'На эту дату новых данных нет: значение без изменений с '}${escapeHtml(card.carriedFrom || '')}">${fromPres ? 'из презентации' : 'без изменений'} · ${escapeHtml(shortFrom)}</span>`;
    }

    // Расхождение источников (желтый значок с тултипом)
    let discrepancyHtml = '';
    if (card.discrepancy) {
      discrepancyHtml = `
        <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-bold cursor-help whitespace-nowrap" title="${escapeHtml(card.discrepancy.message)}">
          <i data-lucide="alert-circle" class="w-3 h-3 text-amber-600"></i>
          <span>Слайд: ${formatNumber(card.discrepancy.slideValue)}</span>
        </span>
      `;
    }

    // Цвета статуса выполнения
    let statusColorClass = 'text-slate-700';
    let barColorClass = 'bg-slate-400';
    let statusBadgeText = '';
    let statusBadgeClass = '';

    if (card.status === 'on_track') {
      statusColorClass = 'text-emerald-600';
      barColorClass = 'bg-emerald-500';
      statusBadgeText = 'в графике';
      statusBadgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';
    } else if (card.status === 'warning') {
      statusColorClass = 'text-amber-600';
      barColorClass = 'bg-amber-500';
      statusBadgeText = `−${card.lagPercent} п.п.`;
      statusBadgeClass = 'bg-amber-50 text-amber-700 border-amber-200';
    } else if (card.status === 'critical') {
      statusColorClass = 'text-rose-600';
      barColorClass = 'bg-rose-500';
      statusBadgeText = `−${card.lagPercent} п.п.`;
      statusBadgeClass = 'bg-rose-50 text-rose-700 border-rose-200';
    }

    // Прогресс бар выполнения
    let progressHtml = '';
    if (card.plan && card.percent !== null) {
      const expPct = card.expectedPercent || 76;
      progressHtml = `
        <div class="mt-2.5 pt-2.5 border-t border-slate-100">
          <div class="flex justify-between items-center text-[11px] font-bold mb-1">
            <span class="text-slate-500 font-semibold flex items-center gap-1.5">
              <span>План: ${formatNumber(card.plan)}</span>
              ${isAdminLoggedIn ? `<button class="text-indigo-600 hover:text-indigo-800 text-[10px] underline edit-plan-btn" data-key="${escapeHtml(card.key)}" title="Изменить ориентир">изм.</button>` : ''}
            </span>
            <span class="${statusColorClass} font-black text-xs flex items-center gap-1">
              <span>${card.percent}%</span>
              ${statusBadgeText ? `<span class="text-[9px] px-1 py-0.2 rounded border ${statusBadgeClass}">${statusBadgeText}</span>` : ''}
            </span>
          </div>

          <!-- Полоса прогресса с отметкой "должны быть сегодня" -->
          <div class="kpi-progress-track relative w-full bg-slate-100 rounded-full h-2 my-2 overflow-visible">
            <div class="h-2 rounded-full ${barColorClass} transition-all duration-500" style="width: ${Math.min(card.percent, 100)}%"></div>
            
            <!-- Вертикальная отметка ожидаемого процента -->
            <div class="norm-marker" style="left: ${expPct}%" title="Ожидаемо на сегодня: ${expPct}% (${card.expectedFact ? formatNumber(card.expectedFact) + ' чел.' : ''})">
              <span class="norm-marker-label">сегодня ${expPct}%</span>
            </div>
          </div>

          <!-- Строка нужного и текущего темпа -->
          <div class="mt-3 flex items-center justify-between text-[10px] text-slate-500">
            <span class="whitespace-nowrap">Нужно: <strong class="text-slate-800 font-bold">+${formatNumber(card.requiredPace)}/нед</strong></span>
            <span class="text-right whitespace-nowrap">сейчас <strong class="${(card.currentPace >= card.requiredPace) ? 'text-emerald-600' : 'text-slate-700'} font-bold">+${formatNumber(card.currentPace)}/нед</strong><span class="block text-[9px] text-slate-400">в среднем за 4 нед.${observedLabel(card) ? ' ' + observedLabel(card) : ''}</span></span>
          </div>

          <!-- Прогноз на 31.12 -->
          <div class="mt-1 flex items-center justify-between text-[10px] text-slate-500 pt-1 border-t border-slate-100/60">
            <span>Прогноз на 31.12:</span>
            <strong class="text-slate-800 font-bold">${formatNumber(card.forecast3112)} чел. <span class="text-slate-500 font-normal">(${card.forecastPercent}%)</span></strong>
          </div>
        </div>
      `;
    } else {
      // Пока ориентир не задан — скрывать полосу прогресса
      progressHtml = `
        <div class="mt-2.5 pt-2.5 border-t border-slate-100 text-[11px] text-slate-400">
          <div class="flex justify-between items-center mb-1">
            <span class="font-medium">Норматив:</span>
            <div class="flex items-center gap-1.5">
              <span class="text-slate-600 font-bold">Не задан</span>
              ${isAdminLoggedIn ? `<button class="text-indigo-600 hover:underline text-[10px] font-bold set-plan-btn" data-key="${escapeHtml(card.key)}">+ Задать</button>` : ''}
            </div>
          </div>
          <div class="mt-2 flex items-center justify-between text-[10px] text-slate-500">
            <span>Текущий темп <span class="text-slate-400">(4 нед.)</span>:</span>
            <strong class="text-slate-700 font-bold whitespace-nowrap">+${formatNumber(card.currentPace)}/нед</strong>
          </div>
          <div class="mt-1 flex items-center justify-between text-[10px] text-slate-500">
            <span>Прогноз на 31.12:</span>
            <strong class="text-slate-800 font-bold">${formatNumber(card.forecast3112)} чел.</strong>
          </div>
        </div>
      `;
    }

    // Кнопка карандаша (ручная правка)
    const editBtn = (isAdminLoggedIn && !isVirtualSnapshot()) ? `
      <button class="edit-indicator-btn p-1 text-slate-400 hover:text-indigo-600 transition" title="Редактировать значение" data-key="${escapeHtml(card.key)}" aria-label="Редактировать значение">
        <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
      </button>
    ` : '';

    // Дата обновления источника и признак "устарело"
    const outdatedBadge = card.isOutdated ? '<span class="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] font-bold shrink-0">устарело >7дн</span>' : '';

    cardEl.innerHTML = `
      <div class="w-full">
        ${overrideBadge}
        <div class="flex items-start justify-between gap-1 mb-1">
          <div>
            <span class="text-[10px] font-bold tracking-wider uppercase text-slate-400">${escapeHtml(card.category)}</span>
            <h4 class="text-xs font-bold text-slate-800 leading-snug mt-0.5">${escapeHtml(card.title)}</h4>
          </div>
          ${editBtn}
        </div>

        <div class="flex items-baseline gap-1.5 mt-2">
          <span class="text-3xl font-black text-slate-900 tracking-tight">${formatNumber(card.fact)}</span>
          <span class="text-[11px] font-bold text-slate-400">${escapeHtml(card.unit)}</span>
          ${discrepancyHtml}
        </div>

        <div class="mt-1.5">
          ${deltaHtml}
        </div>
      </div>

      <div class="w-full mt-2">
        ${progressHtml}
        <div class="mt-2 text-[10px] text-slate-400 flex items-center justify-between gap-1 pt-1 border-t border-slate-100/60" title="${escapeHtml(card.source)}">
          <span class="truncate">${escapeHtml(card.source)}</span>
          ${outdatedBadge}
        </div>
      </div>
    `;

    container.appendChild(cardEl);
  });

  // Слушатели кнопок карточек
  container.querySelectorAll('.edit-indicator-btn').forEach(btn => {
    btn.onclick = (e) => {
      const key = e.currentTarget.getAttribute('data-key');
      openOverrideModal(key);
    };
  });

  container.querySelectorAll('.revert-btn').forEach(btn => {
    btn.onclick = (e) => {
      const key = e.currentTarget.getAttribute('data-key');
      revertOverride(key);
    };
  });

  container.querySelectorAll('.set-plan-btn, .edit-plan-btn').forEach(btn => {
    btn.onclick = (e) => {
      const key = e.currentTarget.getAttribute('data-key');
      openIndicatorPlanModal(key);
    };
  });
}

function renderTable(cards) {
  const tbody = document.getElementById('summaryTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  cards.forEach(card => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50/80 transition';

    if (card.noData) {
      tr.innerHTML = `
        <td class="px-4 py-3 font-bold text-slate-400">${escapeHtml(card.title)}</td>
        <td class="px-3 py-3 text-slate-400">${escapeHtml(card.category)}</td>
        <td class="px-3 py-3 text-slate-400">${card.plan ? formatNumber(card.plan) + ' чел.' : '—'}</td>
        <td class="px-3 py-3 text-slate-300" colspan="6">нет данных на эту дату</td>
        <td class="px-4 py-3 text-slate-400">${escapeHtml(card.source)}</td>
        <td></td>`;
      tbody.appendChild(tr);
      return;
    }

    // Форматирование дельты
    let deltaText = '—';
    if (card.delta !== null) {
      const sign = card.delta > 0 ? '+' : '';
      const daysText = card.deltaDays ? ` за ${card.deltaDays} дн.` : '';
      const obs = observedLabel(card);
      deltaText = `${sign}${formatNumber(card.delta)} чел.${daysText}${obs ? ' ' + obs : ''}`;
    }

    // Бейдж ручной правки
    let overrideMark = '';
    if (card.isOverridden) {
      overrideMark = `<span class="inline-block ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">правка</span>`;
    }

    // Расхождение для КВЦ
    let discrepancyMark = '';
    if (card.discrepancy) {
      discrepancyMark = `
        <span class="inline-flex items-center gap-0.5 ml-1 px-1 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] font-bold cursor-help" title="${escapeHtml(card.discrepancy.message)}">
          <i data-lucide="alert-circle" class="w-2.5 h-2.5 text-amber-600"></i>
          слайд ${formatNumber(card.discrepancy.slideValue)}
        </span>
      `;
    }

    if (card.carried && card.delta === null) deltaText = `${card.carriedSrc === 'презентация' ? 'из презентации' : 'без изменений'} (${String(card.carriedFrom || '').slice(0, 5)})`;

    // Ожидаемо к дате
    let expectedText = '—';
    if (card.expectedFact !== null) {
      expectedText = `${formatNumber(card.expectedFact)} чел. (${card.expectedPercent}%)`;
    }

    // Нужный темп
    let reqPaceText = '—';
    if (card.requiredPace !== null) {
      reqPaceText = card.requiredPace > 0 ? `+${formatNumber(card.requiredPace)}/нед` : '0/нед (выполнен)';
    }

    // Прогноз на 31.12
    let forecastText = '—';
    if (card.forecast3112 !== null) {
      const pctStr = card.forecastPercent !== null ? ` (${card.forecastPercent}%)` : '';
      forecastText = `${formatNumber(card.forecast3112)} чел.${pctStr}`;
    }

    // Цвет выполнения
    let pctColor = 'text-slate-700';
    if (card.status === 'on_track') pctColor = 'text-emerald-600';
    else if (card.status === 'warning') pctColor = 'text-amber-600';
    else if (card.status === 'critical') pctColor = 'text-rose-600';

    // Действия (кнопка правки значения, план действий, ориентир)
    let actionButtons = `
      <div class="flex items-center justify-end gap-1.5">
        <button class="action-plan-row-btn p-1 text-slate-400 hover:text-indigo-600 transition" title="План действий / Комментарии" data-key="${escapeHtml(card.key)}" aria-label="План действий">
          <i data-lucide="message-square" class="w-3.5 h-3.5"></i>
        </button>
        ${isAdminLoggedIn ? `
          <button class="edit-table-btn text-indigo-600 hover:text-indigo-800 font-bold text-xs" data-key="${escapeHtml(card.key)}">
            Правка
          </button>
        ` : ''}
      </div>
    `;

    if (isVirtualSnapshot()) actionButtons = '';

    // Источник и бейдж устаревания
    const outdatedBadge = card.isOutdated ? '<span class="ml-1 px-1 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] font-bold">устарело</span>' : '';

    tr.innerHTML = `
      <td class="px-4 py-3 font-bold text-slate-900 flex items-center gap-1">
        <span>${escapeHtml(card.title)}</span>
        ${overrideMark}
        ${discrepancyMark}
      </td>
      <td class="px-3 py-3 text-slate-500">${escapeHtml(card.category)}</td>
      <td class="px-3 py-3 text-slate-700 font-semibold">${card.plan ? formatNumber(card.plan) + ' чел.' : '—'}</td>
      <td class="px-3 py-3 font-black text-slate-900">${formatNumber(card.fact)} чел.</td>
      <td class="px-3 py-3 font-extrabold ${pctColor}">
        ${card.percent !== null ? card.percent + '%' : '—'}
      </td>
      <td class="px-3 py-3 text-slate-600 font-medium">${expectedText}</td>
      <td class="px-3 py-3 font-bold ${card.delta > 0 ? 'text-emerald-600' : 'text-slate-500'}">
        ${deltaText}
      </td>
      <td class="px-3 py-3 font-bold text-slate-700">${reqPaceText}</td>
      <td class="px-3 py-3 font-extrabold text-slate-800">${forecastText}</td>
      <td class="px-4 py-3 text-slate-400 max-w-xs truncate" title="${escapeHtml(card.source)}">
        <span>${escapeHtml(card.source)}</span>
        ${outdatedBadge}
      </td>
      <td class="px-4 py-3 text-right">
        ${actionButtons}
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.edit-table-btn').forEach(btn => {
    btn.onclick = (e) => {
      const key = e.currentTarget.getAttribute('data-key');
      openOverrideModal(key);
    };
  });

  tbody.querySelectorAll('.action-plan-row-btn').forEach(btn => {
    btn.onclick = (e) => {
      const key = e.currentTarget.getAttribute('data-key');
      openActionPlanModal(key);
    };
  });
}

// --- ГРАФИК ДИНАМИКИ CHART.JS ---

async function loadHistoryChart() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error('Не удалось загрузить историю');
    const data = await res.json();
    const series = chartMode === 'pct' ? data.datasetsPercent : data.datasets;
    const ctx = document.getElementById('historyChart')?.getContext('2d');
    if (!ctx) return;

    // Ось X — время (дни): точки стоят на реальном расстоянии друг от друга, а не через равные шаги
    const DAY_MS = 24 * 3600 * 1000;
    const dayOf = iso => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
    const dayLabel = d => {
      const dt = new Date(d * DAY_MS);
      return `${String(dt.getUTCDate()).padStart(2, '0')}.${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    // dates (ISO) появились позже labels (ДД.ММ.ГГГГ): если сервер старый — берём labels
    const isoDates = data.dates || (data.labels || []).map(l => l.split('.').reverse().join('-'));
    const xs = isoDates.map(dayOf);
    const targetX = dayOf(data.targetDate || '2026-12-31');
    const latestX = xs[xs.length - 1];
    const isDark = document.documentElement.classList.contains('dark');
    const hollowFill = isDark ? '#111827' : '#ffffff';
    const theme = isDark
      ? { grid: 'rgba(148, 163, 184, 0.12)', tick: '#7c8ba1', tipBg: 'rgba(15, 23, 42, 0.96)', tipBorder: '#334155' }
      : { grid: 'rgba(148, 163, 184, 0.16)', tick: '#94a3b8', tipBg: 'rgba(15, 23, 42, 0.92)', tipBorder: 'rgba(15, 23, 42, 0)' };
    // мягкая заливка под линией общего итога
    const areaFill = c => {
      const { ctx: g, chartArea } = c.chart;
      if (!chartArea) return 'transparent';
      const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      grad.addColorStop(0, isDark ? 'rgba(99, 102, 241, 0.32)' : 'rgba(79, 70, 229, 0.18)');
      grad.addColorStop(1, 'rgba(79, 70, 229, 0)');
      return grad;
    };

    const pointsOf = key => series[key].data
      .map((y, i) => ({ x: xs[i], y, carried: (data.carried && data.carried[key] && data.carried[key][i]) || null }))
      .filter(p => p.y !== null && p.y !== undefined);
    const lineDs = (id, label, width, radius) => {
      const color = INDICATOR_COLORS[id].border;
      return {
        id, label, data: pointsOf(id), borderColor: color,
        backgroundColor: id === 'total' ? areaFill : INDICATOR_COLORS[id].bg,
        borderWidth: width, pointRadius: radius, pointHoverRadius: radius + 3, pointHitRadius: 10,
        tension: 0.35, cubicInterpolationMode: 'monotone', fill: id === 'total' ? 'origin' : false, spanGaps: true,
        borderCapStyle: 'round', borderJoinStyle: 'round',
        // перенесённые из прошлых презентаций точки — полые
        pointBackgroundColor: c => (c.raw && c.raw.carried ? hollowFill : color),
        pointBorderColor: color,
        pointBorderWidth: c => (c.raw && c.raw.carried ? 2 : 0),
        pointHoverBorderWidth: 3, pointHoverBorderColor: hollowFill, pointHoverBackgroundColor: color
      };
    };
    const datasets = [
      lineDs('total', 'Общий итог', 3, 3.5),
      lineDs('gz', 'Госзадание', 2.25, 3),
      lineDs('mfc', 'МФЦ МО', 2.25, 3),
      lineDs('kvc', 'КВЦ', 2.25, 3),
      lineDs('omsu', 'ОМСУ', 2.25, 3)
    ];

    const planLines = [];
    const forecastLines = [];

    datasets.forEach(ds => {
      const key = ds.id;
      const valueSeries = series[key].data;
      const lastValue = valueSeries[valueSeries.length - 1] ?? null;
      const plan = chartMode === 'pct' ? (data.plans[key] ? 100 : null) : data.plans[key];
      const forecast = chartMode === 'pct' ? data.forecastsPercent3112[key] : data.forecasts3112[key];

      if (plan !== null && plan !== undefined && lastValue !== null) {
        planLines.push({
          id: `${key}-plan`, label: `${ds.label} — план`, data: [{ x: latestX, y: plan }, { x: targetX, y: plan }],
          borderColor: ds.borderColor + '99', borderWidth: 1.5, borderDash: [6, 6],
          pointRadius: 0, pointHitRadius: 0, tension: 0, fill: false
        });
      }

      if (forecast !== null && forecast !== undefined && lastValue !== null) {
        forecastLines.push({
          id: `${key}-forecast`, label: `${ds.label} — прогноз`, data: [{ x: latestX, y: lastValue }, { x: targetX, y: forecast }],
          borderColor: ds.borderColor, borderWidth: 2, borderDash: [1, 5], borderCapStyle: 'round',
          pointRadius: [0, 4], pointStyle: 'circle', pointBackgroundColor: hollowFill, pointBorderColor: ds.borderColor, pointBorderWidth: 2,
          pointHitRadius: [0, 10], tension: 0, fill: false
        });
      }
    });

    renderHeroSparkline(data.datasets.total.data, isoDates);

    if (historyChart) historyChart.destroy();
    historyChart = null;
    const ticket = ++historyChartTicket;

    const chartConfig = {
      type: 'line',
      data: { datasets: [...datasets, ...planLines, ...forecastLines] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        ...(window.motionLineAnimation ? window.motionLineAnimation() : {}),
        interaction: { mode: 'x', intersect: false },
        layout: { padding: { top: 6, right: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: theme.tipBg, borderColor: theme.tipBorder, borderWidth: 1,
            padding: 12, cornerRadius: 14, caretSize: 6, displayColors: true, boxWidth: 8, boxHeight: 8,
            titleFont: { size: 12, weight: 'bold' }, bodyFont: { size: 11 }, bodySpacing: 4,
            filter: item => !item.dataset.id.endsWith('-plan'),
            itemSort: (a, b) => b.parsed.y - a.parsed.y,
            callbacks: {
              labelColor: c => ({ borderColor: c.dataset.borderColor, backgroundColor: c.dataset.borderColor, borderRadius: 4 }),
              title: (items) => (items.length ? (items[0].parsed.x === targetX ? (data.targetDateLabel || '31.12.2026') : dayLabel(items[0].parsed.x)) : ''),
              label: (ctx) => ` ${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)} ${chartMode === 'pct' ? '%' : 'чел.'}`,
              afterLabel: (ctx) => {
                const c = ctx.raw && ctx.raw.carried;
                if (!c) return '';
                const from = String(c.from || '').slice(0, 5);
                return c.src === 'презентация'
                  ? `   перенесено из презентации планёрки от ${from}`
                  : `   перенесено: значение от ${from}`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            suggestedMax: chartMode === 'pct' ? 110 : undefined,
            grid: { color: theme.grid, drawTicks: false },
            border: { display: false, dash: [3, 4] },
            ticks: {
              font: { size: 11, weight: '500' }, color: theme.tick, padding: 8, maxTicksLimit: 6,
              callback: (val) => chartMode === 'pct' ? `${val}%` : formatNumber(val)
            }
          },
          x: {
            type: 'linear',
            min: xs.length ? xs[0] - 2 : undefined,
            max: targetX + 2,
            grid: { display: false },
            border: { color: theme.grid },
            // деления каждые 2 недели от первой точки и отдельно 31.12
            afterBuildTicks: axis => {
              if (!xs.length) return;
              const ticks = [];
              for (let d = xs[0]; d < targetX - 7; d += 14) ticks.push({ value: d });
              ticks.push({ value: targetX });
              axis.ticks = ticks;
            },
            ticks: { font: { size: 11, weight: '500' }, color: theme.tick, padding: 6, autoSkip: true, maxRotation: 0, callback: (val) => dayLabel(val) }
          }
        }
      }
    };

    // График создаётся, когда блок появляется на экране, — чтобы анимация входа была видна
    const createChart = () => {
      if (ticket !== historyChartTicket) return; // уже запрошена более свежая отрисовка
      historyChart = new Chart(ctx, chartConfig);
    };
    if (window.motionWhenVisible) window.motionWhenVisible(ctx.canvas, createChart);
    else createChart();

    document.querySelectorAll('#chartFilterChips .filter-chip').forEach(btn => {
      const key = btn.getAttribute('data-key');
      btn.classList.add('active');
      btn.onclick = () => {
        if (!historyChart) return;
        const target = historyChart.data.datasets.find(d => d.id === key);
        if (!target) return;
        target.hidden = !target.hidden;
        historyChart.data.datasets.filter(d => d.id.startsWith(`${key}-`)).forEach(line => { line.hidden = target.hidden; });
        btn.classList.toggle('active', !target.hidden);
        historyChart.update();
      };
    });

    const absBtn = document.getElementById('btnChartModeAbs');
    const pctBtn = document.getElementById('btnChartModePct');
    if (absBtn) absBtn.onclick = () => {
      if (chartMode === 'abs') return;
      chartMode = 'abs';
      absBtn.className = 'px-2.5 py-1 rounded-lg font-bold bg-white text-indigo-700 shadow-2xs transition';
      if (pctBtn) pctBtn.className = 'px-2.5 py-1 rounded-lg font-semibold text-slate-500 hover:text-slate-800 transition';
      loadHistoryChart();
    };
    if (pctBtn) pctBtn.onclick = () => {
      if (chartMode === 'pct') return;
      chartMode = 'pct';
      pctBtn.className = 'px-2.5 py-1 rounded-lg font-bold bg-white text-indigo-700 shadow-2xs transition';
      if (absBtn) absBtn.className = 'px-2.5 py-1 rounded-lg font-semibold text-slate-500 hover:text-slate-800 transition';
      loadHistoryChart();
    };

  } catch (err) {
    console.error('Ошибка графика:', err);
  }
}

// --- РУЧНЫЕ ПРАВКИ, ОРИЕНТИРЫ И ПЛАН ДЕЙСТВИЙ ---

function toggleMeetingMode(enable) {
  isMeetingMode = Boolean(enable);
  document.body.classList.toggle('meeting-mode', isMeetingMode);
  const meetingHeader = document.getElementById('meetingModeHeader');
  if (meetingHeader) {
    if (isMeetingMode) meetingHeader.classList.remove('hidden');
    else meetingHeader.classList.add('hidden');
  }
  showToast(isMeetingMode ? 'Включен режим планёрки для экрана' : 'Обычный режим');
  if (window.lucide) lucide.createIcons();
}

function openIndicatorPlanModal(indicatorKey) {
  if (!isAdminLoggedIn) {
    openModal('modalLogin');
    return;
  }
  const card = currentSnapshotData?.cards?.find(c => c.key === indicatorKey);
  if (!card) return;

  const keyInput = document.getElementById('planTargetKey');
  const titleEl = document.getElementById('planIndicatorTitle');
  const valInput = document.getElementById('planValueInput');

  if (keyInput) keyInput.value = card.key;
  if (titleEl) titleEl.textContent = card.title;
  if (valInput) valInput.value = card.plan !== null && card.plan !== undefined ? card.plan : '';

  openModal('modalIndicatorPlan');
}

async function submitIndicatorPlan(e) {
  e.preventDefault();
  const indicatorKey = document.getElementById('planTargetKey')?.value;
  const planValue = document.getElementById('planValueInput')?.value;

  try {
    const res = await fetch('/api/indicator-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ indicatorKey, planValue: planValue ? Number(planValue) : null })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось сохранить ориентир');

    closeAllModals();
    showToast('Ориентир успешно обновлен!');
    await loadSnapshot(currentSnapshotId);
    await loadHistoryChart();
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

function openActionPlanModal(indicatorKey) {
  const card = currentSnapshotData?.cards?.find(c => c.key === indicatorKey);
  if (!card) return;

  const keyInput = document.getElementById('actionPlanKey');
  const titleEl = document.getElementById('actionPlanTitle');
  const reasonEl = document.getElementById('actionReason');
  const solEl = document.getElementById('actionSolution');
  const assignEl = document.getElementById('actionAssignee');
  const deadEl = document.getElementById('actionDeadline');

  if (keyInput) keyInput.value = card.key;
  if (titleEl) titleEl.textContent = `${card.title} (${card.percent || 0}% от плана)`;
  if (reasonEl) reasonEl.value = card.comments?.reason || '';
  if (solEl) solEl.value = card.comments?.solution || '';
  if (assignEl) assignEl.value = card.comments?.assignee || '';
  if (deadEl) deadEl.value = card.comments?.deadline || '';

  openModal('modalActionPlan');
}

async function submitActionPlan(e) {
  e.preventDefault();
  if (!isAdminLoggedIn) {
    openModal('modalLogin');
    return;
  }
  const indicatorKey = document.getElementById('actionPlanKey')?.value;
  const reason = document.getElementById('actionReason')?.value;
  const solution = document.getElementById('actionSolution')?.value;
  const assignee = document.getElementById('actionAssignee')?.value;
  const deadline = document.getElementById('actionDeadline')?.value;

  try {
    const res = await fetch('/api/indicator-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({
        snapshotId: currentSnapshotId,
        indicatorKey,
        reason,
        solution,
        assignee,
        deadline
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось сохранить комментарий');

    closeAllModals();
    showToast('Комментарий и план действий сохранены');
    await loadSnapshot(currentSnapshotId);
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

async function openMonthlyAndYoYModal() {
  openModal('modalMonthlyAndYoY');
  const yoyGrid = document.getElementById('yoyCardsGrid');
  const table = document.getElementById('monthlyBreakdownTable');
  if (yoyGrid) yoyGrid.innerHTML = '<div class="col-span-full py-4 text-center text-slate-400 text-xs">Загрузка сравнения...</div>';
  if (table) table.innerHTML = '<tr><td class="py-4 text-center text-slate-400 text-xs">Загрузка помесячной разбивки...</td></tr>';

  try {
    const [resYoY, resMon] = await Promise.all([
      fetch('/api/yoy-comparison'),
      fetch('/api/monthly-breakdown')
    ]);
    const yoyData = await resYoY.json();
    const monData = await resMon.json();

    if (yoyGrid && yoyData?.comparison) {
      yoyGrid.innerHTML = '';
      for (const [key, item] of Object.entries(yoyData.comparison)) {
        const isPos = item.growth >= 0;
        const card = document.createElement('div');
        card.className = 'p-3 rounded-2xl bg-slate-50 border border-slate-200 text-xs flex flex-col justify-between';
        card.innerHTML = `
          <div>
            <span class="text-[10px] font-bold text-slate-400 uppercase">${escapeHtml(item.title)}</span>
            <div class="text-sm font-black text-slate-900 mt-1">${formatNumber(item.current2026)} чел.</div>
            <div class="text-[10px] text-slate-500">2025 год: ${formatNumber(item.past2025)} чел.</div>
          </div>
          <div class="mt-2 text-[11px] font-bold ${isPos ? 'text-emerald-600' : 'text-rose-600'}">
            ${isPos ? '▲ +' : '▼ '}${formatNumber(item.growth)} (${item.growthPercent}%)
          </div>
        `;
        yoyGrid.appendChild(card);
      }
    }

    if (table && monData) {
      const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
      let thead = `<thead class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-200"><tr><th class="px-3 py-2">Направление</th><th class="px-2 py-2">Тип</th>`;
      months.forEach(m => { thead += `<th class="px-2 py-2 text-center">${m}</th>`; });
      thead += `</tr></thead>`;

      let tbody = `<tbody class="divide-y divide-slate-100 text-xs">`;
      for (const [k, d] of Object.entries(monData)) {
        tbody += `<tr><td rowspan="2" class="px-3 py-2 font-bold text-slate-800 align-middle bg-slate-50/50">${escapeHtml(d.title)}</td>`;
        tbody += `<td class="px-2 py-1 text-[11px] text-indigo-600 font-semibold">План</td>`;
        d.monthlyPlans.forEach(val => { tbody += `<td class="px-2 py-1 text-center font-medium text-slate-600">${val ? formatNumber(val) : '—'}</td>`; });
        tbody += `</tr><tr><td class="px-2 py-1 text-[11px] text-emerald-700 font-semibold">Факт</td>`;
        d.monthlyFacts.forEach(val => { tbody += `<td class="px-2 py-1 text-center font-bold ${val !== null ? 'text-slate-900' : 'text-slate-300'}">${val !== null ? formatNumber(val) : '—'}</td>`; });
        tbody += `</tr>`;
      }
      tbody += `</tbody>`;
      table.innerHTML = thead + tbody;
    }
  } catch (err) {
    if (yoyGrid) yoyGrid.innerHTML = `<div class="col-span-full text-rose-500 text-xs">Ошибка: ${escapeHtml(err.message)}</div>`;
  }
}

function openOverrideModal(indicatorKey) {
  if (!authToken) {
    openModal('modalLogin');
    return;
  }

  const card = currentSnapshotData.cards.find(c => c.key === indicatorKey);
  if (!card) return;

  document.getElementById('overrideKey').value = card.key;
  document.getElementById('overrideIndicatorTitle').textContent = card.title;
  document.getElementById('overrideSnapshotDate').textContent = currentSnapshotData.snapshot.date;
  document.getElementById('overrideCurrentVal').textContent = `${formatNumber(card.fact)} чел.`;
  document.getElementById('overrideNewValue').value = card.fact;
  document.getElementById('overrideNote').value = card.overrideInfo?.note || '';

  openModal('modalOverride');
}

async function submitOverride(e) {
  e.preventDefault();
  const indicatorKey = document.getElementById('overrideKey').value;
  const newValue = document.getElementById('overrideNewValue').value;
  const note = document.getElementById('overrideNote').value;
  const author = document.getElementById('overrideAuthor').value;

  try {
    const res = await fetch('/api/override', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        snapshotId: currentSnapshotId,
        indicatorKey,
        newValue,
        note,
        author
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сохранения правки');

    closeAllModals();
    showToast('Правка успешно сохранена');
    loadSnapshot(currentSnapshotId);
    loadHistoryChart();
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

async function revertOverride(indicatorKey) {
  if (!confirm('Вернуть значение из таблицы?')) return;

  try {
    const res = await fetch('/api/override/revert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        snapshotId: currentSnapshotId,
        indicatorKey,
        author: 'Администратор'
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сброса');

    showToast('Правка отменена');
    loadSnapshot(currentSnapshotId);
    loadHistoryChart();
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

async function loadAuditLog() {
  try {
    const res = await fetch('/api/audit');
    if (!res.ok) throw new Error('Не удалось загрузить журнал аудита');
    const logs = await res.json();

    const tbody = document.getElementById('auditTableBody');
    tbody.innerHTML = '';

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-slate-400">Журнал пуст</td></tr>';
      return;
    }

    logs.forEach(log => {
      const tr = document.createElement('tr');
      const timeStr = new Date(log.timestamp).toLocaleString('ru-RU');
      const actionBadge = log.action === 'override'
        ? '<span class="text-amber-800 bg-amber-50 px-2 py-0.5 rounded-md font-bold">Правка</span>'
        : (log.action === 'revert'
            ? '<span class="text-blue-800 bg-blue-50 px-2 py-0.5 rounded-md font-bold">Откат</span>'
            : (log.action === 'plan_update'
                ? '<span class="text-purple-800 bg-purple-50 px-2 py-0.5 rounded-md font-bold">Ориентир</span>'
                : '<span class="text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-md font-bold">Срез</span>'));

      tr.innerHTML = `
        <td class="px-4 py-2.5 text-slate-400 whitespace-nowrap">${escapeHtml(timeStr)}</td>
        <td class="px-4 py-2.5 font-bold text-slate-800">${escapeHtml(log.snapshotDate || '—')}</td>
        <td class="px-4 py-2.5 font-bold text-slate-700">${escapeHtml(log.indicatorTitle || log.indicatorKey)} ${actionBadge}</td>
        <td class="px-4 py-2.5 text-slate-400">${log.oldValue !== null ? escapeHtml(formatNumber(log.oldValue)) : '—'}</td>
        <td class="px-4 py-2.5 font-extrabold text-slate-900">${escapeHtml(formatNumber(log.newValue))}</td>
        <td class="px-4 py-2.5 text-slate-600 font-semibold">${escapeHtml(log.author)}</td>
        <td class="px-4 py-2.5 text-slate-500 italic max-w-xs truncate" title="${escapeHtml(log.note || '')}">${escapeHtml(log.note || '—')}</td>
      `;
      tbody.appendChild(tr);
    });

    openModal('modalAuditLog');
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

// --- СОЗДАНИЕ СРЕЗА И ИМПОРТ EXCEL ---

async function submitNewSnapshot(e) {
  e.preventDefault();
  const date = document.getElementById('newSnapshotDate').value;
  const note = document.getElementById('newSnapshotNote').value;
  const gzFact = document.getElementById('newGzFact').value;
  const mfcFact = document.getElementById('newMfcFact').value;
  const kvcFact = document.getElementById('newKvcFact').value;
  const omsuFact = document.getElementById('newOmsuFact').value;

  const indicators = {};
  if (gzFact) indicators.gz = { fact: Number(gzFact) };
  if (mfcFact) indicators.mfc = { fact: Number(mfcFact) };
  if (kvcFact) indicators.kvc = { fact: Number(kvcFact) };
  if (omsuFact) indicators.omsu = { fact: Number(omsuFact) };

  try {
    const res = await fetch('/api/snapshot/manual', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ date, note, indicators })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка создания среза');

    closeAllModals();
    showToast(`Срез на ${data.snapshot.date} зафиксирован!`);
    loadSnapshot(data.snapshot.id);
    loadHistoryChart();
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

async function submitUploadExcel(e) {
  e.preventDefault();
  const fileInput = document.getElementById('excelFileInput');
  const dateVal = document.getElementById('uploadDate').value;

  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Выберите файл Excel');
    return;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('date', dateVal);

  const btn = document.getElementById('btnSubmitUpload');
  btn.disabled = true;
  btn.textContent = 'Обработка...';

  try {
    const res = await fetch('/api/upload-excel', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: formData
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка загрузки Excel');

    closeAllModals();
    showToast('Данные успешно импортированы!');
    loadSnapshot(data.snapshotId);
    loadHistoryChart();
  } catch (err) {
    alert('Ошибка: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Импортировать в дашборд';
  }
}

// --- НАВИГАЦИЯ И СЛУШАТЕЛИ СОБЫТИЙ ---

function setupEventListeners() {
  // Переключение вкладок сайдбара
  document.querySelectorAll('.nav-rail-btn[data-tab]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.nav-rail-btn[data-tab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      handleTabSwitch(tab);
    };
  });

  // Верхние пилюли
  document.querySelectorAll('.tab-pill[data-target]').forEach(pill => {
    pill.onclick = () => {
      document.querySelectorAll('.tab-pill[data-target]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const target = pill.getAttribute('data-target');
      handleTabSwitch(target);
    };
  });

  // Кнопка аудита на сайдбаре
  document.getElementById('railBtnAudit').onclick = () => {
    loadAuditLog();
  };

  // Кнопка загрузки на сайдбаре
  document.getElementById('railBtnUpload').onclick = () => {
    if (!authToken) {
      openModal('modalLogin');
    } else {
      document.getElementById('uploadDate').value = new Date().toISOString().slice(0, 10);
      openModal('modalUploadExcel');
    }
  };

  // Кнопка админа на сайдбаре
  document.getElementById('railBtnAdmin').onclick = openAccountModal;

  const btnLogout = document.getElementById('adminLogoutBtn');
  if (btnLogout) btnLogout.onclick = logoutUser;

  const btnOpenAuditLog = document.getElementById('btnOpenAuditLog');
  if (btnOpenAuditLog) btnOpenAuditLog.onclick = loadAuditLog;

  // Форма логина
  document.getElementById('loginForm').onsubmit = (e) => {
    e.preventDefault();
    loginUser(
      document.getElementById('loginUsername').value,
      document.getElementById('loginPassword').value
    );
  };

  // Селектор среза
  const snapSelect = document.getElementById('snapshotSelect');
  if (snapSelect) {
    snapSelect.onchange = (e) => {
      loadSnapshot(e.target.value);
    };
  }

  // Кнопка "Новый срез" в топбаре и герое
  const openNewSnapshotHandler = () => {
    if (!authToken) {
      openModal('modalLogin');
    } else {
      document.getElementById('newSnapshotDate').value = new Date().toISOString().slice(0, 10);
      openModal('modalNewSnapshot');
    }
  };

  const btnTopNew = document.getElementById('btnTopNewSnapshot');
  if (btnTopNew) btnTopNew.onclick = openNewSnapshotHandler;

  const btnHeroNew = document.getElementById('btnOpenNewSnapshotHero');
  if (btnHeroNew) btnHeroNew.onclick = openNewSnapshotHandler;

  const btnQuickRefresh = document.getElementById('btnQuickRefresh');
  if (btnQuickRefresh) {
    btnQuickRefresh.onclick = async () => {
      const icon = btnQuickRefresh.querySelector('svg') || btnQuickRefresh.querySelector('i');
      if (icon) icon.classList.add('animate-spin');
      await loadSnapshot(currentSnapshotId);
      if (icon) setTimeout(() => icon.classList.remove('animate-spin'), 600);
      showToast('Данные среза актуализированы');
    };
  }

  // Экспорт дропдаун
  const exportBtn = document.getElementById('exportBtn');
  const exportMenu = document.getElementById('exportMenu');
  exportBtn.onclick = (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle('hidden');
  };
  document.addEventListener('click', () => {
    exportMenu.classList.add('hidden');
  });

  // Формы
  document.getElementById('overrideForm').onsubmit = submitOverride;
  document.getElementById('newSnapshotForm').onsubmit = submitNewSnapshot;
  document.getElementById('uploadExcelForm').onsubmit = submitUploadExcel;
  const indicatorPlanForm = document.getElementById('indicatorPlanForm');
  if (indicatorPlanForm) indicatorPlanForm.onsubmit = submitIndicatorPlan;
  const actionPlanForm = document.getElementById('actionPlanForm');
  if (actionPlanForm) actionPlanForm.onsubmit = submitActionPlan;

  // Режим планёрки
  const btnEnterMeeting = document.getElementById('btnEnterMeetingMode');
  if (btnEnterMeeting) btnEnterMeeting.onclick = () => toggleMeetingMode(true);
  const btnExitMeeting = document.getElementById('btnExitMeetingMode');
  if (btnExitMeeting) btnExitMeeting.onclick = () => toggleMeetingMode(false);
  const btnPrintMeeting = document.getElementById('btnPrintMeeting');
  if (btnPrintMeeting) btnPrintMeeting.onclick = () => window.print();

  // Открытие модалки помесячной разбивки и 2025
  const btnOpenMonthly = document.getElementById('btnOpenMonthlyModal');
  if (btnOpenMonthly) btnOpenMonthly.onclick = openMonthlyAndYoYModal;

  // Скрытие / показ красной зоны «Требует внимания» (состояние запоминается)
  const btnToggleAttention = document.getElementById('btnToggleAttention');
  if (btnToggleAttention) {
    const applyAttentionCollapsed = (collapsed) => {
      document.getElementById('attentionCardsGrid')?.classList.toggle('hidden', collapsed);
      document.getElementById('attentionHeader')?.classList.toggle('mb-4', !collapsed);
      btnToggleAttention.setAttribute('aria-expanded', String(!collapsed));
      btnToggleAttention.innerHTML = collapsed
        ? '<i data-lucide="eye" class="w-3.5 h-3.5"></i><span>Показать</span>'
        : '<i data-lucide="eye-off" class="w-3.5 h-3.5"></i><span>Скрыть</span>';
      if (window.lucide) lucide.createIcons();
    };
    let collapsed = false;
    try { collapsed = localStorage.getItem('attentionCollapsed') === '1'; } catch (e) {}
    applyAttentionCollapsed(collapsed);
    btnToggleAttention.onclick = () => {
      collapsed = !collapsed;
      try { localStorage.setItem('attentionCollapsed', collapsed ? '1' : '0'); } catch (e) {}
      applyAttentionCollapsed(collapsed);
    };
  }

  // Кнопка плана действий в блоке "Требует внимания"
  const btnActionPlanModal = document.getElementById('btnOpenActionPlanModal');
  if (btnActionPlanModal) {
    btnActionPlanModal.onclick = () => {
      const firstAttention = currentSnapshotData?.attentionList?.[0];
      openActionPlanModal(firstAttention ? firstAttention.key : 'mfc');
    };
  }

  // Drop zone Excel
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('excelFileInput');
  const fileNameDisplay = document.getElementById('fileNameDisplay');

  dropZone.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    if (fileInput.files.length > 0) fileNameDisplay.textContent = fileInput.files[0].name;
  };
  dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('border-indigo-500', 'bg-indigo-50/50');
  };
  dropZone.ondragleave = () => {
    dropZone.classList.remove('border-indigo-500', 'bg-indigo-50/50');
  };
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-indigo-500', 'bg-indigo-50/50');
    if (e.dataTransfer.files.length > 0) {
      fileInput.files = e.dataTransfer.files;
      fileNameDisplay.textContent = e.dataTransfer.files[0].name;
    }
  };

  // Закрытие модалок
  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.onclick = closeAllModals;
  });
  window.onkeydown = (e) => {
    if (e.key === 'Escape') closeAllModals();
  };
}

function handleTabSwitch(tab) {
  if (tab === 'dashboard') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (tab === 'analytics') {
    const el = document.getElementById('blockAnalytics');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else if (tab === 'table') {
    const el = document.getElementById('blockTable');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else if (tab === 'schedule') {
    const el = document.getElementById('blockSchedule');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else if (tab === 'rating') {
    const el = document.getElementById('blockRating');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else if (tab === 'curators') {
    const el = document.getElementById('blockCurators');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else if (tab === 'timeline') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function openModal(id) {
  if (id === 'modalLogin') { showToast('Недостаточно прав для этого действия'); return; }
  closeAllModals();
  const m = document.getElementById(id);
  if (m) m.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeAllModals() {
  document.querySelectorAll('[id^="modal"]').forEach(el => el.classList.add('hidden'));
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return Number(num).toLocaleString('ru-RU');
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-6 right-6 z-50 bg-slate-900 text-white text-xs font-semibold px-4 py-3 rounded-2xl shadow-2xl border border-slate-700 transition transform duration-300 flex items-center gap-2';
  toast.innerHTML = `<span>✓</span> <span>${message}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ================= ИИ-ПОМОЩНИК (GIGACHAT) =================

function setupChatWidget() {
  const chatBox = document.getElementById('aiChatBox');
  const toggleBtn = document.getElementById('aiChatToggleBtn');
  const railBtnChat = document.getElementById('railBtnChat');
  const closeBtn = document.getElementById('btnChatClose');
  const settingsBtn = document.getElementById('btnChatSettings');
  const settingsPanel = document.getElementById('chatSettingsPanel');
  const clearBtn = document.getElementById('btnChatClear');
  const chatForm = document.getElementById('aiChatForm');
  const chatInput = document.getElementById('aiChatInput');

  // Переключение видимости чата
  const toggleChat = () => {
    const isHidden = chatBox.classList.contains('hidden');
    if (isHidden) {
      chatBox.classList.remove('hidden');
      if (railBtnChat) railBtnChat.classList.add('active');
      checkChatStatus();
      setTimeout(() => chatInput.focus(), 150);
    } else {
      chatBox.classList.add('hidden');
      if (railBtnChat) railBtnChat.classList.remove('active');
    }
  };

  if (toggleBtn) toggleBtn.onclick = toggleChat;
  if (railBtnChat) railBtnChat.onclick = toggleChat;
  if (closeBtn) closeBtn.onclick = toggleChat;

  // Настройки GigaChat
  if (settingsBtn) {
    settingsBtn.onclick = () => {
      settingsPanel.classList.toggle('hidden');
    };
  }

  // Очистка сообщений
  if (clearBtn) {
    clearBtn.onclick = () => {
      chatHistory = [];
      const messagesContainer = document.getElementById('chatMessages');
      messagesContainer.innerHTML = `
        <div class="flex items-start gap-2.5">
          <img src="assets/boris-face-sm.webp?v=2" alt="" class="boris-avatar w-7 h-7 rounded-full object-cover shrink-0 ring-1 ring-indigo-200">
          <div class="bg-slate-100/90 rounded-2xl rounded-tl-sm p-3.5 text-slate-800 max-w-[85%] space-y-2">
            <p>
              История очищена. Борис снова готов: спросите про цифры среза, выгрузку отчёта или сообщение руководителю.
            </p>
          </div>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
    };
  }

  // Быстрые подсказки
  document.querySelectorAll('.ai-prompt-chip').forEach(chip => {
    chip.onclick = () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) {
        chatInput.value = prompt;
        submitChatMessage(prompt);
      }
    };
  });

  // Отправка сообщения
  if (chatForm) {
    chatForm.onsubmit = (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      submitChatMessage(text);
    };
  }

  // Проверка статуса после входа и только ролям с доступом к помощнику
  document.addEventListener('app:ready', () => { if (can('chat')) checkChatStatus(); });
}

async function checkChatStatus() {
  try {
    const res = await fetch('/api/chat/status');
    const data = await res.json();
    const pill = document.getElementById('chatStatusPill');
    const badge = document.getElementById('keyStatusBadge');

    if (data.configured) {
      if (pill) {
        pill.textContent = 'GigaChat подключен';
        pill.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-400/25 text-emerald-200 border border-emerald-400/30';
      }
      if (badge) badge.textContent = 'Ключ задан в окружении сервера';
    } else {
      if (pill) {
        pill.textContent = 'Локальный режим';
        pill.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-400/25 text-amber-200 border border-amber-400/30';
      }
      if (badge) badge.textContent = 'Ключ не задан (работает база)';
    }
  } catch (e) {}
}

async function submitChatMessage(userText) {
  const chatInput = document.getElementById('aiChatInput');
  const submitBtn = document.getElementById('aiChatSubmitBtn');
  chatInput.value = '';

  // 1. Добавляем сообщение пользователя
  appendChatMessage('user', escapeHtml(userText));

  // 2. Добавляем индикатор печати
  const typingId = appendTypingIndicator();

  chatInput.disabled = true;
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userText,
        history: chatHistory,
        snapshotId: currentSnapshotId
      })
    });

    const data = await res.json();
    removeTypingIndicator(typingId);

    if (!res.ok) throw new Error(data.error || 'Ошибка связи с ИИ');

    // Форматируем markdown-ответ
    const formattedReply = formatAiResponse(data.reply);
    appendChatMessage('assistant', formattedReply, data.copyText);

    // Сохраняем в историю
    chatHistory.push({ sender: 'user', text: userText });
    chatHistory.push({ sender: 'assistant', text: data.reply });

  } catch (err) {
    removeTypingIndicator(typingId);
    appendChatMessage('assistant', `⚠️ Ошибка: ${err.message}`);
  } finally {
    chatInput.disabled = false;
    submitBtn.disabled = false;
    chatInput.focus();
  }
}

function appendChatMessage(sender, htmlContent, copyText) {
  const container = document.getElementById('chatMessages');
  const msgEl = document.createElement('div');

  if (sender === 'user') {
    msgEl.className = 'flex items-start justify-end gap-2.5';
    msgEl.innerHTML = `
      <div class="bg-indigo-600 text-white rounded-2xl rounded-tr-sm p-3 max-w-[85%] font-medium leading-relaxed shadow-xs text-xs">
        ${htmlContent}
      </div>
    `;
  } else {
    msgEl.className = 'flex items-start gap-2.5';
    msgEl.innerHTML = `
      <img src="assets/boris-face-sm.webp?v=2" alt="" class="boris-avatar w-7 h-7 rounded-full object-cover shrink-0 ring-1 ring-indigo-200">
      <div class="bg-slate-100/90 rounded-2xl rounded-tl-sm p-3.5 text-slate-800 max-w-[85%] leading-relaxed space-y-1.5 shadow-2xs text-xs">
        ${htmlContent}
      </div>
    `;
  }

  // Готовый текст (сообщение руководителю): кнопка копирования
  if (copyText) {
    const bubble = msgEl.lastElementChild;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs transition';
    btn.innerHTML = '<i data-lucide="copy" class="w-3.5 h-3.5"></i><span>Копировать текст</span>';
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(copyText);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = copyText;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (err) {}
        ta.remove();
      }
      btn.querySelector('span').textContent = 'Скопировано';
      setTimeout(() => { btn.querySelector('span').textContent = 'Копировать текст'; }, 2000);
    };
    bubble.appendChild(document.createElement('br'));
    bubble.appendChild(btn);
  }

  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
  if (window.lucide) lucide.createIcons();
}

function appendTypingIndicator() {
  const id = 'typing-' + Date.now();
  const container = document.getElementById('chatMessages');
  const typingEl = document.createElement('div');
  typingEl.id = id;
  typingEl.className = 'flex items-start gap-2.5';
  typingEl.innerHTML = `
    <img src="assets/boris-face-sm.webp?v=2" alt="" class="boris-avatar animate-pulse w-7 h-7 rounded-full object-cover shrink-0 ring-1 ring-indigo-200">
    <div class="bg-slate-100 rounded-2xl rounded-tl-sm px-4 py-3 text-slate-500 flex items-center gap-1.5 text-xs">
      <span class="inline-block w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce"></span>
      <span class="inline-block w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style="animation-delay: 0.15s"></span>
      <span class="inline-block w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style="animation-delay: 0.3s"></span>
      <span class="ml-1 text-[11px] font-medium text-slate-400">Борис листает цифры...</span>
    </div>
  `;
  container.appendChild(typingEl);
  container.scrollTop = container.scrollHeight;
  if (window.lucide) lucide.createIcons();
  return id;
}

function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function formatAiResponse(rawText) {
  if (!rawText) return '';

  let text = escapeHtml(rawText);

  // Жирный шрифт **текст**
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Ссылки вида [Название](/api/export/...) превращаем в стильные кнопки скачивания
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
    return `<a href="${href}" target="_blank" class="inline-flex items-center gap-1.5 my-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow-xs transition text-xs no-underline">
      <i data-lucide="download" class="w-3.5 h-3.5"></i>
      <span>${label}</span>
    </a>`;
  });

  // Ссылки вида [/api/export/...] без круглых скобок
  text = text.replace(/\[(\/api\/export\/[^\]]+)\]/g, (match, href) => {
    const isHistory = href.includes('history');
    const label = isHistory ? 'Скачать историю в Excel' : 'Скачать срез в Excel';
    return `<a href="${href}" target="_blank" class="inline-flex items-center gap-1.5 my-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow-xs transition text-xs no-underline">
      <i data-lucide="download" class="w-3.5 h-3.5"></i>
      <span>${label}</span>
    </a>`;
  });

  // Маркеры списков
  text = text.replace(/^[•\-] (.*)$/gm, '<li class="ml-3 list-disc">$1</li>');

  // Переносы строк
  text = text.replace(/\n/g, '<br>');

  return text;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

