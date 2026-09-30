import { accessAt } from '../../core/access';
import { accessLine, HOSPITAL_EMPTY_TH, HOSPITAL_NOTE_TH, hospitalLine } from '../../core/advice';
import { hospitalProvinces, nearestHospitals } from '../../core/hospital';
import type { RiskInput } from '../../core/risk';
import type { DataStore } from '../lib/data';
import { clear, h } from '../lib/dom';

export const HOSPITAL_LOADING_TH = 'กำลังโหลด…';
export const HOSPITAL_FAILED_TH = 'โหลดข้อมูลโรงพยาบาลไม่ได้';

/** Fills a card's "โรงพยาบาลใกล้จุดนี้" body (first open only): the nearest OSM hospitals with the
 *  road status beside each, from the card's own RiskInput. Text nodes only. */
export async function mountHospitals(host: HTMLElement, store: DataStore, lat: number, lon: number, input: RiskInput): Promise<void> {
  clear(host);
  host.append(h('p', { class: 'muted', role: 'status' }, HOSPITAL_LOADING_TH));
  try {
    const provs = hospitalProvinces(lat, lon, await store.provinces());
    // A province without a file simply has no hospital data (null); a network failure rejects.
    const files = (await Promise.all(provs.map((p) => store.hospitals(p)))).filter((f) => f !== null);
    const near = nearestHospitals(lat, lon, files.flatMap((f) => f.items));
    const fetchedAt = files.map((f) => f.fetchedAt).sort()[0];
    clear(host);
    if (!near.length || !fetchedAt) {
      host.append(h('p', { 'data-testid': 'hospital-empty' }, HOSPITAL_EMPTY_TH), callButton());
      return;
    }
    host.append(
      h('ul', { class: 'list', 'data-testid': 'hospital-list' }, ...near.map((n) => h('li', { 'data-testid': 'hospital-row' },
        h('strong', {}, hospitalLine(n)), h('br'),
        `ถนนใกล้โรงพยาบาล: ${accessLine(accessAt(n.lat, n.lon, input, 'near'))}`))),
      callButton(),
      h('p', { class: 'muted', 'data-testid': 'hospital-note' }, HOSPITAL_NOTE_TH(fetchedAt)));
  } catch {
    clear(host);
    host.append(h('p', { role: 'alert', 'data-testid': 'hospital-error' }, HOSPITAL_FAILED_TH, ' ',
      h('button', { 'data-testid': 'hospital-retry', onclick: () => void mountHospitals(host, store, lat, lon, input) }, 'ลองใหม่')));
  }
}

const callButton = () => h('p', { class: 'actions' },
  h('a', { href: 'tel:1669', class: 'callbtn', 'aria-label': 'โทร 1669 เจ็บป่วยฉุกเฉิน', 'data-testid': 'hospital-call' }, 'โทร 1669'));
