# Как пользоваться `fluent-case-builder`

Плагин живёт в этом профиле DSH и вызывается из чата обычными фразами. Ниже — рабочие сценарии,
порядок вызовов и что появится на диске.

## 0. Три режима работы

| Режим | Когда | Надёжность |
|---|---|---|
| **Профиль** (`example-channel`) | повторяемый кейс из параметров: сетка, модели, шаблон журнала | ✅ пример + формат; свои профили — в `data/profiles` или `profileDirs` |
| **Универсальная спецификация** (case spec) | новая задача: гидро/газодинамика, горение, сверхзвук и т.д. | 🟡 только проверенные шаги; непроверенные явно перечисляются |
| **Интервью + правила** | когда непонятно, что нужно: класс задачи, Mach/Re, теплообмен, горение… | рекомендации со статусом и источником |

## 1. Пример профиля `example-channel` (быстрый старт)

В поставке есть **синтетический** профиль-пример: сетка → ламинарный решатель → инициализация →
критерии по невязкам → сохранение. Он не воспроизводит чужой расчёт и не содержит чужих данных.

> «Создай тестовый кейс по профилю example-channel, сетка /path/to/channel.msh»

1. `fluent_case_profiles({profile:"example-channel"})` — параметры и значения по умолчанию.
2. `fluent_case_plan({profile:"example-channel", params:{meshFile:"/path/to/channel.msh"}})` —
   сухой прогон **без записи**: имя каталога, вычисляемое `y_mid`, пресет `quick`/`fine`,
   список файлов, полный журнал, оффлайн-проверка.
3. `fluent_case_generate({profile:"example-channel", params:{...}})` — создаёт каталог кейса.
4. `fluent_case_validate({caseDir})` — проверяет `setup_case.jou` по индексу команд.
5. `fluent_case_run({action:"start", caseDir, confirm:true})` — запускает Fluent с журналом.
6. `fluent_case_run({action:"status", caseDir})` — лог, ошибки, наличие `.cas.h5/.dat.h5`.

### Что создаётся в каталоге кейса

```
<caseRoots[0]>/channel_L-1000mm_h-10mm/
├── setup_case.jou     # журнал: read-case, mesh/check, laminar, solver, init, residual criteria, save
├── case.json          # манифест: параметры, пресет, файлы, ожидаемые результаты
├── data/, archive/    # рабочие каталоги
└── workflow.log       # файл-маркер (не папка)
```

### Параметры профиля

| Параметр | По умолчанию | Смысл |
|---|---|---|
| `meshFile` | `/path/to/channel.msh` | путь к вашей сетке `.msh` (обязательно заменить) |
| `L` | 1000 | длина канала, мм (в имени кейса) |
| `h` | 10 | высота канала, мм (в имени кейса и в вычислении `y_mid`) |
| `iterations` | 500 | максимум итераций |

Пресет выбирается автоматически по `presetWhen`: при `iterations < 1000` — `quick`
(критерий невязок `1e-3`), иначе `fine` (`1e-4`).

### Свой профиль

Скопируйте `data/profiles/example-channel`, переименуйте `id`, опишите параметры/вычисления/ассеты
и шаблоны по контракту `docs/FORMATS.md` §1. Приватные проектные профили удобно держать вне
репозитория и подключать через `config.profileDirs`.

## 2. Новая задача: интервью и универсальная спецификация

> «Нужен расчёт сверхзвукового течения в сопле, Mach 2.5, сетка есть, хочу поля температуры и давления»

1. `fluent_case_interview({answers:{...}})` — плагин вернёт:
   - `next[]` — следующие вопросы пользователю (их задаёт агент, не плагин);
   - `recommendations` — что включить (например `solver.type=density-based-implicit`,
     `physics.compressible=true`, `physics.turbulence.model=kw-sst`, `physics.energy=true`);
   - `matchedRules[]` — какие инженерные правила сработали, почему, статус и источник в KB;
   - `completeness` — сколько ответов собрано, чего не хватает;
   - `draftSpec` — черновик спецификации кейса.
2. `fluent_case_plan({spec})` — соберёт журнал из **проверенных рецептов** (сухой прогон):
   - `sections` — какие рецепты вошли;
   - `unsupported` — какие шаги нельзя сгенерировать на текущей KB (например inlet/outlet BC,
     transient, `/mesh/scale`) и почему;
   - `derived` — шаги, выведенные из справки/журналов (требуют живой проверки);
   - `validation` — оффлайн-проверка по `commands.csv`.

3. `fluent_case_generate({spec, outputDir, name})` — материализует кейс: пишет `setup_case.jou`
   (только проверенные шаги) и `case.json` в каталог `outputDir` внутри `caseRoots`.
   Пути к сетке/UDF берутся из спеки, файлы не копируются — кейс запускается из своего каталога.

Формат спецификации — `docs/CASE_SPEC.md`. Ключевые блоки: `mesh`, `physics`, `materials`,
`boundary`, `solver`, `initialization`, `convergence` (критерии остановки!), `outputs`
(поля для экспорта, бэкапы), `run` (этапы, sweep expression).

## 3. Критерии остановки, бэкапы и выходные поля

Плагин поддерживает то, что просили:

- **Критерии остановки**: `convergence.residuals` (порог невязок), `convergence.stopping.type`
  (`iterations | report-criteria | residuals | physical-time | custom`), `reports[].stop` —
  критерий по интегральному отчёту (conv-reports). В профиле-примере это пресеты `quick`/`fine`.
- **Бэкапы**: `fluent_case_run` перед каждым запуском копирует журналы/скрипты/существующие
  `.cas.h5/.dat.h5` в `archive/pre-<name>-<ts>/`; `fluent_case_generate` при `force:true`
  уводит старую версию кейса в `archive/<naming>.<ts>/`.
- **Поля для анализа**: `outputs.exports[]` → строки `/file/export/ascii …`; если профиль задаёт экспорт, он выполняется в его run-скрипте.

## 3.1. Отчёт о задаче и заметки (для мейнтейнера)

Коллега после работы создаёт один файл-отчёт и отправляет его мейнтейнеру:

- `fluent_task_log({caseDir, kind:"question", message:"…"})` — заметки по ходу: что не вышло,
  чем пришлось обходить, какие вопросы остались. Пишутся в `<caseDir>/analysis/task-notes.jsonl`.
- `fluent_task_report({caseDir|profile+params|spec, title, kind, description, expectations,
  notes, questions})` — самодостаточный JSON + Markdown: окружение (ОС, Node, Python, **версия и
  build Fluent**, лицензия), постановка, интервью и рекомендации, кейс/спека, проверка журнала
  по KB, лог запуска (усечённый), автоматический анализ стадий и ошибок, список пробелов и
  вопросов мейнтейнеру. Секретов и лицензионных ключей в отчёте нет.
- Мейнтейнер складывает JSON в `learning/inbox/` и запускает
  `node scripts/ingest-report.mjs --out learning` → `learning/backlog.md`.

Формат отчёта и весь цикл обучения — `docs/REPORT_FORMAT.md` и `docs/MAINTAINING.md`.

## 3.2. Конфигурация

Плагин переносим: машинные пути не «зашиты» в пакет. Приоритет:
`DEFAULTS → config строки плагина → внешний config.json → env`.

- Внешний файл: `~/.config/fluent-case-builder/config.json` (или `$XDG_CONFIG_HOME/...`);
  путь можно переопределить `FLUENT_CONFIG`.
- Переменные: `FLUENT_PATH`, `ANSYSLMD_LICENSE_FILE`, `FLUENT_KB_ROOT`, `FLUENT_KB_INDEX`,
  `FLUENT_CASE_ROOTS` (через `:`), `FLUENT_PROFILE_DIRS`, `FLUENT_REPORT_DIR`,
  `FLUENT_REGISTRY_PATH`, `FLUENT_ALLOW_RUN`.
- `caseRoots` по умолчанию — `~/fluent-cases`; `allowRun` по умолчанию `false`.
- KB необязательна: без `kbRoot`/`indexDir` инструменты KB и оффлайн-валидация отключаются
  с подсказкой. Профили ищутся в `data/profiles` и `profileDirs`.

## 4. Инструменты (кратко)

| Инструмент | Что делает | Пишет на диск |
|---|---|---|
| `fluent_case_profiles` | список профилей и параметров | нет |
| `fluent_case_interview` | вопросы, рекомендации моделей, черновик spec | нет |
| `fluent_case_plan` | сухой прогон: каталог, вычисления, журнал, проверка | нет |
| `fluent_case_generate` | создаёт файлы кейса и `case.json` | да (в `caseRoots`) |
| `fluent_case_validate` | оффлайн-проверка журнала по KB | нет |
| `fluent_case_status` | манифест, выходы, последний запуск, лог | нет |
| `fluent_case_list` | реестр созданных кейсов | нет |
| `fluent_case_run` | `start`/`status`/`stop` процесса Fluent | лог, бэкапы |
| `fluent_kb_search` | поиск по командам/вопросам KB | нет |
| `fluent_kb_get` | чтение документа KB | нет |
| `fluent_task_log` | заметка исполнителя в журнал задачи | да (`task-notes.jsonl`) |
| `fluent_task_report` | отчёт о задаче JSON+MD для мейнтейнера | да (в `analysis/`) |

## 5. Расширение: новый проект или новое знание

- **Новый проектный кейс** — добавьте `data/profiles/<id>/profile.json` + шаблоны
  (`setup_case.jou.tmpl`, `start.sh.tmpl`) по контракту `docs/FORMATS.md` §1, зарегистрируйте
  `templateRoots`/`profileRoots` в `cordis.patch.yml`. Код не меняется.
- **Новая проверенная команда** — `data/recipes/<id>.json` (журнальная строка, статус, источник
  `файл:строки`). Компилятор включит её автоматически; непроверенная не попадёт в журнал.
- **Новое инженерное правило** — `data/rules/physics-rules.json`: `when` → `recommend` + `why` +
  `source`. Например «Re ≥ 5000 → k-ω SST» уже работает.
- **Новый вопрос интервью** — `data/rules/questions.json` с `specPath` в спецификацию.

Правило: **сначала проверить в живой сессии Fluent, потом добавлять в данные**. Именно поэтому
в `unsupported` попадают inlet/outlet BC, transient, `/mesh/scale`, under-relaxation.

## 6. Безопасность и ограничения

- Запись только в `caseRoots` из конфига; путь проверяется.
- `allowRun` в конфиге: `true` — запуск разрешён; сам запуск всегда требует `confirm:true`.
- Остановка: `fluent_case_run({action:"stop"})` убивает группу процессов.
- Строки `/solve/set/under-relaxation …` и `/solve/initialize fmg-initialization …` в проверенных журналах 2025 R1
  пришли из журналов 2025 R1 (валидатор помечает их `journal-2025`). Живой прогон 2026-11-11 показал,
  что Fluent 2026 R1 их **принимает**. В конце журнала возможна безвредная ошибка
  `invalid command: yes` — это batch-подтверждение перезаписи после успешной записи `.cas.h5/.dat.h5`;
  `fluent_case_status` в этом случае даёт `status: configured` и предупреждение, а не «провал».
