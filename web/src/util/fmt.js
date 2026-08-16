/**
 * util/fmt.js — 공용 표시 포맷터(v2.319, 모듈화 감사 #9).
 *
 * Insights.jsx 의 전력/에너지/CO2/시각 포맷터와 PortalBackup·DavinciChecks 에 복붙돼 있던
 * fmtBytes 를 한곳으로 통합한다(기능 무변 — 본문은 원본 그대로 이동).
 *
 * ⚠ 통합 범위 주의(정직 표기): 다른 뷰들의 유사 헬퍼(예: tools/PortalDb.jsx 의 fmtBytes)는
 * **의미가 다르다**(null→'—'·TB 지원 vs 여기 것은 falsy→'0 B'·GB 상한). 이름이 같다고 여기로
 * 합치면 표시가 조용히 바뀐다 — 동일 구현임을 확인한 곳만 이 모듈로 옮길 것.
 */

/** 상대 시각("N초/분/시간 전"). 서버-브라우저 시계 오차로 음수("-12초 전")가 되지 않게 clamp. */
export const fmtAgo = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

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

/** 바이트(falsy→'0 B', GB 상한) — PortalBackup/DavinciChecks 복붙 통합본(원문 그대로). */
export const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
