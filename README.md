# fluent-case-builder

**Конструктор расчётных кейсов ANSYS Fluent для DeepSeek Harness.** Агент ведёт инженера от
постановки задачи до готового журнала TUI, файлов кейса, контролируемого запуска и отчёта
мейнтейнеру — и при этом не выдумывает синтаксис команд Fluent.

`Версия 0.4.0` · `Лицензия MIT` · `Node.js ≥ 20` · `DSH 0.2.1-rc.5` · база знаний не требуется

## Зачем это

Обычный LLM-агент, которого просят «настрой кейс во Fluent», уверенно сочиняет команды TUI —
и ошибается в порядке диалогов, количестве ответов `q` и версии синтаксиса. `fluent-case-builder`
меняет роли: **знание хранится в данных плагина** (проверенные профили, рецепты журналов,
инженерные правила, диагностика ошибок), а код только собирает из них журнал, файлы кейса и
проверяет результат.

Отсюда главный принцип: **строки журнала не придумываются**. В журнал попадают рецепты со статусом
`verified` (проверены в живой сессии/рабочем журнале) и `derived` (выведены из справки или журналов —
и всегда с явным предупреждением). Всё, что не проверено (`unverified`), помечается как
неподдержанное и в журнал не попадает. Плагин честно говорит «этого я не умею», вместо того чтобы
генерировать правдоподобный бред.

## Возможности

| Возможность | Что даёт |
|---|---|
| **Поиск «как включить X»** | встроенный индекс 1736 команд TUI + 70 рецептов журналов (35 verified): journal-строка, статус, источник — сразу после установки, без настройки KB |
| **Встроенный skill** | агент сам выбирает KB-инструменты для вопросов по Fluent и не выдумывает синтаксис |
| **Интервью по задаче** | вопросы по классу задачи, Mach/Re, теплообмену, горению, излучению, многофазности, UDF, сетке, ГУ и критериям остановки + рекомендации моделей с обоснованием и источником |
| **Профильные кейсы** | повторяемый проектный кейс воспроизводится из параметров: вычисляемые величины, пресеты, подстановки в UDF, копии сетки/TSV, манифест `case.json` |
| **Универсальная спецификация** | журнал собирается из проверенных рецептов по JSON-спеке кейса; `generate` пишет его на диск (`setup_case.jou` + `case.json`); неподдержанные шаги перечисляются отдельно, а не додумываются |
| **Сухой прогон** | план без записи на диск: каталог, вычисления, пресет, полный журнал, оффлайн-проверка |
| **Проверка журнала по базе знаний** | классификация строк: точно в индексе команд, меню-контейнер, скрытая, синтаксис 2025 R1, неизвестная |
| **Контролируемый запуск** | Fluent в фоне с логом, статусом и остановкой; бэкап журналов/результатов перед каждым запуском; `allowRun` + `confirm:true` |
| **Отчёты для мейнтейнера** | самодостаточный JSON + Markdown: окружение, версия Fluent, постановка, интервью, кейс, запуск, автоматический анализ ошибок, пробелы KB |
| **Расширение данными** | новый профиль/рецепт/правило/вопрос/диагностика — это новый JSON в `data/`, код не меняется |

## Требования

| Компонент | Версия / примечание |
|---|---|
| **Node.js** | ≥ 20 (`engines` в `package.json`) |
| **DeepSeek Harness** | 0.2.1-rc.5 (peer-зависимости: `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-skill`) |
| **pnpm** | нужен DSH для установки плагинов. Если `pnpm` не найден: `corepack enable pnpm` |
| **ANSYS Fluent** | установленный Fluent + доступный лицензионный сервер. Нужен для `fluent_case_run`; планирование и генерация работают и без него |
| **Python 3** | опционально: нужен профилям с `python:`-вычислениями (в примере `example-channel` так вычисляется `y_mid`) |
| **unzip** | опционально: нужен профилям, которые распаковывают zip-ассеты (например, готовые сетки) |
| **База знаний Fluent TUI** | **не обязательна для поиска команд**: индекс на 1736 команд встроен в пакет. `kbRoot` нужен только для полных deep_dive-документов (`fluent_kb_get`) |

## Установка

Плагин ставится как DSH-бандл. Публичный репозиторий: **https://github.com/AstDen/fluent-case-builder**.

### 1. Из git (рекомендуется)

Через агента DSH (инструмент `plugin_manager`):

```text
plugin_manager install_bundle  target: "github:AstDen/fluent-case-builder"
```

Или через CLI (тот же pnpm под капотом):

```bash
dsh plugin --profile web add github:AstDen/fluent-case-builder
```

Для своего форка замените `AstDen/fluent-case-builder` на `<OWNER>/<REPO>`.

### 2. Из локального каталога

```text
plugin_manager install_bundle  target: "/absolute/path/to/fluent-case-builder"
```

```bash
dsh plugin --profile web add /absolute/path/to/fluent-case-builder
```

### После установки

- Если `pnpm` нет: `corepack enable pnpm` и повторите установку.
- Плагин подключается патчем бандла (`cordis.patch.yml`). Если после установки инструменты
  не видны — **перезапустите DSH**.
- **Установка/обновление из git требует перезапуска DSH.** Признак: при активации пишется
  `failed to import: Cannot find package '@deepseek-ai/dsh-tools'` — это не дефект пакета,
  а старая генерация модулей в уже запущенном DSH: перезапустите его. Если ошибка повторяется,
  используйте способ 2: локальный клон и установка по пути — она не зависит от git-резолвинга pnpm.
- Проверка: вызовите `fluent_case_profiles` — должен вернуться список профилей (в поставке есть
  `example-channel`). Если ответ пустой — см. [docs/INSTALL.md](docs/INSTALL.md), раздел «Типовые проблемы».

### Обновление

Текущая версия — в `CHANGELOG.md` и в `plugin_manager` → `list_bundles`. Обновление **всегда**
состоит из трёх шагов: заменить пакет → перезапустить DSH → проверить версию.

**Через агента (рекомендуется).** В сессии:

```text
plugin_manager  action: "remove_bundle"  target: "fluent-case-builder"
plugin_manager  action: "install_bundle" target: "github:AstDen/fluent-case-builder#v0.4.0"
```

`install_bundle` отказывает, если пакет уже установлен (`already-installed`), поэтому сначала
`remove_bundle`. Указывайте тег (`#v0.4.0`) для воспроизводимой версии или `#main` / без рефа —
для последней. После установки **перезапустите DSH**: до рестарта возможен симптом
`failed to import: Cannot find package '@deepseek-ai/dsh-tools'` (старая генерация модулей).

**Из терминала.** `dsh plugin` — это pnpm в каталоге профиля с пересборкой списка бандлов:

```bash
# последняя версия из main
dsh plugin --profile web update fluent-case-builder
# или точная версия: удалить и поставить тег
dsh plugin --profile web remove fluent-case-builder
dsh plugin --profile web add github:AstDen/fluent-case-builder#v0.4.0
```

**Откат** — та же процедура с тегом предыдущей версии (`#v0.3.0` и т.д.). Внешний конфиг
(`~/.config/fluent-case-builder/config.json`), созданные кейсы и реестр при обновлении не
затрагиваются. Для установки из локального клона хватает `git pull` (данные подхватываются сразу),
но после изменения кода DSH всё равно нужно перезапустить.

**Проверка после обновления:**

- `plugin_manager` → `list_bundles` показывает новую версию;
- `fluent_case_profiles` и `fluent_kb_search({query:"k-ω SST"})` отвечают;
- `fluent_task_report(...)` → `generator.pluginVersion` совпадает с ожидаемой;
- для локального клона: `node scripts/smoke.mjs`.

Подробная пошаговая инструкция (проверка Fluent и лицензии, smoke-тесты, troubleshooting) —
в [docs/INSTALL.md](docs/INSTALL.md).

## Конфигурация

Поиск команд и рецептов работает «из коробки» — настраивать ничего не нужно. Конфиг нужен, только
если вы хотите читать полные deep_dive-документы (`kbRoot`), сменить каталог кейсов (`caseRoots`),
разрешить запуск Fluent (`allowRun`) или подключить приватные профили (`profileDirs`).
Приоритет настроек (низший → высший):

```text
DEFAULTS (lib/config.js)
  → config строки плагина в cordis.patch.yml
    → внешний config.json
      → переменные окружения
```

### Внешний config.json

Путь по умолчанию:

```text
$XDG_CONFIG_HOME/fluent-case-builder/config.json
или
~/.config/fluent-case-builder/config.json
```

Переопределить путь целиком: переменная `FLUENT_CONFIG` (абсолютный путь к JSON-файлу).

Готовый пример всех ключей — [examples/config.example.json](examples/config.example.json):
скопируйте его, замените пути и оставьте только нужные ключи.

### Автоопределение

- **Fluent**: `fluentPath` по умолчанию пуст — плагин ищет `fluent` в `PATH`, затем в
  `/ansys_inc/*/fluent/bin/fluent`, `/opt/ansys_inc`, `~/ansys_inc`, `/usr/ansys_inc`
  (берётся старшая версия). Явно: `FLUENT_PATH` или ключ `fluentPath`.
- **Лицензия**: `licenseHost` по умолчанию берётся из `ANSYSLMD_LICENSE_FILE`, иначе
  `1055@localhost`. Для запуска Fluent эта переменная подставляется в окружение процесса.
- **Кейсы**: `caseRoots` по умолчанию — `[~/fluent-cases]`. Запись кейсов, бэкапов и отчёта
  разрешена только внутри этих корней.
- **Поиск команд работает из коробки**: `indexDir` по умолчанию — встроенный `data/index`
  (индекс TUI-команд + сводка). `kbRoot` по умолчанию пуст: он нужен только для чтения полных
  markdown-документов через `fluent_kb_get`; без него этот инструмент вернёт подсказку.

### Ключи конфига

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `dataDir` | `<пакет>/data` | профили, рецепты, правила. Обычно менять не нужно |
| `profileDirs` | `[]` | дополнительные каталоги профилей (абсолютные пути) |
| `kbRoot` | `''` | корень базы знаний Fluent TUI для `fluent_kb_get`; `''` — только встроенный индекс и рецепты |
| `indexDir` | `<пакет>/data/index` | каталог с `commands.csv`/`kb_summary.json`; встроенный индекс работает сразу |
| `caseRoots` | `[~/fluent-cases]` | разрешённые корни записи кейсов/бэкапов/отчётов |
| `templateRoots` | `{}` | шаблоны/ассеты проектов по id профиля (только чтение) |
| `profileRoots` | `{}` | корень вывода кейсов по id профиля; обязателен для профилей с `outputRoot` из `{{solutionsRoot}}` (если профиль так задаёт `outputRoot`) |
| `reportDir` | `''` | куда писать отчёты и `task-notes.jsonl`; пусто — `<caseDir>/analysis` или `<caseRoots[0]>/reports` |
| `registryPath` | `~/.cache/fluent-case-builder/cases.jsonl` | реестр созданных кейсов |
| `allowRun` | `false` | разрешён ли запуск Fluent (сам запуск всё равно требует `confirm: true`) |
| `fluentPath` | `''` (авто) | путь к launcher'у Fluent |
| `licenseHost` | `ANSYSLMD_LICENSE_FILE` или `1055@localhost` | адрес лицензионного сервера |
| `timeoutMs` | `600000` | таймаут одной команды TUI, мс |
| `maxOutputChars` | `20000` | лимит вывода в ответе инструмента, символов |
| `maxLogLines` | `800` | сколько последних строк лога включать в отчёт |

### Переменные окружения

| Переменная | Ключ конфига |
|---|---|
| `FLUENT_CONFIG` | путь к внешнему config.json |
| `FLUENT_PATH` | `fluentPath` |
| `ANSYSLMD_LICENSE_FILE` | `licenseHost` |
| `FLUENT_KB_ROOT` | `kbRoot` |
| `FLUENT_KB_INDEX` | `indexDir` |
| `FLUENT_CASE_ROOTS` | `caseRoots` (через `:`) |
| `FLUENT_PROFILE_DIRS` | `profileDirs` (через `:`) |
| `FLUENT_REGISTRY_PATH` | `registryPath` |
| `FLUENT_REPORT_DIR` | `reportDir` |
| `FLUENT_ALLOW_RUN` | `allowRun` (`1/true/yes/on`) |

### Переопределение строки плагина по id

Если конфиг должен быть частью профиля DSH (например, на общей рабочей станции), переопределите
строку `fluent-case-builder` в пользовательском патче профиля
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: fluent-case-builder
  name: 'fluent-case-builder'
  config:
    kbRoot: '/path/to/ansys-fluent-tui-kb'   # опционально: полные deep_dive-документы
    indexDir: ''                             # '' = встроенный индекс команд
    caseRoots:
      - '/home/user/fluent-cases'
    allowRun: false
```

Важно: `config` строки заменяется **целиком**, а не сливается с конфигом бандла — перечислите все
нужные ключи. Рабочий пример — [examples/cordis.override.example.yml](examples/cordis.override.example.yml).

## Quick start

### (0) Вопрос про функцию Fluent — самый частый сценарий

```text
fluent_kb_search({ query: "как включить k-omega SST", scope: "all", limit: 5 })
```

В ответе: `commands` — записи встроенного индекса TUI-команд (путь, вопрос, default, blocked, help)
и `recipes` — проверенные journal-строки со статусом (`verified`/`derived`/`unverified`), параметрами
и источником. Настроек не требуется — индекс на 1736 команд уже в пакете. Подробнее — раздел
[«Как задать вопрос про функцию Fluent»](#как-задать-вопрос-про-функцию-fluent).

### (i) Пример профиля `example-channel`

`example-channel` — **синтетический** профиль-пример: сетка → ламинарный решатель → инициализация →
критерии по невязкам → сохранение. В нём нет граничных условий и чужих данных; он нужен, чтобы
увидеть формат профиля и проверить установку.

```text
fluent_case_profiles({ profile: "example-channel" })
fluent_case_plan({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
fluent_case_generate({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
fluent_case_validate({ caseDir: "~/fluent-cases/channel_L-1000mm_h-10mm" })
fluent_case_run({ action: "start", caseDir: "...", confirm: true })
```

Что нужно:

- **своя сетка** в `meshFile` (обязательный параметр, по умолчанию заглушка `/path/to/channel.msh`);
- каталог вывода: `caseRoots[0]` (по умолчанию `~/fluent-cases`) или параметр `outputRoot`;
- свои ГУ/отчёты добавьте через универсальную спецификацию (сценарий ii) или в шаблон своего профиля.

Свой проектный профиль кладите в `data/profiles/<id>` **или** в отдельный каталог
`config.profileDirs` — так приватные кейсы не попадают в публичный репозиторий.

### (ii) Новая задача: интервью → spec → план

```text
fluent_case_interview({ answers: { "task.kind": "gas-dynamics", "mach": 2.5, "reynolds": 30000 } })
```

В ответе — `next[]` (вопросы, которые агент задаёт пользователю), `recommendations`, `matchedRules`,
`completeness` и `draftSpec`. Дальше:

```text
fluent_case_plan({ spec: { ...draftSpec } })
```

План покажет, какие рецепты вошли в журнал (`sections`), что выведено из справки (`derived`) и
какие шаги на текущей KB неподдержаны (`unsupported`). Полный формат спеки — [docs/CASE_SPEC.md](docs/CASE_SPEC.md).

### (iii) Отчёт для мейнтейнера

По ходу работы фиксируйте заметки — они попадут в отчёт:

```text
fluent_task_log({ message: "inlet BC не сгенерился, использовал массовый расход вручную", kind: "blocked", caseDir: "..." })
```

Когда задача закончена (успешно или нет):

```text
fluent_task_report({
  caseDir: "...",
  title: "Сверхзвуковое сопло, Mach 2.5",
  kind: "gas-dynamics",
  description: "что считали и зачем",
  expectations: "какой результат был нужен",
  questions: ["почему не поддержан inlet BC?"]
})
```

Инструмент запишет `<timestamp>-<slug>-report.json` и `...-report.md` (в `outputDir`, иначе в
`reportDir`, иначе в `<caseDir>/analysis`, иначе в `<caseRoots[0]>/reports`) и вернёт путь,
размер и краткую сводку. JSON — самодостаточный: его достаточно прислать мейнтейнеру одним файлом.
Формат — [docs/REPORT_FORMAT.md](docs/REPORT_FORMAT.md).

## Инструменты

В плагине 12 инструментов; все ответы — JSON.

| № | Инструмент | Что делает | Пишет на диск |
|---|---|---|---|
| 1 | `fluent_case_profiles` | список профилей или подробности одного (`profile`) | нет |
| 2 | `fluent_case_interview` | вопросы, рекомендации моделей, полнота, черновик spec (`answers`, `spec`, `limit`) | нет |
| 3 | `fluent_case_plan` | сухой прогон: профиль+`params` или `spec` → каталог, вычисления, пресет, журнал, проверка (`outputRoot`, `includeJournal`) | нет |
| 4 | `fluent_case_generate` | создание файлов кейса по профилю (`params`, `force`, `outputRoot`) или по универсальной спеке (`spec` + `outputDir`) | да, в `caseRoots` |
| 5 | `fluent_case_validate` | оффлайн-проверка журнала: `profile`+`params`, `caseDir` или `journal[]` | нет |
| 6 | `fluent_case_status` | манифест, ожидаемые `.cas.h5/.dat.h5`, последний запуск, хвост лога (`run`, `lines`) | нет |
| 7 | `fluent_case_list` | реестр созданных кейсов (`limit`, `profile`) | нет |
| 8 | `fluent_case_run` | `action: start/status/stop`, лог и результаты запуска; `start` требует `confirm:true` и `allowRun` | лог, бэкапы |
| 9 | `fluent_kb_search` | **главный инструмент для вопросов**: команды TUI + проверенные рецепты (`query`, `scope: all/commands/recipes`, `limit`, `category`) | нет |
| 10 | `fluent_kb_get` | чтение документа KB по относительному пути (`path`, `offset`, `limit`) | нет |
| 11 | `fluent_task_report` | самодостаточный отчёт JSON + Markdown для мейнтейнера; подхватывает `task-notes.jsonl` | да, JSON+MD |
| 12 | `fluent_task_log` | заметка исполнителя в `task-notes.jsonl` (`message`, `kind`, `author`) | да, JSONL |

## Как задать вопрос про функцию Fluent

Достаточно открыть сессию и спросить — встроенный skill подскажет агенту использовать KB-инструменты,
но надёжнее сформулировать явно:

> «Как включить k-ω SST? Найди через `fluent_kb_search`, покажи journal-строку, статус и источник.»

Что происходит внутри:

1. `fluent_kb_search({ query: "k-ω SST", scope: "all" })` → два раздела:
   - `commands` — команды TUI из встроенного индекса (путь, вопрос, default, blocked, help);
   - `recipes` — проверенные рецепты: готовые journal-строки, статус, параметры, источник.
2. Если нужен полный документ — `fluent_kb_get({ path: "KB/04_MODELS/viscous.md" })` (нужен `kbRoot`).
3. Ответ по формату: journal-строка → интерактивная последовательность → зависимости → проверка →
   статус ✅/🟡/🔴 → источник.

### Как убедиться, что ответ из базы знаний плагина

- В Web UI видны **карточки вызовов инструментов**: были `fluent_kb_search`/`fluent_kb_get` — ответ
  опирается на данные плагина.
- Попросите **сырые результаты**: «покажи вывод `fluent_kb_search` без пересказа» — в нём должны быть
  `path`, `question`, `blocked`, `journal`, `status`, `source`.
- В ответе есть **статус и источник** (`KB/04_MODELS/viscous.md:160-181`, рецепт `models.viscous.kw-sst`).
  Нет статуса/источника — вероятно, ответ из памяти модели, а не из KB.
- `fluent_case_validate` → `verdict: "skipped"` или `fluent_kb_search` → `configured: false` означают,
  что соответствующий источник не настроен/недоступен.
- `fluent_task_report(...)` фиксирует `environment.config` (какие пути KB использовались) и покрытие
  журнала рецептами.

## Расширение: код не меняется

Всё предметное знание — JSON в `data/`. В поставке: **70 рецептов** (35 `verified`, 16 `derived`, 19 `unverified`), **23 инженерных
правила**, **65 вопросов интервью**, **12 диагностик ошибок**, **встроенный индекс 1736 команд**
и профиль-пример `example-channel`.

| Что добавить | Куда | Формат |
|---|---|---|
| Новый проектный кейс | `data/profiles/<id>/profile.json` + `templates/` | [docs/FORMATS.md](docs/FORMATS.md) §1 |
| Новый проверенный блок журнала | `data/recipes/<id>.json` | [docs/FORMATS.md](docs/FORMATS.md) §2 |
| Новое инженерное правило | `data/rules/physics-rules.json` | [docs/FORMATS.md](docs/FORMATS.md) §3 |
| Новый вопрос интервью | `data/rules/questions.json` | [docs/FORMATS.md](docs/FORMATS.md) §4 |
| Новая диагностика ошибок по логу | `data/rules/diagnostics.json` | `{version, patterns:[{id, match, kind, severity, meaning, recommendation, source}]}` |

Дополнительные профили можно держать вне пакета — в `profileDirs` (см. конфиг).

Правило репозитория: **сначала проверить в живой сессии Fluent, потом добавлять в данные**.
Именно поэтому в `unsupported` попадают inlet/outlet BC, transient, `/mesh/scale` и
under-relaxation: для них нет проверенных журнальных строк.

## Петля обучения

Плагин развивается от реальных задач коллег, а не от фантазий разработчика.

```text
коллега решает свою задачу
  → fluent_task_log + fluent_task_report
    → JSON-отчёт мейнтейнеру
      → learning/inbox/                  (сырые отчёты, .gitignore)
        → node scripts/ingest-report.mjs learning/inbox --out learning
          → learning/aggregate.json + learning/backlog.md
            → проверка в живой сессии Fluent
              → data/recipes | rules | diagnostics | profiles
                → CHANGELOG + версия + git tag
                  → коллеги обновляют плагин и получают новые знания
```

Мейнтейнер видит в бэклоге топ неподдержанных шагов, непроверенных рецептов, неотвеченных
обязательных вопросов, частые коды ошибок и расхождения версий ANSYS. Дальше — проверить в живой
сессии, добавить данные, повысить статус рецепта и выпустить версию.

В репозиторий коммитятся только агрегаты (`learning/aggregate.json`, `learning/backlog.md`);
сырые отчёты и заметки остаются локально. Подробности — [docs/MAINTAINING.md](docs/MAINTAINING.md)
и [docs/REPORT_FORMAT.md](docs/REPORT_FORMAT.md).

## Безопасность

- **`caseRoots`** — белый список корней. Генерация кейса, бэкапы, каталог запуска и `outputDir`
  отчёта проверяются: запись за пределы разрешённых путей — ошибка, а не «тихая» запись.
- **`allowRun: false` по умолчанию.** Запуск Fluent включает только конфиг, а сам `start` всегда
  требует явного `confirm: true` — агент обязан спросить пользователя.
- **Без shell.** Fluent запускается `spawn` с массивом аргументов; никакой конкатенации команд.
- **Бэкапы.** Перед запуском журналы, скрипты и существующие результаты копируются в
  `archive/pre-<name>-<ts>/`; `fluent_case_generate({force:true})` уводит старую версию кейса в
  `archive/<naming>.<ts>/`.
- **Идемпотентность.** Существующий кейс не перезаписывается без `force`.
- **Никаких секретов в отчётах.** Лог усечён (`maxLogLines`, общий лимит ~400 КБ), лицензионный
  ключ не пишется — только адрес сервера. `learning/inbox/` в `.gitignore`.

## Ограничения (честно)

- **База знаний покрывает не всё.** 61% команд KB ни разу не вызывались в живой сессии. Поэтому
  универсальный компилятор собирает журнал только из рецептов `verified` и `derived` (вторые —
  с предупреждением), а `unverified`-шаги попадают в `unsupported` и **не генерируются**. Это не
  баг, а осознанная защита от правдоподобного, но неверного журнала.
- **Универсальный spec материализуется только из проверенных рецептов.** `fluent_case_generate`
  с `spec` + `outputDir` пишет `setup_case.jou` и `case.json`, но только из `verified`/`derived`
  строк; непроверенные шаги (inlet/outlet BC, transient, `/mesh/scale` и т.п.) останутся в
  `unsupported` и в журнал не попадут — их нужно сначала проверить в живой сессии и добавить
  рецептом.
- **`example-channel` — синтетический пример, а не готовый кейс.** В нём нет граничных условий и
  отчётов: он показывает формат профиля и проверяет установку. Для реальной задачи используйте
  универсальный spec или свой профиль.
- **Разные версии ANSYS.** Встроенный индекс снят с Fluent **2026 R1 (build 10262)**; на других
  версиях состав меню может отличаться. Строки из журналов 2025 R1 валидатор помечает классом
  `journal-2025`, а отчёты коллег помогают отслеживать расхождения.
- **Живая проверка остаётся за инженером.** Плагин проверяет синтаксис по индексу KB и анализирует
  лог запуска, но не гарантирует физическую корректность постановки (модели, ГУ, критерии) —
  это ответственность инженера.

## Что уже проверено

- **Поиск «как включить X»**: `fluent_kb_search` находит команду в встроенном индексе и рецепт со
  статусом/источником (проверено на `k-ω SST`).
- **Встроенный skill**: отдельная новая сессия по вопросу «Как включить k-ω SST?» сама загрузила
  `fluent-tui-knowledge`, вызвала `fluent_kb_search` + `fluent_kb_get` и ответила с журнальной
  строкой, статусом ✅ и источником.
- Профиль `example-channel`: `fluent_case_plan` и `fluent_case_generate` создают каталог и журнал;
  журнал проходит оффлайн-валидацию по встроенному индексу.
- Универсальный spec: демо-сборка журнала из рецептов проходит; `unsupported` — только ожидаемые
  непроверенные шаги (inlet/outlet BC, `/mesh/scale`).
- Живой прогон на тестовом кейсе (Fluent 2026 R1): настройка завершается, `.cas.h5`/`.dat.h5`
  записываются, `fluent_case_status` показывает `configured`.
- Отчёты и агрегация: `fluent_task_report` → `scripts/ingest-report.mjs` проверены на реальных
  JSON-отчётах (дедупликация, пустой inbox, невалидные файлы).
- `node scripts/smoke.mjs` — 18 проверок движка без DSH (индекс, рецепты, отчёты, профиль и т.д.).

## Структура репозитория

```text
index.js                 регистрация 12 инструментов
lib/                     движок: config, profile, engine, rules, compile, analyze, report, run, kb, util
data/index/              встроенный индекс TUI-команд (commands.csv) + сводка
data/profiles/<id>/      профили кейсов: profile.json + шаблоны журналов
data/recipes/*.json      проверенные блоки журнала (единица компиляции spec)
data/rules/              physics-rules.json, questions.json, diagnostics.json
docs/                    контракты и инструкции (см. ниже)
examples/                примеры config.json и cordis.override.yml
scripts/smoke.mjs        смоук-тест без DSH
scripts/ingest-report.mjs агрегация отчётов в бэклог мейнтейнера
learning/                агрегаты петли обучения; inbox/ — локальные отчёты
LICENSE                  MIT
CHANGELOG.md             история версий
```

## Документация

- [docs/INSTALL.md](docs/INSTALL.md) — установка, конфигурация, smoke-проверка, типовые проблемы.
- [docs/USAGE.md](docs/USAGE.md) — рабочие сценарии, что появляется на диске, безопасность.
- [docs/CASE_SPEC.md](docs/CASE_SPEC.md) — универсальная спецификация кейса.
- [docs/FORMATS.md](docs/FORMATS.md) — контракты данных: профиль, рецепт, правило, вопрос.
- [docs/REPORT_FORMAT.md](docs/REPORT_FORMAT.md) — формат отчёта `report@1` и петля обучения.
- [docs/MAINTAINING.md](docs/MAINTAINING.md) — как мейнтейнеру добавлять знания и выпускать версии.
- [CHANGELOG.md](CHANGELOG.md) — история версий.

## Лицензия

MIT — полный текст в [LICENSE](LICENSE). Copyright (c) 2026 fluent-case-builder contributors.

ANSYS и Fluent — товарные знаки ANSYS, Inc. Плагин не аффилирован с ANSYS и не поставляет Fluent;
лицензия на Fluent и лицензионный сервер — ответственность пользователя.
