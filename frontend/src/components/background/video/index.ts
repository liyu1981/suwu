import { registerBackground } from '../registry'
import { VIDEO_PARAMS } from './params'

/**
 * Video — plays a short, muted MP4 clip as the app-shell background.
 *
 * Canvas-2D backend only: WebCodecs (`VideoDecoder`) decodes the frames and
 * they are drawn straight to the canvas — no `<video>` element, no WebGPU, no
 * audio. The clip URL, playback mode (loop / boomerang), fit and speed are
 * exposed through the shared background parameter framework.
 */
registerBackground({
  id: 'video',
  label: 'Video',
  params: VIDEO_PARAMS,
  cpu: () => import('./video-cpu'),
})
