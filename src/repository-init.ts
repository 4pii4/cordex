import { lstat } from 'node:fs/promises'
import path from 'node:path'

export async function assertRepositoryInitTarget(directory: string, update: boolean): Promise<void> {
  const target = path.join(directory, 'AGENTS.md')
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error('AGENTS.md must be a regular, single-linked file; initialization will not follow links or replace other targets.')
  }
  if (!update) {
    throw new Error('AGENTS.md already exists. Use /init update:true to refresh it while preserving existing instructions.')
  }
}

export async function repositoryInitOverrideNotice(directory: string): Promise<string | undefined> {
  const info = await lstat(path.join(directory, 'AGENTS.override.md')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info || (!info.isFile() && !info.isSymbolicLink())) return undefined
  return info.isFile() && info.size === 0
    ? '⚠ AGENTS.override.md is empty but can still prevent automatic AGENTS.md loading. Review the override if you want the generated guide selected; Cordex leaves it untouched.'
    : '⚠ AGENTS.override.md is present and may take precedence over AGENTS.md. Cordex leaves it unchanged; review your instruction sources before starting a fresh session.'
}

export function repositoryInitPrompt(options: { update: boolean; instructions?: string }): string {
  return [
    'Initialize contributor guidance in the current working directory by creating AGENTS.md.',
    options.update
      ? 'If AGENTS.md already exists, refresh it in place while preserving every existing user-authored rule, example, custom section, and comment. Do not replace it with a generic template.'
      : 'Create only: do not overwrite an existing AGENTS.md. Recheck immediately before writing; if one has appeared, stop and explain that explicit update:true is required.',
    'Before writing, confirm the target is absent or a regular single-linked file. Never follow a symlink, edit a multiply linked file, or replace a directory or other special file.',
    'Read and obey applicable project instructions, including AGENTS.override.md. Do not modify override files. Report any override that takes precedence over the new AGENTS.md. An empty override supplies no instructions but may still prevent automatic AGENTS.md loading; do not promise fallback without verifying it.',
    'Inspect the README, relevant build/package manifests, source layout, and existing verification tooling. Write concise, repository-specific guidance with useful headings, real setup/build/verification commands, project structure, and change safeguards. Prefer roughly 200-400 words where practical; do not invent commands or requirements.',
    'Only create or edit AGENTS.md in the current working directory. Leave source, tests, configuration, generated artifacts, Git history, and the index untouched. Do not install dependencies, commit, publish, or inspect credential files such as .env or authentication/session stores.',
    ...(options.instructions?.trim()
      ? [`Additional project guidance requested by the user:\n${options.instructions.trim()}`]
      : []),
    'Report what you created or refreshed, any limitations, and the exact path. Explain that a fresh Codex session can load the updated guidance; do not claim that instructions in an already-running session were automatically replaced.',
  ].join('\n\n')
}
