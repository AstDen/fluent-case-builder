# `learning/` — петля обучения `fluent-case-builder`

Здесь собираются отчёты коллег и агрегируется бэклог для мейнтейнера плагина.
Подробный процесс — [`docs/MAINTAINING.md`](../docs/MAINTAINING.md), контракт отчёта —
[`docs/REPORT_FORMAT.md`](../docs/REPORT_FORMAT.md).

## Структура

```
learning/
├── README.md          # этот файл: что куда класть и что коммитится
├── inbox/             # СЫРЫЕ отчёты коллег (.json) — НЕ коммитятся
│   └── .gitkeep
├── aggregate.json     # агрегат по id отчётов — коммитится (генерируется)
└── backlog.md         # человекочитаемый бэклог — коммитится (генерируется)
```

## Что делать коллеге

1. Сгенерировать отчёт инструментом `fluent_task_report` (JSON + Markdown).
2. Прислать мейнтейнеру JSON-файл (Markdown — для чтения, ingest его не читает).
3. Не класть в отчёт секреты, токены и лицензионные ключи.

## Что делает мейнтейнер

```bash
# 1. Положить присланные .json в learning/inbox/ (можно подкаталогами)
# 2. Обновить агрегат и бэклог:
node scripts/ingest-report.mjs

# то же явно, с отдельным каталогом вывода:
node scripts/ingest-report.mjs learning/inbox --out learning

# пересобрать агрегат с нуля (дедуп внутри запуска сохраняется):
node scripts/ingest-report.mjs --no-merge

# только предпросмотр: произвольные файлы/каталоги
node scripts/ingest-report.mjs path/to/reports
```

Скрипт дедуплицирует отчёты по `id`, поэтому повторный ingest того же inbox не удваивает
статистику. Невалидные файлы (чужой `schema`, нет `id`, битый JSON) пропускаются
с предупреждением, exit code остаётся 0.

## Политика версионирования

- **Коммитятся:** `learning/README.md`, `learning/aggregate.json`, `learning/backlog.md`.
- **Не коммитятся:** всё содержимое `learning/inbox/` (кроме `.gitkeep`) — это сырые отчёты
  коллег с путями и именами их машин. В `.gitignore` должно быть:

  ```gitignore
  learning/inbox/*
  !learning/inbox/.gitkeep
  ```

- Агрегат содержит только сводные карточки: id, версии, вердикты, находки, пробелы, счётчики
  хостов/ОС. Лицензионные серверы и ключи в агрегат не попадают.

## Что дальше

Идти по `learning/backlog.md`: проверить гипотезы в живой сессии Fluent, обновить
`data/recipes/`, `data/rules/`, `data/profiles/`, обновить `CHANGELOG.md` и версию, поставить
git-тег. Полный чек-лист — в [`docs/MAINTAINING.md`](../docs/MAINTAINING.md).
