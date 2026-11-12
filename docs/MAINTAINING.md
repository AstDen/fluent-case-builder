# MAINTAINING — the `fluent-case-builder` learning loop

A document for the plugin maintainer: how to receive colleague reports, turn them into a backlog,
verify hypotheses in a live ANSYS Fluent session and ship new versions of the knowledge.

Related documents:

- [`REPORT_FORMAT.md`](REPORT_FORMAT.md) — the `report@1` report contract;
- [`FORMATS.md`](FORMATS.md) — formats of profiles, recipes, rules, questions;
- [`CASE_SPEC.md`](CASE_SPEC.md) — the universal case spec;
- [`USAGE.md`](USAGE.md) — plugin usage scenarios.

---

## 1. How the loop works

```
a colleague
  │  fluent_task_report(...)
  ▼
report.json  (schema: fluent-case-builder/report@1)  + report.md for reading
  │  sends it to the maintainer
  ▼
learning/inbox/            ← raw reports, NOT committed
  │  node scripts/ingest-report.mjs
  ▼
learning/aggregate.json    ← machine-readable aggregate (dedup by id), committed
learning/backlog.md        ← human-readable backlog, committed
  │  the maintainer processes the backlog
  ▼
live Fluent session        ← hypothesis checks, build/version capture, journal lines
  │
  ▼
data/recipes/  data/rules/  data/profiles/  docs/  KB
  │  CHANGELOG.md + semver + git tag
  ▼
colleagues update the plugin and get the new knowledge
```

The principle: **the code does not change from report to report**. A report adds to the data
(`data/`) and, when necessary, to the diagnostics. If new behavior needs code, that is a separate PR
with tests.

---

## 2. Receiving reports

1. A colleague sends the **JSON file** of the report (`schema: "fluent-case-builder/report@1"`, a
   unique `id` of the form `<generatedAt>-<hash>`). A `.md` sits next to it — that one is only for
   reading.
2. Put the JSON into `learning/inbox/`. You can organize it into subdirectories
   (`learning/inbox/2026-11/`, `learning/inbox/colleague-name/`) — ingest walks them recursively.
3. You can rename the file however you like: the identity of a report is the `id` field, not the
   file name.
4. **Do not commit** the contents of `learning/inbox/`: it is raw data with the paths and machine
   names of colleagues. The package `.gitignore` must contain:

   ```gitignore
   learning/inbox/*
   !learning/inbox/.gitkeep
   ```

5. Run ingest (see below), review `learning/backlog.md`, and commit `learning/aggregate.json` and
   `learning/backlog.md`.

If a report contains secrets (tokens, passwords, license keys) — **do not put it in the inbox**;
ask the colleague to regenerate the report without secrets. Host names and paths are allowed by the
contract.

---

## 3. Ingest: commands and behavior

Script: `scripts/ingest-report.mjs`. Node.js >= 20, ESM, no external dependencies.
It **does not import the plugin's `lib/`** and works without DSH installed.

```bash
# basic scenario: learning/inbox/ → learning/aggregate.json + learning/backlog.md
node scripts/ingest-report.mjs

# explicit input and output (several paths: files and/or directories)
node scripts/ingest-report.mjs learning/inbox --out learning
node scripts/ingest-report.mjs report-1.json path/to/reports/ --out /tmp/agg

# rebuild the aggregate from scratch (dedup within a run is preserved)
node scripts/ingest-report.mjs --no-merge

# preview on a separate directory without touching learning/
node scripts/ingest-report.mjs /tmp/reports --out /tmp/agg
```

Behavior:

| Situation | What ingest does |
|---|---|
| JSON with `schema: "fluent-case-builder/report@1"` and a non-empty `id` | reads it as a report |
| a different `schema`, no `id`, broken JSON | `⚠ skipped <file>: <reason>` on stderr, skipped, **exit 0** |
| non-JSON files (`.md`, `.txt`, `.gitkeep`) | silently skipped |
| its own `aggregate.json` in the input | recognized by schema and skipped |
| a nonexistent input | warning, the other inputs are processed, exit 0 |
| a repeated run over the same inbox | dedup by `id`: `reportsTotal` does not grow |
| `--merge` (default) | extends the existing `aggregate.json`, old reports are not lost |
| `--no-merge` | ignores the old aggregate and rebuilds it from the inputs |

Output: `aggregate.json` (`schema: "fluent-case-builder/aggregate@1"`) and `backlog.md`.
The final summary (how many were read / new / duplicates / invalid, top numbers, file paths) is
printed to stdout. Exit codes: `0` — success (including an empty inbox), `1` — a read/write error,
`2` — invalid arguments.

### Structure of `aggregate.json`

```jsonc
{
  "schema": "fluent-case-builder/aggregate@1",
  "updatedAt": "2026-11-11T09:42:46.146Z",
  "generator": { "script": "scripts/ingest-report.mjs", "format": 1 },
  "ingest": {
    "lastRunAt": "...", "merged": true, "inputs": ["inbox"],
    "filesScanned": 8, "reportsFound": 5, "reportsAdded": 0, "reportsReplaced": 0,
    "reportsBeforeMerge": 4, "reportsTotal": 4, "duplicates": 5,
    "invalid": [{ "file": "broken.json", "reason": "invalid JSON: ..." }],
    "nonJsonSkipped": ["notes.txt"], "missingInputs": []
  },
  "reports": {
    "2026-11-01T10:00:00.000Z-aaaa1111": {
      "id": "...", "generatedAt": "...", "ingestedAt": "...", "sourceFile": "report-1.json",
      "plugin": "0.2.0",
      "environment": { "os": "...", "hostname": "...", "fluent": { "version": "2026 R1", "build": "10262", "source": "run-log" } },
      "task": { "kind": "gas-dynamics", "title": "...", "ansysVersions": ["2026 R1"] },
      "case": { "mode": "spec", "profileId": null },
      "verdict": "analyzed", "runStatus": "finished", "generationVerdict": "needs-review",
      "completeness": { "total": 65, "answered": 12, "required": 20, "requiredAnswered": 8 },
      "counts": { "findings": 2, "gaps": 2, "unsupportedSteps": 1, "...": 0 },
      "findings": [ { "code": "syntax-version", "severity": "warning", "message": "...", "recommendation": "...", "recipeId": null, "count": 1 } ],
      "gaps": [ { "kind": "unsupported-step", "detail": "pressure-outlet BC", "frequency": 1 } ],
      "unsupportedSteps": [ { "step": "pressure-outlet BC", "reason": "..." } ],
      "unverifiedSteps": [], "unverifiedRecipes": [ { "id": "boundary.velocity-inlet.chain", "status": "derived", "lines": 3 } ],
      "unknownLines": ["/solve/set/pseudo-time-method"],
      "missingRequired": ["mesh.file", "boundary.inlet"],
      "questionsForMaintainer": ["..."], "notes": ["..."],
      "runErrors": [], "caseWarnings": []
    }
  },
  "stats": {
    "reportsTotal": 4,
    "pluginVersions": { "0.2.0": 3 },
    "fluentVersions": { "2026 R1": { "count": 2, "reports": ["..."], "builds": { "10262": 2 } } },
    "ansysVersions": { "2026 R1": 1 },
    "taskKinds": { "gas-dynamics": 1 },
    "verdicts": { "analyzed": 1 },
    "findingsByCode": { "syntax-version": 1 },
    "findingsBySeverity": { "warning": 1 },
    "gapsByKind": { "unsupported-step": 2 },
    "unsupportedSteps": [ { "step": "pressure-outlet BC", "count": 2, "reports": ["id1", "id2"] } ],
    "unknownJournalLines": [ { "line": "...", "count": 1, "reports": ["id"] } ],
    "missingRequiredQuestions": [ { "id": "mesh.file", "count": 1, "reports": ["id"] } ],
    "openQuestions": [ { "text": "...", "kind": "maintainer", "count": 1, "reports": ["id"] } ],
    "notes": [ { "text": "...", "count": 1, "reports": ["id"] } ],
    "kbGaps": [ { "detail": "...", "kind": "kb-gap", "count": 2, "reports": ["id"] } ],
    "hostsCount": 2, "osCount": 3,
    "ansysVersionConflicts": [ { "conflict": "declared 2025 R2 / log says 2026 R1", "count": 1, "reports": ["id"] } ]
  }
}
```

Aggregate data rules:

- `count` in `findingsBy*`/`gapsByKind` is the **sum** of `count`/`frequency` from the reports; for
  list statistics (`unsupportedSteps` and so on) `count` is the number of reports where it occurred
  and `reports` holds 1–3 example ids.
- The aggregate is a derived artifact: manual edits are overwritten by the next ingest. If a wording
  must be fixed, fix the data/documentation, not the aggregate.
- There are no secrets in the aggregate: license servers/keys are not copied, hosts and OS appear
  only as the `hostsCount`/`osCount` counters in `stats`; full logs never reach the aggregate.

---

## 4. How to read `backlog.md`

Header: the update date and the number of reports in the aggregate. Sections:

| Section | What it means | Where the work goes |
|---|---|---|
| **Verify in a live session** | `unsupported-step`, unverified steps in `coverage.unverifiedSteps`, recipes with a status ≠ `verified`, journal lines missing from the command index | a live Fluent session → `data/recipes/*.json`, KB, `data/rules/diagnostics.json` |
| **Add interview questions** | frequently unanswered required questions (`interview.completeness.missingRequired`) and `missing-question` gaps | `data/rules/questions.json` |
| **Error diagnostics** | findings by `code` (frequency, message, recommendation); reports with `failed` and empty `findings` | `data/rules/diagnostics.json`, analysis in `lib/rules.js` |
| **ANSYS versions** | which Fluent versions occur, `build`, where the version came from, mismatches between `task.ansysVersions` and the log | re-checking recipes on new versions, the `verifiedOn` field |
| **Requests and notes from colleagues** | `task.questionsForMaintainer`, `task.notes` | reply to the colleague, and if needed add an interview question or a diagnostic |
| **Knowledge-base gaps** | `kb-gap`/`documentation` gaps, `kb-gap` findings | KB documentation, new sections, a more precise `source` |

Each item carries a frequency and 1–3 example report ids. The full data is in `aggregate.json`
(look up a report by `id` in `reports`). An empty inbox produces a backlog marked "no data yet" and
exit 0 — that is the normal state of a fresh package.

---

## 5. Verifying a hypothesis in a live Fluent session

Verify **only** with a real license and a real Fluent; the result is the only source of the
`verified` status.

1. Take an item from the backlog and formulate a testable hypothesis, for example:
   "the line `/solve/set/under-relaxation pressure 0.2` is accepted by Fluent 2026 R1 and changes
   the relaxation factor".
2. Prepare a minimal journal (read the mesh/case + the lines under test + save/exit), for example:

   ```
   /file/read-case "case.cas.h5"
   /solve/set/under-relaxation pressure 0.2
   /file/write-case-data "verify"
   /exit
   ```

   The package already contains the `example-channel` profile and working journals for reproducible
   runs — use them as the reference.
3. Run it in batch mode (`fluent 3ddp -g -t<N> -mpi=intel -affinity=core -i verify.jou`) and keep
   the transcript/log.
4. Record in the note: the Fluent version and build (the `Welcome to ANSYS Fluent`, `Build Id`
   lines), the date, the exact journal line, the interactive menu answers, the result
   (accepted/error/behavior changed) and the log path.
5. Only after that update the data. If you cannot verify, leave `status: "derived"`/`"unverified"`
   and state honestly what is missing.

Do not invent journal lines "from the help". The offline `fluent_case_validate` check against
`commands.csv` is auxiliary; it does not replace a live run.

---

## 6. Updating the data

All formats are described in [`FORMATS.md`](FORMATS.md). Below is what exactly to change following
the backlog and which rules to observe.

### 6.1. Recipes — `data/recipes/<id>.json`

An atomic verified journal block. Template:

```json
{
  "id": "solve.under-relaxation",
  "title": "Relaxation factors",
  "category": "solve",
  "status": "verified",
  "confidence": "high",
  "source": "07_SOLVER/deep_dive.md:141-168; live run 2026-11-11",
  "verifiedOn": [
    {
      "fluent": "2026 R1",
      "build": "10262",
      "date": "2026-11-11",
      "evidence": "the journal was accepted in a batch run, the value changed in the report",
      "source": "transcript: verify-under-relaxation.log:12-20"
    }
  ],
  "date": "2026-11-11",
  "journal": ["/solve/set/under-relaxation pressure 0.2"],
  "interactive": "Under-Relaxation Factor for Pressure [0.3] → 0.2",
  "requires": [],
  "conflicts": [],
  "params": [],
  "notes": "…"
}
```

Rules:

- `status` ∈ `verified | derived | unverified`:
  - `verified` — the line was verified in a live Fluent session, there is `verifiedOn` with the
    version/build/date and a link to the log; `journal` is filled in;
  - `derived` — the lines were assembled from help/other journals but were not verified in this
    session; a non-empty `journal` is allowed, and the compiler marks such steps as "requires
    verification";
  - `unverified` — only the intent/help is known; `journal: []`, and `notes` says what is missing.
- `source` is **mandatory** and points to the **file and lines** of the KB/reference:
  `04_MODELS/viscous.md:21-43`, `QA_LOG.md:104-117`, `temp_case_setting/...:28-30`.
  A reference "in the KB" without a file/lines is not a source.
- `verifiedOn` is **mandatory for `verified`**: an array of checks
  `{fluent, build, date, evidence, source}`. The same line can be verified on several versions —
  then there are several elements (the freshest first).
- If a command changed/disappeared in a new version: do not silently rewrite the old recipe.
  Create a new `id` (for example `solve.under-relaxation.v2026`) with an `appliesTo` field
  (`{"fluent": "2026 R1"}`) or mark the old one with `deprecatedIn`/`notes` — and state it
  explicitly in `CHANGELOG.md`.
- `conflicts`/`requires` — as appropriate; do not duplicate commands across recipes.
- The offline validator and the compiler must not break: check `node scripts/smoke.mjs` and
  `fluent_case_validate` on a demo journal.

### 6.2. Engineering rules — `data/rules/physics-rules.json`

```json
{
  "id": "turbulence.re",
  "title": "Turbulence at Re > 5000",
  "when": { "re": { ">=": 5000 } },
  "recommend": { "physics.turbulence.model": "kw-sst" },
  "why": "At Re>5000 the flow is turbulent; in the verified working journal k-ω SST is enabled.",
  "status": "derived",
  "confidence": "high",
  "source": "04_MODELS/viscous.md:21-43; CASE-CREATION-INSTRUCTIONS.md",
  "recipes": ["models.viscous.kw-sst"]
}
```

- `when` is an object of conditions over case spec paths; the value is a scalar or
  `{">=",">","<","<=","in":[...]}`.
- Every rule: a unique `id`, `why`, `status`, `confidence`, `source` (file:lines), and `recipes` —
  which recipes implement the recommendation.
- A new rule from a report: if it follows only from a colleague's practice it is `derived` until
  confirmed by a reference/live check; a rule that contradicts an existing one must not be added
  silently — discuss it and update both.

### 6.3. Interview questions — `data/rules/questions.json`

```json
{
  "id": "mesh.units",
  "text": "In which units is the mesh geometry defined?",
  "type": "enum",
  "values": ["m", "mm", "cm", "in"],
  "default": "mm",
  "why": "the units determine whether /mesh/scale is needed",
  "specPath": "mesh.units",
  "required": true
}
```

- The backlog section "Add interview questions" → add the question to a suitable section.
- `id` is stable (`section.name`), `specPath` is a real case spec path (see `CASE_SPEC.md`), and
  `required` only if the case cannot be assembled without the answer.
- Questions must not be duplicated: search by `specPath`/`id` (the backlog already shows ids from
  `interview.completeness.missingRequired` — questions with those ids must exist).
- After the edit, walk through the interview manually: `fluent_case_interview({answers:{...}})` must
  not fail and must return `next[]`/`completeness`.

### 6.4. Error diagnostics — `data/rules/diagnostics.json`

The registry of finding codes: `data/rules/diagnostics.json` (already exists, `version: 1`,
14 codes). Codes from `analysis.findings[].code` must be described here — the maintainer extends the
file from the reports received. Format:

```json
{
  "version": 1,
  "updated": "2026-11-11",
  "note": "Error diagnostics for the Fluent TUI based on the log. Maintained by the maintainer from report files.",
  "patterns": [
    {
      "id": "invalid-command-batch-confirm",
      "match": "invalid command:?\\s+yes",
      "kind": "batch-confirmation",
      "severity": "info",
      "meaning": "After /file/write-case-data \"...\" yes the file is already written, and the trailing yes token is rejected because overwrite confirmations are enabled in batch mode.",
      "recommendation": "Consider the setup successful if .cas.h5/.dat.h5 exist. Drop the trailing yes or set /file/confirm-overwrite? no.",
      "source": "live run 2026-11-11, build 10262"
    }
  ]
}
```

- `id` matches the `code` of a finding (the list of base codes is in `REPORT_FORMAT.md`; unknown
  situations get `other`);
- `match` is a regular expression (a string for `new RegExp(...)`, without the `/.../` delimiters)
  that log/`logTail` lines are matched against; escape special characters;
- `kind` is a category (`batch-confirmation`, `syntax`, `license`, `udf`, `mesh-zones`,
  `crash`, `resources`, `journal-abort`, `files`, `dialog`, `scheme`, …; the list in the file is the
  actual one, extend it deliberately);
- `severity` ∈ `error | warning | info`;
- `meaning` and `recommendation` are human-readable, with no "see above";
- `source` is where the knowledge comes from (a live run with version/build, a KB file:lines).
- When adding: test the regexp against real `logTail`s from reports (it must not match everything in
  a row), do not duplicate `id`s, and bump `version` when the semantics change.

### 6.5. Profiles — `data/profiles/<id>/profile.json`

- A new profile — according to the `FORMATS.md` §1 contract: `profile.json` + `templates/`,
  registration of `profileRoots`/`templateRoots` in the config, a profile README.
- `verification: {status, date, evidence}` is mandatory; a profile without a live check is not
  `verified`.
- Template rendering must match the reference **byte for byte** for the control parameter sets
  (quick/fine) — this check is part of the release checklist.
- Changing a profile's parameters/templates is a potentially breaking change for colleagues: bump
  the profile `version` and record it in `CHANGELOG.md`.
- `data/rules/profiles-index.json` must contain up-to-date `id/path/title/status`.

### 6.6. KB and documentation

- Close `kb-gap`/`documentation` gaps from the backlog in the KB (`kbRoot`) and/or in `docs/`;
  every new KB page must provide a `source` of the form `path:lines`.
- References to the KB in the data must include line numbers, otherwise the provenance is lost
  within a month.

---

## 7. Raising statuses

Allowed transitions:

```
unverified ──(live check; journal + verifiedOn)──▶ verified
     │                                                   ▲
     └──(lines assembled from help/journals)──▶ derived ─┘
```

- `derived → verified` — only after a live check; update `source`, `verifiedOn`, `date`,
  `confidence`.
- Lowering (`verified → derived/unverified`) — if the line turns out not to work or the check was
  wrong; state the reason in `notes` and `CHANGELOG.md` without fail.
- When a new ANSYS version appears, an old `verified` does not become `unverified` by itself.
  Run the check on the new version and add `verifiedOn`; if the behavior changed — a new
  recipe/rule (see 6.1) and a `CHANGELOG.md` entry.
- Do not raise a status based on a colleague's report without a check: a report is a hypothesis
  (unless it contains a live check with a log; and even then the maintainer still records the
  version/build and verifies reproducibility).

---

## 8. Release: `CHANGELOG.md`, semver, git tag

### 8.1. `CHANGELOG.md`

The `CHANGELOG.md` file at the package root (it already exists, the current version is `0.6.0`),
format — [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), sections in English:
`Added / Changed / Fixed / Removed / Verified`. For every release:

```markdown
## [0.3.0] — 2026-11-20

### Added
- data/recipes: `boundary.pressure-outlet.chain` (verified, Fluent 2026 R1 / build 10262)
- data/rules/diagnostics.json: code `license` (error)

### Changed
- data/rules/questions.json: `mesh.units` is now mandatory

### Verified
- `solve.under-relaxation` — confirmed on 2026 R1

### Fixed
- scripts/ingest-report.mjs: report dedup on a repeated ingest
```

### 8.2. Semver

- **patch** (`0.2.x`): fixes to scripts/documentation that do not change the data or the plugin
  behavior; ingest fixes that do not change the aggregate format.
- **minor** (`0.x.0`): new recipes/rules/questions/profiles, status raises, new data fields, new
  codes in `data/rules/diagnostics.json` — backward compatible.
- **major** (`x.0.0`): breaking changes — an incompatible `case spec`, changed profile parameters,
  removal of a tool/data field, a new report schema (`report@2`) or aggregate schema
  (`aggregate@2`). A new report schema requires ingest support and a migration.

The version in `package.json` (`version`) and the tag must match. Bump the version even if only the
data changes: colleagues rely on it to know whether they have "caught up" with the knowledge.

### 8.3. Release checklist

```bash
# 1. Fresh reports: put them into learning/inbox, aggregate
node scripts/ingest-report.mjs
# 2. Process learning/backlog.md, update the data (sections 6–7) and CHANGELOG.md
# 3. JSON validity of all data
node -e "const {readdirSync,readFileSync,statSync}=require('fs');const walk=(d)=>readdirSync(d).flatMap(n=>{const p=d+'/'+n;return statSync(p).isDirectory()?walk(p):[p]});for(const f of walk('data')){if(f.endsWith('.json'))JSON.parse(readFileSync(f,'utf8'))}console.log('data JSON ok')"
# 4. Engine smoke tests
node scripts/smoke.mjs
# 5. A repeated ingest must be idempotent (reportsTotal does not change)
node scripts/ingest-report.mjs
# 6. Update the version in package.json and CHANGELOG.md, review the diff
git diff
git add -A
git commit -m "feat(data): ..."      # Conventional Commits
git tag -a v0.3.0 -m "fluent-case-builder 0.3.0"
git push && git push --tags
```

Additionally, before tagging:

- profiles are re-rendered and match the reference byte for byte (the quick/fine control sets);
- `learning/aggregate.json` and `learning/backlog.md` are updated and committed;
- raw `learning/inbox/*` did not accidentally reach the index: `git status --short learning/inbox`;
- the data has no references to nonexistent `recipe id`s/`specPath`s;
- there are no secrets in the reports or the aggregate (`git diff learning/aggregate.json | grep -i -E 'token|password|secret|license'`).

After tagging — notify colleagues (see section 10): which version, what is new, what can now be
verified/re-verified.

---

## 9. Privacy and security

- **Not committed:** `learning/inbox/*` (raw reports), cases, `.cas.h5/.dat.h5`, Fluent logs,
  transcripts. The package `.gitignore` already contains `learning/inbox/*` and
  `!learning/inbox/.gitkeep`.
- **Committed:** `learning/aggregate.json`, `learning/backlog.md` — summary cards only.
- Reports may contain paths and host names (they are needed for provenance), but **must not**
  contain license keys/license servers, tokens, passwords, personal data or the contents of
  commercial cases. If they ended up in a report — do not commit; ask the colleague to regenerate
  the report without them.
- Ingest deliberately does not copy `environment.license`, `license.server`, `features` or full logs
  into the aggregate; hosts/OS appear only as counters.
- Before committing the aggregate: `git diff learning/aggregate.json` — check by eye that no
  new unwanted fields appeared.
- Do not publish reports/aggregates in a public repository if they contain customer names or closed
  data; when in doubt — redact/anonymize.

---

## 10. How to reply to a colleague

The reply is free-form, but with an explicit status and an update path:

1. **Received:** thanks, the report is accepted, id `...`; the verdict/key finding.
2. **What is clear / what is being clarified:** briefly — which hypothesis is confirmed, what went
   to the backlog, which question needs a live-session check.
3. **What was done:** "added/raised recipe `X` (verified, Fluent 2026 R1), version `v0.3.0`".
4. **How to update:** `plugin_manager` install/update bundle with the new tag (or `git pull` +
   restarting the profile), then repeat `fluent_case_plan`/`fluent_case_validate`.
5. **What to check on your side:** a specific command/scenario; if the problem repeats — send a new
   report (the id will differ) with the log.

Statuses for the reply: "in the backlog", "in progress", "fixed in vX.Y.Z", "needs a check on your
Fluent version". Do not promise `verified` until the check is done.

Template:

```text
Thanks, the report is accepted (id 2026-11-11T09:41:48.422Z-0ef8d17a).
What I see: invalid command: yes — a harmless artifact of batch confirmation; …
What went to the backlog: pressure-outlet BC (unverified), license (diagnostic).
Done in v0.3.0: the `boundary.pressure-outlet.chain` recipe → verified on 2026 R1 (build 10262).
Update the plugin and check `fluent_case_plan` for your task.
If it repeats — send a new report with the run log.
```

---

## 11. Cadence and metrics

- Run ingest on every report batch and before a release (it is idempotent).
- Once a week/sprint: process the backlog, close the top 3 items; update the KB.
- Useful dynamics metrics: `stats.reportsTotal`, the top `unsupportedSteps`, the top
  `missingRequiredQuestions`, `reportsFailed`, the number of Fluent versions/builds in
  `fluentVersions`. Watch the tops shrink — that is the effect of the learning loop.

---

## 12. Common problems

| Symptom | Cause / solution |
|---|---|
| the backlog is empty, "no data yet" | there are no valid reports in `learning/inbox`; check `schema`/`id` and the ingest stderr |
| a report was read twice | the same `id` in two files — dedup by id, `ingest.duplicates` > 0 is normal |
| a report has a "foreign schema" | the colleague sent a report/aggregate of a different version; update the plugin on their side or support the new schema in ingest |
| the aggregate "went sideways" | do not edit `aggregate.json` by hand; rebuild it with `--no-merge` from the inbox |
| `reportsTotal` does not grow | all reports are already in the aggregate (dedup) — this is expected |
| the `verified` status does not appear | `verified` needs a live run + `verifiedOn` + `source`; a colleague's report is not enough |
| the colleague updated but has no new knowledge | check the version/tag, restart the DSH profile, call the tool again |
