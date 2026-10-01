import { CAPS } from '../core/alert-config';
import { chartCaption } from '../core/week-svg';
import type { ChartEntry, ChartSource } from './chart';
import type { Counts } from './log';
import { TG_PACE, type Clock, type TgPhotoResult, type TgPhotoSend } from './telegram';

/** One chart photo owed to a chat whose text already went out. */
export interface PhotoReq { chat: number; stationId: string; km: number; label: string | null }
export interface PhotoRun { charts: ChartSource; send: TgPhotoSend; clock: Clock; deadline: number; stopping(): boolean; max?: number }

/** Chart photos after the texts of a run (Plan O spec §3.3), in the order given. Best-effort and
 *  never throws: a photo that cannot be made or sent is counted and forgotten — no chat is ever
 *  treated as dead for it and nothing is retried next run. Same pacing as the texts; the send
 *  deadline and SIGTERM are checked before every photo; a 429 or a 401 stops the rest. */
export async function sendChartPhotos(reqs: readonly PhotoReq[], gen: string, o: PhotoRun): Promise<Counts> {
  const chartCounts: Counts = {}; // chart_render / chart_fetch_err / chart_render_err, from the source
  let ok = 0;
  let fail = 0;
  let skip = 0;
  const max = o.max ?? CAPS.tgPhotosPerRun;
  const gap = 1000 / TG_PACE.perSecond;
  const lastByChat = new Map<number, number>();
  // The texts went out just before: the first photo waits one full per-chat gap.
  let last = o.clock.now() + TG_PACE.perChatMs - gap;
  let stopped = false;
  let tried = 0;
  for (const q of reqs) {
    if (!stopped && (o.clock.now() >= o.deadline || o.stopping())) stopped = true;
    if (stopped || tried >= max) { skip++; continue; }
    let entry: ChartEntry | null;
    try { entry = await o.charts.get(gen, q.stationId, chartCounts); } catch { entry = null; }
    if (!entry) { skip++; continue; }
    tried++;
    const wait = Math.max(last + gap, (lastByChat.get(q.chat) ?? -Infinity) + TG_PACE.perChatMs) - o.clock.now();
    if (wait > 0) await o.clock.sleep(wait);
    if (o.clock.now() >= o.deadline) { stopped = true; skip++; continue; }
    const caption = chartCaption(q.label, entry.file, q.km);
    let r: TgPhotoResult;
    try {
      r = await o.send(q.chat, entry.fileId ? { fileId: entry.fileId } : { png: entry.png }, caption);
      // A file_id Telegram no longer accepts: upload the PNG again, once.
      if (entry.fileId && r.status === 400) { entry.fileId = null; r = await o.send(q.chat, { png: entry.png }, caption); }
    } catch {
      r = { ok: false, status: 0, retryAfterS: 0, description: '', fileId: null };
    }
    last = o.clock.now();
    lastByChat.set(q.chat, last);
    if (r.ok) { ok++; if (r.fileId) entry.fileId = r.fileId; }
    else { fail++; if (r.status === 429 || r.status === 401) stopped = true; }
  }
  return { ...chartCounts, tg_photo_ok: ok, tg_photo_fail: fail, tg_photo_skip: skip };
}
