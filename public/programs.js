// План-график программ и рейтинг по анкетам обратной связи.
// Использует глобальные функции app.js: escapeHtml, openModal, closeAllModals, isAdminLoggedIn.

const PROGRAM_KIND = {
  pk: { short: 'ПК', label: 'ДПП ПК', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  seminar: { short: 'Сем', label: 'Семинар', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  training: { short: 'Трен', label: 'Тренинг', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  distant: { short: 'Дист', label: 'Дистанционный семинар / тренинг', cls: 'bg-teal-50 text-teal-700 border-teal-200' }
};

const GROUP_STATUS = {
  planned: { label: 'Запланирована', bar: 'bg-indigo-300', chip: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  running: { label: 'Идёт', bar: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  finished: { label: 'Завершена', bar: 'bg-slate-300', chip: 'bg-slate-100 text-slate-600 border-slate-200' },
  rated: { label: 'Анкета получена', bar: 'bg-sky-600', chip: 'bg-sky-50 text-sky-700 border-sky-200' },
  no_feedback: { label: 'Анкета не собрана', bar: 'bg-rose-500', chip: 'bg-rose-50 text-rose-700 border-rose-200' },
  cancelled: { label: 'Отменена', bar: 'bg-slate-100 border border-dashed border-slate-400', chip: 'bg-slate-50 text-slate-500 border-slate-200' }
};

const MODE_NAMES = { inperson: 'Очно', distant: 'Дистанционно' };

const FUNDING_NAMES = { gz: 'Госзадание', mfc: 'МФЦ МО', kvc: 'КВЦ', omsu: 'ОМСУ' };
const MONTH_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

let scheduleData = null;
let ratingsData = null;
let feedbackFilesInfo = null;
let ratingTypeFilter = 'all';
let ratingModeFilter = 'all';
let signalsExpanded = false;
let openedProgram = null; // { pid, ratingKey }

// ---------- помощники ----------

async function pFetch(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* не JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function pPost(url, body) {
  return pFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}

function pToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-6 right-6 z-[60] max-w-sm text-white text-xs font-semibold px-4 py-3 rounded-2xl shadow-2xl border transition duration-300 flex items-start gap-2 '
    + (isError ? 'bg-rose-700 border-rose-500' : 'bg-slate-900 border-slate-700');
  const mark = document.createElement('span');
  mark.textContent = isError ? '✕' : '✓';
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(mark, text);
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, isError ? 6000 : 3500);
}

// право на правку план-графика и анкет: администратор и методист
function requireAdmin() {
  if (can('programsEdit')) return true;
  pToast('Недостаточно прав для этого действия', true);
  return false;
}

function fmtDM(iso) { return iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : ''; }
function fmtDMY(iso) { return iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : ''; }
function periodText(start, end) { return start === end ? fmtDM(start) : `${fmtDM(start)}–${fmtDM(end)}`; }
function fmtPct(v) { return v === null || v === undefined ? '—' : `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`; }

function satTone(v) {
  if (v >= 90) return { bar: 'bg-emerald-500', text: 'text-emerald-700' };
  if (v >= 85) return { bar: 'bg-amber-500', text: 'text-amber-700' };
  return { bar: 'bg-rose-500', text: 'text-rose-700' };
}

function kindBadge(kind) {
  const k = PROGRAM_KIND[kind] || { short: '—', label: '', cls: 'bg-slate-50 text-slate-500 border-slate-200' };
  return `<span title="${escapeHtml(k.label)}" class="shrink-0 px-1.5 py-0.5 rounded-md border text-[9px] font-extrabold uppercase ${k.cls}">${escapeHtml(k.short)}</span>`;
}

function statusChip(status) {
  const st = GROUP_STATUS[status] || GROUP_STATUS.finished;
  return `<span class="px-2 py-0.5 rounded-full border text-[10px] font-bold whitespace-nowrap ${st.chip}">${st.label}</span>`;
}

function errorBlock(message, retryFn) {
  return `<div class="p-6 text-center text-xs text-slate-500">
    <p class="mb-3">${escapeHtml(message)}</p>
    <button type="button" onclick="${retryFn}" class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold">Повторить попытку</button>
  </div>`;
}

// положение даты на дорожке: 12 равных месяцев
function pctPos(iso, year, isEnd) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (y < year) return 0;
  if (y > year) return 100;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return ((m - 1) + (isEnd ? d : d - 1) / dim) / 12 * 100;
}

function groupTouchesMonth(g, month, year) {
  const a = Number(g.start.slice(0, 4)) === year ? Number(g.start.slice(5, 7)) : 1;
  const b = Number(g.end.slice(0, 4)) === year ? Number(g.end.slice(5, 7)) : 12;
  return a <= month && month <= b;
}

// ---------- план-график ----------

async function loadSchedule() {
  try {
    scheduleData = await pFetch('/api/schedule');
    renderSchedule();
  } catch (e) {
    const box = document.getElementById('scheduleGantt');
    if (box) box.innerHTML = errorBlock(e.message, 'loadSchedule()');
  }
}

function getScheduleFilters() {
  return {
    q: document.getElementById('schedSearch')?.value || '',
    type: document.getElementById('schedType')?.value || 'all',
    status: document.getElementById('schedStatus')?.value || 'all',
    mode: document.getElementById('schedMode')?.value || 'all',
    month: document.getElementById('schedMonth')?.value || 'all'
  };
}

function renderSchedule() {
  const s = scheduleData;
  if (!s) return;
  const subtitle = document.getElementById('scheduleSubtitle');
  const chips = document.getElementById('scheduleChips');
  const upcoming = document.getElementById('scheduleUpcoming');
  const legend = document.getElementById('scheduleLegend');
  const gantt = document.getElementById('scheduleGantt');

  if (!s.loaded) {
    subtitle.textContent = 'План-график не загружен';
    chips.innerHTML = '';
    upcoming.innerHTML = '';
    legend.innerHTML = '';
    document.getElementById('scheduleCount').textContent = '';
    gantt.innerHTML = `<div class="p-8 text-center text-xs text-slate-500">
      <p class="font-bold text-slate-700 mb-1">План-график ещё не загружен</p>
      <p>Администратор может загрузить Excel-файл план-графика кнопкой «Загрузить план-график».</p>
    </div>`;
    return;
  }

  const upl = s.uploadedAt ? new Date(s.uploadedAt).toLocaleDateString('ru-RU') : '';
  subtitle.textContent = `Файл «${s.fileName || '—'}»${upl ? ' · загружен ' + upl : ''} · статусы на ${fmtDMY(s.asOf)}`;

  const sm = s.summary;
  const chipDefs = [
    { label: 'Программ', value: sm.programs, cls: 'bg-slate-50 text-slate-700 border-slate-200' },
    { label: 'Групп', value: sm.groups, cls: 'bg-slate-50 text-slate-700 border-slate-200' },
    { label: 'очных групп', value: sm.byMode.inperson.groups, sub: `${sm.byMode.inperson.hours} ак. ч`, mode: 'inperson', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
    { label: 'дистанционных', value: sm.byMode.distant.groups, sub: `${sm.byMode.distant.hours} ак. ч`, mode: 'distant', cls: 'bg-teal-50 text-teal-800 border-teal-200' },
    { label: 'Идут', value: sm.running, status: 'running', cls: GROUP_STATUS.running.chip },
    { label: 'Запланированы', value: sm.planned, status: 'planned', cls: GROUP_STATUS.planned.chip },
    { label: 'Анкета получена', value: sm.rated, status: 'rated', cls: GROUP_STATUS.rated.chip },
    { label: 'Анкета не собрана', value: sm.no_feedback, status: 'no_feedback', cls: sm.no_feedback ? GROUP_STATUS.no_feedback.chip : 'bg-slate-50 text-slate-500 border-slate-200' }
  ].filter(c => !(c.status === 'no_feedback' && s.feedbackSource && s.feedbackSource.empty));
  const fundingUnset = s.fundingSummary.none && s.fundingSummary.none.groups === sm.groups;
  chips.innerHTML = chipDefs.map(c => {
    const inner = `<span class="text-sm font-extrabold">${c.value}</span> <span class="font-semibold">${c.label}</span>${c.sub ? ` <span class="opacity-70">· ${c.sub}</span>` : ''}`;
    if (c.mode) return `<button type="button" data-chip-mode="${c.mode}" class="px-3 py-1.5 rounded-xl border text-xs ${c.cls} hover:brightness-95 transition" title="Показать только ${c.label}">${inner}</button>`;
    return c.status
      ? `<button type="button" data-chip-status="${c.status}" class="px-3 py-1.5 rounded-xl border text-xs ${c.cls} hover:brightness-95 transition">${inner}</button>`
      : `<span class="px-3 py-1.5 rounded-xl border text-xs ${c.cls}">${inner}</span>`;
  }).join('') + (fundingUnset
    ? `<span class="px-3 py-1.5 text-[11px] text-slate-400">Источник финансирования и план слушателей по группам пока не заданы: откройте программу и заполните (администратор).</span>`
    : '');

  const upBlock = (title, rows, dateOf) => {
    const items = rows.length
      ? rows.slice(0, 8).map(r => `
        <button type="button" data-open-program="${escapeHtml(r.pid)}" class="w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded-lg hover:bg-indigo-50/60 transition">
          <span class="w-14 shrink-0 text-[11px] font-extrabold text-indigo-600">${fmtDM(dateOf(r))}</span>
          ${kindBadge(r.kind)}
          <span class="text-xs text-slate-700 truncate" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
        </button>`).join('') + (rows.length > 8 ? `<p class="px-2.5 pt-1 text-[11px] text-slate-400">и ещё ${rows.length - 8}</p>` : '')
      : '<p class="px-2.5 py-1.5 text-xs text-slate-400">Нет</p>';
    return `<div class="rounded-2xl border border-slate-200 p-3">
      <h4 class="px-2.5 pb-1.5 text-[11px] font-extrabold uppercase tracking-wider text-slate-400">${title} <span class="text-slate-300">· ${rows.length}</span></h4>
      ${items}</div>`;
  };
  upcoming.innerHTML = upBlock('Стартуют в ближайшие 2 недели', s.upcoming.starting, r => r.start)
    + upBlock('Завершаются в ближайшие 2 недели', s.upcoming.ending, r => r.end);

  legend.innerHTML = Object.values(GROUP_STATUS).map(st =>
    `<span class="inline-flex items-center gap-1.5"><span class="inline-block w-3 h-2.5 rounded ${st.bar}"></span>${st.label}</span>`
  ).join('')
    + `<span class="inline-flex items-center gap-1.5"><span class="inline-block w-px h-3 bg-rose-500"></span>сегодня</span>`
    + `<span class="text-slate-400">ПК — повышение квалификации · Сем — семинар · Трен — тренинг · Дист — дистанционный</span>`;

  renderScheduleGantt();
}

function renderScheduleGantt() {
  const s = scheduleData;
  const box = document.getElementById('scheduleGantt');
  if (!s || !s.loaded || !box) return;
  const f = getScheduleFilters();
  const year = s.year;
  const q = f.q.trim().toLowerCase();

  const progs = s.programs.filter(p => {
    if (f.type !== 'all' && p.kind !== f.type) return false;
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (f.status !== 'all' && !p.groups.some(g => g.status === f.status)) return false;
    if (f.mode !== 'all' && !p.groups.some(g => g.mode === f.mode)) return false;
    if (f.month !== 'all' && !p.groups.some(g => groupTouchesMonth(g, Number(f.month), year))) return false;
    return true;
  });
  document.getElementById('scheduleCount').textContent = `Показано программ: ${progs.length} из ${s.programs.length}`;

  if (progs.length === 0) {
    box.innerHTML = '<div class="p-8 text-center text-xs text-slate-500">Нет программ по выбранным фильтрам</div>';
    return;
  }

  const todayPct = pctPos(s.asOf, year, false);
  const asOfMonth = Number(s.asOf.slice(5, 7));
  const labels = [];
  const tracks = [];
  let lastDir = null;

  progs.forEach(p => {
    const dirKey = `${p.section}|${p.direction}`;
    if (dirKey !== lastDir) {
      lastDir = dirKey;
      labels.push(`<div class="h-[24px] px-3 flex items-center bg-slate-50 border-b border-slate-100 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 truncate" title="${escapeHtml(p.direction)}">${escapeHtml(p.direction)}</div>`);
      tracks.push('<div class="h-[24px] bg-slate-50 border-b border-slate-100"></div>');
    }
    labels.push(`<button type="button" data-open-program="${escapeHtml(p.pid)}" class="h-[30px] w-full px-3 flex items-center gap-2 text-left text-[11px] font-semibold text-slate-700 hover:bg-indigo-50/60 border-b border-slate-100 transition" title="${escapeHtml(p.name)}">
      ${kindBadge(p.kind)}<span class="truncate">${escapeHtml(p.name)}</span></button>`);

    const bars = p.groups.map(g => {
      const left = pctPos(g.start, year, false);
      const right = pctPos(g.end, year, true);
      const width = Math.max(right - left, 0.2);
      const st = GROUP_STATUS[g.status] || GROUP_STATUS.finished;
      const dim = (f.status !== 'all' && g.status !== f.status) || (f.mode !== 'all' && g.mode !== f.mode) ? 'opacity-25' : '';
      const tip = [`${p.name}`, `${periodText(g.start, g.end)} · ${st.label} · ${MODE_NAMES[g.mode] || ''}`,
        g.curator ? `Куратор: ${g.curator}` : '',
        g.feedback ? `Удовлетворённость ${fmtPct(g.feedback.satisfaction)}, анкет ${g.feedback.forms}` : '',
        g.funding ? `Источник: ${FUNDING_NAMES[g.funding]}` : '', g.planned ? `План: ${g.planned} чел.` : ''].filter(Boolean).join('\n');
      return `<button type="button" data-open-program="${escapeHtml(p.pid)}" class="gantt-bar absolute top-[6px] h-[18px] rounded ${st.bar} ${dim}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;min-width:6px" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></button>`;
    }).join('');
    tracks.push(`<div class="gantt-track h-[30px] relative border-b border-slate-100">${bars}</div>`);
  });

  const monthHead = MONTH_SHORT.map((m, i) =>
    `<div class="px-1 py-2 text-center text-[10px] font-bold uppercase ${i + 1 === asOfMonth ? 'text-rose-600' : 'text-slate-400'}">${m}</div>`).join('');

  box.innerHTML = `<div class="overflow-x-auto"><div class="min-w-[960px] grid" style="grid-template-columns: 280px 1fr">
    <div class="sticky left-0 z-10 bg-white px-3 py-2 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-400">Программа</div>
    <div class="grid grid-cols-12 border-b border-slate-200">${monthHead}</div>
    <div class="sticky left-0 z-10 bg-white border-r border-slate-100">${labels.join('')}</div>
    <div class="relative">${tracks.join('')}<div class="absolute top-0 bottom-0 w-px bg-rose-500/70 pointer-events-none" style="left:${todayPct.toFixed(2)}%" title="Сегодня ${fmtDMY(s.asOf)}"></div></div>
  </div></div>`;
}

async function uploadSchedule(file) {
  const out = document.getElementById('scheduleImportResult');
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await pFetch('/api/schedule/upload', { method: 'POST', body: fd });
    const lines = [`<strong>Загружено:</strong> программ ${r.programs}, групп ${r.groups}.`];
    if (r.removed && r.removed.length) {
      lines.push(`<strong>Убраны из план-графика (${r.removed.length}):</strong> ${r.removed.slice(0, 5).map(escapeHtml).join('; ')}${r.removed.length > 5 ? '…' : ''}`);
    }
    if (r.added && r.added !== r.groups) lines.push(`<strong>Новых групп:</strong> ${r.added}.`);
    if (r.warnings && r.warnings.length) {
      lines.push(`<strong>Не разобрано (${r.warnings.length}):</strong> ${r.warnings.slice(0, 5).map(escapeHtml).join('; ')}`);
    }
    out.innerHTML = lines.join('<br>');
    out.classList.remove('hidden');
    pToast('План-график загружен');
    await Promise.all([loadSchedule(), loadRatings()]);
    renderRatings();
  } catch (e) {
    out.innerHTML = `<strong class="text-rose-700">${escapeHtml(e.message)}</strong>`;
    out.classList.remove('hidden');
    pToast(e.message, true);
  }
}

// ---------- карточка программы ----------

function openProgramModal(pid, ratingKey) {
  const p = pid && scheduleData ? scheduleData.programs.find(x => x.pid === pid) : null;
  const r = ratingsData ? ratingsData.ratings.find(x => (pid && x.programId === pid) || (ratingKey && x.key === ratingKey)) : null;
  if (!p && !r) return;
  openedProgram = { pid: pid || null, ratingKey: ratingKey || (r && r.key) || null };

  const head = document.getElementById('programModalHead');
  const body = document.getElementById('programModalBody');
  const title = p ? p.name : r.title;
  const kindKey = p ? p.kind : r.type;
  const meta = [];
  if (p && p.hours) meta.push(`${p.hours} ак. ч`);
  if (p && p.form) meta.push(p.form);
  if (p) meta.push(p.direction);
  const modeKey = p ? p.mode : (r ? r.mode : null);
  if (modeKey) meta.unshift(MODE_NAMES[modeKey]);
  let curLine = '';
  if (p) {
    const counts = {};
    p.groups.forEach(g => { if (g.curator && g.status !== 'cancelled') counts[g.curator] = (counts[g.curator] || 0) + 1; });
    const list = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (list.length) curLine = `<div class="mt-1 text-xs text-slate-500">Кураторы: ${list.map(([n, c]) => `<span class="font-semibold text-slate-700">${escapeHtml(n)}</span> (${c})`).join(', ')}</div>`;
  }
  head.innerHTML = `<h3 class="text-base lg:text-lg font-extrabold text-slate-900 leading-snug">${escapeHtml(title)}</h3>
    <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">${kindBadge(kindKey)}<span>${escapeHtml(meta.join(' · '))}</span></div>${curLine}`;

  let html = '';
  if (p) html += renderProgramGroups(p);
  html += renderProgramFeedback(r, Boolean(p));
  body.innerHTML = html;
  openModal('modalProgram');
}

function fundingOptions(selected) {
  return ['', 'gz', 'mfc', 'kvc', 'omsu'].map(k =>
    `<option value="${k}" ${k === (selected || '') ? 'selected' : ''}>${k ? FUNDING_NAMES[k] : '— не задан —'}</option>`).join('');
}

function renderProgramGroups(p) {
  const admin = can('programsEdit');
  const inputCls = 'px-2 py-1 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 focus:outline-none';
  const pm = p.meta || {};
  const programForm = admin ? `
    <div class="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-3.5">
      <p class="text-[11px] font-extrabold uppercase tracking-wider text-indigo-500 mb-2">Параметры программы (для всех групп)</p>
      <div class="flex flex-wrap items-end gap-3">
        <label class="text-[11px] font-bold text-slate-600">Источник финансирования<br><select id="pmFunding" class="${inputCls} mt-1 bg-white">${fundingOptions(pm.funding)}</select></label>
        <label class="text-[11px] font-bold text-slate-600">План слушателей на группу<br><input id="pmPlanned" type="number" min="0" value="${pm.planned ?? ''}" class="${inputCls} mt-1 w-28"></label>
        <label class="text-[11px] font-bold text-slate-600">Куратор<br><input id="pmCurator" type="text" value="${escapeHtml(pm.curator || '')}" class="${inputCls} mt-1 w-44"></label>
        <button type="button" data-save-program="${escapeHtml(p.key)}" class="px-3 py-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm transition">Сохранить</button>
      </div>
      <p class="text-[10px] text-slate-400 mt-2">Значения у группы ниже переопределяют параметры программы. Пустое поле группы = брать из программы.</p>
    </div>` : '';

  const rows = p.groups.map(g => {
    const own = g.ownMeta || {};
    const fbCell = g.feedback
      ? `<span class="font-bold ${satTone(g.feedback.satisfaction).text}">${fmtPct(g.feedback.satisfaction)}</span> <span class="text-slate-400">(${g.feedback.forms}${g.feedback.listeners ? '/' + g.feedback.listeners : ''})</span>`
      : '<span class="text-slate-300">—</span>';
    const sessions = g.sessions
      ? `<div class="text-[10px] text-slate-400">${g.sessions.map(x => `${x.name}: ${x.from === x.to ? x.from : x.from + '–' + x.to}`).join(' · ')}</div>` : '';
    const planned = admin
      ? `<input type="number" min="0" data-gm="planned" value="${own.planned ?? ''}" placeholder="${g.planned ?? ''}" class="${inputCls} w-20">`
      : (g.planned ?? '—');
    const fundHint = g.fundingSource === 'status' ? `<div class="text-[10px] text-slate-400">из статусов: ${FUNDING_NAMES[g.funding]}</div>` : '';
    const funding = admin
      ? `<select data-gm="funding" class="${inputCls} bg-white">${fundingOptions(own.funding)}</select>${fundHint}`
      : (g.funding ? FUNDING_NAMES[g.funding] + fundHint : '—');
    const curSrc = g.curatorSource === 'table' ? 'из таблицы кураторов' : (g.curatorSource === 'anketa' ? 'из анкеты' : '');
    const curator = admin
      ? `<input type="text" data-gm="curator" value="${escapeHtml(own.curator || '')}" placeholder="${escapeHtml(g.curator || '')}" class="${inputCls} w-36">`
        + (curSrc ? `<div class="text-[10px] text-slate-400">${curSrc}</div>` : '')
        + (g.substitute ? `<div class="text-[10px] text-amber-700">замена: ${escapeHtml(g.substitute)}</div>` : '')
      : `<span title="${curSrc}">${escapeHtml(g.curator || '—')}</span>` + (g.substitute ? `<div class="text-[10px] text-amber-700">замена: ${escapeHtml(g.substitute)}</div>` : '');
    const pr = g.progress && g.progress.latest;
    const progressCell = pr && pr.requested !== null
      ? `<span title="Статус на ${fmtDMY(pr.date)}">${pr.completed !== null ? pr.completed : '—'} из ${pr.requested}${pr.rate !== null ? ` <span class="font-bold ${satTone(pr.rate).text}">· ${fmtPct(pr.rate)}</span>` : ''}</span>`
      : '<span class="text-slate-300">—</span>';
    return `<tr data-gid="${escapeHtml(g.id)}">
      <td class="px-3 py-2 whitespace-nowrap font-semibold">${periodText(g.start, g.end)}${sessions}</td>
      <td class="px-3 py-2 whitespace-nowrap">${MODE_NAMES[g.mode] || '—'}</td>
      <td class="px-3 py-2">${statusChip(g.status)}</td>
      <td class="px-3 py-2">${planned}</td>
      <td class="px-3 py-2">${funding}</td>
      <td class="px-3 py-2">${curator}</td>
      <td class="px-3 py-2">${g.applications ?? '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2 whitespace-nowrap">${progressCell}</td>
      <td class="px-3 py-2 whitespace-nowrap">${fbCell}</td>
      ${admin ? `<td class="px-3 py-2"><button type="button" data-save-group="${escapeHtml(g.id)}" class="px-2.5 py-1 text-[11px] font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition">Сохранить</button></td>` : ''}
    </tr>`;
  }).join('');

  return `<div class="space-y-3">
    <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400">Группы по план-графику (${p.groups.length})</h4>
    ${programForm}
    <div class="overflow-x-auto rounded-2xl border border-slate-200">
      <table class="w-full text-left text-xs text-slate-700">
        <thead class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-100">
          <tr><th class="px-3 py-2.5">Даты</th><th class="px-3 py-2.5">Формат</th><th class="px-3 py-2.5">Статус</th><th class="px-3 py-2.5">План, чел.</th><th class="px-3 py-2.5">Финансирование</th><th class="px-3 py-2.5">Куратор</th><th class="px-3 py-2.5" title="По таблице кураторов">Заявок</th><th class="px-3 py-2.5" title="Завершили из заявленных по еженедельным статусам">Обучение</th><th class="px-3 py-2.5">Анкета</th>${admin ? '<th class="px-3 py-2.5"></th>' : ''}</tr>
        </thead>
        <tbody class="divide-y divide-slate-100">${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function renderProgramFeedback(r, hasSchedule) {
  if (!r) {
    return `<div class="rounded-2xl border border-dashed border-slate-200 p-5 text-center text-xs text-slate-400">Анкет по этой программе пока нет. Положите сводную анкету в папку — она появится здесь после чтения папки.</div>`;
  }
  const tone = satTone(r.satisfaction);
  const cov = r.coverage !== null ? `${Math.round(r.coverage * 100)}%` : '—';
  const stat = (label, value, extra = '') => `<div class="rounded-2xl border border-slate-200 p-3"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${label}</div><div class="text-lg font-extrabold ${extra}">${value}</div></div>`;
  const groups = r.groups.map(g => {
    const qs = g.questions.map(q => {
      const t = satTone(q.satisfaction);
      return `<tr><td class="px-3 py-1.5">${escapeHtml(q.text)}</td>
        ${q.counts.map(c => `<td class="px-2 py-1.5 text-center ${c ? '' : 'text-slate-300'}">${c || '–'}</td>`).join('')}
        <td class="px-3 py-1.5 font-bold ${t.text} whitespace-nowrap">${fmtPct(q.satisfaction)}</td></tr>`;
    }).join('');
    const warn = g.warnings && g.warnings.length
      ? `<p class="mt-1.5 text-[11px] text-amber-700">В файле расхождения (показан пересчёт по оценкам): ${g.warnings.map(escapeHtml).join('; ')}</p>` : '';
    return `<div class="rounded-2xl border border-slate-200 overflow-hidden">
      <div class="px-3 py-2 bg-slate-50 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span class="font-bold text-slate-800">Группа ${periodText(g.start, g.end)}${g.curator ? ' · ' + escapeHtml(g.curator) : ''}</span>
        <span class="text-slate-500">анкет ${g.forms}${g.listeners ? ' из ' + g.listeners : ''} · удовлетворённость <strong class="${satTone(g.satisfaction).text}">${fmtPct(g.satisfaction)}</strong></span>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-left text-xs text-slate-700">
        <thead class="text-[10px] uppercase font-bold text-slate-400"><tr><th class="px-3 py-1.5">Вопрос</th><th class="px-2 py-1.5 text-center">1</th><th class="px-2 py-1.5 text-center">2</th><th class="px-2 py-1.5 text-center">3</th><th class="px-2 py-1.5 text-center">4</th><th class="px-2 py-1.5 text-center">5</th><th class="px-3 py-1.5">%</th></tr></thead>
        <tbody class="divide-y divide-slate-100">${qs}</tbody></table></div>${warn ? `<div class="px-3 pb-2">${warn}</div>` : ''}
    </div>`;
  }).join('');

  const comments = r.comments.length
    ? r.comments.map(c => `<div><p class="text-[11px] font-bold text-slate-600 mb-1">${escapeHtml(c.question)}</p>
        <ul class="space-y-1">${c.items.map(i => `<li class="text-xs text-slate-700 pl-3 border-l-2 border-slate-200">${escapeHtml(i)}</li>`).join('')}</ul></div>`).join('')
    : '<p class="text-xs text-slate-400">Комментариев нет</p>';

  return `<div class="space-y-4">
    <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400">Обратная связь слушателей</h4>
    ${!hasSchedule ? '<p class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">Программа не найдена в план-графике: анкета учитывается по названию. Проверьте название и даты или привяжите анкету вручную в списке файлов под рейтингом.</p>' : ''}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${stat('Удовлетворённость', fmtPct(r.satisfaction), tone.text)}
      ${stat('Средний балл', `${r.avgScore.toLocaleString('ru-RU')} <span class="text-xs font-semibold text-slate-400">из 5</span>`)}
      ${stat('Анкет', `${r.forms}${r.listeners ? ' <span class="text-xs font-semibold text-slate-400">из ' + r.listeners + '</span>' : ''}`)}
      ${stat('Охват', cov, r.coverage !== null && r.coverage < 0.6 ? 'text-amber-700' : '')}
    </div>
    ${r.enough ? '' : '<p class="text-[11px] text-slate-500">Меньше 5 анкет: программа показана в таблице, но не получает место в рейтинге.</p>'}
    <div class="space-y-3">${groups}</div>
    <div><h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400 mb-2">Комментарии</h4><div class="space-y-3">${comments}</div></div>
  </div>`;
}

async function saveProgramMeta(programKey) {
  if (!requireAdmin()) return;
  try {
    const planned = document.getElementById('pmPlanned').value;
    await pPost('/api/schedule/meta', {
      programKey,
      funding: document.getElementById('pmFunding').value,
      planned: planned === '' ? null : Number(planned),
      curator: document.getElementById('pmCurator').value
    });
    pToast('Параметры программы сохранены');
    await loadSchedule();
    if (openedProgram) openProgramModal(openedProgram.pid, openedProgram.ratingKey);
  } catch (e) {
    pToast(e.message, true);
  }
}

async function saveGroupMeta(groupId) {
  if (!requireAdmin()) return;
  const row = document.querySelector(`#programModalBody tr[data-gid="${CSS.escape(groupId)}"]`);
  if (!row) return;
  try {
    const planned = row.querySelector('[data-gm="planned"]').value;
    await pPost('/api/schedule/meta', {
      groupId,
      planned: planned === '' ? null : Number(planned),
      funding: row.querySelector('[data-gm="funding"]').value,
      curator: row.querySelector('[data-gm="curator"]').value
    });
    pToast('Параметры группы сохранены');
    await loadSchedule();
    if (openedProgram) openProgramModal(openedProgram.pid, openedProgram.ratingKey);
  } catch (e) {
    pToast(e.message, true);
  }
}

// ---------- рейтинг ----------

async function loadRatings() {
  try {
    const [ratings, files] = await Promise.all([pFetch('/api/feedback/ratings'), pFetch('/api/feedback/files')]);
    ratingsData = ratings;
    feedbackFilesInfo = files;
    renderRatings();
  } catch (e) {
    const body = document.getElementById('ratingTableBody');
    if (body) body.innerHTML = `<tr><td colspan="9">${errorBlock(e.message, 'loadRatings()')}</td></tr>`;
  }
}

function renderRatings() {
  const d = ratingsData;
  if (!d) return;
  const info = feedbackFilesInfo || { dir: '', files: [], lastScanAt: null };

  const list = d.ratings.filter(r => (ratingTypeFilter === 'all' || r.type === ratingTypeFilter)
    && (ratingModeFilter === 'all' || r.mode === ratingModeFilter));
  const totalForms = d.ratings.reduce((a, r) => a + r.forms, 0);
  const scanned = info.lastScanAt ? new Date(info.lastScanAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'ещё не читалась';
  document.getElementById('ratingSubtitle').textContent = `Программ с анкетами: ${d.ratings.length} · анкет: ${totalForms} · папка прочитана: ${scanned}`;

  renderRatingSourceBanner(d.source || info.source);

  const ratingMode = document.getElementById('ratingMode');
  if (ratingMode) ratingMode.onchange = () => { ratingModeFilter = ratingMode.value; renderRatings(); };

  document.querySelectorAll('.rating-tab').forEach(btn => {
    const active = btn.getAttribute('data-rtype') === ratingTypeFilter;
    btn.className = 'rating-tab px-3 py-1.5 rounded-xl border ' + (active
      ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50');
  });

  const rankedByType = {};
  d.ratings.forEach(r => { if (r.rank) rankedByType[r.type] = (rankedByType[r.type] || 0) + 1; });

  const tbody = document.getElementById('ratingTableBody');
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-xs text-slate-500">
      <p class="font-bold text-slate-700 mb-1">Анкет пока нет</p>
      <p>Положите сводные анкеты (.xlsx) в папку: <span class="font-mono text-slate-700">${escapeHtml(info.dir || '')}</span></p></td></tr>`;
  } else {
    tbody.innerHTML = list.map(r => {
      const tone = satTone(r.satisfaction);
      const cov = r.coverage !== null ? Math.round(r.coverage * 100) : null;
      const trend = r.trend === null ? '<span class="text-slate-300">—</span>'
        : `<span class="font-bold ${r.trend >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${r.trend >= 0 ? '▲ +' : '▼ '}${String(r.trend).replace('.', ',')} п.п.</span>`;
      return `<tr class="${r.enough ? '' : 'text-slate-400'} hover:bg-indigo-50/40 cursor-pointer" data-open-program="${escapeHtml(r.programId || '')}" data-rating-key="${escapeHtml(r.key)}">
        <td class="px-3 py-3 whitespace-nowrap font-extrabold ${r.rank === 1 ? 'text-amber-500' : ''}" title="Место среди программ вида «${escapeHtml(r.typeLabel)}»">${r.rank ? `${r.rank}<span class="text-[10px] font-semibold text-slate-400"> из ${rankedByType[r.type]}</span>` : '—'}</td>
        <td class="px-3 py-3 max-w-[340px]"><div class="font-semibold text-slate-800 ${r.enough ? '' : '!text-slate-500'}">${escapeHtml(r.title)}</div>
          ${r.enough ? '' : '<span class="text-[10px] font-bold text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">мало данных</span> '}
          ${r.linked ? '' : '<span class="text-[10px] font-bold text-amber-700 bg-amber-50 rounded px-1.5 py-0.5" title="Анкета не найдена в план-графике">нет в план-графике</span>'}</td>
        <td class="px-3 py-3 whitespace-nowrap">${escapeHtml(r.typeLabel)}<div class="text-[10px] text-slate-400">${MODE_NAMES[r.mode] || ''}</div></td>
        <td class="px-3 py-3">${r.groupsCount}</td>
        <td class="px-3 py-3 whitespace-nowrap">${r.forms}${r.listeners ? ' / ' + r.listeners : ''}${cov !== null ? ` <span class="${cov < 60 ? 'text-amber-600 font-bold' : 'text-slate-400'}">· ${cov}%</span>` : ''}</td>
        <td class="px-3 py-3"><div class="flex items-center gap-2"><div class="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div class="h-full rounded-full ${tone.bar}" style="width:${Math.min(100, r.satisfaction)}%"></div></div><span class="font-extrabold ${tone.text}">${fmtPct(r.satisfaction)}</span></div></td>
        <td class="px-3 py-3 font-bold">${r.avgScore.toLocaleString('ru-RU')}</td>
        <td class="px-3 py-3 max-w-[260px] text-slate-500">${r.weakest ? `${escapeHtml(r.weakest.text)} <span class="font-bold ${satTone(r.weakest.satisfaction).text}">${fmtPct(r.weakest.satisfaction)}</span>` : '—'}</td>
        <td class="px-3 py-3 whitespace-nowrap">${trend}</td>
      </tr>`;
    }).join('');
  }

  renderRatingSignals(d.signals);
  renderRatingThemes(d.themes);
  renderFeedbackFiles(info);
}

function renderRatingSourceBanner(src) {
  const box = document.getElementById('ratingSourceBanner');
  if (!box) return;
  if (!src || !src.empty) { box.className = 'hidden'; box.innerHTML = ''; return; }
  box.className = 'px-4 py-3 rounded-2xl border border-amber-200 bg-amber-50 text-xs text-amber-800';
  box.innerHTML = `<p class="font-bold">Источник анкет пуст — проверьте путь</p>
    <p class="mt-0.5">Папка: <span class="font-mono">${escapeHtml(src.dir || '')}</span>${src.exists ? ' — файлов .xlsx нет' : ' — не найдена'}. Статус «анкета не собрана» и связанные сигналы не выводятся, пока в источнике нет анкет.</p>`;
}

function renderRatingSignals(signals) {
  const box = document.getElementById('ratingSignals');
  if (!signals.length) {
    box.innerHTML = '<p class="text-xs text-slate-400">Сигналов нет</p>';
    return;
  }
  const tone = {
    danger: 'bg-rose-50 border-rose-200 text-rose-800',
    warn: 'bg-amber-50 border-amber-200 text-amber-800',
    info: 'bg-slate-50 border-slate-200 text-slate-600'
  };
  const shown = signalsExpanded ? signals : signals.slice(0, 6);
  box.innerHTML = shown.map(s => `<div class="px-3 py-2 rounded-xl border text-xs ${tone[s.level] || tone.info}">${escapeHtml(s.text)}</div>`).join('')
    + (signals.length > 6 ? `<button type="button" data-toggle-signals class="text-xs font-bold text-indigo-600 hover:underline">${signalsExpanded ? 'Свернуть' : `Показать все (${signals.length})`}</button>` : '');
}

function renderRatingThemes(themes) {
  const box = document.getElementById('ratingThemes');
  if (!themes.length) {
    box.innerHTML = '<p class="text-xs text-slate-400">Комментариев пока нет</p>';
    return;
  }
  box.innerHTML = themes.map(t => `<div class="flex items-start gap-3 p-2.5 rounded-xl border border-slate-200">
    <span class="shrink-0 min-w-[28px] text-center px-1.5 py-0.5 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-extrabold">${t.count}</span>
    <div class="min-w-0"><div class="text-xs font-bold text-slate-800">${escapeHtml(t.title)}</div>
      <div class="text-[11px] text-slate-400 truncate" title="${escapeHtml(t.programs.join('; '))}">${escapeHtml(t.programs.join('; '))}</div>
      ${t.examples[0] ? `<div class="text-[11px] text-slate-500 mt-0.5">«${escapeHtml(t.examples[0].text)}»</div>` : ''}</div></div>`).join('');
}

function linkOptionsFor(f) {
  const opts = [];
  if (f.linkType === 'ambiguous') {
    f.candidates.forEach(c => opts.push({ id: c.groupId, label: `${c.program} (${periodText(c.start, c.end)})` }));
  } else if (scheduleData && scheduleData.loaded && f.title) {
    const needle = f.title.toLowerCase().replace(/ё/g, 'е').slice(0, 12);
    scheduleData.programs.forEach(p => {
      if (!p.name.toLowerCase().replace(/ё/g, 'е').includes(needle)) return;
      p.groups.forEach(g => opts.push({ id: g.id, label: `${p.name} (${periodText(g.start, g.end)})` }));
    });
  }
  return opts;
}

function renderFeedbackFiles(info) {
  const summary = document.getElementById('ratingFilesSummary');
  const box = document.getElementById('ratingFiles');
  const problems = info.files.filter(f => f.status !== 'ok' || f.linkType === 'none' || f.linkType === 'ambiguous').length;
  summary.innerHTML = `Файлы анкет (${info.files.length})${problems ? ` · <span class="text-amber-700">требуют внимания: ${problems}</span>` : ''}`;

  const linkText = { auto: 'привязана автоматически', manual: 'привязана вручную', ambiguous: 'нужна привязка к группе', none: 'не найдена в план-графике' };
  const rows = info.files.map(f => {
    let state;
    if (f.status === 'error') state = `<span class="text-rose-700 font-bold">не принят: ${escapeHtml(f.error || '')}</span>`;
    else if (f.status === 'duplicate') state = `<span class="text-slate-500">дубль, учтён файл «${escapeHtml(f.duplicateOf || '')}»</span>`;
    else state = `<span class="${f.linkType === 'none' || f.linkType === 'ambiguous' ? 'text-amber-700 font-bold' : 'text-emerald-700 font-semibold'}">${linkText[f.linkType] || ''}</span>`;
    let control = '';
    if (can('programsEdit') && f.status !== 'error') {
      const opts = linkOptionsFor(f);
      if (opts.length || f.linkType === 'manual') {
        control = `<select data-link-hash="${escapeHtml(f.hash)}" class="px-2 py-1 border border-slate-200 rounded-lg text-[11px] bg-white max-w-[260px]" aria-label="Привязать анкету к группе">
          <option value="">${f.linkType === 'manual' ? '— снять ручную привязку —' : '— привязать к группе —'}</option>
          ${opts.map(o => `<option value="${escapeHtml(o.id)}" ${o.id === f.groupId ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
      }
    }
    return `<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs px-3 py-2 rounded-xl border border-slate-200">
      <span class="font-semibold text-slate-800">${escapeHtml(f.fileName)}</span>
      ${f.title ? `<span class="text-slate-400">${escapeHtml(f.title)}${f.start ? ' · ' + periodText(f.start, f.end) : ''}</span>` : ''}
      ${state}${control}</div>`;
  }).join('');

  box.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 pt-1">
      <span>Папка: <span class="font-mono text-slate-700">${escapeHtml(info.dir || '')}</span></span>
      ${can('programsEdit') ? '<button type="button" data-change-feedback-dir class="font-bold text-indigo-600 hover:underline">Изменить папку</button>' : ''}</div>`
    + (rows || '<p class="text-xs text-slate-400 py-2">В папке нет файлов .xlsx</p>');
}

async function scanFeedback() {
  if (!requireAdmin()) return;
  try {
    const r = await pPost('/api/feedback/scan');
    pToast(`Папка прочитана: файлов ${r.files}, новых ${r.added}, ошибок ${r.errors}`, r.errors > 0);
    await Promise.all([loadRatings(), loadSchedule()]);
  } catch (e) {
    pToast(e.message, true);
  }
}

async function uploadFeedback(file) {
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await pFetch('/api/feedback/upload', { method: 'POST', body: fd });
    pToast(`Анкета принята: ${r.fileName}`);
    await Promise.all([loadRatings(), loadSchedule()]);
  } catch (e) {
    pToast(e.message, true);
  }
}

async function changeFeedbackDir() {
  const current = (feedbackFilesInfo && feedbackFilesInfo.dir) || '';
  const next = window.prompt('Путь к папке с анкетами на сервере (пусто — папка по умолчанию):', current);
  if (next === null) return;
  try {
    await pPost('/api/feedback/settings', { dir: next });
    pToast('Папка с анкетами изменена');
    await Promise.all([loadRatings(), loadSchedule()]);
  } catch (e) {
    pToast(e.message, true);
  }
}

async function linkFeedback(hash, groupId) {
  try {
    await pPost('/api/feedback/link', { hash, groupId: groupId || null });
    pToast(groupId ? 'Анкета привязана к группе' : 'Привязка снята');
    await Promise.all([loadRatings(), loadSchedule()]);
  } catch (e) {
    pToast(e.message, true);
  }
}

// ---------- события ----------

function rerenderPrograms() {
  if (typeof rerenderCurators === 'function') rerenderCurators();
  if (scheduleData) renderSchedule();
  if (ratingsData) renderRatings();
  const modal = document.getElementById('modalProgram');
  if (modal && !modal.classList.contains('hidden') && openedProgram) openProgramModal(openedProgram.pid, openedProgram.ratingKey);
}

function setupProgramsListeners() {
  ['schedSearch', 'schedType', 'schedMode', 'schedStatus', 'schedMonth'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', renderScheduleGantt);
  });

  const upSched = document.getElementById('scheduleFileInput');
  document.getElementById('btnUploadSchedule').onclick = () => { if (requireAdmin()) upSched.click(); };
  upSched.onchange = () => { if (upSched.files[0]) uploadSchedule(upSched.files[0]); upSched.value = ''; };

  const upFb = document.getElementById('feedbackFileInput');
  document.getElementById('btnUploadFeedback').onclick = () => { if (requireAdmin()) upFb.click(); };
  upFb.onchange = () => { if (upFb.files[0]) uploadFeedback(upFb.files[0]); upFb.value = ''; };
  document.getElementById('btnScanFeedback').onclick = scanFeedback;

  document.querySelectorAll('.rating-tab').forEach(btn => {
    btn.onclick = () => { ratingTypeFilter = btn.getAttribute('data-rtype'); renderRatings(); };
  });

  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-program]');
    if (open) {
      openProgramModal(open.getAttribute('data-open-program') || null, open.getAttribute('data-rating-key') || null);
      return;
    }
    const chipMode = e.target.closest('[data-chip-mode]');
    if (chipMode) {
      const sel = document.getElementById('schedMode');
      const next = chipMode.getAttribute('data-chip-mode');
      sel.value = sel.value === next ? 'all' : next;
      renderScheduleGantt();
      return;
    }
    const chip = e.target.closest('[data-chip-status]');
    if (chip) {
      const sel = document.getElementById('schedStatus');
      const next = chip.getAttribute('data-chip-status');
      sel.value = sel.value === next ? 'all' : next;
      renderScheduleGantt();
      return;
    }
    const saveProg = e.target.closest('[data-save-program]');
    if (saveProg) { saveProgramMeta(saveProg.getAttribute('data-save-program')); return; }
    const saveGroup = e.target.closest('[data-save-group]');
    if (saveGroup) { saveGroupMeta(saveGroup.getAttribute('data-save-group')); return; }
    if (e.target.closest('[data-toggle-signals]')) { signalsExpanded = !signalsExpanded; renderRatingSignals(ratingsData.signals); return; }
    if (e.target.closest('[data-change-feedback-dir]')) { changeFeedbackDir(); }
  });

  document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-link-hash]');
    if (sel) linkFeedback(sel.getAttribute('data-link-hash'), sel.value);
  });
}

document.addEventListener('DOMContentLoaded', setupProgramsListeners);

// данные грузятся после входа и только ролям с правом «programs»
document.addEventListener('app:ready', async () => {
  if (!can('programs')) return;
  await Promise.all([loadSchedule(), loadRatings()]);
  renderRatings();
});
