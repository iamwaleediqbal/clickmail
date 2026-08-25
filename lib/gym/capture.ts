/**
 * Screenshots without a server.
 *
 * A browser cannot be launched in a serverless function — Chromium is larger
 * than the whole function size limit — so the environment photographs itself
 * instead. `modern-screenshot` serialises the node into an SVG foreignObject
 * and lets the browser rasterise it, which means whatever the browser can
 * render, the capture matches. Libraries that reimplement CSS in JavaScript
 * do not survive `color-mix()` or gradients, both of which this UI uses.
 *
 * Capture is best effort. A run that produced no picture is still a run; a run
 * that died taking one would be a worse outcome than a missing thumbnail.
 */

const WIDTH = 1180;
const HEIGHT = 720;
const SCALE = 0.5;

/**
 * The geometry every coordinate in a computer-use run is measured against.
 *
 * The model is shown the scaled image and answers in its pixels; the
 * environment is hit-tested in CSS pixels. Publishing both from one place is
 * what stops the two drifting apart — a factor-of-two mismatch here reads
 * exactly like a model that cannot aim, and would be blamed on the model.
 */
export const CAPTURE = {
  width: WIDTH,
  height: HEIGHT,
  imageWidth: Math.round(WIDTH * SCALE),
  imageHeight: Math.round(HEIGHT * SCALE),
} as const;

export async function capture(node: HTMLElement): Promise<string | undefined> {
  try {
    const { domToJpeg } = await import("modern-screenshot");
    return await domToJpeg(node, {
      width: WIDTH,
      height: HEIGHT,
      // Half scale and lossy: these are thumbnails held in memory for the
      // length of a run, not archives.
      scale: SCALE,
      quality: 0.7,
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
      style: { transform: "none" },
      // The UI is system-ui throughout, so there is nothing to embed and the
      // font pass is pure latency on every single turn.
      font: false,
      // A capture that hangs must not hang the run behind it.
      timeout: 4000,
    });
  } catch {
    return undefined;
  }
}
