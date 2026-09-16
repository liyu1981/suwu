import type { BackgroundDefinition } from './types'

const registry = new Map<string, BackgroundDefinition>()

/** Register a background so the shell can start it by id. */
export function registerBackground(definition: BackgroundDefinition): void {
  registry.set(definition.id, definition)
}

/** Look up a registered background by id. */
export function getBackground(id: string): BackgroundDefinition | undefined {
  return registry.get(id)
}

/** All registered backgrounds, in registration order. */
export function listBackgrounds(): BackgroundDefinition[] {
  return [...registry.values()]
}
