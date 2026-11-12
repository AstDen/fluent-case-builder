# Task report format (`report@1`) — the "learning loop"

A report is **a single self-contained JSON file** that a colleague generates with the
`fluent_task_report` tool and sends to the maintainer. The maintainer puts the reports into
`learning/inbox/` and runs `node scripts/ingest-report.mjs`, getting an aggregated backlog: which
questions, recipes, diagnostics, profiles and ANSYS versions should be added to the plugin.

A human-readable `.md` with the same content is written next to the JSON.

```json
{
  "schema": "fluent-case-builder/report@1",
  "id": "2026-11-11T09:40:00.000Z-1a2b3c4d",
  "generatedAt": "2026-11-11T09:40:00.000Z",
  "generator": {
    "plugin": "fluent-case-builder",
    "pluginVersion": "0.6.0",
    "dshProfile": "web"
  },
  "environment": {
    "os": "Linux 6.8.0 x86_64",
    "hostname": "ast-daniil",
    "node": "v22.23.4",
    "python3": "Python 3.10.13",
    "fluent": { "path": "/home/user/ansys_inc/v261/fluent/bin/fluent", "version": "2026 R1", "build": "10262", "source": "run-log|path|config|unknown" },
    "license": { "server": "1055@localhost", "features": ["..."], "source": "log|config" },
    "hardware": { "cpus": 32 }
  },
  "task": {
    "title": "Supersonic nozzle, Mach 2.5",
    "kind": "gas-dynamics",
    "description": "what we compute and why",
    "expectations": "what result is needed",
    "notes": ["notes along the way"],
    "questionsForMaintainer": ["why was the inlet BC not generated?"],
    "appVersion": "2026 R1",
    "ansysVersions": ["2026 R1"]
  },
  "interview": {
    "answers": { "task.kind": "gas-dynamics", "mach": 2.5 },
    "completeness": { "total": 65, "answered": 12, "required": 20, "requiredAnswered": 8, "missingRequired": ["mesh.file"] },
    "recommendations": { "solver.type": "density-based-implicit" },
    "matchedRules": [{ "id": "solver.mach-density-based", "status": "derived", "why": "...", "source": "..." }]
  },
  "case": {
    "mode": "profile | spec | existing | none",
    "profile": { "id": "example-channel", "params": {}, "preset": "quick" },
    "spec": {},
    "caseDir": "/path/to/case",
    "files": ["setup_case.jou", "start.sh"],
    "warnings": [],
    "outputs": [{ "path": "...cas.h5", "exists": true, "bytes": 4908645 }]
  },
  "generation": {
    "created": [{ "kind": "template", "path": "setup_case.jou" }],
    "validation": { "total": 98, "exact": 74, "container": 16, "hiddenKnown": 3, "journal2025": 4, "unknown": 0, "verdict": "ok-with-2025-syntax" }
  },
  "run": {
    "name": "setup",
    "status": "finished | failed | running | absent",
    "command": "fluent 3ddp -g -t2 -mpi=intel -affinity=core -i setup_case.jou",
    "durationSec": 79,
    "errors": [],
    "invalidCommands": [],
    "outputsPresent": true,
    "logFile": ".run/setup.log",
    "logTail": "…the last N lines…"
  },
  "analysis": {
    "verdict": "configured | failed | incomplete | analyzed",
    "stages": [
      { "stage": "mesh-read", "status": "ok", "evidence": "Reading \"mesh_region_fluid.msh\"" }
    ],
    "coverage": {
      "journalLines": 98,
      "byStatus": { "verified": 74, "derived": 16, "journal-2025": 4, "hidden": 3, "unknown": 0 },
      "recipesUsed": [{ "id": "models.energy", "status": "verified", "lines": 1 }],
      "unknownLines": [],
      "unverifiedSteps": []
    },
    "findings": [
      {
        "severity": "error | warning | info",
        "code": "<id from data/rules/diagnostics.json, e.g. invalid-command-batch-confirm | license | udf-compile | crash | kb-gap>",
        "message": "what happened",
        "journalLine": "the journal line, if known",
        "recipeId": "the recipe id, if applicable",
        "recommendation": "what to do",
        "source": "a KB file or protocol",
        "count": 1,
        "examples": ["the first log line, if useful"]
      }
    ],
    "gaps": [
      { "kind": "unsupported-step | unverified-recipe | missing-question | kb-gap | version-mismatch | documentation", "detail": "…", "frequency": 1 }
    ]
  },
  "artifacts": {
    "reportJson": "analysis/…-report.json",
    "reportMarkdown": "analysis/…-report.md",
    "notesFile": "analysis/task-notes.jsonl",
    "includedLogBytes": 51200,
    "truncated": false
  }
}
```

## Filling rules

- `interview` may be `null` (a report without an interview); `case.mode` is `profile`, `spec`, `existing` (a report about a ready case) or `none`.

- `id` is unique: `<generatedAt>-<hash>`; ingest deduplicates reports by it.
- `environment.fluent.version/build` comes from the Fluent run log (the `Build Id`, `Welcome to ANSYS Fluent` lines); otherwise the version is derived from the path (`source: "path"`, `v261` for example); otherwise `unknown`. This is needed to support several ANSYS versions.
- `analysis.findings` is the main value: every problem with a code and a recommendation. The set of codes lives in `data/rules/diagnostics.json` (14 codes in 0.6.0); every finding carries `severity`, `code`, `message`, `recommendation`, `source` and optionally `examples[]`.
- `analysis.gaps` describes what the plugin was missing: a step is unsupported (`unsupported-step`), a recipe is unverified (`unverified-recipe`), the interview had no question (`missing-question`), a KB gap (`kb-gap`), a version mismatch (`version-mismatch`).
- `case.spec` (for the universal path) is stored in full — it shows the maintainer which spec fields need support.
- Logs are truncated (`maxLogLines`, total limit ~400 KB (TOTAL_LOG_LIMIT in lib/report.js)); `truncated: true` if truncation happened.
- The license is written only to `environment.license` (`server`, `features[]`, `source`); it is not in `environment.fluent`.
- No secrets or tokens: paths and host names are fine, license keys are not.

## What the maintainer does

1. `node scripts/ingest-report.mjs learning/inbox --out learning` — updates `learning/aggregate.json` and `learning/backlog.md`.
2. Reads the backlog: top `unsupported-step` → what to verify in a live session; top `missing-question` → what to add to `data/rules/questions.json`; top errors → what to add to `data/rules/diagnostics.json`; new ANSYS versions → what to re-check.
3. Verifies the facts in a live Fluent session, adds recipes/rules/questions/profiles, raises statuses (`unverified → verified`), updates `CHANGELOG.md` and the version.
4. Commit + tag — colleagues update the plugin and receive the new knowledge.
