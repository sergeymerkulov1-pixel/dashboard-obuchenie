// Единая картина на главной странице: структура по направлениям и программам КВЦ (из презентаций планёрок)
// и сверка данных между источниками. Только числа: блоки открыты всем.

function structFmt(n) {
  return n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU');
}

function structDate(iso) {
  return iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';
}

let structureRequest = 0;

async function loadStructure(snapshotId) {
  const ticket = ++structureRequest;
  try {
    const res = await fetch(`/api/structure?id=${encodeURIComponent(snapshotId || '')}`);
    if (!res.ok) throw new Error('Не удалось загрузить структуру');
    const data = await res.json();
    if (ticket === structureRequest) renderStructure(data);
  } catch (e) {
    console.error('Структура:', e);
  }
}

function structureList(items, tone) {
  if (!items.length) return '<p class="text-xs text-slate-400 py-3">Нет данных</p>';
  const max = Math.max(...items.map(i => i.count), 1);
  return items.map(i => {
    const isMfc = /МФЦ|Контакт-центр/i.test(i.name);
    const bar = tone === 'kvc' ? 'bg-amber-500' : (isMfc ? 'bg-teal-500' : 'bg-indigo-500');
    const delta = i.delta === null ? '' : (i.delta === 0
      ? '<span class="font-normal text-slate-300">±0</span>'
      : `<span class="font-bold ${i.delta > 0 ? 'text-emerald-600' : 'text-rose-600'}">${i.delta > 0 ? '+' : ''}${structFmt(i.delta)}</span>`);
    return `<div class="py-1.5">
      <div class="flex items-baseline justify-between gap-3 text-xs">
        <span class="text-slate-700 truncate" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</span>
        <span class="shrink-0 font-extrabold text-slate-900">${structFmt(i.count)} ${delta ? `<span class="text-[11px] ml-1">${delta}</span>` : ''}</span>
      </div>
      <div class="h-1.5 rounded-full bg-slate-100 mt-1 overflow-hidden"><div class="h-full rounded-full ${bar}" style="width:${Math.max(2, Math.round(i.count / max * 100))}%"></div></div>
    </div>`;
  }).join('');
}

function renderStructure(d) {
  const dirBox = document.getElementById('structureDirections');
  const kvcBox = document.getElementById('structureKvc');
  const dirSub = document.getElementById('structureDirSub');
  const kvcSub = document.getElementById('structureKvcSub');
  const note = document.getElementById('structureDirNote');
  if (!dirBox || !kvcBox) return;

  if (!d || !d.available) {
    dirBox.innerHTML = '<p class="text-xs text-slate-400 py-3">На эту дату нет презентации планёрки: структура недоступна.</p>';
    kvcBox.innerHTML = '';
    dirSub.textContent = '';
    kvcSub.textContent = '';
    note.textContent = '';
    return;
  }

  const cmp = d.previousDate ? `, изменение к ${structDate(d.previousDate)}` : '';
  dirSub.textContent = `По презентации планёрки на ${structDate(d.date)}${cmp}`;
  kvcSub.textContent = `По презентации планёрки на ${structDate(d.date)}${cmp}`;
  dirBox.innerHTML = structureList(d.directions, 'gz');
  kvcBox.innerHTML = structureList(d.kvcPrograms, 'kvc');

  const dirSum = d.directions.reduce((a, i) => a + i.count, 0);
  const t = d.totals;
  note.innerHTML = `Сумма по направлениям <strong class="text-slate-700">${structFmt(dirSum)}</strong>, итог на слайде <strong class="text-slate-700">${structFmt(t.total)}</strong>
    (ГЗ ${structFmt(t.gz)} + МФЦ ${structFmt(t.mfc)} + ОМСУ ${structFmt(t.omsu)}). В таблицу направлений не вошло ${structFmt(t.total - dirSum)}:
    ОМСУ ${structFmt(t.omsu)} и ${structFmt(t.total - dirSum - t.omsu)} без распределения по направлениям.`;
}

// ---------- сверка данных ----------

async function loadReconcile() {
  try {
    const res = await fetch('/api/reconcile');
    if (!res.ok) throw new Error('Не удалось загрузить сверку');
    renderReconcile(await res.json());
  } catch (e) {
    const box = document.getElementById('reconcileBody');
    if (box) box.innerHTML = errorBlock(e.message, 'loadReconcile()');
  }
}

function renderReconcile(d) {
  const box = document.getElementById('reconcileBody');
  const sub = document.getElementById('reconcileSummary');
  if (!box) return;
  const c = d.counts;
  sub.innerHTML = [
    c.error ? `<span class="font-bold text-rose-700">${c.error} ошибок</span>` : '',
    c.warn ? `<span class="font-bold text-amber-700">${c.warn} расхождений</span>` : '',
    c.info ? `<span class="text-slate-600">${c.info} к сведению</span>` : '',
    `<span class="font-bold text-emerald-700">${c.ok} совпадает</span>`
  ].filter(Boolean).join(' · ');

  const tone = {
    error: { dot: 'bg-rose-500', card: 'border-rose-200 bg-rose-50/50' },
    warn: { dot: 'bg-amber-500', card: 'border-amber-200 bg-amber-50/50' },
    info: { dot: 'bg-slate-400', card: 'border-slate-200 bg-slate-50/60' },
    ok: { dot: 'bg-emerald-500', card: 'border-emerald-200 bg-emerald-50/40' }
  };
  const item = ch => `<div class="flex gap-3 p-3 rounded-xl border ${tone[ch.level].card}">
      <span class="mt-1.5 w-2 h-2 rounded-full shrink-0 ${tone[ch.level].dot}"></span>
      <div class="min-w-0"><div class="text-xs font-bold text-slate-800">${escapeHtml(ch.title)}</div>
        <div class="text-[11px] text-slate-600 leading-relaxed mt-0.5">${escapeHtml(ch.detail)}</div></div></div>`;

  const attention = d.checks.filter(x => x.level !== 'ok');
  const ok = d.checks.filter(x => x.level === 'ok');
  box.innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-2 gap-2.5">${attention.map(item).join('')}</div>`
    + (ok.length ? `<details class="mt-3"><summary class="text-xs font-bold text-slate-500 cursor-pointer select-none">Совпадает (${ok.length})</summary>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-2.5 mt-2.5">${ok.map(item).join('')}</div></details>` : '');
}

document.addEventListener('app:ready', () => {
  loadReconcile();
});
