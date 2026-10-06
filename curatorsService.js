// Кураторы программ и рейтинг кураторов.
// Источник: помесячная Google Таблица (листы «январь» … «декабрь», колонка «Куратор»).
// Рейтинг строится по анкетам: анкета привязывается к строке таблицы по названию, виду и датам.

const crypto = require('crypto');
const XLSX = require('xlsx');
const dataStore = require('./dataStore');
const ps = require('./programsService');

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MAX_DOWNLOAD = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45000;

const text = ps.cellText;
const sha = (s, n = 10) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

// ---------- скачивание ----------

function sheetIdFromUrl(url) {
  const m = String(url || '').trim().match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function downloadSheet(url) {
  const id = sheetIdFromUrl(url);
  if (!id) throw new Error('Нужна ссылка вида https://docs.google.com/spreadsheets/d/…');
  const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(exportUrl, { signal: ctrl.signal, redirect: 'follow' });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Нет доступа к таблице: включите доступ «Все, у кого есть ссылка — читатель»');
    }
    if (!res.ok) throw new Error(`Google вернул ошибку ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_DOWNLOAD) throw new Error('Файл таблицы слишком большой');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD) throw new Error('Файл таблицы слишком большой');
    if (buf.subarray(0, 2).toString('latin1') !== 'PK') {
      throw new Error('Google вернул не Excel-файл (вероятно, таблица закрыта для просмотра по ссылке)');
    }
    return buf;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Google Таблица не ответила за 45 секунд');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- разбор ----------

function extractDates(str, year) {
  const out = [];
  const re = /(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?\.(\d{1,2})(?:\.(\d{4}))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const mon = Number(m[3]);
    const y = m[4] ? Number(m[4]) : year;
    [m[1], m[2]].filter(Boolean).forEach(dd => {
      const d = Number(dd);
      if (ps.validDM(d, mon)) out.push(ps.toIso(y, mon, d));
    });
  }
  return out;
}

// Возвращает список групп {start, end}; пустой список = даты не разобраны
function parseSheetDates(value, year) {
  if (value === null || value === undefined || text(value) === '') return [];
  if (typeof value === 'number') {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d || d.y < 2000 || d.y > 2100) return [];
    const iso = ps.toIso(d.y, d.m, d.d);
    return [{ start: iso, end: iso }];
  }
  const s = text(value);
  const dates = extractDates(s, year);
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  if (/сесс/i.test(s) || /[-–—]/.test(s)) return [{ start: sorted[0], end: sorted[sorted.length - 1] }];
  if (dates.length === 1) return [{ start: dates[0], end: dates[0] }];
  return sorted.map(d => ({ start: d, end: d }));
}

function sheetKind(format) {
  const t = text(format).toLowerCase();
  if (!t) return null;
  if (t.startsWith('пк')) return 'pk';
  if (t.startsWith('семинар')) return 'seminar';
  if (t.startsWith('тренинг')) return 'training';
  if (t.startsWith('открыт')) return 'open';
  if (t.startsWith('вебинар')) return 'webinar';
  return null;
}

function surnameKey(name) {
  return name.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

// «С.С. Меркулов» → «Меркулов»; несколько кураторов через / , ; или «и»
function parseCurators(value) {
  const t = text(value);
  if (!t) return [];
  const out = [];
  t.split(/[\/,;]|\sи\s/).forEach(part => {
    const name = part.replace(/[А-ЯЁ]\.\s*/g, '').replace(/\s+/g, ' ').trim();
    if (!name || /\d/.test(name) || name.length > 40) return;
    out.push({ name, key: surnameKey(name) });
  });
  return out;
}

function parseApplications(value) {
  if (typeof value === 'number' && value >= 0 && value <= 1000) return Math.round(value);
  const t = text(value);
  return /^\d{1,4}$/.test(t) && Number(t) <= 1000 ? Number(t) : null;
}

function parseCuratorSheet(buffer, year = 2026) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  const warnings = [];

  wb.SheetNames.forEach(sheetName => {
    if (!MONTHS.includes(sheetName.trim().toLowerCase())) return;
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
    const hi = aoa.findIndex(r => r.some(c => text(c).toLowerCase() === 'наименование'));
    if (hi === -1) {
      warnings.push(`Лист «${sheetName}»: не найден заголовок «Наименование»`);
      return;
    }
    const header = aoa[hi].map(c => text(c).toLowerCase());
    const col = re => header.findIndex(h => re.test(h));
    const cName = col(/^наименование/);
    const cFmt = col(/^формат/);
    const cDate = col(/^даты/);
    const cSpk = col(/^спикер/);
    const cPlace = col(/^место/);
    const cCur = col(/^куратор/);
    const cApp = col(/заяв/);
    const noteCols = header.map((h, i) => (/^комментар|^дополнит|^примеч|^примея/.test(h) ? i : -1)).filter(i => i >= 0);
    if (cDate === -1 || cCur === -1) {
      warnings.push(`Лист «${sheetName}»: нет колонок «Даты проведения» или «Куратор»`);
      return;
    }

    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i];
      const name = text(r[cName]);
      if (!name) continue;
      const groups = parseSheetDates(r[cDate], year);
      if (groups.length === 0) {
        warnings.push(`Лист «${sheetName}», строка ${i + 1}: не разобраны даты «${text(r[cDate]) || 'пусто'}» (${name.slice(0, 50)})`);
        continue;
      }
      const notes = noteCols.map(c => text(r[c])).filter(Boolean).join('; ');
      const placeText = cPlace === -1 ? '' : text(r[cPlace]);
      let modeByPlace = null;
      if (/lms|дистанц|онлайн|вебинар|zoom|teams/i.test(placeText)) modeByPlace = 'distant';
      else if (placeText) modeByPlace = 'inperson';
      else if (sheetKind(r[cFmt]) === 'webinar') modeByPlace = 'distant';
      const hasSessions = /сесс/i.test(text(r[cDate]));
      const subM = notes.match(/([А-ЯЁ][а-яё]+)\s+на\s+время\s+отпуск/);
      groups.forEach(g => {
        rows.push({
          id: 'c_' + sha(`${sheetName}|${i}|${name}|${g.start}`, 10),
          sheet: sheetName.trim().toLowerCase(),
          name,
          norm: ps.normName(name),
          kind: sheetKind(r[cFmt]),
          kindRaw: text(r[cFmt]),
          start: g.start,
          end: g.end,
          curators: parseCurators(r[cCur]),
          applications: cApp === -1 ? null : parseApplications(r[cApp]),
          speaker: cSpk === -1 ? '' : text(r[cSpk]),
          place: placeText,
          modeByPlace,
          hasSessions,
          notes,
          substitute: subM ? subM[1] : null,
          cancelled: /отмен/i.test(notes)
        });
      });
    }
  });

  if (rows.length === 0) throw new Error('В файле не найдено ни одной строки: нужны листы «январь» … «декабрь» с колонками «Наименование», «Даты проведения», «Куратор»');
  return { rows, warnings, year };
}

function applyParsed(parsed, { sourceUrl, sourceName }) {
  const c = ps.state().curation;
  c.rows = parsed.rows;
  c.warnings = parsed.warnings;
  c.year = parsed.year;
  c.sourceUrl = sourceUrl || null;
  c.sourceName = sourceName || null;
  c.fetchedAt = new Date().toISOString();
  c.error = null;
  c.errorAt = null;
  dataStore.saveData();
  return { rows: parsed.rows.length, warnings: parsed.warnings };
}

function getSourceUrl() {
  return process.env.CURATOR_SHEET_URL || ps.state().settings?.curatorSheetUrl || null;
}

async function refreshFromGoogle() {
  const url = getSourceUrl();
  if (!url) throw new Error('Не указана ссылка на Google Таблицу с кураторами');
  try {
    const buf = await downloadSheet(url);
    return applyParsed(parseCuratorSheet(buf), { sourceUrl: url, sourceName: 'Google Таблица' });
  } catch (e) {
    const c = ps.state().curation;
    c.error = e.message;
    c.errorAt = new Date().toISOString();
    dataStore.saveData();
    throw e;
  }
}

function importFile(buffer, fileName) {
  return applyParsed(parseCuratorSheet(buffer), { sourceUrl: null, sourceName: fileName });
}

function setSourceUrl(url) {
  const s = ps.state();
  s.settings = s.settings || {};
  const u = String(url || '').trim();
  if (!u) {
    delete s.settings.curatorSheetUrl;
  } else {
    if (!sheetIdFromUrl(u)) throw new Error('Нужна ссылка вида https://docs.google.com/spreadsheets/d/…');
    s.settings.curatorSheetUrl = u;
  }
  dataStore.saveData();
}

// ---------- рейтинг кураторов ----------

function surnameOfFileCurator(str) {
  if (!str) return null;
  const list = parseCurators(str);
  return list.length ? list[0].key : null;
}

function computeCurators(asOfIso = ps.todayIso()) {
  const s = ps.state();
  const cur = s.curation;
  const rows = cur.rows || [];

  // анкеты, найденные в таблице; дубли файлов уже исключены (status !== 'ok')
  const fbs = ps.feedbackState().filter(f => f.status === 'ok');
  const fbByRow = {};
  const conflicts = [];
  const noRowFeedback = [];
  fbs.forEach(f => {
    const row = ps.matchCurationForFeedback(f.parsed, rows);
    if (!row) {
      noRowFeedback.push({ fileName: f.fileName, title: f.parsed.title, start: f.parsed.start, end: f.parsed.end });
      return;
    }
    if (fbByRow[row.id]) return;
    fbByRow[row.id] = f;
    const fileKey = surnameOfFileCurator(f.parsed.curator);
    if (fileKey && row.curators.length && !row.curators.some(c => c.key === fileKey)) {
      conflicts.push({
        fileName: f.fileName, title: f.parsed.title, start: f.parsed.start, end: f.parsed.end,
        table: row.curators.map(c => c.name).join(' / '), file: f.parsed.curator
      });
    }
  });

  // еженедельные статусы: завершаемость и заявки КВЦ
  const statusService = require('./statusService');
  const smRaw = statusService.curatorMetrics();

  // опечатки без женского окончания («Буланцев» → «Буланцева») объединяются с полной фамилией
  const allKeys = new Set(Object.keys(smRaw));
  rows.forEach(r => r.curators.forEach(c => allKeys.add(c.key)));
  const alias = {};
  allKeys.forEach(k => { if (allKeys.has(k + 'а')) alias[k] = k + 'а'; });
  const canon = k => alias[k] || k;

  const byCurator = {};
  rows.forEach(r => {
    if (!r.start) return;
    r.curators.forEach(c => {
      const k = canon(c.key);
      const e = (byCurator[k] ||= { key: k, name: c.name, rows: [] });
      if (c.key === k) e.name = c.name;
      e.rows.push(r);
    });
  });

  const curators = Object.values(byCurator).map(c => {
    const groups = c.rows.map(r => {
      const fb = fbByRow[r.id] || null;
      let status;
      if (r.cancelled) status = 'cancelled';
      else if (r.start > asOfIso) status = 'planned';
      else if (r.end >= asOfIso) status = 'running';
      else status = fb ? 'rated' : 'finished';
      const prog = ps.programForCurationRow(r);
      const mode = r.modeByPlace || (r.hasSessions ? 'inperson' : (prog ? ps.modeOfProgram(prog) : (r.end > r.start ? 'distant' : 'inperson')));
      return {
        rowId: r.id, name: r.name, kind: r.kind, kindRaw: r.kindRaw, sheet: r.sheet,
        mode, hours: prog ? prog.hours : null,
        start: r.start, end: r.end, status,
        applications: r.applications, note: r.notes, substitute: r.substitute,
        feedback: fb ? { satisfaction: ps.round1(fb.parsed.satisfaction), forms: fb.parsed.forms, listeners: fb.parsed.listeners } : null
      };
    }).sort((a, b) => b.start.localeCompare(a.start));

    const active = groups.filter(g => g.status !== 'cancelled');
    const rated = active.filter(g => g.feedback);
    const forms = rated.reduce((a, g) => a + (g.feedback.forms || 0), 0);
    const listenersKnown = rated.length > 0 && rated.every(g => g.feedback.listeners);
    const listeners = listenersKnown ? rated.reduce((a, g) => a + g.feedback.listeners, 0) : null;
    const satisfaction = forms ? rated.reduce((a, g) => a + g.feedback.satisfaction * (g.feedback.forms || 0), 0) / forms : null;

    const progMap = {};
    active.forEach(g => {
      const k = ps.normName(g.name) + '|' + (g.kind || '');
      const e = (progMap[k] ||= { name: g.name, kind: g.kind, groups: 0, finished: 0, rated: 0 });
      e.groups++;
      if (g.status === 'finished' || g.status === 'rated') e.finished++;
      if (g.feedback) e.rated++;
    });

    const appValues = active.map(g => g.applications).filter(v => v !== null);
    const byMode = {};
    ['inperson', 'distant'].forEach(m => {
      const list = active.filter(g => g.mode === m);
      byMode[m] = {
        groups: list.length,
        finished: list.filter(g => g.status === 'finished' || g.status === 'rated').length,
        running: list.filter(g => g.status === 'running').length,
        planned: list.filter(g => g.status === 'planned').length,
        applications: list.reduce((a, g) => a + (g.applications || 0), 0),
        hours: list.reduce((a, g) => a + (g.hours || 0), 0),
        withoutHours: list.filter(g => !g.hours).length
      };
    });
    return {
      key: c.key,
      name: c.name,
      groupsTotal: active.length,
      cancelled: groups.length - active.length,
      finished: active.filter(g => g.status === 'finished' || g.status === 'rated').length,
      running: active.filter(g => g.status === 'running').length,
      planned: active.filter(g => g.status === 'planned').length,
      ratedGroups: rated.length,
      forms,
      listeners,
      coverage: listeners ? forms / listeners : null,
      satisfaction: satisfaction === null ? null : ps.round1(satisfaction),
      enough: forms >= ps.constants.MIN_FORMS_FOR_RATING,
      applications: appValues.length ? appValues.reduce((a, b) => a + b, 0) : null,
      programs: Object.values(progMap).sort((a, b) => b.groups - a.groups || a.name.localeCompare(b.name)),
      byMode,
      groups
    };
  });

  const sm = {};
  Object.values(smRaw).forEach(m => {
    const k = canon(m.key);
    const e = (sm[k] ||= {
      key: k, name: (smRaw[k] || m).name,
      completion: { requested: 0, completed: 0, groups: 0 }, kvc: { applications: 0, programs: [] }, rows: [],
      workload: { inperson: { groups: 0, requested: 0 }, distant: { groups: 0, requested: 0 } },
      mass: { programs: 0, requested: 0 }
    });
    e.mass.programs += m.mass.programs;
    e.mass.requested += m.mass.requested;
    e.completion.requested += m.completion.requested;
    e.completion.completed += m.completion.completed;
    e.completion.groups += m.completion.groups;
    e.kvc.applications += m.kvc.applications;
    e.kvc.programs.push(...m.kvc.programs);
    e.rows.push(...m.rows);
    ['inperson', 'distant'].forEach(md => {
      e.workload[md].groups += m.workload[md].groups;
      e.workload[md].requested += m.workload[md].requested;
    });
  });
  const MIN_REQ = statusService.MIN_REQUESTED_FOR_COMPLETION;
  const attach = (c, m) => {
    const requested = m ? m.completion.requested : 0;
    const completed = m ? m.completion.completed : 0;
    c.completionRequested = requested;
    c.completionCompleted = completed;
    c.completionGroups = m ? m.completion.groups : 0;
    c.completionRate = requested > 0 ? ps.round1(completed / requested * 100) : null;
    c.completionEnough = requested >= MIN_REQ;
    c.workload = m ? m.workload : { inperson: { groups: 0, requested: 0 }, distant: { groups: 0, requested: 0 } };
    c.mass = m ? m.mass : { programs: 0, requested: 0 };
    c.kvcApplications = m ? m.kvc.applications : 0;
    c.kvcPrograms = m ? m.kvc.programs : [];
    c.statusRows = m ? m.rows : [];
  };
  curators.forEach(c => attach(c, sm[c.key]));
  Object.values(sm).forEach(m => {
    if (byCurator[m.key]) return;
    const c = {
      key: m.key, name: m.name, groupsTotal: 0, cancelled: 0, finished: 0, running: 0, planned: 0, ratedGroups: 0,
      forms: 0, listeners: null, coverage: null, satisfaction: null, enough: false, applications: null, programs: [], groups: [],
      byMode: {
        inperson: { groups: 0, finished: 0, running: 0, planned: 0, applications: 0, hours: 0, withoutHours: 0 },
        distant: { groups: 0, finished: 0, running: 0, planned: 0, applications: 0, hours: 0, withoutHours: 0 }
      }
    };
    attach(c, m);
    curators.push(c);
  });

  curators
    .filter(c => c.enough)
    .sort((a, b) => b.satisfaction - a.satisfaction)
    .forEach((c, i) => { c.rank = i + 1; });
  curators
    .filter(c => c.completionEnough)
    .sort((a, b) => b.completionRate - a.completionRate)
    .forEach((c, i) => { c.rankCompletion = i + 1; });
  const tier = c => (c.enough ? 0 : (c.completionEnough ? 1 : 2));
  curators.sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (tier(a) === 0) return b.satisfaction - a.satisfaction;
    if (tier(a) === 1) return b.completionRate - a.completionRate;
    return b.groupsTotal - a.groupsTotal;
  });

  const noCurator = rows
    .filter(r => r.start && !r.cancelled && r.kind !== 'open' && r.curators.length === 0)
    .map(r => ({ sheet: r.sheet, name: r.name, start: r.start, end: r.end, kind: r.kind }))
    .sort((a, b) => a.start.localeCompare(b.start));

  return {
    source: {
      url: getSourceUrl(),
      sourceName: cur.sourceName,
      fetchedAt: cur.fetchedAt,
      rows: rows.length,
      warnings: cur.warnings || [],
      error: cur.error,
      errorAt: cur.errorAt
    },
    asOf: asOfIso,
    curators,
    noCurator: { count: noCurator.length, items: noCurator.slice(0, 50) },
    conflicts,
    aliases: Object.entries(alias).map(([from, to]) => ({ from, to })),
    unmatchedFeedback: noRowFeedback,
    statuses: statusService.getStatusInfo(),
    constants: { ...ps.constants, MIN_REQUESTED_FOR_COMPLETION: MIN_REQ }
  };
}

function buildCuratorsWorkbook() {
  const { curators } = computeCurators();
  const head = ['Место (анкеты)', 'Куратор', 'Групп (без отменённых)', 'Проведено', 'Идут', 'Впереди', 'Отменено', 'Анкет получено по группам', 'Анкет', 'Слушателей', 'Охват, %', 'Удовлетворённость, %', 'Заявок (по таблице)', 'Место (завершаемость)', 'Заявлено (дистант)', 'Завершили', 'Завершаемость, %', 'Заявок КВЦ', 'Примечание'];
  const rows = curators.map(c => [
    c.rank || '', c.name, c.groupsTotal, c.finished, c.running, c.planned, c.cancelled, c.ratedGroups, c.forms,
    c.listeners ?? '', c.coverage !== null ? Math.round(c.coverage * 100) : '', c.satisfaction ?? '', c.applications ?? '',
    c.rankCompletion || '', c.completionRequested || '', c.completionRequested ? c.completionCompleted : '', c.completionRate ?? '', c.kvcApplications || '',
    [c.forms === 0 ? 'нет анкет' : (c.enough ? '' : `анкет мало (меньше ${ps.constants.MIN_FORMS_FOR_RATING})`),
      c.completionRequested && !c.completionEnough ? 'завершаемость: мало данных' : ''].filter(Boolean).join('; ')
  ]);
  const ws1 = XLSX.utils.aoa_to_sheet([head, ...rows]);
  ws1['!cols'] = [{ wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 11 }, { wch: 7 }, { wch: 9 }, { wch: 10 }, { wch: 16 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 11 }, { wch: 36 }];

  const gHead = ['Куратор', 'Программа', 'Формат', 'Начало', 'Окончание', 'Статус', 'Заявок', 'Удовлетворённость, %', 'Анкет', 'Примечание'];
  const statusRu = { cancelled: 'отменена', planned: 'запланирована', running: 'идёт', finished: 'проведена', rated: 'проведена, анкета получена' };
  const gRows = [];
  curators.forEach(c => c.groups.slice().reverse().forEach(g => gRows.push([
    c.name, g.name, g.kindRaw, ps.ruDate(g.start), ps.ruDate(g.end), statusRu[g.status] || g.status, g.applications ?? '',
    g.feedback ? g.feedback.satisfaction : '', g.feedback ? g.feedback.forms : '',
    [g.note, g.substitute ? `замена: ${g.substitute}` : ''].filter(Boolean).join('; ')
  ])));
  const ws2 = XLSX.utils.aoa_to_sheet([gHead, ...gRows]);
  ws2['!cols'] = [{ wch: 16 }, { wch: 60 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 24 }, { wch: 8 }, { wch: 16 }, { wch: 8 }, { wch: 50 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Рейтинг кураторов');
  XLSX.utils.book_append_sheet(wb, ws2, 'Группы по кураторам');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  parseCurators, extractDates, parseCuratorSheet, parseSheetDates, refreshFromGoogle, importFile, setSourceUrl, getSourceUrl,
  computeCurators, buildCuratorsWorkbook, sheetIdFromUrl
};
