// переменные окружения из .env рядом с сервером (ключ GigaChat и т.п.), если файл есть
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch (e) { /* .env нет — берём окружение как есть */ }

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const dataStore = require('./dataStore');
const excelService = require('./excelService');
const gigachatService = require('./gigachatService');
const programsService = require('./programsService');
const curatorsService = require('./curatorsService');
const statusService = require('./statusService');
const presentationService = require('./presentationService');
const reconcileService = require('./reconcileService');
const reportService = require('./reportService');
const collectService = require('./collectService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// CORS: разрешён только origin этого же хоста (и явно перечисленные в CORS_ORIGINS через запятую).
// Изменяющие запросы с чужого origin отклоняются целиком, а не только скрываются от чтения.
const EXTRA_ORIGINS = String(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // запрос со своей страницы без Origin, curl, планировщик
  if (EXTRA_ORIGINS.includes(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}
app.use(cors((req, cb) => cb(null, { origin: originAllowed(req), credentials: true })));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !originAllowed(req)) {
    return res.status(403).json({ error: 'Запрос с чужого адреса отклонён' });
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper для разбора cookies
function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// --- ВХОД, СЕССИИ И РОЛИ ---
// Без входа доступна только страница входа и /api/auth/*. Роль определяет, какие данные и действия доступны.
const ROLES = {
  admin: {
    label: 'Администратор',
    description: 'Полный доступ: правки данных, загрузка файлов, кураторы, журнал, управление пользователями',
    perms: ['view', 'programs', 'programsEdit', 'curators', 'chat', 'audit', 'edit', 'users']
  },
  manager: {
    label: 'Руководитель',
    description: 'Видит всё, включая кураторов и журнал правок, но ничего не меняет',
    perms: ['view', 'programs', 'curators', 'chat', 'audit']
  },
  methodist: {
    label: 'Методист',
    description: 'Показатели, план-график и рейтинг программ (с загрузкой анкет и план-графика). Без кураторов и журнала правок',
    perms: ['view', 'programs', 'programsEdit', 'chat']
  },
  viewer: {
    label: 'Наблюдатель',
    description: 'Только сводные показатели, динамика и таблица. Без программ, кураторов, журнала и помощника',
    perms: ['view']
  }
};

const SESSION_TTL_MS = 8 * 3600 * 1000;
const COOKIE_NAME = 'session';
const sessions = new Map(); // token -> { username, expiresAt }

function tokenFromRequest(req) {
  const cookieToken = parseCookies(req)[COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.substring(7) : null;
}

// Роль берётся из хранилища при каждом запросе: смена роли и удаление пользователя действуют сразу
function sessionUser(req) {
  const token = tokenFromRequest(req);
  const s = token && sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  const user = dataStore.getUser(s.username);
  if (!user) { sessions.delete(token); return null; }
  return user;
}

function permsOf(user) {
  return (ROLES[user.role] || { perms: [] }).perms;
}

function authPayload(user) {
  return { authenticated: true, user: { username: user.username, name: user.name, role: user.role, roleLabel: (ROLES[user.role] || {}).label || user.role }, roleDescription: (ROLES[user.role] || {}).description || '', permissions: permsOf(user) };
}

// Какое право нужно для маршрута (путь без /api). Первое совпадение выигрывает;
// всё остальное: GET — 'view', изменяющие запросы — 'edit'.
const ROUTE_PERMS = [
  [/^\/users(\/|$)/, '*', 'users'],
  [/^\/audit$/, 'GET', 'audit'],
  [/^\/(chat|generate-brief)(\/|$)/, '*', 'chat'],
  [/^\/schedule\/(upload|meta)$/, 'POST', 'programsEdit'],
  [/^\/feedback\/(scan|upload|link|settings)$/, 'POST', 'programsEdit'],
  [/^\/(schedule|feedback\/(ratings|files)|export\/ratings)$/, 'GET', 'programs'],
  [/^\/(curators|export\/curators|statuses|presentations)(\/|$)/, 'GET', 'curators']
];

function requiredPerm(method, p) {
  for (const [re, m, perm] of ROUTE_PERMS) {
    if ((m === '*' || m === method) && re.test(p)) return perm;
  }
  return method === 'GET' || method === 'HEAD' ? 'view' : 'edit';
}

const PUBLIC_API = new Set(['/auth/login', '/auth/check', '/auth/logout']);

app.use('/api', (req, res, next) => {
  if (PUBLIC_API.has(req.path)) return next();
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Требуется вход в систему' });
  const perm = requiredPerm(req.method, req.path);
  if (!permsOf(user).includes(perm)) {
    return res.status(403).json({ error: 'Недостаточно прав для этого действия или раздела' });
  }
  req.user = user;
  req.adminUser = user.name; // подпись автора в журнале правок
  next();
});

// Защита от подбора пароля: 5 неудачных попыток на логин+адрес за 10 минут
const loginFailures = new Map(); // key -> [timestamps]
function throttleKey(req, username) { return req.ip + '|' + String(username || '').toLowerCase(); }
function recentFailures(key) {
  const now = Date.now();
  const list = (loginFailures.get(key) || []).filter(t => now - t < 10 * 60 * 1000);
  if (list.length) loginFailures.set(key, list); else loginFailures.delete(key);
  return list;
}

// Глобальный шлюз выше уже проверил вход и роль; здесь только страховка для маршрутов с правкой.
function authMiddleware(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: 'Требуется вход в систему' });
}

// Multer для загрузки файлов Excel
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB
});

// multer отдаёт имя файла в latin1: возвращаем нормальную кириллицу
function uploadedFileName(file) {
  const raw = file.originalname || '';
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('�') ? raw : decoded;
}

// --- API МАРШРУТЫ ---

// 1. Получить данные текущего (или выбранного) среза
app.get('/api/snapshot', (req, res) => {
  try {
    const { id } = req.query;
    const details = dataStore.computeSnapshotDetails(id || null);
    if (!details) {
      return res.status(404).json({ error: 'Данные среза не найдены' });
    }
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Получить динамику показателей для графика
app.get('/api/history', (req, res) => {
  try {
    const history = dataStore.getHistoryChartData();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2b. Недели из еженедельных статусов: КВЦ, ГЗ дистант/очно, МФЦ (для «Графика планёрок»)
app.get('/api/status-history', (req, res) => {
  try {
    res.json({ weeks: statusService.getTimeline() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Вход, проверка сессии, выход
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = throttleKey(req, username);
  if (recentFailures(key).length >= 5) {
    return res.status(429).json({ error: 'Слишком много неверных попыток. Подождите 10 минут' });
  }
  const user = dataStore.verifyUser(username, password);
  if (!user) {
    loginFailures.set(key, [...recentFailures(key), Date.now()]);
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  loginFailures.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; HttpOnly; Path=/; Max-Age=' + (SESSION_TTL_MS / 1000) + '; SameSite=Lax');
  return res.json({ success: true, token, ...authPayload(user) });
});

app.get('/api/auth/check', (req, res) => {
  const user = sessionUser(req);
  return res.json(user ? authPayload(user) : { authenticated: false });
});

app.post('/api/auth/logout', (req, res) => {
  const token = tokenFromRequest(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ success: true });
});

// Управление пользователями (роль admin)
app.get('/api/users', (req, res) => {
  res.json({
    users: dataStore.listUsers(),
    roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, description: r.description }))
  });
});

app.post('/api/users', (req, res) => {
  try {
    res.json({ success: true, user: dataStore.addUser(req.body || {}, req.user.name) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/:username', (req, res) => {
  try {
    const { name, role, password } = req.body || {};
    const user = dataStore.updateUser(req.params.username, { name, role, password }, req.user.name);
    // после смены пароля другие сессии этого пользователя закрываются
    if (password) {
      const current = tokenFromRequest(req);
      for (const [t, s] of sessions) if (s.username === req.params.username && t !== current) sessions.delete(t);
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:username', (req, res) => {
  try {
    if (req.params.username === req.user.username) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    dataStore.deleteUser(req.params.username, req.user.name);
    for (const [t, s] of sessions) if (s.username === req.params.username) sessions.delete(t);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Ручная корректировка цифры (только для админа)
app.post('/api/override', authMiddleware, (req, res) => {
  try {
    const { snapshotId, indicatorKey, newValue, author, note } = req.body;
    if (!snapshotId || !indicatorKey || newValue === undefined) {
      return res.status(400).json({ error: 'Не все обязательные поля заполнены' });
    }

    const log = dataStore.applyOverride(
      snapshotId,
      indicatorKey,
      Number(newValue),
      author || 'Администратор',
      note || ''
    );

    const updated = dataStore.computeSnapshotDetails(snapshotId);
    res.json({ success: true, updated, log });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 5. Откат ручной корректировки (только для админа)
app.post('/api/override/revert', authMiddleware, (req, res) => {
  try {
    const { snapshotId, indicatorKey, author } = req.body;
    if (!snapshotId || !indicatorKey) {
      return res.status(400).json({ error: 'Не указан срез или показатель' });
    }

    const log = dataStore.revertOverride(
      snapshotId,
      indicatorKey,
      author || 'Администратор'
    );

    const updated = dataStore.computeSnapshotDetails(snapshotId);
    res.json({ success: true, updated, log });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 6. Журнал аудита
app.get('/api/audit', (req, res) => {
  try {
    const logs = dataStore.getAuditLog(150);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Создание нового среза вручную (для админа)
app.post('/api/snapshot/manual', authMiddleware, (req, res) => {
  try {
    const { date, indicators, note } = req.body;
    if (!date) {
      return res.status(400).json({ error: 'Дата среза обязательна (формат YYYY-MM-DD)' });
    }

    const snapshot = dataStore.createSnapshot(
      date,
      indicators || {},
      false,
      note || 'Ручной срез'
    );

    res.json({ success: true, snapshot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 8. Загрузка Excel файла
app.post('/api/upload-excel', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл Excel не предоставлен' });
    }

    const parsed = excelService.parseUploadedExcel(req.file.buffer);
    const dateStr = req.body.date || new Date().toISOString().slice(0, 10);

    // Подготовка показателей
    const indicators = {};
    if (parsed.gz !== null) indicators.gz = { fact: parsed.gz };
    if (parsed.mfc !== null) indicators.mfc = { fact: parsed.mfc };
    if (parsed.kvc !== null) indicators.kvc = { fact: parsed.kvc };
    if (parsed.omsu !== null) indicators.omsu = { fact: parsed.omsu };
    if (parsed.total !== null) indicators.total = { fact: parsed.total };

    const snapshot = dataStore.createSnapshot(
      dateStr,
      indicators,
      false,
      `Импорт из файла: ${uploadedFileName(req.file)}`
    );

    res.json({
      success: true,
      message: 'Файл успешно обработан',
      snapshotId: snapshot.id,
      parsedValues: parsed
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка разбора Excel: ' + err.message });
  }
});

// 9. Экспорт текущего среза в Excel
app.get('/api/export/current', (req, res) => {
  try {
    const { id } = req.query;
    const details = dataStore.computeSnapshotDetails(id || null);
    if (!details) return res.status(404).send('Срез не найден');

    const buffer = excelService.generateCurrentSnapshotExcel(details);
    const filename = `Дашборд_срез_${details.snapshot.date.replace(/\./g, '-')}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Ошибка экспорта: ' + err.message);
  }
});

// 10. Экспорт истории в Excel
app.get('/api/export/history', (req, res) => {
  try {
    const snapshots = dataStore.getAllSnapshots();
    const buffer = excelService.generateHistoryExcel(snapshots);
    const filename = `Дашборд_история_по_неделям.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Ошибка экспорта: ' + err.message);
  }
});

// 11. ИИ-помощник: Генерация тезисов к планёрке
app.post('/api/generate-brief', async (req, res) => {
  try {
    const { snapshotId } = req.body;
    const currentDetails = dataStore.computeSnapshotDetails(snapshotId || null);
    const allSnapshots = dataStore.getAllSnapshots();
    const apiKey = process.env.GIGACHAT_CREDENTIALS || null;

    const thesesPrompt = 'Сформируй тезисы к планёрке учебного отдела по текущему срезу: 3-5 ключевых пунктов, включая общий охват, проблемные зоны с отставанием от 76%, нужный темп и решения.';
    const result = await gigachatService.askGigaChat(
      apiKey,
      thesesPrompt,
      [],
      currentDetails,
      allSnapshots
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Установка / сброс ориентира показателя (только для админа)
app.post('/api/indicator-plan', authMiddleware, (req, res) => {
  try {
    const { indicatorKey, planValue, author } = req.body;
    if (!indicatorKey) return res.status(400).json({ error: 'Не указан ключ показателя' });
    const result = dataStore.setIndicatorPlan(indicatorKey, planValue, author || req.adminUser);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Сохранение комментария к срезу по направлению (только для админа)
app.post('/api/indicator-comment', authMiddleware, (req, res) => {
  try {
    const { snapshotId, indicatorKey, reason, solution, assignee, deadline, author } = req.body;
    if (!snapshotId || !indicatorKey) {
      return res.status(400).json({ error: 'Не указан срез или показатель' });
    }
    const comments = dataStore.saveIndicatorComment(
      snapshotId,
      indicatorKey,
      { reason, solution, assignee, deadline },
      author || req.adminUser
    );
    res.json({ success: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. Помесячная разбивка план/факт
app.get('/api/monthly-breakdown', (req, res) => {
  try {
    const data = dataStore.getMonthlyBreakdown();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 15. Сравнение с прошлым годом (2025)
app.get('/api/yoy-comparison', (req, res) => {
  try {
    const data = dataStore.getPreviousYearComparison();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 16. Статус и расписание авто-срезов (вторник после 16:00)
app.get('/api/notification-status', (req, res) => {
  const latest = dataStore.getLatestSnapshot();
  const details = dataStore.computeSnapshotDetails();
  const card = k => details?.cards?.find(c => c.key === k);
  const total = card('total');
  const gz = card('gz');
  const kvc = card('kvc');
  const fmt = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));

  const nextSnap = collectService.nextSnapshotAt();
  const nextRu = collectService.mskNow(nextSnap).toISOString().slice(0, 10).split('-').reverse().join('.');

  res.json({
    schedule: 'Срез: каждый вторник после 16:00 МСК. Сбор данных: ежедневно в 09:00, 12:00 и 18:00 МСК',
    nextRun: `Вторник, ${nextRu}, 16:05 МСК`,
    latestSnapshot: latest?.date || null,
    previewNotification: {
      title: `📊 Срез учебного отдела на ${latest?.date || '—'} сформирован`,
      threeMainNumbers: [
        `Сводный охват: ${fmt(total?.fact)} чел. (${total?.delta === null || total?.delta === undefined ? '—' : (total.delta >= 0 ? '+' : '') + fmt(total.delta)})`,
        `Госзадание: ${fmt(gz?.fact)}/${fmt(gz?.plan)} (${gz?.percent ?? '—'}%)`,
        `КВЦ: ${fmt(kvc?.fact)}/${fmt(kvc?.plan)} (${kvc?.percent ?? '—'}%)`
      ],
      link: `http://localhost:${PORT}/?snapshot=${latest?.id || ''}`
    }
  });
});

// 16a. Статус всего дашборда на текущий момент: цифры, свежесть источников, расписание (публично, только числа)
app.get('/api/dashboard-status', (req, res) => {
  try {
    const details = dataStore.computeSnapshotDetails();
    const latest = dataStore.getLatestSnapshot();
    const run = collectService.lastRun();
    const stepOf = name => (run && run.steps.find(x => x.name === name)) || null;
    const statusInfo = statusService.getStatusInfo();
    const presInfo = presentationService.getInfo();
    const cur = curatorsService.getSourceUrl() ? (dataStore.data.curation || {}) : null;
    const fbInfo = programsService.getFeedbackFilesInfo();
    const sources = [
      { key: 'statuses', title: 'Статусы по программам', lastDataDate: (statusInfo.files.find(f => f.status === 'ok') || {}).date || null, scannedAt: statusInfo.lastScanAt, files: statusInfo.files.length, errors: statusInfo.files.filter(f => f.status !== 'ok').length, step: stepOf('statuses') },
      { key: 'presentations', title: 'Презентации планёрок', lastDataDate: (presInfo.releases[presInfo.releases.length - 1] || presInfo.releases[0] || {}).date || null, scannedAt: presInfo.lastScanAt, files: presInfo.files.length, errors: presInfo.files.filter(f => f.status !== 'ok').length, step: stepOf('presentations') },
      { key: 'feedback', title: 'Анкеты', lastDataDate: null, scannedAt: fbInfo.lastScanAt, files: (fbInfo.files || []).length, errors: (fbInfo.files || []).filter(f => f.status && f.status !== 'ok').length, step: stepOf('feedback') },
      { key: 'curators', title: 'Таблица кураторов', lastDataDate: cur && cur.fetchedAt ? cur.fetchedAt.slice(0, 10) : null, scannedAt: cur ? cur.fetchedAt : null, files: null, errors: cur && cur.error ? 1 : 0, step: stepOf('curators') }
    ];
    res.json({
      now: new Date().toISOString(),
      collecting: collectService.isRunning(),
      latestSnapshot: latest ? { id: latest.id, date: latest.date } : null,
      expectedPercent: details ? details.cards.find(c => c.expectedPercent !== undefined)?.expectedPercent ?? null : null,
      cards: details ? details.cards.map(c => ({
        key: c.key, title: c.title, category: c.category, plan: c.plan, fact: c.fact, percent: c.percent,
        expectedPercent: c.expectedPercent, expectedFact: c.expectedFact, lagPercent: c.lagPercent,
        status: c.status, delta: c.delta, deltaDays: c.deltaDays, currentPace: c.currentPace,
        requiredPace: c.requiredPace, forecastPercent: c.forecastPercent,
        sourceUpdatedAt: c.sourceUpdatedAt, isOutdated: c.isOutdated, discrepancy: c.discrepancy || null
      })) : [],
      attention: details && details.attentionList ? details.attentionList.map(a => ({ key: a.key, title: a.title, lagPercent: a.lagPercent, shortage: a.shortage })) : [],
      sources,
      lastRun: run ? { reason: run.reason, startedAt: run.startedAt, finishedAt: run.finishedAt } : null,
      nextCollectAt: collectService.nextCollectAt().toISOString(),
      nextSnapshotAt: collectService.nextSnapshotAt().toISOString(),
      schedule: { collect: '09:00, 12:00, 18:00 МСК ежедневно', snapshot: 'вторник, после 16:00 МСК (16:05)' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 16b. Собрать данные сейчас (только для админа)
app.post('/api/collect', authMiddleware, async (req, res) => {
  try {
    const run = await collectService.collectAll('вручную');
    res.json({ success: true, run });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 17. ИИ-помощник (GigaChat API)
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, snapshotId } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }

    // Готовые отчёты по данным дашборда (например, сообщение руководителю о идущих программах) — без обращения к GigaChat
    const report = reportService.tryHandle(message, Array.isArray(history) ? history : []);
    if (report) return res.json(report);

    const currentDetails = dataStore.computeSnapshotDetails(snapshotId || null);
    const allSnapshots = dataStore.getAllSnapshots();

    // Ключ берется из окружения или из защищенных настроек сервера
    const apiKey = process.env.GIGACHAT_CREDENTIALS || null;

    const result = await gigachatService.askGigaChat(
      apiKey,
      message,
      Array.isArray(history) ? history : [],
      currentDetails,
      allSnapshots
    );

    res.json(result);
  } catch (err) {
    console.error('Ошибка в эндпоинте /api/chat:', err);
    res.status(500).json({ error: 'Ошибка обработки запроса ИИ: ' + err.message });
  }
});

// Статус подключения GigaChat
app.get('/api/chat/status', (req, res) => {
  // ключ берётся только из окружения; наружу не отдаётся даже частично
  const configured = Boolean(process.env.GIGACHAT_CREDENTIALS);
  return res.json({ configured, isEnv: configured, maskedKey: null });
});

// Ключ GigaChat задаётся только переменной окружения GIGACHAT_CREDENTIALS (или строкой в .env рядом с сервером)
app.post('/api/chat/settings', authMiddleware, (req, res) => {
  res.status(410).json({ error: 'Ключ GigaChat задаётся только переменной окружения GIGACHAT_CREDENTIALS на сервере (можно строкой в файле .env рядом с server.js)' });
});

// --- ПЛАН-ГРАФИК ПРОГРАММ И РЕЙТИНГ ПО АНКЕТАМ ---

function asOfFromQuery(req) {
  const v = String(req.query.asOf || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : programsService.todayIso();
}

// 18. План-график: группы, статусы, ближайшие 2 недели
app.get('/api/schedule', (req, res) => {
  try {
    res.json(programsService.getSchedule(asOfFromQuery(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 19. Загрузка Excel план-графика (только для админа)
app.post('/api/schedule/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл план-графика не предоставлен' });
    const year = Number(req.body.year) || 2026;
    const parsed = programsService.parsePlanSchedule(req.file.buffer, year);
    const result = programsService.applySchedule(parsed, uploadedFileName(req.file));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: 'Ошибка разбора план-графика: ' + err.message });
  }
});

// 20. План слушателей, источник финансирования и куратор программы/группы (только для админа)
app.post('/api/schedule/meta', authMiddleware, (req, res) => {
  try {
    programsService.setScheduleMeta(req.body || {});
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 21. Рейтинг программ, сигналы и темы комментариев
app.get('/api/feedback/ratings', (req, res) => {
  try {
    res.json({ ...programsService.computeRatings(asOfFromQuery(req)), constants: programsService.constants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 22. Состояние папки с анкетами и журнал обработки
app.get('/api/feedback/files', (req, res) => {
  try {
    res.json(programsService.getFeedbackFilesInfo());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 23. Прочитать папку с анкетами сейчас (только для админа)
app.post('/api/feedback/scan', authMiddleware, (req, res) => {
  try {
    res.json({ success: true, ...programsService.scanFeedbackFolder() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 24. Загрузка файла анкеты в папку (только для админа)
app.post('/api/feedback/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл анкеты не предоставлен' });
    const name = programsService.saveUploadedFeedback(uploadedFileName(req.file), req.file.buffer);
    const scan = programsService.scanFeedbackFolder();
    res.json({ success: true, fileName: name, ...scan });
  } catch (err) {
    res.status(400).json({ error: 'Анкета не принята: ' + err.message });
  }
});

// 25. Ручная привязка анкеты к группе план-графика (только для админа)
app.post('/api/feedback/link', authMiddleware, (req, res) => {
  try {
    const { hash, groupId } = req.body || {};
    programsService.setManualLink(hash, groupId || null);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 26. Папка с анкетами (только для админа)
app.post('/api/feedback/settings', authMiddleware, (req, res) => {
  try {
    programsService.setFeedbackDir((req.body || {}).dir);
    res.json({ success: true, ...programsService.scanFeedbackFolder() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 27. Выгрузка рейтинга программ в Excel
app.get('/api/export/ratings', (req, res) => {
  try {
    const buffer = programsService.buildRatingsWorkbook();
    const filename = 'Рейтинг_программ_по_анкетам.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Ошибка экспорта: ' + err.message);
  }
});


// --- КУРАТОРЫ, РЕЙТИНГ КУРАТОРОВ И ЕЖЕНЕДЕЛЬНЫЕ СТАТУСЫ (только для админа: это оценка сотрудников) ---

// 28. Кураторы: нагрузка по очным и дистанционным программам, рейтинг
app.get('/api/curators', authMiddleware, (req, res) => {
  try {
    res.json(curatorsService.computeCurators(asOfFromQuery(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 29. Обновить таблицу кураторов из Google Таблицы
app.post('/api/curators/refresh', authMiddleware, async (req, res) => {
  try {
    const r = await curatorsService.refreshFromGoogle();
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// 30. Загрузить таблицу кураторов файлом .xlsx (если таблица закрыта по ссылке)
app.post('/api/curators/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не предоставлен' });
    const r = curatorsService.importFile(req.file.buffer, uploadedFileName(req.file));
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(400).json({ error: 'Таблица не принята: ' + err.message });
  }
});

// 31. Ссылка на Google Таблицу с кураторами
app.post('/api/curators/settings', authMiddleware, async (req, res) => {
  try {
    curatorsService.setSourceUrl((req.body || {}).url);
    if (!curatorsService.getSourceUrl()) return res.json({ success: true, rows: 0 });
    const r = await curatorsService.refreshFromGoogle();
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 32. Выгрузка рейтинга кураторов в Excel
app.get('/api/export/curators', authMiddleware, (req, res) => {
  try {
    const buffer = curatorsService.buildCuratorsWorkbook();
    const filename = 'Кураторы_нагрузка_и_рейтинг.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Ошибка экспорта: ' + err.message);
  }
});

// 33. Еженедельные «Статусы по программам»: список файлов, динамика заявок КВЦ
app.get('/api/statuses', authMiddleware, (req, res) => {
  try {
    res.json(statusService.getStatusInfo());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/statuses/scan', authMiddleware, (req, res) => {
  try {
    res.json({ success: true, ...statusService.scanStatusFolder() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/statuses/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл статусов не предоставлен' });
    const name = statusService.saveUploadedStatus(uploadedFileName(req.file), req.file.buffer);
    res.json({ success: true, fileName: name, ...statusService.scanStatusFolder() });
  } catch (err) {
    res.status(400).json({ error: 'Файл статусов не принят: ' + err.message });
  }
});

app.post('/api/statuses/settings', authMiddleware, (req, res) => {
  try {
    statusService.setStatusDir((req.body || {}).dir);
    res.json({ success: true, ...statusService.scanStatusFolder() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- ЕДИНАЯ КАРТИНА: СТРУКТУРА ПО ПРЕЗЕНТАЦИЯМ И СВЕРКА ИСТОЧНИКОВ ---

// 34. Направления госзадания и программы КВЦ на дату (из презентации планёрки не позже этой даты)
app.get('/api/structure', (req, res) => {
  try {
    const id = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.id || '')) ? String(req.query.id) : (dataStore.getLatestSnapshot() || {}).id;
    res.json(presentationService.getStructure(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 35. Сверка данных между источниками
app.get('/api/reconcile', (req, res) => {
  try {
    res.json(reconcileService.getReconcile());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 36. Презентации планёрок: папка, выпуски, замечания (только для админа)
app.get('/api/presentations', authMiddleware, (req, res) => {
  try {
    res.json(presentationService.getInfo());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/presentations/scan', authMiddleware, (req, res) => {
  try {
    res.json({ success: true, ...presentationService.scanPresentations() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/presentations/settings', authMiddleware, (req, res) => {
  try {
    presentationService.setPresentationDir((req.body || {}).dir);
    res.json({ success: true, ...presentationService.scanPresentations() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- АВТОМАТИЧЕСКИЙ СРЕЗ ПО ВТОРНИКАМ ПОСЛЕ 16:00 (МСК) ---
// В cron: 5 16 * * 2 (минуты/часы/день/месяц/день недели, 2 - вторник)
// Перед срезом данные собираются заново, чтобы срез взял свежие цифры.
cron.schedule(collectService.SNAPSHOT_CRON, async () => {
  console.log(`[${new Date().toISOString()}] Автоматический срез по расписанию (вторник, 16:05)`);
  try { await collectService.collectAll('перед срезом'); } catch (e) { console.error('Сбор перед срезом:', e); }
  try {
    const todayStr = collectService.mskDateStr();

    const latest = dataStore.getLatestSnapshot();
    const indicatorsData = {};
    if (latest && latest.indicators) {
      for (const [k, v] of Object.entries(latest.indicators)) {
        indicatorsData[k] = {
          fact: v.override ? v.override.value : v.fact,
          plan: v.plan
        };
      }
    }

    dataStore.createSnapshot(todayStr, indicatorsData, true, 'Регулярный авто-срез по вторникам после 16:00 (перед планёркой в среду)');
    console.log(`Автоматический срез ${todayStr} успешно создан.`);
  } catch (err) {
    console.error('Ошибка создания автоматического снимка:', err);
  }
}, {
  timezone: 'Europe/Moscow'
});

// --- СБОР ДАННЫХ: при запуске и ежедневно в 09:00, 12:00, 18:00 (МСК) ---
// Анкеты, статусы, презентации планёрок и таблица кураторов (см. collectService.js)
collectService.collectAll('старт');
cron.schedule(collectService.COLLECT_CRON, () => collectService.collectAll('по расписанию'), { timezone: 'Europe/Moscow' });

// Маршрут по умолчанию - отдача SPA приложения
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Дашборд учебного отдела успешно запущен!`);
  console.log(`📡 Локальный адрес: http://localhost:${PORT}`);
  console.log(`📱 В локальной сети: http://0.0.0.0:${PORT}`);
  console.log(`⏰ Сбор данных: ежедневно 09:00, 12:00, 18:00 МСК`);
  console.log(`⏰ Авто-срез: каждый вторник в 16:05 МСК`);
  console.log(`📁 Папка с анкетами: ${programsService.feedbackDir()}`);
  console.log(`📁 Папка со статусами: ${statusService.statusDir()}`);
  console.log(`📁 Папка с презентациями планёрок: ${presentationService.presentationDir()}`);
  console.log(`🔐 Вход по логину и паролю (администратор: admin; пароль задаётся ADMIN_PASSWORD или при первом запуске)`);
  console.log(`====================================================`);
});
