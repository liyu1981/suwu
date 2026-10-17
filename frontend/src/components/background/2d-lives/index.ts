import { registerBackground } from '../registry';
import { LIVES_PARAMS } from './params';

/**
 * 2D Lives — search a remote animated-wallpaper provider and play the chosen
 * wallpaper as the app-shell background.
 *
 * The wallpaper is downloaded through the Suwu server into its own OPFS
 * library (never the Video clip library), then rendered by the shared video
 * renderer with wallpaper-appropriate controls. The provider itself is an
 * adapter on the server (pkg/lives2d), so the frontend never names a site.
 */
registerBackground({
  id: '2d-lives',
  label: '2D Lives',
  params: LIVES_PARAMS,
  cpu: () => import('./lives-cpu'),
});
