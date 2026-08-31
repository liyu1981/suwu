/**
 * App configs are preset entries shown in the "New Application" picker.
 * Each config references a real tile plugin by id and provides extra URL
 * params that get merged into the plugin's iframe src.
 */

import { registerAppConfig } from '../appConfigs'

registerAppConfig({
  id: 'port-forward',
  label: 'Port Forward',
  description: 'TCP/UDP port forwarding',
  iconBg: 'bg-cyan-500/20 text-cyan-400',
  iconLetter: 'F',
  pluginId: 'forward',
  params: {},
})
