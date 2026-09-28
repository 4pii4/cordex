import type { DynamicToolSpec, JsonObject } from './types.js'

export const fileUploadToolName = 'cordex_upload_files'

export const fileUploadTool: DynamicToolSpec = {
  type: 'function',
  name: fileUploadToolName,
  description: [
    'Upload 1-10 generated project files to the current Discord thread in one message.',
    'Use only when the user explicitly asks to receive files, screenshots, or artifacts in Discord.',
    'Paths must resolve inside the current session directory and must not be hidden files.',
    'Call this after creating and verifying the files, then tell the user what was queued.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['paths'],
    properties: {
      paths: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        description: 'Paths of the 1-10 files to upload from the current session directory.',
        items: { type: 'string', minLength: 1, maxLength: 4_096 },
      },
    },
  },
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFileUploadPaths(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.paths) ||
    value.paths.length < 1 || value.paths.length > 10) {
    throw new Error('Upload tool requires 1-10 file paths')
  }
  return value.paths.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 4_096) {
      throw new Error('Every upload path must be a non-empty string under 4096 characters')
    }
    return entry.trim()
  })
}
