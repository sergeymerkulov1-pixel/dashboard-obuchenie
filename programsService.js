// План-график программ и рейтинг по анкетам обратной связи.
// Разбор Excel план-графика, разбор сводных анкет из папки, привязка анкеты к группе,
// расчёт удовлетворённости и рейтинга. Проценты всегда пересчитываются по оценкам 1–5.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const dataStore = require('./dataStore');

const TYPE_LABELS = { pk: 'ДПП ПК', seminar: 'Семинар', training: 'Тренинг' };
const KIND_LABELS = { pk: 'ДПП ПК', seminar: 'Семинар', training: 'Тренинг', distant: 'Дист. семинар/тренинг' };
const FUNDING_LABELS = { gz: 'Госзадание', mfc: 'МФЦ МО', kvc: 'КВЦ', omsu: 'ОМСУ' };
const MIN_FORMS_FOR_RATING = 5;
const LOW_COVERAGE = 0.6;
const LOW_QUESTION = 85;
const NO_FEEDBACK_DAYS = 7;
const NO_FEEDBACK_WINDOW_DAYS = 45;

// ---------- общие помощники ----------

const pad2 = n => String(n).padStart(2, '0');
const sha = (s, n = 10) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

function cellText(c) {
  if (c === null || c === undefined) return '';
  return String(c).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[«»"'“”„’`]/g, ' ')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validDM(d, m) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function toIso(year, m, d) {
  return `${year}-${pad2(m)}-${pad2(d)}`;
}

function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(aIso, bIso) {
  return Math.round((isoToDate(bIso) - isoToDate(aIso)) / 86400000);
}

function addDays(iso, n) {
  const d = isoToDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function todayIso() {
  const n = new Date();
  return toIso(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

function ruDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// ---------- состояние в data.json ----------

function state() {
  const d = dataStore.data;
  if (!d.schedule) {
    d.schedule = { year: 2026, fileName: null, uploadedAt: null, programs: [], warnings: [], programMeta: {}, groupMeta: {} };
  }
  if (!d.feedback) {
    d.feedback = { files: {}, manualLinks: {}, lastScanAt: null, log: [] };
  }
  if (!d.curation) {
    d.curation = { sourceUrl: null, sourceName: null, fetchedAt: null, rows: [], warnings: [], error: null, errorAt: null };
  }
  return d;
}

// реальные сводные анкеты лежат рядом с проектом; локальная ./feedback — запасной вариант
const DEFAULT_FEEDBACK_DIRS = [
  path.join(__dirname, '..', 'анкеты обратной связи'),
  path.join(__dirname, 'feedback')
];

function listFeedbackXlsx(dir) {
  return fs.readdirSync(dir).filter(n => /\.xlsx$/i.test(n) && !n.startsWith('~$'));
}

function feedbackDir() {
  const s = state();
  const explicit = process.env.FEEDBACK_DIR || s.settings?.feedbackDir;
  if (explicit) return explicit;
  const withFiles = DEFAULT_FEEDBACK_DIRS.find(d => {
    try { return listFeedbackXlsx(d).length > 0; } catch (e) { return false; }
  });
  return withFiles || DEFAULT_FEEDBACK_DIRS.find(d => fs.existsSync(d)) || DEFAULT_FEEDBACK_DIRS[0];
}

// Источник анкет: есть ли папка и файлы в ней. Пока источник пуст, «анкета не собрана» не ставится —
// иначе любая завершившаяся группа выглядела бы как недоработка.
function feedbackSource() {
  const dir = feedbackDir();
  let exists = false;
  let files = 0;
  try {
    exists = fs.statSync(dir).isDirectory();
    if (exists) files = listFeedbackXlsx(dir).length;
  } catch (e) { /* папки нет */ }
  return { dir, exists, files, empty: files === 0 };
}

// ---------- разбор план-графика ----------

function parseCell(text, year) {
  const s = cellText(text);
  const groups = [];
  if (!s) return { groups, ok: true };

  const mk = (a, b, extra = {}) => {
    const [d1, m1] = a.split('.').map(Number);
    const [d2, m2] = b.split('.').map(Number);
    if (!validDM(d1, m1) || !validDM(d2, m2)) return null;
    const start = toIso(year, m1, d1);
    let end = toIso(year, m2, d2);
    if (end < start) end = toIso(year + 1, m2, d2);
    return { start, end, ...extra };
  };

  const sess = s.match(/установ\.?\s*сессия\s*-?\s*(\d{1,2}\.\d{2})(?:\s*-\s*(\d{1,2}\.\d{2}))?\s*итоговая\s*сессия\s*-?\s*(\d{1,2}\.\d{2})(?:\s*-\s*(\d{1,2}\.\d{2}))?/i);
  if (sess) {
    const g = mk(sess[1], sess[4] || sess[3], {
      kind: 'sessions',
      sessions: [
        { name: 'Установочная', from: sess[1], to: sess[2] || sess[1] },
        { name: 'Итоговая', from: sess[3], to: sess[4] || sess[3] }
      ]
    });
    if (g) groups.push(g);
    return { groups, ok: groups.length > 0 };
  }

  let rest = s;
  const rangeRe = /(\d{1,2}\.\d{2})\s*[-–—]\s*(\d{1,2}\.\d{2})/g;
  let m;
  while ((m = rangeRe.exec(s)) !== null) {
    const g = mk(m[1], m[2], { kind: 'range' });
    if (g) groups.push(g);
  }
  rest = rest.replace(rangeRe, ' ');
  const singleRe = /\b(\d{1,2}\.\d{2})\b/g;
  while ((m = singleRe.exec(rest)) !== null) {
    const g = mk(m[1], m[1], { kind: 'single' });
    if (g) groups.push(g);
  }
  return { groups, ok: groups.length > 0 };
}

function sectionKind(title) {
  const t = title.toLowerCase();
  if (t.includes('дистанц')) return 'distant';
  if (t.includes('повышения квалификации')) return 'pk';
  if (t.includes('семинар')) return 'seminar';
  if (t.includes('тренинг')) return 'training';
  return 'pk';
}

function parsePlanSchedule(buffer, year = 2026) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('В файле нет листов');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  let headerIdx = -1;
  let monthCol0 = 4;
  rows.forEach((r, i) => {
    if (headerIdx !== -1) return;
    const c = r.findIndex(x => cellText(x).toLowerCase() === 'январь');
    if (c !== -1) { headerIdx = i; monthCol0 = c; }
  });
  if (headerIdx === -1) throw new Error('Не найдена строка с месяцами (Январь … Декабрь). Проверьте, что это план-график.');

  const programs = [];
  const warnings = [];
  let section = { no: 0, title: '', kind: 'pk' };
  let direction = '';

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const a = cellText(r[0]);
    const b = cellText(r[1]);
    const restEmpty = r.slice(1).every(x => cellText(x) === '');

    if (!a && !b) continue;

    const secMatch = a.match(/^(\d)\s*\.\s*(\S.*)$/);
    if (secMatch && restEmpty && !/^\d+$/.test(a)) {
      section = { no: Number(secMatch[1]), title: secMatch[2], kind: sectionKind(secMatch[2]) };
      direction = '';
      continue;
    }
    if (a && restEmpty && !/^\d+$/.test(a)) {
      direction = a;
      continue;
    }
    if (!/^\d+$/.test(a) || !b) continue;

    const num = Number(a);
    const form = /электронн\w*\s+курс/i.test(b) ? 'электронный курс' : null;
    const name = b.replace(/\(\s*электронн\w*\s+курс\s*\)/i, '').replace(/\s+/g, ' ').trim();
    const key = `${section.kind}|${normName(name)}`;
    const program = {
      pid: 'p_' + sha(key, 8),
      key,
      section: section.no,
      kind: section.kind,
      direction: direction || section.title,
      num,
      name,
      form,
      audience: cellText(r[2]),
      hours: Number(r[3]) || null,
      groups: []
    };

    for (let mi = 0; mi < 12; mi++) {
      const raw = r[monthCol0 + mi];
      if (cellText(raw) === '') continue;
      const parsed = parseCell(raw, year);
      if (!parsed.ok) {
        warnings.push(`Не удалось разобрать ячейку «${cellText(raw)}» (программа № ${section.no}.${num}, месяц ${mi + 1})`);
        continue;
      }
      parsed.groups.forEach(g => {
        program.groups.push({ id: 'g_' + sha(`${key}@${g.start}`, 10), ...g });
      });
    }
    program.groups.sort((x, y) => x.start.localeCompare(y.start));
    programs.push(program);
  }

  if (programs.length === 0) throw new Error('В файле не найдено ни одной программы');
  return { programs, warnings, year };
}

function applySchedule(parsed, fileName) {
  const d = state();
  const oldIds = new Set();
  const oldNames = {};
  (d.schedule.programs || []).forEach(p => p.groups.forEach(g => { oldIds.add(g.id); oldNames[g.id] = `${p.name} (${ruDate(g.start)})`; }));
  const newIds = new Set();
  parsed.programs.forEach(p => p.groups.forEach(g => newIds.add(g.id)));

  const added = [...newIds].filter(id => !oldIds.has(id)).length;
  const removed = [...oldIds].filter(id => !newIds.has(id)).map(id => oldNames[id]);

  d.schedule.programs = parsed.programs;
  d.schedule.warnings = parsed.warnings;
  d.schedule.year = parsed.year;
  d.schedule.fileName = fileName;
  d.schedule.uploadedAt = new Date().toISOString();
  dataStore.saveData();

  return {
    programs: parsed.programs.length,
    groups: newIds.size,
    added: oldIds.size === 0 ? newIds.size : added,
    removed: oldIds.size === 0 ? [] : removed,
    warnings: parsed.warnings
  };
}

// ---------- разбор анкеты ----------

function toCount(v) {
  const s = cellText(v);
  if (s === '' || s === '-' || s === '–' || s === '—') return 0;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function isNumeric(v) {
  if (typeof v === 'number') return true;
  const s = cellText(v);
  return s !== '' && /^-?\d+([.,]\d+)?$/.test(s);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function parseFeedbackFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('В файле нет листов');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
  const lines = rows.map(r => r.map(cellText).filter(Boolean).join(' '));
  const lower = lines.map(l => l.toLowerCase());

  const iTitle = lower.findIndex(l => l.includes('сводный анализ'));
  const iHeader = rows.findIndex(r => r.some(c => cellText(c).toLowerCase().startsWith('сфера оценки')));
  if (iTitle === -1 || iHeader === -1) {
    throw new Error('Не похоже на сводную анкету: нет строк «Сводный анализ…» и «Сфера оценки»');
  }

  const head = lines.slice(iTitle, iHeader).join(' ');
  const headLower = head.toLowerCase();
  const titleMatch = head.match(/«([^»]+)»/) || head.match(/"([^"]+)"/);
  if (!titleMatch) throw new Error('Не найдено название программы в «ёлочках»');
  const title = titleMatch[1].trim();

  let kind = null;
  if (/повышения квалификации|профессиональной программы/.test(headLower)) kind = 'pk';
  else if (/семинар/.test(headLower)) kind = 'seminar';
  else if (/тренинг/.test(headLower)) kind = 'training';
  const distant = /заочн|дистанц|электронн/.test(headLower);

  let start = null;
  let end = null;
  const range = head.match(/(\d{1,2})\.(\d{2})\s*[-–—]\s*(\d{1,2})\.(\d{2})\.(\d{4})/);
  if (range) {
    const y2 = Number(range[5]);
    const y1 = Number(range[2]) > Number(range[4]) ? y2 - 1 : y2;
    start = toIso(y1, Number(range[2]), Number(range[1]));
    end = toIso(y2, Number(range[4]), Number(range[3]));
  } else {
    const single = head.match(/(\d{1,2})\.(\d{2})\.(\d{4})/);
    if (single) {
      start = end = toIso(Number(single[3]), Number(single[2]), Number(single[1]));
    }
  }
  if (!start) throw new Error('Не найдены даты обучения (ожидается 06.04-27.04.2026)');

  const allText = lines.join(' | ');
  const listenersM = allText.match(/количество\s+слушателей\s*:\s*(\d+)/i);
  const formsM = allText.match(/количество\s+анкет\s*:\s*(\d+)/i);
  const listeners = listenersM ? Number(listenersM[1]) : null;
  let forms = formsM ? Number(formsM[1]) : null;

  // шкала 1..5
  let scaleIdx = -1;
  let scaleCols = null;
  for (let i = iHeader; i < Math.min(rows.length, iHeader + 4); i++) {
    const cols = [];
    rows[i].forEach((c, ci) => { if (cellText(c) !== '') cols.push([ci, cellText(c)]); });
    const seq = cols.filter(([, v]) => /^[1-5]$/.test(v));
    if (seq.length >= 5) {
      for (let s = 0; s + 5 <= seq.length; s++) {
        if (seq.slice(s, s + 5).map(x => x[1]).join('') === '12345') {
          scaleIdx = i;
          scaleCols = seq.slice(s, s + 5).map(x => x[0]);
          break;
        }
      }
      if (scaleCols) break;
    }
  }
  if (!scaleCols) throw new Error('Не найдена строка шкалы «1 2 3 4 5»');

  const questions = [];
  let fileTotal = null;
  for (let i = scaleIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const first = lines[i].toLowerCase();
    if (first.startsWith('итого')) {
      const nums = r.filter((c, ci) => ci > 0 && isNumeric(c));
      if (nums.length) fileTotal = toCount(nums[nums.length - 1]);
      break;
    }
    if (!isNumeric(r.find(c => cellText(c) !== ''))) continue;
    const textCells = r.slice(0, scaleCols[0]).map(cellText).filter(t => t && !isNumeric(t));
    const q = textCells.sort((a, b) => b.length - a.length)[0];
    if (!q) continue;
    const counts = scaleCols.map(ci => toCount(r[ci]));
    const after = r.slice(scaleCols[4] + 1).filter(c => isNumeric(c));
    const filePct = after.length ? toCount(after[0]) : null;
    questions.push({ no: questions.length + 1, text: q.replace(/\s+/g, ' ').trim(), counts, filePct });
  }
  if (questions.length === 0) throw new Error('Не найдено ни одного вопроса с оценками');

  const warnings = [];
  const maxResp = Math.max(...questions.map(q => q.counts.reduce((a, b) => a + b, 0)));
  if (forms === null) {
    forms = maxResp;
    warnings.push('Не указано «Количество анкет», взято максимальное число ответов на вопрос');
  }

  questions.forEach(q => {
    q.responses = q.counts.reduce((a, b) => a + b, 0);
    const sum = q.counts.reduce((a, c, i) => a + c * (i + 1), 0);
    q.avg = q.responses ? sum / q.responses : null;
    q.satisfaction = q.responses ? (sum / (5 * q.responses)) * 100 : null;
    q.dist = q.counts.map(c => (q.responses ? (c / q.responses) * 100 : 0));
    if (q.responses > forms) warnings.push(`Вопрос ${q.no}: ответов (${q.responses}) больше, чем анкет (${forms})`);
    if (q.filePct !== null && q.satisfaction !== null && Math.abs(q.filePct - q.satisfaction) > 0.5) {
      warnings.push(`Вопрос ${q.no}: в файле ${round1(q.filePct)}%, по оценкам получается ${round1(q.satisfaction)}% (на дашборде используется пересчёт)`);
    }
  });

  const valid = questions.filter(q => q.satisfaction !== null);
  const satisfaction = valid.length ? valid.reduce((a, q) => a + q.satisfaction, 0) / valid.length : null;
  if (fileTotal !== null && satisfaction !== null && Math.abs(fileTotal - satisfaction) > 0.5) {
    warnings.push(`Итог в файле ${round1(fileTotal)}%, по оценкам получается ${round1(satisfaction)}% (на дашборде используется пересчёт)`);
  }

  // комментарии
  const comments = [];
  const iComm = lower.findIndex(l => l.startsWith('комментарии'));
  if (iComm !== -1) {
    let current = { question: 'Комментарии', items: [] };
    for (let i = iComm + 1; i < lines.length; i++) {
      const l = lines[i];
      if (lower[i].startsWith('куратор')) break;
      if (/^[-–•]/.test(l)) {
        const item = l.replace(/^[-–•]\s*/, '').replace(/[;.]\s*$/, '').trim();
        if (item) current.items.push(item);
      } else if (l.trim()) {
        if (current.items.length) comments.push(current);
        current = { question: l.trim(), items: [] };
      }
    }
    if (current.items.length) comments.push(current);
  }

  let curator = null;
  for (const r of rows) {
    const idx = r.findIndex(c => cellText(c).toLowerCase().startsWith('куратор'));
    if (idx !== -1) {
      const own = cellText(r[idx]).split(':')[1];
      curator = (own && own.trim()) || r.slice(idx + 1).map(cellText).find(Boolean) || null;
      break;
    }
  }

  return {
    title, kind, distant, start, end, listeners, forms, curator,
    satisfaction, questions, comments, warnings
  };
}

// ---------- папка с анкетами ----------

function scanFeedbackFolder() {
  const s = state();
  const dir = feedbackDir();
  const log = [];
  let names = [];
  try {
    names = listFeedbackXlsx(dir);
  } catch (e) {
    s.feedback.lastScanAt = new Date().toISOString();
    s.feedback.log = [{ file: dir, status: 'error', message: 'Папка недоступна: ' + e.message }];
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
    const known = s.feedback.files[hash];
    if (known) {
      known.fileName = name;
      known.mtime = stat.mtimeMs;
      if (known.status === 'error') { log.push({ file: name, status: 'error', message: known.error }); errors++; }
      continue;
    }
    try {
      const parsed = parseFeedbackFile(buf);
      s.feedback.files[hash] = { hash, fileName: name, mtime: stat.mtimeMs, status: 'ok', parsed, importedAt: new Date().toISOString() };
      added++;
      log.push({ file: name, status: 'ok', message: 'Принят: ' + parsed.title });
    } catch (e) {
      s.feedback.files[hash] = { hash, fileName: name, mtime: stat.mtimeMs, status: 'error', error: e.message, importedAt: new Date().toISOString() };
      log.push({ file: name, status: 'error', message: e.message });
      errors++;
    }
  }
  // файлы, удалённые из папки, больше не учитываются
  Object.keys(s.feedback.files).forEach(h => { if (!present.has(h)) delete s.feedback.files[h]; });
  Object.keys(s.feedback.manualLinks).forEach(h => { if (!present.has(h)) delete s.feedback.manualLinks[h]; });

  s.feedback.lastScanAt = new Date().toISOString();
  s.feedback.log = log;
  dataStore.saveData();
  return { dir, files: names.length, added, errors };
}

function saveUploadedFeedback(originalName, buffer) {
  const dir = feedbackDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // проверяем до сохранения, чтобы в папку не попадали мусорные файлы
  parseFeedbackFile(buffer);
  const safe = path.basename(originalName || 'anketa.xlsx').replace(/[\\/:*?"<>|]/g, '_');
  const name = /\.xlsx$/i.test(safe) ? safe : safe + '.xlsx';
  fs.writeFileSync(path.join(dir, name), buffer);
  return name;
}

// ---------- привязка анкеты к группе ----------

function kindCompatible(fbKind, progKind) {
  if (!fbKind) return true;
  if (fbKind === 'pk') return progKind === 'pk';
  if (fbKind === 'seminar') return progKind === 'seminar' || progKind === 'distant';
  if (fbKind === 'training') return progKind === 'training' || progKind === 'distant';
  return true;
}

function nameMatches(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function dateScore(fb, g) {
  if (fb.start === g.start && fb.end === g.end) return 3;
  if (fb.start === g.start) return 2;
  if (fb.start <= g.end && g.start <= fb.end) return 1;
  return 0;
}

function allGroups() {
  const out = [];
  (state().schedule.programs || []).forEach(p => p.groups.forEach(g => out.push({ program: p, group: g })));
  return out;
}

function linkFeedback(entry, groupIndex) {
  const s = state();
  const manual = s.feedback.manualLinks[entry.hash];
  if (manual && groupIndex[manual]) {
    return { type: 'manual', groupId: manual };
  }
  const fb = entry.parsed;
  const nn = normName(fb.title);
  const cands = [];
  Object.values(groupIndex).forEach(({ program, group }) => {
    if (!kindCompatible(fb.kind, program.kind)) return;
    if (!nameMatches(normName(program.name), nn)) return;
    const score = dateScore(fb, group);
    if (score > 0) cands.push({ groupId: group.id, score, program, group });
  });
  if (cands.length === 0) {
    return { type: 'none', groupId: null, candidates: [] };
  }
  cands.sort((x, y) => y.score - x.score);
  const top = cands.filter(c => c.score === cands[0].score);
  if (top.length === 1) return { type: 'auto', groupId: top[0].groupId };
  return {
    type: 'ambiguous',
    groupId: null,
    candidates: top.map(c => ({ groupId: c.groupId, program: c.program.name, kind: c.program.kind, start: c.group.start, end: c.group.end }))
  };
}

// Итоговое состояние всех анкет: привязка, дубли, ключ рейтинга
function feedbackState() {
  const s = state();
  const groupIndex = {};
  allGroups().forEach(x => { groupIndex[x.group.id] = x; });

  const entries = Object.values(s.feedback.files).sort((a, b) => b.mtime - a.mtime);
  const claimed = {};
  const result = [];
  for (const e of entries) {
    if (e.status !== 'ok') {
      result.push({ hash: e.hash, fileName: e.fileName, status: 'error', error: e.error });
      continue;
    }
    const link = linkFeedback(e, groupIndex);
    const p = e.parsed;
    const gx = link.groupId ? groupIndex[link.groupId] : null;
    const dupKey = link.groupId ? 'g:' + link.groupId : `u:${p.kind || ''}:${normName(p.title)}:${p.start}:${p.end}`;
    let duplicateOf = null;
    if (claimed[dupKey]) duplicateOf = claimed[dupKey];
    else claimed[dupKey] = e.fileName;

    const programKey = gx ? gx.program.key : `fb|${p.kind || 'x'}|${normName(p.title)}`;
    result.push({
      hash: e.hash,
      fileName: e.fileName,
      status: duplicateOf ? 'duplicate' : 'ok',
      duplicateOf,
      link,
      programKey,
      programName: gx ? gx.program.name : p.title,
      programId: gx ? gx.program.pid : null,
      type: p.kind || (gx ? (gx.program.kind === 'distant' ? 'seminar' : gx.program.kind) : null),
      groupId: link.groupId,
      parsed: p
    });
  }
  return result;
}

// ---------- рейтинг ----------

function computeRatings(asOfIso = todayIso()) {
  const fbs = feedbackState();
  const source = feedbackSource();
  const usable = fbs.filter(f => f.status === 'ok');
  const byProgram = {};
  usable.forEach(f => {
    (byProgram[f.programKey] ||= []).push(f);
  });

  const ratings = Object.entries(byProgram).map(([key, list]) => {
    list.sort((a, b) => a.parsed.start.localeCompare(b.parsed.start));
    const first = list[0];
    const forms = list.reduce((a, f) => a + (f.parsed.forms || 0), 0);
    const listenersKnown = list.every(f => f.parsed.listeners);
    const listeners = listenersKnown ? list.reduce((a, f) => a + f.parsed.listeners, 0) : null;

    const weight = list.reduce((a, f) => a + (f.parsed.forms || 0), 0) || 1;
    const satisfaction = list.reduce((a, f) => a + (f.parsed.satisfaction || 0) * (f.parsed.forms || 0), 0) / weight;

    // вопросы по всем группам программы (по тексту вопроса)
    const qMap = {};
    list.forEach(f => f.parsed.questions.forEach(q => {
      const k = normName(q.text);
      const e = (qMap[k] ||= { text: q.text, counts: [0, 0, 0, 0, 0] });
      q.counts.forEach((c, i) => { e.counts[i] += c; });
    }));
    const questions = Object.values(qMap).map(q => {
      const resp = q.counts.reduce((a, b) => a + b, 0);
      const sum = q.counts.reduce((a, c, i) => a + c * (i + 1), 0);
      return { text: q.text, counts: q.counts, responses: resp, satisfaction: resp ? (sum / (5 * resp)) * 100 : null };
    });
    const weakest = questions.filter(q => q.satisfaction !== null).sort((a, b) => a.satisfaction - b.satisfaction)[0] || null;

    let trend = null;
    if (list.length >= 2) {
      trend = round1(list[list.length - 1].parsed.satisfaction - list[list.length - 2].parsed.satisfaction);
    }

    const comments = {};
    list.forEach(f => f.parsed.comments.forEach(c => {
      (comments[c.question] ||= []).push(...c.items);
    }));

    return {
      key,
      programId: first.programId,
      title: first.programName,
      type: first.type,
      typeLabel: TYPE_LABELS[first.type] || '—',
      linked: Boolean(first.programId),
      mode: (() => {
        const prog = first.programId ? (state().schedule.programs || []).find(x => x.pid === first.programId) : null;
        if (prog) return modeOfProgram(prog);
        return first.parsed.distant ? 'distant' : 'inperson';
      })(),
      groupsCount: list.length,
      forms,
      listeners,
      coverage: listeners ? forms / listeners : null,
      satisfaction: round1(satisfaction),
      avgScore: Math.round(satisfaction / 20 * 100) / 100,
      enough: forms >= MIN_FORMS_FOR_RATING,
      weakest: weakest ? { text: weakest.text, satisfaction: round1(weakest.satisfaction) } : null,
      trend,
      questions: questions.map(q => ({ ...q, satisfaction: q.satisfaction === null ? null : round1(q.satisfaction) })),
      comments: Object.entries(comments).map(([question, items]) => ({ question, items })),
      groups: list.map(f => ({
        hash: f.hash,
        fileName: f.fileName,
        groupId: f.groupId,
        linkType: f.link.type,
        start: f.parsed.start,
        end: f.parsed.end,
        forms: f.parsed.forms,
        listeners: f.parsed.listeners,
        coverage: f.parsed.listeners ? f.parsed.forms / f.parsed.listeners : null,
        satisfaction: round1(f.parsed.satisfaction),
        curator: f.parsed.curator,
        questions: f.parsed.questions.map(q => ({ no: q.no, text: q.text, counts: q.counts, satisfaction: round1(q.satisfaction), avg: round1(q.avg) })),
        warnings: f.parsed.warnings
      }))
    };
  });

  // места в рейтинге — отдельно по видам, только где достаточно анкет
  ['pk', 'seminar', 'training'].forEach(t => {
    ratings
      .filter(r => r.type === t && r.enough)
      .sort((a, b) => b.satisfaction - a.satisfaction)
      .forEach((r, i) => { r.rank = i + 1; });
  });
  ratings.sort((a, b) => {
    if (a.enough !== b.enough) return a.enough ? -1 : 1;
    return b.satisfaction - a.satisfaction;
  });

  return { ratings, files: fbs, source, signals: computeSignals(fbs, ratings, asOfIso, source), themes: computeThemes(ratings) };
}

function computeSignals(fbs, ratings, asOfIso, source = feedbackSource()) {
  const signals = [];
  const usable = fbs.filter(f => f.status === 'ok');

  // группы завершились, а анкеты нет (только если источник анкет вообще что-то содержит)
  const linkedGroupIds = new Set(usable.filter(f => f.groupId).map(f => f.groupId));
  if (!source.empty) allGroups().forEach(({ program, group }) => {
    const sinceEnd = daysBetween(group.end, asOfIso);
    if (sinceEnd > NO_FEEDBACK_DAYS && sinceEnd <= NO_FEEDBACK_WINDOW_DAYS && !linkedGroupIds.has(group.id)) {
      signals.push({
        level: 'danger', code: 'no_feedback', program: program.name, groupId: group.id,
        text: `Анкета не собрана: «${program.name}», группа ${ruDate(group.start)}–${ruDate(group.end)} завершилась ${sinceEnd} дн. назад`
      });
    }
  });

  usable.forEach(f => {
    if (f.status === 'duplicate') return;
    const p = f.parsed;
    const label = `«${f.programName}», группа ${ruDate(p.start)}–${ruDate(p.end)}`;
    if (p.listeners && p.forms / p.listeners < LOW_COVERAGE) {
      signals.push({ level: 'warn', code: 'low_coverage', program: f.programName, text: `Низкий охват анкетированием: ${label} — ${p.forms} из ${p.listeners} (${Math.round(p.forms / p.listeners * 100)}%)` });
    }
    p.questions.forEach(q => {
      if (q.satisfaction !== null && q.satisfaction < LOW_QUESTION) {
        signals.push({ level: 'warn', code: 'low_question', program: f.programName, text: `Низкая оценка по вопросу «${q.text}»: ${label} — ${round1(q.satisfaction)}%` });
      }
      const bad = q.counts[0] + q.counts[1];
      if (bad > 0) {
        signals.push({ level: 'warn', code: 'low_scores', program: f.programName, text: `Оценки 1–2 (${bad} шт.) по вопросу «${q.text}»: ${label}` });
      }
    });
    if (f.link.type === 'ambiguous') {
      signals.push({ level: 'info', code: 'needs_link', program: f.programName, text: `Анкету «${f.fileName}» подходит к нескольким группам — нужна ручная привязка` });
    }
    if (f.link.type === 'none' && state().schedule.programs.length > 0) {
      signals.push({ level: 'info', code: 'unlinked', program: f.programName, text: `Анкета «${f.fileName}» не найдена в план-графике — проверьте название и даты` });
    }
    if (p.warnings.length) {
      signals.push({ level: 'info', code: 'file_warning', program: f.programName, text: `В файле «${f.fileName}» расхождения: ${p.warnings.length} (дашборд использует пересчёт по оценкам)` });
    }
  });
  fbs.filter(f => f.status === 'error').forEach(f => {
    signals.push({ level: 'danger', code: 'file_error', program: '', text: `Файл «${f.fileName}» не принят: ${f.error}` });
  });
  fbs.filter(f => f.status === 'duplicate').forEach(f => {
    signals.push({ level: 'info', code: 'duplicate', program: f.programName, text: `Файл «${f.fileName}» — дубль анкеты, уже учтён файл «${f.duplicateOf}»` });
  });

  const order = { danger: 0, warn: 1, info: 2 };
  signals.sort((a, b) => order[a.level] - order[b.level]);
  return signals;
}

const THEME_RULES = [
  { id: 'practice', title: 'Больше практики и кейсов', re: /практич|кейс|пример|задани/i },
  { id: 'access', title: 'Доступ к материалам после курса', re: /доступ.*(после|сохран)|сохранить доступ|после завершения/i },
  { id: 'tech', title: 'Технические замечания (СДО, оформление)', re: /техническ|прокрутк|формат отображ|не открыва|ошибк|сбой|интерфейс|оформлени/i },
  { id: 'tests', title: 'Тесты и проверка знаний', re: /тест|экзамен|итогов\w* контрол/i },
  { id: 'topics', title: 'Дополнить темы', re: /добавить|включить|дополнить|расширить/i },
  { id: 'positive', title: 'Положительные отзывы', re: /положительно|благодар|отличн|спасибо|довольн|понравил|доступност|структурирован|информативн/i }
];

function computeThemes(ratings) {
  const themes = THEME_RULES.map(t => ({ id: t.id, title: t.title, count: 0, programs: new Set(), examples: [] }));
  ratings.forEach(r => {
    r.comments.forEach(c => c.items.forEach(item => {
      THEME_RULES.forEach((rule, i) => {
        if (rule.re.test(item)) {
          themes[i].count++;
          themes[i].programs.add(r.title);
          if (themes[i].examples.length < 3) themes[i].examples.push({ program: r.title, text: item });
        }
      });
    }));
  });
  return themes
    .filter(t => t.count > 0)
    .map(t => ({ id: t.id, title: t.title, count: t.count, programs: [...t.programs], examples: t.examples }))
    .sort((a, b) => b.count - a.count);
}

// ---------- строки таблицы кураторов (Google Таблица) ----------

function rowKindCompatible(rowKind, progKind) {
  if (rowKind === 'open') return false;
  if (!rowKind) return true;
  if (rowKind === 'pk') return progKind === 'pk';
  if (rowKind === 'training') return progKind === 'training' || progKind === 'distant';
  return progKind === 'seminar' || progKind === 'distant';
}

function curationRows() {
  return state().curation.rows || [];
}

function bestCurationRow(name, compatible, start, end) {
  const nn = normName(name);
  let best = null;
  curationRows().forEach(r => {
    if (!r.start || !nameMatches(r.norm, nn) || !compatible(r)) return;
    const score = dateScore({ start, end }, r);
    if (score === 0) return;
    if (!best || score > best.score || (score === best.score && best.row.cancelled && !r.cancelled)) best = { row: r, score };
  });
  return best ? best.row : null;
}

function matchCurationForGroup(program, group) {
  return bestCurationRow(program.name, r => rowKindCompatible(r.kind, program.kind), group.start, group.end);
}

// анкета → строка таблицы: вид из шапки анкеты должен совпасть с форматом строки
function matchCurationForFeedback(parsed) {
  const ok = r => {
    if (r.kind === 'open') return false;
    if (!parsed.kind || !r.kind) return true;
    if (parsed.kind === 'pk') return r.kind === 'pk';
    if (parsed.kind === 'seminar') return r.kind === 'seminar' || r.kind === 'webinar';
    if (parsed.kind === 'training') return r.kind === 'training';
    return true;
  };
  return bestCurationRow(parsed.title, ok, parsed.start, parsed.end);
}

// ---------- график ----------

// Формат: дистанционный / очный. Раздел 4 и «электронные курсы» — дистанционные;
// семинары, тренинги и программы с установочной/итоговой сессиями — очные;
// остальные ДПП ПК с непрерывным диапазоном дат — дистанционные.
const MODE_LABELS = { inperson: 'Очно', distant: 'Дистанционно' };

function modeOfProgram(p) {
  if (p.kind === 'distant') return 'distant';
  if (p.kind === 'seminar' || p.kind === 'training') return 'inperson';
  if (p.form) return 'distant';
  if (p.groups.some(g => g.kind === 'sessions')) return 'inperson';
  if (p.groups.some(g => g.kind === 'range')) return 'distant';
  return 'inperson';
}

// программа план-графика для строки таблицы кураторов (нужна для академических часов и формата)
function programForCurationRow(row) {
  const progs = state().schedule.programs || [];
  let best = null;
  progs.forEach(p => {
    if (!nameMatches(normName(p.name), row.norm) || !rowKindCompatible(row.kind, p.kind)) return;
    p.groups.forEach(g => {
      const score = dateScore({ start: row.start, end: row.end }, g);
      if (score > 0 && (!best || score > best.score)) best = { p, score };
    });
  });
  return best ? best.p : null;
}

// статусы программ (statusService) подключаются через регистрацию, чтобы не было циклической зависимости
let statusProvider = null;
function registerStatusProvider(fn) {
  statusProvider = fn;
}

function getEffectiveMeta(program, group) {
  const s = state().schedule;
  const pm = s.programMeta[program.key] || {};
  const gm = s.groupMeta[group.id] || {};
  return {
    funding: gm.funding ?? pm.funding ?? null,
    curator: gm.curator ?? pm.curator ?? null,
    planned: gm.planned ?? pm.planned ?? null
  };
}

function groupStatus(group, asOfIso, hasFeedback, feedbackEmpty = false) {
  if (group.start > asOfIso) return 'planned';
  if (group.end >= asOfIso) return 'running';
  if (hasFeedback) return 'rated';
  if (feedbackEmpty) return 'finished';
  const since = daysBetween(group.end, asOfIso);
  if (since > NO_FEEDBACK_DAYS && since <= NO_FEEDBACK_WINDOW_DAYS) return 'no_feedback';
  return 'finished';
}

function getSchedule(asOfIso = todayIso()) {
  const s = state();
  const sched = s.schedule;
  const fbs = feedbackState().filter(f => f.status === 'ok' && f.groupId);
  const source = feedbackSource();
  const fbByGroup = {};
  fbs.forEach(f => { fbByGroup[f.groupId] = f; });

  const curationByGroup = {};
  sched.programs.forEach(p => p.groups.forEach(g => {
    const row = matchCurationForGroup(p, g);
    if (row) curationByGroup[g.id] = row;
  }));

  const programs = sched.programs.map(p => ({
    pid: p.pid,
    key: p.key,
    section: p.section,
    kind: p.kind,
    kindLabel: KIND_LABELS[p.kind] || '',
    direction: p.direction,
    num: p.num,
    name: p.name,
    form: p.form,
    hours: p.hours,
    audience: p.audience,
    mode: modeOfProgram(p),
    meta: s.schedule.programMeta[p.key] || {},
    groups: p.groups.map(g => {
      const fb = fbByGroup[g.id] || null;
      const eff = getEffectiveMeta(p, g);
      const row = curationByGroup[g.id] || null;
      const own = s.schedule.groupMeta[g.id] || {};
      const prog = statusProvider ? statusProvider(p, g) : null;
      const tableCurator = row && row.curators.length ? row.curators.map(c => c.name).join(' / ') : null;
      const pm = s.schedule.programMeta[p.key] || {};
      let curator = null;
      let curatorSource = null;
      if (own.curator) { curator = own.curator; curatorSource = 'manual'; }
      else if (tableCurator) { curator = tableCurator; curatorSource = 'table'; }
      else if (pm.curator) { curator = pm.curator; curatorSource = 'manual'; }
      else if (fb?.parsed.curator) { curator = fb.parsed.curator; curatorSource = 'anketa'; }
      return {
        id: g.id, start: g.start, end: g.end, kind: g.kind, sessions: g.sessions || null,
        mode: (row && row.modeByPlace) || (g.kind === 'sessions' ? 'inperson' : modeOfProgram(p)),
        status: row && row.cancelled ? 'cancelled' : groupStatus(g, asOfIso, Boolean(fb), source.empty),
        planned: eff.planned, funding: eff.funding ?? (prog ? prog.funding : null),
        fundingSource: eff.funding ? 'manual' : (prog ? 'status' : null),
        progress: prog ? { latest: prog.latest, history: prog.history } : null,
        curator, curatorSource,
        substitute: row ? row.substitute : null,
        applications: row ? row.applications : null,
        note: row ? row.notes : null,
        ownMeta: own,
        feedback: fb ? { satisfaction: round1(fb.parsed.satisfaction), forms: fb.parsed.forms, listeners: fb.parsed.listeners } : null
      };
    })
  }));

  const summary = {
    programs: programs.length, groups: 0, planned: 0, running: 0, finished: 0, rated: 0, no_feedback: 0, cancelled: 0,
    byMode: { inperson: { programs: 0, groups: 0, hours: 0 }, distant: { programs: 0, groups: 0, hours: 0 } }
  };
  programs.forEach(p => { summary.byMode[p.mode].programs++; });
  const fundingSummary = {};
  const starting = [];
  const ending = [];
  const horizon = addDays(asOfIso, 14);
  programs.forEach(p => p.groups.forEach(g => {
    summary.groups++;
    if (g.status === 'finished') summary.finished++;
    else summary[g.status]++;
    if (g.status !== 'cancelled') {
      summary.byMode[g.mode].groups++;
      summary.byMode[g.mode].hours += p.hours || 0;
    }
    const f = g.funding || 'none';
    const fe = (fundingSummary[f] ||= { groups: 0, planned: 0 });
    fe.groups++;
    fe.planned += g.planned || 0;
    const row = { pid: p.pid, gid: g.id, name: p.name, kind: p.kind, kindLabel: p.kindLabel, start: g.start, end: g.end };
    if (g.status === 'cancelled') return;
    if (g.start >= asOfIso && g.start <= horizon) starting.push(row);
    if (g.end >= asOfIso && g.end <= horizon) ending.push(row);
  }));
  starting.sort((a, b) => a.start.localeCompare(b.start));
  ending.sort((a, b) => a.end.localeCompare(b.end));

  return {
    loaded: programs.length > 0,
    asOf: asOfIso,
    year: sched.year,
    fileName: sched.fileName,
    uploadedAt: sched.uploadedAt,
    warnings: sched.warnings || [],
    summary,
    feedbackSource: source,
    fundingSummary,
    fundingLabels: FUNDING_LABELS,
    upcoming: { starting, ending },
    programs
  };
}

function setScheduleMeta({ programKey, groupId, funding, curator, planned }) {
  const s = state().schedule;
  const clean = {};
  if (funding !== undefined) {
    if (funding && !FUNDING_LABELS[funding]) throw new Error('Неизвестный источник финансирования');
    clean.funding = funding || null;
  }
  if (curator !== undefined) clean.curator = curator ? String(curator).trim().slice(0, 120) : null;
  if (planned !== undefined) {
    const n = planned === null || planned === '' ? null : Number(planned);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100000)) throw new Error('План слушателей должен быть числом от 0');
    clean.planned = n;
  }
  if (groupId) {
    const exists = allGroups().some(x => x.group.id === groupId);
    if (!exists) throw new Error('Группа не найдена');
    s.groupMeta[groupId] = { ...(s.groupMeta[groupId] || {}), ...clean };
  } else if (programKey) {
    const exists = s.programs.some(p => p.key === programKey);
    if (!exists) throw new Error('Программа не найдена');
    s.programMeta[programKey] = { ...(s.programMeta[programKey] || {}), ...clean };
  } else {
    throw new Error('Не указана программа или группа');
  }
  dataStore.saveData();
}

function setManualLink(hash, groupId) {
  const s = state();
  if (!s.feedback.files[hash]) throw new Error('Файл анкеты не найден');
  if (groupId) {
    if (!allGroups().some(x => x.group.id === groupId)) throw new Error('Группа не найдена');
    s.feedback.manualLinks[hash] = groupId;
  } else {
    delete s.feedback.manualLinks[hash];
  }
  dataStore.saveData();
}

function getFeedbackFilesInfo() {
  const s = state();
  const source = feedbackSource();
  return {
    dir: source.dir,
    source,
    lastScanAt: s.feedback.lastScanAt,
    log: s.feedback.log || [],
    files: feedbackState().map(f => ({
      hash: f.hash, fileName: f.fileName, status: f.status, error: f.error || null,
      duplicateOf: f.duplicateOf || null,
      linkType: f.link?.type || null, groupId: f.groupId || null,
      candidates: f.link?.candidates || [],
      programName: f.programName || null,
      title: f.parsed?.title || null,
      start: f.parsed?.start || null, end: f.parsed?.end || null,
      kindLabel: f.parsed?.kind ? TYPE_LABELS[f.parsed.kind] : null
    }))
  };
}

function setFeedbackDir(dir) {
  const d = String(dir || '').trim();
  const s = state();
  s.settings = s.settings || {};
  if (!d) {
    delete s.settings.feedbackDir;
  } else {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error('Такой папки нет на сервере');
    s.settings.feedbackDir = d;
  }
  dataStore.saveData();
}

// ---------- выгрузка рейтинга ----------

function buildRatingsWorkbook() {
  const { ratings } = computeRatings();
  const header = ['Место', 'Программа', 'Вид', 'Групп', 'Анкет', 'Слушателей', 'Охват, %', 'Удовлетворённость, %', 'Средний балл (из 5)', 'Слабое место', 'Тренд, п.п.', 'Примечание'];
  const rows = ratings.map(r => [
    r.rank || '', r.title, r.typeLabel, r.groupsCount, r.forms, r.listeners ?? '',
    r.coverage !== null ? Math.round(r.coverage * 100) : '', r.satisfaction, r.avgScore,
    r.weakest ? `${r.weakest.text} (${r.weakest.satisfaction}%)` : '', r.trend ?? '',
    r.enough ? '' : `мало данных (меньше ${MIN_FORMS_FOR_RATING} анкет)`
  ]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{ wch: 7 }, { wch: 60 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 18 }, { wch: 60 }, { wch: 12 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Рейтинг программ');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  parsePlanSchedule, applySchedule, parseFeedbackFile, scanFeedbackFolder, saveUploadedFeedback,
  computeRatings, getSchedule, setScheduleMeta, setManualLink, getFeedbackFilesInfo, setFeedbackDir,
  buildRatingsWorkbook, feedbackDir, feedbackSource, todayIso,
  // для curatorsService и statusService
  registerStatusProvider, modeOfProgram, programForCurationRow, MODE_LABELS, state, normName, nameMatches, dateScore, feedbackState, matchCurationForFeedback, matchCurationForGroup,
  validDM, toIso, isoToDate, daysBetween, ruDate, round1, cellText, TYPE_LABELS, KIND_LABELS,
  constants: { MIN_FORMS_FOR_RATING, LOW_COVERAGE, LOW_QUESTION, NO_FEEDBACK_DAYS, NO_FEEDBACK_WINDOW_DAYS }
};
