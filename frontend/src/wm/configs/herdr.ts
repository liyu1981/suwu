import i18n from '../../i18n'
import { registerAppConfig } from '../appConfigs'

registerAppConfig({
  id: 'herdr',
  get label() { return i18n.t('plugin.herdr') },
  get description() { return i18n.t('plugin.herdrDesc') },
  iconBg: 'bg-emerald-500/20 text-emerald-400',
  pluginId: 'term',
  params: { cmd: 'herdr' },
})
