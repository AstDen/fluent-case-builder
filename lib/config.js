/**
 * Plugin configuration: portable defaults, external file, environment
 * variables, Fluent auto-detection.
 *
 * Priority order (lowest → highest):
 *   DEFAULTS → plugin config lines (cordis.patch.yml) → external config.json
 *   → environment variables.
 *
 * @module fluent-case-builder/lib/config
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Path to the user's external config. */
export function externalConfigPath() {
  if (process.env.FLUENT_CONFIG) return resolve(process.env.FLUENT_CONFIG)
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'fluent-case-builder', 'config.json')
}

/** Defaults (nothing machine-specific). */
export const DEFAULTS = {
  /** Plugin data directory (profiles/recipes/rules). */
  dataDir: join(PACKAGE_ROOT, 'data'),
  /** Additional profile directories (absolute paths). */
  profileDirs: [],
  /** Fluent TUI knowledge-base root; empty — KB tools are disabled. */
  kbRoot: '',
  /** Directory with commands.csv and kb_summary.json; defaults to the bundled data/index. */
  indexDir: join(PACKAGE_ROOT, 'data', 'index'),
  /** Allowed roots for writing cases; empty — [~/fluent-cases]. */
  caseRoots: [],
  /** Template roots by profile id (project files, read-only). */
  templateRoots: {},
  /** Case output roots by profile id. */
  profileRoots: {},
  /** Where to write reports/notes when caseDir is not set; empty — <caseRoots[0]>/reports. */
  reportDir: '',
  /** Registry of generated cases. */
  registryPath: join(homedir(), '.cache', 'fluent-case-builder', 'cases.jsonl'),
  /** Fluent runs are allowed (the run itself always requires confirm:true). */
  allowRun: false,
  /** Path to the Fluent launcher; empty — auto-detect. */
  fluentPath: '',
  /** License server address. */
  licenseHost: process.env.ANSYSLMD_LICENSE_FILE || '1055@localhost',
  /** Timeout of a single TUI command, ms. */
  timeoutMs: 600000,
  /** Output limit in a tool response, characters. */
  maxOutputChars: 20000,
  /** How many log lines to include in the report. */
  maxLogLines: 800,
  /** Plugin update source (github:owner/repo or a git URL). */
  updateSource: 'github:AstDen/fluent-case-builder',
  /** Allow the fluent_plugin_update tool to modify the profile (disabled by default). */
  allowSelfUpdate: false,
  /** dsh executable for self-update (looked up in PATH by default). */
  dshCommand: 'dsh',
}

/** Read the external config.json, if present. */
export function loadExternalConfig() {
  const file = externalConfigPath()
  if (!existsSync(file)) return { config: {}, path: null }
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'))
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('a JSON object is expected')
    }
    return { config, path: file }
  } catch (error) {
    throw new Error(`external config ${file}: ${error.message}`)
  }
}

/** Try to locate an installed Fluent. */
export function detectFluentPath() {
  if (process.env.FLUENT_PATH) return process.env.FLUENT_PATH
  const which = spawnSync('which', ['fluent'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split('\n')[0]
  const roots = ['/ansys_inc', '/opt/ansys_inc', join(homedir(), 'ansys_inc'), '/usr/ansys_inc']
  for (const root of roots) {
    if (!existsSync(root)) continue
    const versions = readdirSync(root).sort().reverse()
    for (const version of versions) {
      const candidate = join(root, version, 'fluent', 'bin', 'fluent')
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

function listFromEnv(name) {
  const value = process.env[name]
  if (!value) return undefined
  return value.split(':').map((item) => item.trim()).filter(Boolean)
}

function boolFromEnv(name) {
  const value = process.env[name]
  if (value === undefined) return undefined
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

/** Overrides from environment variables. */
export function envOverrides() {
  const overrides = {}
  const map = {
    FLUENT_PATH: 'fluentPath',
    ANSYSLMD_LICENSE_FILE: 'licenseHost',
    FLUENT_KB_ROOT: 'kbRoot',
    FLUENT_KB_INDEX: 'indexDir',
    FLUENT_REGISTRY_PATH: 'registryPath',
    FLUENT_REPORT_DIR: 'reportDir',
    FLUENT_UPDATE_SOURCE: 'updateSource',
    FLUENT_DSH_COMMAND: 'dshCommand',
  }
  for (const [env, key] of Object.entries(map)) {
    if (process.env[env]) overrides[key] = process.env[env]
  }
  const caseRoots = listFromEnv('FLUENT_CASE_ROOTS')
  if (caseRoots) overrides.caseRoots = caseRoots
  const profileDirs = listFromEnv('FLUENT_PROFILE_DIRS')
  if (profileDirs) overrides.profileDirs = profileDirs
  const allowRun = boolFromEnv('FLUENT_ALLOW_RUN')
  if (allowRun !== undefined) overrides.allowRun = allowRun
  const allowSelfUpdate = boolFromEnv('FLUENT_ALLOW_SELF_UPDATE')
  if (allowSelfUpdate !== undefined) overrides.allowSelfUpdate = allowSelfUpdate
  return overrides
}

/** Merge config: DEFAULTS → plugin config → external file → env. */
export function normalizeConfig(raw = {}) {
  const external = loadExternalConfig()
  const merged = {
    ...DEFAULTS,
    ...(raw ?? {}),
    ...external.config,
    ...envOverrides(),
  }
  const config = { ...merged }

  config.dataDir = resolve(config.dataDir || DEFAULTS.dataDir)
  config.profileDirs = (config.profileDirs ?? []).map((p) => resolve(p))
  config.kbRoot = config.kbRoot ? resolve(config.kbRoot) : ''
  config.indexDir = resolve(config.indexDir || DEFAULTS.indexDir)
  config.caseRoots = (config.caseRoots ?? []).map((p) => resolve(p))
  if (!config.caseRoots.length) config.caseRoots = [join(homedir(), 'fluent-cases')]
  config.templateRoots = { ...(config.templateRoots ?? {}) }
  config.profileRoots = { ...(config.profileRoots ?? {}) }
  config.reportDir = config.reportDir ? resolve(config.reportDir) : ''
  config.registryPath = resolve(config.registryPath || DEFAULTS.registryPath)
  if (!config.fluentPath) config.fluentPath = detectFluentPath()
  if (!config.licenseHost) config.licenseHost = '1055@localhost'
  config.maxLogLines = Number(config.maxLogLines) > 0 ? Number(config.maxLogLines) : DEFAULTS.maxLogLines
  config.__meta = {
    externalConfigPath: external.path,
    fluentDetected: Boolean(config.fluentPath),
  }
  return config
}

/** Friendly hint when the config is not set up for the KB. */
export function kbHint(config) {
  return config.kbRoot
    ? null
    : `The knowledge base is not configured. Set kbRoot in ${externalConfigPath()} or the FLUENT_KB_ROOT env variable.`
}

/** Friendly hint when the command index is missing. */
export function indexHint(config) {
  return config.indexDir
    ? null
    : `The command index is not configured (config.indexDir / FLUENT_KB_INDEX) — offline journal validation skipped.`
}
