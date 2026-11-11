# Формат отчёта о задаче (`report@1`) — «петля обучения»

Отчёт — **один самодостаточный JSON-файл**, который коллега генерирует инструментом
`fluent_task_report` и присылает мейнтейнеру. Мейнтейнер складывает отчёты в `learning/inbox/`
и запускает `node scripts/ingest-report.mjs`, получая агрегированный бэклог: какие вопросы,
рецепты, диагностики, профили и версии ANSYS нужно добавить в плагин.

Рядом с JSON пишется человекочитаемый `.md` с тем же содержимым.

```json
{
  "schema": "fluent-case-builder/report@1",
  "id": "2026-11-11T09:40:00.000Z-1a2b3c4d",
  "generatedAt": "2026-11-11T09:40:00.000Z",
  "generator": {
    "plugin": "fluent-case-builder",
    "pluginVersion": "0.2.0",
    "dshProfile": "web"
  },
  "environment": {
    "os": "Linux 6.8.0 x86_64",
    "hostname": "ast-daniil",
    "node": "v22.23.4",
    "python3": "Python 3.10.13",
    "fluent": { "path": "/home/user/ansys_inc/v261/fluent/bin/fluent", "version": "2026 R1", "build": "10262", "source": "run-log|path|config|unknown" },
    "license": { "server": "1055@localhost", "features": ["..."], "source": "log|config" },
    "hardware": { "cpus": 32 }
  },
  "task": {
    "title": "Сверхзвуковое сопло, Mach 2.5",
    "kind": "gas-dynamics",
    "description": "что считаем и зачем",
    "expectations": "какой результат нужен",
    "notes": ["заметки по ходу"],
    "questionsForMaintainer": ["почему не сгенерировался inlet BC?"],
    "appVersion": "2026 R1",
    "ansysVersions": ["2026 R1"]
  },
  "interview": {
    "answers": { "task.kind": "gas-dynamics", "mach": 2.5 },
    "completeness": { "total": 65, "answered": 12, "required": 20, "requiredAnswered": 8, "missingRequired": ["mesh.file"] },
    "recommendations": { "solver.type": "density-based-implicit" },
    "matchedRules": [{ "id": "solver.mach-density-based", "status": "derived", "why": "...", "source": "..." }]
  },
  "case": {
    "mode": "profile | spec | existing | none",
    "profile": { "id": "example-channel", "params": {}, "preset": "quick" },
    "spec": {},
    "caseDir": "/path/to/case",
    "files": ["setup_case.jou", "start.sh"],
    "warnings": [],
    "outputs": [{ "path": "...cas.h5", "exists": true, "bytes": 4908645 }]
  },
  "generation": {
    "created": [{ "kind": "template", "path": "setup_case.jou" }],
    "validation": { "total": 98, "exact": 74, "container": 16, "hiddenKnown": 3, "journal2025": 4, "unknown": 0, "verdict": "ok-with-2025-syntax" }
  },
  "run": {
    "name": "setup",
    "status": "finished | failed | running | absent",
    "command": "fluent 3ddp -g -t2 -mpi=intel -affinity=core -i setup_case.jou",
    "durationSec": 79,
    "errors": [],
    "invalidCommands": [],
    "outputsPresent": true,
    "logFile": ".run/setup.log",
    "logTail": "…последние N строк…"
  },
  "analysis": {
    "verdict": "configured | failed | incomplete | analyzed",
    "stages": [
      { "stage": "mesh-read", "status": "ok", "evidence": "Reading \"mesh_region_fluid.msh\"" }
    ],
    "coverage": {
      "journalLines": 98,
      "byStatus": { "verified": 74, "derived": 16, "journal-2025": 4, "hidden": 3, "unknown": 0 },
      "recipesUsed": [{ "id": "models.energy", "status": "verified", "lines": 1 }],
      "unknownLines": [],
      "unverifiedSteps": []
    },
    "findings": [
      {
        "severity": "error | warning | info",
        "code": "<id из data/rules/diagnostics.json, напр. invalid-command-batch-confirm | license | udf-compile | crash | kb-gap>",
        "message": "что произошло",
        "journalLine": "строка журнала, если известна",
        "recipeId": "id рецепта, если применимо",
        "recommendation": "что делать",
        "source": "KB-файл или протокол",
        "count": 1,
        "examples": ["первая строка лога, если полезна"]
      }
    ],
    "gaps": [
      { "kind": "unsupported-step | unverified-recipe | missing-question | kb-gap | version-mismatch | documentation", "detail": "…", "frequency": 1 }
    ]
  },
  "artifacts": {
    "reportJson": "analysis/…-report.json",
    "reportMarkdown": "analysis/…-report.md",
    "notesFile": "analysis/task-notes.jsonl",
    "includedLogBytes": 51200,
    "truncated": false
  }
}
```

## Правила заполнения

- `interview` может быть `null` (отчёт без интервью); `case.mode` — `profile`, `spec`, `existing` (отчёт по готовому кейсу) или `none`.

- `id` — уникален: `<generatedAt>-<hash>`, по нему ingest дедуплицирует отчёты.
- `environment.fluent.version/build` берётся из лога запуска Fluent (строки `Build Id`, `Welcome to ANSYS Fluent`); иначе версия выводится из пути (`source: "path"`, например `v261`); иначе `unknown`. Это нужно для поддержки нескольких версий ANSYS.
- `analysis.findings` — главная ценность: каждая проблема с кодом и рекомендацией. Набор кодов — в `data/rules/diagnostics.json` (12 кодов на 0.2.0); каждый finding несёт `severity`, `code`, `message`, `recommendation`, `source` и опционально `examples[]`.
- `analysis.gaps` — чего не хватило плагину: шаг не поддержан (`unsupported-step`), рецепт не проверен (`unverified-recipe`), не было вопроса в интервью (`missing-question`), пробел в KB (`kb-gap`), расхождение версий (`version-mismatch`).
- `case.spec` (для универсального пути) сохраняется целиком — по нему мейнтейнер видит, какие поля спеки нужно поддержать.
- Логи усекаются (`maxLogLines`, общий лимит ~400 КБ (TOTAL_LOG_LIMIT в lib/report.js)); `truncated: true`, если усечение было.
- Лицензия пишется только в `environment.license` (`server`, `features[]`, `source`); в `environment.fluent` её нет.
- Никаких секретов/токенов: пути и имена хостов допустимы, лицензионные ключи — нет.

## Что делает мейнтейнер

1. `node scripts/ingest-report.mjs learning/inbox --out learning` — обновляет `learning/aggregate.json` и `learning/backlog.md`.
2. Смотрит бэклог: топ `unsupported-step` → что проверить в живой сессии; топ `missing-question` → что добавить в `data/rules/questions.json`; топ ошибок → что добавить в `data/rules/diagnostics.json`; новые версии ANSYS → что перепроверить.
3. Проверяет факты в живой сессии Fluent, добавляет рецепты/правила/вопросы/профили, повышает статусы (`unverified → verified`), обновляет `CHANGELOG.md` и версию.
4. Коммит + тег — коллеги обновляют плагин и получают новые знания.
