/**
 * Самообновление плагина: проверка версии, план обновления, генерация скрипта и
 * применение через официальный CLI `dsh plugin` (не через сырой pnpm).
 * @module fluent-case-builder/lib/update
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PACKAGE_ROOT } from './config.js'
import { PKG_VERSION } from './version.js'

/** Источник обновления по умолчанию. */
export const DEFAULT_UPDATE_SOURCE = 'github:AstDen/fluent-case-builder'
export const CHANGELOG_URL = 'https://github.com/AstDen/fluent-case-builder/blob/main/CHANGELOG.md'

/** Каталог профиля DSH. */
export function profileDir(profile = process.env.DSH_PROFILE || 'web') {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  return join(homedir(), '.dsh', 'profiles', profile)
}

/** Прочитать установленную версию и spec из профиля. */
export function installedState(profile) {
  const dir = profileDir(profile)
  const state = { profile, profileDir: dir, version: PKG_VERSION, spec: null, bundled: null, error: null }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const deps = pkg.dependencies ?? {}
    state.spec = deps['fluent-case-builder'] ?? null
    state.bundled = (pkg.dsh?.profile?.bundles ?? []).includes('fluent-case-builder')
  } catch (error) {
    state.error = `не удалось прочитать ${join(dir, 'package.json')}: ${error.message}`
  }
  return state
}

/** Сравнить semver-подобные версии: -1/0/1. */
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? '').replace(/^v/, '').split(/[.-]/).map((part) => {
    const number = Number(part)
    return Number.isFinite(number) ? number : part
  })
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l === r) continue
    if (typeof l === 'number' && typeof r === 'number') return l > r ? 1 : -1
    return String(l) > String(r) ? 1 : -1
  }
  return 0
}

/** Преобразовать source (`github:owner/repo`, URL) в URL для git. */
export function sourceToUrl(source) {
  const value = String(source ?? '').trim()
  const github = /^github:([^#]+)/.exec(value)
  if (github) return `https://github.com/${github[1].replace(/\.git$/, '')}.git`
  if (/^https?:\/\//.test(value) || /^git\+https?:\/\//.test(value)) return value.replace(/^git\+/, '')
  if (/^git@/.test(value)) return value
  return null
}

/** Теги вида vX.Y.Z из remote (без сети — тестируемо). */
export function parseTags(output) {
  const tags = []
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /refs\/tags\/(v?\d+\.\d+\.\d+)\^?$/.exec(line.trim())
    if (match) tags.push(match[1].replace(/^v/, 'v'))
  }
  return [...new Set(tags)].sort((a, b) => compareVersions(b, a))
}

/** Список тегов remote через git ls-remote (сеть, таймаут). */
export function remoteTags(source, { timeoutMs = 15000 } = {}) {
  const url = sourceToUrl(source)
  if (!url) throw new Error(`неподдерживаемый источник обновления: ${source}`)
  const result = spawnSync('git', ['ls-remote', '--tags', url], {
    encoding: 'utf8', timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
  })
  if (result.error) throw new Error(`git ls-remote: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ls-remote: код ${result.status}: ${(result.stderr || '').trim().split('\n').slice(-1)[0] || ''}`)
  return parseTags(result.stdout)
}

/** Команды обновления для агента (plugin_manager) и терминала (dsh plugin). */
export function buildUpdateCommands({ source = DEFAULT_UPDATE_SOURCE, version = 'main', profile = 'web' } = {}) {
  const spec = version && version !== 'main' ? `${source}#${version}` : `${source}#main`
  return {
    spec,
    pluginManager: [
      { action: 'remove_bundle', target: 'fluent-case-builder' },
      { action: 'install_bundle', target: spec },
    ],
    cli: [
      `dsh plugin --profile ${profile} remove fluent-case-builder`,
      `dsh plugin --profile ${profile} add ${spec}`,
      '# или одной командой на последнюю версию из main:',
      `dsh plugin --profile ${profile} update fluent-case-builder`,
    ],
    restart: 'После обновления перезапустите DSH (до рестарта возможна ошибка failed to import).',
  }
}

/** Найти исполняемый файл dsh. */
export function resolveDshCommand(config = {}) {
  if (config.dshCommand && config.dshCommand !== 'dsh') return config.dshCommand
  if (process.env.DSH_CLI) return process.env.DSH_CLI
  const which = spawnSync('which', ['dsh'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split('\n')[0]
  // запуск через node_modules/.bin/dsh (npx-кэш): <...>/@deepseek-ai/dsh/lib/bin.js
  const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
  if (argv1.endsWith(join('@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    const candidate = join(dirname(dirname(dirname(argv1))), '.bin', 'dsh')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Проверить наличие обновления (сеть). */
export function checkUpdate(config = {}, { source = config.updateSource ?? DEFAULT_UPDATE_SOURCE, timeoutMs = 15000 } = {}) {
  const state = installedState(config.profile)
  const result = {
    currentVersion: PKG_VERSION,
    installedSpec: state.spec,
    bundled: state.bundled,
    source,
    latestVersion: null,
    latestTag: null,
    updateAvailable: false,
    changelogUrl: CHANGELOG_URL,
    error: state.error,
  }
  try {
    const tags = remoteTags(source, { timeoutMs })
    result.latestTag = tags[0] ?? null
    result.latestVersion = tags[0] ? tags[0].replace(/^v/, 'v') : null
    result.updateAvailable = Boolean(tags[0] && compareVersions(tags[0], `v${PKG_VERSION}`) > 0)
  } catch (error) {
    result.error = error.message
  }
  return result
}

/** Сгенерировать скрипт обновления (не изменяет профиль). */
export function writeUpdateScript(config, { source, version, profile, outputDir } = {}) {
  const commands = buildUpdateCommands({ source: source ?? config.updateSource, version, profile: profile ?? config.profile })
  const dir = resolve(outputDir ?? config.caseRoots?.[0] ?? process.cwd())
  const file = join(dir, 'update-fluent-case-builder.sh')
  const text = [
    '#!/usr/bin/env bash',
    '# Обновление плагина fluent-case-builder (сгенерировано плагином).',
    '# Запускать в обычном терминале; после завершения перезапустить DSH.',
    'set -euo pipefail',
    `echo "Обновление: ${commands.spec}"`,
    commands.cli[0],
    commands.cli[1],
    'echo "Готово. Перезапустите DSH и проверьте: fluent_case_profiles, fluent_kb_search."',
    '',
  ].join('\n')
  writeFileSync(file, text, 'utf8')
  try { chmodSync(file, 0o755) } catch { /* Windows/ограничения ФС */ }
  return { file, commands, text }
}

/** Применить обновление через официальный CLI `dsh plugin` (требует явных разрешений). */
export function applyUpdate(config, { version, profile, confirm, dryRun = false } = {}) {
  if (!confirm) throw new Error('обновление требует confirm:true')
  if (!config.allowSelfUpdate) throw new Error('самообновление выключено: включите allowSelfUpdate:true в конфиге')
  const targetProfile = profile ?? config.profile ?? process.env.DSH_PROFILE ?? 'web'
  const commands = buildUpdateCommands({ source: config.updateSource, version: version ?? 'main', profile: targetProfile })
  // сначала удаляем, затем ставим закреплённый ref — так pnpm гарантированно перечитает spec
  const steps = [
    ['plugin', '--profile', targetProfile, 'remove', 'fluent-case-builder'],
    ['plugin', '--profile', targetProfile, 'add', commands.spec],
  ]
  if (dryRun) return { dryRun: true, commands, steps, restartRequired: true }
  const dsh = resolveDshCommand(config)
  if (!dsh) throw new Error('не найден исполняемый файл dsh; обновите вручную по fluent_plugin_update({action:"plan"})')
  const log = []
  for (const args of steps) {
    const result = spawnSync(dsh, args, {
      encoding: 'utf8', timeout: config.timeoutMs ?? 600000,
      env: { ...process.env },
    })
    log.push({
      command: `${dsh} ${args.join(' ')}`,
      exitCode: result.status,
      stdout: (result.stdout ?? '').slice(-4000),
      stderr: (result.stderr ?? '').slice(-4000),
      error: result.error ? result.error.message : null,
    })
    if (result.error || result.status !== 0) {
      return { ok: false, steps: log, restartRequired: true, note: 'обновление не завершено; см. лог шагов' }
    }
  }
  return { ok: true, steps: log, restartRequired: true, note: 'обновление установлено; перезапустите DSH' }
}

export { PACKAGE_ROOT, PKG_VERSION }
