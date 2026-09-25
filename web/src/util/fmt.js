/**
 * util/fmt.js — 공용 표시 포맷터(v2.319, 모듈화 감사 #9).
 *
 * Insights.jsx 의 전력/에너지/CO2/시각 포맷터와 PortalBackup·DavinciChecks 에 복붙돼 있던
 * fmtBytes 를 한곳으로 통합한다.
 *
 * v2.613 WEB2613-03 / DEPS2613-11: `fmtBytes` 는 `numOrNull` 기반이다 — **읽지 못한 값은 `—`**
 * (예전 `if (!n) return '0 B'` 는 null 을 '0 B' 로 둔갑시켰다 — v2.561·v2.575 규약 위반). `0` 은
 * 값이라 `0 B` 그대로다. `vmSeriesText.fmtBytes`·`sanSwitchPerfText.bytesText`·`MetricsSettings`
 * 로컬 사본(셋 다 `Number(b) || 0`)은 이 함수로 합쳤다. `fmtAgo` 는 `relTime.agoText` 의 껍데기다.
 *
 * ⚠ 통합 범위 주의(정직 표기): `tools/PortalDb.jsx`·`storageUnits.formatBytes` 류는 TB 승급이 있어
 * 표기가 다르다 — 이름이 같다고 합치면 표시가 조용히 바뀐다. 동일 의미를 확인한 곳만 옮길 것.
 */
import { numOrNull } from '../numOrNull.js';
import { agoText } from '../views/tools/relTime.js';

/**
 * 상대 시각("N초/분/시간 전") — `relTime.agoText` 에 위임한다(코어는 하나다).
 * 결측(0·null·'')·미래(시계 오차)는 코어 규칙(`—`·`방금`)이고 `opt`(dash·subMinute)로 화면 계약을 지킨다.
 */
export const fmtAgo = (ts, opt) => agoText(ts, Date.now(), opt);

export const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
export const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('ko-KR') : '—');
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
export const dec1 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });

/** 전력(W): 1,000 넘으면 상위 단위(kW→MW→GW). 예: 131,133 W → 131.1 kW. */
export const fmtW = (w) => {
  if (w == null || !Number.isFinite(Number(w))) return '—';
  const a = Math.abs(w);
  if (a >= 1e9) return `${dec1(w / 1e9)} GW`;
  if (a >= 1e6) return `${dec1(w / 1e6)} MW`;
  if (a >= 1e3) return `${dec1(w / 1e3)} kW`;
  return `${Math.round(w).toLocaleString()} W`;
};

/** 에너지(입력 kWh): 1,000 넘으면 MWh→GWh. 예: 141,623.6 kWh → 141.6 MWh. */
export const fmtWh = (kwh) => {
  if (kwh == null || !Number.isFinite(Number(kwh))) return '—';
  const a = Math.abs(kwh);
  if (a >= 1e6) return `${dec1(kwh / 1e6)} GWh`;
  if (a >= 1e3) return `${dec1(kwh / 1e3)} MWh`;
  return `${dec1(kwh)} kWh`;
};

/** CO2(입력 kg): 1,000 넘으면 t(톤). */
export const fmtKg = (kg) => {
  if (kg == null || !Number.isFinite(Number(kg))) return '—';
  return Math.abs(kg) >= 1e3 ? `${dec1(kg / 1e3)} t` : `${Math.round(kg).toLocaleString()} kg`;
};

/**
 * 바이트 → 사람이 읽는 크기(GB 상한 — TB 미승급은 원본 동작).
 * 읽지 못한 값(null·''·NaN·비수치)은 `dash`(기본 `—`)다 — 0 으로 둔갑시키지 않는다(v2.613 WEB2613-03).
 */
export const fmtBytes = (n, { dash = '—' } = {}) => {
  const v0 = numOrNull(n);
  if (v0 == null) return dash;
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = v0;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
