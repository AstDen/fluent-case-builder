/**
 * Конфигурация плагина: переносимые значения по умолчанию, внешний файл,
 * переменные окружения, автоопределение Fluent.
 *
 * Порядок приоритета (низший → высший):
 *   DEFAULTS → config строки плагина (cordis.patch.yml) → внешний config.json
 *   → переменные окружения.
 *
 * @module fluent-case-builder/lib/config
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Путь внешнего конфига пользователя. */
export function externalConfigPath() {
  if (process.env.FLUENT_CONFIG) return resolve(process.env.FLUENT_CONFIG)
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'fluent-case-builder', 'config.json')
}

/** Значения по умолчанию (ничего машинно-специфичного). */
export const DEFAULTS = {
  /** Каталог данных плагина (профили/рецепты/правила). */
  dataDir: join(PACKAGE_ROOT, 'data'),
  /** Дополнительные каталоги профилей (абсолютные пути). */
  profileDirs: [],
  /** Корень базы знаний Fluent TUI; пусто — KB-инструменты отключены. */
  kbRoot: '',
  /** Каталог с commands.csv и kb_summary.json; пусто — оффлайн-валидация отключена. */
  indexDir: '',
  /** Разрешённые корни для записи кейсов; пусто — [~/fluent-cases]. */
  caseRoots: [],
  /** Корни шаблонов по id профиля (проектные файлы, только чтение). */
  templateRoots: {},
  /** Корни вывода кейсов по id профиля. */
  profileRoots: {},
  /** Куда писать отчёты/заметки, если не задан caseDir; пусто — <caseRoots[0]>/reports. */
  reportDir: '',
  /** Реестр созданных кейсов. */
  registryPath: join(homedir(), '.cache', 'fluent-case-builder', 'cases.jsonl'),
  /** Запуск Fluent разрешён (сам запуск всегда требует confirm:true). */
  allowRun: false,
  /** Путь к launcher'у Fluent; пусто — автоопределение. */
  fluentPath: '',
  /** Адрес лицензионного сервера. */
  licenseHost: process.env.ANSYSLMD_LICENSE_FILE || '1055@localhost',
  /** Таймаут одной команды TUI, мс. */
  timeoutMs: 600000,
  /** Лимит вывода в ответе инструмента, символов. */
  maxOutputChars: 20000,
  /** Сколько строк лога включать в отчёт. */
  maxLogLines: 800,
}

/** Прочитать внешний config.json, если он есть. */
export function loadExternalConfig() {
  const file = externalConfigPath()
  if (!existsSync(file)) return { config: {}, path: null }
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'))
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('ожидается JSON-объект')
    }
    return { config, path: file }
  } catch (error) {
    throw new Error(`внешний конфиг ${file}: ${error.message}`)
  }
}

/** Попробовать найти установленный Fluent. */
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

/** Переопределения из переменных окружения. */
export function envOverrides() {
  const overrides = {}
  const map = {
    FLUENT_PATH: 'fluentPath',
    ANSYSLMD_LICENSE_FILE: 'licenseHost',
    FLUENT_KB_ROOT: 'kbRoot',
    FLUENT_KB_INDEX: 'indexDir',
    FLUENT_REGISTRY_PATH: 'registryPath',
    FLUENT_REPORT_DIR: 'reportDir',
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
  return overrides
}

/** Слить конфиг: DEFAULTS → строка плагина → внешний файл → env. */
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
  config.indexDir = config.indexDir ? resolve(config.indexDir) : ''
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

/** Понятная подсказка, если конфиг не настроен для KB. */
export function kbHint(config) {
  return config.kbRoot
    ? null
    : `База знаний не настроена. Задайте kbRoot в ${externalConfigPath()} или env FLUENT_KB_ROOT.`
}

/** Понятная подсказка, если нет индекса команд. */
export function indexHint(config) {
  return config.indexDir
    ? null
    : `Индекс команд не настроен (config.indexDir / FLUENT_KB_INDEX) — оффлайн-валидация журнала пропущена.`
}
