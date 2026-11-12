# fluent-case-builder

**ANSYS Fluent case builder for DeepSeek Harness.** The agent walks an engineer from the
problem statement to a ready TUI journal, case files, a controlled run and a report to the
maintainer — and never invents Fluent command syntax.

`Version 0.6.0` · `MIT license` · `Node.js ≥ 20` · `DSH ≥ 0.2.1-rc.5 < 0.3.0` · no knowledge base required

## Why this exists

A regular LLM agent asked to "set up a Fluent case" confidently makes up TUI commands —
and gets the order of dialogs, the number of `q` answers and the syntax version wrong.
`fluent-case-builder` changes the roles: **knowledge lives in the plugin data** (verified profiles,
journal recipes, engineering rules, error diagnostics), while the code only assembles a journal
from them, writes the case files and validates the result.

Hence the main principle: **journal lines are never invented.** A journal is assembled only from
recipes with status `verified` (checked in a live session / against a working journal) and
`derived` (derived from help or journals — always with an explicit warning). Anything unverified
(`unverified`) is marked as unsupported and never enters a journal. The plugin honestly says
"I can't do that" instead of generating plausible nonsense.

## Features

| Feature | What it gives you |
|---|---|
| **"How to enable X" search** | built-in index of 1736 TUI commands + 72 journal recipes (37 verified): journal line, status and source — right after installation, no KB setup |
| **Built-in skill** | the agent picks KB tools for Fluent questions on its own and does not invent syntax |
| **Task interview** | questions on task class, Mach/Re, heat transfer, combustion, radiation, multiphase, UDF, mesh, BCs and stopping criteria + model recommendations with rationale and source |
| **Profile cases** | a repeatable project case is reproduced from parameters: computed values, presets, substitutions into UDFs, mesh/TSV copies, `case.json` manifest |
| **Universal spec** | the journal is assembled from verified recipes according to a JSON case spec; `generate` writes it to disk (`setup_case.jou` + `case.json`); unsupported steps are listed separately instead of being guessed |
| **Dry run** | a plan with nothing written to disk: directory, computations, preset, full journal, offline validation |
| **Journal validation against the knowledge base** | line classification: exactly in the command index, menu container, hidden, 2025 R1 syntax, unknown |
| **Controlled run** | Fluent in the background with a log, status and stop; journals/results are backed up before every run; `allowRun` + `confirm:true` |
| **Maintainer reports** | self-contained JSON + Markdown: environment, Fluent version, statement, interview, case, run, automatic error analysis, KB gaps |
| **Extension through data** | a new profile/recipe/rule/question/diagnostic is a new JSON file in `data/`; no code changes |
| **Update from chat** | `fluent_plugin_update`: version check via git tags, plan, script, or apply through the official `dsh plugin` |

## Requirements

| Component | Version / note |
|---|---|
| **Node.js** | ≥ 20 (`engines` in `package.json`) |
| **DeepSeek Harness** | `>=0.2.1-rc.5 <0.3.0` (verified on 0.2.1-rc.5 and 0.2.2-rc.1); the requirement is in `engines.dsh` |
| **pnpm** | DSH needs it to install plugins. If `pnpm` is not found: `corepack enable pnpm` |
| **ANSYS Fluent** | an installed Fluent + a reachable license server. Needed for `fluent_case_run`; planning and generation work without it |
| **Python 3** | optional: needed by profiles with `python:` computations (in the `example-channel` example `y_mid` is computed this way) |
| **unzip** | optional: needed by profiles that unpack zip assets (ready-made meshes, for example) |
| **Fluent TUI knowledge base** | **not required for command search**: the index of 1736 commands is built into the package. `kbRoot` is needed only for full deep_dive documents (`fluent_kb_get`) |

## Installation

The plugin is installed as a DSH bundle. Public repository: **https://github.com/AstDen/fluent-case-builder**.

### 1. From git (recommended)

Through the DSH agent (the `plugin_manager` tool):

```text
plugin_manager install_bundle  target: "github:AstDen/fluent-case-builder"
```

Or through the CLI (the same pnpm under the hood):

```bash
dsh plugin --profile web add github:AstDen/fluent-case-builder
```

For your own fork, replace `AstDen/fluent-case-builder` with `<OWNER>/<REPO>`.

### 2. From a local directory

```text
plugin_manager install_bundle  target: "/absolute/path/to/fluent-case-builder"
```

```bash
dsh plugin --profile web add /absolute/path/to/fluent-case-builder
```

### After installation

- If `pnpm` is missing: `corepack enable pnpm` and repeat the installation.
- The plugin is wired in by a bundle patch (`cordis.patch.yml`). If the tools are not visible
  after installation — **restart DSH**.
- **Installing/updating from git requires a DSH restart.** Symptom: on activation you get
  `failed to import: Cannot find package '@deepseek-ai/dsh-tools'` — this is not a defect of the
  package but stale module generation in an already running DSH: restart it. If the error repeats,
  use method 2: a local clone and installation by path — it does not depend on pnpm git resolution.
- Check: call `fluent_case_profiles` — it must return a list of profiles (the distribution includes
  `example-channel`). If the answer is empty, see [docs/INSTALL.md](docs/INSTALL.md), section
  "Common problems".

### Updating

The current version is in `CHANGELOG.md` and in `plugin_manager` → `list_bundles`. An update
**always** consists of three steps: replace the package → restart DSH → check the version.

**Through the plugin tool.** In a session:

```text
fluent_plugin_update({ action: "check" })                       # current and latest version
fluent_plugin_update({ action: "plan", version: "v0.6.0" })     # ready-made commands
fluent_plugin_update({ action: "apply", version: "v0.6.0", confirm: true })
```

`apply` is off by default: enable `allowSelfUpdate: true` in the config. It calls the official
`dsh plugin` and requires a DSH restart after installation. If you do not want to enable it, use
`plan`/`script` and run the commands manually.

**Through the agent (plugin_manager).** In a session:

```text
plugin_manager  action: "remove_bundle"  target: "fluent-case-builder"
plugin_manager  action: "install_bundle" target: "github:AstDen/fluent-case-builder#v0.6.0"
```

`install_bundle` refuses if the package is already installed (`already-installed`), so run
`remove_bundle` first. Specify a tag (`#v0.5.1`) for a reproducible version or `#main` / no ref
for the latest one. **Restart DSH** after installation: until the restart the symptom
`failed to import: Cannot find package '@deepseek-ai/dsh-tools'` is possible (stale module
generation).

**From the terminal.** `dsh plugin` is pnpm in the profile directory with a rebuild of the bundle
list:

```bash
# latest version from main
dsh plugin --profile web update fluent-case-builder
# or an exact version: remove and install the tag
dsh plugin --profile web remove fluent-case-builder
dsh plugin --profile web add github:AstDen/fluent-case-builder#v0.5.1
```

**If the plugin did not load** (for example, after a DSH update you saw the message
"incompatible with DSH …" and the tools are unavailable), `fluent_plugin_update` is unavailable
too — update directly: `plugin_manager` → `remove_bundle` + `install_bundle` with the tag of the
latest version, or `dsh plugin --profile web add github:AstDen/fluent-case-builder#v0.6.0`, then
restart DSH. Since version 0.5.1 the plugin declares compatibility through `engines.dsh`
(`>=0.2.1-rc.5 <0.3.0`), so DSH updates within the 0.2.x branch do not disable it.

**Rollback** — the same procedure with the tag of a previous version (`#v0.5.1` and so on).
The external config (`~/.config/fluent-case-builder/config.json`), generated cases and the
registry are not affected by an update. For an installation from a local clone, `git pull` is
enough (data is picked up immediately), but after code changes DSH still needs a restart.

**Check after updating:**

- `plugin_manager` → `list_bundles` shows the new version;
- `fluent_case_profiles` and `fluent_kb_search({query:"k-ω SST"})` respond;
- `fluent_task_report(...)` → `generator.pluginVersion` matches the expected one;
- for a local clone: `node scripts/smoke.mjs`.

A detailed step-by-step guide (Fluent and license checks, smoke tests, troubleshooting) is in
[docs/INSTALL.md](docs/INSTALL.md).

## Configuration

Command and recipe search works out of the box — nothing needs to be configured. The config is
only needed if you want to read full deep_dive documents (`kbRoot`), change the case directory
(`caseRoots`), allow Fluent runs (`allowRun`) or connect private profiles (`profileDirs`).
Settings priority (lowest → highest):

```text
DEFAULTS (lib/config.js)
  → the plugin config line in cordis.patch.yml
    → external config.json
      → environment variables
```

### External config.json

Default path:

```text
$XDG_CONFIG_HOME/fluent-case-builder/config.json
or
~/.config/fluent-case-builder/config.json
```

To override the path entirely, use the `FLUENT_CONFIG` variable (an absolute path to a JSON file).

A ready-made example with every key is in [examples/config.example.json](examples/config.example.json):
copy it, replace the paths and keep only the keys you need.

### Auto-detection

- **Fluent**: `fluentPath` is empty by default — the plugin looks for `fluent` in `PATH`, then in
  `/ansys_inc/*/fluent/bin/fluent`, `/opt/ansys_inc`, `~/ansys_inc`, `/usr/ansys_inc`
  (the highest version wins). Explicitly: `FLUENT_PATH` or the `fluentPath` key.
- **License**: `licenseHost` defaults to the value from `ANSYSLMD_LICENSE_FILE`, otherwise
  `1055@localhost`. To run Fluent, this variable is injected into the process environment.
- **Cases**: `caseRoots` defaults to `[~/fluent-cases]`. Writing cases, backups and the report is
  allowed only inside these roots.
- **Command search works out of the box**: `indexDir` defaults to the built-in `data/index`
  (TUI command index + summary). `kbRoot` is empty by default: it is needed only to read full
  markdown documents through `fluent_kb_get`; without it the tool returns a hint.

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | `<package>/data` | profiles, recipes, rules. Usually there is no need to change it |
| `profileDirs` | `[]` | additional profile directories (absolute paths) |
| `kbRoot` | `''` | root of the Fluent TUI knowledge base for `fluent_kb_get`; `''` — built-in index and recipes only |
| `indexDir` | `<package>/data/index` | directory with `commands.csv`/`kb_summary.json`; the built-in index works immediately |
| `caseRoots` | `[~/fluent-cases]` | allowed roots for writing cases/backups/reports |
| `templateRoots` | `{}` | project templates/assets by profile id (read-only) |
| `profileRoots` | `{}` | output root for cases by profile id; required for profiles with an `outputRoot` from `{{solutionsRoot}}` (if the profile defines `outputRoot` that way) |
| `reportDir` | `''` | where to write reports and `task-notes.jsonl`; empty — `<caseDir>/analysis` or `<caseRoots[0]>/reports` |
| `registryPath` | `~/.cache/fluent-case-builder/cases.jsonl` | registry of generated cases |
| `allowRun` | `false` | whether Fluent runs are allowed (a run still requires `confirm: true`) |
| `fluentPath` | `''` (auto) | path to the Fluent launcher |
| `licenseHost` | `ANSYSLMD_LICENSE_FILE` or `1055@localhost` | license server address |
| `timeoutMs` | `600000` | timeout of a single TUI command, ms |
| `maxOutputChars` | `20000` | output limit in a tool response, characters |
| `maxLogLines` | `800` | how many of the last log lines to include in the report |
| `updateSource` | `github:AstDen/fluent-case-builder` | plugin update source |
| `allowSelfUpdate` | `false` | allow `fluent_plugin_update({action:"apply"})` to modify the profile |
| `dshCommand` | `dsh` | DSH executable for self-update |

### Environment variables

| Variable | Config key |
|---|---|
| `FLUENT_CONFIG` | path to the external config.json |
| `FLUENT_PATH` | `fluentPath` |
| `ANSYSLMD_LICENSE_FILE` | `licenseHost` |
| `FLUENT_KB_ROOT` | `kbRoot` |
| `FLUENT_KB_INDEX` | `indexDir` |
| `FLUENT_CASE_ROOTS` | `caseRoots` (separated by `:`) |
| `FLUENT_PROFILE_DIRS` | `profileDirs` (separated by `:`) |
| `FLUENT_REGISTRY_PATH` | `registryPath` |
| `FLUENT_REPORT_DIR` | `reportDir` |
| `FLUENT_ALLOW_RUN` | `allowRun` (`1/true/yes/on`) |
| `FLUENT_UPDATE_SOURCE` | `updateSource` |
| `FLUENT_ALLOW_SELF_UPDATE` | `allowSelfUpdate` |
| `FLUENT_DSH_COMMAND` | `dshCommand` |

### Overriding the plugin line by id

If the config should be part of the DSH profile (on a shared workstation, for example), override
the `fluent-case-builder` line in the user profile patch
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: fluent-case-builder
  name: 'fluent-case-builder'
  config:
    kbRoot: '/path/to/ansys-fluent-tui-kb'   # optional: full deep_dive documents
    indexDir: ''                             # '' = built-in command index
    caseRoots:
      - '/home/user/fluent-cases'
    allowRun: false
```

Important: the `config` of the line is replaced **entirely**, not merged with the bundle config —
list every key you need. A working example is in [examples/cordis.override.example.yml](examples/cordis.override.example.yml).

## Quick start

### (0) A question about a Fluent feature — the most common scenario

```text
fluent_kb_search({ query: "how to enable k-omega SST", scope: "all", limit: 5 })
```

The answer contains `commands` — entries of the built-in TUI command index (path, question, default,
blocked, help) — and `recipes` — verified journal lines with status (`verified`/`derived`/`unverified`),
parameters and source. No setup is required — the index of 1736 commands already ships with the
package. More on this in
["How to ask a question about a Fluent feature"](#how-to-ask-a-question-about-a-fluent-feature).

### (i) The `example-channel` example profile

`example-channel` is a **synthetic** example profile: mesh → laminar solver → initialization →
residual criteria → save. It has no boundary conditions and no third-party data; it exists to show
the profile format and to verify the installation.

```text
fluent_case_profiles({ profile: "example-channel" })
fluent_case_plan({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
fluent_case_generate({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
fluent_case_validate({ caseDir: "~/fluent-cases/channel_L-1000mm_h-10mm" })
fluent_case_run({ action: "start", caseDir: "...", confirm: true })
```

What you need:

- **your own mesh** in `meshFile` (a required parameter, defaults to the placeholder `/path/to/channel.msh`);
- an output directory: `caseRoots[0]` (`~/fluent-cases` by default) or the `outputRoot` parameter;
- add your own BCs/reports through the universal spec (scenario ii) or in your profile template.

Put your own project profile in `data/profiles/<id>` **or** in a separate directory listed in
`config.profileDirs` — that way private cases never reach the public repository.

### (ii) A new task: interview → spec → plan

```text
fluent_case_interview({ answers: { "task.kind": "gas-dynamics", "mach": 2.5, "reynolds": 30000 } })
```

The answer contains `next[]` (questions the agent asks the user), `recommendations`, `matchedRules`,
`completeness` and `draftSpec`. Then:

```text
fluent_case_plan({ spec: { ...draftSpec } })
```

The plan shows which recipes made it into the journal (`sections`), what was derived from help
(`derived`) and which steps are unsupported with the current KB (`unsupported`). The full spec
format is in [docs/CASE_SPEC.md](docs/CASE_SPEC.md).

### (iii) A report for the maintainer

Record notes as you work — they end up in the report:

```text
fluent_task_log({ message: "inlet BC was not generated, used mass flow manually", kind: "blocked", caseDir: "..." })
```

When the task is finished (successfully or not):

```text
fluent_task_report({
  caseDir: "...",
  title: "Supersonic nozzle, Mach 2.5",
  kind: "gas-dynamics",
  description: "what was computed and why",
  expectations: "what result was needed",
  questions: ["why is the inlet BC not supported?"]
})
```

The tool writes `<timestamp>-<slug>-report.json` and `...-report.md` (to `outputDir`, otherwise to
`reportDir`, otherwise to `<caseDir>/analysis`, otherwise to `<caseRoots[0]>/reports`) and returns
the path, the size and a short summary. The JSON is self-contained: it is enough to send it to the
maintainer as a single file. Format — [docs/REPORT_FORMAT.md](docs/REPORT_FORMAT.md).

## Tools

The plugin has 13 tools; every response is JSON.

| # | Tool | What it does | Writes to disk |
|---|---|---|---|
| 1 | `fluent_case_profiles` | list of profiles or details of one (`profile`) | no |
| 2 | `fluent_case_interview` | questions, model recommendations, completeness, spec draft (`answers`, `spec`, `limit`) | no |
| 3 | `fluent_case_plan` | dry run: profile+`params` or `spec` → directory, computations, preset, journal, validation (`outputRoot`, `includeJournal`) | no |
| 4 | `fluent_case_generate` | create case files from a profile (`params`, `force`, `outputRoot`) or from a universal spec (`spec` + `outputDir`) | yes, into `caseRoots` |
| 5 | `fluent_case_validate` | offline journal validation: `profile`+`params`, `caseDir` or `journal[]` | no |
| 6 | `fluent_case_status` | manifest, expected `.cas.h5/.dat.h5`, last run, log tail (`run`, `lines`) | no |
| 7 | `fluent_case_list` | registry of generated cases (`limit`, `profile`) | no |
| 8 | `fluent_case_run` | `action: start/status/stop`, log and run results; `start` requires `confirm:true` and `allowRun` | log, backups |
| 9 | `fluent_kb_search` | **the main tool for questions**: TUI commands + verified recipes (`query`, `scope: all/commands/recipes`, `limit`, `category`) | no |
| 10 | `fluent_kb_get` | read a KB document by relative path (`path`, `offset`, `limit`) | no |
| 11 | `fluent_task_report` | self-contained JSON + Markdown report for the maintainer; picks up `task-notes.jsonl` | yes, JSON+MD |
| 12 | `fluent_task_log` | an implementer's note in `task-notes.jsonl` (`message`, `kind`, `author`) | yes, JSONL |
| 13 | `fluent_plugin_update` | `check`/`plan`/`script`/`apply` — plugin check and update (`apply` requires `confirm` and `allowSelfUpdate`) | yes, script/profile |

## How to ask a question about a Fluent feature

It is enough to open a session and ask — the built-in skill tells the agent to use the KB tools,
but it is more reliable to be explicit:

> "How do I enable k-ω SST? Find it with `fluent_kb_search`, show the journal line, the status and
> the source."

What happens inside:

1. `fluent_kb_search({ query: "k-ω SST", scope: "all" })` → two sections:
   - `commands` — TUI commands from the built-in index (path, question, default, blocked, help);
   - `recipes` — verified recipes: ready journal lines, status, parameters, source.
2. If a full document is needed — `fluent_kb_get({ path: "KB/04_MODELS/viscous.md" })` (`kbRoot` is required).
3. The answer follows the format: journal line → interactive sequence → dependencies → validation →
   status ✅/🟡/🔴 → source.

### How to make sure the answer comes from the plugin knowledge base

- In the Web UI you can see **tool call cards**: if `fluent_kb_search`/`fluent_kb_get` were there,
  the answer relies on plugin data.
- Ask for **raw results**: "show the output of `fluent_kb_search` without retelling it" — it must
  contain `path`, `question`, `blocked`, `journal`, `status`, `source`.
- A proper answer has **status and source** (`KB/04_MODELS/viscous.md:160-181`, recipe `models.viscous.kw-sst`).
  No status/source — the answer probably comes from the model's memory, not from the KB.
- `fluent_case_validate` → `verdict: "skipped"` or `fluent_kb_search` → `configured: false` mean
  that the corresponding source is not configured/unavailable.
- `fluent_task_report(...)` records `environment.config` (which KB paths were used) and the journal
  coverage with recipes.

## Extending: no code changes

All domain knowledge is JSON in `data/`. The distribution ships **72 recipes** (37 `verified`,
16 `derived`, 19 `unverified`), **23 engineering rules**, **65 interview questions**, **14 error
diagnostics**, a **built-in index of 1736 commands** and the `example-channel` example profile.

| What to add | Where | Format |
|---|---|---|
| A new project case | `data/profiles/<id>/profile.json` + `templates/` | [docs/FORMATS.md](docs/FORMATS.md) §1 |
| A new verified journal block | `data/recipes/<id>.json` | [docs/FORMATS.md](docs/FORMATS.md) §2 |
| A new engineering rule | `data/rules/physics-rules.json` | [docs/FORMATS.md](docs/FORMATS.md) §3 |
| A new interview question | `data/rules/questions.json` | [docs/FORMATS.md](docs/FORMATS.md) §4 |
| A new error diagnostic for a log | `data/rules/diagnostics.json` | `{version, patterns:[{id, match, kind, severity, meaning, recommendation, source}]}` |

Additional profiles can live outside the package — in `profileDirs` (see the config).

Repository rule: **verify in a live session Fluent first, then add to the data.** That is exactly why
inlet/outlet BCs, transient, `/mesh/scale` and under-relaxation end up in `unsupported`: there are no
verified journal lines for them.

## The learning loop

The plugin evolves from the real tasks of colleagues, not from the developer's imagination.

```text
a colleague solves their task
  → fluent_task_log + fluent_task_report
    → JSON report to the maintainer
      → learning/inbox/                  (raw reports, .gitignore)
        → node scripts/ingest-report.mjs learning/inbox --out learning
          → learning/aggregate.json + learning/backlog.md
            → verification in a live Fluent session
              → data/recipes | rules | diagnostics | profiles
                → CHANGELOG + version + git tag
                  → colleagues update the plugin and get the new knowledge
```

The maintainer sees in the backlog the top unsupported steps, unverified recipes, unanswered
required questions, frequent error codes and ANSYS version mismatches. Then: verify in a live
session, add the data, raise the recipe status and ship a version.

Only aggregates (`learning/aggregate.json`, `learning/backlog.md`) are committed to the repository;
raw reports and notes stay local. Details — [docs/MAINTAINING.md](docs/MAINTAINING.md)
and [docs/REPORT_FORMAT.md](docs/REPORT_FORMAT.md).

## Security

- **`caseRoots`** is an allow-list of roots. Case generation, backups, the run directory and the
  report `outputDir` are validated: writing outside the allowed paths is an error, not a "silent"
  write.
- **`allowRun: false` by default.** Only the config enables Fluent runs, and `start` itself always
  requires an explicit `confirm: true` — the agent must ask the user.
- **No shell.** Fluent is launched with `spawn` and an argument array; no command concatenation.
- **Backups.** Before a run, journals, scripts and existing results are copied to
  `archive/pre-<name>-<ts>/`; `fluent_case_generate({force:true})` moves the old case version to
  `archive/<naming>.<ts>/`.
- **Idempotency.** An existing case is not overwritten without `force`.
- **No secrets in reports.** The log is truncated (`maxLogLines`, total limit ~400 KB), the license
  key is never written — only the server address. `learning/inbox/` is in `.gitignore`.

## Limitations (honestly)

- **The knowledge base does not cover everything.** 61% of KB commands have never been called in a
  live session. That is why the universal compiler assembles a journal only from `verified` and
  `derived` recipes (the latter with a warning), and `unverified` steps land in `unsupported` and are
  **not generated**. This is not a bug but a deliberate guard against a plausible yet wrong journal.
- **The universal spec is materialized only from verified recipes.** `fluent_case_generate`
  with `spec` + `outputDir` writes `setup_case.jou` and `case.json`, but only from `verified`/`derived`
  lines; unverified steps (inlet/outlet BCs, transient, `/mesh/scale` and the like) stay in
  `unsupported` and never reach the journal — they must first be verified in a live session and
  added as a recipe.
- **`example-channel` is a synthetic example, not a ready case.** It has no boundary conditions and
  no reports: it demonstrates the profile format and verifies the installation. For a real task use
  the universal spec or your own profile.
- **Different ANSYS versions.** The built-in index was captured from Fluent **2026 R1 (build 10262)**;
  on other versions the menu layout may differ. The validator marks lines from 2025 R1 journals with
  the `journal-2025` class, and colleague reports help track discrepancies.
- **Live verification remains the engineer's job.** The plugin validates syntax against the KB index
  and analyzes the run log, but it does not guarantee the physical correctness of the setup (models,
  BCs, criteria) — that is the engineer's responsibility.

## What has been verified

- **"How to enable X" search**: `fluent_kb_search` finds a command in the built-in index and a recipe
  with status/source (verified on `k-ω SST`).
- **Built-in skill**: a separate new session asked "How do I enable k-ω SST?" loaded
  `fluent-tui-knowledge` on its own, called `fluent_kb_search` + `fluent_kb_get` and answered with a
  journal line, a ✅ status and a source.
- The `example-channel` profile: `fluent_case_plan` and `fluent_case_generate` create the directory
  and the journal; the journal passes offline validation against the built-in index.
- The universal spec: a demo journal assembly from recipes passes; `unsupported` contains only the
  expected unverified steps (inlet/outlet BCs, `/mesh/scale`).
- A live run on a test case (Fluent 2026 R1): the setup completes, `.cas.h5`/`.dat.h5` are written,
  `fluent_case_status` reports `configured`.
- Reports and aggregation: `fluent_task_report` → `scripts/ingest-report.mjs` verified on real
  JSON reports (deduplication, empty inbox, invalid files).
- `node scripts/smoke.mjs` — 18 engine checks without DSH (index, recipes, reports, profile, etc.).

## Repository layout

```text
index.js                 registration of 13 tools
lib/                     engine: config, profile, engine, rules, compile, analyze, report, run, kb, update, util
data/index/              built-in TUI command index (commands.csv) + summary
data/profiles/<id>/      case profiles: profile.json + journal templates
data/recipes/*.json      verified journal blocks (the compilation unit of a spec)
data/rules/              physics-rules.json, questions.json, diagnostics.json
docs/                    contracts and instructions (see below)
examples/                config.json and cordis.override.yml examples
scripts/smoke.mjs        smoke test without DSH
scripts/ingest-report.mjs aggregation of reports into the maintainer backlog
learning/                learning-loop aggregates; inbox/ — local reports
LICENSE                  MIT
CHANGELOG.md             version history
```

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md) — installation, configuration, smoke check, common problems.
- [docs/USAGE.md](docs/USAGE.md) — workflows, what appears on disk, security.
- [docs/CASE_SPEC.md](docs/CASE_SPEC.md) — the universal case spec.
- [docs/FORMATS.md](docs/FORMATS.md) — data contracts: profile, recipe, rule, question.
- [docs/REPORT_FORMAT.md](docs/REPORT_FORMAT.md) — the `report@1` format and the learning loop.
- [docs/MAINTAINING.md](docs/MAINTAINING.md) — how a maintainer adds knowledge and ships versions.
- [CHANGELOG.md](CHANGELOG.md) — version history.

## License

MIT — full text in [LICENSE](LICENSE). Copyright (c) 2026 fluent-case-builder contributors.

ANSYS and Fluent are trademarks of ANSYS, Inc. The plugin is not affiliated with ANSYS and does not
distribute Fluent; the Fluent license and the license server are the user's responsibility.
