// Кураторы: нагрузка по очным и дистанционным программам, рейтинг кураторов.
// Раздел виден ролям с правом «curators» (администратор, руководитель): данные приходят с защищённого API /api/curators.
// Загрузка и настройка источников — только с правом «edit».
// Использует помощники programs.js (pFetch, pPost, pToast, fmtPct, statusChip, MODE_NAMES …).

let curatorsData = null;
let curatorsLoading = false;
let curatorSort = 'sat'; // 'sat' — по анкетам, 'completion' — по завершаемости
let noCuratorExpanded = false;
let curatorModalOpen = false;

const MODE_CLS = {
  inperson: { bar: 'bg-amber-400', text: 'text-amber-800', chip: 'bg-amber-50 border-amber-200' },
  distant: { bar: 'bg-teal-500', text: 'text-teal-800', chip: 'bg-teal-50 border-teal-200' }
};

function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}

async function loadCurators() {
  if (!can('curators')) return;
  curatorsLoading = true;
  renderCurators();
  try {
    curatorsData = await pFetch('/api/curators');
  } catch (e) {
    curatorsData = null;
    const body = document.getElementById('curatorsBody');
    if (body && e.status !== 401) body.innerHTML = errorBlock(e.message, 'loadCurators()');
    curatorsLoading = false;
    return;
  }
  curatorsLoading = false;
  renderCurators();
}

function rerenderCurators() {
  if (!document.getElementById('curatorsBody')) return;
  if (!can('curators')) {
    curatorsData = null;
    if (curatorModalOpen) { closeAllModals(); curatorModalOpen = false; }
    renderCurators();
    return;
  }
  if (!curatorsData && !curatorsLoading) loadCurators();
  else renderCurators();
}

function modeCell(m, key, withBorder) {
  const v = m[key];
  return `<td class="px-3 py-2.5 text-right ${withBorder ? 'border-l border-slate-100' : ''}">${v || '<span class="text-slate-300">—</span>'}</td>`;
}

function renderCurators() {
  const body = document.getElementById('curatorsBody');
  const subtitle = document.getElementById('curatorsSubtitle');
  const actions = document.getElementById('curatorsActions');
  if (!body) return;

  if (!can('curators')) {
    actions.classList.add('hidden');
    subtitle.textContent = 'Раздел недоступен для вашей роли';
    body.innerHTML = `<div class="p-8 text-center text-xs text-slate-500">
      <p class="font-bold text-slate-700 mb-1">Нагрузка и рейтинг кураторов доступны руководителю и администратору</p>
      <p>Это оценка работы сотрудников, поэтому раздел виден только отдельным ролям.</p></div>`;
    return;
  }
  actions.classList.toggle('hidden', !can('edit'));

  if (!curatorsData) {
    subtitle.textContent = 'Загрузка…';
    body.innerHTML = '<div class="p-8 text-center text-xs text-slate-400">Загрузка…</div>';
    return;
  }

  const d = curatorsData;
  const src = d.source;
  subtitle.textContent = `Формат: очно и дистанционно считаются отдельно · на ${fmtDMY(d.asOf)}`;

  // --- источник
  let sourceHtml;
  if (!src.rows) {
    sourceHtml = `<div class="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-xs text-slate-700">
      <p class="font-bold text-slate-800 mb-1">Таблица кураторов ещё не загружена</p>
      <p class="mb-2">Укажите ссылку на Google Таблицу (доступ «Все, у кого есть ссылка — читатель») или загрузите её файлом .xlsx.</p>
      ${can('edit') ? '<button type="button" data-curators-url class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold">Указать ссылку</button>' : ''}
      ${src.error ? `<p class="mt-2 text-rose-700 font-semibold">${escapeHtml(src.error)}</p>` : ''}</div>`;
  } else {
    sourceHtml = `<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
      <span>Таблица кураторов: <strong class="text-slate-700">${escapeHtml(src.sourceName || '—')}</strong> · строк ${src.rows} · обновлена ${fmtDateTime(src.fetchedAt)}</span>
      ${can('edit') ? '<button type="button" data-curators-url class="font-bold text-indigo-600 hover:underline">Изменить ссылку</button>' : ''}
      ${src.error ? `<span class="text-rose-700 font-semibold">Не удалось обновить (${fmtDateTime(src.errorAt)}): ${escapeHtml(src.error)}. Показаны прежние данные.</span>` : ''}</div>`;
  }

  // --- нагрузка по формату
  const list = d.curators.filter(c => c.groupsTotal || c.kvcApplications || c.workload.inperson.requested || c.workload.distant.requested || (c.mass && c.mass.requested));
  const workloadSorted = [...list].sort((a, b) => b.groupsTotal - a.groupsTotal);
  const tot = { ig: 0, ia: 0, ih: 0, dg: 0, da: 0, dh: 0, dreq: 0, dcomp: 0, kvc: 0, mass: 0 };
  const rows = workloadSorted.map(c => {
    const i = c.byMode.inperson;
    const dd = c.byMode.distant;
    tot.ig += i.groups; tot.ia += i.applications; tot.ih += i.hours;
    tot.dg += dd.groups; tot.da += dd.applications; tot.dh += dd.hours;
    tot.dreq += c.completionRequested || 0; tot.dcomp += c.completionRequested ? c.completionCompleted : 0;
    tot.kvc += c.kvcApplications || 0; tot.mass += (c.mass && c.mass.requested) || 0;
    const sum = i.groups + dd.groups;
    const shareIn = sum ? Math.round(i.groups / sum * 100) : 0;
    const hoursNote = (m) => (m.withoutHours ? `<span class="text-slate-400" title="У ${m.withoutHours} групп нет часов в план-графике">*</span>` : '');
    return `<tr class="hover:bg-indigo-50/40 cursor-pointer" data-open-curator="${escapeHtml(c.key)}">
      <td class="px-3 py-2.5 font-bold text-slate-800 whitespace-nowrap">${escapeHtml(c.name)}</td>
      ${modeCell(i, 'groups', true)}${modeCell(i, 'applications', false)}<td class="px-3 py-2.5 text-right">${i.hours ? i.hours + hoursNote(i) : '<span class="text-slate-300">—</span>'}</td>
      ${modeCell(dd, 'groups', true)}${modeCell(dd, 'applications', false)}<td class="px-3 py-2.5 text-right">${dd.hours ? dd.hours + hoursNote(dd) : '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2.5 text-right border-l border-slate-100" title="Заявлено по закончившимся дистанционным группам (еженедельные статусы)">${c.completionRequested || '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2.5 text-right font-semibold" title="Завершили обучение">${c.completionRequested ? c.completionCompleted : '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2.5 text-right">${c.completionRate !== null ? `<span class="font-extrabold ${satTone(c.completionRate).text}" title="${c.completionGroups} групп${c.completionEnough ? '' : '; данных мало (заявлено меньше ' + d.constants.MIN_REQUESTED_FOR_COMPLETION + ')'}">${fmtPct(c.completionRate)}</span>` : '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2.5 border-l border-slate-100"><div class="flex h-2 w-28 rounded-full overflow-hidden bg-slate-100" title="Очные ${i.groups} · дистанционные ${dd.groups} групп">
        <div class="${MODE_CLS.inperson.bar}" style="width:${shareIn}%"></div><div class="${MODE_CLS.distant.bar}" style="width:${sum ? 100 - shareIn : 0}%"></div></div>
        <div class="text-[10px] text-slate-400 mt-0.5">${sum ? shareIn + '% очных' : '—'}</div></td>
      <td class="px-3 py-2.5 text-right border-l border-slate-100">${c.kvcApplications || '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2.5 text-right">${c.mass && c.mass.requested ? c.mass.requested.toLocaleString('ru-RU') : '<span class="text-slate-300">—</span>'}</td>
    </tr>`;
  }).join('');

  const workloadHtml = `<div>
    <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400 mb-2.5">Нагрузка: очные и дистанционные программы</h4>
    <div class="overflow-x-auto rounded-2xl border border-slate-200">
      <table class="w-full text-left text-xs text-slate-700">
        <thead class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-100">
          <tr>
            <th class="px-3 pt-2.5 pb-1" rowspan="2">Куратор</th>
            <th class="px-3 pt-2.5 pb-1 text-center border-l border-slate-100 ${MODE_CLS.inperson.text}" colspan="3">Очные</th>
            <th class="px-3 pt-2.5 pb-1 text-center border-l border-slate-100 ${MODE_CLS.distant.text}" colspan="6">Дистанционные</th>
            <th class="px-3 pt-2.5 pb-1 border-l border-slate-100" rowspan="2">Доля очных</th>
            <th class="px-3 pt-2.5 pb-1 text-right border-l border-slate-100" rowspan="2" title="Открытые курсы КВЦ: заявок нарастающим итогом по последнему статусу">КВЦ, заявок</th>
            <th class="px-3 pt-2.5 pb-1 text-right" rowspan="2" title="Потоки от 1000 человек (например, обучение всех сотрудников МФЦ за квартал) не входят в группы и заявки">Массовые, чел.</th>
          </tr>
          <tr>
            <th class="px-3 pb-2 text-right border-l border-slate-100">Групп</th><th class="px-3 pb-2 text-right">Заявок</th><th class="px-3 pb-2 text-right">Ак. ч</th>
            <th class="px-3 pb-2 text-right border-l border-slate-100">Групп</th><th class="px-3 pb-2 text-right">Заявок</th><th class="px-3 pb-2 text-right">Ак. ч</th>
            <th class="px-3 pb-2 text-right border-l border-slate-100" title="По закончившимся группам из статусов">Заявлено</th><th class="px-3 pb-2 text-right">Завершили</th><th class="px-3 pb-2 text-right">%</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">${rows || '<tr><td colspan="13" class="px-4 py-6 text-center text-slate-400">Нет данных</td></tr>'}</tbody>
        <tfoot class="bg-slate-50 font-extrabold text-slate-800 border-t border-slate-200"><tr>
          <td class="px-3 py-2.5">Всего</td>
          <td class="px-3 py-2.5 text-right border-l border-slate-100">${tot.ig}</td><td class="px-3 py-2.5 text-right">${tot.ia}</td><td class="px-3 py-2.5 text-right">${tot.ih}</td>
          <td class="px-3 py-2.5 text-right border-l border-slate-100">${tot.dg}</td><td class="px-3 py-2.5 text-right">${tot.da}</td><td class="px-3 py-2.5 text-right">${tot.dh}</td>
          <td class="px-3 py-2.5 text-right border-l border-slate-100">${tot.dreq || '—'}</td><td class="px-3 py-2.5 text-right">${tot.dreq ? tot.dcomp : '—'}</td><td class="px-3 py-2.5 text-right">${tot.dreq ? fmtPct(Math.round(tot.dcomp / tot.dreq * 1000) / 10) : '—'}</td>
          <td class="border-l border-slate-100"></td><td class="px-3 py-2.5 text-right border-l border-slate-100">${tot.kvc}</td><td class="px-3 py-2.5 text-right">${tot.mass ? tot.mass.toLocaleString('ru-RU') : '—'}</td>
        </tr></tfoot>
      </table>
    </div>
    <p class="text-[11px] text-slate-400 mt-2">Группы — по таблице кураторов без отменённых; если у группы несколько кураторов, она считается каждому. Заявки — из той же таблицы (только числовые значения). Ак. ч — часы программы по план-графику × число групп (* — у части групп часы неизвестны). Заявлено / Завершили / % — по закончившимся дистанционным группам из еженедельных статусов (по последнему отчёту о каждой группе; группы без внесённого результата не входят). Формат: площадка «lms», разделы «Дистанционные», «электронные курсы» и непрерывные диапазоны дат — дистанционно; семинары, тренинги, программы с установочной/итоговой сессией и очные площадки — очно.</p>
  </div>`;

  // --- рейтинг
  const C = d.constants;
  const eligible = curatorSort === 'sat' ? list.filter(c => c.enough) : list.filter(c => c.completionEnough);
  const rest = list.filter(c => !eligible.includes(c));
  eligible.sort((a, b) => curatorSort === 'sat' ? b.satisfaction - a.satisfaction : b.completionRate - a.completionRate);
  rest.sort((a, b) => b.groupsTotal - a.groupsTotal);
  const ratingRows = [...eligible, ...rest].map(c => {
    const place = curatorSort === 'sat' ? c.rank : c.rankCompletion;
    const sat = c.satisfaction !== null
      ? `<span class="font-extrabold ${satTone(c.satisfaction).text}">${fmtPct(c.satisfaction)}</span>` : '<span class="text-slate-300">—</span>';
    const cov = c.coverage !== null ? ` <span class="text-slate-400">· ${Math.round(c.coverage * 100)}%</span>` : '';
    const comp = c.completionRate !== null
      ? `<span class="font-extrabold ${satTone(c.completionRate).text}">${fmtPct(c.completionRate)}</span>` : '<span class="text-slate-300">—</span>';
    const note = [];
    if (c.forms && !c.enough) note.push(`анкет мало (меньше ${C.MIN_FORMS_FOR_RATING})`);
    if (!c.forms) note.push('нет анкет');
    if (c.completionRequested && !c.completionEnough) note.push(`завершаемость: мало данных (заявлено меньше ${C.MIN_REQUESTED_FOR_COMPLETION})`);
    if (!c.completionRequested) note.push('нет завершённых дистанционных групп в статусах');
    const muted = place ? '' : 'text-slate-400';
    return `<tr class="${muted} hover:bg-indigo-50/40 cursor-pointer" data-open-curator="${escapeHtml(c.key)}">
      <td class="px-3 py-2.5 font-extrabold ${place === 1 ? 'text-amber-500' : ''}">${place || '—'}</td>
      <td class="px-3 py-2.5 font-bold ${place ? 'text-slate-800' : ''} whitespace-nowrap">${escapeHtml(c.name)}</td>
      <td class="px-3 py-2.5 text-right border-l border-slate-100">${c.ratedGroups || '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2.5 text-right whitespace-nowrap">${c.forms ? c.forms + (c.listeners ? ' / ' + c.listeners : '') + cov : '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2.5 text-right">${sat}</td>
      <td class="px-3 py-2.5 text-right border-l border-slate-100">${c.completionGroups || '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2.5 text-right" title="${c.completionRequested ? 'Завершили ' + c.completionCompleted + ' из ' + c.completionRequested : ''}">${comp}</td>
      <td class="px-3 py-2.5 text-[11px] text-slate-500">${escapeHtml(note.join('; '))}</td>
    </tr>`;
  }).join('');

  const sortBtn = (id, label) => `<button type="button" data-curators-sort="${id}" class="px-3 py-1.5 rounded-xl border text-xs font-semibold ${curatorSort === id ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}">${label}</button>`;
  const ratingHtml = `<div>
    <div class="flex flex-wrap items-center justify-between gap-3 mb-2.5">
      <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400">Рейтинг кураторов</h4>
      <div class="flex gap-1.5">${sortBtn('sat', 'По анкетам (удовлетворённость)')}${sortBtn('completion', 'По завершаемости (дистант)')}</div>
    </div>
    <div class="overflow-x-auto rounded-2xl border border-slate-200">
      <table class="w-full text-left text-xs text-slate-700">
        <thead class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-100">
          <tr><th class="px-3 py-2.5">Место</th><th class="px-3 py-2.5">Куратор</th>
            <th class="px-3 py-2.5 text-right border-l border-slate-100">Групп с анкетой</th><th class="px-3 py-2.5 text-right">Анкет / слушателей</th><th class="px-3 py-2.5 text-right">Удовлетворённость</th>
            <th class="px-3 py-2.5 text-right border-l border-slate-100">Групп (дистант)</th><th class="px-3 py-2.5 text-right" title="Завершили ÷ заявлено; числа — в таблице нагрузки выше">Завершаемость</th>
            <th class="px-3 py-2.5">Примечание</th></tr>
        </thead>
        <tbody class="divide-y divide-slate-100">${ratingRows || '<tr><td colspan="8" class="px-4 py-6 text-center text-slate-400">Нет данных</td></tr>'}</tbody>
      </table>
    </div>
    <p class="text-[11px] text-slate-400 mt-2">Удовлетворённость — по анкетам групп куратора (место при ≥ ${C.MIN_FORMS_FOR_RATING} анкетах). Завершаемость = завершили ÷ заявлено по закончившимся дистанционным группам из еженедельных статусов (числа «Заявлено» и «Завершили» — в таблице нагрузки выше, при наведении на % — тоже) (место при заявлено ≥ ${C.MIN_REQUESTED_FOR_COMPLETION}); учитывается последний статус по каждой группе. Очные группы в завершаемости не участвуют: в очных статусах нет поля «завершили». Места нужно читать вместе с нагрузкой выше.</p>
  </div>`;

  // --- замечания по данным
  const notes = [];
  d.conflicts.forEach(c => notes.push({ level: 'warn', text: `Куратор расходится: «${c.title}», ${periodText(c.start, c.end)} — в таблице «${c.table}», в анкете «${c.file}». В рейтинге используется таблица.` }));
  d.unmatchedFeedback.forEach(f => notes.push({ level: 'info', text: `Анкета «${f.fileName}» не привязана к куратору: в таблице нет строки «${f.title}» на ${periodText(f.start, f.end)}.` }));
  if (d.aliases.length) notes.push({ level: 'info', text: `Объединены похожие фамилии: ${d.aliases.map(a => `${a.from} → ${a.to}`).join(', ')}.` });
  if (src.warnings.length) notes.push({ level: 'info', text: `В таблице не разобрано строк: ${src.warnings.length} (например: ${src.warnings.slice(0, 2).join('; ')}).` });
  const tone = { warn: 'bg-amber-50 border-amber-200 text-amber-800', info: 'bg-slate-50 border-slate-200 text-slate-600' };
  let notesHtml = notes.map(n => `<div class="px-3 py-2 rounded-xl border text-xs ${tone[n.level]}">${escapeHtml(n.text)}</div>`).join('');
  if (d.noCurator.count) {
    const items = noCuratorExpanded
      ? `<ul class="mt-1.5 space-y-0.5">${d.noCurator.items.map(i => `<li>${escapeHtml(i.sheet)}: ${escapeHtml(i.name)} (${periodText(i.start, i.end)})</li>`).join('')}</ul>` : '';
    notesHtml += `<div class="px-3 py-2 rounded-xl border text-xs ${tone.warn}">В таблице у ${d.noCurator.count} групп не указан куратор — они не попадают в нагрузку.
      <button type="button" data-toggle-nocurator class="font-bold underline">${noCuratorExpanded ? 'Скрыть' : 'Показать'}</button>${items}</div>`;
  }
  const notesBlock = notesHtml ? `<div><h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400 mb-2.5">Что проверить в данных</h4><div class="space-y-1.5">${notesHtml}</div></div>` : '';

  // --- статусы
  const st = d.statuses;
  const files = st.files.map(f => `<li class="flex flex-wrap gap-x-3 ${f.status === 'error' ? 'text-rose-700' : ''}">
      <span class="font-semibold text-slate-700">${f.date ? fmtDMY(f.date) : '—'}</span><span>${escapeHtml(f.fileName)}</span>
      <span class="text-slate-400">${f.status === 'error' ? 'не принят: ' + escapeHtml(f.error || '') : (f.rows ? 'строк ' + f.rows : 'пустой бланк')}${f.dateSource === 'mtime' ? ' · дата по изменению файла' : ''}</span></li>`).join('');
  const kvc = st.kvcTimeline.map(k => `${fmtDM(k.date)} — ${k.total ?? k.sum}`).join(' · ');
  const statusesHtml = `<details class="rounded-2xl border border-slate-200">
    <summary class="px-4 py-3 text-xs font-bold text-slate-700 cursor-pointer select-none">Еженедельные статусы по программам (${st.files.length}) · папка прочитана ${fmtDateTime(st.lastScanAt)}</summary>
    <div class="px-4 pb-4 space-y-2 text-xs text-slate-500">
      <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] pt-1"><span>Папка: <span class="font-mono text-slate-700">${escapeHtml(st.dir)}</span></span>${can('edit') ? '<button type="button" data-status-dir class="font-bold text-indigo-600 hover:underline">Изменить папку</button>' : ''}</div>
      <ul class="space-y-1">${files || '<li class="text-slate-400">В папке нет файлов .xlsx</li>'}</ul>
      ${kvc ? `<p class="pt-1"><span class="font-bold text-slate-600">Заявки КВЦ по неделям:</span> ${kvc}</p>` : ''}
    </div></details>`;

  body.innerHTML = sourceHtml + workloadHtml + ratingHtml + notesBlock + statusesHtml;
}

// ---------- карточка куратора ----------

function openCuratorModal(key) {
  const c = curatorsData && curatorsData.curators.find(x => x.key === key);
  if (!c) return;
  openedProgram = null;
  curatorModalOpen = true;

  const head = document.getElementById('programModalHead');
  const body = document.getElementById('programModalBody');
  const i = c.byMode.inperson;
  const dd = c.byMode.distant;
  head.innerHTML = `<h3 class="text-base lg:text-lg font-extrabold text-slate-900">${escapeHtml(c.name)}</h3>
    <div class="mt-1 text-xs text-slate-500">Куратор · групп без отменённых: ${c.groupsTotal}${c.cancelled ? `, отменено ${c.cancelled}` : ''}</div>`;

  const modeCard = (m, label, cls) => `<div class="rounded-2xl border ${cls.chip} p-3.5">
      <div class="text-[10px] font-bold uppercase tracking-wider ${cls.text}">${label}</div>
      <div class="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
        <span><strong class="text-lg text-slate-900">${m.groups}</strong> групп</span>
        <span><strong class="text-lg text-slate-900">${m.hours}</strong> ак. ч</span>
        <span><strong class="text-lg text-slate-900">${m.applications}</strong> заявок</span></div>
      <div class="mt-1 text-[11px] text-slate-500">проведено ${m.finished} · идут ${m.running} · впереди ${m.planned}</div></div>`;

  const groupRows = c.groups.map(g => {
    const fb = g.feedback ? `<span class="font-bold ${satTone(g.feedback.satisfaction).text}">${fmtPct(g.feedback.satisfaction)}</span> <span class="text-slate-400">(${g.feedback.forms}${g.feedback.listeners ? '/' + g.feedback.listeners : ''})</span>` : '<span class="text-slate-300">—</span>';
    const note = [g.note, g.substitute ? `замена: ${g.substitute}` : ''].filter(Boolean).join('; ');
    return `<tr class="${g.status === 'cancelled' ? 'text-slate-400' : ''}">
      <td class="px-3 py-2 whitespace-nowrap">${MODE_NAMES[g.mode] || '—'}</td>
      <td class="px-3 py-2 max-w-[300px]">${escapeHtml(g.name)}${g.kindRaw ? ` <span class="text-slate-400">· ${escapeHtml(g.kindRaw)}</span>` : ''}</td>
      <td class="px-3 py-2 whitespace-nowrap font-semibold">${periodText(g.start, g.end)}</td>
      <td class="px-3 py-2">${statusChip(g.status)}</td>
      <td class="px-3 py-2 text-right">${g.applications ?? '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2 text-right">${g.hours ?? '<span class="text-slate-300">—</span>'}</td>
      <td class="px-3 py-2 whitespace-nowrap">${fb}</td>
      <td class="px-3 py-2 text-[11px] text-slate-500 max-w-[220px]">${escapeHtml(note)}</td></tr>`;
  }).join('');

  const statusRows = c.statusRows.map(r => `<tr>
      <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(r.section)}${r.mass ? ' <span class="text-[10px] font-bold text-slate-500 bg-slate-100 rounded px-1">массовый</span>' : ''}</td>
      <td class="px-3 py-2 max-w-[260px]">${escapeHtml(r.name)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(r.dates || '')}</td>
      <td class="px-3 py-2 text-right">${r.requested ?? '—'}</td>
      <td class="px-3 py-2 text-right">${r.completed ?? '—'}</td>
      <td class="px-3 py-2 text-[11px] text-slate-600 max-w-[320px]">${escapeHtml(r.action || '')}</td>
      <td class="px-3 py-2 text-[11px] text-slate-400 whitespace-nowrap">${fmtDM(r.date)}</td></tr>`).join('');

  const kvc = c.kvcPrograms.length
    ? `<div><h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400 mb-2">КВЦ: открытые курсы (${c.kvcApplications} заявок)</h4>
        <ul class="text-xs text-slate-600 space-y-1">${c.kvcPrograms.map(k => `<li class="flex justify-between gap-3"><span>${escapeHtml(k.name)}</span><strong>${k.applications}</strong></li>`).join('')}</ul></div>` : '';

  body.innerHTML = `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      ${modeCard(i, 'Очные программы', MODE_CLS.inperson)}${modeCard(dd, 'Дистанционные программы', MODE_CLS.distant)}</div>
    <div><h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400 mb-2">Группы по таблице кураторов</h4>
      <div class="overflow-x-auto rounded-2xl border border-slate-200"><table class="w-full text-left text-xs text-slate-700">
        <thead class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-100"><tr><th class="px-3 py-2.5">Формат</th><th class="px-3 py-2.5">Программа</th><th class="px-3 py-2.5">Даты</th><th class="px-3 py-2.5">Статус</th><th class="px-3 py-2.5 text-right">Заявок</th><th class="px-3 py-2.5 text-right">Ак. ч</th><th class="px-3 py-2.5">Анкета</th><th class="px-3 py-2.5">Примечание</th></tr></thead>
        <tbody class="divide-y divide-slate-100">${groupRows || '<tr><td colspan="8" class="px-4 py-5 text-center text-slate-400">Групп в таблице нет</td></tr>'}</tbody></table></div></div>
    ${statusRows ? `<div><h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400 mb-2">Статусы по программам (последний отчёт по каждой группе)</h4>
      <div class="overflow-x-auto rounded-2xl border border-slate-200"><table class="w-full text-left text-xs text-slate-700">
        <thead class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-100"><tr><th class="px-3 py-2.5">Раздел</th><th class="px-3 py-2.5">Программа</th><th class="px-3 py-2.5">Даты</th><th class="px-3 py-2.5 text-right">Заявлено</th><th class="px-3 py-2.5 text-right">Завершили</th><th class="px-3 py-2.5">Что предпринял куратор</th><th class="px-3 py-2.5">Отчёт</th></tr></thead>
        <tbody class="divide-y divide-slate-100">${statusRows}</tbody></table></div></div>` : ''}
    ${kvc}`;
  openModal('modalProgram');
}

// ---------- действия ----------

async function refreshCurators() {
  if (!requireAdmin()) return;
  try {
    const r = await pPost('/api/curators/refresh');
    pToast(`Таблица кураторов обновлена: строк ${r.rows}`);
    await Promise.all([loadCurators(), loadSchedule(), loadRatings()]);
  } catch (e) {
    pToast(e.message, true);
    loadCurators();
  }
}

async function uploadCuratorsFile(file) {
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await pFetch('/api/curators/upload', { method: 'POST', body: fd });
    pToast(`Таблица кураторов принята: строк ${r.rows}`);
    await Promise.all([loadCurators(), loadSchedule(), loadRatings()]);
  } catch (e) {
    pToast(e.message, true);
  }
}

async function uploadStatusFile(file) {
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await pFetch('/api/statuses/upload', { method: 'POST', body: fd });
    pToast(`Статусы приняты: ${r.fileName}`);
    await Promise.all([loadCurators(), loadSchedule()]);
  } catch (e) {
    pToast(e.message, true);
  }
}

async function changeCuratorsUrl() {
  const current = (curatorsData && curatorsData.source.url) || '';
  const next = window.prompt('Ссылка на Google Таблицу с кураторами (доступ «Все, у кого есть ссылка — читатель»):', current);
  if (next === null) return;
  try {
    const r = await pPost('/api/curators/settings', { url: next });
    pToast(r.rows ? `Ссылка сохранена, строк ${r.rows}` : 'Ссылка очищена');
    await Promise.all([loadCurators(), loadSchedule(), loadRatings()]);
  } catch (e) {
    pToast(e.message, true);
    loadCurators();
  }
}

async function changeStatusDir() {
  const current = (curatorsData && curatorsData.statuses.dir) || '';
  const next = window.prompt('Путь к папке со статусами на сервере (пусто — папка по умолчанию):', current);
  if (next === null) return;
  try {
    await pPost('/api/statuses/settings', { dir: next });
    pToast('Папка со статусами изменена');
    await Promise.all([loadCurators(), loadSchedule()]);
  } catch (e) {
    pToast(e.message, true);
  }
}

function setupCuratorsListeners() {
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  const curFile = document.getElementById('curatorsFileInput');
  const stFile = document.getElementById('statusFileInput');
  bind('btnRefreshCurators', refreshCurators);
  bind('btnUploadCurators', () => { if (requireAdmin()) curFile.click(); });
  bind('btnUploadStatus', () => { if (requireAdmin()) stFile.click(); });
  curFile.onchange = () => { if (curFile.files[0]) uploadCuratorsFile(curFile.files[0]); curFile.value = ''; };
  stFile.onchange = () => { if (stFile.files[0]) uploadStatusFile(stFile.files[0]); stFile.value = ''; };

  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-curator]');
    if (open) { openCuratorModal(open.getAttribute('data-open-curator')); return; }
    const sort = e.target.closest('[data-curators-sort]');
    if (sort) { curatorSort = sort.getAttribute('data-curators-sort'); renderCurators(); return; }
    if (e.target.closest('[data-toggle-nocurator]')) { noCuratorExpanded = !noCuratorExpanded; renderCurators(); return; }
    if (e.target.closest('[data-curators-url]')) { changeCuratorsUrl(); return; }
    if (e.target.closest('[data-status-dir]')) { changeStatusDir(); return; }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupCuratorsListeners();
  renderCurators();
});
