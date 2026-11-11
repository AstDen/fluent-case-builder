/**
 * Инженерные правила и интервью: рекомендации моделей по физике задачи,
 * вопросы, которые плагин задаёт пользователю.
 * @module fluent-case-builder/lib/rules
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { lookup, readJson } from './util.js'

/** Загрузить правила и банк вопросов из dataDir. */
export async function loadKnowledge(dataDir) {
  const rulesFile = join(dataDir, 'rules', 'physics-rules.json')
  const questionsFile = join(dataDir, 'rules', 'questions.json')
  const rules = existsSync(rulesFile) ? await readJson(rulesFile, 'physics-rules.json') : { version: 0, rules: [] }
  const questions = existsSync(questionsFile) ? await readJson(questionsFile, 'questions.json') : { version: 0, sections: [] }
  return { rules: rules.rules ?? [], questions: questions.sections ?? [], warnings: [] }
}

/** Проверить одно условие правила: значение из facts против ожидания. */
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

/** Применить правила к facts; вернуть сработавшие правила и рекомендации. */
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
        warnings.push(`правила «${recommendations[`__rule:${path}`]}» и «${rule.id}» дают разные значения для ${path}; принято последнее (${rule.id})`)
      }
      recommendations[path] = value
      recommendations[`__rule:${path}`] = rule.id
    }
  }
  for (const key of Object.keys(recommendations).filter((k) => k.startsWith('__rule:'))) delete recommendations[key]
  return { matched, recommendations, warnings }
}

/** Записать значение по пути a.b.c в объект. */
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

/** Собрать "факты" из spec и явных ответов (плоских или вложенных). */
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
  // удобные синонимы: плоские имена поверх вложенных путей spec
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

/** Следующие вопросы интервью: необязательные — по одному из каждой секции. */
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

/** Сводка по полноте: какие обязательные вопросы не заданы. */
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

/** Собрать черновик spec из ответов + рекомендаций правил. */
export function draftSpec(spec, answers, knowledge) {
  const merged = { ...spec }
  // id вопроса → specPath из questions.json (иначе ключ ответа считается путём)
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
