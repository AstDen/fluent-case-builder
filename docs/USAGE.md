# How to use `fluent-case-builder`

The plugin lives in this DSH profile and is invoked from chat with ordinary phrases. Below are the
workflows, the order of calls and what will appear on disk.

## 0. Three modes of operation

| Mode | When | Reliability |
|---|---|---|
| **Profile** (`example-channel`) | a repeatable case from parameters: mesh, models, journal template | ✅ example + format; your own profiles go to `data/profiles` or `profileDirs` |
| **Universal spec** (case spec) | a new task: hydrodynamics/gas dynamics, combustion, supersonic flow, etc. | 🟡 verified steps only; unverified ones are listed explicitly |
| **Interview + rules** | when it is unclear what is needed: task class, Mach/Re, heat transfer, combustion… | recommendations with status and source |

## 1. The `example-channel` example profile (quick start)

The distribution includes a **synthetic** example profile: mesh → laminar solver → initialization →
residual criteria → save. It does not reproduce someone else's computation and contains no
third-party data.

> "Create a test case from the example-channel profile, mesh /path/to/channel.msh"

1. `fluent_case_profiles({profile:"example-channel"})` — parameters and default values.
2. `fluent_case_plan({profile:"example-channel", params:{meshFile:"/path/to/channel.msh"}})` —
   a dry run **with nothing written**: the directory name, the computed `y_mid`, the
   `quick`/`fine` preset, the file list, the full journal, the offline validation.
3. `fluent_case_generate({profile:"example-channel", params:{...}})` — creates the case directory.
4. `fluent_case_validate({caseDir})` — validates `setup_case.jou` against the command index.
5. `fluent_case_run({action:"start", caseDir, confirm:true})` — launches Fluent with the journal.
6. `fluent_case_run({action:"status", caseDir})` — log, errors, presence of `.cas.h5/.dat.h5`.

### What is created in the case directory

```
<caseRoots[0]>/channel_L-1000mm_h-10mm/
├── setup_case.jou     # journal: read-case, mesh/check, laminar, solver, init, residual criteria, save
├── case.json          # manifest: parameters, preset, files, expected results
├── data/, archive/    # working directories
└── workflow.log       # marker file (not a directory)
```

### Profile parameters

| Parameter | Default | Meaning |
|---|---|---|
| `meshFile` | `/path/to/channel.msh` | path to your `.msh` mesh (you must replace it) |
| `L` | 1000 | channel length, mm (used in the case name) |
| `h` | 10 | channel height, mm (used in the case name and in the `y_mid` computation) |
| `iterations` | 500 | iteration limit |

The preset is chosen automatically via `presetWhen`: with `iterations < 1000` — `quick`
(residual criterion `1e-3`), otherwise `fine` (`1e-4`).

### Your own profile

Copy `data/profiles/example-channel`, rename the `id`, describe the parameters/computations/assets
and templates according to the contract in `docs/FORMATS.md` §1. Private project profiles are best
kept outside the repository and connected through `config.profileDirs`.

## 1.1. A question about a Fluent feature (the most common scenario)

It is enough to open a session and ask. For reliability, name the tool explicitly:

> "How do I enable k-ω SST? Through `fluent_kb_search`, show the journal line, the status and the
> source."

The sequence the agent follows:

1. `fluent_kb_search({query:"k-ω SST", scope:"all"})` — the built-in command index + verified
   recipes (journal lines with status and source).
2. If needed, `fluent_kb_get({path:"KB/04_MODELS/viscous.md"})` — the full document
   (requires `kbRoot`; without it the tool returns a hint).
3. The answer: journal line → interactive chain → dependencies → how to verify → status → source.

**Checking that the answer comes from the plugin KB:**

- the session shows `fluent_kb_search`/`fluent_kb_get` calls (tool cards in the Web UI);
- the answer has the `status` (verified/derived/unverified) and `source` (a KB path or a recipe id)
  fields;
- ask for "show the raw output of `fluent_kb_search`" — it will contain `path`, `question`,
  `blocked`, `journal`, `source`;
- signs of "not from the KB": no status/source, or the tool returned `configured: false`.

## 2. A new task: interview and the universal spec

> "I need a supersonic nozzle flow computation, Mach 2.5, the mesh is ready, I want temperature and
> pressure fields"

1. `fluent_case_interview({answers:{...}})` — the plugin returns:
   - `next[]` — the next questions for the user (the agent asks them, not the plugin);
   - `recommendations` — what to enable (for example `solver.type=density-based-implicit`,
     `physics.compressible=true`, `physics.turbulence.model=kw-sst`, `physics.energy=true`);
   - `matchedRules[]` — which engineering rules fired, why, their status and the KB source;
   - `completeness` — how many answers were collected and what is missing;
   - `draftSpec` — a draft of the case spec.
2. `fluent_case_plan({spec})` — assembles the journal from **verified recipes** (a dry run):
   - `sections` — which recipes were included;
   - `unsupported` — which steps cannot be generated with the current KB (inlet/outlet BC,
     transient, `/mesh/scale`, for example) and why;
   - `derived` — steps derived from help/journals (they require live verification);
   - `validation` — the offline check against `commands.csv`.

3. `fluent_case_generate({spec, outputDir, name})` — materializes the case: writes `setup_case.jou`
   (verified steps only) and `case.json` into the `outputDir` directory inside `caseRoots`.
   Mesh/UDF paths come from the spec and the files are not copied — the case is run from its own
   directory.

The spec format is in `docs/CASE_SPEC.md`. Key blocks: `mesh`, `physics`, `materials`,
`boundary`, `solver`, `initialization`, `convergence` (stopping criteria!), `outputs`
(fields to export, backups), `run` (stages, expression sweep).

## 3. Stopping criteria, backups and output fields

The plugin supports what was asked for:

- **Stopping criteria**: `convergence.residuals` (residual threshold), `convergence.stopping.type`
  (`iterations | report-criteria | residuals | physical-time | custom`), `reports[].stop` —
  a criterion based on an integral report (conv-reports). In the example profile these are the
  `quick`/`fine` presets.
- **Backups**: before every run `fluent_case_run` copies journals/scripts/existing
  `.cas.h5/.dat.h5` into `archive/pre-<name>-<ts>/`; with `force:true`, `fluent_case_generate`
  moves the old case version to `archive/<naming>.<ts>/`.
- **Fields for analysis**: `outputs.exports[]` → `/file/export/ascii …` lines; if the profile
  defines an export, it runs in its run script.

## 3.1. The task report and notes (for the maintainer)

After finishing the work, a colleague creates a single report file and sends it to the maintainer:

- `fluent_task_log({caseDir, kind:"question", message:"…"})` — notes along the way: what did not
  work, what workarounds were needed, what questions remain. They are written to
  `<caseDir>/analysis/task-notes.jsonl`.
- `fluent_task_report({caseDir|profile+params|spec, title, kind, description, expectations,
  notes, questions})` — self-contained JSON + Markdown: environment (OS, Node, Python, **Fluent
  version and build**, license), statement, interview and recommendations, case/spec, KB journal
  validation, run log (truncated), automatic analysis of stages and errors, a list of gaps and
  questions for the maintainer. There are no secrets or license keys in the report.
- The maintainer puts the JSON into `learning/inbox/` and runs
  `node scripts/ingest-report.mjs --out learning` → `learning/backlog.md`.

The report format and the whole learning cycle are described in `docs/REPORT_FORMAT.md` and
`docs/MAINTAINING.md`.

## 3.2. Configuration

The plugin is portable: machine paths are not hard-coded into the package. Priority:
`DEFAULTS → plugin config line → external config.json → env`.

- External file: `~/.config/fluent-case-builder/config.json` (or `$XDG_CONFIG_HOME/...`);
  the path can be overridden with `FLUENT_CONFIG`.
- Variables: `FLUENT_PATH`, `ANSYSLMD_LICENSE_FILE`, `FLUENT_KB_ROOT`, `FLUENT_KB_INDEX`,
  `FLUENT_CASE_ROOTS` (separated by `:`), `FLUENT_PROFILE_DIRS`, `FLUENT_REPORT_DIR`,
  `FLUENT_REGISTRY_PATH`, `FLUENT_ALLOW_RUN`.
- `caseRoots` defaults to `~/fluent-cases`; `allowRun` defaults to `false`.
- The KB is optional: without `kbRoot`/`indexDir` the KB tools and offline validation are disabled
  with a hint. Profiles are looked up in `data/profiles` and `profileDirs`.

## 4. Tools (briefly)

| Tool | What it does | Writes to disk |
|---|---|---|
| `fluent_case_profiles` | list of profiles and their parameters | no |
| `fluent_case_interview` | questions, model recommendations, spec draft | no |
| `fluent_case_plan` | dry run: directory, computations, journal, validation | no |
| `fluent_case_generate` | creates the case files and `case.json` | yes (into `caseRoots`) |
| `fluent_case_validate` | offline validation of the journal against the KB | no |
| `fluent_case_status` | manifest, outputs, last run, log | no |
| `fluent_case_list` | registry of generated cases | no |
| `fluent_case_run` | `start`/`status`/`stop` of the Fluent process | log, backups |
| `fluent_kb_search` | search across KB commands/questions | no |
| `fluent_kb_get` | read a KB document | no |
| `fluent_task_log` | an implementer's note in the task journal | yes (`task-notes.jsonl`) |
| `fluent_task_report` | a JSON+MD task report for the maintainer | yes (into `analysis/`) |
| `fluent_plugin_update` | check/plan/script/apply a plugin update | yes (script/profile) |

## 5. Extending: a new project or new knowledge

- **A new project case** — add `data/profiles/<id>/profile.json` + templates
  (`setup_case.jou.tmpl`, `start.sh.tmpl`) according to the contract in `docs/FORMATS.md` §1, and
  register `templateRoots`/`profileRoots` in `cordis.patch.yml`. No code changes.
- **A new verified command** — `data/recipes/<id>.json` (journal line, status, source
  `file:lines`). The compiler picks it up automatically; an unverified recipe never reaches the
  journal.
- **A new engineering rule** — `data/rules/physics-rules.json`: `when` → `recommend` + `why` +
  `source`. For example "Re ≥ 5000 → k-ω SST" already works.
- **A new interview question** — `data/rules/questions.json` with a `specPath` into the spec.

The rule: **verify in a live session Fluent first, then add to the data.** That is exactly why
inlet/outlet BCs, transient, `/mesh/scale` and under-relaxation end up in `unsupported`.

## 6. Security and limitations

- Writing is allowed only into `caseRoots` from the config; the path is validated.
- `allowRun` in the config: `true` — runs are allowed; a run itself always requires `confirm:true`.
- Stop: `fluent_case_run({action:"stop"})` kills the process group.
- The `/solve/set/under-relaxation …` and `/solve/initialize fmg-initialization …` lines in verified
  journals came from 2025 R1 journals (the validator marks them `journal-2025`). A live run on
  2026-11-11 showed that Fluent 2026 R1 **accepts** them. At the end of the journal a harmless
  `invalid command: yes` error is possible — it is the batch confirmation of overwriting after a
  successful `.cas.h5/.dat.h5` write; in that case `fluent_case_status` reports `status: configured`
  plus a warning instead of a "failure".
