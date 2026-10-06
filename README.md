# Дашборд учебного отдела

Мониторинг план-факта обучения. Сервер на Node.js (Express), интерфейс в папке `public/`.

## Запуск

```bash
npm install
cp .env.example .env   # заполните значения
npm start
```

Приложение откроется на http://localhost:3000.

## Данные

В репозитории нет рабочих данных. `data.json` создаётся при первом запуске; выгрузки статусов, презентации и анкеты хранятся вне git (см. `.gitignore`) и задаются переменными `DATA_FILE`, `STATUS_DIR`, `PRESENTATION_DIR`, `FEEDBACK_DIR`.

Подробное описание проекта: [PROJECT_HANDOVER.md](PROJECT_HANDOVER.md).
