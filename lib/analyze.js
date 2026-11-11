/**
 * Анализ задачи: окружение Fluent, стадии выполнения журнала, ошибки по логу,
 * покрытие журнала рецептами, пробелы для мейнтейнера.
 * @module fluent-case-builder/lib/analyze
 */
import { existsSync } from 'node:fs'
import { cpus, hostname, platform, release, arch } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readJson } from './util.js'
import { findCommand, loadCommands } from './kb.js'

/** Загрузить таблицу диагностик (data/rules/diagnostics.json). */
export async function loadDiagnostics(dataDir) {
  const file = join(dataDir, 'rules', 'diagnostics.json')
  if (!existsSync(file)) return { patterns: [], warnings: [`нет ${file}`] }
  const data = await readJson(file, 'diagnostics.json')
  const patterns = []
  const warnings = []
  for (const pattern of data.patterns ?? []) {
    try {
      const source = String(pattern.match).replace(/^\(\?i\)/, '')
      patterns.push({ ...pattern, regex: new RegExp(source, 'i') })
    } catch (error) {
      warnings.push(`диагностика ${pattern.id}: некорректный regex: ${error.message}`)
    }
  }
  return { patterns, warnings }
}

/** Версия ОС/среды для отчёта. */
export function environmentBasics() {
  return {
    os: `${platform()} ${release()} ${arch()}`,
    hostname: hostname(),
    node: process.version,
    python3: pythonVersion(),
    hardware: { cpus: cpus().length },
  }
}

function pythonVersion() {
  const result = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  return (result.stdout || result.stderr || '').trim() || 'unknown'
}

/** Определить версию/сборку Fluent из текста лога, иначе из пути. */
export function detectFluentInfo(config, logText = '') {
  const info = { path: config.fluentPath || '', version: 'unknown', build: 'unknown', source: 'unknown' }
  const version = /Welcome to ANSYS Fluent ([\d]{4} R\d)/i.exec(logText)
  const build = /Build Id:\s*(\d+)/i.exec(logText)
  if (version) { info.version = version[1]; info.source = 'run-log' }
  if (build) { info.build = build[1]; info.source = 'run-log' }
  if (info.source === 'unknown' && config.fluentPath) {
    const match = /v(\d{3})/.exec(config.fluentPath)
    if (match) { info.version = `v${match[1]}`; info.source = 'path' }
  }
  const license = /Connected License Server List:\s*\n?\s*([^\n]+)/i.exec(logText)
  info.license = {
    server: license ? license[1].trim() : (config.licenseHost || 'unknown'),
    features: /license enables (\d+)-way parallel execution/i.exec(logText)?.[1]
      ? [`${/license enables (\d+)-way/i.exec(logText)[1]}-way parallel`]
      : [],
    source: license ? 'run-log' : 'config',
  }
  return info
}

const STAGES = [
  { stage: 'mesh-read', markers: [/Reading\s+"/i, /Reading case file/i] },
  { stage: 'udf-compile-load', markers: [/compiled-functions/i, /Compiling/i, /libudf/i] },
  { stage: 'mesh-interfaces', markers: [/Pairing interface zones/i, /Creating one-to-one mesh interfaces/i] },
  { stage: 'models-materials-bc', markers: [/material-name/i, /porous zone/i, /zone-type/i, /species-transport/i] },
  { stage: 'initialization', markers: [/hyb-initialization|initialize-flow|fmg-initialization|Initializing/i] },
  { stage: 'reports', markers: [/report-definitions|report-files|conv-reports/i] },
  { stage: 'save-case-data', markers: [/Writing to .*\.cas\.h5/i, /Writing to .*\.dat\.h5/i] },
]

/** Разобрать лог запуска: стадии, объёмы, длительность. */
export function parseRunLog(logText = '') {
  const stages = STAGES.map((stage) => {
    const marker = stage.markers.find((regex) => regex.test(logText))
    const match = marker?.exec(logText)
    return { stage: stage.stage, status: marker ? 'seen' : 'not-seen', evidence: match ? String(match[0]).slice(0, 160) : null }
  })
  const cells = /(\d+)\s+cells\b/i.exec(logText)
  const zones = /(\d+)\s+zones\b/i.exec(logText)
  const duration = /Total Transcript Time:\s*(.+)/i.exec(logText)
  return {
    stages,
    cells: cells ? Number(cells[1]) : null,
    zones: zones ? Number(zones[1]) : null,
    durationText: duration ? duration[1].trim() : null,
    durationSec: duration ? parseDuration(duration[1]) : null,
  }
}

function parseDuration(text) {
  let seconds = 0
  const hours = /(\d+)\s*Hour/i.exec(text)
  const minutes = /(\d+)\s*Minute/i.exec(text)
  const secs = /(\d+)\s*Second/i.exec(text)
  if (hours) seconds += Number(hours[1]) * 3600
  if (minutes) seconds += Number(minutes[1]) * 60
  if (secs) seconds += Number(secs[1])
  return seconds || null
}

/** Сопоставить строку журнала с рецептом (шаблон с {{...}} → regex). */
export function matchRecipe(line, recipes) {
  const text = String(line).trim()
  let best = null
  for (const recipe of recipes?.values?.() ?? []) {
    for (const template of recipe.journal ?? []) {
      if (!template) continue
      const pattern = '^' + template
        .split(/\{\{[^}]+\}\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.+?') + '$'
      let regex
      try { regex = new RegExp(pattern) } catch { continue }
      if (regex.test(text) && (!best || template.length > best.template.length)) {
        best = { recipe, template }
      }
    }
  }
  return best ? { id: best.recipe.id, status: best.recipe.status } : null
}

/** Покрытие журнала: по статусам рецептов и по валидации KB. */
export async function journalCoverage(config, lines, validation, recipes) {
  const coverage = {
    journalLines: 0,
    byStatus: { verified: 0, derived: 0, unverified: 0, unknown: 0, service: 0 },
    recipesUsed: [],
    unknownLines: [],
    unverifiedSteps: [],
  }
  const used = new Map()
  const commands = config.indexDir ? await loadCommands(config.indexDir).catch(() => null) : null
  for (const raw of lines) {
    const line = String(raw).trim()
    if (!line || line.startsWith(';')) continue
    coverage.journalLines++
    if (/^(exit|\/exit)/.test(line) || line.startsWith('(')) { coverage.byStatus.service++; continue }
    const recipe = matchRecipe(line, recipes)
    if (recipe) {
      used.set(recipe.id, { id: recipe.id, status: recipe.status, lines: (used.get(recipe.id)?.lines ?? 0) + 1 })
      if (recipe.status === 'verified') coverage.byStatus.verified++
      else if (recipe.status === 'derived') coverage.byStatus.derived++
      else { coverage.byStatus.unverified++; coverage.unverifiedSteps.push({ line, recipe: recipe.id }) }
      continue
    }
    const match = commands ? findCommand(commands, line) : null
    if (match?.reason === 'exact') { coverage.byStatus.verified++; continue }
    if (match?.reason === 'container' || match?.reason === 'hidden-known') { coverage.byStatus.derived++; continue }
    coverage.byStatus.unknown++
    coverage.unknownLines.push(line)
  }
  coverage.recipesUsed = [...used.values()]
  if (validation?.unknown?.length) {
    coverage.unknownLines = [...new Set([...coverage.unknownLines, ...validation.unknown])]
    coverage.byStatus.unknown = Math.max(coverage.byStatus.unknown, validation.unknown.length)
  }
  if (validation?.journal2025?.length) {
    coverage.legacy2025 = validation.journal2025
  }
  return coverage
}

/** Найти диагностируемые ошибки в логе по таблице patterns. */
export function findingsFromLog(logText, diagnostics) {
  const findings = []
  const lines = String(logText).split(/\r?\n/)
  for (const pattern of diagnostics?.patterns ?? []) {
    const matched = []
    for (let i = 0; i < lines.length; i++) {
      if (!pattern.regex.test(lines[i])) continue
      matched.push(lines[i].trim())
      if (matched.length >= 20) break
    }
    if (!matched.length) continue
    findings.push({
      severity: pattern.severity ?? 'warning',
      code: pattern.id,
      message: pattern.meaning ?? matched[0],
      journalLine: null,
      recipeId: null,
      recommendation: pattern.recommendation ?? '',
      source: pattern.source ?? null,
      count: matched.length,
      examples: matched.slice(0, 3),
    })
  }
  const batch = findings.find((finding) => finding.code === 'invalid-command-batch-confirm')
  if (batch) {
    const filtered = findings.filter((finding) => !(finding.code === 'invalid-command'
      && (finding.examples ?? []).every((line) => (batch.examples ?? []).includes(line))))
    return filtered
  }
  return findings
}

/** Собрать analysis-блок отчёта. */
export async function analyzeCase({
  config, recipes, diagnostics, journalLines = [], validation = null,
  runStatus = null, runLog = '', unsupported = [], interviewCompleteness = null,
  notes = [], questions = [],
}) {
  const coverage = journalLines.length
    ? await journalCoverage(config, journalLines, validation, recipes)
    : { journalLines: 0, byStatus: {}, recipesUsed: [], unknownLines: [], unverifiedSteps: [] }
  const parsed = parseRunLog(runLog)
  const findings = findingsFromLog(runLog, diagnostics)
  const gaps = []
  const seenGaps = new Set()
  const addGap = (kind, detail) => {
    const key = `${kind}:${detail}`
    if (seenGaps.has(key)) return
    seenGaps.add(key)
    gaps.push({ kind, detail, frequency: 1 })
  }

  for (const item of unsupported) {
    addGap('unsupported-step', `${item.id ?? item.section} (${item.reason ?? 'нет проверенного рецепта'})${item.source ? `; ${item.source}` : ''}`)
  }
  for (const item of coverage.unverifiedSteps ?? []) {
    addGap('unverified-recipe', `${item.recipe}: ${item.line.slice(0, 160)}`)
  }
  for (const missing of interviewCompleteness?.missingRequired ?? []) {
    addGap('missing-question', `не отвечен обязательный вопрос интервью: ${missing}`)
  }
  const legacy = new Set(coverage.legacy2025 ?? [])
  for (const line of coverage.unknownLines ?? []) {
    if (legacy.has(line)) continue
    addGap('kb-gap', `строка журнала не найдена в KB-индексе: ${line.slice(0, 160)}`)
  }
  for (const line of coverage.legacy2025 ?? []) {
    addGap('version-mismatch', `строка подтверждена только журналами 2025 R1: ${line.slice(0, 160)}`)
  }
  if (parsed.stages.every((stage) => stage.status === 'not-seen') && runLog) {
    addGap('documentation', 'лог запуска есть, но ни одна ключевая стадия не распознана — нужен разбор мейнтейнером')
  }
  for (const note of notes) addGap('documentation', `заметка исполнителя: ${String(note).slice(0, 200)}`)
  for (const question of questions) addGap('documentation', `вопрос мейнтейнеру: ${String(question).slice(0, 200)}`)

  // Решение по вердикту
  const hasErrors = findings.some((finding) => finding.severity === 'error')
  const outputsPresent = runStatus?.outputs?.some?.((output) => output.exists) ?? false
  let verdict = 'analyzed'
  if (runStatus) {
    verdict = runStatus.status === 'failed' && hasErrors ? 'failed' : outputsPresent ? 'configured' : 'incomplete'
  } else if (coverage.journalLines && coverage.byStatus.unknown === 0 && !unsupported.length) {
    verdict = 'planned'
  }

  return {
    verdict,
    stages: parsed.stages,
    stats: {
      cells: parsed.cells,
      zones: parsed.zones,
      durationText: parsed.durationText,
      durationSec: parsed.durationSec ?? (runStatus?.durationSec ?? null),
    },
    coverage,
    findings,
    gaps,
  }
}

export { spawnSync }
