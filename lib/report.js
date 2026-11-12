/**
 * Task report (report@1): collect the environment, task statement, case, run
 * and analysis into a self-contained JSON + human-readable Markdown.
 * @module fluent-case-builder/lib/report
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PKG_VERSION } from './version.js'
import {
  analyzeCase, detectFluentInfo, environmentBasics, loadDiagnostics,
} from './analyze.js'
import { compileSpec, loadRecipes } from './compile.js'
import { caseStatus, planCase, validateJournal } from './engine.js'
import { completeness, draftSpec, loadKnowledge } from './rules.js'
import { assertWritable, jsonSafe } from './util.js'

const REPORT_SCHEMA = 'fluent-case-builder/report@1'
const TOTAL_LOG_LIMIT = 400_000

/** Resolve the report directory: caseRoots, reportDir, or the case itself. */
function resolveReportDir(config, { caseDir, outputDir }) {
  const candidates = []
  if (outputDir) candidates.push(resolve(outputDir))
  if (config.reportDir) candidates.push(config.reportDir)
  if (caseDir) candidates.push(join(caseDir, 'analysis'))
  if (!outputDir && !config.reportDir) candidates.push(join(config.caseRoots[0] ?? process.cwd(), 'reports'))
  const target = candidates[0]
  if (outputDir) {
    const allowed = [...config.caseRoots]
    if (config.reportDir) allowed.push(config.reportDir)
    if (caseDir) allowed.push(caseDir)
    assertWritable(allowed, target, 'report directory')
  }
  return target
}

/** Read the latest case run and its log. */
async function readRun(config, caseDir, { runName = 'setup', includeLogs = true, maxLogLines } = {}) {
  if (!caseDir) return { record: null, log: '', logFile: null, truncated: false }
  const runDir = join(caseDir, '.run')
  if (!existsSync(runDir)) return { record: null, log: '', logFile: null, truncated: false }
  const names = (await readdir(runDir)).filter((name) => name.endsWith('.json'))
  if (!names.length) return { record: null, log: '', logFile: null, truncated: false }
  const chosen = names.find((name) => name === `${runName}.json`) ?? names.sort().slice(-1)[0]
  let record = null
  try { record = JSON.parse(await readFile(join(runDir, chosen), 'utf8')) } catch { record = null }
  let log = ''
  let logFull = ''
  let truncated = false
  if (record?.logFile && existsSync(record.logFile)) {
    const text = await readFile(record.logFile, 'utf8')
    logFull = text
    if (includeLogs) {
      const limit = Number(maxLogLines) > 0 ? Number(maxLogLines) : config.maxLogLines
      const lines = text.split(/\r?\n/)
      const kept = lines.slice(-limit)
      truncated = kept.length < lines.length || text.length > TOTAL_LOG_LIMIT
      log = kept.join('\n').slice(-TOTAL_LOG_LIMIT)
    }
  }
  return { record, log, logFull, logFile: record?.logFile ?? null, truncated }
}

/** Build and write the report. */
export async function createReport(config, options = {}) {
  const {
    caseDir: caseDirInput, profile, params, spec, answers,
    title, kind, description, expectations, notes = [], questions = [],
    includeLogs = true, outputDir, runName = 'setup',
  } = options

  const generatedAt = new Date().toISOString()
  const knowledge = await loadKnowledge(config.dataDir)
  const { recipes, warnings: recipeWarnings } = await loadRecipes(config.dataDir)
  const diagnostics = await loadDiagnostics(config.dataDir)

  // ---- determine case/plan/journal ----
  let caseDir = caseDirInput ? resolve(caseDirInput) : null
  let profileData = null
  let plan = null
  let compiled = null
  let validation = null
  let generation = null
  let journalLines = []

  if (profile) {
    plan = await planCase(config, profile, params ?? {}, { outputRoot: options.outputRoot })
    caseDir = caseDir ?? plan.caseDir
    profileData = { id: plan.profile.id, params: plan.params, preset: plan.preset?.name ?? null, title: plan.profile.title }
    journalLines = plan.journal ? plan.journal.split(/\r?\n/) : []
    validation = await validateJournal(config, journalLines).catch(() => null)
    generation = { warnings: plan.warnings, validation, unsupported: [] }
  }
  if (spec) {
    compiled = compileSpec(spec, recipes)
    journalLines = compiled.journal
    validation = await validateJournal(config, compiled.journal).catch(() => null)
    generation = { warnings: [...recipeWarnings, ...compiled.warnings], validation, unsupported: compiled.unsupported }
  }

  // existing case: manifest + journal + status
  let status = null
  let manifest = null
  if (caseDir && existsSync(join(caseDir, 'case.json'))) {
    try { manifest = JSON.parse(await readFile(join(caseDir, 'case.json'), 'utf8')) } catch { manifest = null }
    try { status = await caseStatus(caseDir) } catch { status = null }
  }
  if (!profileData && manifest) {
    profileData = {
      id: manifest.profile ?? null,
      params: manifest.params ?? null,
      preset: manifest.preset ?? null,
      title: manifest.title ?? null,
    }
  }
  if (!journalLines.length && caseDir && existsSync(join(caseDir, 'setup_case.jou'))) {
    journalLines = (await readFile(join(caseDir, 'setup_case.jou'), 'utf8')).split(/\r?\n/)
    validation = validation ?? await validateJournal(config, journalLines).catch(() => null)
    generation = generation ?? { warnings: manifest?.warnings ?? [], validation, unsupported: [] }
  }

  // ---- run and log ----
  const run = await readRun(config, caseDir, { runName, includeLogs })
  const fluentInfo = detectFluentInfo(config, run.logFull || run.log)
  const environment = {
    ...environmentBasics(),
    fluent: { path: fluentInfo.path, version: fluentInfo.version, build: fluentInfo.build, source: fluentInfo.source },
    license: fluentInfo.license,
    plugin: { plugin: 'fluent-case-builder', pluginVersion: PKG_VERSION, dshProfile: process.env.DSH_PROFILE ?? null },
  }
  const runSection = run.record
    ? {
        name: run.record.name ?? runName,
        status: status?.outputs?.some?.((output) => output.exists) ? 'finished' : run.record.status ?? 'unknown',
        command: run.record.command ?? null,
        startedAt: run.record.startedAt ?? null,
        durationSec: null,
        errors: [],
        invalidCommands: [],
        outputsPresent: status?.allOutputsPresent ?? false,
        logFile: run.record.logFile ? run.record.logFile.replace(caseDir + '/', '') : null,
        logTail: run.log,
      }
    : { status: 'absent', logTail: '' }

  // ---- interview ----
  let interview = null
  if (answers && Object.keys(answers).length) {
    const draft = draftSpec(spec ?? {}, answers, knowledge)
    interview = {
      answers,
      completeness: completeness(knowledge.questions, answers),
      recommendations: draft.recommendations,
      matchedRules: draft.matched.map((rule) => ({ id: rule.id, status: rule.status, why: rule.why, source: rule.source })),
    }
  }

  // ---- notes from file + passed in ----
  const fileNotes = await readTaskNotes(config, { caseDir, outputDir }).catch(() => [])
  const mergedNotes = [
    ...fileNotes.map((note) => `[${note.kind}] ${note.message}`),
    ...notes.map(String),
  ]

  // ---- analysis ----
  const analysis = await analyzeCase({
    config, recipes, diagnostics, journalLines, validation,
    runStatus: run.record ? { status: runSection.status, outputs: status?.outputs ?? [] } : null,
    runLog: run.logFull || run.log,
    unsupported: generation?.unsupported ?? [],
    interviewCompleteness: interview?.completeness ?? null,
    notes: mergedNotes, questions,
  })
  runSection.durationSec = analysis.stats.durationSec ?? null

  // ---- report ----
  const slug = slugify(title || profileData?.title || (spec?.meta?.name) || 'fluent-task')
  const shortHash = createHash('sha1')
    .update(`${generatedAt}|${caseDir ?? ''}|${title ?? ''}`)
    .digest('hex')
    .slice(0, 8)
  const report = {
    schema: REPORT_SCHEMA,
    id: `${generatedAt}-${shortHash}`,
    generatedAt,
    generator: {
      plugin: 'fluent-case-builder',
      pluginVersion: PKG_VERSION,
      dshProfile: process.env.DSH_PROFILE ?? null,
    },
    environment: {
      os: environment.os,
      hostname: environment.hostname,
      node: environment.node,
      python3: environment.python3,
      fluent: environment.fluent,
      license: environment.license,
      hardware: environment.hardware,
      config: {
        externalConfigPath: config.__meta?.externalConfigPath ?? null,
        kbRoot: config.kbRoot || null,
        indexDir: config.indexDir || null,
        caseRoots: config.caseRoots,
        allowRun: Boolean(config.allowRun),
      },
    },
    task: {
      title: title ?? profileData?.title ?? spec?.meta?.name ?? 'Untitled task',
      kind: kind ?? spec?.meta?.taskKind ?? null,
      description: description ?? null,
      expectations: expectations ?? null,
      notes: notes.map(String),
      questionsForMaintainer: questions.map(String),
      appVersion: environment.fluent.version,
      ansysVersions: environment.fluent.version !== 'unknown' ? [environment.fluent.version] : [],
    },
    interview,
    case: {
      mode: profile ? 'profile' : spec ? 'spec' : caseDir ? 'existing' : 'none',
      profile: profileData,
      spec: spec ? jsonSafe(spec) : null,
      caseDir: caseDir ?? null,
      files: status?.files ?? [],
      warnings: generation?.warnings ?? [],
      outputs: status?.outputs ?? [],
    },
    generation: {
      created: [],
      validation,
      unsupported: generation?.unsupported ?? [],
    },
    run: runSection,
    analysis,
    artifacts: {
      reportJson: null,
      reportMarkdown: null,
      notesFile: null,
      includedLogBytes: Buffer.byteLength(run.log, 'utf8'),
      truncated: run.truncated,
    },
  }

  // run errors — from analysis findings
  runSection.errors = analysis.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.message)
  runSection.invalidCommands = analysis.findings
    .filter((finding) => finding.code.startsWith('invalid-command'))
    .flatMap((finding) => finding.examples ?? [])
  const notesPathCandidate = caseDir ? join(caseDir, 'analysis', 'task-notes.jsonl') : null

  // ---- writing ----
  const dir = resolveReportDir(config, { caseDir, outputDir })
  if (notesPathCandidate && existsSync(notesPathCandidate)) report.artifacts.notesFile = notesPathCandidate
  await mkdir(dir, { recursive: true })
  const base = `${timestampForFile(generatedAt)}-${slug}`
  const jsonPath = join(dir, `${base}-report.json`)
  const mdPath = join(dir, `${base}-report.md`)
  report.artifacts.reportJson = jsonPath
  report.artifacts.reportMarkdown = mdPath
  const safe = jsonSafe(report)
  await writeFile(jsonPath, JSON.stringify(safe, null, 2) + '\n', 'utf8')
  await writeFile(mdPath, renderMarkdown(safe) + '\n', 'utf8')
  const size = (await stat(jsonPath)).size
  return {
    report: safe,
    jsonPath,
    mdPath,
    bytes: size,
    summary: {
      id: safe.id,
      verdict: safe.analysis.verdict,
      findings: safe.analysis.findings.length,
      gaps: safe.analysis.gaps.length,
      journalLines: safe.analysis.coverage.journalLines,
      fluent: `${safe.environment.fluent.version} build ${safe.environment.fluent.build}`,
    },
  }
}

/** Append an executor note to the JSONL next to the reports. */
export async function appendTaskNote(config, { caseDir, outputDir, message, kind = 'note', author = null }) {
  const dir = resolveReportDir(config, { caseDir, outputDir })
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'task-notes.jsonl')
  const entry = {
    ts: new Date().toISOString(),
    kind,
    message: String(message),
    author: author ?? process.env.USER ?? null,
    pluginVersion: PKG_VERSION,
  }
  await writeFile(file, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf8' })
  return { file, entry }
}

/** Read notes from the JSONL (if present). */
export async function readTaskNotes(config, { caseDir, outputDir } = {}) {
  const dir = resolveReportDir(config, { caseDir, outputDir })
  const file = join(dir, 'task-notes.jsonl')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

/** Human-readable Markdown report. */
export function renderMarkdown(report) {
  const lines = []
  const h = (level, text) => lines.push(`${'#'.repeat(level)} ${text}`, '')
  h(1, `Task report: ${report.task.title}`)
  lines.push(
    `- **ID:** \`${report.id}\``,
    `- **Created:** ${report.generatedAt}`,
    `- **Plugin:** ${report.generator.plugin} ${report.generator.pluginVersion}`,
    `- **Fluent:** ${report.environment.fluent.version} (build ${report.environment.fluent.build}), license: ${report.environment.license.server}`,
    `- **OS:** ${report.environment.os}; Node ${report.environment.node}; Python: ${report.environment.python3}`,
    '',
  )
  h(2, 'Task')
  lines.push(
    `- Task kind: ${report.task.kind ?? '—'}`,
    `- Description: ${report.task.description ?? '—'}`,
    `- Expectations: ${report.task.expectations ?? '—'}`,
    `- Mode: ${report.case.mode}`,
    report.case.profile ? `- Profile: ${report.case.profile.id}, preset: ${report.case.profile.preset ?? '—'}` : '',
    report.case.profile ? `- Parameters: \`${JSON.stringify(report.case.profile.params)}\`` : '',
    report.case.caseDir ? `- Case directory: \`${report.case.caseDir}\`` : '',
    '',
  )
  if (report.interview) {
    h(2, 'Interview and recommendations')
    lines.push(`- Completeness: ${report.interview.completeness.answered}/${report.interview.completeness.total}, required ${report.interview.completeness.requiredAnswered}/${report.interview.completeness.required}`)
    if (report.interview.completeness.missingRequired.length) {
      lines.push(`- Unanswered: ${report.interview.completeness.missingRequired.join(', ')}`)
    }
    for (const [path, value] of Object.entries(report.interview.recommendations ?? {})) {
      lines.push(`- Recommendation \`${path}\` = \`${JSON.stringify(value)}\``)
    }
    for (const rule of report.interview.matchedRules ?? []) {
      lines.push(`  - rule \`${rule.id}\` (${rule.status}): ${rule.why ?? ''}`)
    }
    lines.push('')
  }
  h(2, 'Journal validation')
  const val = report.generation.validation
  if (val) {
    lines.push(
      `- Total lines: ${val.total ?? '—'}`,
      `- Exact in the KB index: ${val.exact ?? '—'}; menu container: ${val.container ?? '—'}; hidden: ${val.hiddenKnown?.length ?? 0}; 2025-only: ${val.journal2025?.length ?? 0}; unknown: ${val.unknown?.length ?? 0}`,
      `- Verdict: \`${val.verdict ?? '—'}\``,
      '',
    )
  } else {
    lines.push('- The journal was not validated (no index or journal).', '')
  }
  h(2, 'Run')
  lines.push(
    `- Status: ${report.run.status}`,
    report.run.command ? `- Command: \`${report.run.command}\`` : '',
    report.run.durationSec ? `- Duration: ${report.run.durationSec} s` : '',
    `- Results: ${report.case.outputs.filter((output) => output.exists).length}/${report.case.outputs.length}`,
    '',
  )
  h(2, 'Analysis')
  lines.push(`**Verdict:** \`${report.analysis.verdict}\``, '')
  lines.push('| Stage | Status | Evidence |', '|---|---|---|')
  for (const stage of report.analysis.stages ?? []) {
    lines.push(`| ${stage.stage} | ${stage.status} | ${(stage.evidence ?? '').replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  const cov = report.analysis.coverage
  if (cov) {
    lines.push(
      `Journal coverage: ${cov.journalLines} lines — verified ${cov.byStatus.verified ?? 0}, derived ${cov.byStatus.derived ?? 0}, unverified ${cov.byStatus.unverified ?? 0}, unknown ${cov.byStatus.unknown ?? 0}.`,
      '',
    )
  }
  if (report.analysis.findings.length) {
    h(2, 'Findings')
    lines.push('| Code | Severity | Meaning | Recommendation |', '|---|---|---|---|')
    for (const finding of report.analysis.findings) {
      lines.push(`| \`${finding.code}\` | ${finding.severity} | ${(finding.message ?? '').replace(/\|/g, '\\|')} | ${(finding.recommendation ?? '').replace(/\|/g, '\\|')} |`)
    }
    lines.push('')
  }
  if (report.analysis.gaps.length) {
    h(2, 'Gaps for the maintainer')
    for (const gap of report.analysis.gaps) lines.push(`- **${gap.kind}:** ${gap.detail}`)
    lines.push('')
  }
  if (report.task.questionsForMaintainer.length) {
    h(2, 'Questions for the maintainer')
    for (const question of report.task.questionsForMaintainer) lines.push(`- ${question}`)
    lines.push('')
  }
  if (report.task.notes.length) {
    h(2, 'Notes')
    for (const note of report.task.notes) lines.push(`- ${note}`)
    lines.push('')
  }
  lines.push('---', `Full data: \`${report.artifacts.reportJson}\``, '')
  return lines.filter((line) => line !== '' || true).join('\n')
}

function slugify(text) {
  const base = String(text)
    .toLowerCase()
    .replace(/[\u0430-\u044f\u0451]/g, (char) => TRANSLIT[char] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'task'
}

const TRANSLIT = {
  '\u0430': 'a', '\u0431': 'b', '\u0432': 'v', '\u0433': 'g', '\u0434': 'd', '\u0435': 'e', '\u0451': 'e', '\u0436': 'zh', '\u0437': 'z', '\u0438': 'i',
  '\u0439': 'y', '\u043a': 'k', '\u043b': 'l', '\u043c': 'm', '\u043d': 'n', '\u043e': 'o', '\u043f': 'p', '\u0440': 'r', '\u0441': 's', '\u0442': 't',
  '\u0443': 'u', '\u0444': 'f', '\u0445': 'h', '\u0446': 'ts', '\u0447': 'ch', '\u0448': 'sh', '\u0449': 'sch', '\u044a': '', '\u044b': 'y', '\u044c': '',
  '\u044d': 'e', '\u044e': 'yu', '\u044f': 'ya',
}

function timestampForFile(iso) {
  return iso.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

export { REPORT_SCHEMA }
