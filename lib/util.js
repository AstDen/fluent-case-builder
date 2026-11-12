/**
 * Utilities: JSON reading, safe paths, profile expression evaluation,
 * {{name}} placeholder substitution.
 * @module fluent-case-builder/lib/util
 */
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Read a JSON file with a clear error message. */
export async function readJson(file, what = file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`failed to read ${what}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in ${what}: ${error.message}`)
  }
}

/** Whether target is a path inside root (including root itself). */
export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Ensure the path lies under one of the allowed roots; otherwise throw. */
export function assertWritable(roots, target, what = 'path') {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(`no allowed write roots configured (config.caseRoots)`)
  }
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error(`${what} is outside the allowed roots: ${target}\nallowed: ${roots.join(', ')}`)
  }
  return resolve(target)
}

/** Substitute {{name}} in a string. An unknown placeholder throws with a list. */
export function renderTemplate(text, scope, source = 'template') {
  const missing = new Set()
  const out = text.replace(/\{\{\s*([A-Za-z0-9_.$-]+)\s*\}\}/g, (_, name) => {
    const value = lookup(scope, name)
    if (value === undefined || value === null) { missing.add(name); return '' }
    return formatValue(value)
  })
  if (missing.size) {
    throw new Error(`${source}: unresolved placeholders: ${[...missing].join(', ')}`)
  }
  return out
}

/** Value by name; supports nested paths a.b.c. */
export function lookup(scope, name) {
  if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return scope[name]
  let cur = scope
  for (const part of String(name).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined
    cur = cur[part]
  }
  return cur
}

/** String representation of a value for text substitution. */
export function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue).join(' ')
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-numeric value: ${value}`)
    // 9 decimal places are enough for coordinates, but strip trailing zeros
    return String(Number(value.toFixed(12)))
  }
  return String(value)
}

const FUNCTIONS = {
  abs: Math.abs, sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log,
  log10: Math.log10, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sign: Math.sign, trunc: Math.trunc,
}
const CONSTANTS = { pi: Math.PI, e: Math.E, true: true, false: false }

/**
 * Evaluate an arithmetic/logical profile expression without eval.
 * Supports: numbers, strings, identifiers (scope/nested paths), + - * / % **,
 * comparisons, && || !, parentheses, whitelisted functions.
 * @returns {number|string|boolean}
 */
export function evalExpression(expression, scope = {}) {
  const tokens = tokenize(String(expression))
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const expect = (kind, value) => {
    const token = next()
    if (!token || token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind} in expression "${expression}" (position ${pos})`)
    }
    return token
  }

  function parseOr() {
    let left = parseAnd()
    while (peek() && peek().kind === 'op' && peek().value === '||') { next(); const right = parseAnd(); left = Boolean(left) || Boolean(right) }
    return left
  }
  function parseAnd() {
    let left = parseCompare()
    while (peek() && peek().kind === 'op' && peek().value === '&&') { next(); const right = parseCompare(); left = Boolean(left) && Boolean(right) }
    return left
  }
  function parseCompare() {
    let left = parseAdd()
    while (peek() && peek().kind === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(peek().value)) {
      const op = next().value
      const right = parseAdd()
      switch (op) {
        case '<': left = left < right; break
        case '<=': left = left <= right; break
        case '>': left = left > right; break
        case '>=': left = left >= right; break
        case '==': left = left === right; break
        case '!=': left = left !== right; break
      }
    }
    return left
  }
  function parseAdd() {
    let left = parseMul()
    while (peek() && peek().kind === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value
      const right = parseMul()
      left = op === '+' ? add(left, right) : sub(left, right)
    }
    return left
  }
  function parseMul() {
    let left = parseUnary()
    while (peek() && peek().kind === 'op' && ['*', '/', '%'].includes(peek().value)) {
      const op = next().value
      const right = parseUnary()
      left = op === '*' ? left * right : op === '/' ? left / right : left % right
    }
    return left
  }
  function parseUnary() {
    if (peek() && peek().kind === 'op' && peek().value === '!') { next(); return !parseUnary() }
    if (peek() && peek().kind === 'op' && peek().value === '-') { next(); return -parseUnary() }
    if (peek() && peek().kind === 'op' && peek().value === '+') { next(); return parseUnary() }
    return parsePow()
  }
  function parsePow() {
    const base = parsePrimary()
    if (peek() && peek().kind === 'op' && peek().value === '**') { next(); return Math.pow(base, parseUnary()) }
    return base
  }
  function parsePrimary() {
    const token = next()
    if (!token) throw new Error(`unexpected end of expression "${expression}"`)
    if (token.kind === 'number' || token.kind === 'string') return token.value
    if (token.kind === 'ident') {
      if (peek() && peek().kind === 'op' && peek().value === '(') {
        next()
        const args = []
        if (!(peek() && peek().kind === 'op' && peek().value === ')')) {
          args.push(parseOr())
          while (peek() && peek().kind === 'op' && peek().value === ',') { next(); args.push(parseOr()) }
        }
        expect('op', ')')
        const fn = FUNCTIONS[token.value]
        if (!fn) throw new Error(`unknown function "${token.value}" in "${expression}"`)
        return fn(...args)
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, token.value)) return CONSTANTS[token.value]
      let name = token.value
      while (peek() && peek().kind === 'op' && peek().value === '.') {
        next()
        const part = next()
        if (!part || part.kind !== 'ident') throw new Error(`expected a property name in "${expression}"`)
        name += '.' + part.value
      }
      const value = lookup(scope, name)
      if (value === undefined) throw new Error(`unknown name "${name}" in "${expression}"`)
      return value
    }
    if (token.kind === 'op' && token.value === '(') { const value = parseOr(); expect('op', ')'); return value }
    throw new Error(`unexpected token "${token.value}" in "${expression}"`)
  }

  const result = parseOr()
  if (pos !== tokens.length) throw new Error(`extra tokens in expression "${expression}"`)
  return result
}

function add(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  return a + b
}
function sub(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.filter((x) => !b.includes(x))
  return a - b
}

function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) { i++; continue }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const match = /^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/.exec(text.slice(i))
      tokens.push({ kind: 'number', value: Number(match[0]) })
      i += match[0].length
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(text.slice(i))
      tokens.push({ kind: 'ident', value: match[0] })
      i += match[0].length
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      let value = ''
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\' && j + 1 < text.length) { value += text[j + 1]; j += 2; continue }
        value += text[j]; j++
      }
      if (j >= text.length) throw new Error(`unterminated string in expression "${text}"`)
      tokens.push({ kind: 'string', value })
      i = j + 1
      continue
    }
    const two = text.slice(i, i + 2)
    if (['<=', '>=', '==', '!=', '&&', '||', '**'].includes(two)) { tokens.push({ kind: 'op', value: two }); i += 2; continue }
    if ('+-*/%<>!(),.'.includes(ch)) { tokens.push({ kind: 'op', value: ch }); i++; continue }
    throw new Error(`invalid character "${ch}" in expression "${text}"`)
  }
  return tokens
}

/**
 * Evaluate a profile python expression (`python: ...`) with parameters in globals().
 * Profile data is local and trusted; no shell is used.
 */
export function evalPython(expression, scope = {}) {
  const code = [
    'import json,sys',
    'p=json.loads(sys.stdin.read())',
    'globals().update(p)',
    'print(json.dumps(eval(' + JSON.stringify(String(expression).replace(/^python:\s*/, '')) + ')))',
  ].join('\n')
  const result = spawnSync('python3', ['-c', code], { input: JSON.stringify(scope), encoding: 'utf8', timeout: 30000 })
  if (result.error) throw new Error(`python3: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`python: ${(result.stderr || '').trim().split('\n').slice(-1)[0] || 'error'}`)
  const out = (result.stdout || '').trim()
  try { return JSON.parse(out) } catch { return out }
}

/** Coerce a parameter value to its declared type. */
export function coerceParam(name, value, spec) {
  const type = spec?.type ?? 'string'
  if (type === 'number' || type === 'integer') {
    const num = typeof value === 'string' ? Number(value.replace(',', '.')) : value
    if (typeof num !== 'number' || !Number.isFinite(num)) throw new Error(`parameter ${name}: a number is expected, got "${value}"`)
    if (type === 'integer' && !Number.isInteger(num)) throw new Error(`parameter ${name}: an integer is expected, got ${num}`)
    return num
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (['true', 'yes', '1'].includes(String(value).toLowerCase())) return true
    if (['false', 'no', '0'].includes(String(value).toLowerCase())) return false
    throw new Error(`parameter ${name}: a boolean is expected`)
  }
  if (type === 'array') {
    const items = Array.isArray(value) ? value : String(value).split(/[\s,;]+/).filter(Boolean)
    return items.map((item) => coerceParam(`${name}[]`, item, { type: spec?.items ?? 'string' }))
  }
  if (value === null || value === undefined) return null
  return String(value)
}

/** Format a date as YYYY-MM-DD. */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/** Ensure lossless JSON: undefined → null, NaN/Infinity → null. */
export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item === undefined) return null
    if (typeof item === 'number' && !Number.isFinite(item)) return null
    return item
  }))
}

/** Briefly: the first n lines of text. */
export function headLines(text, n = 40) {
  return String(text).split(/\r?\n/).slice(0, n).join('\n')
}

export { FUNCTIONS, sep }
