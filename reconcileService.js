// Сверка данных: что совпадает между источниками (срезы дашборда, презентации планёрок, еженедельные статусы,
// план-график, таблица кураторов, анкеты), а что нет. Только числа, без имён: результат публичный.

const dataStore = require('./dataStore');
const ps = require('./programsService');
const pres = require('./presentationService');
const status = require('./statusService');

const KEY_NAMES = { gz: 'Госзадание', mfc: 'МФЦ МО', kvc: 'КВЦ', omsu: 'ОМСУ', total: 'Общий итог' };
const fmt = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));
const ruDate = iso => ps.ruDate(iso);

function effectiveFact(ind) {
  if (!ind) return null;
  return ind.override ? ind.override.value : ind.fact;
}

function buildChecks() {
  const checks = [];
  const add = (level, title, detail, extra = {}) => checks.push({ level, title, detail, ...extra });

  const stored = dataStore.getSnapshots();
  const latest = stored[stored.length - 1] || null;
  const releases = pres.getReleases();
  const statusWeeks = status.getTimeline();

  // 1. итог = ГЗ + МФЦ + ОМСУ на последнем срезе
  if (latest) {
    const g = effectiveFact(latest.indicators.gz);
    const m = effectiveFact(latest.indicators.mfc);
    const o = effectiveFact(latest.indicators.omsu);
    const t = effectiveFact(latest.indicators.total);
    if ([g, m, o, t].every(v => v !== null)) {
      const sum = g + m + o;
      add(sum === t ? 'ok' : 'error', `Итог на ${latest.date}`,
        sum === t ? `${fmt(t)} = госзадание ${fmt(g)} + МФЦ ${fmt(m)} + ОМСУ ${fmt(o)} (КВЦ в итог не входит)`
          : `Итог ${fmt(t)}, а сумма составляющих ${fmt(sum)} (разница ${fmt(t - sum)})`);
    }
  }

  // 2. срез дашборда и слайд на ту же дату
  if (latest) {
    const rel = releases.find(r => r.date === latest.id);
    if (rel) {
      const diffs = [];
      ['gz', 'mfc', 'omsu', 'total', 'kvc'].forEach(k => {
        const mine = effectiveFact(latest.indicators[k]);
        const slide = rel[k];
        if (mine !== null && slide !== null && mine !== slide) diffs.push({ k, mine, slide });
      });
      if (diffs.length === 0) {
        add('ok', `Дашборд и слайд планёрки на ${latest.date}`, 'Все показатели совпадают со слайдом.');
      } else {
        diffs.forEach(d => {
          let why = '';
          if (d.k === 'kvc') {
            const prevStatus = statusWeeks.filter(w => w.date <= latest.id && w.kvc === d.mine).pop();
            if (prevStatus && prevStatus.date < latest.id) {
              why = ` Значение ${fmt(d.mine)} в еженедельных статусах стоит на ${ruDate(prevStatus.date)}, слайд — на ${ruDate(latest.id)}: ` +
                `разница ${fmt(d.slide - d.mine)} — вероятнее всего рост за ${ps.daysBetween(prevStatus.date, latest.id)} дн., а не ошибка. Нужно решить, какое число считать верным на ${ruDate(latest.id)}.`;
            }
          }
          add('warn', `${KEY_NAMES[d.k]}: дашборд и слайд расходятся`, `Дашборд ${fmt(d.mine)}, слайд ${fmt(d.slide)}.${why}`);
        });
      }
    }
  }

  // 3. внутренняя согласованность самих презентаций
  const badDecks = releases.filter(r => r.warnings.length);
  if (releases.length) {
    if (badDecks.length === 0) {
      add('ok', 'Презентации планёрок', `${releases.length} выпусков (${ruDate(releases[0].date)} — ${ruDate(releases[releases.length - 1].date)}): итоги и суммы по программам КВЦ сходятся.`);
    } else {
      badDecks.forEach(r => add('warn', `Презентация ${ruDate(r.date)}: цифры внутри слайда не сходятся`, r.warnings.join('; ')));
    }
  }

  // 4. цепочка КВЦ: слайды и статусы должны давать одну возрастающую линию
  if (releases.length && statusWeeks.length) {
    const points = [
      ...releases.filter(r => r.kvc !== null).map(r => ({ date: r.date, v: r.kvc, src: 'слайд' })),
      ...statusWeeks.filter(w => w.kvc !== null).map(w => ({ date: w.date, v: w.kvc, src: 'статус' }))
    ].sort((a, b) => a.date.localeCompare(b.date));
    const drops = [];
    for (let i = 1; i < points.length; i++) {
      if (points[i].v < points[i - 1].v) drops.push(`${ruDate(points[i - 1].date)} (${points[i - 1].src}) ${fmt(points[i - 1].v)} → ${ruDate(points[i].date)} (${points[i].src}) ${fmt(points[i].v)}`);
    }
    add(drops.length ? 'warn' : 'ok', 'КВЦ: слайды и статусы в одной линии',
      drops.length ? `Накопленный итог не должен убывать: ${drops.join('; ')}.`
        : `${points.length} точек с ${ruDate(points[0].date)} по ${ruDate(points[points.length - 1].date)} растут без провалов (${fmt(points[0].v)} → ${fmt(points[points.length - 1].v)}).`);
  }

  // 5. направления госзадания и итог
  const lastRel = releases[releases.length - 1];
  if (lastRel) {
    const dirSum = lastRel.directions.reduce((a, d) => a + d.count, 0);
    const base = (lastRel.gz || 0) + (lastRel.mfc || 0);
    if (lastRel.directions.length) {
      const notIn = lastRel.total - dirSum;
      add('info', `Таблица направлений на слайде ${ruDate(lastRel.date)}`,
        `Сумма по 9 направлениям ${fmt(dirSum)}, итог ${fmt(lastRel.total)}: не вошло ${fmt(notIn)} = ОМСУ ${fmt(lastRel.omsu)} + ${fmt(notIn - lastRel.omsu)} без распределения по направлениям (ГЗ + МФЦ = ${fmt(base)}, в направлениях ${fmt(dirSum)}).`);
    }
    const mfcDirs = lastRel.directions.filter(d => /МФЦ|Контакт-центр/i.test(d.name));
    if (mfcDirs.length) {
      const s = mfcDirs.reduce((a, d) => a + d.count, 0);
      add(s === lastRel.mfc ? 'ok' : 'warn', 'МФЦ: направления и общий показатель',
        `Три направления МФЦ дают ${fmt(s)}, показатель МФЦ ${fmt(lastRel.mfc)}${s === lastRel.mfc ? ' — совпадает' : ` (разница ${fmt(lastRel.mfc - s)})`}.`);
    }
  }

  // 6. ОМСУ неизменно
  if (releases.length > 2) {
    const vals = [...new Set(releases.map(r => r.omsu))];
    if (vals.length === 1) {
      add('info', 'ОМСУ и подведы', `Значение ${fmt(vals[0])} не менялось во всех ${releases.length} презентациях с ${ruDate(releases[0].date)}. Проверьте, обновляется ли лист «хозрасчёт».`);
    }
  }

  // 7. активные ручные правки
  const overrides = [];
  stored.forEach(s => Object.entries(s.indicators).forEach(([k, ind]) => {
    if (ind.override) overrides.push(`${s.date} · ${KEY_NAMES[k]}: ${fmt(ind.fact)} → ${fmt(ind.override.value)}`);
  }));
  add(overrides.length ? 'info' : 'ok', 'Ручные правки', overrides.length ? `Действуют: ${overrides.join('; ')}.` : 'Ручных правок нет, все значения как в источниках.');

  // 8. история срезов
  const all = dataStore.getAllSnapshots();
  const virtual = all.filter(s => s.virtual);
  const carriedCount = virtual.reduce((a, sn) => a + Object.values(sn.indicators).filter(i => i.carried).length, 0);
  add('info', 'История срезов', `${all.length} дат: ${stored.length} сохранённых и ${virtual.length} из презентаций и статусов. Если в статусах на дату показателя нет, показывается последняя презентация планёрки не позже этой даты (таких значений ${carriedCount}); раньше первой презентации остаётся «нет данных».`);

  // 9. план-график и таблица кураторов
  const sched = ps.getSchedule();
  if (sched.loaded) {
    const rows = ps.state().curation.rows || [];
    const noCur = rows.filter(r => r.start && !r.cancelled && r.kind !== 'open' && (!r.curators || r.curators.length === 0)).length;
    const unmatchedRows = rows.filter(r => r.start && r.kind !== 'open' && !r.cancelled && !ps.programForCurationRow(r)).length;
    if (rows.length) {
      add(noCur ? 'warn' : 'ok', 'Таблица кураторов: кураторы указаны', noCur ? `У ${noCur} групп куратор не указан — они не попадают в нагрузку.` : 'У всех групп указан куратор.');
      add(unmatchedRows ? 'info' : 'ok', 'Таблица кураторов и план-график', unmatchedRows ? `${unmatchedRows} строк таблицы не нашлись в план-графике (семинары, тренинги и мероприятия вне плана).` : 'Все строки таблицы есть в план-графике.');
    }
    const fundUnset = sched.fundingSummary.none ? sched.fundingSummary.none.groups : 0;
    add(fundUnset ? 'info' : 'ok', 'План-график: источник финансирования', fundUnset ? `У ${fundUnset} из ${sched.summary.groups} групп источник финансирования не задан (подставляется из статусов, где есть).` : 'У всех групп задан источник финансирования.');
    const noFb = sched.summary.no_feedback;
    if (sched.feedbackSource && sched.feedbackSource.empty) {
      add('warn', 'Анкеты обратной связи', `Источник анкет пуст — проверьте путь: ${sched.feedbackSource.dir}${sched.feedbackSource.exists ? '' : ' (папка не найдена)'}.`);
    } else add(noFb ? 'warn' : 'ok', 'Анкеты обратной связи', noFb ? `Анкеты не собраны по ${noFb} группам, завершившимся от 8 до 45 дней назад.` : 'По завершившимся группам анкеты собраны.');
  }

  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return checks;
}

function getReconcile() {
  const checks = buildChecks();
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      error: checks.filter(c => c.level === 'error').length,
      warn: checks.filter(c => c.level === 'warn').length,
      info: checks.filter(c => c.level === 'info').length,
      ok: checks.filter(c => c.level === 'ok').length
    },
    checks
  };
}

module.exports = { getReconcile };
