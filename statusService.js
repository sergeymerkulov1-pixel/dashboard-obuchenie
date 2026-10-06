// Еженедельные «Статусы по программам»: заявлено / завершили / что предпринял куратор.
// Каждый файл — снимок на дату из имени (например «…_01.10.xlsx»). Папка читается как папка анкет:
// каждый файл разбирается один раз, удалённые из папки файлы перестают учитываться.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const dataStore = require('./dataStore');
const ps = require('./programsService');
const cs = require('./curatorsService');

const text = ps.cellText;

const SECTION_DEFS = [
  { re: /госзадание.*дистант/i, key: 'gz_distant', funding: 'gz', mode: 'distant', label: 'Госзадание · дистант' },
  { re: /госзадание.*оч/i, key: 'gz_inperson', funding: 'gz', mode: 'inperson', label: 'Госзадание · очно' },
  { re: /^квц/i, key: 'kvc', funding: 'kvc', mode: 'open', label: 'КВЦ' },
  { re: /мфц/i, key: 'mfc_distant', funding: 'mfc', mode: 'distant', label: 'МФЦ · дистант' }
];

const COMPLETION_SECTIONS = new Set(['gz_distant', 'mfc_distant']);
// версия разбора: при её изменении ранее принятые файлы разбираются заново
const PARSER_VERSION = 2;
// строки от 1000 человек — массовые потоки (например, обучение всех сотрудников МФЦ за квартал), а не группы
const MASS_THRESHOLD = 1000;

function state() {
  const d = ps.state();
  if (!d.statuses) d.statuses = { files: {}, lastScanAt: null, log: [] };
  return d.statuses;
}

function statusDir() {
  return process.env.STATUS_DIR || ps.state().settings?.statusDir || path.join(__dirname, 'Статусы');
}

// ---------- разбор файла ----------

function leadingInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = text(v).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function dateFromName(fileName, mtimeMs) {
  const m = fileName.match(/(\d{2})\.(\d{2})/);
  const year = new Date(mtimeMs).getFullYear();
  if (m && ps.validDM(Number(m[1]), Number(m[2]))) {
    return { iso: ps.toIso(year, Number(m[2]), Number(m[1])), source: 'name' };
  }
  const d = new Date(mtimeMs);
  return { iso: ps.toIso(d.getFullYear(), d.getMonth() + 1, d.getDate()), source: 'mtime' };
}

function mapColumns(row) {
  const cols = {};
  row.forEach((c, i) => {
    const h = text(c).toLowerCase();
    if (!h) return;
    let field = null;
    if (h.startsWith('название')) field = 'name';
    else if (h.startsWith('что предпринял')) field = 'action';
    else if (h.startsWith('предложения по новым темам')) field = 'topics';
    else if (h.startsWith('дата')) field = 'dates';
    else if (h.startsWith('куратор')) field = 'curator';
    else if (/^(всего человек заявлено|подано заявок|всего заявок|количество заявок)/.test(h)) field = 'requested';
    else if (h.startsWith('завершили')) field = 'completed';
    else if (h.startsWith('подтвердилось')) field = 'confirmed';
    else if (h.startsWith('заключили контракты')) field = 'contracts';
    else if (h.startsWith('заполнили документы и приступили')) field = 'started';
    else if (h.startsWith('заполнили документы, но не приступили')) field = 'notStarted';
    else if (h.startsWith('не заполнили документы')) field = 'notFilled';
    else if (h.startsWith('приняли участие в очном')) field = 'training';
    if (field && cols[field] === undefined) cols[field] = i;
  });
  return cols;
}

function parseRow(r, cols, year) {
  const get = f => (cols[f] === undefined ? null : r[cols[f]]);
  const name = text(get('name'));
  const rawDates = get('dates');
  let datesText = text(rawDates);
  let dates = [];
  if (typeof rawDates === 'number' && rawDates > 30000) {
    const d = XLSX.SSF.parse_date_code(rawDates);
    if (d) {
      const iso = ps.toIso(d.y, d.m, d.d);
      dates = [iso];
      datesText = ps.ruDate(iso);
    }
  } else if (datesText) {
    dates = cs.extractDates(datesText, year).sort();
  }
  const row = {
    name,
    norm: ps.normName(name),
    datesText,
    start: dates.length ? dates[0] : null,
    end: dates.length ? dates[dates.length - 1] : null,
    curators: cs.parseCurators(get('curator')),
    requested: leadingInt(get('requested')),
    requestedText: text(get('requested')),
    completed: leadingInt(get('completed')),
    confirmed: leadingInt(get('confirmed')),
    contracts: leadingInt(get('contracts')),
    started: leadingInt(get('started')),
    notStarted: leadingInt(get('notStarted')),
    notFilled: leadingInt(get('notFilled')),
    notFilledText: text(get('notFilled')),
    training: leadingInt(get('training')),
    trainingText: text(get('training')),
    action: text(get('action')),
    topics: text(get('topics'))
  };
  const hasAny = row.name || row.requested !== null;
  return hasAny ? row : null;
}

function parseStatusFile(buffer, fileName, mtimeMs) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('В файле нет листов');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const date = dateFromName(fileName, mtimeMs);
  const year = Number(date.iso.slice(0, 4));

  const sections = [];
  let cur = null;
  let cols = null;
  for (const r of aoa) {
    const a = text(r[0]);
    const restEmpty = r.slice(1).every(c => text(c) === '');
    if (!a && restEmpty) continue;

    if (a && restEmpty && !/^название/i.test(a)) {
      const def = SECTION_DEFS.find(d => d.re.test(a));
      if (def) {
        cur = { key: def.key, title: a, funding: def.funding, mode: def.mode, label: def.label, rows: [], total: null };
        sections.push(cur);
        cols = null;
        continue;
      }
    }
    if (!cur) continue;
    if (/^название/i.test(a)) { cols = mapColumns(r); continue; }
    if (!cols) continue;
    const row = parseRow(r, cols, year);
    if (!row) continue;
    if (!row.name) {
      if (row.requested !== null) cur.total = row.requested;
      continue;
    }
    cur.rows.push(row);
  }
  if (sections.length === 0) {
    throw new Error('Не похоже на «Статусы по программам»: нет разделов ГОСЗАДАНИЕ / КВЦ / МФЦ с таблицами');
  }
  return { date: date.iso, dateSource: date.source, sections };
}

// ---------- папка ----------

function scanStatusFolder() {
  const s = state();
  const dir = statusDir();
  const log = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(n => /\.xlsx$/i.test(n) && !n.startsWith('~$'));
  } catch (e) {
    s.lastScanAt = new Date().toISOString();
    s.log = [{ file: dir, status: 'error', message: 'Папка недоступна: ' + e.message }];
    dataStore.saveData();
    return { dir, files: 0, added: 0, errors: 1 };
  }

  const present = new Set();
  let added = 0;
  let errors = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    let buf;
    let stat;
    try {
      buf = fs.readFileSync(full);
      stat = fs.statSync(full);
    } catch (e) {
      log.push({ file: name, status: 'error', message: 'Не удалось прочитать файл: ' + e.message });
      errors++;
      continue;
    }
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    present.add(hash);
    const known = s.files[hash];
    if (known && known.v === PARSER_VERSION) {
      known.fileName = name;
      known.mtime = stat.mtimeMs;
      if (known.status === 'error') { log.push({ file: name, status: 'error', message: known.error }); errors++; }
      continue;
    }
    try {
      const parsed = parseStatusFile(buf, name, stat.mtimeMs);
      s.files[hash] = { hash, v: PARSER_VERSION, fileName: name, mtime: stat.mtimeMs, status: 'ok', date: parsed.date, dateSource: parsed.dateSource, parsed, importedAt: new Date().toISOString() };
      added++;
      const total = parsed.sections.reduce((a, x) => a + x.rows.length, 0);
      log.push({ file: name, status: 'ok', message: total ? `Принят: срез на ${ps.ruDate(parsed.date)}` : 'Пустой бланк без данных: пропущен' });
    } catch (e) {
      s.files[hash] = { hash, v: PARSER_VERSION, fileName: name, mtime: stat.mtimeMs, status: 'error', error: e.message, importedAt: new Date().toISOString() };
      log.push({ file: name, status: 'error', message: e.message });
      errors++;
    }
  }
  Object.keys(s.files).forEach(h => { if (!present.has(h)) delete s.files[h]; });
  s.lastScanAt = new Date().toISOString();
  s.log = log;
  dataStore.saveData();
  return { dir, files: names.length, added, errors };
}

function saveUploadedStatus(originalName, buffer) {
  const safe = path.basename(originalName || 'statuses.xlsx').replace(/[\\/:*?"<>|]/g, '_');
  const name = /\.xlsx$/i.test(safe) ? safe : safe + '.xlsx';
  parseStatusFile(buffer, name, Date.now());
  const dir = statusDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
  return name;
}

function setStatusDir(dir) {
  const d = String(dir || '').trim();
  const s = ps.state();
  s.settings = s.settings || {};
  if (!d) {
    delete s.settings.statusDir;
  } else {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error('Такой папки нет на сервере');
    s.settings.statusDir = d;
  }
  dataStore.saveData();
}

// ---------- выборки ----------

function okFiles() {
  return Object.values(state().files)
    .filter(f => f.status === 'ok')
    .sort((a, b) => a.date.localeCompare(b.date) || a.mtime - b.mtime);
}

// последнее известное состояние каждой строки (ключ: раздел + название + дата начала)
function latestRows() {
  const map = {};
  okFiles().forEach(f => f.parsed.sections.forEach(sec => sec.rows.forEach(row => {
    const key = `${sec.key}|${row.norm}|${sec.key === 'kvc' ? '' : (row.start || '')}`;
    map[key] = { ...row, sectionKey: sec.key, funding: sec.funding, mode: sec.mode, sectionLabel: sec.label, date: f.date, file: f.fileName };
  })));
  return Object.values(map);
}

function rate(completed, requested) {
  return requested > 0 && completed !== null ? Math.round(completed / requested * 1000) / 10 : null;
}

// статус группы план-графика: источник финансирования и числа (без текстов куратора — они только для админа)
function statusForGroup(program, group) {
  const nn = ps.normName(program.name);
  const hist = [];
  let funding = null;
  okFiles().forEach(f => f.parsed.sections.forEach(sec => {
    if (sec.key === 'kvc') return;
    sec.rows.forEach(row => {
      if (!row.start || !ps.nameMatches(row.norm, nn)) return;
      if (ps.dateScore({ start: group.start, end: group.end }, row) < 2) return;
      funding = sec.funding;
      hist.push({
        date: f.date, requested: row.requested, completed: row.completed, confirmed: row.confirmed,
        started: row.started, notStarted: row.notStarted, notFilled: row.notFilled
      });
    });
  }));
  if (!hist.length) return null;
  const last = hist[hist.length - 1];
  return { funding, latest: { ...last, rate: rate(last.completed, last.requested) }, history: hist };
}

function curatorMetrics() {
  const out = {};
  const ensure = c => (out[c.key] ||= {
    key: c.key, name: c.name,
    completion: { requested: 0, completed: 0, groups: 0 },
    kvc: { applications: 0, programs: [] },
    workload: { inperson: { groups: 0, requested: 0 }, distant: { groups: 0, requested: 0 } },
    mass: { programs: 0, requested: 0 },
    rows: []
  });
  latestRows().forEach(r => r.curators.forEach(c => {
    const e = ensure(c);
    if (r.sectionKey === 'kvc') {
      if (r.requested !== null) {
        e.kvc.applications += r.requested;
        e.kvc.programs.push({ name: r.name, applications: r.requested, date: r.date });
      }
      return;
    }
    const mass = (r.requested || 0) >= MASS_THRESHOLD;
    if (mass) {
      e.mass.programs++;
      e.mass.requested += Math.round(r.requested / r.curators.length);
    } else if (r.mode === 'inperson' || r.mode === 'distant') {
      e.workload[r.mode].groups++;
      e.workload[r.mode].requested += r.requested || 0;
    }
    e.rows.push({
      mass, mode: r.mode, section: r.sectionLabel, name: r.name, dates: r.datesText, start: r.start, end: r.end,
      requested: r.requested, requestedText: r.requestedText, completed: r.completed, confirmed: r.confirmed,
      started: r.started, notStarted: r.notStarted, notFilled: r.notFilled, notFilledText: r.notFilledText,
      action: r.action, date: r.date
    });
    // завершаемость: только дистанционные группы, уже закончившиеся к дате отчёта, с внесённым результатом
    if (!mass && COMPLETION_SECTIONS.has(r.sectionKey) && r.requested > 0 && r.completed !== null && r.end && r.end <= r.date) {
      e.completion.requested += r.requested;
      e.completion.completed += r.completed;
      e.completion.groups++;
    }
  }));
  Object.values(out).forEach(e => {
    e.rows.sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    e.kvc.programs.sort((a, b) => b.applications - a.applications);
  });
  return out;
}

// Сводка по неделям для «Графика планёрок» и динамики: только числа, без имён и текстов кураторов (публичный API)
function getTimeline() {
  const byDate = {};
  okFiles().forEach(f => {
    if (!f.parsed.sections.some(s => s.rows.length)) return;
    const sec = k => f.parsed.sections.find(s => s.key === k) || null;
    const rows = s => (s ? s.rows.filter(r => (r.requested || 0) < MASS_THRESHOLD) : []);
    const sum = (list, field) => list.reduce((a, r) => a + (r[field] || 0), 0);
    const kvc = sec('kvc');
    const gzd = rows(sec('gz_distant'));
    const gzi = rows(sec('gz_inperson'));
    const mfc = rows(sec('mfc_distant'));
    const done = gzd.filter(r => r.completed !== null);
    byDate[f.date] = {
      date: f.date,
      kvc: kvc ? (kvc.total ?? sum(kvc.rows, 'requested')) : null,
      gzDistant: { groups: gzd.length, requested: sum(gzd, 'requested'), completed: sum(done, 'completed'), completedOf: sum(done, 'requested') },
      gzInperson: { groups: gzi.length, requested: sum(gzi, 'requested') },
      mfc: { groups: mfc.length, requested: sum(mfc, 'requested') }
    };
  });
  const weeks = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  weeks.forEach((w, i) => {
    const prev = i > 0 ? weeks[i - 1] : null;
    w.kvcDelta = prev && prev.kvc !== null && w.kvc !== null ? w.kvc - prev.kvc : null;
    w.daysFromPrev = prev ? ps.daysBetween(prev.date, w.date) : null;
  });
  return weeks;
}

function getStatusInfo() {
  const s = state();
  const files = Object.values(s.files).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  // динамика заявок КВЦ по неделям: сумма по программам и итоговая строка из файла
  const kvcTimeline = okFiles().map(f => {
    const sec = f.parsed.sections.find(x => x.key === 'kvc');
    const sum = sec ? sec.rows.reduce((a, r) => a + (r.requested || 0), 0) : null;
    return { date: f.date, sum, total: sec ? sec.total : null };
  });
  return {
    dir: statusDir(),
    lastScanAt: s.lastScanAt,
    log: s.log || [],
    files: files.map(f => ({
      hash: f.hash, fileName: f.fileName, status: f.status, error: f.error || null,
      date: f.date || null, dateSource: f.dateSource || null,
      rows: f.status === 'ok' ? f.parsed.sections.reduce((a, x) => a + x.rows.length, 0) : 0
    })),
    kvcTimeline
  };
}

ps.registerStatusProvider(statusForGroup);

// Недели статусов как срезы дашборда: известна только цифра КВЦ (накопленный итог заявок)
dataStore.registerVirtualSnapshotProvider('status', 2, () => getTimeline()
  .filter(w => w.kvc !== null)
  .map(w => ({
    id: w.date,
    date: ps.ruDate(w.date),
    createdAt: `${w.date}T07:00:00.000Z`,
    isAutomatic: true,
    virtual: true,
    sources: ['статусы'],
    note: 'Срез по еженедельным статусам: известна только цифра КВЦ',
    indicators: { kvc: { fact: w.kvc, override: null, src: 'статусы' } }
  })));


module.exports = {
  parseStatusFile, scanStatusFolder, saveUploadedStatus, setStatusDir, statusDir,
  latestRows, statusForGroup, curatorMetrics, getStatusInfo, getTimeline,
  MIN_REQUESTED_FOR_COMPLETION: 20, MASS_THRESHOLD
};
