const btwSuffixPattern = /(?:[.!?,;:])\s*btw\.?\s*$|\n\s*btw\.?\s*$/i

export function parseBtwMessage(content: string): { prompt: string; fork: boolean } {
  if (!btwSuffixPattern.test(content)) return { prompt: content, fork: false }
  return {
    prompt: content.replace(btwSuffixPattern, '').trimEnd(),
    fork: true,
  }
}
