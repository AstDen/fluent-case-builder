/**
 * fluent-case-builder — универсальный конструктор расчётных кейсов ANSYS Fluent.
 *
 * Плагин не «зашивает» один проект: предметное знание живёт в данных
 * (data/profiles — проектные кейсы, data/recipes — проверенные блоки журнала,
 * data/rules — инженерные правила и вопросы интервью). Код только:
 *  1) проводит интервью и рекомендует модели;
 *  2) собирает план и генерирует файлы кейса;
 *  3) проверяет журнал по базе знаний;
 *  4) запускает Fluent и контролирует выполнение с бэкапами.
 *
 * @module fluent-case-builder
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { kbHint, normalizeConfig } from './lib/config.js'
import { caseStatus, generateCase, generateFromSpec, listCases, planCase, validateJournal } from './lib/engine.js'
import { discoverProfiles, describeParams, loadProfile } from './lib/profile.js'
import { applyRules, buildFacts, completeness, draftSpec, loadKnowledge, nextQuestions } from './lib/rules.js'
import { compileSpec, loadRecipes, searchRecipes } from './lib/compile.js'
import { loadCommands, readKbFile, searchCommands } from './lib/kb.js'
import { startRun, runStatus, stopRun } from './lib/run.js'
import { jsonSafe } from './lib/util.js'
import { PKG_VERSION } from './lib/version.js'
import { appendTaskNote, createReport } from './lib/report.js'


/** Встроенный skill: маршрутизация вопросов по Fluent в базу знаний плагина. */
const KB_SKILL = {
  name: 'fluent-tui-knowledge',
  description: 'ANSYS Fluent TUI: поиск проверенных команд и рецептов, настройка кейсов, отчёты для мейнтейнера',
  whenToUse: 'любые вопросы про ANSYS Fluent, TUI-команды, включение моделей/BC/материалов/решателя, создание и проверка расчётных кейсов, journal-автоматизация',
  source: 'bundled',
  content: `# ANSYS Fluent — работа через плагин fluent-case-builder

## Железные правила
1. **Синтаксис TUI не выдумывать.** Сначала ищи факт в плагине, только потом отвечай.
2. **Сначала поиск, потом ответ.** Для вопроса «как включить/задать/найти в Fluent» вызывай
   \`fluent_kb_search({ query, scope: "all" })\` — он возвращает и команды из индекса TUI, и
   проверенные рецепты (journal-строки со статусом).
3. **Статус обязателен.** \`verified\` — проверено в живой сессии/журнале; \`derived\` — выведено из
   справки (проверить вживую); \`unverified\` — не проверено, не выдавать за факт.
4. **Указывай источник.** Путь в KB (\`KB/04_MODELS/viscous.md:160-181\`, \`QA_LOG Q-007\`) или рецепт.
5. **Если факта нет** — так и скажи: «в базе нет подтверждённого ответа, нужна проверка в живой
   сессии», и предложи проверить через \`fluent_case_run\`/journal.

## Формат ответа на вопрос «как включить X»
1) journal-строка (готовая, с аргументами);
2) интерактивная последовательность (путь → вопросы → ответы);
3) зависимости (энергия/модели/сетка/лицензия);
4) как проверить, что применилось;
5) статус ✅/🟡/🔴 и источник.

## Создание кейса
- Непонятна задача → \`fluent_case_interview\` (вопросы + рекомендации моделей по Re/Mach/теплообмену).
- Есть спецификация → \`fluent_case_plan({spec})\` (сухой прогон) → \`fluent_case_generate({spec, outputDir})\`
  (журнал только из проверенных рецептов; непроверенные шаги перечисляются в \`unsupported\`).
- Повторяемый профиль → \`fluent_case_profiles\` → \`fluent_case_plan/generate\`.
- Проверка журнала → \`fluent_case_validate\`; запуск → \`fluent_case_run\` (только по явной просьбе,
  с \`confirm:true\`; \`allowRun\` в конфиге).
- Трудности/вопросы → \`fluent_task_log\`; итоговый отчёт мейнтейнеру → \`fluent_task_report\`.

## Если инструмент вернул configured:false
Скажи пользователю, что не настроен путь к базе знаний (\`kbRoot\`/\`indexDir\`), приведи hint из ответа
и не подменяй KB собственной памятью.
`,
}

/** Уникальное имя cordis-плагина. */
export const name = 'fluent-case-builder'

/** Версия плагина (для отчётов и диагностики). */
export const version = PKG_VERSION

/** Требуемые сервисы Harness. */
export const inject = ['tools', 'skills']

const text = (value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}]

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => text(value),
}

/** Разрешить кейс по caseDir или паре profile+params. */
async function resolveCaseDir(config, args) {
  if (args.caseDir) return args.caseDir
  if (args.profile) {
    const plan = await planCase(config, args.profile, args.params ?? {})
    return plan.caseDir
  }
  throw new Error('укажите caseDir или profile+params')
}

/** Плагин: регистрирует инструменты. */
export function apply(ctx, rawConfig = {}) {
  // Встроенный skill: агент сам выбирает KB-инструменты для вопросов по Fluent.
  if (ctx.skills?.register) {
    try { ctx.skills.register(KB_SKILL) } catch (error) { /* skill не критичен для работы плагина */ }
  }

  // Любой ответ инструмента приводим к lossless JSON (undefined/NaN недопустимы в output-схеме).
  const safeRegister = (definition) => ctx.tools.register({
    ...definition,
    execute: async (args, exec) => jsonSafe(await definition.execute(args, exec)),
  })
  let config
  try {
    config = normalizeConfig(rawConfig ?? {})
  } catch (error) {
    throw new Error(`fluent-case-builder: некорректный конфиг: ${error.message}`)
  }

  // ---- 1. Профили ----
  safeRegister(defineTool({
    name: 'fluent_case_profiles',
    description: 'Список готовых профилей расчётных кейсов (проектных шаблонов) с их параметрами. '
      + 'Профиль — самый надёжный путь: он воспроизводит проверенный кейс из параметров. '
      + 'Начните с него, если задача похожа на существующий проект; иначе используйте интервью/спецификацию.',
    parameters: {
      profile: { type: 'string', description: 'id профиля — вернуть подробности; пусто — список всех' },
    },
    output: jsonOutput,
    async execute(args) {
      const profiles = await discoverProfiles(config.dataDir, config.profileDirs ?? [])
      if (args.profile) {
        const profile = await loadProfile(config.dataDir, args.profile, config.profileDirs ?? [])
        return {
          id: profile.id,
          title: profile.title,
          description: profile.description ?? null,
          status: profile.status ?? null,
          source: profile.source ?? null,
          params: describeParams(profile),
          verification: profile.verification ?? null,
          templateRoot: config.templateRoots?.[profile.id] ?? null,
        }
      }
      return {
        profiles: profiles.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description ?? null,
          category: p.category ?? null,
          status: p.status ?? (p.error ? `error: ${p.error}` : null),
          paramCount: Object.keys(p.params ?? {}).length,
        })),
        hint: 'fluent_case_plan({profile, params}) — сухой прогон без записи; fluent_case_generate — создать файлы',
      }
    },
  }))

  // ---- 2. Интервью ----
  safeRegister(defineTool({
    name: 'fluent_case_interview',
    description: 'Провести интервью по задаче и получить: следующие вопросы пользователю, рекомендации моделей '
      + '(турбулентность по Re, решатель по Mach, энергия, горение, излучение и т.д.), полноту ответов и '
      + 'черновик спецификации кейса. Вызывайте многократно, передавая накопленные answers. '
      + 'Плагин сам ничего у пользователя не спрашивает — вопросы задаёт агент.',
    parameters: {
      answers: {
        type: 'object', additionalProperties: true,
        description: 'Накопленные ответы: {questionId или specPath: значение}. Пример: {"task.kind":"gas-dynamics","mach":2.5,"reynolds":30000}',
      },
      spec: { type: 'object', additionalProperties: true, description: 'Текущий черновик case spec (см. docs/CASE_SPEC.md)' },
      limit: { type: 'integer', description: 'Сколько вопросов вернуть (по умолчанию 5)' },
    },
    output: jsonOutput,
    async execute(args) {
      const knowledge = await loadKnowledge(config.dataDir)
      const answers = args.answers ?? {}
      const draft = draftSpec(args.spec ?? {}, answers, knowledge)
      const questions = nextQuestions(knowledge.questions, answers)
      const limit = args.limit ?? 5
      return {
        next: questions.next.slice(0, limit),
        pendingCount: questions.pendingCount,
        requiredCount: questions.requiredCount,
        completeness: completeness(knowledge.questions, answers),
        recommendations: draft.recommendations,
        matchedRules: draft.matched.map((r) => ({
          id: r.id, why: r.why, status: r.status, confidence: r.confidence, source: r.source,
        })),
        warnings: draft.warnings,
        draftSpec: draft.spec,
        hint: 'задайте пользователю next[].text, затем повторите вызов с новыми answers',
      }
    },
  }))

  // ---- 3. План ----
  safeRegister(defineTool({
    name: 'fluent_case_plan',
    description: 'Сухой прогон без записи на диск: профиль+параметры → директория кейса, вычисляемые величины, '
      + 'пресет (например quick/fine), список файлов, предпросмотр журнала; либо универсальный case spec → собранный '
      + 'журнал и список непроверенных шагов. Всегда вызывайте перед generate.',
    parameters: {
      profile: { type: 'string', description: 'id профиля (например example-channel)' },
      params: { type: 'object', additionalProperties: true, description: 'Параметры профиля {R:50, L:1500, phi:0.8, ...}' },
      spec: { type: 'object', additionalProperties: true, description: 'Универсальная спецификация кейса (альтернатива profile)' },
      outputRoot: { type: 'string', description: 'переопределить корень вывода (должен быть внутри caseRoots)' },
      includeJournal: { type: 'boolean', description: 'Вернуть полный журнал, а не только предпросмотр' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.spec) {
        const { recipes, warnings: recipeWarnings } = await loadRecipes(config.dataDir)
        const compiled = compileSpec(args.spec, recipes)
        const validation = await validateJournal(config, compiled.journal).catch((error) => ({ error: error.message }))
        return {
          mode: 'spec',
          journal: args.includeJournal ? compiled.journal : compiled.journal.slice(0, 40),
          journalLineCount: compiled.journal.length,
          truncated: !args.includeJournal && compiled.journal.length > 40,
          sections: compiled.sections,
          derived: compiled.derived,
          unsupported: compiled.unsupported,
          warnings: [...recipeWarnings, ...compiled.warnings],
          validation,
        }
      }
      if (!args.profile) throw new Error('укажите profile или spec')
      const plan = await planCase(config, args.profile, args.params ?? {}, { outputRoot: args.outputRoot })
      const validation = plan.journal
        ? await validateJournal(config, plan.journal.split('\n')).catch((error) => ({ error: error.message }))
        : null
      const result = { mode: 'profile', ...plan, validation }
      if (!args.includeJournal) delete result.journal
      return result
    },
  }))

  // ---- 4. Генерация ----
  safeRegister(defineTool({
    name: 'fluent_case_generate',
    description: 'Создать файлы кейса на диске: по профилю+параметрам (директории, копии UDF/TSV/сетки, '
      + 'setup_case.jou, start.sh, манифест case.json, бэкап старой версии) ИЛИ по универсальной спецификации '
      + '(setup_case.jou только из проверенных рецептов + case.json; нужен outputDir). Идемпотентно: '
      + 'существующий кейс не перезаписывается без force. Ничего не запускает.',
    parameters: {
      profile: { type: 'string', description: 'id профиля (вместо spec)' },
      params: { type: 'object', additionalProperties: true, description: 'Параметры профиля' },
      spec: { type: 'object', additionalProperties: true, description: 'универсальная спецификация кейса (вместо profile)' },
      outputDir: { type: 'string', description: 'каталог для spec-кейса (внутри caseRoots)' },
      name: { type: 'string', description: 'имя кейса/файлов для spec (по умолчанию spec.meta.name)' },
      force: { type: 'boolean', description: 'Пересоздать существующий кейс (старая версия профиля уйдёт в archive/)' },
      outputRoot: { type: 'string', description: 'переопределить корень вывода профиля (внутри caseRoots)' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.spec) {
        if (!args.outputDir) throw new Error('для spec-кейса укажите outputDir')
        const result = await generateFromSpec(config, args.spec, {
          outputDir: args.outputDir, force: Boolean(args.force), name: args.name,
        })
        const { readFile } = await import('node:fs/promises')
        const validation = await validateJournal(config, (await readFile(result.journalPath, 'utf8')).split(/\r?\n/))
        return { ...result, validation }
      }
      if (!args.profile) throw new Error('укажите profile+params или spec+outputDir')
      const result = await generateCase(config, args.profile, args.params ?? {}, { force: Boolean(args.force), outputRoot: args.outputRoot })
      const validation = await validateJournal(config, (await renderFullJournal(config, await planCase(config, args.profile, args.params ?? {}, { outputRoot: args.outputRoot }))).split('\n')).catch((error) => ({ error: error.message }))
      return { ...result, validation }
    },
  }))

  // ---- 5. Валидация ----
  safeRegister(defineTool({
    name: 'fluent_case_validate',
    description: 'Оффлайн-проверка журнала по индексу команд Fluent TUI (commands.csv): какие строки точно есть, '
      + 'какие скрытые/подтверждённые журналами, какие неизвестны. Не заменяет живую проверку — динамические '
      + 'меню и скрытые команды дают предупреждения.',
    parameters: {
      profile: { type: 'string', description: 'проверить журнал профиля' },
      params: { type: 'object', additionalProperties: true, description: 'параметры профиля' },
      caseDir: { type: 'string', description: 'проверить существующий кейс (setup_case.jou)' },
      journal: { type: 'array', items: { type: 'string' }, description: 'проверить произвольные строки журнала' },
    },
    output: jsonOutput,
    async execute(args) {
      let lines = args.journal
      if (!lines && args.caseDir) {
        const file = join(args.caseDir, 'setup_case.jou')
        if (!existsSync(file)) throw new Error(`нет setup_case.jou в ${args.caseDir}`)
        const { readFile } = await import('node:fs/promises')
        lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      }
      if (!lines && args.profile) {
        const plan = await planCase(config, args.profile, args.params ?? {}, { outputRoot: args.outputRoot })
        lines = (await renderFullJournal(config, plan)).split(/\r?\n/)
      }
      if (!lines) throw new Error('укажите profile+params, caseDir или journal')
      return validateJournal(config, lines)
    },
  }))

  // ---- 6. Статус ----
  safeRegister(defineTool({
    name: 'fluent_case_status',
    description: 'Статус кейса: манифест, параметры, наличие ожидаемых результатов (.cas.h5/.dat.h5), '
      + 'состояние последних запусков и хвост лога.',
    parameters: {
      caseDir: { type: 'string', description: 'директория кейса' },
      profile: { type: 'string', description: 'или профиль+params для вычисления пути' },
      params: { type: 'object', additionalProperties: true },
      run: { type: 'string', description: 'имя запуска для лога (по умолчанию setup)' },
      lines: { type: 'integer', description: 'строк лога (по умолчанию 40)' },
    },
    output: jsonOutput,
    async execute(args) {
      const caseDir = await resolveCaseDir(config, args)
      const status = await caseStatus(caseDir)
      let run = null
      try { run = await runStatus(config, caseDir, args.run ?? 'setup', { lines: args.lines ?? 40 }) } catch { run = null }
      return { ...status, lastRun: run }
    },
  }))

  // ---- 7. Реестр ----
  safeRegister(defineTool({
    name: 'fluent_case_list',
    description: 'Последние созданные плагином кейсы из реестра (с параметрами и статусом).',
    parameters: {
      limit: { type: 'integer', description: 'сколько вернуть (по умолчанию 20)' },
      profile: { type: 'string', description: 'фильтр по профилю' },
    },
    output: jsonOutput,
    async execute(args) {
      return { registryPath: config.registryPath, cases: await listCases(config, args) }
    },
  }))

  // ---- 8. Запуск ----
  safeRegister(defineTool({
    name: 'fluent_case_run',
    description: 'Запуск Fluent с журналом в фоне и контроль: action=start (нужен confirm:true и allowRun), '
      + 'action=status (лог, ошибки, результаты), action=stop (остановить группу процессов). '
      + 'Перед запуском автоматически делает бэкап журналов и результатов в archive/. '
      + 'ВНИМАНИЕ: это запускает реальный расчёт/настройку — только по явной просьбе пользователя.',
    parameters: {
      action: { type: 'string', required: true, description: 'start | status | stop' },
      caseDir: { type: 'string', description: 'директория кейса' },
      profile: { type: 'string', description: 'или профиль+params' },
      params: { type: 'object', additionalProperties: true },
      journal: { type: 'string', description: 'файл журнала относительно кейса (setup_case.jou)' },
      name: { type: 'string', description: 'имя запуска для лога/записи (setup)' },
      dimension: { type: 'string', description: '3ddp | 2ddp | 3d | 2d' },
      threads: { type: 'integer', description: 'число процессов' },
      mpi: { type: 'string', description: 'intel | msmpi | none' },
      affinity: { type: 'string', description: 'core | none' },
      lines: { type: 'integer', description: 'строк лога в status' },
      confirm: { type: 'boolean', description: 'явное подтверждение запуска (start)' },
    },
    output: jsonOutput,
    async execute(args) {
      const caseDir = await resolveCaseDir(config, args)
      const name = args.name ?? 'setup'
      if (args.action === 'start') {
        if (!args.confirm) throw new Error('запуск требует confirm:true — подтвердите у пользователя, что можно запускать Fluent')
        const result = await startRun(config, {
          caseDir,
          journalFile: args.journal ?? 'setup_case.jou',
          name,
          dimension: args.dimension ?? '3ddp',
          threads: args.threads ?? 2,
          mpi: args.mpi ?? 'intel',
          affinity: args.affinity ?? 'core',
        })
        return { action: 'start', caseDir, ...result, hint: 'проверяйте fluent_case_run({action:"status"})' }
      }
      if (args.action === 'status') {
        return { action: 'status', ...(await runStatus(config, caseDir, name, { lines: args.lines ?? 60 })) }
      }
      if (args.action === 'stop') {
        return { action: 'stop', ...(await stopRun(caseDir, name)) }
      }
      throw new Error(`неизвестное действие: ${args.action}`)
    },
  }))

  // ---- 9. Поиск по KB ----
  safeRegister(defineTool({
    name: 'fluent_kb_search',
    description: 'Поиск по знаниям плагина: (1) индекс TUI-команд — путь, вопрос, default, blocked, help; '
      + '(2) проверенные рецепты — готовые journal-строки «как включить/сделать X» со статусом '
      + 'verified/derived/unverified и источником. Это первый инструмент для любого вопроса про Fluent.',
    parameters: {
      query: { type: 'string', required: true, description: 'что нужно: «включить k-omega SST», /define/... , ключевое слово' },
      limit: { type: 'integer', description: 'сколько результатов на раздел (10)' },
      category: { type: 'string', description: 'ограничить категорию индекса, например 04_MODELS' },
      scope: { type: 'string', enum: ['all', 'commands', 'recipes'], description: 'all (default) | commands | recipes' },
    },
    output: jsonOutput,
    async execute(args) {
      const limit = args.limit ?? 10
      const scope = args.scope ?? 'all'
      const result = { query: args.query, scope, commands: [], recipes: [], configured: {} }
      if (scope !== 'recipes') {
        if (!config.indexDir) {
          result.configured.indices = false
          result.hint = kbHint(config)
        } else {
          try {
            const commands = await loadCommands(config.indexDir)
            result.commands = searchCommands(commands, args.query, { limit, category: args.category })
            result.configured.indices = true
          } catch (error) {
            result.configured.indices = false
            result.hint = error.message
          }
        }
      }
      if (scope !== 'commands') {
        try {
          const { recipes } = await loadRecipes(config.dataDir)
          result.recipes = searchRecipes(recipes, args.query, { limit })
          result.configured.recipes = recipes.size > 0
        } catch (error) {
          result.configured.recipes = false
        }
      }
      const empty = !result.commands.length && !result.recipes.length
      result.hint = result.hint ?? (empty
        ? 'в индексе и рецептах ничего не найдено; уточните запрос или проверьте факт в живой сессии'
        : 'journal-строка рецепта — готовый ответ; статус и source обязательны в ответе')
      return result
    },
  }))

  // ---- 11. Отчёт о задаче (для мейнтейнера) ----
  safeRegister(defineTool({
    name: 'fluent_task_report',
    description: 'Создать самодостаточный отчёт о задаче (JSON + Markdown) для мейнтейнера плагина: '
      + 'окружение и версия Fluent, постановка задачи, ответы интервью и рекомендации, кейс/спека, '
      + 'проверка журнала по KB, лог запуска, автоматический анализ ошибок и список пробелов. '
      + 'Коллега генерирует отчёт и присылает файл; мейнтейнер агрегирует отчёты скриптом '
      + 'scripts/ingest-report.mjs и обновляет плагин. Секретов/лицензионных ключей в отчёте нет.',
    parameters: {
      caseDir: { type: 'string', description: 'каталог кейса плагина (case.json)' },
      profile: { type: 'string', description: 'или профиль кейса' },
      params: { type: 'object', additionalProperties: true, description: 'параметры профиля' },
      spec: { type: 'object', additionalProperties: true, description: 'или универсальная спецификация кейса' },
      answers: { type: 'object', additionalProperties: true, description: 'ответы интервью {id вопроса: значение}' },
      title: { type: 'string', description: 'как назвать задачу' },
      kind: { type: 'string', description: 'класс задачи (hydrodynamics, gas-dynamics, combustion, …)' },
      description: { type: 'string', description: 'что считали и зачем' },
      expectations: { type: 'string', description: 'какой результат был нужен' },
      notes: { type: 'array', items: { type: 'string' }, description: 'заметки по ходу работы' },
      questions: { type: 'array', items: { type: 'string' }, description: 'вопросы мейнтейнеру' },
      includeLogs: { type: 'boolean', description: 'включать лог запуска (default true)' },
      outputDir: { type: 'string', description: 'каталог отчёта (внутри caseRoots/reportDir/кейса)' },
      runName: { type: 'string', description: 'какой запуск брать (setup)' },
      outputRoot: { type: 'string', description: 'корень вывода кейса, если задан profile' },
    },
    output: jsonOutput,
    async execute(args) {
      return createReport(config, args)
    },
  }))

  // ---- 12. Заметка исполнителя ----
  safeRegister(defineTool({
    name: 'fluent_task_log',
    description: 'Дописать заметку исполнителя в журнал задачи (task-notes.jsonl рядом с будущим отчётом). '
      + 'Заметки автоматически попадают в отчёт fluent_task_report как пробелы/запросы мейнтейнеру. '
      + 'Используйте по ходу работы: что не получилось, что пришлось обходить, какие вопросы остались.',
    parameters: {
      message: { type: 'string', required: true, description: 'текст заметки' },
      kind: { type: 'string', description: 'note | question | error | blocked | idea (default note)' },
      caseDir: { type: 'string', description: 'каталог кейса' },
      outputDir: { type: 'string', description: 'каталог журнала (внутри caseRoots/reportDir/кейса)' },
      author: { type: 'string', description: 'кто пишет (по умолчанию USER)' },
    },
    output: jsonOutput,
    async execute(args) {
      return appendTaskNote(config, args)
    },
  }))

  // ---- 10. Документ KB ----
  safeRegister(defineTool({
    name: 'fluent_kb_get',
    description: 'Прочитать документ базы знаний Fluent TUI по относительному пути (например 04_MODELS/viscous.md).',
    parameters: {
      path: { type: 'string', required: true, description: 'путь относительно корня KB' },
      offset: { type: 'integer', description: 'первая строка (1)' },
      limit: { type: 'integer', description: 'сколько строк (400)' },
    },
    output: jsonOutput,
    async execute(args) {
      if (!config.kbRoot) return { configured: false, hint: kbHint(config) }
      return readKbFile(config.kbRoot, args.path, { offset: args.offset ?? 1, limit: args.limit ?? 400 })
    },
  }))
}

/** Отрендерить полный журнал профиля (план читает шаблон). */
async function renderFullJournal(config, plan) {
  const { readFile } = await import('node:fs/promises')
  const { loadProfile } = await import('./lib/profile.js')
  const { resolveProfile } = await import('./lib/profile.js')
  const { renderTemplate } = await import('./lib/util.js')
  const profile = await loadProfile(config.dataDir, plan.profile.id, config.profileDirs ?? [])
  const resolved = resolveProfile(profile, plan.params, config)
  const scope = {
    ...resolved.scope,
    templateRoot: plan.templateRoot,
    solutionsRoot: config.profileRoots?.[profile.id],
  }
  const template = profile.templates?.setupJournal
  if (!template) throw new Error(`профиль ${profile.id}: нет templates.setupJournal`)
  const source = template.startsWith('/') ? template : join(profile.dir, template)
  return renderTemplate(await readFile(source, 'utf8'), scope, 'setupJournal')
}
