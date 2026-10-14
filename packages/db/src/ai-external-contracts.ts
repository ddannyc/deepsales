export type ExternalValue = string | number | boolean | null
export type ExternalInput = {
  name: string
  type: 'string' | 'number' | 'boolean'
  location: 'path' | 'query' | 'body'
  required: boolean
}
export type ExternalFixed = {
  name: string
  location: ExternalInput['location']
  value: ExternalValue
}
export type ExternalOutput = { name: string; path: string[]; type: ExternalInput['type'] }
export type ExternalRequestDefinition = {
  origin: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  effect: 'READ' | 'WRITE'
  inputs: ExternalInput[]
  fixed: ExternalFixed[]
  output: ExternalOutput[]
}

const safeKey = (key: string) =>
  /^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(key) &&
  !['constructor', 'prototype', '__proto__'].includes(key)
export function validateExternalDefinition(definition: ExternalRequestDefinition) {
  if (
    !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(definition.method) ||
    !['READ', 'WRITE'].includes(definition.effect) ||
    !/^\/[A-Za-z0-9/_.{}-]*$/.test(definition.path) ||
    definition.path.startsWith('//') ||
    /(^|\/)\.{1,2}(\/|$)/.test(definition.path) ||
    definition.path.length > 1000 ||
    !Array.isArray(definition.inputs) ||
    definition.inputs.length > 20 ||
    !Array.isArray(definition.fixed) ||
    definition.fixed.length > 20 ||
    !Array.isArray(definition.output) ||
    !definition.output.length ||
    definition.output.length > 20
  )
    throw new Error('Invalid external definition')
  const fields = [...definition.inputs, ...definition.fixed]
  if (
    new Set(fields.map((field) => field.name)).size !== fields.length ||
    fields.some(
      (field) => !safeKey(field.name) || !['path', 'query', 'body'].includes(field.location),
    )
  )
    throw new Error('Invalid external fields')
  if (
    definition.inputs.some(
      (field) =>
        !['string', 'number', 'boolean'].includes(field.type) ||
        typeof field.required !== 'boolean',
    ) ||
    definition.fixed.some((field) => !validValue(field.value)) ||
    definition.output.some(
      (field) =>
        !safeKey(field.name) ||
        !['string', 'number', 'boolean'].includes(field.type) ||
        !Array.isArray(field.path) ||
        !field.path.length ||
        field.path.length > 4 ||
        field.path.some((key) => !safeKey(key)),
    ) ||
    new Set(definition.output.map((field) => field.name)).size !== definition.output.length
  )
    throw new Error('Invalid external schema')
  const placeholders = [...definition.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
  if (
    definition.path.replaceAll(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '').match(/[{}]/) ||
    placeholders.some(
      (name) => !fields.some((field) => field.location === 'path' && field.name === name),
    ) ||
    fields.some((field) => field.location === 'path' && !placeholders.includes(field.name)) ||
    (definition.method === 'GET' && fields.some((field) => field.location === 'body')) ||
    (definition.effect === 'WRITE' &&
      (!definition.fixed.length || definition.inputs.some((field) => field.location === 'path')))
  )
    throw new Error('External object targets must be fixed')
}
export function validValue(value: unknown): value is ExternalValue {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.length <= 2000) ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}
export function validateExternalArguments(
  definition: ExternalRequestDefinition,
  values: Record<string, unknown>,
) {
  if (
    Object.keys(values).length > 20 ||
    Object.keys(values).some((name) => !definition.inputs.some((field) => field.name === name))
  )
    throw new Error('Invalid external arguments')
  for (const field of definition.inputs) {
    const value = values[field.name]
    if (value === undefined && !field.required) continue
    if (!validValue(value) || typeof value !== field.type)
      throw new Error('Invalid external arguments')
    if (
      field.location === 'path' &&
      (!String(value) ||
        String(value).length > 200 ||
        /[/%\\]/.test(String(value)) ||
        ['.', '..'].includes(String(value)))
    )
      throw new Error('Invalid external path')
  }
}

export function validateExternalObjectScope(scope: string, definition: ExternalRequestDefinition) {
  if (definition.effect !== 'WRITE') return
  const parsed: unknown = JSON.parse(scope)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Fixed object policy required')
  const policy = parsed as { policy?: unknown; targets?: unknown; description?: unknown }
  if (
    Object.keys(policy).some((key) => !['policy', 'targets', 'description'].includes(key)) ||
    policy.policy !== 'FIXED_CONFIG' ||
    typeof policy.description !== 'string' ||
    !policy.description.trim() ||
    !Array.isArray(policy.targets) ||
    !policy.targets.length ||
    policy.targets.length > 20
  )
    throw new Error('Fixed object policy required')
  for (const entry of policy.targets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid object target')
    const target = entry as { name?: unknown; location?: unknown }
    if (
      Object.keys(target).some((key) => !['name', 'location'].includes(key)) ||
      !definition.fixed.some(
        (field) =>
          field.name === target.name &&
          field.location === target.location &&
          field.value !== null &&
          String(field.value).length > 0,
      )
    )
      throw new Error('Object targets must bind fixed configured values')
  }
}
