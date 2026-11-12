# CHANGELOG

All notable changes to the plugin. Format — [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions — [semver](https://semver.org/).

## [0.6.0] — 2026-11-12

### Changed
- Repository content, documentation, tool descriptions and bundled knowledge are now in English.

### Added
- Mixture density-method recipes: `materials.mixture-density-method` (non-reacting) and
  `materials.mixture-density-method.reacting` (reacting mixtures require two extra `no` answers
  for the Reaction and Mechanism prompts).
- Diagnostics `dialog-misalignment` and `invalid-integer-dialog`: journal/prompt desynchronization
  (for example, the `eval: unbound variable` failure when a reacting-mixture chain is used).

### Verified
- Reacting-mixture fix reproduced and verified live on Fluent 2026 R1; non-reacting chain
  re-verified live on Fluent 2025 R1.

## [0.5.1] — 2026-11-11

### Fixed
- Compatibility with DSH 0.2.2-rc.1: the `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-skill`
  peer dependencies are now declared as the range `>=0.2.1-rc.5 <0.3.0` instead of the exact
  `0.2.1-rc.5`, and the runtime requirement moved to `engines.dsh`.
- `@deepseek-ai/cordis` — `^4.0.5` (compatible with 4.1.0 in the new DSH).
- README/INSTALL: the supported DSH version range is documented.

## [0.5.0] — 2026-11-11

### Added
- The `fluent_plugin_update` tool: `check` (current/latest version via git tags), `plan`
  (ready-made commands for `plugin_manager` and `dsh plugin`), `script` (an executable update
  script), `apply` (update through the official CLI, requires `confirm:true` and
  `allowSelfUpdate:true`).
- Config: `updateSource` (update source), `allowSelfUpdate`, `dshCommand`; env
  `FLUENT_UPDATE_SOURCE`, `FLUENT_ALLOW_SELF_UPDATE`, `FLUENT_DSH_COMMAND`.
- The built-in skill now covers the update route.

## [0.4.0] — 2026-11-11

### Added
- **Built-in TUI command index** (`data/index/commands.csv`, 1736 commands): `fluent_kb_search`
  works right after installation, without KB setup. `kbRoot` remains optional — for full
  deep_dive documents.
- **Search over verified recipes:** `fluent_kb_search` with `scope: "recipes"` (or `"all"`) returns
  ready journal lines for "how to enable/do X" with the verified/derived/unverified status,
  parameters and source.
- **Built-in `fluent-tui-knowledge` skill**: the agent automatically picks KB tools for Fluent
  questions, does not invent syntax and states the status/source in its answer.

### Changed
- `fluent_kb_search` accepts `scope: all | commands | recipes`; the result is split into
  `commands` and `recipes`.
- The `@deepseek-ai/dsh-skill` peer dependency requirement.

## [0.3.0] — 2026-11-11

### Changed
- A project profile with private data was removed from the public repository: it stays local and
  is connected through `config.profileDirs`.
- Added the synthetic example profile `example-channel` (mesh → laminar solver → initialization →
  criteria → save) — for learning the format and verifying the installation.
- Documentation and data cleaned of references to the private project; case-specific positional
  lines in recipes are marked `unverified` and are not part of the public package.

## [0.2.1] — 2026-11-11

### Fixed / clarified
- Installation documentation: installing/updating from git requires a DSH restart; the
  `failed to import: Cannot find package '@deepseek-ai/dsh-tools'` symptom and the workaround
  (a local clone) are described.
- The `example-channel` example profile: a note on the engine status (unzip-flat and optional
  assets are implemented).
- The report contract is synchronized with the implementation: finding codes come from
  `data/rules/diagnostics.json`, `case.mode: existing`, `environment.fluent.source: path`, the
  license only in `environment.license`.

## [0.2.0] — 2026-11-11

### Added
- `fluent_task_report` — a self-contained task report (JSON + Markdown) for the maintainer:
  environment and Fluent version, statement, interview answers, case/spec, journal validation,
  run log, automatic error analysis and a list of gaps (`docs/REPORT_FORMAT.md`).
- `fluent_task_log` — a log of implementer notes (`task-notes.jsonl`) that automatically lands in
  the report.
- Error diagnostics by log: `data/rules/diagnostics.json` (12 codes: license, UDF, zones, Scheme,
  batch confirmation, crash, OOM and others), analysis of execution stages and of journal coverage
  by recipes.
- The learning loop: `scripts/ingest-report.mjs` aggregates the reports you send into
  `learning/aggregate.json` + `learning/backlog.md` (`docs/MAINTAINING.md`).
- Portable configuration: an external `~/.config/fluent-case-builder/config.json` (env
  `FLUENT_CONFIG`), environment variables, Fluent auto-detection; the KB became optional.
- `profileDirs` — additional case profile directories.
- Public documentation: `README.md`, `docs/INSTALL.md`, `examples/`, the MIT license.

### Changed
- `fluent_case_generate` now materializes the universal spec as well: `setup_case.jou` from verified
  recipes + `case.json` (`outputDir` is required); the profile path is preserved.
- Machine-specific paths removed from the packaging `cordis.patch.yml` (the published package is
  portable); sources in the data are now relative (`KB/…`, `<projects>/…`).
- `caseRoots` defaults to `~/fluent-cases`; `allowRun` defaults to `false`.
- Import of notes from `task-notes.jsonl` into the report; the report is written to
  `<caseDir>/analysis` by default.

### Fixed
- Journal validator: order of exact matches, whitespace form of commands, menu containers,
  `hidden-known` / `journal-2025` categories; with no configured index — `verdict: skipped`.
- Run status: a successful setup with a trailing batch-confirmation error is no longer "failed".
- A profile with `outputRoot` but no `profileRoots` now produces a clear error with a hint instead
  of a path outside `caseRoots`.
- Report: the Fluent version is determined from the full log (not the truncated tail), journal
  coverage is computed for a ready case as well, and notes are picked up from `task-notes.jsonl`.

## [0.1.0] — 2026-11-11

### Added
- First version: 10 tools (`fluent_case_*`, `fluent_kb_*`), the `example-channel` example profile,
  70 TUI command recipes, 23 engineering rules, 65 interview questions.
- The universal case spec (`docs/CASE_SPEC.md`) and the journal compiler built from recipes.
- Verified: byte-for-byte profile rendering against the reference; a live Fluent 2026 R1 run →
  `.cas.h5/.dat.h5`.
