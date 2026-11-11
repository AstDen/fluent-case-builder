# Case Spec — универсальное описание расчётного кейса

Один JSON-объект описывает кейс целиком: от сетки до критериев остановки и выходных полей.
Инструмент `fluent_case_plan` принимает его (или профиль+параметры) и строит план,
`fluent_case_generate` — материализует файлы, `fluent_case_validate` — проверяет журнал,
`fluent_case_run` — запускает.

```json
{
  "meta": {
    "name": "my-case",
    "taskKind": "gas-dynamics",
    "description": "свободное описание задачи",
    "created": "2026-11-11"
  },
  "fluent": {
    "dimension": "3ddp",
    "threads": 8,
    "mpi": "intel",
    "affinity": "core",
    "extraArgs": []
  },
  "mesh": {
    "kind": "single",
    "files": ["/path/to/mesh.msh"],
    "casePath": null,
    "units": "mm",
    "scale": [0.001, 0.001, 0.001],
    "check": true,
    "renames": [{ "from": "fluid-1", "to": "fluid" }],
    "zoneTypes": [{ "zone": "inlet", "type": "mass-flow-inlet" }],
    "appendMesh": [],
    "interfaces": "auto"
  },
  "physics": {
    "compressibility": "incompressible",
    "mach": 0.0,
    "reynolds": 12000,
    "energy": true,
    "turbulence": { "model": "kw-sst" },
    "species": { "enabled": true, "mixture": "mixture-material", "reactions": true },
    "radiation": { "enabled": true, "model": "discrete-ordinates" },
    "multiphase": { "enabled": false, "model": "none" },
    "particles": { "enabled": false },
    "udf": { "enabled": true, "files": [], "library": "", "hooks": [] },
    "axisymmetric": false
  },
  "materials": [
    { "action": "change", "name": "air", "type": "fluid", "density": "ideal-gas" }
  ],
  "boundary": {
    "zones": [
      { "zone": "inlet", "type": "mass-flow-inlet", "role": "inlet",
        "values": { "massFlow": 0.01, "temperature": 2000 } },
      { "zone": "outlet", "type": "pressure-outlet", "role": "outlet",
        "values": { "gaugePressure": 0 } }
    ]
  },
  "solver": {
    "type": "pressure-based",
    "p-v-coupling": "SIMPLE",
    "iterations": 1000
  },
  "initialization": { "method": "hybrid" },
  "convergence": {
    "residuals": [0.5, 0.001, 0.001, 0.001, 0.000005],
    "stopping": { "type": "report-criteria", "frequency": 100 },
    "reports": [
      { "name": "rd---temp-outlet", "type": "surface-areaavg", "field": "temperature",
        "surfaces": ["outlet"], "stop": 1e-3 }
    ]
  },
  "outputs": {
    "reportFile": "data/all_data_file.out",
    "reportPlots": true,
    "exports": [
      { "file": "out/fields", "surfaces": ["wall-zone-fluid"], "fields": ["temperature", "pressure"] }
    ],
    "backups": { "enabled": true, "everyIterations": 500, "keep": 5, "path": "archive" }
  },
  "run": {
    "stages": [
      { "name": "startFR", "iterate": 1 },
      { "name": "sweep", "iterate": 1000000, "expressionSweep": { "name": "Inlet_Velocity", "values": [10, 20, 30] } }
    ]
  },
  "provenance": {
    "profile": null,
    "rules": ["turbulence.re"],
    "confidence": "derived",
    "warnings": []
  }
}
```

## Семантика ключевых полей

| Поле | Значение |
|---|---|
| `mesh.kind` | `single` — один `.msh` через `/file/read-case`; `case` — готовый `.cas.h5`; `zip` — архив (профильная логика). |
| `mesh.scale` | если `units != "m"`, масштаб **должен** быть подтверждён (KB: `/mesh/scale` не проверен — 🔴). |
| `physics.turbulence.model` | `laminar`, `kw-sst`, `ke-realizable`, `spalart-allmaras`, … |
| `solver.p-v-coupling` | `SIMPLE=20`, `SIMPLEC=21`, `PISO=22`, `Coupled=24`. |
| `convergence.stopping.type` | `iterations`, `report-criteria`, `residuals`, `physical-time`, `custom`. |
| `outputs.backups` | бэкап кейса/данных во время расчёта: частота в итерациях, сколько хранить. |
| `run.stages` | этапы расчёта; `expressionSweep` — перебор значения Named Expression с сохранением результата на каждом шаге. |
| `provenance` | какие правила сработали, какие предупреждения, чей профиль. |

## Правила компиляции журнала

1. Журнал собирается **только из рецептов** (`data/recipes/*.json`) со статусом `verified`.
2. Всё непроверенное → `warnings[]` + отдельный блок `requires_verification` в плане; в журнал не попадает.
3. Порядок: mesh → models → materials → boundary → udf/expressions → solver → initialization →
   reports/convergence → outputs → run → save.
4. Число `q` берётся из рецепта (в KB оно не выводимо формально — это ключевое ограничение).
5. Журнал всегда завершается `/file/write-case-data "<name>" yes` и `/exit yes`.

## Различие «профильный» и «универсальный» путь

- **Профиль** (`{ "profile": "example-channel", "params": {...} }`) — материализует готовый проектный
  кейс по шаблонам; самый надёжный путь (эталон проверен на 43 кейсах).
- **Универсальный spec** — собирает журнал из рецептов; на текущей KB он принципиально не может
  покрыть скорость/давление на входе, тепловую стенку, transient и `/mesh/scale` (🔴) — эти места
  явно помечаются в плане, а не подставляются наугад.
