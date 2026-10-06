const https = require('https');
const crypto = require('crypto');

class GigaChatService {
  constructor() {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.httpsAgent = new https.Agent({
      rejectUnauthorized: false // Для работы с сертификатами Минцифры РФ / НУЦ Сбера
    });
  }

  /**
   * Получение токена доступа GigaChat
   */
  async getAccessToken(credentials) {
    const now = Date.now();
    if (this.accessToken && this.tokenExpiresAt > now + 60000) {
      return this.accessToken;
    }

    if (!credentials) {
      throw new Error('Ключ GigaChat (Authorization Data) не настроен');
    }

    const rqUID = crypto.randomUUID();
    const postData = 'scope=GIGACHAT_API_PERS';

    const options = {
      hostname: 'ngw.devices.sberbank.ru',
      port: 9443,
      path: '/api/v2/oauth',
      method: 'POST',
      agent: this.httpsAgent,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'RqUID': rqUID,
        'Authorization': `Basic ${credentials.trim()}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const parsed = JSON.parse(body);
              this.accessToken = parsed.access_token;
              this.tokenExpiresAt = parsed.expires_at || (now + 30 * 60 * 1000);
              resolve(this.accessToken);
            } else {
              reject(new Error(`GigaChat OAuth error (${res.statusCode}): ${body}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse OAuth response: ${e.message}`));
          }
        });
      });

      req.on('error', err => reject(err));
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Превышено время ожидания авторизации GigaChat'));
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * Формирование структурированного контекста для модели на основе живых данных
   */
  buildSystemPrompt(currentDetails, allSnapshots) {
    const curr = currentDetails.snapshot;
    const cards = currentDetails.cards;

    let indicatorsText = cards.map(c => {
      if (c.noData) {
        return `- ${c.title} (${c.category}):
  * НА ЭТУ ДАТУ В ИСТОЧНИКАХ ДАННЫХ НЕТ: показатель не определён. Это не ноль, называть цифру нельзя.`;
      }
      const planStr = c.plan !== null ? `${c.plan} чел.` : 'План не установлен';
      const pctStr = c.percent !== null ? `${c.percent}%` : '—';
      const deltaStr = c.delta !== null ? (c.delta >= 0 ? `+${c.delta} чел.` : `${c.delta} чел.`) : 'нет данных';
      const overrideStr = c.isOverridden ? `[ВНИМАНИЕ: Скорректировано администратором вручную, оригинальное значение из таблицы было ${c.originalFact}]` : '[Данные из таблицы]';
      
      let screenPosition = '';
      if (c.key === 'total') screenPosition = 'Большая синяя акцентная карточка "Сводный охват" вверху и строка "Общий итог" в таблице';
      else if (c.key === 'gz') screenPosition = 'Карточка "Государственное задание" в сетке показателей и 1-я круговая диаграмма';
      else if (c.key === 'mfc') screenPosition = 'Карточка "МФЦ МО" в сетке показателей и 3-я круговая диаграмма';
      else if (c.key === 'kvc') screenPosition = 'Карточка "КВЦ (открытые курсы)" в сетке показателей и 2-я круговая диаграмма';
      else if (c.key === 'omsu') screenPosition = 'Карточка "ОМСУ и подведы" в сетке показателей и блок хозрасчета';

      return `- ${c.title} (${c.category}):
  * Выполнено (факт): ${c.fact} чел.${c.carried ? ` (в статусах на эту дату показателя нет: значение из презентации планёрки от ${c.carriedFrom})` : ''}
  * План: ${planStr}
  * Процент выполнения: ${pctStr}
  * Прирост${c.deltaDays ? ` за ${c.deltaDays} дн.` : ''}: ${deltaStr}
  * Источник: ${c.source}
  * Расположение на экране дашборда: ${screenPosition}
  * Статус: ${overrideStr}`;
    }).join('\n\n');

    let historyText = allSnapshots.map(s => {
      const g = s.indicators.gz?.override?.value ?? s.indicators.gz?.fact ?? '—';
      const m = s.indicators.mfc?.override?.value ?? s.indicators.mfc?.fact ?? '—';
      const k = s.indicators.kvc?.override?.value ?? s.indicators.kvc?.fact ?? '—';
      const o = s.indicators.omsu?.override?.value ?? s.indicators.omsu?.fact ?? '—';
      const t = s.indicators.total?.override?.value ?? s.indicators.total?.fact ?? '—';
      const tilde = key => (s.indicators[key]?.carried ? '~' : '');
      return `* Срез ${s.date} (${s.id}): Итог=${t}${tilde('total')}, Госзадание=${g}${tilde('gz')}, МФЦ=${m}${tilde('mfc')}, КВЦ=${k}${tilde('kvc')}, ОМСУ=${o}${tilde('omsu')}`;
    }).join('\n');

    return `Ты — официальный ИИ-помощник учебного отдела, встроенный в интерактивный дашборд план-факта обучения слушателей.
Твоя задача — отвечать на вопросы руководства и сотрудников обычным языком, находить точные цифры, объяснять источники и подсказывать, где на экране находится информация.

СТРОГИЕ ПРАВИЛА:
1. Цифры бери ТОЛЬКО из предоставленных ниже данных дашборда. Категорически запрещено придумывать или экстраполировать цифры! Если данных о каком-то показателе или периоде нет, прямо отвечай: «В текущих данных дашборда эта информация отсутствует». Если у показателя написано «ДАННЫХ НЕТ», не называй его нулём и не делай выводов об отставании по нему.
2. Когда пользователь спрашивает про конкретный показатель (например, КВЦ, МФЦ, Госзадание):
   - Назови факт выполнения, плановый ориентир и процент выполнения.
   - Обязательно укажи, из какого листа/источника взята цифра (например, лист «открытые курсы», лист «факт гз 2026», слайд презентации).
   - Подскажи, в какой карточке или блоке на экране она находится.
3. Если пользователь просит данные за прошлую неделю — используй блок "ИСТОРИЯ СРЕЗОВ ПО НЕДЕЛЯМ": бери ближайший срез не менее чем за 5 дней до текущего, где показатель известен (знак «—» означает, что на ту дату показателя в источниках нет). Если подходящего среза нет, прямо скажи, что данных нет.
4. Если пользователь просит выгрузить в Excel ("выгрузи всё в Excel", "скачать отчет" и т.п.):
   - Предоставь готовую ссылку на скачивание текущего среза: [Скачать текущий срез в Excel](/api/export/current?id=${curr.id})
   - И ссылку на историю по неделям: [Скачать историю по неделям в Excel](/api/export/history)
5. Персональные данные слушателей отсутствуют и запрещены — оперируй только количественными показателями.
6. Отвечай дружелюбно, четко, структурированно на русском языке.

--- АКТУАЛЬНЫЕ ДАННЫЕ ТЕКУЩЕГО СРЕЗА (${curr.date}) ---
${indicatorsText}

--- ИСТОРИЯ СРЕЗОВ ПО НЕДЕЛЯМ (ДЛЯ СРАВНЕНИЯ; знак ~ — в статусах на дату показателя нет, значение из последней презентации планёрки) ---
${historyText}`;
  }

  /**
   * Отправка запроса в GigaChat
   */
  async askGigaChat(apiKey, userMessage, conversationHistory = [], currentDetails, allSnapshots) {
    try {
      const token = await this.getAccessToken(apiKey);
      const systemPrompt = this.buildSystemPrompt(currentDetails, allSnapshots);

      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      // Добавим последние 4 сообщения из истории для контекста
      const recentHistory = conversationHistory.slice(-4);
      recentHistory.forEach(msg => {
        messages.push({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.text
        });
      });

      messages.push({ role: 'user', content: userMessage });

      const requestPayload = JSON.stringify({
        model: 'GigaChat',
        messages: messages,
        temperature: 0.2, // Низкая температура для строгой фактологичности
        max_tokens: 1000
      });

      const options = {
        hostname: 'gigachat.devices.sberbank.ru',
        port: 443,
        path: '/api/v1/chat/completions',
        method: 'POST',
        agent: this.httpsAgent,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(requestPayload)
        }
      };

      return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                const parsed = JSON.parse(body);
                const reply = parsed.choices?.[0]?.message?.content || 'Не удалось сформировать ответ.';
                resolve({ reply, source: 'gigachat' });
              } else {
                reject(new Error(`GigaChat completion error (${res.statusCode}): ${body}`));
              }
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}`));
            }
          });
        });

        req.on('error', err => reject(err));
        req.setTimeout(25000, () => {
          req.destroy();
          reject(new Error('Таймаут ответа GigaChat'));
        });
        req.write(requestPayload);
        req.end();
      });

    } catch (err) {
      console.warn('GigaChat API недоступен или вернул ошибку, переключение на локальный процессор:', err.message);
      // Если API недоступен или ключ отсутствует — используем фактологический fallback
      const fallbackReply = this.localFallbackResponse(userMessage, currentDetails, allSnapshots);
      return { reply: fallbackReply, source: 'fallback', notice: err.message };
    }
  }

  /**
   * Умный локальный фактологический движок (fallback при отсутствии ключа или сбое сети)
   */
  localFallbackResponse(userMessage, currentDetails, allSnapshots) {
    const q = userMessage.toLowerCase();
    const curr = currentDetails.snapshot;
    const cards = currentDetails.cards;

    // 0. Показатель, которого нет в источниках на эту дату
    const asked = [['квц', 'kvc'], ['открытые курсы', 'kvc'], ['мфц', 'mfc'], ['госзадан', 'gz'], ['омсу', 'omsu']].find(([w]) => q.includes(w));
    const askedCard = asked ? cards.find(c => c.key === asked[1]) : null;
    if (askedCard && askedCard.noData) {
      return `📌 **${askedCard.title}** на срезе ${curr.date}: в текущих данных дашборда эта информация отсутствует (для этой даты в источниках известны не все показатели). Выберите срез с полными данными в списке «Срез» вверху экрана.`;
    }

    // 1. Запрос по КВЦ
    if (q.includes('квц') || q.includes('открытые курсы')) {
      const kvc = cards.find(c => c.key === 'kvc');
      return `📌 **КВЦ (открытые курсы)** на текущем срезе (${curr.date}):
• **Выполнение (факт):** ${kvc.fact.toLocaleString('ru-RU')} чел.
• **План:** ${kvc.plan.toLocaleString('ru-RU')} чел.
• **Процент плана:** ${kvc.percent}%
• **Динамика за неделю:** ${kvc.delta !== null ? (kvc.delta >= 0 ? `+${kvc.delta}` : kvc.delta) : '0'} чел.
• **Источник данных:** ${kvc.source}
• **Где на экране:** 3-я карточка в сетке ключевых показателей «Исполнение планов обучения» и 2-я круговая диаграмма (оранжевое кольцо).`;
    }

    // 2. Запрос по МФЦ за прошлую неделю
    if (q.includes('мфц') && (q.includes('прошл') || q.includes('предыдущ') || q.includes('недел') || q.includes('01.10'))) {
      const mfcNow = cards.find(c => c.key === 'mfc');
      if (mfcNow.delta === null || !mfcNow.deltaDays) {
        return `📌 **МФЦ МО** на срезе ${curr.date}: ${mfcNow.fact} чел. Предыдущего среза с данными по МФЦ нет, поэтому сравнить с прошлой неделей нельзя.`;
      }
      const prevMfcVal = mfcNow.fact - mfcNow.delta;
      const prevPct = mfcNow.plan ? Math.round(prevMfcVal / mfcNow.plan * 100) : null;
      const sign = mfcNow.delta >= 0 ? '+' : '';

      return `📌 **МФЦ МО за прошлую неделю** (предыдущий срез за ${mfcNow.deltaDays} дн. до ${curr.date}):
• **Выполнение на предыдущем срезе:** **${prevMfcVal} чел.**${mfcNow.plan ? ` (план ${mfcNow.plan} чел., ${prevPct}%)` : ''}
• **На текущем срезе (${curr.date}):** **${mfcNow.fact} чел.**${mfcNow.percent !== null ? ` (${mfcNow.percent}% от плана)` : ''}
• **Прирост:** ${sign}${mfcNow.delta} чел. за ${mfcNow.deltaDays} дн.
• **Источник данных:** ${mfcNow.source}
• **Где на экране:** карточка «МФЦ МО» в сетке показателей и зеленая круговая диаграмма. Переключиться на прошлую неделю можно также в выпадающем списке «Срез» вверху экрана.`;
    }

    // 4. Запрос на тезисы к планёрке
    if (q.includes('тезис') || q.includes('планёрк') || q.includes('планерк') || q.includes('итог')) {
      return this.formatTheses(currentDetails);
    }
    if (q.includes('мфц')) {
      const mfc = cards.find(c => c.key === 'mfc');
      return `📌 **МФЦ МО** на текущем срезе (${curr.date}):
• **Выполнение (факт):** ${mfc.fact} чел.
• **План:** ${mfc.plan} чел.
• **Процент выполнения:** ${mfc.percent}%
• **Прирост за неделю:** +${mfc.delta} чел.
• **Источник данных:** ${mfc.source}
• **Где на экране:** Карточка «МФЦ МО» в сетке показателей и 3-я круговая диаграмма (зеленое кольцо).`;
    }

    // 4. Запрос на выгрузку в Excel
    if (q.includes('выгруз') || q.includes('excel') || q.includes('экспорт') || q.includes('скачать')) {
      return `📥 **Готово! Ссылки для выгрузки в Excel сформированы:**

1. [Скачать срез текущей недели (${curr.date}) в Excel](/api/export/current?id=${curr.id})
2. [Скачать полную историю по неделям в Excel](/api/export/history)

Файлы сформированы точно так же, как при нажатии кнопки «Экспорт» в верхнем меню дашборда. В них содержатся только количественные показатели и прогресс, без персональных данных.`;
    }

    // 5. Запрос по Госзаданию
    if (q.includes('госзадан') || q.includes('гз')) {
      const gz = cards.find(c => c.key === 'gz');
      return `📌 **Государственное задание** на ${curr.date}:
• **Выполнение (факт):** ${gz.fact.toLocaleString('ru-RU')} чел.
• **План:** ${gz.plan.toLocaleString('ru-RU')} чел.
• **Процент выполнения:** ${gz.percent}%
• **Прирост за неделю:** +${gz.delta} чел.
• **Источник данных:** ${gz.source}
• **Где на экране:** 1-я карточка в сетке показателей и 1-я круговая диаграмма (синее кольцо).`;
    }

    // 6. Запрос по ОМСУ
    if (q.includes('омсу') || q.includes('хозрасчет') || q.includes('платн')) {
      const omsu = cards.find(c => c.key === 'omsu');
      return `📌 **ОМСУ и подведы (платное / хозрасчет)** на ${curr.date}:
• **Выполнение (факт):** ${omsu.fact} чел.
• **План:** не устанавливается (хозрасчет)
• **Прирост за неделю:** +${omsu.delta} чел.
• **Источник данных:** ${omsu.source}
• **Где на экране:** 4-я карточка в сетке показателей и блок хозрасчета.`;
    }

    // 7. Запрос по общему итогу
    if (q.includes('общий') || q.includes('итог') || q.includes('всего') || q.includes('охват')) {
      const total = cards.find(c => c.key === 'total');
      const gz = cards.find(c => c.key === 'gz');
      const mfc = cards.find(c => c.key === 'mfc');
      const omsu = cards.find(c => c.key === 'omsu');
      const deltaSign = total?.delta >= 0 ? '+' : '';
      return `📌 **Общий итог по обучению** на ${curr.date}:
• **Суммарный факт:** **${(total?.fact || 0).toLocaleString('ru-RU')} чел.**
• **Прирост за неделю:** ${total?.delta !== null ? `${deltaSign}${total.delta} чел.` : 'базовый период'}
• **Формула:** Госзадание (${(gz?.fact || 0).toLocaleString('ru-RU')}) + МФЦ МО (${(mfc?.fact || 0).toLocaleString('ru-RU')}) + ОМСУ (${(omsu?.fact || 0).toLocaleString('ru-RU')}). Согласно PRD КВЦ в общий итог не включается.
• **Где на экране:** Большая градиентная индиго-карточка «Сводный охват» в верхней части дашборда.`;
    }

    // 8. Общий обзор / помощь
    const totalCard = cards.find(c => c.key === 'total');
    const gzCard = cards.find(c => c.key === 'gz');
    const kvcCard = cards.find(c => c.key === 'kvc');
    const mfcCard = cards.find(c => c.key === 'mfc');
    const omsuCard = cards.find(c => c.key === 'omsu');
    const totalDeltaStr = totalCard?.delta !== null ? `(${totalCard.delta >= 0 ? '+' : ''}${totalCard.delta} за неделю)` : '(базовый период)';

    return `Здравствуйте! Я — ИИ-помощник дашборда учебного отдела.

Я знаю все цифры текущего среза на **${curr.date}**:
• **Общий итог:** ${(totalCard?.fact || 0).toLocaleString('ru-RU')} чел. ${totalDeltaStr}
• **Государственное задание:** ${(gzCard?.fact || 0).toLocaleString('ru-RU')} из ${(gzCard?.plan || 0).toLocaleString('ru-RU')} чел. (${gzCard?.percent || 0}%)
• **КВЦ:** ${(kvcCard?.fact || 0).toLocaleString('ru-RU')} из ${(kvcCard?.plan || 0).toLocaleString('ru-RU')} чел. (${kvcCard?.percent || 0}%)
• **МФЦ МО:** ${(mfcCard?.fact || 0).toLocaleString('ru-RU')} из ${(mfcCard?.plan || 0).toLocaleString('ru-RU')} чел. (${mfcCard?.percent || 0}%)
• **ОМСУ (платное):** ${(omsuCard?.fact || 0).toLocaleString('ru-RU')} чел.

💬 Вы можете спросить меня:
• *«Хочу посмотреть КВЦ»*
• *«Покажи МФЦ за прошлую неделю»*
• *«Выгрузи всё в Excel»*
• *«Откуда цифра по Госзаданию?»*`;
  }

  formatTheses(currentDetails) {
    const curr = currentDetails.snapshot;
    const cards = currentDetails.cards;
    const fmt = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));
    const sign = n => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${fmt(n)}`);
    const expPct = currentDetails.yearMetrics?.expectedPercent;
    const weeksLeft = Math.round(currentDetails.yearMetrics?.remainingWeeks || 0);
    const total = cards.find(c => c.key === 'total');
    const known = cards.filter(c => !c.noData);

    if (known.length === 0) {
      return `📋 **Тезисы к планёрке (${curr.date}):** на эту дату в источниках нет данных по показателям.`;
    }

    const lines = [`📋 **Тезисы к планёрке учебного отдела (${curr.date}):**`, ''];

    lines.push('1. **Сводный результат:**');
    if (total && !total.noData) {
      lines.push(`   • Общий охват: **${fmt(total.fact)} чел.** (${sign(total.delta)}${total.deltaDays ? ` за ${total.deltaDays} дн.` : ''}; текущий темп ${sign(total.currentPace)}/нед).`);
    } else {
      lines.push('   • Общий итог на эту дату в источниках не указан.');
    }
    if (expPct !== undefined) lines.push(`   • Пройдено **${expPct}%** года, до конца года ~**${weeksLeft}** недель.`);
    lines.push('');

    lines.push(`2. **По направлениям (норма на дату — ${expPct}% плана):**`);
    known.filter(c => c.plan).forEach(c => {
      const state = c.status === 'on_track' ? 'в графике' : `отставание −${c.lagPercent} п.п.`;
      lines.push(`   • **${c.shortTitle}:** ${fmt(c.fact)} из ${fmt(c.plan)} чел. (${c.percent}%), ${state}. Нужный темп +${fmt(c.requiredPace)}/нед, текущий ${sign(c.currentPace)}/нед; прогноз на 31.12 — ${fmt(c.forecast3112)} чел. (${c.forecastPercent}%).`);
    });
    known.filter(c => !c.plan && c.key !== 'total').forEach(c => {
      lines.push(`   • **${c.shortTitle}:** ${fmt(c.fact)} чел. (${sign(c.delta)}${c.deltaDays ? ` за ${c.deltaDays} дн.` : ''}); норматив не задан.`);
    });
    lines.push('');

    const disc = known.filter(c => c.discrepancy);
    if (disc.length) {
      lines.push('3. **Расхождения источников:**');
      disc.forEach(c => lines.push(`   • ${c.shortTitle}: ${c.discrepancy.message}.`));
      lines.push('');
    }

    const commented = known.filter(c => c.comments && (c.comments.reason || c.comments.solution));
    lines.push(`${disc.length ? 4 : 3}. **Решения по отставанию (из «Плана действий»):**`);
    if (commented.length) {
      commented.forEach(c => {
        const cm = c.comments;
        lines.push(`   • **${c.shortTitle}:** ${cm.reason ? 'причина — ' + cm.reason + '; ' : ''}${cm.solution ? 'решение — ' + cm.solution : ''}${cm.assignee ? ' (ответственный: ' + cm.assignee + (cm.deadline ? ', срок ' + cm.deadline : '') + ')' : ''}.`);
      });
    } else {
      lines.push('   • Решения пока не зафиксированы: их можно внести в карточке «План действий» по каждому направлению.');
    }
    return lines.join('\n');
  }
}

module.exports = new GigaChatService();
