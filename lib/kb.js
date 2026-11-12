/**
 * Fluent TUI knowledge base access: parse commands.csv, search commands,
 * read knowledge-base documents.
 * @module fluent-case-builder/lib/kb
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isInside } from './util.js'

/** Parse CSV with quotes (RFC 4180, no embedded line breaks). */
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
/** Load the command index from indexDir/commands.csv. */
export async function loadCommands(indexDir) {
  if (cache && cache.dir === indexDir) return cache.rows
  const file = join(indexDir, 'commands.csv')
  if (!existsSync(file)) throw new Error(`command index not found: ${file} (config.indexDir)`)
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

/** Normalize a journal command to an index path. */
export function normalizeCommandPath(line) {
  const tokens = String(line).trim().split(/\s+/)
  const token = (tokens[0] ?? '').replace(/^["']|["']$/g, '')
  if (!token || !token.startsWith('/')) return ''
  return token.replace(/\?$/, '').replace(/\/+$/, '')
}

/** Path candidates for a journal line: `/file read-case` and `/file/read-case`. */
export function commandCandidates(line) {
  const tokens = String(line).trim().split(/\s+/).filter(Boolean)
  const first = (tokens[0] ?? '').replace(/^["']|["']$/g, '')
  if (!first || !first.startsWith('/')) return []
  const candidates = [first]
  const second = tokens[1]
  if (second && /^[A-Za-z][A-Za-z0-9_?'-]*$/.test(second)) candidates.push(`${first.replace(/\/$/, '')}/${second.replace(/\?$/, '')}`)
  return candidates
}

/** Commands confirmed by documentation (they work even though absent from the menu/index). */
export const HIDDEN_COMMANDS = [
  '/file/write-case-data',
  '/solve/monitors/residual',
  '/define/user-defined/function-hooks',
]

/** Syntax confirmed only by 2025 R1 journals (not verified for 2026 R1). */
export const JOURNAL_2025_COMMANDS = [
  '/solve/set/under-relaxation',
  '/solve/initialize/fmg-initialization',
  '/define/boundary-conditions/physical-velocity-porous-formulation',
  '/define/boundary-conditions/zone-name',
  '/define/boundary-conditions/zone-type',
  '/define/mesh-interfaces/auto-create',
]

/** Find a command in the index: exact, with ?, as a menu container, hidden, or 2025-only. */
export function findCommand(commands, line) {
  const candidates = commandCandidates(line)
  if (!candidates.length) return { path: '', match: null, reason: 'not-tui-command' }
  const byPath = new Map(commands.map((c) => [c.path, c]))
  // 1) exact matches across all candidates and variants (? suffix)
  for (const candidate of candidates) {
    for (const variant of [candidate, `${candidate}?`, candidate.replace(/\?$/, '')]) {
      const match = byPath.get(variant)
      if (match) return { path: candidate, match, reason: 'exact' }
    }
  }
  // 2) menu containers: the command lives under a known submenu
  for (const candidate of candidates) {
    if (commands.some((c) => c.path.startsWith(`${candidate}/`))) {
      return { path: candidate, match: null, reason: 'container' }
    }
    // 3) dynamic submenus: the parent is known (add/… appears at runtime)
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

/** Ranked search over the command index and help. */
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

/** Read a KB document by relative path (guards against escaping kbRoot). */
export async function readKbFile(kbRoot, relativePath, { offset = 1, limit = 400 } = {}) {
  const target = join(kbRoot, relativePath)
  if (!isInside(kbRoot, target)) throw new Error(`path escapes the KB root: ${relativePath}`)
  if (!existsSync(target)) throw new Error(`document not found in KB: ${relativePath}`)
  const text = await readFile(target, 'utf8')
  const lines = text.split(/\r?\n/)
  const start = Math.max(0, offset - 1)
  return {
    path: relativePath,
    totalLines: lines.length,
    content: lines.slice(start, start + limit).join('\n'),
  }
}
