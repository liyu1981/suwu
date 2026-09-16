import { registerBackground } from '../registry'
import { VIDEO_PARAMS } from './params'

/**
 * Video — plays a short, muted MP4 or WebM clip as the app-shell background.
 *
 * Canvas-2D backend only: mediabunny demuxes and decodes the clip lazily
 * (`VideoSampleSink`), and the frames are drawn straight to the canvas — no
 * `<video>` element, no WebGPU, no audio. The clip source, fit, playback speed
 * and colour mask are exposed through the shared background parameter
 * framework.
 */
registerBackground({
  id: 'video',
  label: 'Video',
  params: VIDEO_PARAMS,
  cpu: () => import('./video-cpu'),
})
