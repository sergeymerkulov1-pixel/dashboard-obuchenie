const XLSX = require('xlsx');

class ExcelService {
  /**
   * Генерация Excel для текущего среза
   */
  generateCurrentSnapshotExcel(details) {
    const wb = XLSX.utils.book_new();

    const titleRow = [`Дашборд учебного отдела — Срез на ${details.snapshot.date}`];
    const subTitleRow = [
      `Сформирован: ${new Date().toLocaleString('ru-RU')}`,
      `Тип среза: ${details.snapshot.isAutomatic ? 'Автоматический' : 'Ручной'}`,
      details.previousDate ? `Сравнение с: ${details.previousDate}` : 'Базовый период'
    ];
    const emptyRow = [];
    const headerRow = [
      'Показатель',
      'Категория',
      'План (чел.)',
      'Факт (чел.)',
      'Выполнение (%)',
      'Ожидаемо к дате',
      'Прирост (чел.)',
      'Нужный темп (чел./нед)',
      'Прогноз на 31.12',
      'Источник данных',
      'Ручная правка'
    ];

    const dataRows = details.cards.map(c => [
      c.title,
      c.category,
      c.plan !== null ? c.plan : '—',
      c.noData ? '—' : c.fact,
      c.percent !== null ? `${c.percent}%` : '—',
      c.expectedFact !== null ? `${c.expectedFact} (${c.expectedPercent}%)` : '—',
      c.delta !== null ? (c.delta > 0 ? `+${c.delta}` : `${c.delta}`) : '—',
      c.requiredPace !== null ? (c.requiredPace > 0 ? `+${c.requiredPace}/нед` : '0/нед') : '—',
      c.forecast3112 !== null ? `${c.forecast3112}${c.forecastPercent !== null ? ` (${c.forecastPercent}%)` : ''}` : '—',
      c.source,
      c.isOverridden ? `Да (${c.overrideInfo?.author || 'Администратор'}: ${c.overrideInfo?.note || 'правка'})` : 'Нет'
    ]);

    const wsData = [
      titleRow,
      subTitleRow,
      emptyRow,
      headerRow,
      ...dataRows
    ];

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Установка ширины колонок
    ws['!cols'] = [
      { wch: 32 }, // Показатель
      { wch: 18 }, // Категория
      { wch: 14 }, // План
      { wch: 14 }, // Факт
      { wch: 16 }, // Выполнение
      { wch: 20 }, // Ожидаемо к дате
      { wch: 16 }, // Прирост
      { wch: 22 }, // Нужный темп
      { wch: 20 }, // Прогноз на 31.12
      { wch: 45 }, // Источник
      { wch: 30 }  // Правка
    ];

    XLSX.utils.book_append_sheet(wb, ws, `Срез_${details.snapshot.date}`);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  /**
   * Генерация Excel для всей истории по неделям
   */
  generateHistoryExcel(snapshots) {
    const wb = XLSX.utils.book_new();

    const header = ['Показатель', 'План'];
    snapshots.forEach(s => {
      header.push(s.date);
    });

    const indicatorNames = {
      gz: { title: 'Государственное задание', plan: 3660 },
      mfc: { title: 'МФЦ МО', plan: 702 },
      kvc: { title: 'КВЦ (открытые курсы)', plan: 3000 },
      omsu: { title: 'ОМСУ и подведы (платное)', plan: '—' },
      total: { title: 'Общий итог (без КВЦ)', plan: '—' }
    };

    const rows = [];
    for (const [key, meta] of Object.entries(indicatorNames)) {
      const row = [meta.title, meta.plan];
      snapshots.forEach(s => {
        const ind = s.indicators[key] || { fact: s.virtual ? '—' : 0 };
        const val = ind.override ? ind.override.value : ind.fact;
        const mark = ind.override ? '*' : (ind.carried ? '~' : '');
        row.push(`${val}${mark}`);
      });
      rows.push(row);
    }

    const noteRow = ['* — значение скорректировано администратором вручную; ~ — на дату в еженедельных статусах показателя нет, показано значение из последней презентации планёрки (или предыдущей даты)'];

    const wsData = [
      ['История динамики показателей учебного отдела по неделям'],
      [`Дата выгрузки: ${new Date().toLocaleString('ru-RU')}`],
      [],
      header,
      ...rows,
      [],
      noteRow
    ];

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 34 },
      { wch: 12 },
      ...snapshots.map(() => ({ wch: 14 }))
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Динамика_по_неделям');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  /**
   * Парсинг загруженного файла Excel
   */
  parseUploadedExcel(bufferOrPath) {
    const wb = typeof bufferOrPath === 'string'
      ? XLSX.readFile(bufferOrPath)
      : XLSX.read(bufferOrPath, { type: 'buffer' });

    const result = {
      gz: null,
      mfc: null,
      kvc: null,
      omsu: null,
      total: null,
      details: []
    };

    // 1. Попытка найти специальный лист "Дашборд" или "Свод"
    const sheetNames = wb.SheetNames;
    
    // Проверим каждый лист
    sheetNames.forEach(sheetName => {
      const ws = wb.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const lowerSheet = sheetName.toLowerCase();

      // Лист с цифрами дашборда
      if (lowerSheet.includes('дашборд') || lowerSheet.includes('свод') || lowerSheet.includes('итог')) {
        json.forEach(row => {
          if (!Array.isArray(row) || row.length < 2) return;
          const text = String(row[0]).toLowerCase();
          const val = Number(row[1]);
          if (isNaN(val)) return;

          if (text.includes('госзадан') || text.includes('гз')) result.gz = val;
          else if (text.includes('мфц')) result.mfc = val;
          else if (text.includes('квц')) result.kvc = val;
          else if (text.includes('омсу') || text.includes('хозрасчет')) result.omsu = val;
          else if (text.includes('общий') || text.includes('всего')) result.total = val;
        });
      }

      // Лист «факт гз 2026»
      if (lowerSheet.includes('факт гз') || lowerSheet.includes('гз')) {
        let sum = 0;
        json.forEach(row => {
          row.forEach(cell => {
            const num = Number(cell);
            // Если находим итоговые числа типа 1582, 411 или общую сумму
            if (!isNaN(num) && num > 100 && num < 5000) {
              // эвристика для листа факт гз
            }
          });
        });
      }

      // Лист «открытые курсы»
      if (lowerSheet.includes('открытые курсы') || lowerSheet.includes('квц')) {
        // Поиск КВЦ
      }

      // Лист «хозрасчет»
      if (lowerSheet.includes('хозрасчет')) {
        // Поиск ОМСУ
      }
    });

    // Универсальный проход по первой странице, если ничего не определилось
    if (result.gz === null && result.mfc === null && result.kvc === null && sheetNames.length > 0) {
      const firstSheet = wb.Sheets[sheetNames[0]];
      const json = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
      json.forEach(row => {
        if (!Array.isArray(row) || row.length < 2) return;
        const text = String(row[0]).toLowerCase();
        const val = Number(row[1]);
        if (isNaN(val)) return;

        if (text.includes('гос') || text.includes('гз')) result.gz = val;
        else if (text.includes('мфц')) result.mfc = val;
        else if (text.includes('квц')) result.kvc = val;
        else if (text.includes('омсу')) result.omsu = val;
        else if (text.includes('итог') || text.includes('всего')) result.total = val;
      });
    }

    return result;
  }
}

module.exports = new ExcelService();
