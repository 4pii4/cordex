import type { VerbosityLevel } from './types.js'

export const defaultVerbosity: VerbosityLevel = 'tools_and_text'

export function showStatusFooter(level: VerbosityLevel): boolean {
  return level !== 'text_only'
}
