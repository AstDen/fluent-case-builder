#!/usr/bin/env node
/**
 * ingest-report.mjs — report aggregator for the fluent-case-builder learning loop.
 *
 * Colleagues generate reports with the `fluent_task_report` tool
 * (contract: docs/REPORT_FORMAT.md, schema `fluent-case-builder/report@1`),
 * the maintainer puts them into learning/inbox/ and runs this script.
 * Output:
 *   learning/aggregate.json — machine-readable aggregate (dedup by report id, merge);
 *   learning/backlog.md     — human-readable backlog for the maintainer.
 *
 * Standalone ESM script: Node.js standard library only (>= 20),
 * no imports from the plugin's lib/.
 *
 * Usage:
 *   node scripts/ingest-report.mjs [paths...] [--out <dir>] [--merge|--no-merge]
 *
 *   paths       .json files and/or directories (recursive walk); default learning/inbox
 *   --out       output directory (aggregate.json, backlog.md); default learning
 *   --merge     extend the existing aggregate.json (enabled by default)
 *   --no-merge  rebuild the aggregate from scratch (dedup within the current run is kept)
 *   -h, --help  this help
 *
 * Invalid reports and non-JSON files are not an error: warning + skip, exit 0.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')

const REPORT_SCHEMA = 'fluent-case-builder/report@1'
const AGGREGATE_SCHEMA = 'fluent-case-builder/aggregate@1'
const SCRIPT_ID = 'scripts/ingest-report.mjs'

/** Default input and output directories — relative to the package root, not cwd. */
const DEFAULT_INBOX = join(PACKAGE_ROOT, 'learning', 'inbox')
const DEFAULT_OUT = join(PACKAGE_ROOT, 'learning')

/** Service directories not to descend into during the recursive walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn'])

const MAX_EXAMPLES = 3 // how many example ids to keep in the stats
const MAX_TEXT = 400 // truncation of arbitrary text (finding messages, etc.)
const MAX_SECTION_ITEMS = 12 // how many items to show in a backlog.md section

const commandLine = (message) => console.log(message)
const warn = (message) => console.warn(`⚠ ${message}`)

class CliError extends Error {}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(stream = commandLine) {
  stream(`fluent-case-builder · report aggregation

Usage:
  node scripts/ingest-report.mjs [paths...] [--out <dir>] [--merge|--no-merge]

  paths       report JSON files and/or directories (recursive walk).
              Default: learning/inbox
  --out       directory for aggregate.json and backlog.md. Default: learning
  --merge     extend the existing aggregate.json (default)
  --no-merge  rebuild aggregate.json from scratch
  -h, --help  show this help

Report contract: docs/REPORT_FORMAT.md (schema "${REPORT_SCHEMA}").
Invalid reports are skipped with a warning; exit code 0.`)
}

function parseArgs(argv) {
  const paths = []
  let out = DEFAULT_OUT
  let merge = true
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '--out') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new CliError('option --out requires a value')
      out = value
      index += 1
      continue
    }
    if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length)
      if (!out) throw new CliError('option --out requires a value')
      continue
    }
    if (arg === '--merge') {
      merge = true
      continue
    }
    if (arg === '--no-merge') {
      merge = false
      continue
    }
    if (arg.startsWith('-')) throw new CliError(`unknown option ${arg}`)
    paths.push(arg)
  }

  return { paths: paths.length > 0 ? paths : [DEFAULT_INBOX], out, merge, help }
}

// ---------------------------------------------------------------------------
// Paths and text
// ---------------------------------------------------------------------------

/** Short path form for logs: relative inside the package, otherwise basename. */
function displayPath(path) {
  const rel = relative(PACKAGE_ROOT, path)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  return basename(path)
}

function isJsonFile(name) {
  return name.toLowerCase().endsWith('.json')
}

function get(object, path) {
  let current = object
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value) {
  if (Array.isArray(value)) return value
  return value == null ? [] : [value]
}

function asString(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function firstString(...values) {
  for (const value of values) {
    const text = asString(value)
    if (text) return text
  }
  return ''
}

/** Single-line text with truncation. */
function truncate(value, max = MAX_TEXT) {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (!flat) return ''
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function uniqueStrings(values) {
  const result = []
  const seen = new Set()
  for (const value of values) {
    const text = asString(value)
    if (text && !seen.has(text)) {
      seen.add(text)
      result.push(text)
    }
  }
  return result
}

const isNumber = (value) => Number.isFinite(value)

// ---------------------------------------------------------------------------
// Walking inputs
// ---------------------------------------------------------------------------

async function collectJsonFiles(inputs) {
  const files = []
  const seen = new Set()
  const missingInputs = []
  const skippedNonJson = []

  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      warn(`failed to read directory ${displayPath(dir)}: ${error.message}`)
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full)
        continue
      }
      if (entry.isSymbolicLink() || !entry.isFile()) continue
      if (!isJsonFile(entry.name)) {
        skippedNonJson.push(full)
        continue
      }
      if (!seen.has(full)) {
        seen.add(full)
        files.push(full)
      }
    }
  }

  for (const input of inputs) {
    let stats
    try {
      stats = await stat(input)
    } catch {
      missingInputs.push(input)
      continue
    }
    if (stats.isDirectory()) {
      await walk(input)
      continue
    }
    if (!stats.isFile()) {
      missingInputs.push(input)
      continue
    }
    if (!isJsonFile(input)) {
      skippedNonJson.push(input)
      continue
    }
    if (!seen.has(input)) {
      seen.add(input)
      files.push(input)
    }
  }

  files.sort((left, right) => left.localeCompare(right))
  return { files, missingInputs, skippedNonJson }
}

// ---------------------------------------------------------------------------
// Reading and validating reports
// ---------------------------------------------------------------------------

function validateReport(report) {
  if (!isPlainObject(report)) return 'JSON is not an object'
  if (report.schema !== REPORT_SCHEMA) {
    return `foreign schema: ${truncate(JSON.stringify(report.schema ?? null), 80)}`
  }
  if (typeof report.id !== 'string' || !report.id.trim()) return 'report id is missing'
  return null
}

async function readReports(files) {
  const reports = []
  const invalid = []
  let aggregateJsonSkipped = 0

  for (const file of files) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      const reason = `unreadable: ${error.message}`
      invalid.push({ file: displayPath(file), reason })
      warn(`skipped ${displayPath(file)}: ${reason}`)
      continue
    }

    let data
    try {
      data = JSON.parse(text)
    } catch (error) {
      const reason = `invalid JSON: ${error.message}`
      invalid.push({ file: displayPath(file), reason })
      warn(`skipped ${displayPath(file)}: ${reason}`)
      continue
    }

    // Our own aggregate that accidentally ended up in the input is neither a report nor an error.
    if (isPlainObject(data) && data.schema === AGGREGATE_SCHEMA) {
      aggregateJsonSkipped += 1
      continue
    }

    const problem = validateReport(data)
    if (problem) {
      invalid.push({ file: displayPath(file), reason: problem })
      warn(`skipped ${displayPath(file)}: ${problem}`)
      continue
    }

    reports.push({ file, report: data })
  }

  return { reports, invalid, aggregateJsonSkipped }
}

// ---------------------------------------------------------------------------
// Normalizing report fields
// ---------------------------------------------------------------------------

function normalizeFinding(raw) {
  if (typeof raw === 'string') {
    const message = truncate(raw)
    return message
      ? { code: 'other', severity: 'info', message, recommendation: '', recipeId: null, count: 1 }
      : null
  }
  if (!isPlainObject(raw)) return null
  return {
    code: truncate(firstString(raw.code) || 'other', 80),
    severity: truncate(firstString(raw.severity) || 'info', 40),
    message: truncate(raw.message),
    recommendation: truncate(raw.recommendation),
    recipeId: firstString(raw.recipeId) || null,
    count: isNumber(raw.count) && raw.count > 0 ? raw.count : 1,
  }
}

function normalizeGap(raw) {
  if (typeof raw === 'string') {
    const detail = truncate(raw)
    return detail ? { kind: 'other', detail, frequency: 1 } : null
  }
  if (!isPlainObject(raw)) return null
  const detail = truncate(firstString(raw.detail, raw.message, raw.text, raw.id))
  if (!detail) return null
  return {
    kind: truncate(firstString(raw.kind) || 'other', 80),
    detail,
    frequency: isNumber(raw.frequency) && raw.frequency > 0 ? raw.frequency : 1,
  }
}

function normalizeRecipe(raw) {
  if (typeof raw === 'string') {
    const id = truncate(raw, 160)
    return id ? { id, status: 'unknown', lines: null } : null
  }
  if (!isPlainObject(raw)) return null
  const id = truncate(firstString(raw.id, raw.recipeId, raw.name), 160)
  if (!id) return null
  return {
    id,
    status: truncate(firstString(raw.status) || 'unknown', 40),
    lines: isNumber(raw.lines) ? raw.lines : null,
  }
}

function normalizeJournalLine(raw) {
  if (typeof raw === 'string') return truncate(raw, 300)
  if (isPlainObject(raw)) return truncate(firstString(raw.line, raw.text, raw.command, raw.raw), 300)
  return ''
}

function normalizeQuestionId(raw) {
  if (typeof raw === 'string') return truncate(raw, 160)
  if (isPlainObject(raw)) return truncate(firstString(raw.id, raw.questionId, raw.specPath, raw.text), 160)
  return ''
}

function normalizeNote(raw) {
  if (typeof raw === 'string') return truncate(raw)
  if (isPlainObject(raw)) return truncate(firstString(raw.text, raw.note, raw.message))
  return ''
}

function describeError(raw) {
  if (typeof raw === 'string') return truncate(raw)
  if (isPlainObject(raw)) return truncate(firstString(raw.message, raw.error, raw.detail, raw.text))
  return ''
}

/** A step the plugin did not support: a string or an object ({step|id|reason|why|...}). */
function describeStep(raw) {
  if (typeof raw === 'string') {
    const step = truncate(raw, 200)
    return step ? { step, reason: '' } : null
  }
  if (!isPlainObject(raw)) return null
  const step = firstString(raw.step, raw.id, raw.name, raw.path, raw.recipeId, raw.title, raw.kind, raw.command)
  const reason = firstString(raw.reason, raw.why, raw.detail, raw.message, raw.note)
  if (!step && !reason) return null
  return { step: truncate(step || reason, 200), reason: truncate(reason) }
}

function mergeSteps(items) {
  const merged = new Map()
  for (const item of items) {
    if (!item) continue
    const key = item.step.toLowerCase()
    const existing = merged.get(key)
    if (existing) {
      if (!existing.reason && item.reason) existing.reason = item.reason
      continue
    }
    merged.set(key, { step: item.step, reason: item.reason || '' })
  }
  return [...merged.values()]
}

function mergeRecipes(items) {
  const merged = new Map()
  for (const item of items) {
    if (!item) continue
    const key = item.id.toLowerCase()
    const existing = merged.get(key)
    if (existing) {
      if (existing.status === 'unknown' && item.status !== 'unknown') existing.status = item.status
      continue
    }
    merged.set(key, { id: item.id, status: item.status || 'unknown', lines: item.lines ?? null })
  }
  return [...merged.values()]
}

// ---------------------------------------------------------------------------
// Report card (the compact representation stored in aggregate.json)
// ---------------------------------------------------------------------------

function toCard(report, sourceFile, now) {
  const fluentRaw = get(report, 'environment.fluent')
  const fluent = isPlainObject(fluentRaw) ? fluentRaw : {}
  const coverageRaw = get(report, 'analysis.coverage')
  const coverage = isPlainObject(coverageRaw) ? coverageRaw : {}
  const generationValidation = isPlainObject(get(report, 'generation.validation'))
    ? get(report, 'generation.validation')
    : isPlainObject(get(report, 'case.generation.validation'))
      ? get(report, 'case.generation.validation')
      : {}
  const completenessRaw = get(report, 'interview.completeness')
  const completeness = isPlainObject(completenessRaw) ? completenessRaw : {}

  const findings = asArray(get(report, 'analysis.findings')).map(normalizeFinding).filter(Boolean)
  const gaps = asArray(get(report, 'analysis.gaps')).map(normalizeGap).filter(Boolean)

  const unsupportedSteps = mergeSteps([
    ...asArray(get(report, 'case.generation.unsupported')).map(describeStep).filter(Boolean),
    ...asArray(get(report, 'generation.unsupported')).map(describeStep).filter(Boolean),
    ...gaps
      .filter((gap) => gap.kind === 'unsupported-step')
      .map((gap) => ({ step: gap.detail, reason: '' })),
  ])

  const unverifiedSteps = mergeSteps(
    asArray(coverage.unverifiedSteps).map(describeStep).filter(Boolean),
  )

  const unverifiedRecipes = mergeRecipes([
    ...asArray(coverage.recipesUsed)
      .map(normalizeRecipe)
      .filter(Boolean)
      .filter((recipe) => recipe.status !== 'verified')
      .map((recipe) => ({ id: recipe.id, status: recipe.status, lines: recipe.lines })),
    ...gaps
      .filter((gap) => gap.kind === 'unverified-recipe')
      .map((gap) => ({ id: gap.detail, status: 'unverified', lines: null })),
  ])

  const unknownLines = uniqueStrings(asArray(coverage.unknownLines).map(normalizeJournalLine)).slice(
    0,
    100,
  )
  const missingRequired = uniqueStrings(
    asArray(get(report, 'interview.completeness.missingRequired')).map(normalizeQuestionId),
  )
  const questionsForMaintainer = uniqueStrings(
    asArray(get(report, 'task.questionsForMaintainer')).map(normalizeNote),
  )
  const notes = uniqueStrings(asArray(get(report, 'task.notes')).map(normalizeNote))
  const runErrors = uniqueStrings(asArray(get(report, 'run.errors')).map(describeError))
  const caseWarnings = uniqueStrings(asArray(get(report, 'case.warnings')).map(normalizeNote))
  const ansysVersions = uniqueStrings(asArray(get(report, 'task.ansysVersions')))

  const countFindings = findings.reduce((sum, finding) => sum + finding.count, 0)
  const countGaps = gaps.reduce((sum, gap) => sum + gap.frequency, 0)

  return {
    id: report.id.trim(),
    generatedAt: asString(report.generatedAt) || null,
    ingestedAt: now,
    sourceFile: basename(sourceFile),
    plugin: asString(get(report, 'generator.pluginVersion')) || null,
    environment: {
      os: asString(get(report, 'environment.os')) || null,
      hostname: asString(get(report, 'environment.hostname')) || null,
      fluent: {
        version: asString(fluent.version) || null,
        build: asString(fluent.build) || null,
        source: asString(fluent.source) || null,
      },
    },
    task: {
      kind: firstString(get(report, 'task.kind')) || 'unknown',
      title: truncate(get(report, 'task.title'), 200),
      ansysVersions,
    },
    case: {
      mode: asString(get(report, 'case.mode')) || null,
      profileId: asString(get(report, 'case.profile.id')) || null,
    },
    verdict: firstString(get(report, 'analysis.verdict')) || 'unknown',
    runStatus: firstString(get(report, 'run.status')) || 'absent',
    generationVerdict: firstString(generationValidation.verdict) || null,
    completeness: {
      total: isNumber(completeness.total) ? completeness.total : null,
      answered: isNumber(completeness.answered) ? completeness.answered : null,
      required: isNumber(completeness.required) ? completeness.required : null,
      requiredAnswered: isNumber(completeness.requiredAnswered)
        ? completeness.requiredAnswered
        : null,
    },
    counts: {
      findings: countFindings,
      findingsEntries: findings.length,
      gaps: countGaps,
      gapsEntries: gaps.length,
      unsupportedSteps: unsupportedSteps.length,
      unverifiedSteps: unverifiedSteps.length,
      unverifiedRecipes: unverifiedRecipes.length,
      unknownLines: unknownLines.length,
      missingRequired: missingRequired.length,
      questionsForMaintainer: questionsForMaintainer.length,
      notes: notes.length,
      runErrors: runErrors.length,
    },
    findings,
    gaps,
    unsupportedSteps,
    unverifiedSteps,
    unverifiedRecipes,
    unknownLines,
    missingRequired,
    questionsForMaintainer,
    notes,
    runErrors,
    caseWarnings,
  }
}

/** Bring a card from an old aggregate.json to the current shape (without losing data). */
function adoptExistingCard(raw, fallbackId) {
  if (!isPlainObject(raw)) return null
  const id = asString(raw.id) || fallbackId
  if (!id) return null
  return {
    ...raw,
    id,
    findings: asArray(raw.findings).map(normalizeFinding).filter(Boolean),
    gaps: asArray(raw.gaps).map(normalizeGap).filter(Boolean),
    unsupportedSteps: mergeSteps(asArray(raw.unsupportedSteps).map(describeStep).filter(Boolean)),
    unverifiedSteps: mergeSteps(asArray(raw.unverifiedSteps).map(describeStep).filter(Boolean)),
    unverifiedRecipes: mergeRecipes(asArray(raw.unverifiedRecipes).map(normalizeRecipe).filter(Boolean)),
    unknownLines: uniqueStrings(asArray(raw.unknownLines).map(normalizeJournalLine)),
    missingRequired: uniqueStrings(asArray(raw.missingRequired).map(normalizeQuestionId)),
    questionsForMaintainer: uniqueStrings(
      asArray(raw.questionsForMaintainer).map(normalizeNote),
    ),
    notes: uniqueStrings(asArray(raw.notes).map(normalizeNote)),
    runErrors: uniqueStrings(asArray(raw.runErrors).map(describeError)),
    caseWarnings: uniqueStrings(asArray(raw.caseWarnings).map(normalizeNote)),
    environment: isPlainObject(raw.environment) ? raw.environment : {},
    task: isPlainObject(raw.task) ? raw.task : {},
    completeness: isPlainObject(raw.completeness) ? raw.completeness : {},
    counts: isPlainObject(raw.counts) ? raw.counts : {},
  }
}

function isNewer(candidate, existing) {
  const candidateTime = Date.parse(candidate.generatedAt ?? '')
  const existingTime = Date.parse(existing.generatedAt ?? '')
  if (!Number.isFinite(candidateTime)) return false
  if (!Number.isFinite(existingTime)) return true
  return candidateTime > existingTime
}

function compareCards(left, right) {
  const leftTime = Date.parse(left.generatedAt ?? '') || 0
  const rightTime = Date.parse(right.generatedAt ?? '') || 0
  if (leftTime !== rightTime) return leftTime - rightTime
  return String(left.id).localeCompare(String(right.id))
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function sortedCounts(map) {
  return Object.fromEntries(
    [...map.entries()].sort(
      (left, right) =>
        right[1] - left[1] || String(left[0]).localeCompare(String(right[0]), 'ru'),
    ),
  )
}

function sortedExamples(map) {
  return [...map.entries()]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort(
      (left, right) =>
        right.count - left.count || String(left.key).localeCompare(String(right.key), 'ru'),
    )
}

function computeStats(cards) {
  const pluginVersions = new Map()
  const fluentVersions = new Map()
  const fluentSources = new Map()
  const ansysVersions = new Map()
  const taskKinds = new Map()
  const verdicts = new Map()
  const runStatuses = new Map()
  const findingsByCode = new Map()
  const findingsBySeverity = new Map()
  const gapsByKind = new Map()

  const unsupportedSteps = new Map()
  const unverifiedSteps = new Map()
  const unverifiedRecipes = new Map()
  const unknownJournalLines = new Map()
  const missingRequiredQuestions = new Map()
  const openQuestions = new Map()
  const notes = new Map()
  const kbGaps = new Map()
  const ansysVersionConflicts = new Map()

  const hosts = new Set()
  const oses = new Set()
  const generatedAts = []

  let findingsTotal = 0
  let gapsTotal = 0
  let reportsWithFindings = 0
  let reportsWithGaps = 0
  let reportsFailed = 0

  const addCount = (map, key, weight = 1) => {
    const normalized = truncate(key, 200) || 'unknown'
    map.set(normalized, (map.get(normalized) ?? 0) + weight)
  }

  const bump = (map, key) => {
    const normalized = truncate(key, 200) || 'unknown'
    let entry = map.get(normalized)
    if (!entry) {
      entry = { count: 0, reports: [] }
      map.set(normalized, entry)
    }
    entry.count += 1
    return entry
  }

  const addExample = (entry, id) => {
    if (entry.reports.length < MAX_EXAMPLES && !entry.reports.includes(id)) entry.reports.push(id)
  }

  for (const card of cards) {
    const id = card.id
    const environment = isPlainObject(card.environment) ? card.environment : {}
    const fluent = isPlainObject(environment.fluent) ? environment.fluent : {}
    const task = isPlainObject(card.task) ? card.task : {}
    const findings = Array.isArray(card.findings) ? card.findings : []
    const gaps = Array.isArray(card.gaps) ? card.gaps : []

    addCount(pluginVersions, card.plugin || 'unknown')

    const fluentVersion = asString(fluent.version) || 'unknown'
    let fluentEntry = fluentVersions.get(fluentVersion)
    if (!fluentEntry) {
      fluentEntry = { count: 0, builds: {}, reports: [] }
      fluentVersions.set(fluentVersion, fluentEntry)
    }
    fluentEntry.count += 1
    const build = asString(fluent.build) || 'unknown'
    fluentEntry.builds[build] = (fluentEntry.builds[build] ?? 0) + 1
    if (fluentEntry.reports.length < MAX_EXAMPLES && !fluentEntry.reports.includes(id)) {
      fluentEntry.reports.push(id)
    }
    addCount(fluentSources, fluent.source || 'unknown')

    for (const version of Array.isArray(task.ansysVersions) ? task.ansysVersions : []) {
      addCount(ansysVersions, version)
    }
    addCount(taskKinds, task.kind || 'unknown')
    addCount(verdicts, card.verdict || 'unknown')
    addCount(runStatuses, card.runStatus || 'absent')

    if (card.generatedAt) generatedAts.push(card.generatedAt)
    if (environment.hostname) hosts.add(environment.hostname)
    if (environment.os) oses.add(environment.os)

    if (card.runStatus === 'failed' || card.verdict === 'failed') reportsFailed += 1

    if (findings.length > 0) reportsWithFindings += 1
    for (const finding of findings) {
      const weight = isNumber(finding.count) && finding.count > 0 ? finding.count : 1
      findingsTotal += weight
      addCount(findingsByCode, finding.code || 'other', weight)
      addCount(findingsBySeverity, finding.severity || 'info', weight)
    }

    if (gaps.length > 0) reportsWithGaps += 1
    for (const gap of gaps) {
      const weight = isNumber(gap.frequency) && gap.frequency > 0 ? gap.frequency : 1
      gapsTotal += weight
      addCount(gapsByKind, gap.kind || 'other', weight)
    }

    for (const step of Array.isArray(card.unsupportedSteps) ? card.unsupportedSteps : []) {
      const entry = bump(unsupportedSteps, step.step)
      if (!entry.reason && step.reason) entry.reason = step.reason
      addExample(entry, id)
    }

    for (const step of Array.isArray(card.unverifiedSteps) ? card.unverifiedSteps : []) {
      const entry = bump(unverifiedSteps, step.step)
      if (!entry.reason && step.reason) entry.reason = step.reason
      addExample(entry, id)
    }

    for (const recipe of Array.isArray(card.unverifiedRecipes) ? card.unverifiedRecipes : []) {
      const entry = bump(unverifiedRecipes, recipe.id)
      if (!entry.status || entry.status === 'unknown') entry.status = recipe.status || 'unknown'
      addExample(entry, id)
    }

    for (const line of Array.isArray(card.unknownLines) ? card.unknownLines : []) {
      addExample(bump(unknownJournalLines, line), id)
    }

    for (const question of Array.isArray(card.missingRequired) ? card.missingRequired : []) {
      addExample(bump(missingRequiredQuestions, question), id)
      const entry = bump(openQuestions, `interview::${question}`)
      entry.kind = 'interview'
      entry.text = `required interview question "${question}" is still unanswered`
      addExample(entry, id)
    }

    for (const question of Array.isArray(card.questionsForMaintainer)
      ? card.questionsForMaintainer
      : []) {
      const entry = bump(openQuestions, `maintainer::${question}`)
      entry.kind = 'maintainer'
      entry.text = question
      addExample(entry, id)
    }

    for (const note of Array.isArray(card.notes) ? card.notes : []) {
      addExample(bump(notes, note), id)
    }

    for (const gap of gaps) {
      if (gap.kind === 'kb-gap' || gap.kind === 'documentation') {
        const entry = bump(kbGaps, `${gap.kind}::${gap.detail}`)
        entry.kind = gap.kind
        entry.detail = gap.detail
        addExample(entry, id)
      }
    }
    for (const finding of findings) {
      if (finding.code === 'kb-gap' && finding.message) {
        const entry = bump(kbGaps, `kb-gap::${finding.message}`)
        entry.kind = 'kb-gap'
        entry.detail = finding.message
        addExample(entry, id)
      }
    }

    const claimed = Array.isArray(task.ansysVersions) ? task.ansysVersions : []
    const detected = asString(fluent.version)
    if (claimed.length > 0 && detected) {
      const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/gu, '')
      const matches = claimed.some((version) => normalize(version) === normalize(detected))
      if (!matches) {
        const key = `claimed ${claimed.join(', ')} / in the log ${detected}`
        const entry = bump(ansysVersionConflicts, key)
        entry.claimed = claimed
        entry.detected = detected
        addExample(entry, id)
      }
    }
  }

  const toCountList = (map, field) =>
    sortedExamples(map).map((entry) => ({
      [field]: entry.key,
      ...(entry.kind ? { kind: entry.kind } : {}),
      ...(field === 'recipe' ? { status: entry.status || 'unknown' } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.text ? { text: entry.text } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      count: entry.count,
      reports: entry.reports,
    }))

  return {
    reportsTotal: cards.length,
    generatedAtMin: generatedAts.length > 0 ? generatedAts.slice().sort()[0] : null,
    generatedAtMax:
      generatedAts.length > 0 ? generatedAts.slice().sort().at(-1) : null,
    pluginVersions: sortedCounts(pluginVersions),
    fluentVersions: Object.fromEntries(
      [...fluentVersions.entries()]
        .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
        .map(([version, entry]) => [
          version,
          {
            count: entry.count,
            reports: entry.reports,
            builds: Object.fromEntries(
              Object.entries(entry.builds).sort(
                (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
              ),
            ),
          },
        ]),
    ),
    fluentSources: sortedCounts(fluentSources),
    ansysVersions: sortedCounts(ansysVersions),
    taskKinds: sortedCounts(taskKinds),
    verdicts: sortedCounts(verdicts),
    runStatuses: sortedCounts(runStatuses),
    findingsByCode: sortedCounts(findingsByCode),
    findingsBySeverity: sortedCounts(findingsBySeverity),
    gapsByKind: sortedCounts(gapsByKind),
    findingsTotal,
    gapsTotal,
    reportsWithFindings,
    reportsWithGaps,
    reportsFailed,
    unsupportedSteps: toCountList(unsupportedSteps, 'step'),
    unverifiedSteps: toCountList(unverifiedSteps, 'step'),
    unverifiedRecipes: toCountList(unverifiedRecipes, 'recipe').map((entry) => ({
      id: entry.recipe,
      status: entry.status,
      count: entry.count,
      reports: entry.reports,
    })),
    unknownJournalLines: toCountList(unknownJournalLines, 'line'),
    missingRequiredQuestions: toCountList(missingRequiredQuestions, 'id'),
    openQuestions: toCountList(openQuestions, 'question').map((entry) => ({
      text: entry.text ?? entry.question,
      kind: entry.kind ?? 'maintainer',
      count: entry.count,
      reports: entry.reports,
    })),
    notes: toCountList(notes, 'note').map((entry) => ({
      text: entry.note,
      count: entry.count,
      reports: entry.reports,
    })),
    kbGaps: toCountList(kbGaps, 'gap').map((entry) => ({
      detail: entry.detail ?? entry.gap,
      kind: entry.kind ?? 'kb-gap',
      count: entry.count,
      reports: entry.reports,
    })),
    ansysVersionConflicts: toCountList(ansysVersionConflicts, 'conflict').map((entry) => ({
      conflict: entry.conflict,
      claimed: entry.claimed,
      detected: entry.detected,
      count: entry.count,
      reports: entry.reports,
    })),
    hostsCount: hosts.size,
    osCount: oses.size,
  }
}

// ---------------------------------------------------------------------------
// backlog.md
// ---------------------------------------------------------------------------

function formatStamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso ?? 'unknown')
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function markdownText(value) {
  return truncate(value).replace(/\|/gu, '\\|')
}

function idExamples(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return 'examples: —'
  return `examples: ${reports.map((id) => `\`${id}\``).join(', ')}`
}

function actionItem(text, count, reports) {
  return `- [ ] ${text} — frequency: ${count} rep.; ${idExamples(reports)}`
}

function noteItem(text, count, reports) {
  return `- ${text} — frequency: ${count} rep.; ${idExamples(reports)}`
}

function addSection(lines, title, items) {
  lines.push('', `## ${title}`, '')
  if (items.length === 0) {
    lines.push('_no data yet._')
    return
  }
  const shown = items.slice(0, MAX_SECTION_ITEMS)
  lines.push(...shown)
  if (items.length > shown.length) {
    lines.push('', `_…and ${items.length - shown.length} more item(s): full data in \`aggregate.json\`._`)
  }
}

function collectFindingGroups(cards) {
  const groups = new Map()
  for (const card of cards) {
    const findings = Array.isArray(card.findings) ? card.findings : []
    for (const finding of findings) {
      const code = finding.code || 'other'
      let group = groups.get(code)
      if (!group) {
        group = {
          code,
          severities: new Set(),
          count: 0,
          reports: [],
          messages: [],
          recommendations: [],
        }
        groups.set(code, group)
      }
      group.count += isNumber(finding.count) && finding.count > 0 ? finding.count : 1
      if (finding.severity) group.severities.add(finding.severity)
      if (group.reports.length < MAX_EXAMPLES && !group.reports.includes(card.id)) {
        group.reports.push(card.id)
      }
      if (
        finding.message &&
        group.messages.length < MAX_EXAMPLES &&
        !group.messages.includes(finding.message)
      ) {
        group.messages.push(finding.message)
      }
      if (
        finding.recommendation &&
        group.recommendations.length < MAX_EXAMPLES &&
        !group.recommendations.includes(finding.recommendation)
      ) {
        group.recommendations.push(finding.recommendation)
      }
    }
  }
  return [...groups.values()].sort(
    (left, right) => right.count - left.count || left.code.localeCompare(right.code),
  )
}

function renderBacklog({ aggregate, cards }) {
  const stats = aggregate.stats
  const lines = []

  lines.push('# Learning backlog for `fluent-case-builder`', '')
  lines.push(
    `Updated: **${formatStamp(aggregate.updatedAt)}** · reports in the aggregate: **${stats.reportsTotal}**`,
  )
  lines.push('')
  lines.push(
    'How to update: put report JSON files into `learning/inbox/` and run `node scripts/ingest-report.mjs`.',
  )
  lines.push('Report contract: `docs/REPORT_FORMAT.md`. Process: `docs/MAINTAINING.md`.')
  if (stats.reportsTotal === 0) {
    lines.push('')
    lines.push(
      '> **No data yet.** There are no valid reports in `learning/inbox/` (`schema: "fluent-case-builder/report@1"`).',
    )
  }

  // 1. Verify in a live session -----------------------------------------------
  const live = []
  for (const item of stats.unsupportedSteps) {
    const reason = item.reason ? ` (${markdownText(item.reason)})` : ''
    live.push(actionItem(`Verify step "${markdownText(item.step)}" in a live session${reason}`, item.count, item.reports))
  }
  for (const item of stats.unverifiedSteps) {
    const reason = item.reason ? `: ${markdownText(item.reason)}` : ''
    live.push(actionItem(`Verify the step marked as unverified — "${markdownText(item.step)}"${reason}`, item.count, item.reports))
  }
  for (const recipe of stats.unverifiedRecipes) {
    live.push(
      actionItem(
        `Verify recipe \`${markdownText(recipe.id)}\` (${markdownText(recipe.status)}) and promote its status to \`verified\``,
        recipe.count,
        recipe.reports,
      ),
    )
  }
  for (const item of stats.unknownJournalLines) {
    live.push(
      actionItem(
        `Investigate journal line \`${markdownText(item.line)}\` — it is not in the command index`,
        item.count,
        item.reports,
      ),
    )
  }
  addSection(lines, 'Verify in a live session', live)

  // 2. Add interview questions ------------------------------------------------
  const questions = []
  for (const item of stats.missingRequiredQuestions) {
    questions.push(
      actionItem(
        `Add/refine required question \`${markdownText(item.id)}\` in \`data/rules/questions.json\``,
        item.count,
        item.reports,
      ),
    )
  }
  for (const gap of cards.flatMap((card) =>
    (Array.isArray(card.gaps) ? card.gaps : [])
      .filter((item) => item.kind === 'missing-question')
      .map((item) => ({ card, item })),
  )) {
    questions.push(
      actionItem(
        `Add interview question: "${markdownText(gap.item.detail)}"`,
        gap.item.frequency,
        [gap.card.id],
      ),
    )
  }
  addSection(lines, 'Add interview questions', questions)

  // 3. Error diagnostics ------------------------------------------------------
  const diagnostics = []
  for (const group of collectFindingGroups(cards)) {
    const severity = [...group.severities].join('/') || 'info'
    const message = group.messages[0] ? `: "${markdownText(group.messages[0])}"` : ''
    const recommendation = group.recommendations[0]
      ? ` → ${markdownText(group.recommendations[0])}`
      : ''
    const code = group.code === 'other' ? 'other (assign an exact code)' : group.code
    diagnostics.push(
      actionItem(
        `Add/refine diagnostic \`${markdownText(code)}\` (${markdownText(severity)})${message}${recommendation}`,
        group.count,
        group.reports,
      ),
    )
  }
  for (const card of cards) {
    const failed = card.runStatus === 'failed' || card.verdict === 'failed'
    const hasFindings = Array.isArray(card.findings) && card.findings.length > 0
    if (failed && !hasFindings) {
      diagnostics.push(
        actionItem(
          `Investigate report \`${card.id}\`: run/analysis failed, but findings is empty — a new diagnostic is needed`,
          1,
          [card.id],
        ),
      )
    }
  }
  addSection(lines, 'Error diagnostics', diagnostics)

  // 4. ANSYS versions ---------------------------------------------------------
  lines.push('', '## ANSYS versions', '')
  if (stats.reportsTotal === 0) {
    lines.push('_no data yet._')
  } else {
    lines.push('| Fluent version | build | reports |', '|---|---|---|')
    for (const [version, entry] of Object.entries(stats.fluentVersions)) {
      const builds = Object.entries(entry.builds)
        .map(([build, count]) => `${build} ×${count}`)
        .join(', ')
      lines.push(`| ${markdownText(version)} | ${markdownText(builds)} | ${entry.count} |`)
    }
    lines.push('')
    if (Object.keys(stats.ansysVersions).length > 0) {
      lines.push(
        `Versions claimed in the reports (\`task.ansysVersions\`): ${Object.entries(stats.ansysVersions)
          .map(([version, count]) => `\`${version}\` ×${count}`)
          .join(', ')}.`,
      )
      lines.push('')
    }
    if (Object.keys(stats.fluentSources).length > 0) {
      lines.push(
        `Version source: ${Object.entries(stats.fluentSources)
          .map(([source, count]) => `\`${source}\` ×${count}`)
          .join(', ')}.`,
      )
      lines.push('')
    }

    const versionItems = []
    for (const [version, entry] of Object.entries(stats.fluentVersions)) {
      if (version === 'unknown') continue
      versionItems.push(
        actionItem(
          `Run the verification journal on Fluent "${version}" and set \`verifiedOn\` in the affected recipes`,
          entry.count,
          entry.reports ?? [],
        ),
      )
    }
    for (const conflict of stats.ansysVersionConflicts) {
      versionItems.push(
        actionItem(
          `Reconcile the ANSYS version: ${markdownText(conflict.conflict)} (claimed in the report, different in the log)`,
          conflict.count,
          conflict.reports,
        ),
      )
    }
    // A gap and a version-mismatch finding often describe the same thing — deduplicate by card and text.
    const seenVersionIssues = new Set()
    const pushVersionIssue = (card, text, count) => {
      const key = `${card.id}::${truncate(text).toLowerCase()}`
      if (seenVersionIssues.has(key)) return
      seenVersionIssues.add(key)
      versionItems.push(actionItem(`Investigate the version mismatch: "${markdownText(text)}"`, count, [card.id]))
    }
    for (const card of cards) {
      for (const gap of Array.isArray(card.gaps) ? card.gaps : []) {
        if (gap.kind === 'version-mismatch') {
          pushVersionIssue(card, gap.detail, gap.frequency)
        }
      }
      for (const finding of Array.isArray(card.findings) ? card.findings : []) {
        if (finding.code === 'version-mismatch') {
          pushVersionIssue(card, finding.message, finding.count)
        }
      }
    }
    if (versionItems.length === 0) versionItems.push('- [ ] No new versions or mismatches.')
    lines.push(...versionItems.slice(0, MAX_SECTION_ITEMS))
    if (versionItems.length > MAX_SECTION_ITEMS) {
      lines.push('', `_…and ${versionItems.length - MAX_SECTION_ITEMS} more item(s): full data in \`aggregate.json\`._`)
    }
  }

  // 5. Requests and notes from colleagues --------------------------------------
  const requests = []
  for (const question of stats.openQuestions) {
    if (question.kind !== 'maintainer') continue
    requests.push(actionItem(`Reply to the colleague: "${markdownText(question.text)}"`, question.count, question.reports))
  }
  for (const note of stats.notes) {
    requests.push(noteItem(`Take the note into account: "${markdownText(note.text)}"`, note.count, note.reports))
  }
  addSection(lines, 'Requests and notes from colleagues', requests)

  // 6. Knowledge-base gaps ----------------------------------------------------
  const kb = []
  for (const gap of stats.kbGaps) {
    const kind = gap.kind && gap.kind !== 'kb-gap' ? ` (${markdownText(gap.kind)})` : ''
    kb.push(actionItem(`Close knowledge-base gap: "${markdownText(gap.detail)}"${kind}`, gap.count, gap.reports))
  }
  addSection(lines, 'Knowledge-base gaps', kb)

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(
    `Source: ${aggregate.ingest.inputs.map((input) => `\`${input}\``).join(', ')}. Rebuild: \`node scripts/ingest-report.mjs\`.`,
  )
  lines.push(
    'Raw reports in `learning/inbox/` are not committed; `learning/aggregate.json` and `learning/backlog.md` are committed.',
  )
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    console.error(`Node.js >= 20 is required (currently ${process.versions.node}).`)
    process.exitCode = 1
    return
  }

  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`Argument error: ${error.message}`)
    printUsage(console.error)
    process.exitCode = 2
    return
  }
  if (options.help) {
    printUsage()
    return
  }

  const inputs = options.paths.map((path) => resolve(process.cwd(), path))
  const outDir = resolve(process.cwd(), options.out)
  const aggregatePath = join(outDir, 'aggregate.json')
  const backlogPath = join(outDir, 'backlog.md')

  console.log('fluent-case-builder · report aggregation')
  console.log(`Input:  ${inputs.join(', ')}`)
  console.log(`Output: ${outDir}`)

  const { files, missingInputs, skippedNonJson } = await collectJsonFiles(inputs)
  for (const missing of missingInputs) {
    const hint = missing === DEFAULT_INBOX ? ' — empty inbox, this is normal' : ''
    warn(`input not found: ${missing}${hint}`)
  }

  const { reports, invalid, aggregateJsonSkipped } = await readReports(files)

  // Merge with the previous aggregate.
  const cards = new Map()
  let merged = false
  let reportsBefore = 0
  if (options.merge && existsSync(aggregatePath)) {
    try {
      const parsed = JSON.parse(await readFile(aggregatePath, 'utf8'))
      if (isPlainObject(parsed) && parsed.schema === AGGREGATE_SCHEMA && isPlainObject(parsed.reports)) {
        for (const [id, raw] of Object.entries(parsed.reports)) {
          const card = adoptExistingCard(raw, id)
          if (card) cards.set(card.id, card)
        }
        merged = true
        reportsBefore = cards.size
      } else {
        warn(`aggregate.json does not match schema ${AGGREGATE_SCHEMA} — rebuilding from scratch`)
      }
    } catch (error) {
      warn(`failed to read aggregate.json (${error.message}) — rebuilding from scratch`)
    }
  }

  const now = new Date().toISOString()
  let added = 0
  let duplicates = 0
  let replaced = 0

  for (const { file, report } of reports) {
    const card = toCard(report, file, now)
    const existing = cards.get(card.id)
    if (!existing) {
      cards.set(card.id, card)
      added += 1
      continue
    }
    duplicates += 1
    if (isNewer(card, existing)) {
      cards.set(card.id, card)
      replaced += 1
    }
  }

  const sortedCards = [...cards.values()].sort(compareCards)
  const stats = computeStats(sortedCards)

  const aggregate = {
    schema: AGGREGATE_SCHEMA,
    updatedAt: now,
    generator: {
      script: SCRIPT_ID,
      format: 1,
    },
    ingest: {
      lastRunAt: now,
      merged,
      inputs: inputs.map(displayPath),
      filesScanned: files.length,
      reportsFound: reports.length,
      reportsAdded: added,
      reportsReplaced: replaced,
      reportsBeforeMerge: reportsBefore,
      reportsTotal: sortedCards.length,
      duplicates,
      invalid,
      nonJsonSkipped: skippedNonJson.map(displayPath).slice(0, 100),
      aggregateJsonSkipped,
      missingInputs: missingInputs.map(displayPath),
    },
    reports: Object.fromEntries(sortedCards.map((card) => [card.id, card])),
    stats,
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8')
  await writeFile(backlogPath, renderBacklog({ aggregate, cards: sortedCards }), 'utf8')

  // Final summary.
  const formatCounts = (counts) => {
    const entries = Object.entries(counts)
    return entries.length > 0 ? entries.map(([key, value]) => `${key} ${value}`).join(', ') : 'none'
  }
  const formatFluent = () =>
    Object.entries(stats.fluentVersions)
      .map(([version, entry]) => {
        const builds = Object.entries(entry.builds)
          .map(([build, count]) => `${build} ×${count}`)
          .join(', ')
        return `${version} [${builds}] ×${entry.count}`
      })
      .join('; ') || 'no data'

  const maintainerQuestions = stats.openQuestions.filter(
    (question) => question.kind === 'maintainer',
  ).length

  console.log('')
  console.log(
    `Reports read: ${reports.length}; new: ${added}; duplicates: ${duplicates}; invalid: ${invalid.length}; non-JSON skipped: ${skippedNonJson.length}.`,
  )
  console.log(
    `Total in the aggregate: ${stats.reportsTotal}${merged ? ` (merge; was ${reportsBefore})` : ' (rebuilt from scratch)'}.`,
  )
  console.log('')
  console.log('Summary:')
  console.log(`  findings: ${stats.findingsTotal} (${formatCounts(stats.findingsBySeverity)})`)
  console.log(`  gaps: ${stats.gapsTotal} (${formatCounts(stats.gapsByKind)})`)
  console.log(
    `  unsupported steps: ${stats.unsupportedSteps.length}; unverified recipes: ${stats.unverifiedRecipes.length}; unknown journal lines: ${stats.unknownJournalLines.length}`,
  )
  console.log(
    `  unanswered required questions: ${stats.missingRequiredQuestions.length}; maintainer requests: ${maintainerQuestions}; notes: ${stats.notes.length}`,
  )
  console.log(`  Fluent versions: ${formatFluent()}`)
  console.log(`  hosts: ${stats.hostsCount}; OS: ${stats.osCount}`)
  console.log('')
  console.log(`Aggregate: ${aggregatePath}`)
  console.log(`Backlog:  ${backlogPath}`)
  if (stats.reportsTotal === 0) {
    console.log('')
    console.log('No reports yet — the backlog is empty, this is normal.')
  }
}

main().catch((error) => {
  console.error(`Ingest error: ${error?.stack || error?.message || error}`)
  process.exitCode = 1
})
