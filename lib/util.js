/**
 * Утилиты: чтение JSON, безопасные пути, вычисление выражений профиля,
 * подстановка плейсхолдеров {{name}}.
 * @module fluent-case-builder/lib/util
 */
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Прочитать JSON-файл с понятной ошибкой. */
export async function readJson(file, what = file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`не удалось прочитать ${what}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`некорректный JSON в ${what}: ${error.message}`)
  }
}

/** Является ли target путём внутри root (включая сам root). */
export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Проверить, что путь лежит в одном из разрешённых корней; иначе — ошибка. */
export function assertWritable(roots, target, what = 'путь') {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(`не настроены разрешённые корни для записи (config.caseRoots)`)
  }
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error(`${what} вне разрешённых корней: ${target}\nразрешено: ${roots.join(', ')}`)
  }
  return resolve(target)
}

/** Заменить {{name}} в строке. unknown-placeholder → ошибка со списком. */
export function renderTemplate(text, scope, source = 'шаблон') {
  const missing = new Set()
  const out = text.replace(/\{\{\s*([A-Za-z0-9_.$-]+)\s*\}\}/g, (_, name) => {
    const value = lookup(scope, name)
    if (value === undefined || value === null) { missing.add(name); return '' }
    return formatValue(value)
  })
  if (missing.size) {
    throw new Error(`${source}: не подставлены плейсхолдеры: ${[...missing].join(', ')}`)
  }
  return out
}

/** Значение по имени; поддержка вложенных путей a.b.c. */
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

/** Строковое представление значения для подстановки в текст. */
export function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue).join(' ')
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`нечисловое значение: ${value}`)
    // 9 знаков после точки достаточно для координат, но убираем хвостовые нули
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
 * Вычислить арифметическое/логическое выражение профиля без eval.
 * Поддержка: числа, строки, идентификаторы (scope/вложенные пути), + - * / % **,
 * сравнения, && || !, скобки, функции из белого списка.
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
      throw new Error(`ожидалось ${value ?? kind} в выражении «${expression}» (позиция ${pos})`)
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
    if (!token) throw new Error(`неожиданный конец выражения «${expression}»`)
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
        if (!fn) throw new Error(`неизвестная функция «${token.value}» в «${expression}»`)
        return fn(...args)
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, token.value)) return CONSTANTS[token.value]
      let name = token.value
      while (peek() && peek().kind === 'op' && peek().value === '.') {
        next()
        const part = next()
        if (!part || part.kind !== 'ident') throw new Error(`ожидалось имя свойства в «${expression}»`)
        name += '.' + part.value
      }
      const value = lookup(scope, name)
      if (value === undefined) throw new Error(`неизвестное имя «${name}» в «${expression}»`)
      return value
    }
    if (token.kind === 'op' && token.value === '(') { const value = parseOr(); expect('op', ')'); return value }
    throw new Error(`неожиданный токен «${token.value}» в «${expression}»`)
  }

  const result = parseOr()
  if (pos !== tokens.length) throw new Error(`лишние токены в выражении «${expression}»`)
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
      if (j >= text.length) throw new Error(`незакрытая строка в выражении «${text}»`)
      tokens.push({ kind: 'string', value })
      i = j + 1
      continue
    }
    const two = text.slice(i, i + 2)
    if (['<=', '>=', '==', '!=', '&&', '||', '**'].includes(two)) { tokens.push({ kind: 'op', value: two }); i += 2; continue }
    if ('+-*/%<>!(),.'.includes(ch)) { tokens.push({ kind: 'op', value: ch }); i++; continue }
    throw new Error(`недопустимый символ «${ch}» в выражении «${text}»`)
  }
  return tokens
}

/**
 * Вычислить python-выражение профиля (`python: ...`) с параметрами в globals().
 * Данные профиля локальные и доверенные; shell не используется.
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
  if (result.status !== 0) throw new Error(`python: ${(result.stderr || '').trim().split('\n').slice(-1)[0] || 'ошибка'}`)
  const out = (result.stdout || '').trim()
  try { return JSON.parse(out) } catch { return out }
}

/** Нормализовать значение параметра под объявленный тип. */
export function coerceParam(name, value, spec) {
  const type = spec?.type ?? 'string'
  if (type === 'number' || type === 'integer') {
    const num = typeof value === 'string' ? Number(value.replace(',', '.')) : value
    if (typeof num !== 'number' || !Number.isFinite(num)) throw new Error(`параметр ${name}: ожидается число, получено «${value}»`)
    if (type === 'integer' && !Number.isInteger(num)) throw new Error(`параметр ${name}: ожидается целое, получено ${num}`)
    return num
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (['true', 'yes', '1'].includes(String(value).toLowerCase())) return true
    if (['false', 'no', '0'].includes(String(value).toLowerCase())) return false
    throw new Error(`параметр ${name}: ожидается boolean`)
  }
  if (type === 'array') {
    const items = Array.isArray(value) ? value : String(value).split(/[\s,;]+/).filter(Boolean)
    return items.map((item) => coerceParam(`${name}[]`, item, { type: spec?.items ?? 'string' }))
  }
  if (value === null || value === undefined) return null
  return String(value)
}

/** Отформатировать дату YYYY-MM-DD. */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/** Гарантировать lossless JSON: undefined → null, NaN/Infinity → null. */
export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item === undefined) return null
    if (typeof item === 'number' && !Number.isFinite(item)) return null
    return item
  }))
}

/** Кратко: первые n строк текста. */
export function headLines(text, n = 40) {
  return String(text).split(/\r?\n/).slice(0, n).join('\n')
}

export { FUNCTIONS, sep }
