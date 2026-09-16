import type {
  BackgroundDefinition,
  BackgroundParam,
  BackgroundParamValue,
} from './types'

/**
 * Defaults for every parameter a background declares.
 *
 * The schema is the single source of truth: a backend never needs its own copy
 * of the defaults, and System Settings shows exactly these values on first use.
 */
export function defaultBackgroundParams(
  definition: BackgroundDefinition,
): Record<string, BackgroundParamValue> {
  const out: Record<string, BackgroundParamValue> = {}
  for (const param of definition.params ?? []) {
    out[param.key] = param.default
  }
  return out
}

/**
 * Merge stored overrides over the declared defaults.
 *
 * Overrides are untrusted (they come from localStorage), so anything that does
 * not match the parameter's declared kind — or sits outside a number's range —
 * is silently discarded in favour of the default. That keeps a stale or
 * hand-edited entry from feeding a backend garbage.
 */
export function resolveBackgroundParams(
  definition: BackgroundDefinition,
  overrides?: Record<string, BackgroundParamValue>,
): Record<string, BackgroundParamValue> {
  const out = defaultBackgroundParams(definition)
  if (!overrides) return out
  for (const param of definition.params ?? []) {
    const value = overrides[param.key]
    if (value !== undefined) out[param.key] = coerceParam(param, value)
  }
  return out
}

/** Validates one stored value against its schema, falling back to the default. */
function coerceParam(
  param: BackgroundParam,
  value: BackgroundParamValue,
): BackgroundParamValue {
  switch (param.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return param.default
      return Math.min(param.max, Math.max(param.min, value))
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : param.default
    case 'select':
      return typeof value === 'string' && param.options.some((o) => o.value === value)
        ? value
        : param.default
  }
}
