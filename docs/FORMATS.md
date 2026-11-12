# Data formats of the `fluent-case-builder` plugin

The plugin is generic: all domain knowledge lives in JSON data. The code only executes it.
Three kinds of data: a **profile** (a specific project/case), a **recipe** (a verified journal
block), a **rule/question** (engineering recommendations and the interview).

All JSON is UTF-8, no comments, no trailing commas. Placeholders in strings are `{{name}}`.

---

## 1. Case profile — `data/profiles/<id>/profile.json`

A profile describes a repeatable case: parameters, computed values, the directory name, assets
(mesh/UDF/TSV), substitutions and journal templates.

```json
{
  "id": "example-channel",
  "title": "Example: laminar channel (synthetic template)",
  "description": "Minimal tutorial case: mesh, models, initialization, criteria, save.",
  "category": "example",
  "version": 1,
  "status": "example",
  "source": "synthetic",
  "params": {
    "meshFile": {
      "type": "string", "required": true, "default": "/path/to/channel.msh",
      "description": "path to your .msh mesh"
    },
    "L": { "type": "number", "unit": "mm", "default": 1000, "description": "channel length" },
    "h": { "type": "number", "unit": "mm", "default": 10, "description": "channel height" },
    "iterations": { "type": "integer", "default": 500, "description": "maximum iterations" }
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
    "evidence": "synthetic example; the journal is assembled only from verified recipes",
    "notes": "a template for learning the profile format"
  }
}
```

Rules:
- `params[*].type` ∈ `number | integer | string | boolean | array`.
- `computed` — arithmetic over parameters (`+ - * / **`, parentheses, Math functions), or `python: ...` (formatting `y_mid`, for example).
- `{{animation}}` — a computed name: `animation_` + `naming` (without parameters), defined by the profile.
- `{{templateRoot}}` — the config `templateRoots[profileId]` (if the profile copies its own assets).
- A profile must not contain absolute paths to user data, except in `source`.

### Additions to the profile format (implemented by the engine)

| Field | Meaning |
|---|---|
| `outputRoot` | output root template, e.g. `"{{solutionsRoot}}/{{project}}"`; `{{solutionsRoot}}` = `config.profileRoots[id]`. Overridden by the tool's `outputRoot` parameter. |
| `animation` | animation directory name template, e.g. `"animation_{name}"`, `{name}` = `naming`. |
| `computed.<name> = "python: f'{...}'"` | computation through python3 (needed for exact number formatting in names and templates); profile data is trusted, no shell is used. |
| `assets[].optional: true` | a missing source file does not fail generation but produces a warning. |
| `assets[].mode` | `copy`, `copyIfExists`, `skip-if-missing`, `unzip`, `unzip-flat` (unpacking that flattens files into the case root — needed for zips with a nested directory). |
| `params.meshZip` (example) | a parameter that overrides the mesh path on top of the computed value. |

### Profile templates

`templates/setup_case.jou.tmpl` — the journal where values are replaced by the placeholders
`{{meshFile}} {{L}} {{h}} {{iterations}} {{residuals}} {{y_mid}} {{caseFileBase}}`;
`templates/start.sh.tmpl` — a bash script with the same placeholders and the `{{FR}}` list
(expanded to a space-separated list `10 20 30 …`).

---

## 2. Verified command recipe — `data/recipes/<id>.json`

A recipe is an atomic journal block verified in the TUI. The universal compiler assembles a journal
only from recipes; anything not covered by a recipe is marked "requires verification" and never
silently reaches the journal.

```json
{
  "id": "models.energy",
  "title": "Energy equation",
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
  "notes": "5 questions; the journal form is verified in the user's working journal"
}
```

Fields:
- `journal` — an array of ready-made lines; the `{{param}}` placeholders are allowed if they are declared in `params`.
- `params` — `[{ "name": "model", "type": "enum", "values": ["kw-sst"], "default": "kw-sst" }]`.
- `status` ∈ `verified | derived | unverified`; `confidence` ∈ `high | medium | low`.
- `requires` — ids of recipes that must come earlier.
- `conflicts` — ids of recipes incompatible with this one.
- `interactive` — a human-readable sequence of questions.

The mandatory minimum of recipes (based on the KB audit):
`models.solver.pressure-based`, `models.solver.density-based-implicit`,
`solver.pv-coupling` (codes 20/21/22/24), `models.energy`, `models.viscous.laminar`,
`models.viscous.kw-sst`, `materials.ideal-gas.fluid`, `materials.ideal-gas.mixture`,
`init.hybrid`, `report.definitions` (example), `report.conv-reports` (example), `report.files`,
`report.plots`, `monitor.residual-criteria`, `solve.number-of-iterations`,
`solve.reporting-interval`, `solve.iterate`, `file.write-case-data`, `file.export-ascii`,
`udf.compile-load-hook`, `models.species-transport`, `boundary.mass-flow-inlet.chain`,
`boundary.fluid.porous`, `boundary.zone-type`, `boundary.zone-name`.
For unverified ones — `status: "unverified"` and `journal: []`, with a quote from the KB saying
exactly what is unknown. **Do not invent lines.** If the KB has only help without verification, the
recipe is `derived`/`unverified`, with `journal` empty or flagged.

---

## 3. Engineering rules — `data/rules/physics-rules.json`

```json
{
  "version": 1,
  "rules": [
    {
      "id": "turbulence.re",
      "title": "Turbulence at Re > 5000",
      "when": { "re": { ">=": 5000 } },
      "recommend": { "physics.turbulence.model": "kw-sst" },
      "why": "At Re>5000 the flow is turbulent; in the verified working journal k-ω SST is enabled at Re>5000.",
      "status": "derived",
      "confidence": "high",
      "source": "CASE-CREATION-INSTRUCTIONS.md; 04_MODELS/viscous.md",
      "recipes": ["models.viscous.kw-sst"]
    }
  ]
}
```

`when` is an object of conditions; the key is a case parameter path (`re`, `mach`, `physics.energy`,
`combustion`, `temperature.max`, `compressible`, `heatTransfer`, `radiation`, `multiphase`,
`particles`, `transient`, `udf`, …), the value is a scalar (equality) or
`{">=",">","<","<=","in":[...]}`.
Rules are ordered by priority; identical `recommend` keys are overridden by the last one.
Coverage is mandatory for: compressibility/Mach, turbulence/Re, energy/heat transfer, combustion/
chemistry, radiation at high T, multiphase, particles/DPM, transient, UDF, solver choice
(pressure-based vs density-based).

---

## 4. Interview questions — `data/rules/questions.json`

```json
{
  "version": 1,
  "sections": [
    {
      "id": "task",
      "title": "Task",
      "questions": [
        {
          "id": "task.kind",
          "text": "What is the task class?",
          "type": "enum",
          "values": ["hydrodynamics", "gas-dynamics", "combustion", "engines", "supersonic", "chemical-reactions", "heat-transfer", "multiphase", "other"],
          "default": "hydrodynamics",
          "why": "the class determines the set of models and recommendations",
          "specPath": "meta.taskKind",
          "required": true
        }
      ]
    }
  ]
}
```

`specPath` — where the answer lands in the case spec. `type` ∈ `enum|string|number|boolean|array`.
The questions must cover: task class, dimensionality, compressibility/Mach, Re/velocity, heat
transfer, combustion/mechanism, radiation, multiphase, particles, UDF, mesh (file/units/scale),
materials, BCs (inlet/outlet type, values), stopping criteria, backups, output fields, resources.

---

## 5. Case Spec (assembled by the interview/rules, executed by the engine)

See `docs/CASE_SPEC.md`. Profile cases (`example-channel`) use the spec only as
`{ profile: "example-channel", params: {...} }`; universal ones use the full spec.
