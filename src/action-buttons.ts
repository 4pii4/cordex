import type { DynamicToolSpec, JsonObject } from './types.js'

export const actionButtonsToolName = 'cordex_action_buttons'

export type ActionButtonColor = 'white' | 'blue' | 'green' | 'red'

export type ActionButtonOption = {
  label: string
  color: ActionButtonColor
}

export const actionButtonsTool: DynamicToolSpec = {
  type: 'function',
  name: actionButtonsToolName,
  description: [
    'Show action buttons in the current Discord thread for quick confirmations.',
    'Use this when the user can respond by clicking one of up to 3 buttons.',
    'Prefer a single button whenever possible. Default color is white.',
    'If more than 3 options are needed, use request_user_input instead.',
    'Always call this tool last, after all response text.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['buttons'],
    properties: {
      buttons: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        description: 'Array of 1-3 action buttons. Prefer one button whenever possible.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label'],
          properties: {
            label: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
              description: 'Button label shown to the user (1-80 characters).',
            },
            color: {
              type: 'string',
              enum: ['white', 'blue', 'green', 'red'],
              description: 'Optional button color. White is the default.',
            },
          },
        },
      },
    },
  },
}

export const cordexDynamicTools: DynamicToolSpec[] = [actionButtonsTool]

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isActionButtonColor(value: unknown): value is ActionButtonColor {
  return value === 'white' || value === 'blue' || value === 'green' || value === 'red'
}

export function parseActionButtons(argumentsValue: unknown): ActionButtonOption[] {
  if (!isRecord(argumentsValue) || !Array.isArray(argumentsValue.buttons)) {
    throw new Error('Action buttons require a buttons array')
  }
  if (argumentsValue.buttons.length < 1 || argumentsValue.buttons.length > 3) {
    throw new Error('Action buttons require between 1 and 3 buttons')
  }
  return argumentsValue.buttons.map((value) => {
    if (!isRecord(value) || typeof value.label !== 'string') {
      throw new Error('Each action button requires a label')
    }
    const label = value.label.trim()
    if (!label || label.length > 80) {
      throw new Error('Action button labels must contain 1-80 characters')
    }
    if (value.color !== undefined && !isActionButtonColor(value.color)) {
      throw new Error(`Unsupported action button color: ${String(value.color)}`)
    }
    return { label, color: value.color ?? 'white' }
  })
}

export function actionButtonToolResult(text: string, success: boolean): JsonObject {
  return {
    contentItems: [{ type: 'inputText', text }],
    success,
  }
}
