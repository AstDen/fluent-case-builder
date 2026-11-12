#!/usr/bin/env node
/**
 * Engine smoke test without DSH: util, kb, rules, compile, profile (if a profile is ready).
 * Run: node scripts/smoke.mjs
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const ok = []
const check = (name, fn) => {
  try {
    const value = fn()
    if (value instanceof Promise) throw new Error('use checkAsync')
    ok.push(name)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    ok.push(name)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

const { evalExpression, renderTemplate, isInside, coerceParam } = await import(join(root, 'lib/util.js'))

check('evalExpression: arithmetic', () => {
  assert(evalExpression('(a - b) / 1000', { a: 50, b: 10 }) === 0.04, '(50-10)/1000 must be 0.04')
  assert(evalExpression('1 * L / 6000', { L: 1500 }) === 0.25, 'l1')
  assert(evalExpression('iterations >= 1000 || level >= 0.7', { iterations: 1500, level: 0.2 }) === true, 'preset fine')
  assert(evalExpression('iterations >= 1000 || level >= 0.7', { iterations: 500, level: 0.2 }) === false, 'preset quick')
  assert(evalExpression('max(2, 7) ** 2', {}) === 49, 'max**2')
  assert(evalExpression('!!true', {}) === true, 'double negation')
})
check('renderTemplate', () => {
  const out = renderTemplate('L={{L}} y={{y1}} FR={{FR}}', { L: 1500, y1: 0.04, FR: [10, 20, 30] })
  assert(out === 'L=1500 y=0.04 FR=10 20 30', `got: ${out}`)
})
check('isInside', () => {
  assert(isInside('/a/b', '/a/b/c') === true, 'nested path')
  assert(isInside('/a/b', '/a/c') === false, 'sibling path')
})
check('coerceParam', () => {
  assert(coerceParam('R', '50', { type: 'number' }) === 50, 'string→number')
  assert(JSON.stringify(coerceParam('FR', '10 20 30', { type: 'array', items: 'number' })) === '[10,20,30]', 'array')
})

const { loadCommands, searchCommands } = await import(join(root, 'lib/kb.js'))
const { validateJournal } = await import(join(root, 'lib/engine.js'))
const { DEFAULTS, normalizeConfig } = await import(join(root, 'lib/config.js'))
const config = { ...normalizeConfig({}), caseRoots: [root] }
if (!config.indexDir) {
  const localIndex = process.env.FLUENT_KB_INDEX || ''
  if (localIndex && existsSync(join(localIndex, 'commands.csv'))) config.indexDir = localIndex
}
if (!config.kbRoot) {
  const localKb = 'ScienceProjects/ANSYS FLUENT TUI/ANSYS_FLUENT_TUI_KNOWLEDGE'
  if (existsSync(localKb)) config.kbRoot = localKb
}

await checkAsync('loadCommands + search', async () => {
  if (!existsSync(join(config.indexDir, 'commands.csv'))) throw new Error('no commands.csv — skipping')
  const commands = await loadCommands(config.indexDir)
  assert(commands.length > 1000, `too few commands: ${commands.length}`)
  const hits = searchCommands(commands, 'kw-sst', { limit: 5 })
  assert(hits.length > 0, 'kw-sst search is empty')
  assert(hits.some((h) => h.path.includes('viscous')), 'no viscous in results')
})

const { compareVersions, parseTags, buildUpdateCommands, writeUpdateScript, installedState, applyUpdate } = await import(join(root, 'lib/update.js'))

check('update: version comparison', () => {
  assert(compareVersions('v0.5.0', 'v0.4.0') === 1, 'v0.5.0 > v0.4.0')
  assert(compareVersions('v0.4.0', 'v0.4.0') === 0, 'equal versions')
  assert(compareVersions('0.3.9', 'v0.4.0') === -1, '0.3.9 < 0.4.0')
})
check('update: git tag parsing', () => {
  const tags = parseTags('abc\trefs/tags/v0.3.0\ndef\trefs/tags/v0.5.0\nghi\trefs/tags/v0.5.0^{}\njkl\trefs/tags/not-semver')
  assert(tags[0] === 'v0.5.0', `first tag: ${tags[0]}`)
  assert(tags.length === 2, `unique tags: ${tags.length}`)
})
check('update: update commands', () => {
  const pinned = buildUpdateCommands({ version: 'v0.5.0', profile: 'web' })
  assert(pinned.spec.endsWith('#v0.5.0'), pinned.spec)
  assert(pinned.pluginManager[0].action === 'remove_bundle', 'missing remove_bundle')
  assert(pinned.pluginManager[1].target.includes('#v0.5.0'), 'no pin in install_bundle')
  assert(pinned.cli.some((line) => line.includes('dsh plugin --profile web add')), 'no CLI add')
  const latest = buildUpdateCommands({ version: 'main' })
  assert(latest.spec.endsWith('#main'), latest.spec)
})
await checkAsync('update: installed profile state', async () => {
  const dir = join(root, '.smoke-profile')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'smoke-profile', dependencies: { 'fluent-case-builder': 'github:AstDen/fluent-case-builder' },
    dsh: { profile: { bundles: ['fluent-case-builder'] } },
  }))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  try {
    const state = installedState('smoke')
    assert(state.spec.includes('github:'), `spec: ${state.spec}`)
    assert(state.bundled === true, 'bundle not recognized')
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})
await checkAsync('update: script and apply guard', async () => {
  const dir = join(root, '.smoke-update')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  try {
    const written = writeUpdateScript({ caseRoots: [dir] }, { version: 'v0.5.0', outputDir: dir })
    assert(existsSync(written.file), 'script not created')
    const text = await readFile(written.file, 'utf8')
    assert(text.includes('dsh plugin --profile') && text.includes('#v0.5.0'), 'script without commands/pin')
    let guarded = false
    try { applyUpdate({ allowSelfUpdate: false }, { version: 'v0.5.0', confirm: true }) } catch { guarded = true }
    assert(guarded, 'apply without allowSelfUpdate must fail')
    let noConfirm = false
    try { applyUpdate({ allowSelfUpdate: true }, { version: 'v0.5.0' }) } catch { noConfirm = true }
    assert(noConfirm, 'apply without confirm must fail')
    const dry = applyUpdate({ allowSelfUpdate: true }, { version: 'v0.5.0', confirm: true, dryRun: true })
    assert(dry.dryRun === true && dry.restartRequired === true, 'dryRun did not work')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
await checkAsync('bundled command index', async () => {
  const bundled = join(root, 'data', 'index', 'commands.csv')
  assert(existsSync(bundled), 'no bundled data/index/commands.csv')
  const commands = await loadCommands(join(root, 'data', 'index'))
  assert(commands.length > 1500, `too few commands: ${commands.length}`)
  const hits = searchCommands(commands, 'kw-sst', { limit: 3 })
  assert(hits.some((h) => h.path.includes('viscous')), 'kw-sst search does not work on the bundled index')
})
await checkAsync('recipe search', async () => {
  const { loadRecipes, searchRecipes } = await import(join(root, 'lib/compile.js'))
  const { recipes } = await loadRecipes(join(root, 'data'))
  const hits = searchRecipes(recipes, 'k-omega SST', { limit: 5 })
  const recipe = hits.find((h) => h.id === 'models.viscous.kw-sst')
  assert(recipe, `kw-sst recipe not found: ${hits.map((h) => h.id).join(',')}`)
  assert(recipe.status === 'verified', `status: ${recipe.status}`)
  assert(recipe.journal.some((line) => line.includes('kw-sst')), 'no journal line')
  assert(recipe.source, 'no source')
  const porous = searchRecipes(recipes, 'porous zone', { limit: 5 })
  assert(porous.some((h) => h.status === 'unverified'), 'no unverified recipe (porous zone)')
})
await checkAsync('validateJournal', async () => {
  if (!existsSync(join(config.indexDir, 'commands.csv'))) throw new Error('no commands.csv — skipping')
  const result = await validateJournal(config, [
    '/file/write-case-data "case" yes',
    '/solve/set/p-v-coupling 20',
    '/nonexistent/command x',
  ])
  assert(result.exact >= 1, 'no exact matches')
  assert(result.hiddenKnown.includes('/file/write-case-data "case" yes'), 'write-case-data not recognized as hidden')
  assert(result.unknown.length === 1, `expected 1 unknown command, got ${result.unknown.length}`)
})

const { applyRules, buildFacts, nextQuestions, completeness, draftSpec } = await import(join(root, 'lib/rules.js'))
check('applyRules', () => {
  const rules = [{
    id: 'turbulence.re', when: { re: { '>=': 5000 } },
    recommend: { 'physics.turbulence.model': 'kw-sst' }, status: 'derived', why: 'test',
  }]
  const facts = buildFacts({ physics: { reynolds: 12000 } })
  const applied = applyRules(rules, facts)
  assert(applied.recommendations['physics.turbulence.model'] === 'kw-sst', 'rule did not match')
})
check('nextQuestions/completeness', () => {
  const questions = [{ id: 'task', title: 'Task', questions: [
    { id: 'task.kind', text: 'Kind?', required: true, specPath: 'meta.taskKind' },
    { id: 'task.dim', text: 'Dimensions?', required: false },
  ] }]
  const next = nextQuestions(questions, { 'task.kind': 'gas-dynamics' })
  assert(next.next.length === 1 && next.next[0].id === 'task.dim', 'wrong next questions')
  const c = completeness(questions, { 'task.kind': 'x' })
  assert(c.requiredAnswered === 1 && c.answered === 1, `completeness: ${JSON.stringify(c)}`)
})

const { compileSpec, loadRecipes } = await import(join(root, 'lib/compile.js'))
await checkAsync('compileSpec (builtin recipes)', async () => {
  const { recipes } = await loadRecipes(config.dataDir)
  const spec = {
    meta: { name: 'smoke-case' },
    mesh: { files: ['/tmp/mesh.msh'] },
    physics: { energy: true, turbulence: { model: 'laminar' } },
    solver: { type: 'pressure-based', 'p-v-coupling': 'SIMPLE', iterations: 500 },
    initialization: { method: 'hybrid' },
    convergence: { residuals: [0.5, 0.001, 0.001, 0.001, 0.000005] },
    run: { stages: [{ name: 'main', iterate: 500 }] },
  }
  const compiled = compileSpec(spec, recipes)
  assert(compiled.journal.length > 0, 'journal is empty')
  assert(compiled.journal.some((l) => /\/file[\/ ]read-case/.test(l)), 'no mesh read')
  assert(compiled.journal.some((l) => l.includes('/file/write-case-data')), 'no save')
  assert(compiled.sections.some((s) => s.recipe === 'init.hybrid'), 'no init.hybrid step')
})


// ---------- reports and task analysis ----------
const { loadDiagnostics, detectFluentInfo, parseRunLog, findingsFromLog } = await import(join(root, 'lib/analyze.js'))
const { createReport, appendTaskNote } = await import(join(root, 'lib/report.js'))
const { validateJournal: validateNoIndex } = await import(join(root, 'lib/engine.js'))

await checkAsync('diagnostics: table loading', async () => {
  const diagnostics = await loadDiagnostics(config.dataDir)
  assert(diagnostics.patterns.length >= 8, `too few diagnostics: ${diagnostics.patterns.length}`)
  assert(diagnostics.patterns.every((p) => p.regex), 'some patterns have no regex')
})
check('detectFluentInfo: version and license from the log', () => {
  const info = detectFluentInfo({ fluentPath: '/opt/ansys_inc/v261/fluent/bin/fluent', licenseHost: '1055@localhost' },
    'Welcome to ANSYS Fluent 2026 R1\nBuild Id: 10262\nConnected License Server List:\t1055@localhost\nInfo: Your license enables 4-way parallel execution.')
  assert(info.version === '2026 R1', `version=${info.version}`)
  assert(info.build === '10262', `build=${info.build}`)
  assert(info.license.server.includes('1055@localhost'), 'license not recognized')
  assert(info.source === 'run-log', 'version source')
})
check('parseRunLog: stages and sizes', () => {
  const parsed = parseRunLog('Reading "mesh.msh"\n120000 cells, 3 zones ...\nPairing interface zones...\nWriting to x.cas.h5 ...\nTotal Transcript Time: 1 Minute 19 Second.')
  assert(parsed.cells === 120000 && parsed.zones === 3, 'cells/zones')
  assert(parsed.durationSec === 79, `duration=${parsed.durationSec}`)
  const save = parsed.stages.find((s) => s.stage === 'save-case-data')
  assert(save.status === 'seen', 'save stage not found')
})
await checkAsync('findingsFromLog: batch-confirm and fatal', async () => {
  const diagnostics = await loadDiagnostics(config.dataDir)
  const findings = findingsFromLog('Overwrite confirmations (/file/set-batch-options ...)\nare on -- will therefore ignore the following journal\nError: invalid command: yes', diagnostics)
  assert(findings.some((f) => f.code === 'invalid-command-batch-confirm'), 'batch-confirm not recognized')
  assert(findings.find((f) => f.code === 'invalid-command-batch-confirm').severity === 'info', 'batch-confirm severity')
  const fatal = findingsFromLog('Fatal error has happened to some of the processes!', diagnostics)
  assert(fatal.some((f) => f.code === 'crash'), 'crash not recognized')
})
await checkAsync('validateJournal: no index — skipped', async () => {
  const result = await validateNoIndex({ ...config, indexDir: '' }, ['/file/read-case "x"'])
  assert(result.verdict === 'skipped', `verdict=${result.verdict}`)
})
await checkAsync('createReport: JSON+MD, analysis, notes', async () => {
  const caseDir = join(root, '.smoke-case')
  await rm(caseDir, { recursive: true, force: true })
  await mkdir(join(caseDir, '.run'), { recursive: true })
  await mkdir(join(caseDir, 'analysis'), { recursive: true })
  await writeFile(join(caseDir, 'case.json'), JSON.stringify({
    schema: 'fluent-case-builder/case@1', profile: 'smoke', created: new Date().toISOString(), status: 'generated',
    params: { R: 1 }, expectedOutputs: [join(caseDir, 'out.cas.h5')],
  }, null, 2))
  await writeFile(join(caseDir, 'out.cas.h5'), 'fake')
  const logFile = join(caseDir, '.run', 'setup.log')
  await writeFile(logFile, [
    'Welcome to ANSYS Fluent 2026 R1', 'Build Id: 10262',
    'Connected License Server List:\t1055@localhost',
    'Reading "mesh_region_fluid.msh"', '120000 cells, 3 zones ...',
    'Pairing interface zones...', 'Writing to out.cas.h5 ...',
    'Overwrite confirmations (/file/set-batch-options ...)',
    'are on -- will therefore ignore the following journal', 'Error: invalid command: yes',
    'Total Transcript Time: 1 Minute 19 Second.',
  ].join('\n'))
  await writeFile(join(caseDir, '.run', 'setup.json'), JSON.stringify({
    name: 'setup', pid: 1, startedAt: new Date().toISOString(), caseDir, journalFile: 'setup_case.jou',
    logFile, command: 'fluent 3ddp -g -t2 -i setup_case.jou', status: 'running',
  }))
  const configReport = { ...config, caseRoots: [root], kbRoot: '', indexDir: '', reportDir: '', maxLogLines: 50 }
  await appendTaskNote(configReport, { caseDir, message: 'inlet BC was not generated', kind: 'question' })
  const result = await createReport(configReport, {
    caseDir, title: 'Smoke test', kind: 'gas-dynamics', description: 'report check',
    questions: ['how to support inlet BC?'],
  })
  assert(existsSync(result.jsonPath) && existsSync(result.mdPath), 'report files were not created')
  assert(result.report.schema === 'fluent-case-builder/report@1', 'schema')
  assert(result.report.environment.fluent.version === '2026 R1', 'version in the report')
  assert(result.report.analysis.verdict === 'configured', `verdict=${result.report.analysis.verdict}`)
  assert(result.report.analysis.findings.some((f) => f.code === 'invalid-command-batch-confirm'), 'no finding in the report')
  assert(result.report.analysis.gaps.some((g) => g.detail.includes('inlet BC')), 'note did not get into the gaps')
  assert(result.report.analysis.gaps.some((g) => g.detail.includes('inlet BC?')), 'question did not get into the gaps')
  const md = await readFile(result.mdPath, 'utf8')
  assert(md.includes('# Task report') && md.includes('Findings'), 'markdown is incomplete')
  await rm(caseDir, { recursive: true, force: true })
})

const dataProfiles = join(config.dataDir, 'profiles')
await checkAsync('profiles: plan example-channel', async () => {
  if (!existsSync(join(dataProfiles, 'example-channel', 'profile.json'))) throw new Error('no example-channel profile')
  const { planCase } = await import(join(root, 'lib/engine.js'))
  const plan = await planCase({
    ...config,
    caseRoots: [root],
    dataDir: config.dataDir,
    reportDir: '',
  }, 'example-channel', { meshFile: '/tmp/channel.msh', L: 1000, h: 10, iterations: 500 })
  assert(plan.caseDir.includes('channel_L-1000mm_h-10mm'), `caseDir: ${plan.caseDir}`)
  assert(plan.preset.name === 'quick', `preset: ${plan.preset.name}`)
  assert(plan.journalPreview && plan.journalPreview.includes('read-case'), 'no journal')
  assert(plan.computed.y_mid === '0.005000', `y_mid: ${plan.computed.y_mid}`)
  assert(plan.files.some((f) => f.name === 'setupJournal'), 'no setup_case.jou')
})

console.log(`\n✔ passed: ${ok.length}`)
for (const name of ok) console.log(`  ✓ ${name}`)
if (failures.length) {
  console.log(`\n✘ failed: ${failures.length}`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log('\nAll checks passed.')
}
