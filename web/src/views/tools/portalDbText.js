/**
 * views/tools/portalDbText.js — 포탈 DB 화면의 용량·예측 문구(순수, v2.674).
 * 서버 `insights/portalDb.js forecastFrom` 이 `available`·`in1d`~`in1y`·`reason` 을 주고, 화면은 그 값만 그린다.
 * 예측이 없으면 숫자를 지어내지 않는다('—') — 0 B 나 '+0 B/일' 은 '증가 없음' 으로 읽힌다.
 */

/** 바이트를 사람이 읽는 단위로. 음수는 부호를 떼고 단위를 고른 뒤 붙인다(v2.620 WEB2620-07). */
export function fmtBytes(b) {
  if (b == null || b === '' || !Number.isFinite(Number(b))) return '—';
  const raw = Number(b);
  const sign = raw < 0 ? '-' : '';
  const n = Math.abs(raw);
  if (n < 1024) return `${sign}${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${sign}${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** 예측 칸 값 — 예측이 없으면 '—'. */
export function fcText(fc, key) {
  return fc?.available && fc[key] != null ? fmtBytes(fc[key]) : '—';
}

/** 일 증가량 — 예측이 없거나 값이 없으면 '—', 있으면 부호를 붙인다. */
export function perDayText(perDay, fc) {
  if (!fc?.available || perDay == null || !Number.isFinite(Number(perDay))) return '—';
  const n = Number(perDay);
  if (n === 0) return '변화 없음';
  return `${n > 0 ? '+' : ''}${fmtBytes(n)}/일`;
}

/** 합계 예측의 근거 문구 — 파일들이 일 표본 기울기를 쓰는지(재시작에도 이어지는 값) 최근 표본 차이인지. */
export function basisText(report) {
  const files = Array.isArray(report?.files) ? report.files : [];
  const daily = files.filter((f) => f?.trend?.basis === 'daily').length;
  const recent = files.filter((f) => f?.trend?.basis === 'recent' && f?.trend?.perDayBytes != null).length;
  if (daily && !recent) return '일 표본 기울기(최근 30일)';
  if (daily) return `일 표본 ${daily}개 · 최근 표본 ${recent}개`;
  return '최근 표본 차이(관측 짧음)';
}
