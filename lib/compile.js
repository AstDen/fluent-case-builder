/**
 * Компилятор универсальной спецификации кейса в журнал TUI.
 * Собирает журнал ТОЛЬКО из рецептов; verified — в журнал, derived — в журнал
 * с предупреждением, unverified — в `unsupported` (без догадок).
 * @module fluent-case-builder/lib/compile
 */
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from './util.js'

/** Загрузить все рецепты из dataDir/recipes. */
export async function loadRecipes(dataDir) {
  const dir = join(dataDir, 'recipes')
  if (!existsSync(dir)) return { recipes: new Map(), warnings: [`нет каталога рецептов: ${dir}`] }
  const map = new Map()
  const warnings = []
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  for (const file of files) {
    try {
      const recipe = await readJson(join(dir, file), `рецепт ${file}`)
      if (!recipe.id) { warnings.push(`рецепт ${file} без id — пропущен`); continue }
      map.set(recipe.id, { ...recipe, file })
    } catch (error) {
      warnings.push(`рецепт ${file}: ${error.message}`)
    }
  }
  return { recipes: map, warnings }
}

const PV_COUPLING = { SIMPLE: 20, SIMPLEC: 21, PISO: 22, COUPLED: 24 }
const TURBULENCE_RECIPE = {
  laminar: 'models.viscous.laminar',
  'kw-sst': 'models.viscous.kw-sst',
  'ke-realizable': 'models.viscous.ke-realizable',
  'spalart-allmaras': 'models.viscous.spalart-allmaras',
}

/** Встроенные строки, подтверждённые журналами пользователя (на случай отсутствия рецепта). */
const BUILTIN = {
  'file.write-case-data': {
    id: 'file.write-case-data', title: 'Сохранение кейса и данных', status: 'verified', confidence: 'high',
    source: '13_FILE_MANAGEMENT/file_management.md:103-145; QA_LOG Q-015',
    journal: ['/file/write-case-data "{{name}}" yes'],
    params: [{ name: 'name', type: 'string', required: true }],
    notes: 'скрытая команда: нет в меню и справке, но работает',
  },
}

/** Развернуть рецепт в строки журнала. */
function expand(recipe, params) {
  const values = {}
  const missing = []
  for (const spec of recipe.params ?? []) {
    const value = params?.[spec.name] ?? spec.default
    if (value === undefined || value === null || value === '') {
      if (spec.required) missing.push(spec.name)
      continue
    }
    values[spec.name] = value
  }
  if (missing.length) return { lines: [], missing }
  const lines = (recipe.journal ?? []).map((line) =>
    String(line).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, name) =>
      Array.isArray(values[name]) ? values[name].join(' ') : String(values[name] ?? '')))
  return { lines, missing: [] }
}

/**
 * Скомпилировать spec в журнал.
 * @returns {{journal: string[], sections: Array, derived: Array, warnings: string[], unsupported: Array}}
 */
export function compileSpec(spec, recipeMap) {
  const journal = []
  const sections = []
  const warnings = [...(spec.provenance?.warnings ?? [])]
  const unsupported = []
  const derived = []

  const get = (ids) => {
    for (const id of (Array.isArray(ids) ? ids : [ids])) {
      const recipe = recipeMap.get(id) ?? BUILTIN[id]
      if (recipe) return recipe
    }
    return null
  }
  const add = (section, ids, params = {}, { optional = false } = {}) => {
    const recipe = get(ids)
    const id = Array.isArray(ids) ? ids[0] : ids
    if (!recipe) {
      const message = `${section}: нет рецепта «${id}» — шаг пропущен (требует реализации/проверки)`
      if (optional) warnings.push(message); else unsupported.push({ section, id, reason: 'no-recipe' })
      return false
    }
    if (recipe.status === 'unverified') {
      warnings.push(`${section}: «${recipe.title ?? recipe.id}» не проверено — в журнал не включено (${recipe.source ?? 'нет источника'})`)
      unsupported.push({ section, id: recipe.id, reason: 'status:unverified', source: recipe.source ?? null })
      return false
    }
    const { lines, missing } = expand(recipe, params)
    if (missing.length) {
      unsupported.push({ section, id: recipe.id, reason: `missing-params:${missing.join(',')}` })
      warnings.push(`${section}: не заданы параметры для «${recipe.id}»: ${missing.join(', ')}`)
      return false
    }
    if (!lines.length) {
      unsupported.push({ section, id: recipe.id, reason: 'empty-journal' })
      warnings.push(`${section}: рецепт «${recipe.id}» не содержит проверенных строк`)
      return false
    }
    if (recipe.status === 'derived') {
      warnings.push(`${section}: «${recipe.title ?? recipe.id}» выведено из справки/журналов (${recipe.source ?? 'нет источника'}) — проверьте в живой сессии`)
      derived.push({ section, id: recipe.id, source: recipe.source ?? null })
    }
    const joined = lines.join(' ')
    if (!(recipe.params?.length) && / inlet /.test(joined) && params.zone && params.zone !== 'inlet') {
      warnings.push(`${section}: «${recipe.id}» содержит позиционную цепочку с зашитой зоной inlet — для зоны «${params.zone}» требуется живая проверка`)
    }
    journal.push(...lines)
    sections.push({ section, recipe: recipe.id, status: recipe.status, lines })
    return true
  }

  const physics = spec.physics ?? {}
  const mesh = spec.mesh ?? {}
  const solver = spec.solver ?? {}
  const convergence = spec.convergence ?? {}
  const outputs = spec.outputs ?? {}
  const run = spec.run ?? {}

  // ---- сетка ----
  const meshFile = mesh.casePath ?? mesh.files?.[0]
  if (meshFile) add('mesh', ['file.read-case', 'mesh.read-case'], { file: meshFile, caseFile: meshFile })
  for (const extra of mesh.appendMesh ?? []) add('mesh', ['mesh.append-mesh'], { file: extra, meshFile: extra }, { optional: true })
  if (mesh.check) add('mesh', ['mesh.check'], {}, { optional: true })
  if (mesh.scale) {
    if (!add('mesh', ['mesh.scale'], {}, { optional: true })) {
      unsupported.push({ section: 'mesh', id: 'mesh.scale', reason: 'unverified', source: '01_MESH/deep_dive.md (аргументы /mesh/scale не подтверждены)' })
    }
  }
  for (const rename of mesh.renames ?? []) add('mesh', ['boundary.zone-name'], { from: rename.from, to: rename.to, oldName: rename.from, newName: rename.to }, { optional: true })
  for (const zone of mesh.zoneTypes ?? []) add('mesh', ['boundary.zone-type'], { zone: zone.zone, type: zone.type }, { optional: true })
  if (mesh.interfaces === 'auto') add('mesh', ['mesh-interfaces.auto-create'], {}, { optional: true })
  if (!meshFile) warnings.push('mesh: не задан ни файл сетки, ни кейс — журнал не содержит чтения сетки')

  // ---- модели ----
  if (physics.energy) {
    const options = physics.energyOptions ?? {}
    const changed = Object.entries(options).filter(([key, value]) => {
      const expected = { viscousWork: 'no', pressureWork: 'no', kineticEnergy: 'no', diffusionAtInlets: 'yes' }
      return key in expected && String(value) !== expected[key]
    })
    add('models', ['models.energy'], {})
    if (changed.length) {
      warnings.push(`models.energy: проверенный рецепт использует фиксированную цепочку (yes no no no yes); запрошены нестандартные ответы (${changed.map(([k, v]) => `${k}=${v}`).join(', ')}) — нужен отдельный проверенный рецепт для сжимаемых задач`)
      unsupported.push({ section: 'models', id: 'models.energy', reason: 'non-default-options', options: Object.fromEntries(changed) })
    }
  }
  const turbulence = physics.turbulence?.model
  if (turbulence) {
    const recipeId = TURBULENCE_RECIPE[turbulence]
    if (recipeId) add('models', [recipeId])
    else unsupported.push({ section: 'models', id: `models.viscous.${turbulence}`, reason: 'нет проверенного рецепта для этой модели турбулентности' })
  }
  if (physics.species?.enabled) {
    add('models', ['models.species-transport'], { mixture: physics.species.mixture ?? '', mixtureMaterial: physics.species.mixture ?? '' }, { optional: true })
    if (physics.species.reactions) add('models', ['models.species.reactions'], {}, { optional: true })
  }
  if (physics.radiation?.enabled) add('models', ['models.radiation.do', 'models.radiation.discrete-ordinates'], {
    thetaDiv: physics.radiation.thetaDiv ?? 2, phiDiv: physics.radiation.phiDiv ?? 2,
    thetaPixels: physics.radiation.thetaPixels ?? 1, phiPixels: physics.radiation.phiPixels ?? 1,
  }, { optional: true })
  if (physics.multiphase?.enabled) add('models', ['models.multiphase', 'models.multiphase.model'], { model: physics.multiphase.model ?? 'vof' }, { optional: true })
  if (physics.transient) add('models', ['models.transient.unsteady-2nd-order'], {}, { optional: true })
  if (physics.udf?.enabled) {
    add('models', ['udf.user-defined-memory'], { count: physics.udf.userMemory ?? 1 }, { optional: true })
    const udfFiles = (physics.udf.files ?? []).map((f) => `"${f}"`).join(' ')
    add('models', ['udf.compile-load-hook'], {
      library: physics.udf.library ?? 'libudf', files: udfFiles, file: udfFiles,
    }, { optional: true })
    if (physics.udf.function) add('models', ['udf.function-hook'], {
      hook: physics.udf.hook ?? 'initialization', function: physics.udf.function, library: physics.udf.library ?? 'libudf',
    }, { optional: true })
  }

  // ---- материалы ----
  for (const material of spec.materials ?? []) {
    if (material.density === 'ideal-gas') {
      if (material.type === 'mixture') add('materials', ['materials.ideal-gas.mixture'], { name: material.name ?? 'mixture-template' }, { optional: true })
      else add('materials', ['materials.ideal-gas.fluid'], { name: material.name ?? 'air' }, { optional: true })
    } else if (material.action === 'change' || material.density) {
      add('materials', ['materials.change-create'], { name: material.name ?? 'air', densityMethod: material.density ?? 'ideal-gas' }, { optional: true })
    }
  }

  // ---- ГУ ----
  for (const zone of spec.boundary?.zones ?? []) {
    const role = zone.role ?? zone.type
    if (role === 'inlet' || zone.type === 'mass-flow-inlet') {
      add('boundary', ['boundary.mass-flow-inlet.chain'], { zone: zone.zone, ...(zone.values ?? {}) }, { optional: true })
    } else if (role === 'outlet') {
      add('boundary', ['boundary.pressure-outlet.chain'], { zone: zone.zone }, { optional: true })
    } else if (role === 'wall' || zone.type === 'wall') {
      add('boundary', ['boundary.wall.chain', 'boundary.wall.thermal'], {
        zone: zone.zone,
        temperature: zone.values?.temperature ?? 300,
        emissivityExpr: zone.values?.emissivityExpr ?? 'External_Emissivity',
      }, { optional: true })
    } else {
      unsupported.push({ section: 'boundary', id: `boundary.${zone.type ?? role}`, reason: 'no-recipe' })
    }
    if (zone.type) add('boundary', ['boundary.zone-type'], { zone: zone.zone, type: zone.type }, { optional: true })
  }
  if (spec.boundary?.porousFormulation) add('boundary', ['boundary.physical-velocity-porous-formulation'], {}, { optional: true })

  // ---- решатель ----
  const solverType = solver.type ?? 'pressure-based'
  add('solver', [`models.solver.${solverType}`], {}, { optional: true })
  if (solver['p-v-coupling']) {
    const code = PV_COUPLING[String(solver['p-v-coupling']).toUpperCase()] ?? solver['p-v-coupling']
    add('solver', ['solver.pv-coupling'], { code }, { optional: true })
  }
  if (solver.iterations) add('solver', ['solve.number-of-iterations'], { n: solver.iterations, iterations: solver.iterations }, { optional: true })
  add('solver', ['solve.reporting-interval'], { n: convergence.reportingInterval ?? 100, interval: convergence.reportingInterval ?? 100 }, { optional: true })
  if (convergence.limits) add('solver', ['solve.limits'], convergence.limits, { optional: true })

  // ---- инициализация ----
  const initMethod = spec.initialization?.method ?? 'hybrid'
  if (!add('initialization', [`init.${initMethod}`], {}, { optional: true })) {
    unsupported.push({ section: 'initialization', id: `init.${initMethod}`, reason: 'unverified', source: '09_INITIALIZATION/deep_dive.md' })
  }

  // ---- сходимость/отчёты ----
  if (convergence.residuals?.length) add('convergence', ['monitor.residual-criteria'], { values: convergence.residuals }, { optional: true })
  const reportDefs = []
  for (const report of convergence.reports ?? []) {
    const ok = add('reports', ['report.definitions'], {
      name: report.name, type: report.type ?? 'surface-areaavg', field: report.field ?? 'temperature', surfaces: report.surfaces ?? [],
    }, { optional: true })
    if (ok) reportDefs.push(report.name)
    if (report.stop) add('reports', ['report.conv-reports'], {
      name: report.name, type: report.type ?? 'surface-areaavg', field: report.field ?? 'temperature',
      surfaces: report.surfaces ?? [], stop: report.stop,
    }, { optional: true })
  }
  add('reports', ['solve.convergence-frequency'], { n: convergence.stopping?.frequency ?? 100, frequency: convergence.stopping?.frequency ?? 100 }, { optional: true })
  if (outputs.reportFile) {
    add('reports', ['report.files'], {
      name: 'all_data_file', file: outputs.reportFile, reportDefs, frequency: outputs.reportFrequency ?? 50,
    }, { optional: true })
  }
  if (outputs.reportPlots) {
    add('reports', ['report.plots'], { name: 'rp---all', reportDefs, frequency: outputs.reportFrequency ?? 50 }, { optional: true })
  }

  // ---- выходы ----
  for (const exportSpec of outputs.exports ?? []) {
    add('outputs', ['file.export-ascii'], {
      file: exportSpec.file, surfaces: exportSpec.surfaces ?? [], fields: exportSpec.fields ?? [],
    }, { optional: true })
  }
  add('outputs', ['file.write-case-data'], { name: spec.meta?.name ?? 'case' })

  // ---- расчёт ----
  for (const stage of run.stages ?? []) {
    add('run', ['solver.iterate', 'solve.iterate'], { n: stage.iterate ?? solver.iterations ?? 1000, iterations: stage.iterate ?? solver.iterations ?? 1000 }, { optional: true })
  }

  return { journal, sections, derived, warnings: [...new Set(warnings)], unsupported }
}

/** Поиск по проверенным рецептам: «как включить/сделать X» → journal-строка + статус + источник. */
export function searchRecipes(recipes, query, { limit = 10, status } = {}) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return []
  const tokens = q.split(/[\s/._-]+/).filter(Boolean)
  const hits = []
  for (const recipe of recipes.values?.() ?? []) {
    if (status && recipe.status !== status) continue
    const journal = (recipe.journal ?? []).join(' ')
    const hay = [recipe.id, recipe.title, recipe.category, recipe.notes, recipe.interactive, journal]
      .filter(Boolean).join(' ').toLowerCase()
    let score = 0
    if (String(recipe.id ?? '').toLowerCase().includes(q)) score += 50
    if (String(recipe.title ?? '').toLowerCase().includes(q)) score += 30
    if (journal.toLowerCase().includes(q)) score += 20
    for (const token of tokens) if (hay.includes(token)) score += 3
    if (!score) continue
    hits.push({ recipe, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ recipe, score }) => ({
    kind: 'recipe',
    id: recipe.id,
    title: recipe.title,
    category: recipe.category,
    status: recipe.status,
    confidence: recipe.confidence ?? null,
    journal: recipe.journal ?? [],
    params: recipe.params ?? [],
    interactive: recipe.interactive ?? null,
    notes: recipe.notes ?? null,
    source: recipe.source ?? null,
    score,
  }))
}
