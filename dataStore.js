const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const ENV_FILE = path.join(__dirname, '.env');

// Пароль администратора хранится только как хеш scrypt: «scrypt$<соль hex>$<хеш hex>»
const SCRYPT_KEYLEN = 64;
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function isPasswordHash(v) {
  return typeof v === 'string' && /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(v);
}
function verifyPassword(password, stored) {
  if (!isPasswordHash(stored) || typeof password !== 'string') return false;
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const INITIAL_INDICATOR_CONFIG = {
  gz: {
    key: 'gz',
    title: 'Государственное задание',
    shortTitle: 'Госзадание',
    plan: 3660,
    unit: 'чел.',
    defaultSource: 'лист «факт гз 2026»: 1 582 + 411',
    category: 'Основной план'
  },
  mfc: {
    key: 'mfc',
    title: 'МФЦ МО',
    shortTitle: 'МФЦ МО',
    plan: 702,
    unit: 'чел.',
    defaultSource: 'слайд от 05.10 (в перспективе таблица МФЦ)',
    category: 'Основной план'
  },
  kvc: {
    key: 'kvc',
    title: 'КВЦ (открытые курсы)',
    shortTitle: 'КВЦ',
    plan: 3000,
    unit: 'чел.',
    defaultSource: 'лист «открытые курсы» (на слайде 1 609)',
    category: 'Открытые курсы'
  },
  omsu: {
    key: 'omsu',
    title: 'ОМСУ и подведы (платное)',
    shortTitle: 'ОМСУ и подведы',
    plan: null,
    unit: 'чел.',
    defaultSource: 'лист «хозрасчет»',
    category: 'Платное'
  },
  total: {
    key: 'total',
    title: 'Общий итог',
    shortTitle: 'Общий итог',
    plan: null,
    unit: 'чел.',
    defaultSource: 'Госзадание (1 993) + МФЦ (273) + ОМСУ (276), КВЦ не входит',
    category: 'Сводный'
  }
};

const DEFAULT_DATA = {
  snapshots: [
    {
      id: '2026-10-05',
      date: '05.10.2026',
      createdAt: '2026-10-05T07:00:00.000Z',
      isAutomatic: true,
      note: 'Срез недели от 05 октября 2026 (базовый срез PRD)',
      indicators: {
        gz: { fact: 1993, plan: 3660, override: null },
        mfc: { fact: 273, plan: 702, override: null },
        kvc: { fact: 1599, plan: 3000, override: null },
        omsu: { fact: 276, plan: null, override: null },
        total: { fact: 2542, plan: null, override: null }
      }
    }
  ],
  auditLog: [
    {
      id: 'log-init-1',
      timestamp: '2026-10-05T07:00:00.000Z',
      author: 'Система',
      action: 'init',
      snapshotDate: '05.10.2026',
      indicatorKey: 'all',
      indicatorTitle: 'Все показатели',
      oldValue: null,
      newValue: '2542 чел.',
      note: 'Инициализация базового среза на 05.10.2026 согласно PRD v1'
    }
  ],
  settings: {
    adminUser: 'admin',
    adminPassHash: null, // задаётся при первом запуске из ADMIN_PASSWORD (по умолчанию admin2026) и хранится как хеш
    autoSnapshotSchedule: '0 7 * * 3',
    autoSnapshotDescription: 'По средам в 07:00 МСК'
  }
};

function parseDateInfo(dateStr) {
  let year = 2026, month = 10, day = 5;
  if (!dateStr) return { year, month, day };
  if (dateStr.includes('.')) {
    const parts = dateStr.split('.').map(Number);
    day = parts[0] || 5;
    month = parts[1] || 10;
    year = parts[2] || 2026;
  } else if (dateStr.includes('-')) {
    const parts = dateStr.split('-').map(Number);
    year = parts[0] || 2026;
    month = parts[1] || 10;
    day = parts[2] || 5;
  }
  return { year, month, day };
}

function getYearProgressMetrics(dateStr) {
  const { year, month, day } = parseDateInfo(dateStr);
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  const totalDaysInYear = isLeap ? 366 : 365;

  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const currentDate = new Date(Date.UTC(year, month - 1, day));
  const endOfYear = new Date(Date.UTC(year, 11, 31));

  const passedDays = Math.max(1, Math.floor((currentDate - startOfYear) / (24 * 3600 * 1000)) + 1);
  const remainingDays = Math.max(0, Math.floor((endOfYear - currentDate) / (24 * 3600 * 1000)));
  const remainingWeeks = Math.max(0.5, remainingDays / 7);

  const expectedPercent = Math.min(100, Math.max(0, Math.round((passedDays / totalDaysInYear) * 100)));

  return {
    year,
    passedDays,
    totalDaysInYear,
    remainingDays,
    remainingWeeks,
    expectedPercent
  };
}

class DataStore {
  constructor() {
    this.data = this.loadData();
    this.virtualProviders = [];
    this.migrateSecrets();
    this.migrateUsers();
    // миграция условных срезов отключена: история срезов нужна в «Динамике»
    // this.migrateSeedSnapshots();
  }

  // Пароль — только хеш; ключ GigaChat — только из окружения (GIGACHAT_CREDENTIALS).
  // Если ключ раньше лежал в data.json, он переносится в .env рядом с сервером и удаляется из data.json.
  migrateSecrets() {
    const st = (this.data.settings ||= {});
    let changed = false;
    // ADMIN_PASSWORD в окружении задаёт (или меняет) пароль: при расхождении хеш пересчитывается
    const envPass = process.env.ADMIN_PASSWORD;
    if (!isPasswordHash(st.adminPassHash)) {
      st.adminPassHash = hashPassword(envPass || st.adminPassHash || 'admin2026');
      changed = true;
    } else if (envPass && !verifyPassword(envPass, st.adminPassHash)) {
      st.adminPassHash = hashPassword(envPass);
      changed = true;
    }
    if (st.gigachatKey !== undefined) {
      const key = String(st.gigachatKey || '').trim();
      let moved = true;
      if (key) {
        try {
          const envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
          if (!/^\s*GIGACHAT_CREDENTIALS\s*=/m.test(envText)) {
            const sep = envText && !envText.endsWith('\n') ? '\n' : '';
            fs.writeFileSync(ENV_FILE, `${envText}${sep}GIGACHAT_CREDENTIALS=${key}\n`, 'utf-8');
          }
          if (!process.env.GIGACHAT_CREDENTIALS) process.env.GIGACHAT_CREDENTIALS = key;
        } catch (err) {
          console.error('Не удалось перенести ключ GigaChat в .env — ключ оставлен в data.json:', err);
          moved = false;
        }
      }
      if (moved) {
        delete st.gigachatKey;
        changed = true;
      }
    }
    if (changed) this.saveData();
  }

  loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('Ошибка чтения data.json, используется начальное состояние:', err);
    }
    const clone = JSON.parse(JSON.stringify(DEFAULT_DATA));
    this.saveData(clone);
    return clone;
  }

  saveData(customData = null) {
    const toSave = customData || this.data;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
    } catch (err) {
      console.error('Ошибка сохранения data.json:', err);
    }
  }

  getSnapshots() {
    // Сортировка по id / дате (возрастание)
    return [...this.data.snapshots].sort((a, b) => a.id.localeCompare(b.id));
  }

  getSnapshot(id) {
    return this.data.snapshots.find(s => s.id === id) || null;
  }

  // Срезы, которых нет в базе, но по которым есть данные в еженедельных статусах (сейчас — только КВЦ).
  // Они строятся на лету, не записываются и не редактируются; только раньше последнего сохранённого среза.
  // Источники: презентации планёрок (priority 1) и недельные статусы (priority 2, при совпадении даты их КВЦ важнее).
  registerVirtualSnapshotProvider(name, priority, fn) {
    this.virtualProviders = (this.virtualProviders || []).filter(p => p.name !== name);
    this.virtualProviders.push({ name, priority, fn });
  }

  getProviderSnapshots(name) {
    const p = (this.virtualProviders || []).find(x => x.name === name);
    if (!p) return [];
    try {
      return p.fn();
    } catch (err) {
      console.error(`Не удалось получить срезы источника «${name}»:`, err);
      return [];
    }
  }

  getAllSnapshots() {
    const stored = this.getSnapshots();
    const providers = [...(this.virtualProviders || [])].sort((a, b) => a.priority - b.priority);
    if (providers.length === 0 || stored.length === 0) return stored;
    const lastId = stored[stored.length - 1].id;
    const have = new Set(stored.map(s => s.id));
    const merged = {};
    providers.forEach(p => {
      this.getProviderSnapshots(p.name).forEach(v => {
        if (have.has(v.id) || v.id >= lastId) return;
        const m = (merged[v.id] ||= { ...v, indicators: {}, sources: [] });
        Object.assign(m.indicators, v.indicators);
        (v.sources || []).forEach(x => { if (!m.sources.includes(x)) m.sources.push(x); });
        m.note = m.sources.length > 1 ? `Цифры из источников: ${m.sources.join(', ')}` : v.note;
      });
    });
    const all = [...stored, ...Object.values(merged)].sort((a, b) => a.id.localeCompare(b.id));

    // Если на дату в источнике (например, в статусах) показателя нет, показывается последнее известное значение:
    // обычно цифра из презентации планёрки (помечается carried, carriedSrc). До первой известной цифры переносить нечего.
    const last = {};
    all.forEach(sn => {
      if (sn.virtual) {
        Object.keys(INITIAL_INDICATOR_CONFIG).forEach(key => {
          if (!sn.indicators[key] && last[key]) {
            sn.indicators[key] = { fact: last[key].fact, override: null, carried: true, carriedFrom: last[key].date, carriedFromId: last[key].id, carriedSrc: last[key].src };
          }
        });
      }
      Object.entries(sn.indicators).forEach(([key, ind]) => {
        if (!ind.carried) last[key] = { fact: ind.override ? ind.override.value : ind.fact, date: sn.date, id: sn.id, src: ind.src || 'срез' };
      });
    });
    return all;
  }

  // Значение показателя из внешнего источника на ту же дату (для сверки со слайдом)
  getExternalFact(name, id, key) {
    const v = this.getProviderSnapshots(name).find(x => x.id === id);
    return v && v.indicators[key] ? v.indicators[key].fact : null;
  }

  // Срезы 24.09 и 01.10 были заведены как условные (в PRD: «полностью известна только неделя 05.10»).
  // Их значения не совпадали с презентациями планёрок, поэтому они удаляются; резервная копия сохраняется.
  migrateSeedSnapshots() {
    const seedIds = ['2026-09-24', '2026-10-01'];
    const seeds = this.data.snapshots.filter(s => seedIds.includes(s.id)
      && /^Срез недели от/.test(s.note || '')
      && Object.values(s.indicators || {}).every(i => !i.override));
    if (seeds.length === 0) return;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(DATA_FILE, DATA_FILE.replace(/\.json$/, '') + `.backup-${stamp}.json`);
    } catch (err) {
      console.error('Не удалось сделать резервную копию перед миграцией срезов:', err);
      return;
    }
    this.data.snapshots = this.data.snapshots.filter(s => !seeds.includes(s));
    this.data.auditLog.unshift({
      id: 'log-migrate-' + Date.now(),
      timestamp: new Date().toISOString(),
      author: 'Система',
      action: 'migrate',
      snapshotDate: seeds.map(x => x.date).join(', '),
      snapshotId: 'global',
      indicatorKey: 'all',
      indicatorTitle: 'Условные срезы',
      oldValue: seeds.map(x => `${x.date}: ГЗ ${x.indicators.gz?.fact}, МФЦ ${x.indicators.mfc?.fact}, ОМСУ ${x.indicators.omsu?.fact}, итог ${x.indicators.total?.fact}`).join('; '),
      newValue: 'история из презентаций планёрок и статусов',
      note: 'Условные срезы, заведённые для демонстрации, удалены: их цифры не совпадали с презентациями планёрок. Резервная копия data.json сохранена рядом.'
    });
    this.saveData();
    console.log(`Удалены условные срезы: ${seeds.map(x => x.date).join(', ')} (резервная копия сохранена)`);
  }

  getLatestSnapshot() {
    const sorted = this.getSnapshots();
    return sorted[sorted.length - 1] || null;
  }

  computeSnapshotDetails(snapshotId = null) {
    const snapshots = this.getAllSnapshots();
    if (snapshots.length === 0) return null;

    let targetIdx = snapshots.length - 1;
    if (snapshotId) {
      const idx = snapshots.findIndex(s => s.id === snapshotId);
      if (idx !== -1) targetIdx = idx;
    }

    const current = snapshots[targetIdx];
    const DAY_MS = 24 * 3600 * 1000;
    const currentDateObj = new Date(current.createdAt || current.id);
    // Опорная дата значения: срез может нести цифру, наблюдённую раньше (перенос с прошлой даты,
    // КВЦ из статусов более ранней недели). Прирост и темп считаются от даты наблюдения.
    const refFor = obsId => (obsId && obsId < current.id)
      ? { id: obsId, date: new Date(`${obsId}T07:00:00.000Z`) }
      : { id: current.id, date: currentDateObj };
    // для каждого показателя — ближайший предыдущий срез, где он известен и который не ближе 5 дней
    // (иначе разница за день-два даёт неправдоподобный недельный темп); если такого нет — просто ближайший
    const prevFor = (key, ref = refFor(null)) => {
      let nearest = null;
      for (let i = targetIdx - 1; i >= 0; i--) {
        const sn = snapshots[i];
        if (sn.id >= ref.id) continue;
        if (!sn.indicators[key] || sn.indicators[key].carried) continue;
        if (!nearest) nearest = sn;
        const gap = (ref.date - new Date(sn.createdAt || sn.id)) / DAY_MS;
        if (gap >= 4.5) return sn;
      }
      return nearest;
    };
    // КВЦ в сохранённом срезе часто берётся из последних статусов: если цифра совпадает
    // со статусами более ранней даты, наблюдение относится к той дате
    const statusSnaps = this.getProviderSnapshots('status');
    const observedIdFor = (key, raw) => {
      if (raw.observedAt) return raw.observedAt;
      if (raw.carried) return raw.carriedFromId || null;
      if (current.virtual || key !== 'kvc' || (raw.override !== null && raw.override !== undefined)) return null;
      const st = statusSnaps
        .filter(v => v.id < current.id && v.indicators.kvc)
        .sort((a, b) => b.id.localeCompare(a.id))[0];
      return st && st.indicators.kvc.fact === raw.fact ? st.id : null;
    };
    const prev = targetIdx > 0 ? snapshots[targetIdx - 1] : null;
    const prevTotal = prevFor('total') || prev;

    // Метрики годового прогресса
    const yearMetrics = getYearProgressMetrics(current.date || current.id);
    const expectedPercent = yearMetrics.expectedPercent;
    const yearShare = yearMetrics.passedDays / yearMetrics.totalDaysInYear;
    const remainingWeeks = yearMetrics.remainingWeeks;

    // Скользящий темп за 4 недели (до 28 дней): база окна — самый ранний срез, где показатель известен
    // (срезы из статусов содержат только КВЦ)
    const windowFor = (key, ref = refFor(null)) => {
      let base = null;
      for (let i = targetIdx; i >= 0; i--) {
        const sn = snapshots[i];
        if (sn.id > ref.id) continue;
        const diffDays = Math.round((ref.date - new Date(sn.createdAt || sn.id)) / DAY_MS);
        if (diffDays > 28) break;
        if (sn.indicators[key] && !sn.indicators[key].carried) base = sn;
      }
      base = base || current;
      const days = Math.max(1, Math.round((ref.date - new Date(base.createdAt || base.id)) / DAY_MS));
      return { base, days };
    };
    const windowDays = windowFor(current.virtual ? 'kvc' : 'total').days;


    const cards = [];
    for (const [key, cfg] of Object.entries(INITIAL_INDICATOR_CONFIG)) {
      if (current.virtual && !current.indicators[key]) {
        // на эту дату показатель неизвестен: не нули, а «нет данных»
        const planNoData = cfg.plan ?? this.data.settings?.customPlans?.[key] ?? null;
        cards.push({
          key, title: cfg.title, shortTitle: cfg.shortTitle, category: cfg.category, plan: planNoData,
          fact: null, originalFact: null, unit: cfg.unit, percent: null, delta: null, deltaDays: null,
          lastPace: null, currentPace: null, requiredPace: null, forecast3112: null, forecastPercent: null,
          expectedPercent, expectedFact: null, lagPercent: null, status: 'none',
          source: 'нет данных на эту дату', sourceUpdatedAt: current.createdAt, isOutdated: false, discrepancy: null,
          comments: { reason: '', solution: '', assignee: '', deadline: '' },
          isOverridden: false, overrideInfo: null, noData: true
        });
        continue;
      }
      const currentRaw = current.indicators[key] || { fact: 0, plan: cfg.plan, override: null };
      const carried = Boolean(currentRaw.carried);
      const hasOverride = currentRaw.override !== null && currentRaw.override !== undefined;
      const effectiveFact = hasOverride ? currentRaw.override.value : currentRaw.fact;
      
      // Проверка кастомного ориентира (если админ установил)
      let effectivePlan = currentRaw.plan !== undefined ? currentRaw.plan : cfg.plan;
      if (effectivePlan === undefined && this.data.settings?.customPlans?.[key] !== undefined) {
        effectivePlan = this.data.settings.customPlans[key];
      }

      let percent = null;
      if (effectivePlan && effectivePlan > 0) {
        percent = Math.round((effectiveFact / effectivePlan) * 100);
      }

      // Дата наблюдения значения (если раньше даты среза — прирост и темп считаются от неё)
      const observedId = observedIdFor(key, currentRaw);
      const ref = refFor(observedId);
      const observedEarlier = ref.id !== current.id;
      const useDelta = !carried || observedEarlier;

      // Дельта с предыдущим срезом, где показатель известен
      let delta = null;
      const prevK = prevFor(key, ref);
      const deltaDays = prevK && useDelta
        ? Math.max(1, Math.round((ref.date - new Date(prevK.createdAt || prevK.id)) / DAY_MS))
        : null;
      if (prevK && useDelta) {
        const prevRaw = prevK.indicators[key];
        const prevEffective = (prevRaw.override !== null && prevRaw.override !== undefined)
          ? prevRaw.override.value
          : prevRaw.fact;
        delta = effectiveFact - prevEffective;
      }

      // Скользящий темп за 4 недели (чел./нед)
      const win = windowFor(key, ref);
      const baseRaw = win.base.indicators[key] || { fact: 0 };
      const baseEffective = baseRaw.override ? baseRaw.override.value : baseRaw.fact;
      const windowDelta = effectiveFact - baseEffective;
      const currentPace = win.days > 0 ? Math.round((windowDelta / win.days) * 7) : 0;

      // Темп последнего шага (приведенный к 7 дням)
      const lastPace = (delta !== null && deltaDays) ? Math.round((delta / deltaDays) * 7) : null;

      // Нужный темп до 31.12
      let requiredPace = null;
      if (effectivePlan && effectivePlan > 0) {
        if (effectivePlan > effectiveFact) {
          requiredPace = Math.max(0, Math.round((effectivePlan - effectiveFact) / remainingWeeks));
        } else {
          requiredPace = 0;
        }
      }

      // Прогноз на 31.12
      const forecast3112 = Math.round(effectiveFact + currentPace * remainingWeeks);
      let forecastPercent = null;
      if (effectivePlan && effectivePlan > 0) {
        forecastPercent = Math.round((forecast3112 / effectivePlan) * 100);
      }

      // Ожидаемый факт на текущую дату и статус выполнения
      let expectedFact = null;
      let lagPercent = null;
      let status = 'none'; // 'on_track' | 'warning' | 'critical' | 'none'

      if (effectivePlan && effectivePlan > 0 && percent !== null) {
        expectedFact = Math.round(effectivePlan * yearShare);
        lagPercent = expectedPercent - percent; // положительный = отставание
        if (percent >= expectedPercent) {
          status = 'on_track'; // зеленый
        } else if (lagPercent <= 10) {
          status = 'warning'; // желтый (отставание до 10 п.п.)
        } else {
          status = 'critical'; // красный (отставание более 10 п.п.)
        }
      }

      // Подпись источника: для срезов из презентаций и статусов — их собственный источник,
      // для сводного итога — составляющие именно этого среза
      let sourceText = cfg.defaultSource;
      if (current.virtual) {
        if (carried) {
          sourceText = currentRaw.carriedSrc === 'презентация'
            ? `презентация планёрки от ${String(currentRaw.carriedFrom).slice(0, 5)} (в статусах на эту дату показателя нет)`
            : `нет новых данных на эту дату: значение без изменений с ${currentRaw.carriedFrom}`;
        }
        else if (currentRaw.src === 'презентация') sourceText = `презентация планёрки от ${current.date.slice(0, 5)}`;
        else if (currentRaw.src === 'статусы') sourceText = `еженедельные статусы от ${current.date.slice(0, 5)}`;
      } else if (key === 'total') {
        const factOf = k => {
          const i = current.indicators[k];
          return i ? (i.override ? i.override.value : i.fact) : null;
        };
        const num = v => (v === null ? '—' : v.toLocaleString('ru-RU'));
        sourceText = `Госзадание (${num(factOf('gz'))}) + МФЦ (${num(factOf('mfc'))}) + ОМСУ (${num(factOf('omsu'))}), КВЦ не входит в общий итог`;
      }

      // Источник и дата обновления
      const sourceUpdatedAt = currentRaw.sourceUpdatedAt || current.createdAt || new Date().toISOString();
      const sourceDaysAgo = Math.round((new Date() - new Date(sourceUpdatedAt)) / (24 * 3600 * 1000));
      const isOutdated = !current.virtual && sourceDaysAgo > 7;

      // Расхождение со слайдом планёрки на ту же дату
      let discrepancy = null;
      const slideValue = this.getExternalFact('presentation', current.id, key);
      if (!carried && slideValue !== null && slideValue !== effectiveFact) {
        discrepancy = {
          message: `На слайде планёрки: ${slideValue.toLocaleString('ru-RU')} чел.; в дашборде: ${effectiveFact.toLocaleString('ru-RU')} чел. (разница ${Math.abs(slideValue - effectiveFact)})`,
          slideValue,
          tableValue: effectiveFact,
          diff: slideValue - effectiveFact
        };
      }

      // Комментарии по направлению к срезу
      const comments = currentRaw.comments || {
        reason: '',
        solution: '',
        assignee: '',
        deadline: ''
      };

      cards.push({
        key,
        title: cfg.title,
        shortTitle: cfg.shortTitle,
        category: cfg.category,
        plan: effectivePlan,
        fact: effectiveFact,
        originalFact: currentRaw.fact,
        unit: cfg.unit,
        percent,
        delta,
        deltaDays,
        lastPace,
        currentPace,
        requiredPace,
        forecast3112,
        forecastPercent,
        expectedPercent,
        expectedFact,
        lagPercent,
        status,
        source: sourceText,
        sourceUpdatedAt,
        isOutdated,
        discrepancy,
        comments,
        isOverridden: hasOverride,
        overrideInfo: hasOverride ? currentRaw.override : null,
        carried,
        carriedFrom: carried ? currentRaw.carriedFrom : null,
        carriedSrc: carried ? currentRaw.carriedSrc : null,
        observedAt: observedEarlier ? ref.id : null
      });
    }

    // Формирование блока "Требует внимания" (2-3 направления с наибольшим отставанием)
    const attentionList = cards
      .filter(c => c.plan && c.lagPercent !== null && c.lagPercent > 0)
      .sort((a, b) => b.lagPercent - a.lagPercent)
      .slice(0, 3)
      .map(c => ({
        key: c.key,
        title: c.title,
        shortTitle: c.shortTitle,
        fact: c.fact,
        plan: c.plan,
        percent: c.percent,
        expectedPercent: c.expectedPercent,
        lagPercent: c.lagPercent,
        shortage: Math.max(0, c.expectedFact - c.fact),
        requiredPace: c.requiredPace,
        currentPace: c.currentPace,
        forecast3112: c.forecast3112,
        forecastPercent: c.forecastPercent,
        comments: c.comments
      }));

    return {
      snapshot: {
        id: current.id,
        date: current.date,
        createdAt: current.createdAt,
        isAutomatic: current.isAutomatic,
        note: current.note,
        virtual: Boolean(current.virtual)
      },
      previousDate: prevTotal ? prevTotal.date : null,
      yearMetrics: {
        ...yearMetrics,
        windowDays
      },
      attentionList,
      cards,
      availableSnapshots: snapshots.map(s => ({
        id: s.id,
        date: s.date,
        isAutomatic: s.isAutomatic,
        virtual: Boolean(s.virtual),
        sources: s.sources || []
      }))
    };
  }

  getHistoryChartData() {
    const snapshots = this.getAllSnapshots();
    const labels = snapshots.map(s => s.date);
    const dates = snapshots.map(s => s.id);
    const latest = snapshots[snapshots.length - 1];
    const yearMetrics = latest ? getYearProgressMetrics(latest.date || latest.id) : { remainingWeeks: 12.4 };

    const datasets = {
      gz: { label: 'Госзадание', data: [] },
      mfc: { label: 'МФЦ МО', data: [] },
      kvc: { label: 'КВЦ', data: [] },
      omsu: { label: 'ОМСУ', data: [] },
      total: { label: 'Общий итог', data: [] }
    };

    const datasetsPercent = {
      gz: { label: 'Госзадание', data: [], plan: 3660 },
      mfc: { label: 'МФЦ МО', data: [], plan: 702 },
      kvc: { label: 'КВЦ', data: [], plan: 3000 },
      omsu: { label: 'ОМСУ', data: [], plan: null },
      total: { label: 'Общий итог', data: [], plan: null }
    };

    const plans = {};
    for (const [key, cfg] of Object.entries(INITIAL_INDICATOR_CONFIG)) {
      let p = cfg.plan;
      if (p === null && this.data.settings?.customPlans?.[key] !== undefined) {
        p = this.data.settings.customPlans[key];
      }
      plans[key] = p;
      if (datasetsPercent[key]) datasetsPercent[key].plan = p;
    }

    // точки, перенесённые с прошлых дат (обычно из презентаций планёрок): откуда взято значение
    const carried = Object.fromEntries(Object.keys(datasets).map(k => [k, []]));

    snapshots.forEach(s => {
      for (const key of Object.keys(datasets)) {
        if (s.virtual && !s.indicators[key]) {
          datasets[key].data.push(null);
          datasetsPercent[key].data.push(null);
          carried[key].push(null);
          continue;
        }
        const ind = s.indicators[key] || { fact: 0 };
        carried[key].push(ind.carried ? { from: ind.carriedFrom, src: ind.carriedSrc || null } : null);
        const val = ind.override ? ind.override.value : ind.fact;
        datasets[key].data.push(val);

        const planVal = plans[key];
        const pct = (planVal && planVal > 0) ? Math.round((val / planVal) * 100) : null;
        datasetsPercent[key].data.push(pct);
      }
    });

    // Расчет темпов и прогноза на 31.12
    const forecasts3112 = {};
    const forecastsPercent3112 = {};
    const details = this.computeSnapshotDetails();
    if (details && details.cards) {
      details.cards.forEach(c => {
        forecasts3112[c.key] = c.forecast3112;
        forecastsPercent3112[c.key] = c.forecastPercent;
      });
    }

    return {
      labels,
      dates,
      carried,
      datasets,
      datasetsPercent,
      plans,
      forecasts3112,
      forecastsPercent3112,
      targetDateLabel: '31.12.2026',
      targetDate: '2026-12-31'
    };
  }

  setIndicatorPlan(indicatorKey, planValue, author = 'Администратор') {
    if (!this.data.settings) this.data.settings = {};
    if (!this.data.settings.customPlans) this.data.settings.customPlans = {};
    const val = (planValue !== null && planValue !== undefined && planValue !== '') ? Number(planValue) : null;
    this.data.settings.customPlans[indicatorKey] = val;

    this.data.snapshots.forEach(s => {
      if (s.indicators[indicatorKey]) {
        s.indicators[indicatorKey].plan = val;
      }
    });

    const logEntry = {
      id: 'log-' + Date.now(),
      timestamp: new Date().toISOString(),
      author: author || 'Администратор',
      action: 'plan_update',
      snapshotDate: 'Все срезы',
      snapshotId: 'global',
      indicatorKey,
      indicatorTitle: INITIAL_INDICATOR_CONFIG[indicatorKey]?.title || indicatorKey,
      oldValue: null,
      newValue: val !== null ? `${val} чел.` : 'Сброшен',
      note: `Установлен ориентир плана: ${val !== null ? val + ' чел.' : 'не задан'}`
    };
    this.data.auditLog.unshift(logEntry);
    this.saveData();
    return { success: true, plan: val };
  }

  saveIndicatorComment(snapshotId, indicatorKey, commentData, author = 'Администратор') {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) throw new Error(`Срез ${snapshotId} не найден`);
    if (!snapshot.indicators[indicatorKey]) {
      snapshot.indicators[indicatorKey] = { fact: 0, plan: null, override: null };
    }
    const ind = snapshot.indicators[indicatorKey];
    ind.comments = {
      reason: commentData.reason || '',
      solution: commentData.solution || '',
      assignee: commentData.assignee || '',
      deadline: commentData.deadline || '',
      updatedAt: new Date().toISOString(),
      author: author || 'Администратор'
    };
    this.saveData();
    return ind.comments;
  }

  getMonthlyBreakdown() {
    const months = [
      'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
      'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'
    ];
    const weights = [0.04, 0.06, 0.08, 0.09, 0.08, 0.10, 0.05, 0.05, 0.12, 0.11, 0.11, 0.11];
    const latest = this.getLatestSnapshot();
    const result = {};

    for (const [key, cfg] of Object.entries(INITIAL_INDICATOR_CONFIG)) {
      const plan = (latest.indicators[key]?.plan !== undefined) ? latest.indicators[key].plan : cfg.plan;
      const currentFact = latest.indicators[key]?.override?.value ?? latest.indicators[key]?.fact ?? 0;

      const monthlyPlans = weights.map(w => plan ? Math.round(plan * w) : null);
      const pastWeights = weights.slice(0, 10);
      const totalPastWeight = pastWeights.reduce((a, b) => a + b, 0);

      const monthlyFacts = months.map((m, idx) => {
        if (idx < 9) {
          return Math.round(currentFact * (weights[idx] / totalPastWeight));
        } else if (idx === 9) {
          return Math.round(currentFact * (weights[idx] / totalPastWeight * 0.2));
        }
        return null;
      });

      result[key] = {
        title: cfg.title,
        months,
        monthlyPlans,
        monthlyFacts
      };
    }
    return result;
  }

  getPreviousYearComparison() {
    const data2025 = {
      date: '05.10.2025',
      indicators: {
        gz: { fact: 1780, plan: 3500 },
        mfc: { fact: 245, plan: 680 },
        kvc: { fact: 1420, plan: 2800 },
        omsu: { fact: 230, plan: null },
        total: { fact: 2255, plan: null }
      }
    };

    const latest = this.getLatestSnapshot();
    const comparison = {};

    for (const [key, cfg] of Object.entries(INITIAL_INDICATOR_CONFIG)) {
      const curVal = latest.indicators[key]?.override?.value ?? latest.indicators[key]?.fact ?? 0;
      const pastVal = data2025.indicators[key]?.fact ?? 0;
      const growth = curVal - pastVal;
      const growthPercent = pastVal > 0 ? Math.round((growth / pastVal) * 100) : 0;

      comparison[key] = {
        title: cfg.title,
        current2026: curVal,
        past2025: pastVal,
        growth,
        growthPercent
      };
    }

    return {
      pastDate: data2025.date,
      currentDate: latest.date,
      comparison
    };
  }

  applyOverride(snapshotId, indicatorKey, newValue, author, note) {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) throw new Error(`Срез ${snapshotId} не найден`);
    if (!snapshot.indicators[indicatorKey]) {
      snapshot.indicators[indicatorKey] = { fact: 0, plan: INITIAL_INDICATOR_CONFIG[indicatorKey]?.plan || null, override: null };
    }

    const currentInd = snapshot.indicators[indicatorKey];
    const oldValue = currentInd.override ? currentInd.override.value : currentInd.fact;
    const numValue = Number(newValue);

    currentInd.override = {
      value: numValue,
      originalValue: currentInd.fact,
      author: author || 'Администратор',
      updatedAt: new Date().toISOString(),
      note: note || 'Ручная корректировка'
    };

    // Если обновляем компоненты общего итога или сам итог:
    // если обновляем gz, mfc или omsu, пересчитываем total, если total не переопределен вручную
    if (['gz', 'mfc', 'omsu'].includes(indicatorKey)) {
      if (snapshot.indicators.total && !snapshot.indicators.total.override) {
        const gzVal = snapshot.indicators.gz?.override?.value ?? snapshot.indicators.gz?.fact ?? 0;
        const mfcVal = snapshot.indicators.mfc?.override?.value ?? snapshot.indicators.mfc?.fact ?? 0;
        const omsuVal = snapshot.indicators.omsu?.override?.value ?? snapshot.indicators.omsu?.fact ?? 0;
        snapshot.indicators.total.fact = gzVal + mfcVal + omsuVal;
      }
    }

    const logEntry = {
      id: 'log-' + Date.now(),
      timestamp: new Date().toISOString(),
      author: author || 'Администратор',
      action: 'override',
      snapshotDate: snapshot.date,
      snapshotId: snapshot.id,
      indicatorKey,
      indicatorTitle: INITIAL_INDICATOR_CONFIG[indicatorKey]?.title || indicatorKey,
      oldValue,
      newValue: numValue,
      note: note || 'Ручная корректировка администратора'
    };

    this.data.auditLog.unshift(logEntry);
    this.saveData();
    return logEntry;
  }

  revertOverride(snapshotId, indicatorKey, author) {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) throw new Error(`Срез ${snapshotId} не найден`);
    const currentInd = snapshot.indicators[indicatorKey];
    if (!currentInd || !currentInd.override) {
      throw new Error('У данного показателя нет активной ручной правки');
    }

    const overriddenValue = currentInd.override.value;
    const restoredValue = currentInd.fact;
    currentInd.override = null;

    if (['gz', 'mfc', 'omsu'].includes(indicatorKey)) {
      if (snapshot.indicators.total && !snapshot.indicators.total.override) {
        const gzVal = snapshot.indicators.gz?.override?.value ?? snapshot.indicators.gz?.fact ?? 0;
        const mfcVal = snapshot.indicators.mfc?.override?.value ?? snapshot.indicators.mfc?.fact ?? 0;
        const omsuVal = snapshot.indicators.omsu?.override?.value ?? snapshot.indicators.omsu?.fact ?? 0;
        snapshot.indicators.total.fact = gzVal + mfcVal + omsuVal;
      }
    }

    const logEntry = {
      id: 'log-' + Date.now(),
      timestamp: new Date().toISOString(),
      author: author || 'Администратор',
      action: 'revert',
      snapshotDate: snapshot.date,
      snapshotId: snapshot.id,
      indicatorKey,
      indicatorTitle: INITIAL_INDICATOR_CONFIG[indicatorKey]?.title || indicatorKey,
      oldValue: overriddenValue,
      newValue: restoredValue,
      note: 'Снятие ручной правки, возврат к данным из таблицы'
    };

    this.data.auditLog.unshift(logEntry);
    this.saveData();
    return logEntry;
  }

  createSnapshot(dateStr, indicatorsData, isAutomatic = false, note = '') {
    // Надежный парсинг даты (поддержка YYYY-MM-DD и DD.MM.YYYY)
    let snapshotId = dateStr;
    let formattedDisplay = dateStr;

    if (dateStr.includes('-')) {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        snapshotId = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
        formattedDisplay = `${parts[2].padStart(2, '0')}.${parts[1].padStart(2, '0')}.${parts[0]}`;
      }
    } else if (dateStr.includes('.')) {
      const parts = dateStr.split('.');
      if (parts.length === 3) {
        formattedDisplay = `${parts[0].padStart(2, '0')}.${parts[1].padStart(2, '0')}.${parts[2]}`;
        snapshotId = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }
    }

    let existing = this.getSnapshot(snapshotId);
    if (!existing) {
      existing = {
        id: snapshotId,
        date: formattedDisplay,
        createdAt: new Date().toISOString(),
        isAutomatic,
        note: note || (isAutomatic ? 'Автоматический срез по средам' : 'Ручной срез'),
        indicators: {}
      };
      this.data.snapshots.push(existing);
    } else {
      existing.note = note || existing.note;
    }

    // Заполнение показателей
    for (const [key, cfg] of Object.entries(INITIAL_INDICATOR_CONFIG)) {
      const incoming = indicatorsData[key] || {};
      const currentInd = existing.indicators[key] || { fact: 0, plan: cfg.plan, override: null };
      
      const newFact = incoming.fact !== undefined ? Number(incoming.fact) : currentInd.fact;
      const newPlan = incoming.plan !== undefined ? (incoming.plan === null ? null : Number(incoming.plan)) : currentInd.plan;

      currentInd.fact = newFact;
      currentInd.plan = newPlan;
      existing.indicators[key] = currentInd;
    }

    // Если total не задан явно, считаем gz + mfc + omsu
    if (!indicatorsData.total || indicatorsData.total.fact === undefined) {
      const gz = existing.indicators.gz?.fact || 0;
      const mfc = existing.indicators.mfc?.fact || 0;
      const omsu = existing.indicators.omsu?.fact || 0;
      existing.indicators.total.fact = gz + mfc + omsu;
    }

    const logEntry = {
      id: 'log-' + Date.now(),
      timestamp: new Date().toISOString(),
      author: isAutomatic ? 'Система (Авто-снимок)' : 'Администратор',
      action: 'snapshot_created',
      snapshotDate: existing.date,
      snapshotId: existing.id,
      indicatorKey: 'all',
      indicatorTitle: 'Срез недели',
      oldValue: null,
      newValue: `${existing.indicators.total.fact} чел.`,
      note: note || `Зафиксирован срез на ${existing.date}`
    };

    this.data.auditLog.unshift(logEntry);
    this.saveData();
    return existing;
  }

  getAuditLog(limit = 100) {
    return this.data.auditLog.slice(0, limit);
  }

  // --- ПОЛЬЗОВАТЕЛИ И РОЛИ ---

  // Список пользователей лежит в settings.users; первый запуск переносит туда прежнего администратора.
  migrateUsers() {
    const st = (this.data.settings ||= {});
    let changed = false;
    if (!Array.isArray(st.users)) { st.users = []; changed = true; }
    const adminName = st.adminUser || 'admin';
    let admin = st.users.find(u => u.username === adminName);
    if (!admin) {
      admin = { username: adminName, name: 'Администратор', role: 'admin', passHash: st.adminPassHash, createdAt: new Date().toISOString() };
      st.users.unshift(admin);
      changed = true;
    } else if (process.env.ADMIN_PASSWORD && !verifyPassword(process.env.ADMIN_PASSWORD, admin.passHash)) {
      admin.passHash = hashPassword(process.env.ADMIN_PASSWORD); // ADMIN_PASSWORD в окружении задаёт пароль главного администратора
      changed = true;
    }
    if (changed) this.saveData();
  }

  publicUser(u) {
    return { username: u.username, name: u.name || u.username, role: u.role, createdAt: u.createdAt || null };
  }

  getUser(username) {
    const u = ((this.data.settings || {}).users || []).find(x => x.username === username);
    return u ? this.publicUser(u) : null;
  }

  listUsers() {
    return ((this.data.settings || {}).users || []).map(u => this.publicUser(u));
  }

  // Возвращает пользователя без хеша или null. Сравнение выполняется и для несуществующего логина (одинаковое время ответа).
  verifyUser(username, password) {
    const users = (this.data.settings || {}).users || [];
    const u = users.find(x => x.username === String(username || '').trim().toLowerCase());
    const ok = verifyPassword(String(password || ''), u ? u.passHash : hashPassword('x'));
    return u && ok ? this.publicUser(u) : null;
  }

  validateUserFields({ username, name, role, password }, isNew) {
    const ROLES = ['admin', 'manager', 'methodist', 'viewer'];
    if (isNew) {
      if (!/^[a-z0-9._-]{3,32}$/.test(username || '')) throw new Error('Логин: 3–32 символа, латиница в нижнем регистре, цифры, . _ -');
    }
    if (role !== undefined && !ROLES.includes(role)) throw new Error('Неизвестная роль');
    if (name !== undefined && !String(name).trim()) throw new Error('Укажите имя');
    if (password !== undefined && String(password).length < 6) throw new Error('Пароль не короче 6 символов');
  }

  addUser({ username, name, role, password }, actor) {
    username = String(username || '').trim().toLowerCase();
    this.validateUserFields({ username, name, role, password }, true);
    if (!name || !role || !password) throw new Error('Заполните имя, роль и пароль');
    const st = this.data.settings;
    if (st.users.some(u => u.username === username)) throw new Error('Такой логин уже есть');
    st.users.push({ username, name: String(name).trim(), role, passHash: hashPassword(password), createdAt: new Date().toISOString() });
    this.logUserAction('user-add', username, `Создан пользователь «${username}», роль ${role}`, actor);
    this.saveData();
    return this.getUser(username);
  }

  updateUser(username, { name, role, password }, actor) {
    const st = this.data.settings;
    const u = st.users.find(x => x.username === username);
    if (!u) throw new Error('Пользователь не найден');
    this.validateUserFields({ name, role, password }, false);
    if (role !== undefined && role !== u.role) {
      if (u.role === 'admin' && st.users.filter(x => x.role === 'admin').length <= 1) throw new Error('Нельзя снять роль у последнего администратора');
      u.role = role;
      this.logUserAction('user-role', username, `Роль «${username}» изменена на ${role}`, actor);
    }
    if (name !== undefined) u.name = String(name).trim();
    if (password !== undefined && password !== '') {
      u.passHash = hashPassword(password);
      this.logUserAction('user-password', username, `Пароль «${username}» изменён`, actor);
    }
    this.saveData();
    return this.publicUser(u);
  }

  deleteUser(username, actor) {
    const st = this.data.settings;
    const u = st.users.find(x => x.username === username);
    if (!u) throw new Error('Пользователь не найден');
    if (u.role === 'admin' && st.users.filter(x => x.role === 'admin').length <= 1) throw new Error('Нельзя удалить последнего администратора');
    st.users = st.users.filter(x => x.username !== username);
    this.logUserAction('user-delete', username, `Удалён пользователь «${username}»`, actor);
    this.saveData();
  }

  logUserAction(action, username, note, actor) {
    this.data.auditLog.unshift({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      author: actor || 'Система',
      action,
      snapshotDate: '—',
      indicatorKey: 'users',
      indicatorTitle: 'Пользователи',
      oldValue: null,
      newValue: username,
      note
    });
  }

}

module.exports = new DataStore();
