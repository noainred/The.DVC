/**
 * bmusage/parse/fcRate.js — FC HBA 사용률의 분모(순수, v2.743 감사 DEV-03).
 *
 * ── 왜 명목 Gbit 를 분모로 쓰면 안 되는가 ─────────────────────────────────
 * Linux `fc_host/<hostN>/speed` 는 `16 Gbit` 처럼 **명목 속도 등급**을 준다. 그런데 FC 는 회선 부호화(8b/10b·64b/66b)와
 * 프레이밍 때문에 등급 숫자만큼 데이터를 싣지 못한다 — 16GFC 의 표준 데이터율은 방향당 **1,600MB/s** 다. 예전에는
 * `B/s × 8 ÷ 16e9` 로 계산해 그 포트가 **완전히 포화해도 80%** 에서 멈췄다(기본 알림 임계 90% 가 사실상 울리지 않았다).
 *
 * ── 규칙 ─────────────────────────────────────────────────────────────────
 *  · 분모는 아래 표(FC 표준 데이터율, 방향당 · 1MB = 10^6 바이트)다. 대표값(수신·송신 중 큰 쪽)을 그 값으로 나눈다.
 *  · **표에 없는 속도**(10 Gbit FCoE 등)는 예전 명목 계산을 그대로 쓰고 `basis: 'nominal'` 로 밝힌다 — 표를 추측해 늘리지 않는다.
 *  · 100% 를 넘는 값은 예전 규칙대로(`rates.linkPct` — v2.612 COL2612-01·v2.578 D3) **클램프하지 않고 null** 이다. 대신 `over:true`
 *    로 사유를 남긴다 — 카운터가 프레임 헤더까지 세는 드라이버면 데이터율을 조금 넘을 수 있다(⚠ 실장비 미확인 — 추정).
 *  · 이더넷 NIC 는 이 모듈을 쓰지 않는다(링크 속도가 곧 데이터율에 가깝다 — 바꾸지 않는다).
 */
import { linkPct } from '../rates.js';
import { numOrNull } from '../../util/numOrNull.js';

/** FC 속도 등급(명목 Gbit) → 방향당 표준 데이터율(MB/s, 1MB = 10^6 바이트). */
export const FC_DATA_RATE_MBPS = Object.freeze({ 1: 100, 2: 200, 4: 400, 8: 800, 16: 1600, 32: 3200, 64: 6400, 128: 12800 });

/**
 * 명목 속도(bit/s) → 표준 데이터율(바이트/초). 표에 없는 등급이면 null.
 * @param {number|null} bitsPerSec  `16 Gbit` → 16e9
 */
export function fcDataBytesPerSec(bitsPerSec) {
  const b = numOrNull(bitsPerSec);
  if (b == null || b <= 0) return null;
  const g = b / 1e9;
  const key = Math.round(g);
  if (Math.abs(g - key) > 1e-6) return null;
  const mb = FC_DATA_RATE_MBPS[key];
  return mb ? mb * 1e6 : null;
}

/**
 * FC 포트 사용률(%) — 분모는 표준 데이터율(표에 있으면) 또는 명목 속도.
 * @param {number|null} bytesPerSec  대표 방향의 처리량(B/s)
 * @param {number|null} bitsPerSec   명목 속도(bit/s)
 * @returns {{ pct:number|null, basis:'fc-data-rate'|'nominal'|null, over:boolean }}
 *   basis null = 속도를 모른다(사용률을 내지 않는다) · over = 분모보다 큰 처리량이라 사용률을 비웠다
 */
export function fcUtilization(bytesPerSec, bitsPerSec) {
  const b = numOrNull(bytesPerSec);
  const data = fcDataBytesPerSec(bitsPerSec);
  if (data != null) {
    const pct = linkPct(b, data * 8);   // linkPct = B×8 ÷ 분모(bit) — 분모를 데이터율×8 로 주면 B ÷ 데이터율이다(반올림·100% 초과 규칙 공유)
    return { pct, basis: 'fc-data-rate', over: b != null && b >= 0 && pct == null };
  }
  const l = numOrNull(bitsPerSec);
  if (l == null || l <= 0) return { pct: null, basis: null, over: false };
  const pct = linkPct(b, l);
  return { pct, basis: 'nominal', over: b != null && b >= 0 && pct == null };
}

/**
 * FC 행 목록 → 화면·상태 문구(사유 표지). 조용히 바꾸지 않는다 — 명목 기준·데이터율 초과를 개수로 밝힌다.
 * @param {Array<{bps:number|null, pctBasis?:string|null, pctOver?:boolean, pct?:number|null}>} rows
 * @param {string} label  '' 또는 'iDRAC ' 같은 출처 접두
 */
export function fcRateNotes(rows, label = '') {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  const nominal = list.filter((x) => x && x.pctBasis === 'nominal' && x.pct != null).length;
  if (nominal) out.push(`${label}FC 표준 데이터율 표에 없는 속도의 HBA ${nominal}개는 명목 속도(Gbit)로 사용률을 냈습니다 — 포화해도 100% 에 못 미칠 수 있습니다.`);
  const over = list.filter((x) => x && x.pctOver).length;
  if (over) out.push(`${label}FC 표준 데이터율을 넘는 처리량이 나온 HBA ${over}개는 사용률(%)을 비웠습니다(카운터가 프레임 헤더까지 셀 수 있습니다 — 처리량은 그대로입니다).`);
  return out;
}
