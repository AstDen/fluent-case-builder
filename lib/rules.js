/**
 * Engineering rules and the interview: model recommendations based on the
 * task physics, and the questions the plugin asks the user.
 * @module fluent-case-builder/lib/rules
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { lookup, readJson } from './util.js'

/** Load rules and the question bank from dataDir. */
export async function loadKnowledge(dataDir) {
  const rulesFile = join(dataDir, 'rules', 'physics-rules.json')
  const questionsFile = join(dataDir, 'rules', 'questions.json')
  const rules = existsSync(rulesFile) ? await readJson(rulesFile, 'physics-rules.json') : { version: 0, rules: [] }
  const questions = existsSync(questionsFile) ? await readJson(questionsFile, 'questions.json') : { version: 0, sections: [] }
  return { rules: rules.rules ?? [], questions: questions.sections ?? [], warnings: [] }
}

/** Check one rule condition: a value from facts against the expectation. */
function matchCondition(value, expected) {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('in' in expected) return (expected.in ?? []).includes(value)
    if ('truthy' in expected) return Boolean(value) === Boolean(expected.truthy)
    if ('exists' in expected) return (value !== undefined && value !== null) === Boolean(expected.exists)
    if ('>=' in expected) return Number(value) >= Number(expected['>='])
    if ('>' in expected) return Number(value) > Number(expected['>'])
    if ('<=' in expected) return Number(value) <= Number(expected['<='])
    if ('<' in expected) return Number(value) < Number(expected['<'])
    if ('==' in expected) return value === expected['==']
    if ('!=' in expected) return value !== expected['!=']
    return false
  }
  if (Array.isArray(expected)) return expected.includes(value)
  if (typeof expected === 'boolean') return Boolean(value) === expected
  return value === expected
}

/** Apply rules to facts; return the matched rules and recommendations. */
export function applyRules(rules, facts) {
  const matched = []
  const recommendations = {}
  const warnings = []
  for (const rule of rules) {
    const conditions = Object.entries(rule.when ?? {})
    let active = true
    for (const [key, expected] of conditions) {
      let value = lookup(facts, key)
      if (value === undefined && key.includes('.')) value = lookup(facts, key.split('.').pop())
      if (!matchCondition(value, expected)) { active = false; break }
    }
    if (!active) continue
    matched.push(rule)
    for (const [path, value] of Object.entries(rule.recommend ?? {})) {
      if (path in recommendations && JSON.stringify(recommendations[path]) !== JSON.stringify(value)) {
        warnings.push(`rules "${recommendations[`__rule:${path}`]}" and "${rule.id}" give different values for ${path}; the last one (${rule.id}) wins`)
      }
      recommendations[path] = value
      recommendations[`__rule:${path}`] = rule.id
    }
  }
  for (const key of Object.keys(recommendations).filter((k) => k.startsWith('__rule:'))) delete recommendations[key]
  return { matched, recommendations, warnings }
}

/** Set a value at path a.b.c in an object. */
export function setPath(object, path, value) {
  const parts = String(path).split('.')
  let cur = object
  for (const part of parts.slice(0, -1)) {
    if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {}
    cur = cur[part]
  }
  cur[parts[parts.length - 1]] = value
  return object
}

/** Build "facts" from the spec and explicit answers (flat or nested). */
export function buildFacts(spec = {}, answers = {}) {
  const facts = { ...answers }
  const merge = (prefix, value) => {
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      facts[path] = child
      merge(path, child)
    }
  }
  merge('', spec)
  // convenience aliases: flat names on top of nested spec paths
  const alias = (flat, path) => {
    if (facts[flat] === undefined) { const value = lookup(facts, path); if (value !== undefined) facts[flat] = value }
  }
  for (const [flat, path] of [
    ['reynolds', 'physics.reynolds'], ['re', 'physics.reynolds'], ['mach', 'physics.mach'],
    ['energy', 'physics.energy'], ['compressible', 'physics.compressible'],
    ['turbulence', 'physics.turbulence.model'], ['axisymmetric', 'physics.axisymmetric'],
    ['temperature', 'physics.temperature.max'], ['radiation', 'physics.radiation.enabled'],
    ['multiphase', 'physics.multiphase.enabled'], ['particles', 'physics.particles.enabled'],
    ['transient', 'physics.transient'], ['udf', 'physics.udf.enabled'],
    ['combustion', 'physics.species.reactions'], ['species', 'physics.species.enabled'],
  ]) alias(flat, path)
  if (facts.re !== undefined && facts.reynolds === undefined) facts.reynolds = facts.re
  if (facts.reynolds !== undefined && facts.re === undefined) facts.re = facts.reynolds
  return facts
}

/** Next interview questions: optional ones, one per section. */
export function nextQuestions(questions, answers = {}) {
  const answered = new Set(Object.keys(answers))
  const pending = []
  for (const section of questions) {
    for (const question of section.questions ?? []) {
      if (answered.has(question.id) || answered.has(question.specPath)) continue
      pending.push({ ...question, section: section.id, sectionTitle: section.title })
    }
  }
  const required = pending.filter((q) => q.required)
  return {
    next: (required.length ? required : pending).slice(0, 5),
    pendingCount: pending.length,
    requiredCount: required.length,
  }
}

/** Completeness summary: which required questions are unanswered. */
export function completeness(questions, answers = {}) {
  const all = questions.flatMap((s) => (s.questions ?? []).map((q) => ({ ...q, section: s.id })))
  const answered = all.filter((q) => q.id in answers || q.specPath in answers)
  const requiredAll = all.filter((q) => q.required)
  const requiredAnswered = requiredAll.filter((q) => q.id in answers || q.specPath in answers)
  return {
    total: all.length,
    answered: answered.length,
    required: requiredAll.length,
    requiredAnswered: requiredAnswered.length,
    missingRequired: requiredAll.filter((q) => !(q.id in answers || q.specPath in answers)).map((q) => q.id),
    percent: all.length ? Math.round((answered.length / all.length) * 100) : 0,
  }
}

/** Build a draft spec from the answers plus rule recommendations. */
export function draftSpec(spec, answers, knowledge) {
  const merged = { ...spec }
  // question id → specPath from questions.json (otherwise the answer key is treated as a path)
  const questionPath = new Map()
  for (const section of knowledge.questions ?? []) {
    for (const question of section.questions ?? []) questionPath.set(question.id, question.specPath ?? question.id)
  }
  for (const [key, value] of Object.entries(answers)) {
    const path = questionPath.get(key) ?? key
    if (String(path).includes('.')) setPath(merged, path, value)
    else merged[path] = value
  }
  const facts = buildFacts(merged, answers)
  const applied = applyRules(knowledge.rules ?? [], facts)
  for (const [path, value] of Object.entries(applied.recommendations)) setPath(merged, path, value)
  return { spec: merged, facts, ...applied }
}
