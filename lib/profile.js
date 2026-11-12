/**
 * Case profiles: discovery, parameter resolution, computed values,
 * preset selection, case directory name.
 * @module fluent-case-builder/lib/profile
 */
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { coerceParam, evalExpression, evalPython, readJson, renderTemplate } from './util.js'

/** All profiles from data/profiles/<id>/profile.json. */
export async function discoverProfiles(dataDir, extraDirs = []) {
  const roots = [join(dataDir, 'profiles'), ...extraDirs].filter((root) => existsSync(root))
  if (!roots.length) return []
  const profiles = []
  for (const root of roots) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(root, entry.name, 'profile.json')
    if (!existsSync(file)) continue
    try {
      const profile = await readJson(file, `profile ${entry.name}`)
      profiles.push({ ...profile, id: profile.id ?? entry.name, profilePath: file, dir: join(root, entry.name) })
    } catch (error) {
      profiles.push({ id: entry.name, title: entry.name, profilePath: file, dir: join(root, entry.name), error: error.message })
    }
  }
  }
  return profiles
}

/** Find a profile by id. */
export async function loadProfile(dataDir, id, extraDirs = []) {
  const candidates = [join(dataDir, 'profiles', id, 'profile.json'), ...extraDirs.map((dir) => join(dir, id, 'profile.json'))]
  const file = candidates.find((candidate) => existsSync(candidate))
  if (!file) {
    const available = (await discoverProfiles(dataDir, extraDirs)).map((p) => p.id)
    throw new Error(`profile "${id}" not found. Available: ${available.join(', ') || '(none)'}`)
  }
  const profile = await readJson(file, `profile ${id}`)
  return { ...profile, id: profile.id ?? id, profilePath: file, dir: join(dirname(file), '.') }
}

/** Substitute single {name} placeholders (for naming/caseFileBase). */
export function renderNaming(template, scope, source = 'naming') {
  const missing = new Set()
  const out = String(template).replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, name) => {
    const value = scope[name]
    if (value === undefined || value === null) { missing.add(name); return '' }
    return Array.isArray(value) ? value.join(' ') : String(value)
  })
  if (missing.size) throw new Error(`${source}: unresolved placeholders: ${[...missing].join(', ')}`)
  return out
}

/**
 * Resolve profile parameters and compute derived values.
 * @returns {{params, computed, preset, presetName, naming, caseFileBase, animation, caseDir, outputRoot, warnings}}
 */
export function resolveProfile(profile, rawParams, config = {}, { outputRoot: outputRootOverride } = {}) {
  const warnings = []
  const paramsSpec = profile.params ?? {}
  const unknown = Object.keys(rawParams ?? {}).filter((key) => !(key in paramsSpec))
  if (unknown.length) warnings.push(`unknown profile parameters ignored: ${unknown.join(', ')}`)

  const params = {}
  for (const [name, spec] of Object.entries(paramsSpec)) {
    const provided = rawParams && name in rawParams ? rawParams[name] : undefined
    if (provided === undefined || provided === null || provided === '') {
      if (spec.required && spec.default === undefined) throw new Error(`required parameter "${name}" is not set`)
      if (spec.default === undefined) { warnings.push(`parameter "${name}" is not set and has no default value`); continue }
      params[name] = Array.isArray(spec.default) ? [...spec.default] : spec.default
      continue
    }
    params[name] = coerceParam(name, provided, spec)
  }

  const scope = { ...params }
  const computed = {}
  for (const [name, expression] of Object.entries(profile.computed ?? {})) {
    try {
      const value = typeof expression === 'string' && expression.trim().startsWith('python:')
        ? evalPython(expression, scope)
        : evalExpression(expression, scope)
      computed[name] = value
      scope[name] = value
    } catch (error) {
      throw new Error(`profile ${profile.id}: failed to evaluate "${name}" = "${expression}": ${error.message}`)
    }
  }

  // Preset: the first whose condition is true (key order in profile.presets).
  let presetName = null
  let preset = {}
  for (const [name, values] of Object.entries(profile.presets ?? {})) {
    const when = profile.presetWhen?.[name]
    let active = true
    if (when !== undefined) {
      try { active = Boolean(evalExpression(when, scope)) } catch (error) {
        throw new Error(`profile ${profile.id}: preset condition "${name}" ("${when}"): ${error.message}`)
      }
    }
    if (active) { presetName = name; preset = values ?? {}; break }
  }
  if (!presetName && Object.keys(profile.presets ?? {}).length) warnings.push('no preset selected (check presetWhen)')

  Object.assign(scope, preset)

  const naming = renderNaming(profile.naming, scope, `profile ${profile.id}: naming`)
  const caseFileBase = profile.caseFileBase
    ? renderNaming(profile.caseFileBase, scope, `profile ${profile.id}: caseFileBase`)
    : naming
  const animation = renderNaming(profile.animation ?? 'animation_{name}', { ...scope, name: naming }, `profile ${profile.id}: animation`)

  scope.naming = naming
  scope.caseFileBase = caseFileBase
  scope.animation = animation
  scope.profileId = profile.id

  // Output root: profile.outputRoot (placeholders) → config.profileRoots[id] → config.caseRoots[0]
  const solutionsRoot = config.profileRoots?.[profile.id]
  let outputRoot
  if (outputRootOverride) {
    outputRoot = resolve(outputRootOverride)
  } else if (profile.outputRoot) {
    try {
      outputRoot = renderTemplate(profile.outputRoot, solutionsRoot ? { ...scope, solutionsRoot } : scope, `profile ${profile.id}: outputRoot`)
    } catch (error) {
      throw new Error(`${error.message}\nHint: set config.profileRoots["${profile.id}"] (or the env var) — the profile expects an output root; or pass the outputRoot parameter to the tool.`)
    }
  } else {
    outputRoot = solutionsRoot ?? config.caseRoots?.[0]
  }
  if (!outputRoot) throw new Error(`profile ${profile.id}: no output root set (profile.outputRoot / config.profileRoots / config.caseRoots)`)
  outputRoot = resolve(outputRoot)
  const caseDir = join(outputRoot, naming)

  return { profile, params, computed, preset, presetName, naming, caseFileBase, animation, outputRoot, caseDir, scope, warnings }
}

/** Profile parameters as a list for the interview/UI. */
export function describeParams(profile) {
  return Object.entries(profile.params ?? {}).map(([name, spec]) => ({
    name,
    type: spec.type ?? 'string',
    default: spec.default,
    required: Boolean(spec.required),
    unit: spec.unit ?? null,
    description: spec.description ?? '',
  }))
}
