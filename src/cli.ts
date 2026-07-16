#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { CodexAppServer } from './codex-app-server.js'
import {
  assertDirectory,
  emptyState,
  getConfigPath,
  getProjectsDirectory,
  loadConfig,
  loadState,
  saveConfig,
  saveState,
  withManagementLock,
} from './config.js'
import { CordexDiscordBot } from './discord-bot.js'
import { runProjectCli } from './project-cli.js'
import type { CordexConfig } from './types.js'
import { packageVersion } from './version.js'

const execFileAsync = promisify(execFile)
const usage = `Usage: cordex [command] [options]

Commands:
  init                         Write or update Discord credentials
  doctor                       Validate the local Codex and project setup
  start                        Start the Discord bot
  project <subcommand>         Manage Discord project mappings
  add-project [directory]      Alias for "project add"

Options:
  --projects-dir <path>        Override the projects directory
  --verbose, -v                Enable verbose backend logging
  --help, -h                   Show this help
  --version, -V                Show the Cordex version`

async function init(): Promise<void> {
  const existing = await loadConfig().catch(() => undefined)
  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    const token = (await prompt.question('Discord bot token: ')).trim() || existing?.token || ''
    const applicationId = (await prompt.question('Discord application ID: ')).trim() || existing?.applicationId || ''
    const guildId = (await prompt.question('Discord server ID: ')).trim() || existing?.guildId || ''
    if (!token || !applicationId || !guildId) {
      throw new Error('Discord bot token, application ID, and server ID are required')
    }
    const guildChanged = existing !== undefined && existing.guildId !== guildId
    const config: CordexConfig = {
      token,
      applicationId,
      guildId,
      ...(existing?.defaultModel ? { defaultModel: existing.defaultModel } : {}),
      ...(existing?.defaultEffort ? { defaultEffort: existing.defaultEffort } : {}),
      sandbox: existing?.sandbox || 'workspace-write',
      approvalPolicy: existing?.approvalPolicy || 'on-request',
      allowAllUsers: guildChanged ? false : existing?.allowAllUsers ?? false,
      allowShellCommands: guildChanged ? false : existing?.allowShellCommands ?? false,
      ...(!guildChanged && existing?.allowedUserIds
        ? { allowedUserIds: existing.allowedUserIds }
        : {}),
      ...(!guildChanged && existing?.allowedRoleIds
        ? { allowedRoleIds: existing.allowedRoleIds }
        : {}),
      ...(!guildChanged && existing?.categoryId ? { categoryId: existing.categoryId } : {}),
      ...(process.env.CORDEX_PROJECTS_DIR
        ? { projectsDirectory: path.resolve(process.env.CORDEX_PROJECTS_DIR) }
        : existing?.projectsDirectory
          ? { projectsDirectory: existing.projectsDirectory }
        : {}),
      projects: guildChanged ? {} : existing?.projects || {},
    }
    await withManagementLock(async () => {
      await saveConfig(config)
      if (guildChanged) await saveState(emptyState())
    })
    console.log(`Saved ${getConfigPath()}`)
    if (guildChanged) console.log('Discord server changed; cleared old mappings and session state.')
    console.log('Run: cordex')
  } finally {
    prompt.close()
  }
}

async function doctor(): Promise<void> {
  const config = await loadConfig()
  const { stdout: version } = await execFileAsync(
    process.env.CORDEX_CODEX_BIN || 'codex',
    ['--version'],
  )
  for (const project of Object.values(config.projects)) await assertDirectory(project.directory)
  console.log(version.trim())
  console.log(`Config: ${getConfigPath()}`)
  console.log(`Projects directory: ${getProjectsDirectory(config)}`)
  console.log(`Projects: ${Object.keys(config.projects).length}`)
  console.log('Doctor: OK')
}

async function start(verbose = false): Promise<void> {
  const config = await loadConfig()
  const state = await withManagementLock(async () => {
    const state = await loadState()
    // A previous process cannot keep an in-flight turn alive. Treat persisted
    // active turn IDs as stale so the first new Discord message starts cleanly.
    for (const session of Object.values(state.sessions)) delete session.activeTurnId
    await saveState(state)
    return state
  })
  const codex = new CodexAppServer({ verbose })
  const bot = new CordexDiscordBot(config, state, codex, { verbose })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await bot.stop()
    process.exitCode = 0
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
  try {
    await bot.start()
  } catch (error) {
    await bot.stop().catch(() => undefined)
    throw error
  }
  console.log(`Cordex connected. Guild ${config.guildId}.`)
  if (verbose) console.log('Verbose backend logging enabled.')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const verbose = args.includes('--verbose') || args.includes('-v') || process.env.CORDEX_VERBOSE === '1'
  const projectsDirectoryIndex = args.indexOf('--projects-dir')
  if (projectsDirectoryIndex >= 0) {
    const value = args[projectsDirectoryIndex + 1]
    if (!value) throw new Error('--projects-dir requires a path')
    process.env.CORDEX_PROJECTS_DIR = path.resolve(value)
  }
  const commandArgs = args.filter((argument, index) => {
    if (['--verbose', '-v'].includes(argument)) return false
    if (argument === '--projects-dir') return false
    if (index > 0 && args[index - 1] === '--projects-dir') return false
    return true
  })
  if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
    console.log(usage)
    return
  }
  if (commandArgs.includes('--version') || commandArgs.includes('-V')) {
    console.log(await packageVersion())
    return
  }
  if (await runProjectCli(commandArgs)) return
  const command = commandArgs[0] || ''
  if (command === 'init') await init()
  else if (command === 'doctor') await doctor()
  else if (command === 'start') await start(verbose)
  else if (!command) {
    const exists = await access(getConfigPath()).then(() => true).catch(() => false)
    if (!exists) await init()
    await start(verbose)
  }
  else {
    console.error(usage)
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
