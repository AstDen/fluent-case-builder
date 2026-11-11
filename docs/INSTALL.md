# Установка `fluent-case-builder`

Пошаговая инструкция для коллеги: от проверки Fluent и лицензии до smoke-теста инструментов.
Плагин ставится как DSH-бандл и работает в профиле Harness (ниже — профиль `web`).

Если что-то пошло не так — сразу смотрите раздел [«Типовые проблемы»](#типовые-проблемы).

---

## 0. Что понадобится

| Компонент | Проверка | Примечание |
|---|---|---|
| Node.js ≥ 20 | `node --version` | `engines` плагина |
| pnpm | `pnpm --version` | DSH ставит плагины через pnpm |
| DeepSeek Harness 0.2.1-rc.5 | `dsh --version` | peer dependency `@deepseek-ai/dsh-tools` |
| ANSYS Fluent + лицензия | см. шаг 1 | нужен только для запуска расчёта |
| Python 3 (опционально) | `python3 --version` | нужен профилям с `python:`-вычислениями (например, `example-channel`) |
| unzip (опционально) | `unzip -v` | нужен профилям с zip-ассетами (например, `example-channel`: распаковка сетки) |
| База знаний Fluent TUI (опционально) | см. шаг 4 | без неё KB-инструменты отключены, а валидация журнала пропускается |

Планирование, генерация файлов и отчёты работают **без** Fluent и без базы знаний — но тогда,
соответственно, не будет запуска и оффлайн-проверки журнала.

---

## 1. Проверить Fluent и лицензию

### Fluent

```bash
which fluent
# или
echo "$FLUENT_PATH"
ls -d /opt/ansys_inc/*/fluent/bin/fluent ~/ansys_inc/*/fluent/bin/fluent 2>/dev/null
```

Плагин умеет сам искать launcher: `FLUENT_PATH` → `fluent` в `PATH` → `/ansys_inc`,
`/opt/ansys_inc`, `~/ansys_inc`, `/usr/ansys_inc` (берётся старшая версия). Если Fluent лежит
нестандартно — задайте `fluentPath` в конфиге (шаг 4).

### Лицензионный сервер

```bash
echo "$ANSYSLMD_LICENSE_FILE"      # ожидается что-то вида 1055@license-server
ss -ltn | grep 1055                # сервер слушает порт 1055?
```

- Если `ANSYSLMD_LICENSE_FILE` не задан, плагин использует `1055@localhost`.
- Проверка «лицензия реально выдаётся» делается запуском Fluent вручную, например
  `fluent 3ddp -g` (без журнала, после старта — выход). Если Fluent ругается на лицензию,
  плагин тоже не сможет запустить расчёт.

Путь и адрес лицензии можно зафиксировать в конфиге (`fluentPath`, `licenseHost`) — см. шаг 4.

---

## 2. Проверить Node.js, pnpm и DSH

```bash
node --version        # v20.x или новее
pnpm --version
dsh --version         # 0.2.1-rc.5
```

Если `pnpm` не найден (`command not found` / `ENOENT`):

```bash
corepack enable pnpm
pnpm --version
```

Если `corepack` тоже недоступен — поставьте Node.js 20+ из официального дистрибутива (в нём
`corepack` есть) или установите pnpm отдельно, затем повторите шаг 3.

---

## 3. Установить плагин

### Вариант A — из git (для коллег)

В командах ниже `<OWNER>/<REPO>` — плейсхолдер. Замените его на реальный репозиторий,
например `github:ivanov/fluent-case-builder`.

Через агента DSH (инструмент `plugin_manager`):

```text
plugin_manager install_bundle  target: "github:<OWNER>/<REPO>"
```

Или через CLI (тот же pnpm под капотом):

```bash
dsh plugin --profile web install github:<OWNER>/<REPO>
```

### Вариант B — из локального каталога

Если репозиторий уже склонирован:

```text
plugin_manager install_bundle  target: "/absolute/path/to/fluent-case-builder"
```

```bash
dsh plugin --profile web install /absolute/path/to/fluent-case-builder
```

### После установки

1. Проверьте, что пакет появился в профиле — типичный путь:
   `~/.dsh/profiles/web/node_modules/fluent-case-builder` (и запись в
   `~/.dsh/profiles/web/package.json`).
2. **Перезапустите DSH.** Плагин и его конфиг читаются при старте профиля; без перезапуска
   инструменты могут быть не видны или работать со старым конфигом.
3. Проверка: вызовите `fluent_case_profiles` — должен вернуться список профилей, в поставке есть
   `example-channel`:

   ```json
   { "profiles": [ { "id": "example-channel", "title": "Пример: ламинарный канал (синтетический шаблон)", "status": "verified" } ], "hint": "…" }
   ```

Если список пуст или инструмента нет — см. [«Типовые проблемы»](#типовые-проблемы).

---

## 4. Настроить конфигурацию

Плагин читает настройки в порядке возрастания приоритета:

```text
DEFAULTS (lib/config.js)
  → config строки плагина в cordis.patch.yml
    → внешний config.json
      → переменные окружения
```

Для личной машины достаточно внешнего файла:

```bash
mkdir -p ~/.config/fluent-case-builder
cp /absolute/path/to/fluent-case-builder/examples/config.example.json \
   ~/.config/fluent-case-builder/config.json
# отредактируйте пути
```

Путь по умолчанию: `$XDG_CONFIG_HOME/fluent-case-builder/config.json` или
`~/.config/fluent-case-builder/config.json`. Переопределить путь целиком: `FLUENT_CONFIG`.

Минимально полезный конфиг (остальные ключи имеют дефолты — см.
[examples/config.example.json](../examples/config.example.json) и README):

```json
{
  "caseRoots": ["/home/user/fluent-cases"],
  "kbRoot": "/path/to/ansys-fluent-tui-kb",
  "indexDir": "/path/to/ansys-fluent-tui-kb/90_RAW_TUI_OUTPUT/_data",
  "fluentPath": "/opt/ansys_inc/v261/fluent/bin/fluent",
  "licenseHost": "1055@license-server",
  "allowRun": false
}
```

Что важно знать:

- `caseRoots` — **белый список** корней записи. Всё, что плагин создаёт (кейсы, бэкапы, отчёты),
  должно лежать внутри. По умолчанию — `~/fluent-cases`.
- `kbRoot` и `indexDir` можно не задавать. Тогда `fluent_kb_search`/`fluent_kb_get` вернут
  `{ "configured": false, "hint": "…" }`, а `fluent_case_validate` — `verdict: "skipped"` с
  пояснением. Это штатное поведение, а не ошибка.
- `allowRun` по умолчанию `false`. Включайте, только если готовы запускать Fluent; сам запуск
  всегда дополнительно требует `confirm: true`.
- `reportDir` — куда писать отчёты и `task-notes.jsonl`. Если не задан, отчёт идёт в
  `<caseDir>/analysis`, а без кейса — в `<caseRoots[0]>/reports`.
- Для профиля `example-channel` дополнительно нужны `templateRoots["example-channel"]` (каталог с UDF/TSV/сеткой)
  и `profileRoots["example-channel"]` (корень вывода) — это проектные ассеты, в публичном репозитории их нет.
  Без `profileRoots` путь кейса не разрешается (в профиле `outputRoot` строится из
  `{{solutionsRoot}}`); вместо него можно передать `outputRoot` прямо в `fluent_case_plan`/
  `fluent_case_generate`.
- Если конфиг должен быть частью профиля DSH, переопределите строку плагина по id в
  `~/.dsh/profiles/web/cordis.patch.yml` — пример:
  [examples/cordis.override.example.yml](../examples/cordis.override.example.yml).

После изменения конфига **перезапустите DSH** (конфиг читается при активации плагина).

---

## 5. Smoke-проверка

По очереди вызовите инструменты и сравните с ожиданием.

1. **Профили**

   ```text
   fluent_case_profiles()
   ```

   Ожидание: список с `example-channel`.

2. **База знаний**

   ```text
   fluent_kb_search({ query: "energy" })
   ```

   - KB настроена → `results` с командами/документами и признаком проверки.
   - KB не настроена → `{ "configured": false, "hint": "База знаний не настроена. Задайте kbRoot …" }`.
     Это ожидаемо, если шаг 4 без `kbRoot`.

3. **Интервью и рекомендации**

   ```text
   fluent_case_interview({ answers: { "task.kind": "gas-dynamics", "mach": 2.5 } })
   ```

   Ожидание: `next[]` (вопросы), `recommendations`, `completeness`, `draftSpec`.

4. **Сухой прогон профиля (ничего не пишет)**

   ```text
   fluent_case_plan({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
   ```

   Ожидание: `mode: "profile"`, `caseDir` внутри `caseRoots`, вычисляемое `y_mid`,
   `preset` (`quick`/`fine`), список файлов, `validation` (или `verdict: "skipped"` без `indexDir`).

5. **Отчёт для мейнтейнера**

   ```text
   fluent_task_report({ title: "smoke-test", notes: ["проверка установки"] })
   ```

   Ожидание: `jsonPath`, `mdPath`, `bytes`, `summary`; файлы `<timestamp>-smoke-test-report.json/.md`
   в разрешённом каталоге (см. `reportDir`). Убедитесь, что файл создан и JSON валиден:

   ```bash
   node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('report: OK')" \
     /path/to/report.json
   ```

6. **Заметка исполнителя**

   ```text
   fluent_task_log({ message: "проверка установки", kind: "note" })
   ```

   Ожидание: `{ "file": ".../task-notes.jsonl", "entry": { ... } }`; повторный
   `fluent_task_report` подхватит заметку.

7. **Движок без DSH (опционально, если есть локальный клон)**

   ```bash
   cd /absolute/path/to/fluent-case-builder
   node scripts/smoke.mjs
   ```

   Ожидание: смоук-тест проходит без ошибок (выражения, шаблоны, KB, валидатор, правила,
   компилятор, план профиля).

---

## 6. Первый реальный кейс

1. Соберите постановку через интервью (`fluent_case_interview`) или возьмите профиль.
2. Сделайте сухой прогон (`fluent_case_plan`) и просмотрите журнал/`unsupported`.
3. Создайте файлы (`fluent_case_generate`) — только внутри `caseRoots`.
4. Проверьте журнал (`fluent_case_validate`).
5. Запускайте Fluent только после явного согласия: `allowRun: true` в конфиге (и перезапуск DSH) и
   `fluent_case_run({ action: "start", caseDir, confirm: true })`.
6. Следите за прогоном: `fluent_case_run({ action: "status", caseDir })`.
7. В конце работы (успешной или нет) сделайте `fluent_task_report` и пришлите JSON мейнтейнеру —
   это и есть вклад в «петлю обучения» (см. [REPORT_FORMAT.md](REPORT_FORMAT.md)).

---

## Типовые проблемы

| Симптом | Причина | Что делать |
|---|---|---|
| `pnpm: command not found`, `spawn pnpm ENOENT` при установке | нет pnpm | `corepack enable pnpm`, повторить установку; при отсутствии corepack — установить Node 20+ из официального дистрибутива |
| После установки инструментов `fluent_*` нет | DSH не перезапущен; пакет не попал в профиль | перезапустить DSH; проверить `~/.dsh/profiles/web/package.json` и `plugin_manager list_plugins`; при необходимости переустановить |
| При активации: `failed to import: Cannot find package '@deepseek-ai/dsh-tools'` | установка из git при запущенном DSH: держится старая генерация модулей | перезапустить DSH. Если ошибка повторяется — клонировать репозиторий локально и установить способом 3 (путь к каталогу) |
| `fluent_kb_search` / `fluent_kb_get` → `{"configured": false, "hint": …}` | не задан `kbRoot`/`indexDir` | задать оба ключа (пути к KB и к каталогу с `commands.csv`) в config.json или env, перезапустить DSH |
| `fluent_case_validate` → `verdict: "skipped"` | не задан `indexDir` | это не ошибка: оффлайн-проверка отключена. Задайте `indexDir` для проверки |
| Ошибка при старте: `внешний конфиг …: …` | невалидный JSON/JSON-массив в config.json | проверить JSON: `node -e "JSON.parse(require('fs').readFileSync(process.env.HOME + '/.config/fluent-case-builder/config.json','utf8'))"`, исправить, перезапустить |
| `… вне разрешённых корней: …` | путь записи вне `caseRoots` | добавить корень в `caseRoots` или выбрать `outputRoot`/`outputDir` внутри разрешённого |
| Ошибка `директория кейса вне разрешённых корней: …` | для профиля с `outputRoot` не задан `profileRoots` (шаблон разрешается в путь вне `caseRoots`) | задать `profileRoots["<id профиля>"]` или передать `outputRoot` в инструмент |
| `запуск Fluent запрещён конфигом (allowRun:false)` | запуск выключен | включить `allowRun: true` в конфиге и подтвердить `confirm: true` |
| Fluent не стартует / падает сразу | лицензия, неверный `fluentPath`, сетка/журнал | проверить `ANSYSLMD_LICENSE_FILE`, `ss -ltn \| grep 1055`, `fluentPath`; посмотреть `fluent_case_run({action:"status"})` → `logFile`/`errors` |
| Отчёт не создаётся | `outputDir` вне разрешённых каталогов (`caseRoots`/`reportDir`/каталог кейса), нет прав, диск | выбрать `outputDir` внутри разрешённого; проверить права; `fluent_task_report` вернёт ошибку с путём |
| `python3: …` при `fluent_case_plan`/`generate` профиля | нужен Python 3 для `python:`-вычислений профиля | установить `python3` или использовать профиль без таких вычислений |
| `example-channel` не подходит под задачу | это синтетический пример, а не универсальный шаблон | использовать `fluent_case_interview` → `fluent_case_plan({spec})` или добавить свой профиль в `data/profiles`/`profileDirs` |
| Непонятно, почему шаг не сгенерировался | шаг непроверен в KB | это ожидаемо: смотреть `unsupported`/`warnings` в `fluent_case_plan`, зафиксировать `fluent_task_log` и прислать отчёт |

---

## Обновление и удаление

- Обновить: переустановить плагин из git (шаг 3) и перезапустить DSH. Данные кейсов лежат вне
  пакета (`caseRoots`), поэтому установка их не затрагивает.
- Удалить: `dsh plugin --profile web remove fluent-case-builder` (или через `plugin_manager`),
  затем перезапустить DSH.
- Удаление плагина **не** удаляет созданные кейсы, отчёты и реестр
  (`~/.cache/fluent-case-builder/cases.jsonl`).

## См. также

- [README.md](../README.md) — возможности, конфигурация, инструменты.
- [USAGE.md](USAGE.md) — рабочие сценарии и что появляется на диске.
- [REPORT_FORMAT.md](REPORT_FORMAT.md) — формат отчёта для мейнтейнера.
- [MAINTAINING.md](MAINTAINING.md) — петля обучения: от отчёта коллеги до новой версии плагина.
