export const threadTitleMaxLength = 80
export const defaultThreadTitle = 'Cordex session'

export function normalizeThreadTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim() || defaultThreadTitle
  const characters = Array.from(normalized)
  if (characters.length <= threadTitleMaxLength) return normalized
  return `${characters.slice(0, threadTitleMaxLength - 1).join('')}\u2026`
}
