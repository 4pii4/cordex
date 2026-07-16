import { stat } from 'node:fs/promises'
import path from 'node:path'

export type FileAutocompleteChoice = { name: string; value: string }

export function parseFileArguments(value: string): string[] {
  return [...new Set(
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )]
}

export function parseFileAutocomplete(value: string): {
  previousFiles: string[]
  currentQuery: string
} {
  const parts = value.split(',')
  return {
    previousFiles: parts.slice(0, -1).map((file) => file.trim()).filter(Boolean),
    currentQuery: (parts.at(-1) || '').trim(),
  }
}

export function buildFileAutocompleteChoices(
  value: string,
  matches: string[],
): FileAutocompleteChoice[] {
  const { previousFiles } = parseFileAutocomplete(value)
  const prefix = previousFiles.length > 0 ? `${previousFiles.join(', ')}, ` : ''
  return matches.map((file) => {
    const fullValue = `${prefix}${file}`
    const basenames = [...previousFiles, file].map(
      (entry) => entry.split(/[\\/]/).at(-1) || entry,
    )
    let name = basenames.join(', ')
    if (name.length > 100) name = `…${name.slice(-97)}`
    return { name, value: fullValue }
  }).filter((choice) => choice.value.length <= 100).slice(0, 25)
}

export async function resolveProjectFiles(projectDirectory: string, value: string): Promise<string[]> {
  const root = path.resolve(projectDirectory)
  const files = parseFileArguments(value)
  if (files.length === 0) throw new Error('Files option is empty')
  const resolved: string[] = []
  for (const file of files) {
    const absolute = path.resolve(root, file)
    const relative = path.relative(root, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`File is outside the project: ${file}`)
    }
    const info = await stat(absolute).catch(() => undefined)
    if (!info) throw new Error(`File does not exist: ${file}`)
    if (!info.isFile()) throw new Error(`Not a file: ${file}`)
    resolved.push(relative || path.basename(absolute))
  }
  return resolved
}
