# MAINTAINING — петля обучения `fluent-case-builder`

Документ для мейнтейнера плагина: как принимать отчёты коллег, превращать их в бэклог,
проверять гипотезы в живой сессии ANSYS Fluent и выпускать новые версии знаний.

Связанные документы:

- [`REPORT_FORMAT.md`](REPORT_FORMAT.md) — контракт отчёта `report@1`;
- [`FORMATS.md`](FORMATS.md) — форматы профилей, рецептов, правил, вопросов;
- [`CASE_SPEC.md`](CASE_SPEC.md) — универсальная спецификация кейса;
- [`USAGE.md`](USAGE.md) — сценарии использования плагина.

---

## 1. Как устроена петля

```
коллега
  │  fluent_task_report(...)
  ▼
report.json  (schema: fluent-case-builder/report@1)  + report.md для чтения
  │  присылает мейнтейнеру
  ▼
learning/inbox/            ← сырые отчёты, НЕ коммитятся
  │  node scripts/ingest-report.mjs
  ▼
learning/aggregate.json    ← машиночитаемый агрегат (дедуп по id), коммитится
learning/backlog.md        ← человекочитаемый бэклог, коммитится
  │  мейнтейнер разбирает бэклог
  ▼
живая сессия Fluent        ← проверка гипотез, снятие build/версии, журнальные строки
  │
  ▼
data/recipes/  data/rules/  data/profiles/  docs/  KB
  │  CHANGELOG.md + semver + git tag
  ▼
коллеги обновляют плагин и получают новые знания
```

Принцип: **код не меняется от отчёта к отчёту**. Отчёт пополняет данные (`data/`) и, при
необходимости, диагностику. Если для нового поведения нужен код — это отдельный PR с тестами.

---

## 2. Приём отчётов

1. Коллега присылает **JSON-файл** отчёта (`schema: "fluent-case-builder/report@1"`,
   уникальный `id` вида `<generatedAt>-<hash>`). Рядом идёт `.md` — он только для чтения.
2. Положить JSON в `learning/inbox/`. Можно раскладывать по подкаталогам
   (`learning/inbox/2026-11/`, `learning/inbox/colleague-name/`) — ingest обходит рекурсивно.
3. Файл можно переименовать как удобно: идентичность отчёта — поле `id`, а не имя файла.
4. **Не коммитить** содержимое `learning/inbox/`: это сырые данные с путями и именами машин
   коллег. В `.gitignore` пакета должно быть:

   ```gitignore
   learning/inbox/*
   !learning/inbox/.gitkeep
   ```

5. Прогнать ingest (см. ниже), посмотреть `learning/backlog.md`, закоммитить
   `learning/aggregate.json` и `learning/backlog.md`.

Если отчёт содержит секреты (токены, пароли, лицензионные ключи) — **не класть его в inbox**,
попросить коллегу пересоздать отчёт без секретов. Имена хостов и пути допустимы контрактом.

---

## 3. Ingest: команды и поведение

Скрипт: `scripts/ingest-report.mjs`. Node.js >= 20, ESM, без внешних зависимостей.
Он **не импортирует `lib/`** плагина и работает без установленного DSH.

```bash
# базовый сценарий: learning/inbox/ → learning/aggregate.json + learning/backlog.md
node scripts/ingest-report.mjs

# явные вход и выход (несколько путей: файлы и/или каталоги)
node scripts/ingest-report.mjs learning/inbox --out learning
node scripts/ingest-report.mjs report-1.json path/to/reports/ --out /tmp/agg

# пересобрать агрегат с нуля (дедуп внутри запуска сохраняется)
node scripts/ingest-report.mjs --no-merge

# предпросмотр на отдельном каталоге, не трогая learning/
node scripts/ingest-report.mjs /tmp/reports --out /tmp/agg
```

Поведение:

| Ситуация | Что делает ingest |
|---|---|
| JSON с `schema: "fluent-case-builder/report@1"` и непустым `id` | читает как отчёт |
| другой `schema`, нет `id`, битый JSON | `⚠ пропущен <файл>: <причина>` в stderr, пропуск, **exit 0** |
| не-JSON файлы (`.md`, `.txt`, `.gitkeep`) | молча пропускает |
| собственный `aggregate.json` во входе | распознаёт по схеме и пропускает |
| несуществующий вход | предупреждение, остальные входы обрабатываются, exit 0 |
| повторный запуск по тому же inbox | дедуп по `id`: `reportsTotal` не растёт |
| `--merge` (по умолчанию) | дополняет существующий `aggregate.json`, старые отчёты не теряются |
| `--no-merge` | игнорирует старый агрегат и пересобирает его из входов |

Выход: `aggregate.json` (`schema: "fluent-case-builder/aggregate@1"`) и `backlog.md`.
Итоговая сводка (сколько прочитано / новых / дубликатов / невалидных, топ-числа, пути файлов)
печатается в stdout. Коды выхода: `0` — успех (в том числе пустой inbox), `1` — ошибка
чтения/записи, `2` — неверные аргументы.

### Структура `aggregate.json`

```jsonc
{
  "schema": "fluent-case-builder/aggregate@1",
  "updatedAt": "2026-11-11T09:42:46.146Z",
  "generator": { "script": "scripts/ingest-report.mjs", "format": 1 },
  "ingest": {
    "lastRunAt": "...", "merged": true, "inputs": ["inbox"],
    "filesScanned": 8, "reportsFound": 5, "reportsAdded": 0, "reportsReplaced": 0,
    "reportsBeforeMerge": 4, "reportsTotal": 4, "duplicates": 5,
    "invalid": [{ "file": "broken.json", "reason": "невалидный JSON: ..." }],
    "nonJsonSkipped": ["notes.txt"], "missingInputs": []
  },
  "reports": {
    "2026-11-01T10:00:00.000Z-aaaa1111": {
      "id": "...", "generatedAt": "...", "ingestedAt": "...", "sourceFile": "report-1.json",
      "plugin": "0.2.0",
      "environment": { "os": "...", "hostname": "...", "fluent": { "version": "2026 R1", "build": "10262", "source": "run-log" } },
      "task": { "kind": "gas-dynamics", "title": "...", "ansysVersions": ["2026 R1"] },
      "case": { "mode": "spec", "profileId": null },
      "verdict": "analyzed", "runStatus": "finished", "generationVerdict": "needs-review",
      "completeness": { "total": 65, "answered": 12, "required": 20, "requiredAnswered": 8 },
      "counts": { "findings": 2, "gaps": 2, "unsupportedSteps": 1, "...": 0 },
      "findings": [ { "code": "syntax-version", "severity": "warning", "message": "...", "recommendation": "...", "recipeId": null, "count": 1 } ],
      "gaps": [ { "kind": "unsupported-step", "detail": "pressure-outlet BC", "frequency": 1 } ],
      "unsupportedSteps": [ { "step": "pressure-outlet BC", "reason": "..." } ],
      "unverifiedSteps": [], "unverifiedRecipes": [ { "id": "boundary.velocity-inlet.chain", "status": "derived", "lines": 3 } ],
      "unknownLines": ["/solve/set/pseudo-time-method"],
      "missingRequired": ["mesh.file", "boundary.inlet"],
      "questionsForMaintainer": ["..."], "notes": ["..."],
      "runErrors": [], "caseWarnings": []
    }
  },
  "stats": {
    "reportsTotal": 4,
    "pluginVersions": { "0.2.0": 3 },
    "fluentVersions": { "2026 R1": { "count": 2, "reports": ["..."], "builds": { "10262": 2 } } },
    "ansysVersions": { "2026 R1": 1 },
    "taskKinds": { "gas-dynamics": 1 },
    "verdicts": { "analyzed": 1 },
    "findingsByCode": { "syntax-version": 1 },
    "findingsBySeverity": { "warning": 1 },
    "gapsByKind": { "unsupported-step": 2 },
    "unsupportedSteps": [ { "step": "pressure-outlet BC", "count": 2, "reports": ["id1", "id2"] } ],
    "unknownJournalLines": [ { "line": "...", "count": 1, "reports": ["id"] } ],
    "missingRequiredQuestions": [ { "id": "mesh.file", "count": 1, "reports": ["id"] } ],
    "openQuestions": [ { "text": "...", "kind": "maintainer", "count": 1, "reports": ["id"] } ],
    "notes": [ { "text": "...", "count": 1, "reports": ["id"] } ],
    "kbGaps": [ { "detail": "...", "kind": "kb-gap", "count": 2, "reports": ["id"] } ],
    "hostsCount": 2, "osCount": 3,
    "ansysVersionConflicts": [ { "conflict": "заявлено 2025 R2 / в логе 2026 R1", "count": 1, "reports": ["id"] } ]
  }
}
```

Правила данных агрегата:

- `count` у `findingsBy*`/`gapsByKind` — **сумма** `count`/`frequency` из отчётов;
  у списочных статистик (`unsupportedSteps` и т.п.) `count` — число отчётов, где встретилось,
  `reports` — 1–3 id-примера.
- Агрегат — производный артефакт: ручные правки будут перезаписаны при следующем ingest.
  Если нужно поправить формулировку — правьте данные/документацию, а не агрегат.
- Секретов в агрегате нет: лицензионные серверы/ключи не копируются, хосты и ОС — только
  счётчики `hostsCount`/`osCount` в `stats`; полные логи в агрегат не попадают.

---

## 4. Как читать `backlog.md`

Заголовок: дата обновления и число отчётов в агрегате. Разделы:

| Раздел | Что означает | Куда вести работу |
|---|---|---|
| **Проверить в живой сессии** | `unsupported-step`, непроверенные шаги `coverage.unverifiedSteps`, рецепты со статусом ≠ `verified`, строки журнала, которых нет в индексе команд | живая сессия Fluent → `data/recipes/*.json`, KB, `data/rules/diagnostics.json` |
| **Добавить вопросы интервью** | часто неотвеченные обязательные вопросы (`interview.completeness.missingRequired`) и гэпы `missing-question` | `data/rules/questions.json` |
| **Диагностика ошибок** | находки по `code` (частота, сообщение, рекомендация); отчёты с `failed` и пустыми `findings` | `data/rules/diagnostics.json`, анализ в `lib/rules.js` |
| **Версии ANSYS** | какие версии Fluent встречаются, `build`, откуда взята версия, расхождения `task.ansysVersions` ↔ лог | перепроверка рецептов на новых версиях, поле `verifiedOn` |
| **Запросы и заметки коллег** | `task.questionsForMaintainer`, `task.notes` | ответить коллеге, при необходимости — вопрос в интервью или диагностику |
| **Пробелы KB** | гэпы `kb-gap`/`documentation`, находки `kb-gap` | KB-документация, новые разделы, уточнение `source` |

Каждый пункт содержит частоту и 1–3 id-примера отчётов. Полные данные — в `aggregate.json`
(ищите отчёт по `id` в `reports`). Пустой inbox даёт бэклог с пометкой «данных пока нет» и
exit 0 — это нормальное состояние свежего пакета.

---

## 5. Проверка гипотезы в живой сессии Fluent

Проверять **только** на реальной лицензии и реальном Fluent; результат — единственный
источник статуса `verified`.

1. Взять из бэклога пункт и сформулировать проверяемую гипотезу, например:
   «строка `/solve/set/under-relaxation pressure 0.2` принимается Fluent 2026 R1 и меняет
   множитель релаксации».
2. Подготовить минимальный journal (чтение сетки/кейса + проверяемые строки + сохранение/выход),
   например:

   ```
   /file/read-case "case.cas.h5"
   /solve/set/under-relaxation pressure 0.2
   /file/write-case-data "verify"
   /exit
   ```

   В пакете для воспроизводимых прогонов уже есть профиль `example-channel` и рабочие журналы —
   используйте их как эталон.
3. Запустить в batch-режиме (`fluent 3ddp -g -t<N> -mpi=intel -affinity=core -i verify.jou`)
   и сохранить transcript/лог.
4. Зафиксировать в заметке: версию и build Fluent (строки `Welcome to ANSYS Fluent`,
   `Build Id`), дату, точную journal-строку, ответы интерактивных меню, результат
   (принято/ошибка/изменилось поведение), путь к логу.
5. Только после этого обновлять данные. Если проверить нельзя — оставить
   `status: "derived"`/`"unverified"` и честно указать, чего не хватает.

Не выдумывать journal-строки «по справке». Оффлайн-проверка `fluent_case_validate` по
`commands.csv` — вспомогательная, она не заменяет живой прогон.

---

## 6. Обновление данных

Все форматы описаны в [`FORMATS.md`](FORMATS.md). Ниже — что именно менять по итогам бэклога
и какие правила соблюдать.

### 6.1. Рецепты — `data/recipes/<id>.json`

Атомарный проверенный блок журнала. Шаблон:

```json
{
  "id": "solve.under-relaxation",
  "title": "Множители релаксации",
  "category": "solve",
  "status": "verified",
  "confidence": "high",
  "source": "07_SOLVER/deep_dive.md:141-168; живой прогон 2026-11-11",
  "verifiedOn": [
    {
      "fluent": "2026 R1",
      "build": "10262",
      "date": "2026-11-11",
      "evidence": "journal принят в batch-прогоне, значение изменилось в отчёте",
      "source": "transcript: verify-under-relaxation.log:12-20"
    }
  ],
  "date": "2026-11-11",
  "journal": ["/solve/set/under-relaxation pressure 0.2"],
  "interactive": "Under-Relaxation Factor for Pressure [0.3] → 0.2",
  "requires": [],
  "conflicts": [],
  "params": [],
  "notes": "…"
}
```

Правила:

- `status` ∈ `verified | derived | unverified`:
  - `verified` — строка проверена в живой сессии Fluent, есть `verifiedOn` с версией/build/датой
    и ссылкой на лог; `journal` заполнен;
  - `derived` — строки собраны из справки/чужих журналов, но в этой сессии не проверены;
    допустим непустой `journal`, компилятор такие шаги помечает как «требует проверки»;
  - `unverified` — известно только намерение/справка; `journal: []`, в `notes` — чего не хватает.
- `source` **обязателен** и указывает **файл и строки** KB/эталона:
  `04_MODELS/viscous.md:21-43`, `QA_LOG.md:104-117`, `temp_case_setting/...:28-30`.
  Ссылка «в KB» без файла/строк — не источник.
- `verifiedOn` **обязателен для `verified`**: массив проверок
  `{fluent, build, date, evidence, source}`. Одна и та же строка может быть проверена на
  нескольких версиях — тогда несколько элементов (сначала свежая).
- Если команда на новой версии изменилась/исчезла: не переписывать старый рецепт молча.
  Завести новый `id` (например `solve.under-relaxation.v2026`) с полем `appliesTo`
  (`{"fluent": "2026 R1"}`) или пометить старый `deprecatedIn`/`notes` — и явно указать это
  в `CHANGELOG.md`.
- `conflicts`/`requires` — по смыслу; не дублировать команды между рецептами.
- Оффлайн-валидатор и компилятор не должны сломаться: проверить
  `node scripts/smoke.mjs` и `fluent_case_validate` на демо-журнале.

### 6.2. Инженерные правила — `data/rules/physics-rules.json`

```json
{
  "id": "turbulence.re",
  "title": "Турбулентность при Re > 5000",
  "when": { "re": { ">=": 5000 } },
  "recommend": { "physics.turbulence.model": "kw-sst" },
  "why": "При Re>5000 течение турбулентное; в проверенном рабочем журнале включается k-ω SST.",
  "status": "derived",
  "confidence": "high",
  "source": "04_MODELS/viscous.md:21-43; ИНСТРУКЦИЯ-ПО-СОЗДАНИЮ-КЕЙСА.md",
  "recipes": ["models.viscous.kw-sst"]
}
```

- `when` — объект условий по путям case spec; значение — скаляр или
  `{">=",">","<","<=","in":[...]}`.
- Каждое правило: уникальный `id`, `why`, `status`, `confidence`, `source` (файл:строки),
  `recipes` — какие рецепты реализуют рекомендацию.
- Новое правило из отчёта: если оно следует только из практики коллеги — `derived`, пока не
  подтверждено эталоном/живой проверкой; правило, противоречащее существующему, не добавлять
  молча — обсудить и обновить оба.

### 6.3. Вопросы интервью — `data/rules/questions.json`

```json
{
  "id": "mesh.units",
  "text": "В каких единицах задана геометрия сетки?",
  "type": "enum",
  "values": ["m", "mm", "cm", "in"],
  "default": "mm",
  "why": "от единиц зависит необходимость /mesh/scale",
  "specPath": "mesh.units",
  "required": true
}
```

- Раздел бэклога «Добавить вопросы интервью» → добавить вопрос в подходящую секцию.
- `id` — стабильный (`section.name`), `specPath` — реальный путь case spec
  (см. `CASE_SPEC.md`), `required` — только если без ответа кейс не собрать.
- Дублировать вопросы нельзя: ищите по `specPath`/`id` (бэклог уже показывает id
  из `interview.completeness.missingRequired` — вопросы с такими id должны существовать).
- После правки — пройти интервью вручную: `fluent_case_interview({answers:{...}})` не должен
  падать и должен возвращать `next[]`/`completeness`.

### 6.4. Диагностика ошибок — `data/rules/diagnostics.json`

Реестр кодов находок: `data/rules/diagnostics.json` (уже существует, `version: 1`, 12 кодов).
Коды из `analysis.findings[].code` должны быть здесь описаны — файл пополняется мейнтейнером
по присланным отчётам. Формат:

```json
{
  "version": 1,
  "updated": "2026-11-11",
  "note": "Диагностика ошибок Fluent TUI по логу. Пополняется мейнтейнером по report-файлам.",
  "patterns": [
    {
      "id": "invalid-command-batch-confirm",
      "match": "invalid command:?\\s+yes",
      "kind": "batch-confirmation",
      "severity": "info",
      "meaning": "После /file/write-case-data \"...\" yes файл уже записан, а последний токен yes отвергнут, потому что в batch-режиме подтверждения перезаписи включены.",
      "recommendation": "Считать настройку успешной, если .cas.h5/.dat.h5 существуют. Убрать хвостовой yes или выставить /file/confirm-overwrite? no.",
      "source": "живой прогон 2026-11-11, build 10262"
    }
  ]
}
```

- `id` — совпадает с `code` находки (список базовых кодов — в `REPORT_FORMAT.md`;
  неизвестные ситуации получают `other`);
- `match` — регулярное выражение (строка для `new RegExp(...)`, без ограничителей `/.../`),
  с которым сопоставляются строки лога/`logTail`; экранировать спецсимволы;
- `kind` — категория (`batch-confirmation`, `syntax`, `license`, `udf`, `mesh-zones`,
  `crash`, `resources`, `journal-abort`, `files`, `dialog`, `scheme`, …; список в файле —
  фактический, дополняйте его осознанно);
- `severity` ∈ `error | warning | info`;
- `meaning` и `recommendation` — человекочитаемо, без «см. выше»;
- `source` — откуда знание (живой прогон с версией/build, KB-файл:строки).
- При добавлении: проверить регэксп на реальных `logTail` из отчётов (не должен матчить всё
  подряд), не дублировать `id`, обновлять `version` при изменении семантики.

### 6.5. Профили — `data/profiles/<id>/profile.json`

- Новый профиль — по контракту `FORMATS.md` §1: `profile.json` + `templates/`, регистрация
  `profileRoots`/`templateRoots` в конфиге, README профиля.
- Обязательна `verification: {status, date, evidence}`; профиль без живой проверки — не
  `verified`.
- Рендер шаблонов должен совпадать с эталоном **байт-в-байт** для контрольных наборов
  параметров (quick/fine) — проверка входит в релизный чек-лист.
- Изменение параметров/шаблонов профиля — потенциально ломающее изменение для коллег:
  повышайте `version` профиля и фиксируйте в `CHANGELOG.md`.
- `data/rules/profiles-index.json` должен содержать актуальные `id/path/title/status`.

### 6.6. KB и документация

- Гэпы `kb-gap`/`documentation` из бэклога закрывать в KB (`kbRoot`) и/или в `docs/`;
  каждая новая KB-страница должна давать `source` вида `путь:строки`.
- Ссылки на KB в данных — с номерами строк, иначе через месяц провенанс теряется.

---

## 7. Повышение статусов

Разрешённые переходы:

```
unverified ──(живая проверка; journal + verifiedOn)──▶ verified
     │                                                   ▲
     └──(собраны строки из справки/журналов)──▶ derived ─┘
```

- `derived → verified` — только после живой проверки; обновить `source`, `verifiedOn`,
  `date`, `confidence`.
- Понижение (`verified → derived/unverified`) — если выяснилось, что строка не работает или
  проверка была ошибочной; обязательно указать причину в `notes` и `CHANGELOG.md`.
- При появлении новой версии ANSYS: старый `verified` не становится `unverified` сам по себе.
  Прогнать проверку на новой версии, добавить `verifiedOn`; если поведение изменилось —
  новый рецепт/правило (см. 6.1) и запись в `CHANGELOG.md`.
- Не повышать статус на основании отчёта коллеги без проверки: отчёт — это гипотеза
  (если только он сам не содержит живой проверки с логом; и тогда мейнтейнер всё равно
  фиксирует версию/build и проверяет воспроизводимость).

---

## 8. Релиз: `CHANGELOG.md`, semver, git tag

### 8.1. `CHANGELOG.md`

Файл `CHANGELOG.md` в корне пакета (уже есть, текущая версия — `0.2.0`), формат —
[Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), разделы на русском:
`Добавлено / Изменено / Исправлено / Удалено / Проверено`. В каждом релизе:

```markdown
## [0.3.0] — 2026-11-20

### Добавлено
- data/recipes: `boundary.pressure-outlet.chain` (verified, Fluent 2026 R1 / build 10262)
- data/rules/diagnostics.json: код `license` (error)

### Изменено
- data/rules/questions.json: `mesh.units` теперь обязательный

### Проверено
- `solve.under-relaxation` — подтверждён на 2026 R1

### Исправлено
- scripts/ingest-report.mjs: дедуп отчётов при повторном ingest
```

### 8.2. Semver

- **patch** (`0.2.x`): исправления скриптов/документации, не меняющие данные и поведение
  плагина; ingest-фиксы без изменения формата агрегата.
- **minor** (`0.x.0`): новые рецепты/правила/вопросы/профили, повышение статусов,
  новые поля данных, новые коды в `data/rules/diagnostics.json` — обратно совместимо.
- **major** (`x.0.0`): ломающие изменения — несовместимый `case spec`, изменение параметров
  профиля, удаление инструмента/поля данных, новая схема отчёта (`report@2`) или агрегата
  (`aggregate@2`). Новая схема отчёта требует поддержки в ingest и миграции.

Версия в `package.json` (`version`) и тег должны совпадать. Версию также повышать, если
меняются только данные: коллеги ориентируются на неё, чтобы понять, «догнали ли» они знания.

### 8.3. Чек-лист релиза

```bash
# 1. Свежие отчёты: положить в learning/inbox, агрегировать
node scripts/ingest-report.mjs
# 2. Разобрать learning/backlog.md, обновить данные (разделы 6–7), CHANGELOG.md
# 3. JSON-валидность всех данных
node -e "const {readdirSync,readFileSync,statSync}=require('fs');const walk=(d)=>readdirSync(d).flatMap(n=>{const p=d+'/'+n;return statSync(p).isDirectory()?walk(p):[p]});for(const f of walk('data')){if(f.endsWith('.json'))JSON.parse(readFileSync(f,'utf8'))}console.log('data JSON ok')"
# 4. Смоук-тесты движка
node scripts/smoke.mjs
# 5. Повторный ingest должен быть идемпотентным (reportsTotal не меняется)
node scripts/ingest-report.mjs
# 6. Обновить версию в package.json и CHANGELOG.md, проверить дифф
git diff
git add -A
git commit -m "feat(data): ..."      # Conventional Commits
git tag -a v0.3.0 -m "fluent-case-builder 0.3.0"
git push && git push --tags
```

Дополнительно перед тегом:

- профили пере-рендерены и совпадают с эталоном байт-в-байт (контрольные наборы quick/fine);
- `learning/aggregate.json` и `learning/backlog.md` обновлены и закоммичены;
- сырые `learning/inbox/*` случайно не попали в индекс: `git status --short learning/inbox`;
- в данных нет ссылок на несуществующие `recipe id`/`specPath`;
- в отчётах и агрегате нет секретов (`git diff learning/aggregate.json | grep -i -E 'token|password|secret|license'`).

После тега — уведомить коллег (см. раздел 10): какая версия, что нового, что теперь
можно проверить/перепроверить.

---

## 9. Privacy и безопасность

- **Не коммитятся:** `learning/inbox/*` (сырые отчёты), кейсы, `.cas.h5/.dat.h5`, логи
  Fluent, транскрипты. В пакетном `.gitignore` уже есть `learning/inbox/*` и
  `!learning/inbox/.gitkeep`.
- **Коммитятся:** `learning/aggregate.json`, `learning/backlog.md` — только сводные карточки.
- В отчётах допустимы пути и имена хостов (нужны для провенанса), но **недопустимы**
  лицензионные ключи/серверы лицензий, токены, пароли, персональные данные, содержимое
  коммерческих кейсов. Если они попали в отчёт — не коммитить; попросить коллегу
  пересоздать отчёт без них.
- Ingest намеренно не копирует `environment.license`, `license.server`, `features`
  и полные логи в агрегат; хосты/ОС — только счётчиками.
- Перед коммитом агрегата: `git diff learning/aggregate.json` — глазами проверить, что
  не появилось новых нежелательных полей.
- Не публиковать отчёты/агрегаты в публичный репозиторий, если они содержат имена
  заказчиков или закрытые данные; при сомнении — редакция/анонимизация.

---

## 10. Как отвечать коллеге

Ответ — в свободной форме, но с явным статусом и путём к обновлению:

1. **Принято:** спасибо, отчёт принят, id `...`; вердикт/ключевая находка.
2. **Что понятно / что уточняется:** кратко — какая гипотеза подтверждается, что ушло
   в бэклог, какой вопрос нужно проверить в живой сессии.
3. **Что сделано:** «добавлен/повышен рецепт `X` (verified, Fluent 2026 R1), версия `v0.3.0`».
4. **Как обновиться:** `plugin_manager` install/update bundle с новым тегом (или `git pull`
   + перезапуск профиля), затем повторить `fluent_case_plan`/`fluent_case_validate`.
5. **Что проверить у себя:** конкретная команда/сценарий; если проблема повторится —
   прислать новый отчёт (id будет другим) с логом.

Статусы для ответа: «в бэклоге», «в работе», «исправлено в vX.Y.Z», «нужна проверка на вашей
версии Fluent». Не обещать `verified`, пока проверка не сделана.

Шаблон:

```text
Спасибо, отчёт принят (id 2026-11-11T09:41:48.422Z-0ef8d17a).
Что вижу: invalid command: yes — безвредный артефакт batch-подтверждения; …
В бэклог попало: pressure-outlet BC (не проверен), license (диагностика).
Сделано в v0.3.0: рецепт `boundary.pressure-outlet.chain` → verified на 2026 R1 (build 10262).
Обновите плагин и проверьте `fluent_case_plan` для своей задачи.
Если повторится — пришлите новый отчёт с логом запуска.
```

---

## 11. Регулярность и метрики

- Ingest запускать при каждом получении отчётов и перед релизом (идемпотентно).
- Раз в неделю/спринт: разобрать бэклог, закрыть топ-3 пункта; обновить KB.
- Полезные метрики динамики: `stats.reportsTotal`, топ `unsupportedSteps`, топ
  `missingRequiredQuestions`, `reportsFailed`, число версий Fluent/build в `fluentVersions`.
  Смотреть на убывание топов — это и есть эффект петли обучения.

---

## 12. Типовые проблемы

| Симптом | Причина / решение |
|---|---|
| backlog пуст, «данных пока нет» | в `learning/inbox` нет валидных отчётов; проверить `schema`/`id`, stderr ingest |
| отчёт прочитан дважды | одинаковый `id` в двух файлах — дедуп по id, `ingest.duplicates` > 0 это норма |
| отчёт «чужой schema» | коллега прислал отчёт/агрегат другой версии; обновить плагин у коллеги или поддержать новую схему в ingest |
| агрегат «поехал» | не править `aggregate.json` руками; пересобрать `--no-merge` из inbox |
| `reportsTotal` не растёт | все отчёты уже в агрегате (дедуп) — это ожидаемо |
| статус `verified` не появляется | для `verified` нужен живой прогон + `verifiedOn` + `source`; отчёта коллеги недостаточно |
| коллега обновился, а знаний нет | проверить версию/тег, перезапустить профиль DSH, заново вызвать инструмент |
