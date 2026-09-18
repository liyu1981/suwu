/**
 * Timing for the optional crossfade loop.
 *
 * Near the end of a clip a second copy is started from the beginning; over
 * `VIDEO_CROSSFADE_SECONDS` the outgoing frame fades out while the incoming one
 * fades in, hiding the discontinuity at the loop point.
 */

/** Length of the crossfade, in media seconds. */
export const VIDEO_CROSSFADE_SECONDS = 2;

/**
 * A crossfade needs a clip at least twice as long as the blend; otherwise the
 * whole clip would be permanently blended.
 */
export function canCrossfade(duration: number): boolean {
  return duration > VIDEO_CROSSFADE_SECONDS * 2;
}

/**
 * Blend position of the outgoing stream: 0 (fully outgoing) at the start of the
 * window, ramping to 1 (fully incoming) at the end.
 *
 * @param primaryTime   Media time of the outgoing stream, in seconds.
 * @param firstTimestamp Start timestamp of the track, in seconds.
 * @param duration      Clip duration, in seconds.
 */
export function fadeProgress(
  primaryTime: number,
  firstTimestamp: number,
  duration: number,
): number {
  const start = firstTimestamp + duration - VIDEO_CROSSFADE_SECONDS;
  const progress = (primaryTime - start) / VIDEO_CROSSFADE_SECONDS;
  return Math.max(0, Math.min(1, progress));
}
