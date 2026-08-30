/**
 * App configs are preset entries shown in the "New Application" picker.
 * Each config references a real tile plugin by id and provides extra URL
 * params that get merged into the plugin's iframe src.
 */

export interface AppConfig {
  id: string
  label: string
  description?: string
  /** Background + text color classes for the icon (e.g. 'bg-emerald-500/20 text-emerald-400'). */
  iconBg: string
  /** The first letter shown in the icon badge. */
  iconLetter?: string
  /** Which real tile plugin to use. */
  pluginId: string
  /** Extra query params merged into the plugin iframe src. */
  params: Record<string, string>
}

const registry: AppConfig[] = []

export function registerAppConfig(config: AppConfig): void {
  registry.push(config)
}

export function getAllAppConfigs(): AppConfig[] {
  return [...registry]
}
