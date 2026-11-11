/** Версия плагина (единственный источник — package.json). */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let version = '0.0.0'
try {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? version
} catch { /* версия неизвестна — не критично */ }

export const PKG_VERSION = version
