/** Plugin version (single source of truth: package.json). */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let version = '0.0.0'
try {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? version
} catch { /* version unknown — not critical */ }

export const PKG_VERSION = version
