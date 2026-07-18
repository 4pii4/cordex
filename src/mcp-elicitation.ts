import type { JsonObject, JsonValue } from './types.js'

export type McpElicitationStringFormat = 'email' | 'uri' | 'date' | 'date-time'

export type McpElicitationOption = {
  label: string
  value: string
}

type McpElicitationFieldBase = {
  id: string
  label: string
  description: string
  required: boolean
}

export type McpElicitationField =
  | McpElicitationFieldBase & {
      kind: 'string'
      minLength?: number
      maxLength?: number
      format?: McpElicitationStringFormat
      default?: string
    }
  | McpElicitationFieldBase & {
      kind: 'number'
      integer: boolean
      minimum?: number
      maximum?: number
      default?: number
    }
  | McpElicitationFieldBase & {
      kind: 'boolean'
      default?: boolean
    }
  | McpElicitationFieldBase & {
      kind: 'singleSelect'
      options: McpElicitationOption[]
      default?: string
    }
  | McpElicitationFieldBase & {
      kind: 'multiSelect'
      options: McpElicitationOption[]
      minItems?: number
      maxItems?: number
      default?: string[]
    }

export type McpElicitationForm = {
  fields: McpElicitationField[]
  initialContent: Record<string, JsonValue>
}

const maxDiscordTextInputLength = 4_000
const maxDiscordSelectOptions = 25
const maxDiscordFormFields = 25

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function assertAllowedKeys(object: JsonObject, allowed: readonly string[], context: string): void {
  const allowedKeys = new Set(allowed)
  const unsupported = Object.keys(object).find((key) => !allowedKeys.has(key))
  if (unsupported) throw new Error(`${context} contains unsupported key ${JSON.stringify(unsupported)}`)
}

function optionalString(object: JsonObject, key: string, context: string): string | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${context}.${key} must be a string`)
  return value
}

function optionalBoolean(object: JsonObject, key: string, context: string): boolean | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${context}.${key} must be a boolean`)
  return value
}

function optionalFiniteNumber(object: JsonObject, key: string, context: string): number | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context}.${key} must be a finite number`)
  }
  return value
}

function optionalNonNegativeInteger(
  object: JsonObject,
  key: string,
  context: string,
): number | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${context}.${key} must be a non-negative integer`)
  }
  return value as number
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${context} must be an array of strings`)
  }
  return value
}

function uniqueStrings(values: string[], context: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${context} must not contain duplicates`)
}

function fieldBase(
  id: string,
  schema: JsonObject,
  required: boolean,
  context: string,
): McpElicitationFieldBase {
  const title = optionalString(schema, 'title', context)
  const description = optionalString(schema, 'description', context)
  const label = title?.trim() || id || 'Field'
  return {
    id,
    label,
    description: description?.trim() || label,
    required,
  }
}

function parseConstOptions(value: unknown, context: string): McpElicitationOption[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`)
  const options = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${context}[${index}] must be an object`)
    assertAllowedKeys(entry, ['const', 'title'], `${context}[${index}]`)
    if (typeof entry.const !== 'string' || typeof entry.title !== 'string') {
      throw new Error(`${context}[${index}] must contain string const and title values`)
    }
    return { value: entry.const, label: entry.title }
  })
  validateOptions(options, context)
  return options
}

function parseStringOptions(
  values: unknown,
  labels: unknown,
  context: string,
): McpElicitationOption[] {
  const enumValues = stringArray(values, context)
  uniqueStrings(enumValues, context)
  let enumLabels: string[] | undefined
  if (labels !== undefined) {
    enumLabels = stringArray(labels, `${context} labels`)
    if (enumLabels.length !== enumValues.length) {
      throw new Error(`${context} labels must match the number of enum values`)
    }
  }
  const options = enumValues.map((value, index) => ({
    value,
    label: enumLabels?.[index] || value,
  }))
  validateOptions(options, context)
  return options
}

function validateOptions(options: McpElicitationOption[], context: string): void {
  if (options.length === 0) throw new Error(`${context} must contain at least one option`)
  if (options.length > maxDiscordSelectOptions) {
    throw new Error(`${context} has more than ${maxDiscordSelectOptions} options`)
  }
  uniqueStrings(options.map((option) => option.value), `${context} values`)
}

function parseSingleSelect(
  id: string,
  schema: JsonObject,
  required: boolean,
  context: string,
): McpElicitationField {
  const titled = own(schema, 'oneOf')
  assertAllowedKeys(
    schema,
    titled
      ? ['type', 'title', 'description', 'oneOf', 'default']
      : ['type', 'title', 'description', 'enum', 'enumNames', 'default'],
    context,
  )
  const options = titled
    ? parseConstOptions(schema.oneOf, `${context}.oneOf`)
    : parseStringOptions(schema.enum, schema.enumNames, `${context}.enum`)
  const defaultValue = optionalString(schema, 'default', context)
  if (defaultValue !== undefined && !options.some((option) => option.value === defaultValue)) {
    throw new Error(`${context}.default is not one of the available options`)
  }
  return {
    ...fieldBase(id, schema, required, context),
    kind: 'singleSelect',
    options,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  }
}

function parseMultiSelect(
  id: string,
  schema: JsonObject,
  required: boolean,
  context: string,
): McpElicitationField {
  assertAllowedKeys(
    schema,
    ['type', 'title', 'description', 'minItems', 'maxItems', 'items', 'default'],
    context,
  )
  if (!isRecord(schema.items)) throw new Error(`${context}.items must be an object`)
  const items = schema.items
  let options: McpElicitationOption[]
  if (own(items, 'enum')) {
    assertAllowedKeys(items, ['type', 'enum'], `${context}.items`)
    if (items.type !== 'string') throw new Error(`${context}.items.type must be "string"`)
    options = parseStringOptions(items.enum, undefined, `${context}.items.enum`)
  } else if (own(items, 'anyOf') || own(items, 'oneOf')) {
    assertAllowedKeys(items, own(items, 'anyOf') ? ['anyOf'] : ['oneOf'], `${context}.items`)
    options = parseConstOptions(items.anyOf ?? items.oneOf, `${context}.items options`)
  } else {
    throw new Error(`${context}.items must contain enum, anyOf, or oneOf options`)
  }
  const minItems = optionalNonNegativeInteger(schema, 'minItems', context)
  const maxItems = optionalNonNegativeInteger(schema, 'maxItems', context)
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    throw new Error(`${context}.minItems cannot exceed maxItems`)
  }
  if ((minItems ?? 0) > options.length) {
    throw new Error(`${context}.minItems exceeds the number of available options`)
  }
  const effectiveMaxItems = Math.min(maxItems ?? options.length, options.length)
  const defaultValue = schema.default === undefined
    ? undefined
    : stringArray(schema.default, `${context}.default`)
  if (defaultValue) {
    uniqueStrings(defaultValue, `${context}.default`)
    if (defaultValue.some((value) => !options.some((option) => option.value === value))) {
      throw new Error(`${context}.default contains an unavailable option`)
    }
    if (defaultValue.length < (minItems ?? 0) || defaultValue.length > effectiveMaxItems) {
      throw new Error(`${context}.default violates minItems or maxItems`)
    }
  }
  return {
    ...fieldBase(id, schema, required, context),
    kind: 'multiSelect',
    options,
    ...(minItems !== undefined ? { minItems } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  }
}

function parseField(
  id: string,
  value: unknown,
  required: boolean,
): McpElicitationField {
  const context = `requestedSchema.properties[${JSON.stringify(id)}]`
  if (!isRecord(value)) throw new Error(`${context} must be an object`)
  if (value.type === 'string' && (own(value, 'enum') || own(value, 'oneOf'))) {
    return parseSingleSelect(id, value, required, context)
  }
  if (value.type === 'array') return parseMultiSelect(id, value, required, context)
  if (value.type === 'string') {
    assertAllowedKeys(
      value,
      ['type', 'title', 'description', 'minLength', 'maxLength', 'format', 'default'],
      context,
    )
    const minLength = optionalNonNegativeInteger(value, 'minLength', context)
    const maxLength = optionalNonNegativeInteger(value, 'maxLength', context)
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      throw new Error(`${context}.minLength cannot exceed maxLength`)
    }
    if ((minLength ?? 0) > maxDiscordTextInputLength) {
      throw new Error(`${context}.minLength exceeds Discord's text input limit`)
    }
    const format = optionalString(value, 'format', context)
    if (
      format !== undefined &&
      format !== 'email' &&
      format !== 'uri' &&
      format !== 'date' &&
      format !== 'date-time'
    ) {
      throw new Error(`${context}.format is unsupported`)
    }
    const defaultValue = optionalString(value, 'default', context)
    if (defaultValue !== undefined && defaultValue.length > maxDiscordTextInputLength) {
      throw new Error(`${context}.default exceeds Discord's text input limit`)
    }
    const field: McpElicitationField = {
      ...fieldBase(id, value, required, context),
      kind: 'string',
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(format !== undefined ? { format: format as McpElicitationStringFormat } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    }
    const error = validateMcpElicitationFieldValue(field, defaultValue)
    if (defaultValue !== undefined && error) throw new Error(`${context}.default ${error}`)
    return field
  }
  if (value.type === 'number' || value.type === 'integer') {
    assertAllowedKeys(
      value,
      ['type', 'title', 'description', 'minimum', 'maximum', 'default'],
      context,
    )
    const minimum = optionalFiniteNumber(value, 'minimum', context)
    const maximum = optionalFiniteNumber(value, 'maximum', context)
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error(`${context}.minimum cannot exceed maximum`)
    }
    const defaultValue = optionalFiniteNumber(value, 'default', context)
    const field: McpElicitationField = {
      ...fieldBase(id, value, required, context),
      kind: 'number',
      integer: value.type === 'integer',
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    }
    const error = validateMcpElicitationFieldValue(field, defaultValue)
    if (defaultValue !== undefined && error) throw new Error(`${context}.default ${error}`)
    return field
  }
  if (value.type === 'boolean') {
    assertAllowedKeys(value, ['type', 'title', 'description', 'default'], context)
    const defaultValue = optionalBoolean(value, 'default', context)
    return {
      ...fieldBase(id, value, required, context),
      kind: 'boolean',
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    }
  }
  throw new Error(`${context}.type is unsupported`)
}

export function parseMcpElicitationForm(value: unknown): McpElicitationForm {
  if (!isRecord(value)) throw new Error('requestedSchema must be an object')
  assertAllowedKeys(value, ['$schema', 'type', 'properties', 'required'], 'requestedSchema')
  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    throw new Error('requestedSchema.$schema must be a string')
  }
  if (value.type !== 'object') throw new Error('requestedSchema.type must be "object"')
  if (!isRecord(value.properties)) throw new Error('requestedSchema.properties must be an object')
  const propertyEntries = Object.entries(value.properties)
  if (propertyEntries.length > maxDiscordFormFields) {
    throw new Error(`requestedSchema has more than ${maxDiscordFormFields} fields`)
  }
  const required = value.required === undefined
    ? []
    : stringArray(value.required, 'requestedSchema.required')
  uniqueStrings(required, 'requestedSchema.required')
  const propertyIds = new Set(propertyEntries.map(([id]) => id))
  const missingRequired = required.find((id) => !propertyIds.has(id))
  if (missingRequired) {
    throw new Error(`requestedSchema.required references unknown property ${JSON.stringify(missingRequired)}`)
  }
  const requiredIds = new Set(required)
  const fields = propertyEntries.map(([id, schema]) =>
    parseField(id, schema, requiredIds.has(id)))
  const initialContent = Object.create(null) as Record<string, JsonValue>
  for (const field of fields) {
    if ('default' in field && field.default !== undefined) {
      initialContent[field.id] = field.default
    } else if (field.kind === 'multiSelect' && field.required && field.maxItems === 0) {
      initialContent[field.id] = []
    } else if (field.kind === 'string' && field.required && field.maxLength === 0) {
      initialContent[field.id] = ''
    }
  }
  return { fields, initialContent }
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match || !validDate(match[1] || '')) return false
  const hour = Number(match[2])
  const minute = Number(match[3])
  const second = Number(match[4])
  return hour <= 23 && minute <= 59 && second <= 59 && Number.isFinite(Date.parse(value))
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value)
}

function validUri(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) return false
  try {
    void new URL(value)
    return true
  } catch {
    return false
  }
}

export function validateMcpElicitationFieldValue(
  field: McpElicitationField,
  value: unknown,
): string | undefined {
  if (field.kind === 'string') {
    if (typeof value !== 'string') return 'must be a string'
    const length = Array.from(value).length
    if (field.minLength !== undefined && length < field.minLength) {
      return `must contain at least ${field.minLength} characters`
    }
    if (field.maxLength !== undefined && length > field.maxLength) {
      return `must contain at most ${field.maxLength} characters`
    }
    if (field.format === 'email' && !validEmail(value)) return 'must be a valid email address'
    if (field.format === 'uri' && !validUri(value)) return 'must be a valid absolute URI'
    if (field.format === 'date' && !validDate(value)) return 'must be a valid YYYY-MM-DD date'
    if (field.format === 'date-time' && !validDateTime(value)) return 'must be a valid RFC 3339 date-time'
    return undefined
  }
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number'
    if (field.integer && !Number.isSafeInteger(value)) return 'must be a safe integer'
    if (field.minimum !== undefined && value < field.minimum) return `must be at least ${field.minimum}`
    if (field.maximum !== undefined && value > field.maximum) return `must be at most ${field.maximum}`
    return undefined
  }
  if (field.kind === 'boolean') {
    return typeof value === 'boolean' ? undefined : 'must be true or false'
  }
  if (field.kind === 'singleSelect') {
    return typeof value === 'string' && field.options.some((option) => option.value === value)
      ? undefined
      : 'must be one of the available options'
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return 'must be an array of available options'
  }
  if (new Set(value).size !== value.length) return 'must not contain duplicate options'
  if (value.some((entry) => !field.options.some((option) => option.value === entry))) {
    return 'contains an unavailable option'
  }
  if (field.minItems !== undefined && value.length < field.minItems) {
    return `must contain at least ${field.minItems} selections`
  }
  if (field.maxItems !== undefined && value.length > field.maxItems) {
    return `must contain at most ${field.maxItems} selections`
  }
  return undefined
}

export function validateMcpElicitationContent(
  form: McpElicitationForm,
  content: Record<string, JsonValue>,
): string | undefined {
  const fieldsById = new Map(form.fields.map((field) => [field.id, field]))
  const unknown = Object.keys(content).find((id) => !fieldsById.has(id))
  if (unknown) return `Unknown field ${JSON.stringify(unknown)}`
  for (const field of form.fields) {
    if (!own(content, field.id)) {
      if (field.required) return `${field.label} is required`
      continue
    }
    const error = validateMcpElicitationFieldValue(field, content[field.id])
    if (error) return `${field.label} ${error}`
  }
  return undefined
}

export function parseMcpElicitationNumberInput(value: string): number | undefined {
  const normalized = value.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function validateMcpElicitationUrl(value: unknown, serverName: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined
    if (serverName === 'codex_apps') {
      const host = url.hostname.toLowerCase()
      if (
        host !== 'chatgpt.com' &&
        host !== 'chatgpt-staging.com' &&
        !host.endsWith('.chatgpt.com') &&
        !host.endsWith('.chatgpt-staging.com')
      ) return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

export function mcpElicitationPersistModes(meta: unknown): Array<'session' | 'always'> {
  if (!isRecord(meta)) return []
  const values = Array.isArray(meta.persist) ? meta.persist : [meta.persist]
  return ['session', 'always'].filter((mode) => values.includes(mode)) as Array<'session' | 'always'>
}

export function isMcpToolApproval(meta: unknown): boolean {
  return isRecord(meta) && meta.codex_approval_kind === 'mcp_tool_call'
}

export type McpToolApprovalDisplayParam = {
  name: string
  value: JsonValue
  displayName: string
}

export function mcpToolApprovalDisplayParams(meta: unknown): McpToolApprovalDisplayParam[] {
  if (!isRecord(meta)) return []
  const display = Array.isArray(meta.tool_params_display)
    ? meta.tool_params_display.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      const displayName = typeof entry.display_name === 'string' ? entry.display_name.trim() : name
      if (!name || !displayName || !own(entry, 'value')) return []
      return [{ name, displayName, value: entry.value as JsonValue }]
    })
    : []
  if (!isRecord(meta.tool_params)) return display
  const displayNames = new Map(display.map((param) => [param.name, param.displayName]))
  return Object.entries(meta.tool_params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name,
      displayName: displayNames.get(name) || name,
      value: value as JsonValue,
    }))
}
