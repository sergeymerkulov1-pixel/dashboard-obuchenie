// Сбор данных из всех источников (анкеты, статусы, презентации, таблица кураторов).
// Запускается по расписанию (09:00, 12:00, 18:00 МСК), при старте сервера и по кнопке «Обновить сейчас».
// Результат каждого запуска хранится в data.json (последние 30), на нём строится «Статус дашборда».

const dataStore = require('./dataStore');
const programsService = require('./programsService');
const statusService = require('./statusService');
const presentationService = require('./presentationService');
const curatorsService = require('./curatorsService');

const COLLECT_HOURS = [9, 12, 18];
const COLLECT_CRON = '0 9,12,18 * * *';
const SNAPSHOT_CRON = '5 16 * * 2'; // вторник, 16:05 МСК
const SNAPSHOT_HOUR = 16;
const SNAPSHOT_MINUTE = 5;
const MSK_OFFSET_MS = 3 * 3600 * 1000; // в России нет перехода на летнее время
const KEEP_RUNS = 30;

let running = null;

function state() {
  const d = dataStore.data;
  if (!d.collection) d.collection = { runs: [] };
  return d.collection;
}

// «московские» часы: Date, у которого UTC-поля равны московскому времени
function mskNow(now = new Date()) {
  return new Date(now.getTime() + MSK_OFFSET_MS);
}
function fromMsk(y, m, d, h, min) {
  return new Date(Date.UTC(y, m, d, h, min) - MSK_OFFSET_MS);
}

function nextCollectAt(now = new Date()) {
  const m = mskNow(now);
  for (let add = 0; add < 3; add++) {
    for (const h of COLLECT_HOURS) {
      const t = fromMsk(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + add, h, 0);
      if (t > now) return t;
    }
  }
  return null;
}

function nextSnapshotAt(now = new Date()) {
  const m = mskNow(now);
  for (let add = 0; add < 8; add++) {
    const day = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + add));
    if (day.getUTCDay() !== 2) continue;
    const t = fromMsk(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), SNAPSHOT_HOUR, SNAPSHOT_MINUTE);
    if (t > now) return t;
  }
  return null;
}

function mskDateStr(now = new Date()) {
  return mskNow(now).toISOString().slice(0, 10);
}

async function step(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const text = await fn();
    return { name, ok: true, text: text || '', at: startedAt };
  } catch (e) {
    return { name, ok: false, error: e.message || String(e), at: startedAt };
  }
}

async function collectAll(reason = 'вручную') {
  if (running) return running; // параллельный запуск не нужен: отдаём уже идущий
  running = (async () => {
    const startedAt = new Date().toISOString();
    const steps = [];
    steps.push(await step('feedback', () => {
      const r = programsService.scanFeedbackFolder();
      return `файлов ${r.files}, новых ${r.added}, ошибок ${r.errors}`;
    }));
    steps.push(await step('statuses', () => {
      const r = statusService.scanStatusFolder();
      return `файлов ${r.files}, новых ${r.added}, ошибок ${r.errors}`;
    }));
    steps.push(await step('presentations', () => {
      const r = presentationService.scanPresentations();
      return `файлов ${r.files}, новых ${r.added}, ошибок ${r.errors}`;
    }));
    if (curatorsService.getSourceUrl()) {
      steps.push(await step('curators', async () => {
        const r = await curatorsService.refreshFromGoogle();
        return `строк ${r.rows}`;
      }));
    } else {
      steps.push({ name: 'curators', ok: true, skipped: true, text: 'ссылка на таблицу не задана', at: new Date().toISOString() });
    }
    const run = { reason, startedAt, finishedAt: new Date().toISOString(), steps };
    const s = state();
    s.runs.push(run);
    if (s.runs.length > KEEP_RUNS) s.runs.splice(0, s.runs.length - KEEP_RUNS);
    dataStore.saveData();
    const failed = steps.filter(x => !x.ok).map(x => x.name).join(', ');
    console.log(`[сбор данных] ${reason}: ${failed ? 'ошибки: ' + failed : 'успешно'}`);
    return run;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

function lastRun() {
  const runs = state().runs;
  return runs.length ? runs[runs.length - 1] : null;
}

function isRunning() {
  return !!running;
}

module.exports = {
  COLLECT_CRON, SNAPSHOT_CRON, COLLECT_HOURS,
  collectAll, lastRun, isRunning, state,
  nextCollectAt, nextSnapshotAt, mskDateStr, mskNow
};
