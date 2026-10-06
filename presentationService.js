// Еженедельные презентации планёрок (.pptx): итог, госзадание, МФЦ, ОМСУ, КВЦ, направления обучения и программы КВЦ.
// Презентации — исходный документ для недельных цифр, поэтому по ним строится история срезов.
// Читается только текст слайдов; файл открывается как zip без внешних библиотек.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const dataStore = require('./dataStore');
const ps = require('./programsService');

const PARSER_VERSION = 1;

// ---------- минимальное чтение zip ----------

function readZipEntries(buf, accept) {
  // конец центрального каталога
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Это не zip-файл (.pptx)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждён каталог zip');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (accept(name)) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      out[name] = method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function slideLines(buf) {
  const entries = readZipEntries(buf, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const names = Object.keys(entries).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const lines = [];
  names.forEach(n => {
    const xml = entries[n].toString('utf8');
    (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []).forEach(p => {
      const t = (p.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map(x => x.replace(/<\/?a:t>/g, '')).join('');
      const line = decodeXml(t).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      if (line) lines.push(line);
    });
  });
  return lines;
}

// ---------- разбор слайда ----------

const toNum = s => Number(String(s).replace(/\D/g, ''));

function dateFromFileName(name, mtimeMs) {
  const year = new Date(mtimeMs).getFullYear();
  let m = name.match(/(\d{2})[._](\d{2})/);
  if (!m) m = name.match(/\s(\d{2})(\d{2})_/);
  if (m && ps.validDM(Number(m[1]), Number(m[2]))) return ps.toIso(year, Number(m[2]), Number(m[1]));
  return null;
}

function parseTriples(seg) {
  // «номер / название / число» подряд
  const out = [];
  for (let i = 0; i + 2 < seg.length; i++) {
    if (/^\d{1,2}$/.test(seg[i]) && !/^[\d ]+$/.test(seg[i + 1]) && /^[\d ]+$/.test(seg[i + 2])) {
      out.push({ name: seg[i + 1].replace(/\s*\((?:Открытый курс|открытый курс)\)\s*/g, '').trim(), count: toNum(seg[i + 2]) });
      i += 2;
    }
  }
  return out;
}

function parseDeck(buf) {
  const L = slideLines(buf);
  const warnings = [];
  const idx = re => L.findIndex(l => re.test(l));

  const iTotal = idx(/^СОТРУДНИКОВ ПРОШЛИ ОБУЧЕНИЕ/i);
  const total = iTotal > 0 && /^[\d ]+$/.test(L[iTotal - 1]) ? toNum(L[iTotal - 1]) : null;

  // ОМСУ — «276 чел.» в начале слайда
  const omsuLine = L.find(l => /^\d[\d ]*\s*чел\.?$/.test(l));
  const omsu = omsuLine ? toNum(omsuLine) : null;

  // МФЦ — сразу после заголовка блока
  let mfc = null;
  const iMfc = idx(/^Обучение сотрудников МФЦ МО/i);
  if (iMfc !== -1) {
    const m = (L[iMfc + 1] || '').match(/обучено\s+([\d ]+?)\s*(?:\(\+?(-?\d+)\))?\s*чел/i);
    if (m) mfc = toNum(m[1]);
  }

  // ГЗ — другая строка «обучено …»
  let gz = null;
  L.forEach((l, i) => {
    if (i === iMfc + 1) return;
    const m = l.match(/обучено\s+([\d ]+?)\s*(?:\(\+?(-?\d+)\))?\s*чел/i);
    if (m && gz === null) gz = toNum(m[1]);
  });

  // КВЦ
  let kvc = null;
  const kl = L.find(l => /за неделю\)/i.test(l));
  if (kl) {
    const m = kl.match(/^([\d ]+?)\s*\(/);
    if (m) kvc = toNum(m[1]);
  }

  // направления госзадания и программы КВЦ
  const iKvc = L.findIndex(l => /^КВЦ$/i.test(l));
  const dirSeg = iTotal !== -1 && iKvc !== -1 ? L.slice(iTotal + 1, iKvc) : [];
  const directions = parseTriples(dirSeg);
  let kvcEnd = L.findIndex((l, i) => i > iKvc && /^(Разработка и переработка|Обучение сотрудников МФЦ)/i.test(l));
  if (kvcEnd === -1) kvcEnd = L.length;
  const kvcPrograms = iKvc !== -1 ? parseTriples(L.slice(iKvc + 1, kvcEnd)) : [];

  // планы по программам ОМСУ и разработке — как есть, для справки
  const planDone = L.filter(l => /^План\s+\d+\s*\/\s*Выполнено\s+\d+/i.test(l));

  if (total === null) warnings.push('Не найден общий итог');
  if (gz === null && total !== null && mfc !== null && omsu !== null) {
    gz = total - mfc - omsu;
    warnings.push('Госзадание не найдено на слайде: вычислено как итог − МФЦ − ОМСУ');
  }
  if (mfc === null && total !== null && gz !== null && omsu !== null) {
    mfc = total - gz - omsu;
    warnings.push('МФЦ не найден на слайде: вычислено как итог − госзадание − ОМСУ');
  }
  if (total !== null && gz !== null && mfc !== null && omsu !== null && gz + mfc + omsu !== total) {
    warnings.push(`Итог ${total} не равен сумме ${gz} + ${mfc} + ${omsu} = ${gz + mfc + omsu}`);
  }
  const kvcSum = kvcPrograms.reduce((a, p) => a + p.count, 0);
  if (kvc !== null && kvcPrograms.length && kvcSum !== kvc) warnings.push(`Сумма по программам КВЦ ${kvcSum} не равна ${kvc}`);

  return { total, gz, mfc, omsu, kvc, directions, kvcPrograms, planDone, warnings };
}

// ---------- папка ----------

function state() {
  const d = ps.state();
  if (!d.presentations) d.presentations = { files: {}, lastScanAt: null, log: [] };
  return d.presentations;
}

function presentationDir() {
  return process.env.PRESENTATION_DIR || ps.state().settings?.presentationDir || path.join(__dirname, 'Отчет презентация неделя');
}

function scanPresentations() {
  const s = state();
  const dir = presentationDir();
  const log = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(n => /\.pptx$/i.test(n) && !n.startsWith('~$'));
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
    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }
    const key = `${name}|${stat.size}|${Math.round(stat.mtimeMs)}`;
    present.add(key);
    const known = s.files[key];
    if (known && known.v === PARSER_VERSION) {
      if (known.status === 'error') { log.push({ file: name, status: 'error', message: known.error }); errors++; }
      continue;
    }
    try {
      const parsed = parseDeck(fs.readFileSync(full));
      const date = dateFromFileName(name, stat.mtimeMs);
      if (!date) throw new Error('В имени файла нет даты (например, …_05_10_…)');
      s.files[key] = { key, v: PARSER_VERSION, fileName: name, mtime: stat.mtimeMs, status: 'ok', date, parsed, importedAt: new Date().toISOString() };
      added++;
      log.push({ file: name, status: 'ok', message: `Принят: ${ps.ruDate(date)}${parsed.warnings.length ? ' (есть замечания)' : ''}` });
    } catch (e) {
      s.files[key] = { key, v: PARSER_VERSION, fileName: name, mtime: stat.mtimeMs, status: 'error', error: e.message, importedAt: new Date().toISOString() };
      log.push({ file: name, status: 'error', message: e.message });
      errors++;
    }
  }
  Object.keys(s.files).forEach(k => { if (!present.has(k)) delete s.files[k]; });
  s.lastScanAt = new Date().toISOString();
  s.log = log;
  dataStore.saveData();
  return { dir, files: names.length, added, errors };
}

function setPresentationDir(dir) {
  const d = String(dir || '').trim();
  const s = ps.state();
  s.settings = s.settings || {};
  if (!d) {
    delete s.settings.presentationDir;
  } else {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error('Такой папки нет на сервере');
    s.settings.presentationDir = d;
  }
  dataStore.saveData();
}

// ---------- недельные выпуски ----------

function daysApart(isoA, isoB) {
  return Math.abs(ps.daysBetween(isoA, isoB));
}

// Одна неделя — один выпуск. Копии-шаблоны (имя с одной датой, а цифры — другой недели) отбрасываются:
// среди презентаций с одинаковыми цифрами остаётся та, у которой дата в имени ближе всего к дате изменения файла.
function weeklyReleases() {
  const files = Object.values(state().files).filter(f => f.status === 'ok');
  const mtimeDate = f => {
    const d = new Date(f.mtime);
    return ps.toIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  };
  const sig = f => [f.parsed.total, f.parsed.gz, f.parsed.mfc, f.parsed.omsu, f.parsed.kvc].join('/');

  const groups = {};
  files.forEach(f => { (groups[sig(f)] ||= []).push(f); });
  let kept = [];
  Object.values(groups).forEach(list => {
    list.sort((a, b) => daysApart(a.date, mtimeDate(a)) - daysApart(b.date, mtimeDate(b)) || b.mtime - a.mtime);
    kept.push(list[0]);
  });

  // одна дата — самый поздний файл
  const byDate = {};
  kept.sort((a, b) => a.mtime - b.mtime).forEach(f => { byDate[f.date] = f; });
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

function getReleases() {
  return weeklyReleases().map(f => ({
    date: f.date, fileName: f.fileName, ...f.parsed
  }));
}

// срезы дашборда по презентациям: все показатели
dataStore.registerVirtualSnapshotProvider('presentation', 1, () => weeklyReleases().map(f => {
  const p = f.parsed;
  const ind = {};
  const put = (key, v) => { if (v !== null && v !== undefined) ind[key] = { fact: v, override: null, src: 'презентация' }; };
  put('gz', p.gz); put('mfc', p.mfc); put('omsu', p.omsu); put('total', p.total); put('kvc', p.kvc);
  return {
    id: f.date,
    date: ps.ruDate(f.date),
    createdAt: `${f.date}T07:00:00.000Z`,
    isAutomatic: true,
    virtual: true,
    sources: ['презентация'],
    note: `Цифры из презентации планёрки (${f.fileName})`,
    indicators: ind
  };
}));

// структура на дату: направления госзадания и программы КВЦ из ближайшей презентации не позже даты
function getStructure(iso) {
  const rel = getReleases().filter(r => r.date <= iso).pop() || null;
  if (!rel) return { available: false };
  const prev = getReleases().filter(r => r.date < rel.date).pop() || null;
  const withDelta = (list, prevList) => list.map(item => {
    const before = prevList ? prevList.find(x => ps.normName(x.name) === ps.normName(item.name)) : null;
    return { ...item, delta: before ? item.count - before.count : null };
  });
  return {
    available: true,
    date: rel.date,
    previousDate: prev ? prev.date : null,
    directions: withDelta(rel.directions, prev && prev.directions),
    kvcPrograms: withDelta(rel.kvcPrograms, prev && prev.kvcPrograms),
    totals: { total: rel.total, gz: rel.gz, mfc: rel.mfc, omsu: rel.omsu, kvc: rel.kvc },
    planDone: rel.planDone
  };
}

function getInfo() {
  const s = state();
  return {
    dir: presentationDir(),
    lastScanAt: s.lastScanAt,
    log: s.log || [],
    files: Object.values(s.files).sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(f => ({
      fileName: f.fileName, status: f.status, error: f.error || null, date: f.date || null,
      warnings: f.parsed ? f.parsed.warnings : []
    })),
    releases: getReleases().map(r => ({ date: r.date, fileName: r.fileName, total: r.total, gz: r.gz, mfc: r.mfc, omsu: r.omsu, kvc: r.kvc, warnings: r.warnings }))
  };
}

module.exports = { parseDeck, scanPresentations, setPresentationDir, presentationDir, getReleases, getStructure, getInfo };
