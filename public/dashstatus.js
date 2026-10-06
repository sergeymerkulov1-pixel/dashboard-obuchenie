// Кнопка «Статус»: состояние всего дашборда на текущий момент.
// Использует глобальные функции app.js: escapeHtml, openModal, formatNumber, isAdminLoggedIn.

const DS_TONE = {
  on_track: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', bar: 'bg-emerald-500', label: 'в графике' },
  warning: { chip: 'bg-amber-50 text-amber-700 border-amber-200', bar: 'bg-amber-500', label: 'отставание' },
  critical: { chip: 'bg-rose-50 text-rose-700 border-rose-200', bar: 'bg-rose-500', label: 'критично' },
  none: { chip: 'bg-slate-50 text-slate-500 border-slate-200', bar: 'bg-slate-300', label: 'нет плана' }
};

function dsTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК';
}

function dsAge(iso) {
  if (!iso) return null;
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
}

function dsCard(c) {
  const t = DS_TONE[c.status] || DS_TONE.none;
  const pct = c.percent === null || c.percent === undefined ? null : Math.min(100, c.percent);
  const exp = c.expectedPercent;
  const lag = c.lagPercent === null || c.lagPercent === undefined ? '' : (c.lagPercent > 0 ? `−${c.lagPercent} п.п. к норме` : 'не ниже нормы');
  return `<div class="rounded-2xl border border-slate-200 p-3.5">
    <div class="flex items-start justify-between gap-2">
      <div class="text-xs font-bold text-slate-700">${escapeHtml(c.title)}</div>
      <span class="px-2 py-0.5 rounded-full border text-[10px] font-bold whitespace-nowrap ${t.chip}">${t.label}</span>
    </div>
    <div class="mt-1 flex items-baseline gap-1.5">
      <span class="text-xl font-black text-slate-900">${formatNumber(c.fact)}</span>
      ${c.plan ? `<span class="text-xs text-slate-400">из ${formatNumber(c.plan)}</span>` : '<span class="text-xs text-slate-400">план не задан</span>'}
      ${pct !== null ? `<span class="ml-auto text-xs font-extrabold text-slate-700">${c.percent}%</span>` : ''}
    </div>
    ${pct !== null ? `<div class="relative mt-2 h-1.5 rounded-full bg-slate-100">
      <div class="h-1.5 rounded-full ${t.bar}" style="width:${pct}%"></div>
      ${exp ? `<div class="absolute -top-0.5 h-2.5 w-0.5 bg-slate-800" style="left:${Math.min(100, exp)}%" title="Норма к дате ${exp}%"></div>` : ''}
    </div>` : ''}
    <div class="mt-2 text-[11px] text-slate-500 flex flex-wrap gap-x-3">
      ${lag ? `<span>${lag}</span>` : ''}
      ${c.delta !== null && c.delta !== undefined ? `<span>${c.delta >= 0 ? '+' : ''}${formatNumber(c.delta)} за ${c.deltaDays} дн.</span>` : ''}
      ${c.forecastPercent !== null && c.forecastPercent !== undefined ? `<span>прогноз 31.12: ${c.forecastPercent}%</span>` : ''}
      ${c.isOutdated ? '<span class="font-bold text-amber-700">данные устарели</span>' : ''}
    </div>
  </div>`;
}

function dsSource(s) {
  const failed = s.step && !s.step.ok;
  const skipped = s.step && s.step.skipped;
  const tone = failed || s.errors ? 'bg-rose-500' : (skipped || !s.scannedAt ? 'bg-slate-300' : 'bg-emerald-500');
  const note = failed ? `ошибка: ${s.step.error}` : (skipped ? s.step.text : (s.step && s.step.text) || '');
  return `<tr class="border-b border-slate-100">
    <td class="py-2 pr-3"><span class="inline-block w-2 h-2 rounded-full ${tone} mr-2"></span><span class="font-semibold text-slate-700">${escapeHtml(s.title)}</span></td>
    <td class="py-2 pr-3 text-slate-600">${s.lastDataDate ? escapeHtml(s.lastDataDate.split('-').reverse().join('.')) : '—'}</td>
    <td class="py-2 pr-3 text-slate-600">${dsTime(s.scannedAt)}<span class="text-slate-400"> · ${dsAge(s.scannedAt) || 'не читался'}</span></td>
    <td class="py-2 text-slate-500">${escapeHtml(note)}${s.errors && !failed ? ` · файлов с ошибками: ${s.errors}` : ''}</td>
  </tr>`;
}

async function loadDashStatus() {
  const body = document.getElementById('dashStatusBody');
  const sub = document.getElementById('dashStatusSubtitle');
  body.innerHTML = '<div class="p-8 text-center text-xs text-slate-400">Загрузка…</div>';
  try {
    const res = await fetch('/api/dashboard-status');
    if (!res.ok) throw new Error(`Ошибка ${res.status}`);
    const d = await res.json();
    sub.textContent = `На ${dsTime(d.now)} · последний срез ${d.latestSnapshot ? d.latestSnapshot.date : '—'}`;
    const attention = d.attention.length
      ? `<div class="mb-4 rounded-2xl border border-rose-200 bg-rose-50/60 p-3 text-xs text-rose-800"><strong>Требует внимания:</strong> ${d.attention.map(a => `${escapeHtml(a.title)} (−${a.lagPercent} п.п.${a.shortage ? `, не хватает ${formatNumber(a.shortage)} чел.` : ''})`).join('; ')}</div>`
      : '';
    body.innerHTML = `${attention}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${d.cards.map(dsCard).join('')}</div>
      <h4 class="mt-6 mb-2 text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Источники данных</h4>
      <div class="overflow-x-auto"><table class="w-full text-xs text-left">
        <thead><tr class="text-[10px] uppercase text-slate-400"><th class="pb-1 font-bold">Источник</th><th class="pb-1 font-bold">Свежие данные за</th><th class="pb-1 font-bold">Прочитан</th><th class="pb-1 font-bold">Результат</th></tr></thead>
        <tbody>${d.sources.map(dsSource).join('')}</tbody>
      </table></div>
      <h4 class="mt-6 mb-2 text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Расписание</h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-slate-600">
        <div class="rounded-2xl border border-slate-200 p-3"><div class="font-bold text-slate-700">Сбор данных: ${escapeHtml(d.schedule.collect)}</div>
          <div class="mt-1">Последний: ${d.lastRun ? `${dsTime(d.lastRun.finishedAt)} (${escapeHtml(d.lastRun.reason)})` : 'ещё не было'}</div>
          <div>Следующий: ${dsTime(d.nextCollectAt)}</div></div>
        <div class="rounded-2xl border border-slate-200 p-3"><div class="font-bold text-slate-700">Срез: ${escapeHtml(d.schedule.snapshot)}</div>
          <div class="mt-1">Последний срез: ${d.latestSnapshot ? d.latestSnapshot.date.split('-').reverse().join('.') : '—'}</div>
          <div>Следующий: ${dsTime(d.nextSnapshotAt)}</div></div>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="p-6 text-center text-xs text-slate-500"><p class="mb-3">${escapeHtml(e.message)}</p>
      <button type="button" onclick="loadDashStatus()" class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold">Повторить попытку</button></div>`;
  }
}

async function collectNow() {
  if (!can('edit')) { showToast('Обновление данных доступно администратору'); return; }
  const btn = document.getElementById('btnDashCollect');
  btn.disabled = true;
  btn.textContent = 'Собираю…';
  try {
    const res = await fetch('/api/collect', { method: 'POST' });
    if (!res.ok) throw new Error(`Ошибка ${res.status}`);
    showToast('Данные собраны');
    if (typeof loadSchedule === 'function') loadSchedule();
    await loadDashStatus();
  } catch (e) {
    showToast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Обновить сейчас';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const open = document.getElementById('btnDashStatus');
  if (open) open.onclick = () => { openModal('modalDashStatus'); loadDashStatus(); };
  const collect = document.getElementById('btnDashCollect');
  if (collect) collect.onclick = collectNow;
});
