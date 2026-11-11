/**
 * Движок кейсов: план, генерация файлов, манифест, реестр, проверка журнала.
 * @module fluent-case-builder/lib/engine
 */
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertWritable, jsonSafe, readJson, renderTemplate, today } from './util.js'
import { resolveProfile } from './profile.js'
import { compileSpec, loadRecipes } from './compile.js'
import { findCommand, loadCommands, normalizeCommandPath } from './kb.js'

/** Имена выходных файлов по умолчанию для шаблонов профиля. */
const TEMPLATE_TARGETS = {
  setupJournal: 'setup_case.jou',
  runScript: 'start.sh',
  switchTurbulence: 'switch_to_turbulence.jou',
}

/** Собрать план кейса без записи на диск. */
export async function planCase(config, profileId, rawParams, { outputRoot } = {}) {
  const profile = await loadProfileById(config, profileId)
  const resolved = resolveProfile(profile, rawParams, config, { outputRoot })
  assertWritable(config.caseRoots, resolved.caseDir, 'директория кейса')

  const scope = buildScope(resolved, config)
  const warnings = [...resolved.warnings]
  const files = []
  const missingSources = []

  for (const asset of profile.assets ?? []) {
    const from = renderTemplate(asset.from, scope, `профиль ${profileId}: assets.from`)
    const to = renderTemplate(asset.to, scope, `профиль ${profileId}: assets.to`)
    const mode = asset.mode ?? 'copy'
    const target = join(resolved.caseDir, to)
    const exists = existsSync(from)
    if (!exists && !asset.optional && mode !== 'copyIfExists' && mode !== 'skip-if-missing') missingSources.push(from)
    files.push({ kind: 'asset', mode, from, to: target, missing: !exists })
  }

  for (const [name, template] of Object.entries(profile.templates ?? {})) {
    const source = isAbsolute(template) ? template : join(profile.dir, template)
    const targetName = TEMPLATE_TARGETS[name] ?? `${name}.out`
    const content = existsSync(source)
      ? renderTemplate(await readFile(source, 'utf8'), scope, `профиль ${profileId}: шаблон ${name}`)
      : null
    if (content === null) missingSources.push(source)
    files.push({
      kind: 'template',
      name,
      from: source,
      to: join(resolved.caseDir, targetName),
      mode: name === 'runScript' ? 'exec' : 'write',
      content,
    })
  }

  const directories = (profile.directories ?? []).map((d) => join(resolved.caseDir, renderTemplate(d, scope, 'directories')))
  const touchFiles = (profile.touchFiles ?? []).map((f) => join(resolved.caseDir, renderTemplate(f, scope, 'touchFiles')))
  const expectedOutputs = (profile.outputs ?? []).map((f) => join(resolved.caseDir, renderTemplate(f, scope, 'outputs')))

  if (missingSources.length) warnings.push(`отсутствуют исходные файлы: ${missingSources.join(', ')}`)

  const setupFile = files.find((f) => f.name === 'setupJournal')
  const journalLines = setupFile?.content ? setupFile.content.split(/\r?\n/) : []
  const journalPreview = journalLines.length
    ? [...journalLines.slice(0, 40), '…', ...journalLines.slice(-10)].join('\n')
    : null

  return {
    profile: { id: profile.id, title: profile.title, status: profile.status ?? 'unknown' },
    params: resolved.params,
    computed: resolved.computed,
    preset: { name: resolved.presetName, values: resolved.preset },
    naming: resolved.naming,
    caseFileBase: resolved.caseFileBase,
    animation: resolved.animation,
    caseDir: resolved.caseDir,
    outputRoot: resolved.outputRoot,
    exists: existsSync(resolved.caseDir),
    files: files.map((f) => ({ kind: f.kind, name: f.name ?? null, from: f.from, to: f.to, mode: f.mode ?? 'copy', missing: Boolean(f.missing) })),
    directories,
    touchFiles,
    expectedOutputs,
    journalPreview,
    journal: journalLines.length ? journalLines.join('\n') : null,
    journalLineCount: journalLines.length,
    warnings,
    templateRoot: scope.templateRoot,
  }
}

/** Сгенерировать кейс на диске (идемпотентно; force — с бэкапом старой директории). */
export async function generateCase(config, profileId, rawParams, { force = false, outputRoot } = {}) {
  const profile = await loadProfileById(config, profileId)
  const resolved = resolveProfile(profile, rawParams, config, { outputRoot })
  assertWritable(config.caseRoots, resolved.caseDir, 'директория кейса')

  const scope = buildScope(resolved, config)
  let backupPath = null
  if (existsSync(resolved.caseDir)) {
    if (!force) {
      throw new Error(`кейс уже существует: ${resolved.caseDir}\nпередайте force: true, чтобы пересоздать (старая версия будет сохранена в backup)`)
    }
    backupPath = await backupCaseDir(resolved, config)
  }

  await mkdir(resolved.caseDir, { recursive: true })
  for (const d of profile.directories ?? []) {
    await mkdir(join(resolved.caseDir, renderTemplate(d, scope, 'directories')), { recursive: true })
  }
  for (const f of profile.touchFiles ?? []) {
    const target = join(resolved.caseDir, renderTemplate(f, scope, 'touchFiles'))
    if (!existsSync(target)) await writeFile(target, '', 'utf8')
  }

  const created = []
  const warnings = [...resolved.warnings]
  for (const asset of profile.assets ?? []) {
    const from = renderTemplate(asset.from, scope, 'assets.from')
    const to = join(resolved.caseDir, renderTemplate(asset.to, scope, 'assets.to'))
    const mode = asset.mode ?? 'copy'
    if (!existsSync(from)) {
      if (asset.optional || mode === 'copyIfExists' || mode === 'skip-if-missing') {
        warnings.push(`пропущен отсутствующий ассет: ${from}`)
        continue
      }
      throw new Error(`не найден исходный файл ассета: ${from}`)
    }
    if (mode === 'unzip' || mode === 'unzip-flat') {
      const targetDir = resolve(to)
      await mkdir(targetDir, { recursive: true })
      // распаковка в подкаталог, чтобы не засорять корень кейса служебными путями
      const extractDir = join(targetDir, '.mesh-extract')
      await rm(extractDir, { recursive: true, force: true })
      await mkdir(extractDir, { recursive: true })
      const result = spawnSync('unzip', ['-o', from, '-d', extractDir], { encoding: 'utf8', timeout: config.timeoutMs ?? 600000 })
      if (result.error) throw new Error(`unzip ${from}: ${result.error.message}`)
      if (result.status !== 0) throw new Error(`unzip ${from}: код ${result.status}: ${(result.stderr || '').trim().split('\n').slice(-1)[0] || ''}`)
      const extracted = await readdir(extractDir, { recursive: true, withFileTypes: true })
      let moved = 0
      for (const entry of extracted) {
        if (!entry.isFile()) continue
        const source = join(entry.parentPath ?? entry.path ?? '', entry.name)
        const destination = mode === 'unzip-flat' ? join(targetDir, entry.name) : join(targetDir, entry.name)
        await rename(source, destination)
        moved++
      }
      await rm(extractDir, { recursive: true, force: true })
      created.push({ kind: mode, path: targetDir, from, files: moved })
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
    created.push({ kind: 'asset', path: to, from })
  }

  for (const [name, template] of Object.entries(profile.templates ?? {})) {
    const source = isAbsolute(template) ? template : join(profile.dir, template)
    if (!existsSync(source)) throw new Error(`не найден шаблон профиля: ${source}`)
    const targetName = TEMPLATE_TARGETS[name] ?? `${name}.out`
    const target = join(resolved.caseDir, targetName)
    const content = renderTemplate(await readFile(source, 'utf8'), scope, `профиль ${profileId}: шаблон ${name}`)
    assertNoUnresolved(content, target, { allowBashVars: /(^|\/)[^/]*\.sh$/.test(target) })
    await writeFile(target, content, { encoding: 'utf8', mode: name === 'runScript' ? 0o755 : 0o644 })
    created.push({ kind: 'template', path: target, from: source })
  }

  for (const substitution of profile.udfSubstitutions ?? []) {
    const target = join(resolved.caseDir, substitution.file)
    if (!existsSync(target)) {
      if (substitution.required) throw new Error(`файл для подстановки не найден: ${target}`)
      warnings.push(`подстановка пропущена (нет файла): ${target}`)
      continue
    }
    const text = await readFile(target, 'utf8')
    const pattern = new RegExp(substitution.find, 'g')
    const replacement = renderTemplate(substitution.replace, scope, 'udfSubstitutions.replace')
    if (!pattern.test(text)) {
      if (substitution.required) throw new Error(`обязательная подстановка не нашла шаблон /${substitution.find}/ в ${target}`)
      warnings.push(`подстановка не сработала: /${substitution.find}/ в ${target}`)
      continue
    }
    pattern.lastIndex = 0
    await writeFile(target, text.replace(pattern, replacement), 'utf8')
    created.push({ kind: 'substitution', path: target, find: substitution.find })
  }

  const expectedOutputs = (profile.outputs ?? []).map((f) => join(resolved.caseDir, renderTemplate(f, scope, 'outputs')))
  const manifest = {
    schema: 'fluent-case-builder/case@1',
    profile: profile.id,
    profileVersion: profile.version ?? null,
    title: profile.title ?? null,
    created: new Date().toISOString(),
    caseDir: resolved.caseDir,
    params: resolved.params,
    computed: resolved.computed,
    preset: resolved.presetName,
    presetValues: resolved.preset,
    naming: resolved.naming,
    caseFileBase: resolved.caseFileBase,
    animation: resolved.animation,
    templateRoot: scope.templateRoot,
    files: created.map((c) => c.path),
    expectedOutputs,
    backup: backupPath,
    warnings,
    status: 'generated',
  }
  await writeFile(join(resolved.caseDir, 'case.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const registryEntry = {
    ts: manifest.created,
    caseDir: resolved.caseDir,
    profile: profile.id,
    params: resolved.params,
    preset: resolved.presetName,
    status: 'generated',
    manifest: join(resolved.caseDir, 'case.json'),
  }
  let registryWarning = null
  try {
    await appendRegistry(config.registryPath, registryEntry)
  } catch (error) {
    registryWarning = `реестр недоступен (${error.message}); кейс создан, запись не добавлена`
    warnings.push(registryWarning)
  }

  return {
    caseDir: resolved.caseDir,
    naming: resolved.naming,
    params: resolved.params,
    computed: resolved.computed,
    preset: resolved.presetName,
    created,
    expectedOutputs,
    backup: backupPath,
    warnings,
    manifestPath: join(resolved.caseDir, 'case.json'),
    registryPath: config.registryPath,
    registryWarning,
  }
}

/**
 * Сгенерировать кейс из универсальной спецификации: только проверенный журнал
 * + манифест. Файлы сетки/UDF не копируются — пути берутся из спеки.
 */
export async function generateFromSpec(config, spec, { outputDir, force = false, name } = {}) {
  if (!outputDir) throw new Error('для spec-кейса укажите outputDir (каталог, куда писать setup_case.jou)')
  const caseDirPath = resolve(outputDir)
  assertWritable(config.caseRoots, caseDirPath, 'каталог кейса')
  const { recipes, warnings: recipeWarnings } = await loadRecipes(config.dataDir)
  const compiled = compileSpec(spec, recipes)
  if (!compiled.journal.length) {
    throw new Error('журнал пуст: ни один шаг спеки не подтверждён проверенным рецептом. Проверьте unsupported в fluent_case_plan.')
  }
  const manifestPath = join(caseDirPath, 'case.json')
  if (existsSync(manifestPath) && !force) {
    throw new Error(`кейс уже существует: ${caseDirPath}\nпередайте force: true, чтобы пересоздать`)
  }
  await mkdir(caseDirPath, { recursive: true })
  const journalText = [...compiled.journal, 'exit'].join('\n') + '\n'
  const journalPath = join(caseDirPath, 'setup_case.jou')
  await writeFile(journalPath, journalText, 'utf8')
  const caseName = name ?? spec.meta?.name ?? 'case'
  const expectedOutputs = [join(caseDirPath, `${caseName}.cas.h5`), join(caseDirPath, `${caseName}.dat.h5`)]
  const manifest = {
    schema: 'fluent-case-builder/case@1',
    mode: 'spec',
    created: new Date().toISOString(),
    caseDir: caseDirPath,
    name: caseName,
    spec: jsonSafe(spec),
    journalFile: journalPath,
    journalLines: compiled.journal.length,
    sections: compiled.sections.map((section) => ({ section: section.section, recipe: section.recipe, status: section.status })),
    unsupported: compiled.unsupported,
    warnings: [...recipeWarnings, ...compiled.warnings],
    expectedOutputs,
    status: 'generated',
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  try {
    await appendRegistry(config.registryPath, {
      ts: manifest.created, caseDir: caseDirPath, profile: null, mode: 'spec',
      params: spec.meta ?? {}, status: 'generated', manifest: manifestPath,
    })
  } catch { /* реестр необязателен */ }
  return {
    caseDir: caseDirPath,
    mode: 'spec',
    journalPath,
    manifestPath,
    journalLines: compiled.journal.length,
    sections: manifest.sections,
    unsupported: compiled.unsupported,
    warnings: manifest.warnings,
  }
}

/** Статус кейса: манифест, ожидаемые выходы, наличие журналов/логов. */
export async function caseStatus(caseDir) {
  const manifestPath = join(caseDir, 'case.json')
  if (!existsSync(manifestPath)) throw new Error(`это не кейс плагина (нет case.json): ${caseDir}`)
  const manifest = await readJson(manifestPath, 'case.json')
  const outputs = []
  for (const output of manifest.expectedOutputs ?? []) {
    let size = null
    if (existsSync(output)) {
      try { size = (await stat(output)).size } catch { size = null }
    }
    outputs.push({ path: output, exists: size !== null, bytes: size })
  }
  const files = existsSync(caseDir) ? await readdir(caseDir) : []
  const allOutputsPresent = outputs.length > 0 && outputs.every((o) => o.exists)
  return {
    caseDir,
    profile: manifest.profile,
    created: manifest.created,
    params: manifest.params,
    preset: manifest.preset,
    status: allOutputsPresent ? 'configured' : manifest.status,
    manifestStatus: manifest.status,
    outputs,
    files: files.filter((f) => /\.(jou|sh|h5|c|tsv|json)$/.test(f) || f === 'log'),
    allOutputsPresent,
    outputsBytes: outputs.reduce((sum, o) => sum + (o.bytes ?? 0), 0),
  }
}

/** Список последних кейсов из реестра. */
export async function listCases(config, { limit = 20, profile } = {}) {
  if (!existsSync(config.registryPath)) return []
  const text = await readFile(config.registryPath, 'utf8')
  const entries = text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const filtered = profile ? entries.filter((e) => e.profile === profile) : entries
  return filtered.slice(-limit).reverse()
}

/**
 * Оффлайн-проверка журнала по индексу команд KB.
 * Не заменяет живую проверку: скрытые/динамические команды дают предупреждения, а не ошибки.
 */
export async function validateJournal(config, lines) {
  if (!config.indexDir) {
    return {
      total: lines.filter((l) => String(l).trim() && !String(l).trim().startsWith(';')).length,
      exact: 0, container: 0, hiddenKnown: [], journal2025: [], unknown: [], findings: [],
      verdict: 'skipped',
      note: 'индекс команд не настроен (config.indexDir / FLUENT_KB_INDEX) — оффлайн-валидация пропущена',
    }
  }
  const commands = await loadCommands(config.indexDir)
  const findings = []
  const unknown = []
  const hidden = []
  const legacy2025 = []
  let exact = 0
  let containers = 0
  for (const raw of lines) {
    const line = String(raw).trim()
    if (!line || line.startsWith(';')) continue
    if (line === 'exit' || line === '/exit' || line === '/exit yes') {
      findings.push({ line, kind: 'builtin', note: 'завершение журнала' })
      continue
    }
    if (line.startsWith('(')) { findings.push({ line, kind: 'scheme', note: 'Scheme-форма: вне проверки TUI-индекса' }); continue }
    const match = findCommand(commands, line)
    if (match.reason === 'exact') { exact++; continue }
    if (match.reason === 'container') {
      containers++
      findings.push({ line, kind: 'container', note: `меню ${match.path} известно, но самой команды нет в листовом индексе` })
      continue
    }
    if (match.reason === 'hidden-known') {
      hidden.push(line)
      findings.push({ line, kind: 'hidden-known', note: 'подтверждена документацией/журналами, но отсутствует в меню и индексе' })
      continue
    }
    if (match.reason === 'journal-2025') {
      legacy2025.push(line)
      findings.push({ line, kind: 'journal-2025', note: 'синтаксис подтверждён только журналами Fluent 2025 R1; для 2026 R1 требует проверки' })
      continue
    }
    if (match.reason === 'not-tui-command') {
      findings.push({ line, kind: 'not-tui-command', note: 'не TUI-команда (shell/данные)' })
      continue
    }
    unknown.push(line)
    findings.push({ line, kind: 'unknown', note: `команда не найдена в индексе (${match.path || '?'})` })
  }
  const problems = findings.filter((f) => f.kind === 'unknown')
  return {
    total: lines.filter((l) => String(l).trim() && !String(l).trim().startsWith(';')).length,
    exact,
    container: containers,
    hiddenKnown: hidden,
    journal2025: legacy2025,
    unknown,
    findings,
    verdict: problems.length ? 'has-unknown' : legacy2025.length ? 'ok-with-2025-syntax' : 'ok',
    note: legacy2025.length
      ? 'часть строк подтверждена только журналами 2025 R1 — проверьте их в живой сессии Fluent 2026 R1'
      : null,
  }
}

function buildScope(resolved, config) {
  const solutionsRoot = config.profileRoots?.[resolved.profile.id]
  const templateRoot = config.templateRoots?.[resolved.profile.id]
    ?? (resolved.profile.templateRoot ? renderTemplate(resolved.profile.templateRoot, { ...resolved.scope, solutionsRoot }, 'templateRoot') : '')
  return { ...resolved.scope, templateRoot, solutionsRoot, profileId: resolved.profile.id }
}

async function loadProfileById(config, profileId) {
  const { loadProfile } = await import('./profile.js')
  return loadProfile(config.dataDir, profileId, config.profileDirs ?? [])
}

async function backupCaseDir(resolved, config) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archive = join(resolved.outputRoot, 'archive')
  assertWritable(config.caseRoots, archive, 'каталог бэкапа')
  await mkdir(archive, { recursive: true })
  const target = join(archive, `${resolved.naming}.${stamp}`)
  await rename(resolved.caseDir, target)
  return target
}

async function appendRegistry(registryPath, entry) {
  await mkdir(dirname(registryPath), { recursive: true })
  const line = JSON.stringify(entry) + '\n'
  await writeFile(registryPath, line, { flag: 'a', encoding: 'utf8' })
}

/** В отрендеренном файле не должно остаться плейсхолдеров (и bash-переменных в журналах). */
function assertNoUnresolved(content, target, { allowBashVars = false } = {}) {
  const placeholders = [...content.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0])
  if (placeholders.length) {
    throw new Error(`в ${target} остались неподставленные плейсхолдеры: ${[...new Set(placeholders)].join(', ')}`)
  }
  if (allowBashVars) return
  const bashVars = [...content.matchAll(/(?<![\w$])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g)].map((m) => m[0])
  if (bashVars.length) {
    throw new Error(`в ${target} остались bash-переменные (замените на плейсхолдеры): ${[...new Set(bashVars)].join(', ')}`)
  }
}

export { normalizeCommandPath, today }
