# `learning/` — the `fluent-case-builder` learning loop

Colleague reports are collected here and aggregated into a backlog for the plugin maintainer.
The detailed process is in [`docs/MAINTAINING.md`](../docs/MAINTAINING.md), the report contract in
[`docs/REPORT_FORMAT.md`](../docs/REPORT_FORMAT.md).

## Structure

```
learning/
├── README.md          # this file: what goes where and what is committed
├── inbox/             # RAW colleague reports (.json) — NOT committed
│   └── .gitkeep
├── aggregate.json     # aggregate by report id — committed (generated)
└── backlog.md         # human-readable backlog — committed (generated)
```

## What a colleague does

1. Generate a report with the `fluent_task_report` tool (JSON + Markdown).
2. Send the JSON file to the maintainer (Markdown is for reading; ingest does not read it).
3. Do not put secrets, tokens or license keys into the report.

## What the maintainer does

```bash
# 1. Put the received .json files into learning/inbox/ (subdirectories are fine)
# 2. Update the aggregate and the backlog:
node scripts/ingest-report.mjs

# the same explicitly, with a separate output directory:
node scripts/ingest-report.mjs learning/inbox --out learning

# rebuild the aggregate from scratch (dedup within a run is preserved):
node scripts/ingest-report.mjs --no-merge

# preview only: arbitrary files/directories
node scripts/ingest-report.mjs path/to/reports
```

The script deduplicates reports by `id`, so ingesting the same inbox again does not double the
statistics. Invalid files (foreign `schema`, missing `id`, broken JSON) are skipped with a warning
and the exit code stays 0.

## Versioning policy

- **Committed:** `learning/README.md`, `learning/aggregate.json`, `learning/backlog.md`.
- **Not committed:** everything under `learning/inbox/` (except `.gitkeep`) — these are raw
  colleague reports with their machine paths and names. `.gitignore` must contain:

  ```gitignore
  learning/inbox/*
  !learning/inbox/.gitkeep
  ```

- The aggregate contains only summary cards: id, versions, verdicts, findings, gaps, host/OS
  counters. License servers and keys never reach the aggregate.

## What next

Follow `learning/backlog.md`: verify the hypotheses in a live Fluent session, update
`data/recipes/`, `data/rules/`, `data/profiles/`, update `CHANGELOG.md` and the version, and create
a git tag. The full checklist is in [`docs/MAINTAINING.md`](../docs/MAINTAINING.md).
