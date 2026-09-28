import { SlashCommandBuilder } from 'discord.js'
import type { ReasoningEffort } from './types.js'

const DISCORD_DESCRIPTION_LIMIT = 100

export function discordDescription(description: string): string {
  return description.slice(0, DISCORD_DESCRIPTION_LIMIT)
}

const effortChoices: ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]

export function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('model')
      .setDescription(discordDescription('Show or change Codex model'))
      .addStringOption((option) =>
        option.setName('model').setDescription(discordDescription('Codex model')).setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('effort')
          .setDescription(discordDescription('Reasoning effort'))
          .addChoices(...effortChoices.map((effort) => ({ name: effort, value: effort }))),
      )
      .addStringOption((option) =>
        option
          .setName('scope')
          .setDescription(discordDescription('Where preference applies'))
          .addChoices(
            { name: 'current session', value: 'session' },
            { name: 'project channel', value: 'channel' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('mode')
      .setDescription(discordDescription('Show or change Codex collaboration mode'))
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription(discordDescription('Collaboration mode'))
          .addChoices(
            { name: 'default', value: 'default' },
            { name: 'plan', value: 'plan' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('fast')
      .setDescription(discordDescription('Show or change Codex Fast mode'))
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription(discordDescription('Fast mode action'))
          .addChoices(
            { name: 'Status', value: 'status' },
            { name: 'On', value: 'on' },
            { name: 'Off', value: 'off' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('yolo')
      .setDescription(discordDescription('Show or change approval-free, unsandboxed mode'))
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription(discordDescription('YOLO mode action'))
          .addChoices(
            { name: 'Status', value: 'status' },
            { name: 'On', value: 'on' },
            { name: 'Off', value: 'off' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('model-variant')
      .setDescription(discordDescription('Set reasoning effort for current model'))
      .addStringOption((option) =>
        option
          .setName('effort')
          .setDescription(discordDescription('Reasoning effort'))
          .setRequired(true)
          .addChoices(...effortChoices.map((effort) => ({ name: effort, value: effort }))),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('unset-model-override')
      .setDescription(discordDescription('Remove current session or channel model override'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('project')
      .setDescription(discordDescription('Legacy: map the current channel to a local project directory'))
      .addStringOption((option) =>
        option.setName('path').setDescription(discordDescription('Absolute or local project path')).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('add-project')
      .setDescription(discordDescription('Create a Discord channel for an existing local project'))
      .addStringOption((option) =>
        option
          .setName('project')
          .setDescription(discordDescription('Recent Codex project or an absolute directory'))
          .setRequired(true)
          .setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('remove-project')
      .setDescription(discordDescription('Delete a managed project channel and its local mapping'))
      .addStringOption((option) =>
        option
          .setName('project')
          .setDescription(discordDescription('Managed project channel'))
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addBooleanOption((option) =>
        option.setName('force').setDescription(discordDescription('Archive idle sessions before removing the mapping')),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('create-new-project')
      .setDescription(discordDescription('Create a git project, its Discord channel, and an initial session'))
      .addStringOption((option) =>
        option.setName('name').setDescription(discordDescription('New project name')).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('add-dir')
      .setDescription(discordDescription('Allow current session to access an extra directory'))
      .addStringOption((option) =>
        option.setName('directory').setDescription(discordDescription('Path relative to session, or * for all directories')),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('permissions')
      .setDescription(discordDescription('List or select a Codex permission profile for this session'))
      .addStringOption((option) =>
        option.setName('profile').setDescription(discordDescription('Profile ID, or default to clear override')),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('new-session')
      .setDescription(discordDescription('Start a new Codex session'))
      .addStringOption((option) =>
        option.setName('prompt').setDescription(discordDescription('Initial prompt')).setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('files')
          .setDescription(discordDescription('Comma-separated files; longer lists can be typed manually'))
          .setAutocomplete(true)
          .setMaxLength(6_000),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('resume')
      .setDescription(discordDescription('Resume an existing Codex session'))
      .addStringOption((option) =>
        option.setName('session').setDescription(discordDescription('Codex thread ID')).setRequired(true).setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('rename')
      .setDescription(discordDescription('Rename the current Discord and Codex session'))
      .addStringOption((option) =>
        option.setName('name').setDescription(discordDescription('New session name')).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('fork')
      .setDescription(discordDescription('Fork current Codex session into a new Discord thread'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('fork-subagent')
      .setDescription(discordDescription('Fork a Codex subagent task into a new Discord thread'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('subagents')
      .setDescription(discordDescription('List Codex subagent threads in this session'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('btw')
      .setDescription(discordDescription('Fork current context and ask a side question'))
      .addStringOption((option) =>
        option.setName('prompt').setDescription(discordDescription('Side question')).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('compact')
      .setDescription(discordDescription('Compact current Codex context'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('goal')
      .setDescription(discordDescription('Show or set the persistent Codex thread goal'))
      .addStringOption((option) =>
        option.setName('objective').setDescription(discordDescription('Goal objective; omit to show current goal')),
      )
      .addIntegerOption((option) =>
        option.setName('token-budget').setDescription(discordDescription('Optional goal token budget')).setMinValue(1),
      )
      .addStringOption((option) =>
        option
          .setName('status')
          .setDescription(discordDescription('Goal lifecycle status'))
          .addChoices(
            { name: 'Active', value: 'active' },
            { name: 'Paused', value: 'paused' },
            { name: 'Blocked', value: 'blocked' },
            { name: 'Complete', value: 'complete' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('clear-goal')
      .setDescription(discordDescription('Clear the current Codex thread goal'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('archive')
      .setDescription(discordDescription('Archive current Discord and Codex session'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('delete')
      .setDescription(discordDescription('Permanently delete this Codex transcript; keep Discord history'))
      .addStringOption((option) =>
        option
          .setName('confirm-session-id')
          .setDescription(discordDescription('Paste the exact ID from /session-id to confirm'))
          .setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('review')
      .setDescription(discordDescription('Run a Codex code review in current session'))
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription(discordDescription('Review target'))
          .addChoices(
            { name: 'uncommitted changes', value: 'uncommitted' },
            { name: 'base branch', value: 'base' },
            { name: 'custom instructions', value: 'custom' },
          ),
      )
      .addStringOption((option) => option.setName('branch').setDescription(discordDescription('Base branch, when target=base')))
      .addStringOption((option) => option.setName('instructions').setDescription(discordDescription('Custom review instructions')))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('diff')
      .setDescription(discordDescription('Show git diff for current project or session'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('schedule')
      .setDescription(discordDescription('Schedule a prompt in current session'))
      .addStringOption((option) => option.setName('prompt').setDescription(discordDescription('Prompt to send')).setRequired(true))
      .addIntegerOption((option) => option.setName('delay-seconds').setDescription(discordDescription('Seconds until first run')).setMinValue(1).setRequired(true))
      .addIntegerOption((option) => option.setName('repeat-seconds').setDescription(discordDescription('Repeat interval in seconds')))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('tasks')
      .setDescription(discordDescription('List scheduled prompts'))
      .addBooleanOption((option) =>
        option.setName('all').setDescription(discordDescription('Include cancelled and failed tasks')),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('cancel-task')
      .setDescription(discordDescription('Cancel scheduled prompt'))
      .addStringOption((option) => option.setName('id').setDescription(discordDescription('Task ID')).setRequired(true))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('skill')
      .setDescription(discordDescription('Invoke a Codex skill in the current session'))
      .addStringOption((option) =>
        option
          .setName('skill')
          .setDescription(discordDescription('Enabled Codex skill'))
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('prompt')
          .setDescription(discordDescription('Optional instruction for the skill'))
          .setMaxLength(6_000),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('skills')
      .setDescription(discordDescription('List Codex skills available in project'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('skill-toggle')
      .setDescription(discordDescription('Enable or disable a Codex skill'))
      .addStringOption((option) =>
        option
          .setName('skill')
          .setDescription(discordDescription('Codex skill'))
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addBooleanOption((option) =>
        option.setName('enabled').setDescription(discordDescription('Desired skill state')).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('skill-roots')
      .setDescription(discordDescription('Set runtime-only extra Codex skill discovery roots'))
      .addStringOption((option) =>
        option
          .setName('paths')
          .setDescription(discordDescription('Comma-separated absolute directories; empty clears roots'))
          .setMaxLength(4_000),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('plugins')
      .setDescription(discordDescription('Browse Codex plugins from configured marketplaces'))
      .addStringOption((option) =>
        option.setName('query').setDescription(discordDescription('Plugin name or ID')).setMaxLength(100),
      )
      .addBooleanOption((option) =>
        option.setName('include-available').setDescription(discordDescription('Search uninstalled plugins too')),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('plugin')
      .setDescription(discordDescription('Inspect or manage a Codex plugin globally'))
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription(discordDescription('Plugin action'))
          .addChoices(
            { name: 'Inspect', value: 'inspect' },
            { name: 'Install', value: 'install' },
            { name: 'Enable', value: 'enable' },
            { name: 'Disable', value: 'disable' },
            { name: 'Uninstall', value: 'uninstall' },
          )
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('plugin-id').setDescription(discordDescription('Exact ID from /plugins')).setMaxLength(200).setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('confirm-plugin-id').setDescription(discordDescription('Repeat exact ID to confirm a change')).setMaxLength(200),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('hooks')
      .setDescription(discordDescription('Inspect Codex hook events and trust state'))
      .addStringOption((option) =>
        option.setName('event').setDescription(discordDescription('Filter by hook event name')).setMaxLength(80),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('apps')
      .setDescription(discordDescription('Inspect Codex app availability and callable state'))
      .addStringOption((option) =>
        option.setName('query').setDescription(discordDescription('App name or ID')).setMaxLength(100),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('mcp-status')
      .setDescription(discordDescription('List Codex MCP server status'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('mcp')
      .setDescription(discordDescription('List, authenticate, or globally toggle Codex MCP servers'))
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription(discordDescription('MCP action; toggles persist in global Codex config'))
          .addChoices(
            { name: 'Show status', value: 'status' },
            { name: 'Reload configuration', value: 'reload' },
            { name: 'Authenticate', value: 'login' },
            { name: 'Enable globally', value: 'enable-global' },
            { name: 'Disable globally', value: 'disable-global' },
          ),
      )
      .addStringOption((option) =>
        option.setName('server').setDescription(discordDescription('Configured MCP server')).setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('mcp-login')
      .setDescription(discordDescription('Start OAuth login for a Codex MCP server'))
      .addStringOption((option) =>
        option.setName('server').setDescription(discordDescription('MCP server name')).setRequired(true).setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('auth-status')
      .setDescription(discordDescription('Show Codex authentication and account status'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('rate-limits')
      .setDescription(discordDescription('Show Codex account rate-limit usage and resets'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('account-usage')
      .setDescription(discordDescription('Show Codex lifetime token and streak statistics'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('login')
      .setDescription(discordDescription('Start Codex account login'))
      .addStringOption((option) =>
        option
          .setName('method')
          .setDescription(discordDescription('Login flow'))
          .addChoices(
            { name: 'Browser OAuth', value: 'chatgpt' },
            { name: 'Device code', value: 'chatgptDeviceCode' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('rollback')
      .setDescription(discordDescription('Remove recent turns from Codex history; files stay unchanged'))
      .addIntegerOption((option) =>
        option.setName('turns').setDescription(discordDescription('Turns to remove')).setMinValue(1).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('new-worktree')
      .setDescription(discordDescription('Fork current session into an isolated git worktree'))
      .addStringOption((option) =>
        option.setName('name').setDescription(discordDescription('Worktree name; defaults to thread name')),
      )
      .addStringOption((option) =>
        option
          .setName('base-branch')
          .setDescription(discordDescription('Git ref to branch from; defaults to HEAD'))
          .setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('toggle-worktrees')
      .setDescription(discordDescription('Toggle automatic worktrees for new sessions in this channel'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('worktrees')
      .setDescription(discordDescription('List active worktree sessions across all projects'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('merge-worktree')
      .setDescription(discordDescription('Rebase and fast-forward merge worktree into main checkout'))
      .addStringOption((option) =>
        option
          .setName('target-branch')
          .setDescription(discordDescription('Local branch to merge into; defaults to current branch'))
          .setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('delete-worktree')
      .setDescription(discordDescription('Delete a clean worktree after it has been merged'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription(discordDescription('Queue a prompt after current turn'))
      .addStringOption((option) =>
        option.setName('message').setDescription(discordDescription('Prompt to queue')).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('clear-queue')
      .setDescription(discordDescription('Clear queued prompts'))
      .addIntegerOption((option) =>
        option.setName('position').setDescription(discordDescription('1-based queue position')).setMinValue(1),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('pending-prompts')
      .setDescription(discordDescription('Privately review prompts whose delivery is uncertain'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('resolve-pending')
      .setDescription(discordDescription('Explicitly retry or discard one uncertain prompt'))
      .addStringOption((option) =>
        option.setName('action').setDescription(discordDescription('What to do with the saved prompt'))
          .setRequired(true).addChoices(
            { name: 'Retry', value: 'retry' },
            { name: 'Discard', value: 'discard' },
          ),
      )
      .addStringOption((option) =>
        option.setName('source-id').setDescription(discordDescription('Exact ID shown by /pending-prompts'))
          .setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('run-shell-command')
      .setDescription(discordDescription('Run a shell command in project directory'))
      .addStringOption((option) =>
        option.setName('command').setDescription(discordDescription('Shell command')).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('last-sessions')
      .setDescription(discordDescription('Find recent Codex sessions across mapped projects'))
      .addStringOption((option) =>
        option
          .setName('query')
          .setDescription(discordDescription('Case-sensitive title fragment'))
          .setMaxLength(100),
      )
      .addBooleanOption((option) =>
        option.setName('include-archived').setDescription(discordDescription('Include archived sessions')),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('context-usage')
      .setDescription(discordDescription('Show token usage and context window for current session'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('verbosity')
      .setDescription(discordDescription('Show or set output verbosity for this project channel'))
      .addStringOption((option) =>
        option
          .setName('level')
          .setDescription(discordDescription('Output detail level'))
          .addChoices(
            { name: 'Tools and text', value: 'tools_and_text' },
            { name: 'Text and essential tools', value: 'text_and_essential_tools' },
            { name: 'Text only', value: 'text_only' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('session-id')
      .setDescription(discordDescription('Show current Codex session ID and local resume command'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('abort')
      .setDescription(discordDescription('Stop active Codex turn'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('ps')
      .setDescription(discordDescription('List background terminals for this Codex session'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription(discordDescription('Stop background terminals in this Codex session'))
      .addStringOption((option) =>
        option.setName('process-id').setDescription(discordDescription('One Codex process ID; omit to stop all')),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription(discordDescription('Show Cordex session status'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('debug-config')
      .setDescription(discordDescription('Privately show Codex config layers and managed policy'))
      .setDMPermission(false),
  ].map((command) => command.toJSON())
}
