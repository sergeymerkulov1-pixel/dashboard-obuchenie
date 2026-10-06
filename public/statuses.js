// Еженедельные статусы в «Графике планёрок»: даты недель рядом со срезами, панель «Статусы на дату»,
// таблица всех недель. Данные — только числа (публичный /api/status-history).
// renderTimelineChips (app.js) использует переменные и функции этого файла.

let statusWeeks = [];
let selectedStatusDate = null;
let timelineSnapshots = [];
let timelineActiveId = null;

const STATUS_MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function snapshotIso(s) {
  if (s.id && /^\d{4}-\d{2}-\d{2}$/.test(s.id)) return s.id;
  if (s.date && s.date.includes('.')) {
    const p = s.date.split('.');
    return `${p[2]}-${p[1]}-${p[0]}`;
  }
  return s.id;
}

function statusFmt(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

function statusFmtFull(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

// ближайшая неделя статусов не позже даты
function statusWeekOnOrBefore(iso) {
  let found = null;
  statusWeeks.forEach(w => { if (w.date <= iso) found = w; });
  return found;
}

async function loadStatusHistory() {
  try {
    const res = await fetch('/api/status-history');
    if (!res.ok) throw new Error('Не удалось загрузить статусы');
    const data = await res.json();
    statusWeeks = data.weeks || [];
  } catch (e) {
    statusWeeks = [];
    console.error('Статусы по неделям:', e);
  }
  if (typeof renderTimelineChips === 'function' && timelineSnapshots.length) renderTimelineChips(null, timelineActiveId);
  renderStatusPanel();
}

function selectStatusDate(iso) {
  selectedStatusDate = iso;
  if (typeof renderTimelineChips === 'function') renderTimelineChips(null, timelineActiveId);
  renderStatusPanel();
}

function renderStatusPanel() {
  const box = document.getElementById('statusWeekPanel');
  if (!box) return;
  if (!statusWeeks.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const w = statusWeeks.find(x => x.date === selectedStatusDate) || statusWeeks[statusWeeks.length - 1];
  const gz = w.gzDistant;
  const rate = gz.completedOf > 0 ? Math.round(gz.completed / gz.completedOf * 100) : null;
  const delta = w.kvcDelta !== null && w.kvcDelta !== undefined
    ? `<span class="font-bold ${w.kvcDelta >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${w.kvcDelta >= 0 ? '+' : ''}${formatNumber(w.kvcDelta)}</span> <span class="text-slate-400">за ${w.daysFromPrev} дн.</span>` : '';
  const row = (label, value, extra = '') => `<div class="flex items-baseline justify-between gap-2"><span class="text-slate-500">${label}</span><span class="text-right font-semibold text-slate-800">${value}${extra ? ' <span class="font-normal text-slate-400">' + extra + '</span>' : ''}</span></div>`;

  box.innerHTML = `
    <div class="flex items-center justify-between mb-1.5">
      <span class="text-[10px] font-bold uppercase tracking-wider text-teal-700">Статусы по программам на ${statusFmtFull(w.date)}</span>
      <button type="button" id="btnStatusWeeks" class="text-[10px] font-bold text-indigo-600 hover:underline">Все недели</button>
    </div>
    <div class="space-y-1 text-[11px]">
      ${w.kvc !== null ? row('КВЦ, заявок', formatNumber(w.kvc), delta) : ''}
      ${row('ГЗ дистант', `${gz.groups} гр. · заявлено ${formatNumber(gz.requested)}`, gz.completedOf ? `завершили ${formatNumber(gz.completed)} из ${formatNumber(gz.completedOf)}${rate !== null ? ' (' + rate + '%)' : ''} по закончившимся группам` : '')}
      ${row('ГЗ очно', w.gzInperson.groups ? `${w.gzInperson.groups} гр. · ${formatNumber(w.gzInperson.requested)} заявок` : '—')}
      ${row('МФЦ дистант', w.mfc.groups ? `${w.mfc.groups} гр. · заявлено ${formatNumber(w.mfc.requested)}` : '—')}
    </div>`;
  const btn = document.getElementById('btnStatusWeeks');
  if (btn) btn.onclick = openStatusWeeksModal;
}

function openStatusWeeksModal() {
  const body = document.getElementById('statusWeeksBody');
  if (!body) return;
  const cell = (v, cls = '') => `<td class="px-3 py-2 text-right ${cls}">${v === null || v === undefined || v === 0 ? '<span class="text-slate-300">—</span>' : formatNumber(v)}</td>`;
  const rows = [...statusWeeks].reverse().map(w => {
    const gz = w.gzDistant;
    const rate = gz.completedOf > 0 ? Math.round(gz.completed / gz.completedOf * 100) : null;
    const delta = w.kvcDelta === null || w.kvcDelta === undefined ? '<span class="text-slate-300">—</span>'
      : `<span class="font-bold ${w.kvcDelta >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${w.kvcDelta >= 0 ? '+' : ''}${formatNumber(w.kvcDelta)}</span>`;
    return `<tr class="${w.date === (selectedStatusDate || statusWeeks[statusWeeks.length - 1].date) ? 'bg-teal-50/50' : ''}">
      <td class="px-3 py-2 font-bold text-slate-800 whitespace-nowrap">${statusFmtFull(w.date)}</td>
      ${cell(w.kvc, 'border-l border-slate-100')}<td class="px-3 py-2 text-right">${delta}</td>
      ${cell(gz.groups, 'border-l border-slate-100')}${cell(gz.requested)}${cell(gz.completedOf ? gz.completed : null)}
      <td class="px-3 py-2 text-right">${rate !== null ? rate + '%' : '<span class="text-slate-300">—</span>'}</td>
      ${cell(w.gzInperson.groups, 'border-l border-slate-100')}${cell(w.gzInperson.requested)}
      ${cell(w.mfc.groups, 'border-l border-slate-100')}${cell(w.mfc.requested)}</tr>`;
  }).join('');
  body.innerHTML = `<div class="overflow-x-auto rounded-2xl border border-slate-200">
    <table class="w-full text-left text-xs text-slate-700">
      <thead class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-100">
        <tr><th class="px-3 pt-2.5 pb-1" rowspan="2">Дата</th>
          <th class="px-3 pt-2.5 pb-1 text-center border-l border-slate-100" colspan="2">КВЦ</th>
          <th class="px-3 pt-2.5 pb-1 text-center border-l border-slate-100" colspan="4">ГЗ дистант</th>
          <th class="px-3 pt-2.5 pb-1 text-center border-l border-slate-100" colspan="2">ГЗ очно</th>
          <th class="px-3 pt-2.5 pb-1 text-center border-l border-slate-100" colspan="2">МФЦ дистант</th></tr>
        <tr><th class="px-3 pb-2 text-right border-l border-slate-100">Заявок</th><th class="px-3 pb-2 text-right">Прирост</th>
          <th class="px-3 pb-2 text-right border-l border-slate-100">Групп</th><th class="px-3 pb-2 text-right">Заявлено</th><th class="px-3 pb-2 text-right">Завершили</th><th class="px-3 pb-2 text-right">%</th>
          <th class="px-3 pb-2 text-right border-l border-slate-100">Групп</th><th class="px-3 pb-2 text-right">Заявок</th>
          <th class="px-3 pb-2 text-right border-l border-slate-100">Групп</th><th class="px-3 pb-2 text-right">Заявлено</th></tr>
      </thead>
      <tbody class="divide-y divide-slate-100">${rows}</tbody>
    </table></div>
    <p class="text-[11px] text-slate-400 mt-3">КВЦ — заявки нарастающим итогом (совпадают с фактом КВЦ на дни срезов). Остальные колонки — группы, попавшие в недельный отчёт: это не накопленный итог года, а срез «в работе» на дату. «Завершили» и % считаются по тем группам, где результат уже внесён. Массовые потоки от 1000 человек не включены.</p>`;
  openModal('modalStatusWeeks');
}

document.addEventListener('app:ready', () => {
  loadStatusHistory();
});
