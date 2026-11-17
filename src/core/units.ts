/**
 * Display units (design §3 HUD & UI). The simulation always runs in SI (m, m/s); only what the
 * player reads is converted. Metric: km/h, m, m/s, km. Imperial (aviation): knots, feet,
 * feet per minute, nautical miles.
 */
export type Units = 'metric' | 'imperial';

const KT = 3600 / 1852; // m/s → knots
const KMH = 3.6; // m/s → km/h
const FT = 1 / 0.3048; // m → ft
const FPM = 60 / 0.3048; // m/s → ft/min

let current: Units = 'metric';

export function setUnits(u: Units) {
  current = u;
}
export function getUnits(): Units {
  return current;
}

/** m/s → km/h or knots */
export const speedOf = (ms: number, u = current) => ms * (u === 'imperial' ? KT : KMH);
export const speedUnit = (u = current) => (u === 'imperial' ? 'kt' : 'km/h');
export const fmtSpeed = (ms: number, u = current) => `${Math.round(speedOf(ms, u))} ${speedUnit(u)}`;

/** m → m or ft */
export const altOf = (m: number, u = current) => (u === 'imperial' ? m * FT : m);
export const altUnit = (u = current) => (u === 'imperial' ? 'ft' : 'm');
/** altitude rounded for a plan: 10 m or 100 ft */
export const fmtAltRounded = (m: number, u = current) => {
  const step = u === 'imperial' ? 100 : 10;
  return `${Math.round(altOf(m, u) / step) * step} ${altUnit(u)}`;
};
/** a short length on the ground (take-off run): 10 m or 50 ft steps */
export const fmtRun = (m: number, u = current) => {
  const step = u === 'imperial' ? 50 : 10;
  return `${Math.round(altOf(m, u) / step) * step} ${altUnit(u)}`;
};

/** m/s → m/s or ft/min */
export const vsOf = (ms: number, u = current) => (u === 'imperial' ? ms * FPM : ms);
export const vsUnit = (u = current) => (u === 'imperial' ? 'ft/min' : 'm/s');
/** vertical speed: 0.1 m/s or 10 ft/min */
export const fmtVs = (ms: number, u = current) =>
  u === 'imperial' ? `${Math.round(vsOf(ms, u) / 10) * 10} ft/min` : `${ms.toFixed(1)} m/s`;

/** signed vertical speed without the unit: '+2.3' / '−1.0' (m/s) or '+450' / '−120' (ft/min) */
export const vsValue = (ms: number, u = current) => {
  const v = u === 'imperial' ? Math.round(vsOf(ms, u) / 10) * 10 : Math.round(ms * 10) / 10;
  const mag = u === 'imperial' ? String(Math.abs(v)) : Math.abs(v).toFixed(1);
  return v > 0 ? `+${mag}` : v < 0 ? `−${mag}` : mag;
};

/** m → km or nautical miles */
export const distOf = (m: number, u = current) => m / (u === 'imperial' ? 1852 : 1000);
export const distUnit = (u = current) => (u === 'imperial' ? 'nm' : 'km');
export const fmtDist = (m: number, u = current) => `${distOf(m, u).toFixed(1)} ${distUnit(u)}`;
