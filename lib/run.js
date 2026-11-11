/**
 * Запуск Fluent и контроль выполнения: фоновый процесс, лог, PID-файл,
 * предзапусковый бэкап, разбор ошибок.
 * @module fluent-case-builder/lib/run
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { assertWritable, readJson } from './util.js'

const ERROR_PATTERNS = [
  /^Error:/m, /^Error Object:/m, /non-fatal Error: invalid command/i,
  /Fatal error/i, /An error or interrupt occurred while reading the journal file/i,
  /signal \d+/i,
]

/** Каталог служебных файлов запуска внутри кейса. */
const RUN_DIR = '.run'

/** Прочитать/создать запись о запуске. */
export async function runRecord(caseDir, name) {
  const file = join(caseDir, RUN_DIR, `${name}.json`)
  return existsSync(file) ? readJson(file, `запуск ${name}`) : null
}

/**
 * Запустить Fluent с журналом в фоне.
 * @param {object} options
 * @returns {Promise<{pid:number, logFile:string, recordFile:string, command:string}>}
 */
export async function startRun(config, {
  caseDir, journalFile, name = 'setup', dimension = '3ddp', threads = 1,
  mpi = 'intel', affinity = 'core', extraArgs = [],
}) {
  if (!config.allowRun) {
    throw new Error('запуск Fluent запрещён конфигом (allowRun:false). Включите allowRun и подтвердите запуск явно.')
  }
  assertWritable(config.caseRoots, caseDir, 'директория запуска')
  if (!existsSync(join(caseDir, journalFile))) throw new Error(`журнал не найден: ${join(caseDir, journalFile)}`)

  const runDir = join(caseDir, RUN_DIR)
  await mkdir(runDir, { recursive: true })
  const logFile = join(runDir, `${name}.log`)
  const recordFile = join(runDir, `${name}.json`)
  const startedAt = new Date().toISOString()

  // Предзапусковый бэкап важных файлов (журналы/скрипты/существующие результаты).
  const backup = await backupBeforeRun(config, caseDir, name)

  const args = [dimension, '-g', `-t${threads}`]
  if (mpi) args.push(`-mpi=${mpi}`)
  if (affinity) args.push(`-affinity=${affinity}`)
  args.push(...(extraArgs ?? []))
  args.push('-i', journalFile)

  const fd = await open(logFile, 'w')
  const child = spawn(config.fluentPath, args, {
    cwd: caseDir,
    env: {
      ...process.env,
      ANSYSLMD_LICENSE_FILE: config.licenseHost ?? process.env.ANSYSLMD_LICENSE_FILE ?? '1055@localhost',
    },
    detached: true,
    stdio: ['ignore', fd.fd, fd.fd],
  })
  child.unref()
  await fd.close()

  const record = {
    name, pid: child.pid, startedAt, caseDir, journalFile, logFile,
    command: [config.fluentPath, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '),
    dimension, threads, mpi, affinity, backup, status: 'running',
  }
  await writeFile(recordFile, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return { pid: child.pid, logFile, recordFile, command: record.command, backup }
}

/** Жив ли процесс. */
export function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Хвост лога. */
export async function tailLog(logFile, lines = 80) {
  if (!existsSync(logFile)) return ''
  const text = await readFile(logFile, 'utf8')
  return text.split(/\r?\n/).slice(-lines).join('\n')
}

/** Разобрать лог на ошибки и признаки завершения. */
export function analyzeLog(text) {
  const lines = text.split(/\r?\n/)
  const errors = lines.filter((line) => ERROR_PATTERNS.some((re) => re.test(line))).slice(0, 50)
  const invalid = lines.filter((line) => /invalid command/i.test(line)).slice(0, 50)
  const fatal = lines.some((line) => /Fatal error|signal \d+|Segmentation fault/i.test(line))
  // артефакт batch-подтверждений: `write-case-data "... " yes` пишет файл, но последний токен
  // отвергается после успешной записи — это не провал настройки
  const onlyOverwriteNoise = errors.length > 0
    && errors.every((line) => /invalid command:?\s*yes/i.test(line))
  const finished = /Exiting|CALCULATION_COMPLETE|Posting ANSYS|Auto-Transcript Stop/i.test(text)
  return { errors, invalidCommands: invalid, fatal, finished, onlyOverwriteNoise }
}

/** Статус запуска: процесс, лог, выходные файлы, ошибки. */
export async function runStatus(config, caseDir, name = 'setup', { lines = 60 } = {}) {
  const record = await runRecord(caseDir, name)
  if (!record) throw new Error(`нет записи о запуске «${name}» в ${caseDir}`)
  const alive = isAlive(record.pid)
  const log = await tailLog(record.logFile, lines)
  const analysis = analyzeLog(log)
  const manifest = existsSync(join(caseDir, 'case.json')) ? await readJson(join(caseDir, 'case.json'), 'case.json') : null
  const outputs = []
  for (const output of manifest?.expectedOutputs ?? []) outputs.push({ path: output, exists: existsSync(output) })
  const anyOutput = outputs.some((o) => o.exists)
  const status = alive
    ? 'running'
    : analysis.fatal
      ? 'failed'
      : anyOutput
        ? 'finished'
        : analysis.errors.length
          ? 'failed'
          : analysis.finished
            ? 'finished'
            : 'stopped-unknown'
  return {
    name,
    pid: record.pid,
    alive,
    startedAt: record.startedAt,
    command: record.command,
    logFile: record.logFile,
    status,
    warning: !analysis.fatal && anyOutput && analysis.errors.length
      ? 'настройка завершена и результаты записаны; в конце журнала есть безвредная ошибка batch-подтверждения (write-case-data ... yes)'
      : null,
    errors: analysis.errors,
    invalidCommands: analysis.invalidCommands,
    outputs,
    logTail: log,
  }
}

/** Остановить запуск (группа процессов). */
export async function stopRun(caseDir, name = 'setup') {
  const record = await runRecord(caseDir, name)
  if (!record) throw new Error(`нет записи о запуске «${name}»`)
  if (!isAlive(record.pid)) return { stopped: false, note: 'процесс уже завершён' }
  try { process.kill(-record.pid, 'SIGTERM') } catch { try { process.kill(record.pid, 'SIGTERM') } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 1500))
  const stillAlive = isAlive(record.pid)
  if (stillAlive) {
    try { process.kill(-record.pid, 'SIGKILL') } catch { try { process.kill(record.pid, 'SIGKILL') } catch { /* ignore */ } }
  }
  return { stopped: true, forced: stillAlive }
}

/** Бэкап перед запуском: журналы, скрипты, существующие результаты. */
async function backupBeforeRun(config, caseDir, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archive = join(caseDir, 'archive', `pre-${name}-${stamp}`)
  assertWritable(config.caseRoots, archive, 'каталог бэкапа')
  await mkdir(archive, { recursive: true })
  const copied = []
  const entries = await readdir(caseDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/\.(jou|sh|json|tsv|cas\.h5|dat\.h5)$/.test(entry.name)) continue
    const target = join(archive, entry.name)
    await copyFile(join(caseDir, entry.name), target)
    copied.push(entry.name)
  }
  return { dir: archive, files: copied }
}
