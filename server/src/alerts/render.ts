import { existsSync } from 'node:fs';
import type { RenderPng } from '../../../src/alerts/chart';
import { CHART } from '../../../src/core/week-svg';

/** Relative to the working directory, like server/migrations and static/provinces.json (/app in the image). */
export const FONT_FILE = 'server/fonts/NotoSansThaiLooped-Regular.ttf';
export const CHART_WIDTH_PX = 960;

/** The chart renderer (Plan O spec §3.1): our own font only, never the machine's. Rejects when the
 *  font file is missing (resvg would draw a chart with no labels) or the native binding cannot
 *  load — the caller then runs without charts instead of dying at import time. */
export async function resvgRender(fontFile: string = FONT_FILE): Promise<RenderPng> {
  if (!existsSync(fontFile)) throw new Error('chart font missing');
  const { Resvg } = await import('@resvg/resvg-js');
  return (svg) => new Resvg(svg, {
    fitTo: { mode: 'width', value: CHART_WIDTH_PX },
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: CHART.font },
    // Logs stay counts-only: the renderer itself writes nothing to stderr.
    logLevel: 'off',
  }).render().asPng();
}
