export interface Env { isLine: boolean; isIOS: boolean; standalone: boolean; saveData: boolean; canNotify: boolean; canShare: boolean; canGeolocate: boolean; canServiceWorker: boolean }
export interface EnvGlobals {
  userAgent: string; standalone?: boolean; displayModeStandalone?: boolean; saveData?: boolean; maxTouchPoints?: number;
  hasNotification: boolean; hasShare: boolean; hasGeolocation: boolean; hasServiceWorker: boolean;
}

export function detectEnv(g: EnvGlobals): Env {
  const isLine = /\bLine\//.test(g.userAgent);
  const isIOS = /iPhone|iPad|iPod/.test(g.userAgent) || (/Macintosh/.test(g.userAgent) && (g.maxTouchPoints ?? 0) > 1);
  const standalone = !!(g.standalone || g.displayModeStandalone);
  return {
    isLine, isIOS, standalone, saveData: !!g.saveData,
    canNotify: g.hasNotification && !isLine && (!isIOS || standalone),
    canShare: g.hasShare, canGeolocate: g.hasGeolocation, canServiceWorker: g.hasServiceWorker && !isLine,
  };
}

export function browserEnvGlobals(): EnvGlobals {
  const nav = navigator as Navigator & { standalone?: boolean; connection?: { saveData?: boolean } };
  return {
    userAgent: nav.userAgent,
    standalone: nav.standalone,
    maxTouchPoints: nav.maxTouchPoints,
    displayModeStandalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
    saveData: nav.connection?.saveData,
    hasNotification: typeof Notification !== 'undefined',
    hasShare: typeof nav.share === 'function',
    hasGeolocation: 'geolocation' in nav,
    hasServiceWorker: 'serviceWorker' in nav,
  };
}
