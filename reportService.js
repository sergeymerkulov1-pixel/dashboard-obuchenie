// Готовые тексты для ИИ-помощника, которые нужно собрать по данным дашборда, а не «досочинять»:
// сообщение руководителю о том, какие программы идут сейчас и сколько на них людей.
// Цифры берутся только из план-графика, еженедельных статусов и таблицы кураторов (programsService.getSchedule).

const programsService = require('./programsService');

const KIND_SHORT = { pk: 'ПК', seminar: 'семинар', training: 'тренинг', distant: 'дист.' };

// Запрос вида «срочно ответить руководителю / напиши смс … какие программы идут и сколько людей»
function isRunningReportRequest(message) {
  const q = String(message || '').toLowerCase().replace(/ё/g, 'е');
  const about = /(какие|что за)\s+программ\S*\s+(сейчас\s+|в данный момент\s+|на данный момент\s+)?(идут|идет|проходят|проходит|реализуют)|программ\S*\s+(сейчас\s+)?(идут|проходят)|сколько\s+(людей|слушател\S*|человек)\s+(на них|обуча)/.test(q);
  const message_ = /(смс|sms|сообщени|ответ\S*\s+руководител|напиши\s+руководител|написать\s+руководител|руководител\S*\s+(срочно|напиши|ответ)|статус\S*\s+руководител)/.test(q);
  const status = /(статус|программ|идут|идет|слушател|людей|человек)/.test(q);
  // «сколько сейчас человек учится на дистанте / очно», «сколько слушателей обучается сейчас»
  const howMany = /сколько/.test(q) && /(человек|людей|слушател|учится|учатся|учит|обучается|обучаются|обучающ)/.test(q)
    && /(сейчас|в данный момент|на данный момент|в настоящее время|учится|учатся|обучается|обучаются|идут|в процессе|дист|очн|онлайн)/.test(q);
  return about || howMany || (message_ && status);
}

// Формат из вопроса: «на дистанте» → distant, «очно» → inperson, иначе все
function modeFromMessage(message) {
  const q = String(message || '').toLowerCase().replace(/ё/g, 'е');
  const distant = /(дистан|дист|онлайн|удален)/.test(q);
  const inperson = /(очн|в аудитор|вживую)/.test(q);
  if (distant && !inperson) return 'distant';
  if (inperson && !distant) return 'inperson';
  return null;
}

function ruDate(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function shortName(name, max = 48) {
  // отрезаем пояснения в скобках: «(электронный курс)», «(Установочная сессия …)»
  const clean = String(name || '').replace(/\s*\([^)]*\)?\s*$/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

// Сколько человек в группе: заявлено по еженедельным статусам → заявки из таблицы кураторов → план программы
function peopleOf(g) {
  if (g.progress && g.progress.latest && g.progress.latest.requested != null) {
    return { n: g.progress.latest.requested, src: 'status' };
  }
  if (g.applications != null) return { n: g.applications, src: 'table' };
  if (g.planned != null) return { n: g.planned, src: 'plan' };
  return { n: null, src: null };
}

function collectRunning(asOfIso) {
  const sched = programsService.getSchedule(asOfIso);
  if (!sched.loaded) return { loaded: false, asOf: asOfIso, rows: [] };
  const rows = [];
  sched.programs.forEach(p => p.groups.forEach(g => {
    if (g.status !== 'running') return;
    const ppl = peopleOf(g);
    rows.push({
      name: p.name,
      kind: p.kind,
      mode: g.mode,
      start: g.start,
      end: g.end,
      people: ppl.n,
      src: ppl.src
    });
  }));
  rows.sort((a, b) => (b.people ?? -1) - (a.people ?? -1) || a.end.localeCompare(b.end));
  return { loaded: true, asOf: sched.asOf, rows };
}

function rowLabel(r) {
  const tag = r.kind === 'pk' ? 'ПК' : (KIND_SHORT[r.kind] || '');
  const mode = r.mode === 'distant' ? 'дист.' : 'очно';
  const extra = r.kind === 'distant' ? mode : `${tag === 'ПК' ? 'ПК, ' : tag + ', '}${mode}`;
  return `${shortName(r.name)} (${extra})`;
}

const MODE_TITLE = { distant: 'на дистанционном обучении', inperson: 'на очном обучении' };

function buildRunningReport(asOfIso, { brief = false, mode = null, forManager = false } = {}) {
  const data = collectRunning(asOfIso || programsService.todayIso());
  if (mode) data.rows = data.rows.filter(r => r.mode === mode);
  if (!data.loaded) {
    return { reply: 'В дашборде не загружен план-график, поэтому я не могу сказать, какие программы идут сейчас. Загрузите план-график (блок «План-график программ») и повторите запрос.' };
  }
  const { rows } = data;
  const date = ruDate(data.asOf);
  if (!rows.length) {
    const text = `Статус на ${date}: сейчас обучающих групп${mode ? ' ' + MODE_TITLE[mode] : ''} нет.`;
    return { reply: `${text}\n\nПо план-графику на ${date} нет групп со статусом «идёт».`, copyText: text };
  }

  const known = rows.filter(r => r.people != null);
  const total = known.reduce((s, r) => s + r.people, 0);
  const unknown = rows.length - known.length;
  const groupsWord = plural(rows.length, 'группа', 'группы', 'групп');
  const peopleWord = plural(total, 'слушатель', 'слушателя', 'слушателей');

  const where = mode ? ` ${MODE_TITLE[mode]}` : '';
  let head = `Статус на ${date}: сейчас${where} идут ${rows.length} ${groupsWord}, всего ${total} ${peopleWord}`;
  if (unknown) head += ` (по ${unknown} ${plural(unknown, 'группе', 'группам', 'группам')} данных о количестве нет)`;
  head += '.';

  const list = rows.map((r, i) => `${i + 1}. ${rowLabel(r)} — ${r.people != null ? r.people : 'н/д'}`).join('\n');
  const text = brief ? head : `${head}\n${list}`;

  const fromStatus = rows.some(r => r.src === 'status');
  const fromTable = rows.some(r => r.src === 'table');
  const fromPlan = rows.some(r => r.src === 'plan');
  const sources = [
    fromStatus && 'заявлено по еженедельным статусам',
    fromTable && 'заявки из таблицы кураторов',
    fromPlan && 'план набора из план-графика'
  ].filter(Boolean).join('; ');

  const reply = [
    forManager
      ? `Готово, текст для руководителя${brief ? ' (коротко)' : ''}:`
      : `Вот актуальные данные${brief ? ' (коротко)' : ''}. Текст можно скопировать и отправить:`,
    '',
    text,
    '',
    `**Откуда цифры:** план-график на ${date}, число людей — ${sources || 'нет данных'}. Это заявленное число слушателей, а не фактическая явка.`,
    brief ? '' : 'Нужен короче, одной строкой? Напишите «сделай коротко».'
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');

  return { reply, copyText: text };
}

// Возвращает { reply, copyText } для запросов, которые закрываются данными дашборда, иначе null.
// «Сделай коротко» сразу после такого отчёта тоже считается запросом отчёта.
function tryHandle(message, history = []) {
  const q = String(message || '').toLowerCase();
  const wantsBrief = /(коротко|короче|кратко|одной строк|в одну строк)/.test(q);
  const mode = modeFromMessage(message);
  const lastBot = [...history].reverse().find(m => m && m.sender !== 'user');
  const followUp = wantsBrief && lastBot && /^(Готово, текст для руководителя|Вот актуальные данные)/.test(String(lastBot.text || ''));
  if (!followUp && !isRunningReportRequest(message)) return null;
  const forManager = /(смс|sms|сообщени|руководител|начальник|написать\s+письмо)/.test(q)
    || Boolean(followUp && /^Готово, текст для руководителя/.test(String(lastBot.text || '')));
  return { ...buildRunningReport(programsService.todayIso(), { brief: wantsBrief, mode, forManager }), source: 'report' };
}

module.exports = { tryHandle, isRunningReportRequest, buildRunningReport, collectRunning };
