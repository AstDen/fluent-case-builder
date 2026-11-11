# Форматы данных плагина `fluent-case-builder`

Плагин универсален: всё предметное знание вынесено в JSON-данные. Код только исполняет.
Три вида данных: **профиль** (конкретный проект/кейс), **рецепт** (проверенный блок журнала),
**правило/вопрос** (инженерные рекомендации и интервью).

Все JSON — UTF-8, без комментариев, без trailing comma. Плейсхолдеры в строках — `{{name}}`.

---

## 1. Профиль кейса — `data/profiles/<id>/profile.json`

Профиль описывает повторяемый кейс: параметры, вычисляемые величины, имя директории,
ассеты (сетка/UDF/TSV), подстановки и шаблоны журналов.

```json
{
  "id": "example-channel",
  "title": "Пример: ламинарный канал (синтетический шаблон)",
  "description": "Минимальный учебный кейс: сетка, модели, инициализация, критерии, сохранение.",
  "category": "example",
  "version": 1,
  "status": "example",
  "source": "synthetic",
  "params": {
    "meshFile": {
      "type": "string", "required": true, "default": "/path/to/channel.msh",
      "description": "путь к вашей сетке .msh"
    },
    "L": { "type": "number", "unit": "mm", "default": 1000, "description": "длина канала" },
    "h": { "type": "number", "unit": "mm", "default": 10, "description": "высота канала" },
    "iterations": { "type": "integer", "default": 500, "description": "максимум итераций" }
  },
  "computed": {
    "y_mid": "python: f'{h / 2000:.6f}'"
  },
  "naming": "channel_L-{L}mm_h-{h}mm",
  "caseFileBase": "channel_L-{L}mm_h-{h}mm_start",
  "presets": {
    "quick": { "residuals": "1e-3" },
    "fine": { "residuals": "1e-4" }
  },
  "presetWhen": { "quick": "iterations < 1000", "fine": "true" },
  "assets": [],
  "directories": ["data", "archive"],
  "touchFiles": ["workflow.log"],
  "templates": { "setupJournal": "templates/setup_case.jou.tmpl" },
  "outputs": ["{{caseFileBase}}.cas.h5", "{{caseFileBase}}.dat.h5"],
  "verification": {
    "status": "example",
    "date": "2026-11-11",
    "evidence": "синтетический пример; журнал собран только из проверенных рецептов",
    "notes": "шаблон для обучения формату профиля"
  }
}
```

Правила:
- `params[*].type` ∈ `number | integer | string | boolean | array`.
- `computed` — арифметика над параметрами (`+ - * / **`, скобки, Math-функции), либо `python: ...` (например, форматирование `y_mid`).
- `{{animation}}` — вычисляемое имя: `animation_` + `naming` (без параметров), задаётся профилем.
- `{{templateRoot}}` — конфиг `templateRoots[profileId]` (если профиль копирует свои ассеты).
- В профиле не должно быть абсолютных путей к данным пользователя, кроме `source`.

### Дополнения к формату профиля (реализованы движком)

| Поле | Смысл |
|---|---|
| `outputRoot` | шаблон корня вывода, напр. `"{{solutionsRoot}}/{{project}}"`; `{{solutionsRoot}}` = `config.profileRoots[id]`. Переопределяется параметром инструмента `outputRoot`. |
| `animation` | шаблон имени animation-каталога, напр. `"animation_{name}"`, `{name}` = `naming`. |
| `computed.<name> = "python: f'{...}'"` | вычисление через python3 (нужно для точного форматирования чисел в именах и шаблонах); данные профиля доверенные, shell не используется. |
| `assets[].optional: true` | отсутствующий исходный файл не валит генерацию, а даёт предупреждение. |
| `assets[].mode` | `copy`, `copyIfExists`, `skip-if-missing`, `unzip`, `unzip-flat` (распаковка с «выравниванием» файлов в корень кейса — нужно для zip с вложенным каталогом). |
| `params.meshZip` (пример) | параметр-переопределение пути к сетке поверх вычисленного значения. |

### Шаблоны профиля

`templates/setup_case.jou.tmpl` — journal, где вместо значений стоят плейсхолдеры
`{{meshFile}} {{L}} {{h}} {{iterations}} {{residuals}} {{y_mid}} {{caseFileBase}}`,
`templates/start.sh.tmpl` — bash-скрипт с теми же плейсхолдерами и списком `{{FR}}`
(разворачивается в пробел-разделённый список `10 20 30 …`).

---

## 2. Рецепт проверенной команды — `data/recipes/<id>.json`

Рецепт — атомарный, проверенный в TUI блок журнала. Универсальный компилятор собирает журнал
только из рецептов; всё, чего нет в рецептах, помечается «требует проверки» и не попадает в журнал
молча.

```json
{
  "id": "models.energy",
  "title": "Уравнение энергии",
  "category": "models",
  "status": "verified",
  "confidence": "high",
  "source": "04_MODELS/energy.md:21-43; QA_LOG Q-006",
  "date": "2026-11-11",
  "journal": ["/define/models energy yes no no no yes"],
  "interactive": "/define/models/energy? → yes, no, no, no, yes",
  "requires": [],
  "conflicts": ["models.energy-off"],
  "params": [],
  "notes": "5 вопросов; журнальная форма проверена в рабочем журнале пользователя"
}
```

Поля:
- `journal` — массив готовых строк; плейсхолдеры `{{param}}` допустимы, если объявлены в `params`.
- `params` — `[{ "name": "model", "type": "enum", "values": ["kw-sst"], "default": "kw-sst" }]`.
- `status` ∈ `verified | derived | unverified`; `confidence` ∈ `high | medium | low`.
- `requires` — id рецептов, которые обязаны идти раньше.
- `conflicts` — id рецептов, несовместимых с этим.
- `interactive` — человекочитаемая последовательность вопросов.

Обязательный минимум рецептов (по результатам аудита KB):
`models.solver.pressure-based`, `models.solver.density-based-implicit`,
`solver.pv-coupling` (коды 20/21/22/24), `models.energy`, `models.viscous.laminar`,
`models.viscous.kw-sst`, `materials.ideal-gas.fluid`, `materials.ideal-gas.mixture`,
`init.hybrid`, `report.definitions` (пример), `report.conv-reports` (пример), `report.files`,
`report.plots`, `monitor.residual-criteria`, `solve.number-of-iterations`,
`solve.reporting-interval`, `solve.iterate`, `file.write-case-data`, `file.export-ascii`,
`udf.compile-load-hook`, `models.species-transport`, `boundary.mass-flow-inlet.chain`,
`boundary.fluid.porous`, `boundary.zone-type`, `boundary.zone-name`.
Для непроверенных — `status: "unverified"` и `journal: []`, с цитатой из KB, что именно неизвестно.
**Не выдумывать строки.** Если в KB только справка без проверки — рецепт `derived`/`unverified`,
`journal` пустой или помечен.

---

## 3. Инженерные правила — `data/rules/physics-rules.json`

```json
{
  "version": 1,
  "rules": [
    {
      "id": "turbulence.re",
      "title": "Турбулентность при Re > 5000",
      "when": { "re": { ">=": 5000 } },
      "recommend": { "physics.turbulence.model": "kw-sst" },
      "why": "При Re>5000 течение турбулентное; в проверенном рабочем журнале при Re>5000 включается k-ω SST.",
      "status": "derived",
      "confidence": "high",
      "source": "ИНСТРУКЦИЯ-ПО-СОЗДАНИЮ-КЕЙСА.md; 04_MODELS/viscous.md",
      "recipes": ["models.viscous.kw-sst"]
    }
  ]
}
```

`when` — объект условий; ключ — путь параметра кейса (`re`, `mach`, `physics.energy`, `combustion`,
`temperature.max`, `compressible`, `heatTransfer`, `radiation`, `multiphase`, `particles`, `transient`,
`udf`, …), значение — скаляр (равенство), `{">=",">","<","<=","in":[...]}`.
Правила упорядочены по приоритету; одинаковые `recommend`-ключи перекрываются последним.
Обязательно покрыть: сжимаемость/Mach, турбулентность/Re, энергия/теплообмен, горение/химия,
излучение при высоких T, многофазность, частицы/DPM, transient, UDF, выбор решателя
(pressure-based vs density-based).

---

## 4. Вопросы интервью — `data/rules/questions.json`

```json
{
  "version": 1,
  "sections": [
    {
      "id": "task",
      "title": "Задача",
      "questions": [
        {
          "id": "task.kind",
          "text": "Какой класс задачи?",
          "type": "enum",
          "values": ["hydrodynamics", "gas-dynamics", "combustion", "engines", "supersonic", "chemical-reactions", "heat-transfer", "multiphase", "other"],
          "default": "hydrodynamics",
          "why": "от класса зависит набор моделей и рекомендаций",
          "specPath": "meta.taskKind",
          "required": true
        }
      ]
    }
  ]
}
```

`specPath` — куда ответ попадает в case spec. `type` ∈ `enum|string|number|boolean|array`.
Вопросы должны покрывать: класс задачи, размерность, сжимаемость/Mach, Re/скорость, теплообмен,
горение/механизм, излучение, многофазность, частицы, UDF, сетка (файл/единицы/масштаб),
материалы, ГУ (тип входа/выхода, значения), критерии остановки, бэкапы, выходные поля, ресурсы.

---

## 5. Case Spec (его собирает интервью/правила, его исполняет движок)

См. `docs/CASE_SPEC.md`. Профильные кейсы (`example-channel`) используют spec только как
`{ profile: "example-channel", params: {...} }`; универсальные — полный spec.
