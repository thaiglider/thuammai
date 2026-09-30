import { VEHICLES, type Vehicle } from '../../core/thresholds';
import { getJson, setJson, type KV } from './storage';

export interface Settings { size: 'a' | 'a2' | 'a3'; theme: 'auto' | 'light' | 'dark'; saveData: boolean; vehicle: 'none' | Vehicle }

export function loadSettings(kv: KV, envSaveData: boolean): Settings {
  const s = getJson<Partial<Settings>>(kv, 'settings', {});
  return {
    size: s.size === 'a2' || s.size === 'a3' ? s.size : 'a',
    theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'auto',
    saveData: typeof s.saveData === 'boolean' ? s.saveData : envSaveData,
    vehicle: (VEHICLES as readonly string[]).includes(s.vehicle as string) ? s.vehicle as Vehicle : 'none',
  };
}

export function saveSettings(kv: KV, s: Settings): void {
  setJson(kv, 'settings', s);
}

export function applySettings(doc: Document, s: Settings): void {
  doc.documentElement.dataset.size = s.size;
  doc.documentElement.dataset.theme = s.theme;
}
