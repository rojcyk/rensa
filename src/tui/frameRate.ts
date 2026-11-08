// The one place the frame rate is written. Step 11b may set MAX_FPS to 10;
// everything paced by frames derives from it.

/** Ink's `maxFps`. */
export const MAX_FPS = 20

/** One frame in milliseconds: the engine-event batcher's window. */
export const FRAME_MS = Math.round(1000 / MAX_FPS)
