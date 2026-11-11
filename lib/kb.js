/**
 * Доступ к базе знаний Fluent TUI: разбор commands.csv, поиск по командам,
 * чтение документов KB.
 * @module fluent-case-builder/lib/kb
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isInside } from './util.js'

/** Разбор CSV с кавычками (RFC 4180, без вложенных переводов строк). */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (ch === '\r') continue
    field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
}

let cache
/** Загрузить индекс команд из indexDir/commands.csv. */
export async function loadCommands(indexDir) {
  if (cache && cache.dir === indexDir) return cache.rows
  const file = join(indexDir, 'commands.csv')
  if (!existsSync(file)) throw new Error(`не найден индекс команд: ${file} (config.indexDir)`)
  const rows = parseCsv(await readFile(file, 'utf8'))
  const header = rows.shift().map((h) => h.trim())
  const idx = Object.fromEntries(header.map((name, i) => [name, i]))
  const commands = rows.map((cells) => ({
    path: cells[idx.path] ?? '',
    category: cells[idx.category] ?? '',
    kinds: cells[idx.kinds] ?? '',
    passes: cells[idx.passes] ?? '',
    question: cells[idx.question] ?? '',
    default: cells[idx.default] ?? '',
    blocked: cells[idx.blocked] ?? '',
    menuLike: cells[idx.menu_like] ?? '',
    help: cells[idx.help] ?? '',
    available: cells[idx.available] ?? '',
  }))
  cache = { dir: indexDir, rows: commands }
  return commands
}

/** Нормализовать журнальную команду в путь индекса. */
export function normalizeCommandPath(line) {
  const tokens = String(line).trim().split(/\s+/)
  const token = (tokens[0] ?? '').replace(/^["']|["']$/g, '')
  if (!token || !token.startsWith('/')) return ''
  return token.replace(/\?$/, '').replace(/\/+$/, '')
}

/** Кандидаты пути для журнальной строки: `/file read-case` и `/file/read-case`. */
export function commandCandidates(line) {
  const tokens = String(line).trim().split(/\s+/).filter(Boolean)
  const first = (tokens[0] ?? '').replace(/^["']|["']$/g, '')
  if (!first || !first.startsWith('/')) return []
  const candidates = [first]
  const second = tokens[1]
  if (second && /^[A-Za-z][A-Za-z0-9_?'-]*$/.test(second)) candidates.push(`${first.replace(/\/$/, '')}/${second.replace(/\?$/, '')}`)
  return candidates
}

/** Команды, подтверждённые документацией (работают, хотя отсутствуют в меню/индексе). */
export const HIDDEN_COMMANDS = [
  '/file/write-case-data',
  '/solve/monitors/residual',
  '/define/user-defined/function-hooks',
]

/** Синтаксис, подтверждённый только журналами 2025 R1 (для 2026 R1 не проверен). */
export const JOURNAL_2025_COMMANDS = [
  '/solve/set/under-relaxation',
  '/solve/initialize/fmg-initialization',
  '/define/boundary-conditions/physical-velocity-porous-formulation',
  '/define/boundary-conditions/zone-name',
  '/define/boundary-conditions/zone-type',
  '/define/mesh-interfaces/auto-create',
]

/** Найти команду в индексе: точно, с ?, как меню-контейнер, скрытую или 2025-only. */
export function findCommand(commands, line) {
  const candidates = commandCandidates(line)
  if (!candidates.length) return { path: '', match: null, reason: 'not-tui-command' }
  const byPath = new Map(commands.map((c) => [c.path, c]))
  // 1) точные совпадения по всем кандидатам и вариантам (?-суффикс)
  for (const candidate of candidates) {
    for (const variant of [candidate, `${candidate}?`, candidate.replace(/\?$/, '')]) {
      const match = byPath.get(variant)
      if (match) return { path: candidate, match, reason: 'exact' }
    }
  }
  // 2) меню-контейнеры: команда под известным подменю
  for (const candidate of candidates) {
    if (commands.some((c) => c.path.startsWith(`${candidate}/`))) {
      return { path: candidate, match: null, reason: 'container' }
    }
    // 3) динамические подменю: известен родитель (add/… появляются в рантайме)
    const parts = candidate.split('/').filter(Boolean)
    for (let i = parts.length - 1; i > 0; i--) {
      if (byPath.has('/' + parts.slice(0, i).join('/'))) {
        return { path: candidate, match: null, reason: 'container' }
      }
    }
  }
  const rule = (list) => list.find((h) => candidates.some((c) => c === h || c.startsWith(`${h}/`)))
  const hidden = rule(HIDDEN_COMMANDS)
  if (hidden) return { path: hidden, match: null, reason: 'hidden-known' }
  const legacy = rule(JOURNAL_2025_COMMANDS)
  if (legacy) return { path: legacy, match: null, reason: 'journal-2025' }
  return { path: candidates[candidates.length - 1], match: null, reason: 'unknown' }
}

/** Ранжированный поиск по индексу команд и help. */
export function searchCommands(commands, query, { limit = 10, category } = {}) {
  const q = String(query).toLowerCase().replace(/^\//, '').trim()
  if (!q) return []
  const tokens = q.split(/[\s/._-]+/).filter(Boolean)
  const scored = []
  for (const row of commands) {
    if (category && !row.category.toLowerCase().includes(category.toLowerCase())) continue
    const hayPath = row.path.toLowerCase()
    const hay = `${row.path} ${row.question} ${row.help}`.toLowerCase()
    let score = 0
    if (hayPath === q || hayPath === '/' + q) score += 100
    if (hayPath.endsWith('/' + q)) score += 40
    if (hayPath.includes(q)) score += 20
    for (const token of tokens) {
      if (hayPath.includes(token)) score += 6
      if (hay.includes(token)) score += 2
    }
    if (score > 0) scored.push({ row, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ row, score }) => ({
    path: row.path,
    category: row.category,
    kind: row.kinds,
    question: row.question,
    default: row.default,
    blocked: row.blocked === 'B',
    available: row.available,
    help: row.help,
    score,
  }))
}

/** Прочитать документ KB по относительному пути (защита от выхода за kbRoot). */
export async function readKbFile(kbRoot, relativePath, { offset = 1, limit = 400 } = {}) {
  const target = join(kbRoot, relativePath)
  if (!isInside(kbRoot, target)) throw new Error(`путь выходит за пределы KB: ${relativePath}`)
  if (!existsSync(target)) throw new Error(`документ не найден в KB: ${relativePath}`)
  const text = await readFile(target, 'utf8')
  const lines = text.split(/\r?\n/)
  const start = Math.max(0, offset - 1)
  return {
    path: relativePath,
    totalLines: lines.length,
    content: lines.slice(start, start + limit).join('\n'),
  }
}
