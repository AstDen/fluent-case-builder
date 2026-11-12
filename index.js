/**
 * fluent-case-builder — a universal builder for ANSYS Fluent simulation cases.
 *
 * The plugin does not hard-code a single project: domain knowledge lives in the data
 * (data/profiles — project cases, data/recipes — verified journal blocks,
 * data/rules — engineering rules and interview questions). The code only:
 *  1) runs the interview and recommends models;
 *  2) builds the plan and generates case files;
 *  3) validates the journal against the knowledge base;
 *  4) launches Fluent and monitors the run with backups.
 *
 * @module fluent-case-builder
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { kbHint, normalizeConfig } from './lib/config.js'
import { caseStatus, generateCase, generateFromSpec, listCases, planCase, validateJournal } from './lib/engine.js'
import { discoverProfiles, describeParams, loadProfile } from './lib/profile.js'
import { applyRules, buildFacts, completeness, draftSpec, loadKnowledge, nextQuestions } from './lib/rules.js'
import { compileSpec, loadRecipes, searchRecipes } from './lib/compile.js'
import { loadCommands, readKbFile, searchCommands } from './lib/kb.js'
import { startRun, runStatus, stopRun } from './lib/run.js'
import { jsonSafe } from './lib/util.js'
import { PKG_VERSION } from './lib/version.js'
import { applyUpdate, buildUpdateCommands, checkUpdate, DEFAULT_UPDATE_SOURCE, writeUpdateScript } from './lib/update.js'
import { appendTaskNote, createReport } from './lib/report.js'


/** Built-in skill: routes Fluent questions to the plugin knowledge base. */
const KB_SKILL = {
  name: 'fluent-tui-knowledge',
  description: 'ANSYS Fluent TUI: find verified commands and recipes, set up cases, produce maintainer reports',
  whenToUse: 'any questions about ANSYS Fluent, TUI commands, enabling models/BCs/materials/solver, creating and validating simulation cases, journal automation',
  source: 'bundled',
  content: `# ANSYS Fluent — working through the fluent-case-builder plugin

## Hard rules
1. **Do not invent TUI syntax.** Search the plugin for a fact first, answer only after that.
2. **Search first, answer second.** For a "how do I enable/set/find X in Fluent" question, call
   \`fluent_kb_search({ query, scope: "all" })\` — it returns both commands from the TUI index and
   verified recipes (journal lines with a status).
3. **Status is mandatory.** \`verified\` — checked in a live session/journal; \`derived\` — inferred from
   the help (verify live); \`unverified\` — not checked, never present it as fact.
4. **Cite the source.** A path in the KB (\`KB/04_MODELS/viscous.md:160-181\`, \`QA_LOG Q-007\`) or a recipe.
5. **If there is no fact** — say so: "the base has no confirmed answer, live-session verification is
   needed", and suggest verifying through \`fluent_case_run\`/journal.

## Answer format for "how to enable X"
1) journal line (ready to use, with arguments);
2) interactive sequence (path → prompts → answers);
3) dependencies (energy/models/mesh/license);
4) how to verify that it was applied;
5) status ✅/🟡/🔴 and source.

## Creating a case
- Task unclear → \`fluent_case_interview\` (questions + model recommendations by Re/Mach/heat transfer).
- Have a specification → \`fluent_case_plan({spec})\` (dry run) → \`fluent_case_generate({spec, outputDir})\`
  (journal only from verified recipes; unverified steps are listed in \`unsupported\`).
- Reusable profile → \`fluent_case_profiles\` → \`fluent_case_plan/generate\`.
- Validate the journal → \`fluent_case_validate\`; run → \`fluent_case_run\` (only on an explicit request,
  with \`confirm:true\`; \`allowRun\` in the config).
- Difficulties/questions → \`fluent_task_log\`; final report to the maintainer → \`fluent_task_report\`.

## If a tool returns configured:false
Tell the user the knowledge-base path is not configured (\`kbRoot\`/\`indexDir\`), quote the hint from the
response, and do not substitute the KB with your own memory.
`,
}

/** Unique cordis plugin name. */
export const name = 'fluent-case-builder'

/** Plugin version (for reports and diagnostics). */
export const version = PKG_VERSION

/** Required Harness services. */
export const inject = ['tools', 'skills']

const text = (value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}]

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => text(value),
}

/** Resolve the case from caseDir or a profile+params pair. */
async function resolveCaseDir(config, args) {
  if (args.caseDir) return args.caseDir
  if (args.profile) {
    const plan = await planCase(config, args.profile, args.params ?? {})
    return plan.caseDir
  }
  throw new Error('provide caseDir or profile+params')
}

/** Plugin: registers the tools. */
export function apply(ctx, rawConfig = {}) {
  // Built-in skill: the agent itself picks the KB tools for Fluent questions.
  if (ctx.skills?.register) {
    try { ctx.skills.register(KB_SKILL) } catch (error) { /* the skill is not critical for the plugin to work */ }
  }

  // Reduce every tool result to lossless JSON (undefined/NaN are not allowed in the output schema).
  const safeRegister = (definition) => ctx.tools.register({
    ...definition,
    execute: async (args, exec) => jsonSafe(await definition.execute(args, exec)),
  })
  let config
  try {
    config = normalizeConfig(rawConfig ?? {})
  } catch (error) {
    throw new Error(`fluent-case-builder: invalid config: ${error.message}`)
  }

  // ---- 1. Profiles ----
  safeRegister(defineTool({
    name: 'fluent_case_profiles',
    description: 'List of ready-made simulation case profiles (project templates) with their parameters. '
      + 'A profile is the most reliable path: it reproduces a verified case from parameters. '
      + 'Start with it when the task resembles an existing project; otherwise use the interview/specification.',
    parameters: {
      profile: { type: 'string', description: 'profile id — return details; empty — list all' },
    },
    output: jsonOutput,
    async execute(args) {
      const profiles = await discoverProfiles(config.dataDir, config.profileDirs ?? [])
      if (args.profile) {
        const profile = await loadProfile(config.dataDir, args.profile, config.profileDirs ?? [])
        return {
          id: profile.id,
          title: profile.title,
          description: profile.description ?? null,
          status: profile.status ?? null,
          source: profile.source ?? null,
          params: describeParams(profile),
          verification: profile.verification ?? null,
          templateRoot: config.templateRoots?.[profile.id] ?? null,
        }
      }
      return {
        profiles: profiles.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description ?? null,
          category: p.category ?? null,
          status: p.status ?? (p.error ? `error: ${p.error}` : null),
          paramCount: Object.keys(p.params ?? {}).length,
        })),
        hint: 'fluent_case_plan({profile, params}) — dry run without writing; fluent_case_generate — create the files',
      }
    },
  }))

  // ---- 2. Interview ----
  safeRegister(defineTool({
    name: 'fluent_case_interview',
    description: 'Run a task interview and return: the next questions for the user, model recommendations '
      + '(turbulence by Re, solver by Mach, energy, combustion, radiation, etc.), answer completeness and '
      + 'a draft case spec. Call it repeatedly, passing the accumulated answers. '
      + 'The plugin never asks the user anything itself — the agent asks the questions.',
    parameters: {
      answers: {
        type: 'object', additionalProperties: true,
        description: 'Accumulated answers: {questionId or specPath: value}. Example: {"task.kind":"gas-dynamics","mach":2.5,"reynolds":30000}',
      },
      spec: { type: 'object', additionalProperties: true, description: 'Current draft case spec (see docs/CASE_SPEC.md)' },
      limit: { type: 'integer', description: 'How many questions to return (default 5)' },
    },
    output: jsonOutput,
    async execute(args) {
      const knowledge = await loadKnowledge(config.dataDir)
      const answers = args.answers ?? {}
      const draft = draftSpec(args.spec ?? {}, answers, knowledge)
      const questions = nextQuestions(knowledge.questions, answers)
      const limit = args.limit ?? 5
      return {
        next: questions.next.slice(0, limit),
        pendingCount: questions.pendingCount,
        requiredCount: questions.requiredCount,
        completeness: completeness(knowledge.questions, answers),
        recommendations: draft.recommendations,
        matchedRules: draft.matched.map((r) => ({
          id: r.id, why: r.why, status: r.status, confidence: r.confidence, source: r.source,
        })),
        warnings: draft.warnings,
        draftSpec: draft.spec,
        hint: 'ask the user next[].text, then call again with the new answers',
      }
    },
  }))

  // ---- 3. Plan ----
  safeRegister(defineTool({
    name: 'fluent_case_plan',
    description: 'Dry run without writing to disk: profile+params → case directory, computed values, '
      + 'preset (e.g. quick/fine), file list, journal preview; or a generic case spec → assembled '
      + 'journal and a list of unverified steps. Always call before generate.',
    parameters: {
      profile: { type: 'string', description: 'profile id (e.g. example-channel)' },
      params: { type: 'object', additionalProperties: true, description: 'Profile parameters {R:50, L:1500, phi:0.8, ...}' },
      spec: { type: 'object', additionalProperties: true, description: 'Generic case spec (alternative to profile)' },
      outputRoot: { type: 'string', description: 'override the output root (must be inside caseRoots)' },
      includeJournal: { type: 'boolean', description: 'Return the full journal, not just the preview' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.spec) {
        const { recipes, warnings: recipeWarnings } = await loadRecipes(config.dataDir)
        const compiled = compileSpec(args.spec, recipes)
        const validation = await validateJournal(config, compiled.journal).catch((error) => ({ error: error.message }))
        return {
          mode: 'spec',
          journal: args.includeJournal ? compiled.journal : compiled.journal.slice(0, 40),
          journalLineCount: compiled.journal.length,
          truncated: !args.includeJournal && compiled.journal.length > 40,
          sections: compiled.sections,
          derived: compiled.derived,
          unsupported: compiled.unsupported,
          warnings: [...recipeWarnings, ...compiled.warnings],
          validation,
        }
      }
      if (!args.profile) throw new Error('provide profile or spec')
      const plan = await planCase(config, args.profile, args.params ?? {}, { outputRoot: args.outputRoot })
      const validation = plan.journal
        ? await validateJournal(config, plan.journal.split('\n')).catch((error) => ({ error: error.message }))
        : null
      const result = { mode: 'profile', ...plan, validation }
      if (!args.includeJournal) delete result.journal
      return result
    },
  }))

  // ---- 4. Generation ----
  safeRegister(defineTool({
    name: 'fluent_case_generate',
    description: 'Create case files on disk: from profile+params (directories, UDF/TSV/mesh copies, '
      + 'setup_case.jou, start.sh, case.json manifest, backup of the previous version) OR from a generic '
      + 'specification (setup_case.jou only from verified recipes + case.json; outputDir is required). '
      + 'Idempotent: an existing case is not overwritten without force. Does not launch anything.',
    parameters: {
      profile: { type: 'string', description: 'profile id (instead of spec)' },
      params: { type: 'object', additionalProperties: true, description: 'Profile parameters' },
      spec: { type: 'object', additionalProperties: true, description: 'generic case spec (instead of profile)' },
      outputDir: { type: 'string', description: 'directory for the spec case (inside caseRoots)' },
      name: { type: 'string', description: 'case/file name for spec (defaults to spec.meta.name)' },
      force: { type: 'boolean', description: 'Recreate an existing case (the old profile version goes to archive/)' },
      outputRoot: { type: 'string', description: 'override the profile output root (inside caseRoots)' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.spec) {
        if (!args.outputDir) throw new Error('for a spec case provide outputDir')
        const result = await generateFromSpec(config, args.spec, {
          outputDir: args.outputDir, force: Boolean(args.force), name: args.name,
        })
        const { readFile } = await import('node:fs/promises')
        const validation = await validateJournal(config, (await readFile(result.journalPath, 'utf8')).split(/\r?\n/))
        return { ...result, validation }
      }
      if (!args.profile) throw new Error('provide profile+params or spec+outputDir')
      const result = await generateCase(config, args.profile, args.params ?? {}, { force: Boolean(args.force), outputRoot: args.outputRoot })
      const validation = await validateJournal(config, (await renderFullJournal(config, await planCase(config, args.profile, args.params ?? {}, { outputRoot: args.outputRoot }))).split('\n')).catch((error) => ({ error: error.message }))
      return { ...result, validation }
    },
  }))

  // ---- 5. Validation ----
  safeRegister(defineTool({
    name: 'fluent_case_validate',
    description: 'Offline check of the journal against the Fluent TUI command index (commands.csv): which lines '
      + 'definitely exist, which are hidden/confirmed by journals, which are unknown. Does not replace live '
      + 'verification — dynamic menus and hidden commands produce warnings.',
    parameters: {
      profile: { type: 'string', description: 'validate the profile journal' },
      params: { type: 'object', additionalProperties: true, description: 'profile parameters' },
      caseDir: { type: 'string', description: 'validate an existing case (setup_case.jou)' },
      journal: { type: 'array', items: { type: 'string' }, description: 'validate arbitrary journal lines' },
    },
    output: jsonOutput,
    async execute(args) {
      let lines = args.journal
      if (!lines && args.caseDir) {
        const file = join(args.caseDir, 'setup_case.jou')
        if (!existsSync(file)) throw new Error(`no setup_case.jou in ${args.caseDir}`)
        const { readFile } = await import('node:fs/promises')
        lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      }
      if (!lines && args.profile) {
        const plan = await planCase(config, args.profile, args.params ?? {}, { outputRoot: args.outputRoot })
        lines = (await renderFullJournal(config, plan)).split(/\r?\n/)
      }
      if (!lines) throw new Error('provide profile+params, caseDir or journal')
      return validateJournal(config, lines)
    },
  }))

  // ---- 6. Status ----
  safeRegister(defineTool({
    name: 'fluent_case_status',
    description: 'Case status: manifest, parameters, presence of expected results (.cas.h5/.dat.h5), '
      + 'state of recent runs and the log tail.',
    parameters: {
      caseDir: { type: 'string', description: 'case directory' },
      profile: { type: 'string', description: 'or profile+params to compute the path' },
      params: { type: 'object', additionalProperties: true },
      run: { type: 'string', description: 'run name for the log (default setup)' },
      lines: { type: 'integer', description: 'log lines (default 40)' },
    },
    output: jsonOutput,
    async execute(args) {
      const caseDir = await resolveCaseDir(config, args)
      const status = await caseStatus(caseDir)
      let run = null
      try { run = await runStatus(config, caseDir, args.run ?? 'setup', { lines: args.lines ?? 40 }) } catch { run = null }
      return { ...status, lastRun: run }
    },
  }))

  // ---- 7. Registry ----
  safeRegister(defineTool({
    name: 'fluent_case_list',
    description: 'Recent cases created by the plugin, from the registry (with parameters and status).',
    parameters: {
      limit: { type: 'integer', description: 'how many to return (default 20)' },
      profile: { type: 'string', description: 'filter by profile' },
    },
    output: jsonOutput,
    async execute(args) {
      return { registryPath: config.registryPath, cases: await listCases(config, args) }
    },
  }))

  // ---- 8. Run ----
  safeRegister(defineTool({
    name: 'fluent_case_run',
    description: 'Launch Fluent with a journal in the background and monitor it: action=start (requires confirm:true and allowRun), '
      + 'action=status (log, errors, results), action=stop (stop the process group). '
      + 'Before launching, automatically backs up journals and results to archive/. '
      + 'WARNING: this starts a real run/setup — only on an explicit user request.',
    parameters: {
      action: { type: 'string', required: true, description: 'start | status | stop' },
      caseDir: { type: 'string', description: 'case directory' },
      profile: { type: 'string', description: 'or profile+params' },
      params: { type: 'object', additionalProperties: true },
      journal: { type: 'string', description: 'journal file relative to the case (setup_case.jou)' },
      name: { type: 'string', description: 'run name for the log/record (setup)' },
      dimension: { type: 'string', description: '3ddp | 2ddp | 3d | 2d' },
      threads: { type: 'integer', description: 'number of processes' },
      mpi: { type: 'string', description: 'intel | msmpi | none' },
      affinity: { type: 'string', description: 'core | none' },
      lines: { type: 'integer', description: 'log lines in status' },
      confirm: { type: 'boolean', description: 'explicit launch confirmation (start)' },
    },
    output: jsonOutput,
    async execute(args) {
      const caseDir = await resolveCaseDir(config, args)
      const name = args.name ?? 'setup'
      if (args.action === 'start') {
        if (!args.confirm) throw new Error('launch requires confirm:true — confirm with the user that Fluent may be started')
        const result = await startRun(config, {
          caseDir,
          journalFile: args.journal ?? 'setup_case.jou',
          name,
          dimension: args.dimension ?? '3ddp',
          threads: args.threads ?? 2,
          mpi: args.mpi ?? 'intel',
          affinity: args.affinity ?? 'core',
        })
        return { action: 'start', caseDir, ...result, hint: 'check with fluent_case_run({action:"status"})' }
      }
      if (args.action === 'status') {
        return { action: 'status', ...(await runStatus(config, caseDir, name, { lines: args.lines ?? 60 })) }
      }
      if (args.action === 'stop') {
        return { action: 'stop', ...(await stopRun(caseDir, name)) }
      }
      throw new Error(`unknown action: ${args.action}`)
    },
  }))

  // ---- 9. KB search ----
  safeRegister(defineTool({
    name: 'fluent_kb_search',
    description: 'Search the plugin knowledge: (1) the TUI command index — path, question, default, blocked, help; '
      + '(2) verified recipes — ready journal lines "how to enable/do X" with status '
      + 'verified/derived/unverified and a source. This is the first tool for any Fluent question.',
    parameters: {
      query: { type: 'string', required: true, description: 'what you need: "enable k-omega SST", /define/... , a keyword' },
      limit: { type: 'integer', description: 'results per section (10)' },
      category: { type: 'string', description: 'restrict the index category, e.g. 04_MODELS' },
      scope: { type: 'string', enum: ['all', 'commands', 'recipes'], description: 'all (default) | commands | recipes' },
    },
    output: jsonOutput,
    async execute(args) {
      const limit = args.limit ?? 10
      const scope = args.scope ?? 'all'
      const result = { query: args.query, scope, commands: [], recipes: [], configured: {} }
      if (scope !== 'recipes') {
        if (!config.indexDir) {
          result.configured.indices = false
          result.hint = kbHint(config)
        } else {
          try {
            const commands = await loadCommands(config.indexDir)
            result.commands = searchCommands(commands, args.query, { limit, category: args.category })
            result.configured.indices = true
          } catch (error) {
            result.configured.indices = false
            result.hint = error.message
          }
        }
      }
      if (scope !== 'commands') {
        try {
          const { recipes } = await loadRecipes(config.dataDir)
          result.recipes = searchRecipes(recipes, args.query, { limit })
          result.configured.recipes = recipes.size > 0
        } catch (error) {
          result.configured.recipes = false
        }
      }
      const empty = !result.commands.length && !result.recipes.length
      result.hint = result.hint ?? (empty
        ? 'nothing found in the index or recipes; refine the query or verify the fact in a live session'
        : 'a recipe journal line is a ready answer; status and source are mandatory in the answer')
      return result
    },
  }))

  // ---- 11. Task report (for the maintainer) ----
  safeRegister(defineTool({
    name: 'fluent_task_report',
    description: 'Create a self-contained task report (JSON + Markdown) for the plugin maintainer: '
      + 'environment and Fluent version, task statement, interview answers and recommendations, case/spec, '
      + 'journal check against the KB, run log, automatic error analysis and a list of gaps. '
      + 'The colleague generates the report and sends the file; the maintainer aggregates reports with the '
      + 'scripts/ingest-report.mjs script and updates the plugin. The report contains no secrets/license keys.',
    parameters: {
      caseDir: { type: 'string', description: 'plugin case directory (case.json)' },
      profile: { type: 'string', description: 'or the case profile' },
      params: { type: 'object', additionalProperties: true, description: 'profile parameters' },
      spec: { type: 'object', additionalProperties: true, description: 'or a generic case spec' },
      answers: { type: 'object', additionalProperties: true, description: 'interview answers {question id: value}' },
      title: { type: 'string', description: 'what to name the task' },
      kind: { type: 'string', description: 'task class (hydrodynamics, gas-dynamics, combustion, ...)' },
      description: { type: 'string', description: 'what was computed and why' },
      expectations: { type: 'string', description: 'what result was needed' },
      notes: { type: 'array', items: { type: 'string' }, description: 'notes made along the way' },
      questions: { type: 'array', items: { type: 'string' }, description: 'questions for the maintainer' },
      includeLogs: { type: 'boolean', description: 'include the run log (default true)' },
      outputDir: { type: 'string', description: 'report directory (inside caseRoots/reportDir/case)' },
      runName: { type: 'string', description: 'which run to take (setup)' },
      outputRoot: { type: 'string', description: 'case output root when profile is given' },
    },
    output: jsonOutput,
    async execute(args) {
      return createReport(config, args)
    },
  }))


  // ---- 13. Plugin update ----
  safeRegister(defineTool({
    name: 'fluent_plugin_update',
    description: 'Check and update the fluent-case-builder plugin itself. action=check — current and latest '
      + 'version (git tags) and whether an update is available; action=plan — ready-to-run commands for plugin_manager and the CLI; '
      + 'action=script — write an executable update script; action=apply — perform the update through the '
      + 'official `dsh plugin` (requires confirm:true and allowSelfUpdate:true; DSH must be restarted '
      + 'after the update). The version can be pinned to a tag (e.g. "v0.5.0").',
    parameters: {
      action: { type: 'string', enum: ['check', 'plan', 'script', 'apply'], description: 'check (default) | plan | script | apply' },
      version: { type: 'string', description: 'tag (v0.5.0) or main (default main)' },
      profile: { type: 'string', description: 'DSH profile (defaults to DSH_PROFILE or web)' },
      confirm: { type: 'boolean', description: 'for apply: explicit confirmation' },
      dryRun: { type: 'boolean', description: 'for apply: only show the commands, change nothing' },
      outputDir: { type: 'string', description: 'for script: where to write the script (inside caseRoots)' },
    },
    output: jsonOutput,
    async execute(args) {
      const base = { currentVersion: PKG_VERSION, source: config.updateSource ?? DEFAULT_UPDATE_SOURCE }
      if (args.action === 'plan') {
        return { ...base, ...buildUpdateCommands({ source: base.source, version: args.version ?? 'main', profile: args.profile ?? process.env.DSH_PROFILE ?? 'web' }) }
      }
      if (args.action === 'script') {
        const written = writeUpdateScript(config, { version: args.version, profile: args.profile, outputDir: args.outputDir })
        return { ...base, file: written.file, spec: written.commands.spec, note: written.commands.restart }
      }
      if (args.action === 'apply') {
        const result = applyUpdate(config, { version: args.version, profile: args.profile, confirm: Boolean(args.confirm), dryRun: Boolean(args.dryRun) })
        return { ...base, ...result }
      }
      return { ...base, ...checkUpdate(config) }
    },
  }))

  // ---- 12. Executor note ----
  safeRegister(defineTool({
    name: 'fluent_task_log',
    description: 'Append an executor note to the task log (task-notes.jsonl next to the future report). '
      + 'Notes automatically end up in the fluent_task_report as gaps/requests for the maintainer. '
      + 'Use it as you work: what failed, what had to be worked around, what questions remain.',
    parameters: {
      message: { type: 'string', required: true, description: 'note text' },
      kind: { type: 'string', description: 'note | question | error | blocked | idea (default note)' },
      caseDir: { type: 'string', description: 'case directory' },
      outputDir: { type: 'string', description: 'log directory (inside caseRoots/reportDir/case)' },
      author: { type: 'string', description: 'who is writing (default USER)' },
    },
    output: jsonOutput,
    async execute(args) {
      return appendTaskNote(config, args)
    },
  }))

  // ---- 10. KB document ----
  safeRegister(defineTool({
    name: 'fluent_kb_get',
    description: 'Read a Fluent TUI knowledge-base document by relative path (e.g. 04_MODELS/viscous.md).',
    parameters: {
      path: { type: 'string', required: true, description: 'path relative to the KB root' },
      offset: { type: 'integer', description: 'first line (1)' },
      limit: { type: 'integer', description: 'how many lines (400)' },
    },
    output: jsonOutput,
    async execute(args) {
      if (!config.kbRoot) return { configured: false, hint: kbHint(config) }
      return readKbFile(config.kbRoot, args.path, { offset: args.offset ?? 1, limit: args.limit ?? 400 })
    },
  }))
}

/** Render the full profile journal (the plan reads the template). */
async function renderFullJournal(config, plan) {
  const { readFile } = await import('node:fs/promises')
  const { loadProfile } = await import('./lib/profile.js')
  const { resolveProfile } = await import('./lib/profile.js')
  const { renderTemplate } = await import('./lib/util.js')
  const profile = await loadProfile(config.dataDir, plan.profile.id, config.profileDirs ?? [])
  const resolved = resolveProfile(profile, plan.params, config)
  const scope = {
    ...resolved.scope,
    templateRoot: plan.templateRoot,
    solutionsRoot: config.profileRoots?.[profile.id],
  }
  const template = profile.templates?.setupJournal
  if (!template) throw new Error(`profile ${profile.id}: no templates.setupJournal`)
  const source = template.startsWith('/') ? template : join(profile.dir, template)
  return renderTemplate(await readFile(source, 'utf8'), scope, 'setupJournal')
}
