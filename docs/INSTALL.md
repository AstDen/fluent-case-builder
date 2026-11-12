# Installing `fluent-case-builder`

A step-by-step guide for a colleague: from checking Fluent and the license to a smoke test of the
tools. The plugin is installed as a DSH bundle and works in a Harness profile (the `web` profile
below).

If something went wrong, go straight to the [Common problems](#common-problems) section.

---

## 0. What you need

| Component | Check | Note |
|---|---|---|
| Node.js ≥ 20 | `node --version` | the plugin's `engines` |
| pnpm | `pnpm --version` | DSH installs plugins through pnpm |
| DeepSeek Harness 0.2.1-rc.5 | `dsh --version` | peer dependency `@deepseek-ai/dsh-tools` |
| ANSYS Fluent + license | see step 1 | needed only to launch a computation |
| Python 3 (optional) | `python3 --version` | needed by profiles with `python:` computations (for example `example-channel`) |
| unzip (optional) | `unzip -v` | needed by profiles with zip assets (for example `example-channel`: mesh unpacking) |
| Fluent TUI knowledge base (optional) | see step 4 | without it the KB tools are disabled and journal validation is skipped |

Planning, file generation and reports work **without** Fluent and without the knowledge base — but
then, respectively, there will be no run and no offline journal validation.

---

## 1. Check Fluent and the license

### Fluent

```bash
which fluent
# or
echo "$FLUENT_PATH"
ls -d /opt/ansys_inc/*/fluent/bin/fluent ~/ansys_inc/*/fluent/bin/fluent 2>/dev/null
```

The plugin can find the launcher itself: `FLUENT_PATH` → `fluent` in `PATH` → `/ansys_inc`,
`/opt/ansys_inc`, `~/ansys_inc`, `/usr/ansys_inc` (the highest version wins). If Fluent is installed
in a non-standard location, set `fluentPath` in the config (step 4).

### License server

```bash
echo "$ANSYSLMD_LICENSE_FILE"      # expect something like 1055@license-server
ss -ltn | grep 1055                # is the server listening on port 1055?
```

- If `ANSYSLMD_LICENSE_FILE` is not set, the plugin uses `1055@localhost`.
- The "license is actually issued" check is done by launching Fluent manually, for example
  `fluent 3ddp -g` (no journal, exit after startup). If Fluent complains about the license, the
  plugin will not be able to launch a computation either.

The path and the license address can be fixed in the config (`fluentPath`, `licenseHost`) — see step 4.

---

## 2. Check Node.js, pnpm and DSH

```bash
node --version        # v20.x or newer
pnpm --version
dsh --version         # 0.2.1-rc.5
```

If `pnpm` is not found (`command not found` / `ENOENT`):

```bash
corepack enable pnpm
pnpm --version
```

If `corepack` is unavailable too, install Node.js 20+ from the official distribution (it includes
`corepack`) or install pnpm separately, then repeat step 3.

---

## 3. Install the plugin

### Option A — from git (for colleagues)

In the commands below `<OWNER>/<REPO>` is a placeholder. Replace it with the real repository, for
example `github:ivanov/fluent-case-builder`.

Through the DSH agent (the `plugin_manager` tool):

```text
plugin_manager install_bundle  target: "github:<OWNER>/<REPO>"
```

Or through the CLI (the same pnpm under the hood):

```bash
dsh plugin --profile web install github:<OWNER>/<REPO>
```

### Option B — from a local directory

If the repository is already cloned:

```text
plugin_manager install_bundle  target: "/absolute/path/to/fluent-case-builder"
```

```bash
dsh plugin --profile web install /absolute/path/to/fluent-case-builder
```

### After installation

1. Check that the package appeared in the profile — the typical path is
   `~/.dsh/profiles/web/node_modules/fluent-case-builder` (plus an entry in
   `~/.dsh/profiles/web/package.json`).
2. **Restart DSH.** The plugin and its config are read when the profile starts; without a restart
   the tools may be invisible or run with the old config.
3. Check: call `fluent_case_profiles` — it must return a list of profiles; the distribution includes
   `example-channel`:

   ```json
   { "profiles": [ { "id": "example-channel", "title": "Example: laminar channel (synthetic template)", "status": "verified" } ], "hint": "…" }
   ```

If the list is empty or the tool is missing — see [Common problems](#common-problems).

---

## 4. Configure the plugin

The plugin reads settings in increasing order of priority:

```text
DEFAULTS (lib/config.js)
  → the plugin config line in cordis.patch.yml
    → external config.json
      → environment variables
```

For a personal machine the external file is enough:

```bash
mkdir -p ~/.config/fluent-case-builder
cp /absolute/path/to/fluent-case-builder/examples/config.example.json \
   ~/.config/fluent-case-builder/config.json
# edit the paths
```

The default path is `$XDG_CONFIG_HOME/fluent-case-builder/config.json` or
`~/.config/fluent-case-builder/config.json`. To override the path entirely: `FLUENT_CONFIG`.

A minimally useful config (the other keys have defaults — see
[examples/config.example.json](../examples/config.example.json) and the README):

```json
{
  "caseRoots": ["/home/user/fluent-cases"],
  "kbRoot": "/path/to/ansys-fluent-tui-kb",
  "indexDir": "/path/to/ansys-fluent-tui-kb/90_RAW_TUI_OUTPUT/_data",
  "fluentPath": "/opt/ansys_inc/v261/fluent/bin/fluent",
  "licenseHost": "1055@license-server",
  "allowRun": false
}
```

What is important to know:

- `caseRoots` is an **allow-list** of write roots. Everything the plugin creates (cases, backups,
  reports) must live inside. The default is `~/fluent-cases`.
- `kbRoot` and `indexDir` may be omitted. Then `fluent_kb_search`/`fluent_kb_get` return
  `{ "configured": false, "hint": "…" }` and `fluent_case_validate` returns `verdict: "skipped"` with
  an explanation. This is normal behavior, not an error.
- `allowRun` is `false` by default. Enable it only if you are ready to launch Fluent; a launch itself
  always additionally requires `confirm: true`.
- `reportDir` — where to write reports and `task-notes.jsonl`. If not set, the report goes to
  `<caseDir>/analysis`, and without a case to `<caseRoots[0]>/reports`.
- The `example-channel` profile additionally needs `templateRoots["example-channel"]` (a directory
  with the UDF/TSV/mesh) and `profileRoots["example-channel"]` (the output root) — these are project
  assets that are not in the public repository. Without `profileRoots` the case path cannot be
  resolved (the profile builds `outputRoot` from `{{solutionsRoot}}`); instead you can pass
  `outputRoot` directly to `fluent_case_plan`/`fluent_case_generate`.
- If the config must be part of the DSH profile, override the plugin line by id in
  `~/.dsh/profiles/web/cordis.patch.yml` — example:
  [examples/cordis.override.example.yml](../examples/cordis.override.example.yml).

After changing the config, **restart DSH** (the config is read when the plugin is activated).

---

## 5. Smoke check

Call the tools one by one and compare with the expectation.

1. **Profiles**

   ```text
   fluent_case_profiles()
   ```

   Expected: a list including `example-channel`.

2. **Knowledge base**

   ```text
   fluent_kb_search({ query: "energy" })
   ```

   - KB configured → `results` with commands/documents and a verification flag.
   - KB not configured → `{ "configured": false, "hint": "The knowledge base is not configured. Set kbRoot …" }`.
     This is expected if step 4 was done without `kbRoot`.

3. **Interview and recommendations**

   ```text
   fluent_case_interview({ answers: { "task.kind": "gas-dynamics", "mach": 2.5 } })
   ```

   Expected: `next[]` (questions), `recommendations`, `completeness`, `draftSpec`.

4. **Dry run of the profile (writes nothing)**

   ```text
   fluent_case_plan({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
   ```

   Expected: `mode: "profile"`, a `caseDir` inside `caseRoots`, the computed `y_mid`,
   `preset` (`quick`/`fine`), the file list, `validation` (or `verdict: "skipped"` without `indexDir`).

5. **Report for the maintainer**

   ```text
   fluent_task_report({ title: "smoke-test", notes: ["installation check"] })
   ```

   Expected: `jsonPath`, `mdPath`, `bytes`, `summary`; the files
   `<timestamp>-smoke-test-report.json/.md` in an allowed directory (see `reportDir`). Make sure the
   file was created and the JSON is valid:

   ```bash
   node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('report: OK')" \
     /path/to/report.json
   ```

6. **Implementer note**

   ```text
   fluent_task_log({ message: "installation check", kind: "note" })
   ```

   Expected: `{ "file": ".../task-notes.jsonl", "entry": { ... } }`; a repeated
   `fluent_task_report` picks up the note.

7. **Engine without DSH (optional, if you have a local clone)**

   ```bash
   cd /absolute/path/to/fluent-case-builder
   node scripts/smoke.mjs
   ```

   Expected: the smoke test passes without errors (expressions, templates, KB, validator, rules,
   compiler, profile plan).

---

## 6. The first real case

1. Assemble the statement through the interview (`fluent_case_interview`) or take a profile.
2. Do a dry run (`fluent_case_plan`) and review the journal/`unsupported`.
3. Create the files (`fluent_case_generate`) — only inside `caseRoots`.
4. Validate the journal (`fluent_case_validate`).
5. Launch Fluent only after explicit consent: `allowRun: true` in the config (and a DSH restart) and
   `fluent_case_run({ action: "start", caseDir, confirm: true })`.
6. Follow the run: `fluent_case_run({ action: "status", caseDir })`.
7. At the end of the work (successful or not) run `fluent_task_report` and send the JSON to the
   maintainer — that is your contribution to the "learning loop" (see
   [REPORT_FORMAT.md](REPORT_FORMAT.md)).

---

## Common problems

| Symptom | Cause | What to do |
|---|---|---|
| `pnpm: command not found`, `spawn pnpm ENOENT` during installation | pnpm is missing | `corepack enable pnpm`, repeat the installation; without corepack — install Node 20+ from the official distribution |
| After a DSH update: "version … is incompatible with DSH …" | the plugin had hard peer versions of `@deepseek-ai/dsh-*`; the new DSH does not satisfy them | update the plugin to 0.5.1+ (`plugin_manager` remove_bundle → install_bundle with the tag `#v0.5.1`) and restart DSH; `fluent_plugin_update` is unavailable in that state |
| No `fluent_*` tools after installation | DSH was not restarted; the package did not reach the profile | restart DSH; check `~/.dsh/profiles/web/package.json` and `plugin_manager list_plugins`; reinstall if necessary |
| On activation: `failed to import: Cannot find package '@deepseek-ai/dsh-tools'` | installation from git while DSH is running: stale module generation is cached | restart DSH. If the error repeats, clone the repository locally and install by method 3 (a directory path) |
| `fluent_kb_search` → `configured.indices: false` | `indexDir` points to a nonexistent directory | remove `indexDir` from the config (the built-in index will be used) or fix the path |
| `fluent_kb_get` → `{"configured": false, "hint": …}` | `kbRoot` is not set | this is normal for command search; set `kbRoot` if you need full deep_dive documents |
| `fluent_case_validate` → `verdict: "skipped"` | `indexDir` is not set | this is not an error: offline validation is disabled. Set `indexDir` to enable it |
| Error on startup: `external config …: …` | invalid JSON/JSON array in config.json | validate the JSON: `node -e "JSON.parse(require('fs').readFileSync(process.env.HOME + '/.config/fluent-case-builder/config.json','utf8'))"`, fix it, restart |
| `… outside the allowed roots: …` | the write path is outside `caseRoots` | add the root to `caseRoots` or choose an `outputRoot`/`outputDir` inside an allowed one |
| The error `case directory outside the allowed roots: …` | for a profile with `outputRoot`, `profileRoots` is not set (the template resolves to a path outside `caseRoots`) | set `profileRoots["<profile id>"]` or pass `outputRoot` to the tool |
| `Fluent launch is disabled by the config (allowRun:false)` | launching is disabled | enable `allowRun: true` in the config and confirm with `confirm: true` |
| Fluent does not start / crashes immediately | license, wrong `fluentPath`, mesh/journal | check `ANSYSLMD_LICENSE_FILE`, `ss -ltn \| grep 1055`, `fluentPath`; look at `fluent_case_run({action:"status"})` → `logFile`/`errors` |
| The report is not created | `outputDir` outside the allowed directories (`caseRoots`/`reportDir`/the case directory), no permissions, disk | choose an `outputDir` inside an allowed one; check permissions; `fluent_task_report` returns an error with the path |
| `python3: …` during `fluent_case_plan`/`generate` of a profile | Python 3 is needed for the profile's `python:` computations | install `python3` or use a profile without such computations |
| `example-channel` does not fit the task | it is a synthetic example, not a universal template | use `fluent_case_interview` → `fluent_case_plan({spec})` or add your own profile to `data/profiles`/`profileDirs` |
| It is unclear why a step was not generated | the step is unverified in the KB | this is expected: look at `unsupported`/`warnings` in `fluent_case_plan`, record a `fluent_task_log` and send a report |

---

## Updating and removing

- Update: `remove_bundle` → `install_bundle` with a tag (or `dsh plugin --profile web update fluent-case-builder`),
  then restart DSH. Rollback — install the previous tag (`#v0.4.0` → `#v0.3.0`). Case data lives
  outside the package (`caseRoots`), so installation does not touch it.
- Remove: `dsh plugin --profile web remove fluent-case-builder` (or through `plugin_manager`),
  then restart DSH.
- Removing the plugin does **not** delete the created cases, reports or registry
  (`~/.cache/fluent-case-builder/cases.jsonl`).

## See also

- [README.md](../README.md) — features, configuration, tools.
- [USAGE.md](USAGE.md) — workflows and what appears on disk.
- [REPORT_FORMAT.md](REPORT_FORMAT.md) — the report format for the maintainer.
- [MAINTAINING.md](MAINTAINING.md) — the learning loop: from a colleague's report to a new plugin version.
