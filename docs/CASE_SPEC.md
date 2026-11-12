# Case Spec — universal description of a computational case

A single JSON object describes the whole case: from the mesh to the stopping criteria and output
fields. The `fluent_case_plan` tool accepts it (or a profile + parameters) and builds a plan,
`fluent_case_generate` materializes the files, `fluent_case_validate` validates the journal and
`fluent_case_run` launches it.

```json
{
  "meta": {
    "name": "my-case",
    "taskKind": "gas-dynamics",
    "description": "free-form task description",
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

## Semantics of key fields

| Field | Meaning |
|---|---|
| `mesh.kind` | `single` — one `.msh` through `/file/read-case`; `case` — a ready `.cas.h5`; `zip` — an archive (profile logic). |
| `mesh.scale` | if `units != "m"`, the scale **must** be confirmed (KB: `/mesh/scale` is not verified — 🔴). |
| `physics.turbulence.model` | `laminar`, `kw-sst`, `ke-realizable`, `spalart-allmaras`, … |
| `solver.p-v-coupling` | `SIMPLE=20`, `SIMPLEC=21`, `PISO=22`, `Coupled=24`. |
| `convergence.stopping.type` | `iterations`, `report-criteria`, `residuals`, `physical-time`, `custom`. |
| `outputs.backups` | case/data backups during the run: the frequency in iterations and how many to keep. |
| `run.stages` | run stages; `expressionSweep` sweeps a Named Expression value, saving the result at every step. |
| `provenance` | which rules fired, which warnings were issued, whose profile this is. |

## Journal compilation rules

1. The journal is assembled **only from recipes** (`data/recipes/*.json`) with the `verified` status.
2. Everything unverified → `warnings[]` + a separate `requires_verification` block in the plan; it
   never reaches the journal.
3. Order: mesh → models → materials → boundary → udf/expressions → solver → initialization →
   reports/convergence → outputs → run → save.
4. The number of `q` answers comes from the recipe (it cannot be formally derived from the KB — this
   is the key limitation).
5. The journal always ends with `/file/write-case-data "<name>" yes` and `/exit yes`.

## The difference between the "profile" and the "universal" path

- **Profile** (`{ "profile": "example-channel", "params": {...} }`) — materializes a ready project
  case from templates; the most reliable path (the reference was verified on 43 cases).
- **Universal spec** — assembles the journal from recipes; with the current KB it fundamentally
  cannot cover inlet velocity/pressure, a thermal wall, transient or `/mesh/scale` (🔴) — those
  places are explicitly flagged in the plan instead of being filled in at random.
