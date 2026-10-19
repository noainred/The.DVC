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
 *  · v2.744(감사 RECENT-02 — v2.743 회귀): 데이터율을 **조금** 넘는 값(`FC_OVER_CLAMP_PCT` 110% 까지)은 **100 으로 표시**하고
 *    `over:true`·`clamped:true`·`raw`(계산값)로 그 사실을 남긴다. 근거 — 이것은 링크 속도 보고가 틀린 것(v2.578 D3·v2.612 COL2612-01
 *    이 null 로 둔 경우)이 아니라 **측정 정의 차이**다: 표준 데이터율은 페이로드 기준이고, 카운터가 프레임 헤더·SOF/EOF·프리미티브까지
 *    세면 선로 속도(16GFC 14.025 Gbaud 64b/66b ≈ 1,700MB/s = 데이터율의 106.25% — 8b/10b 등급도 같은 비율)까지 올라갈 수 있다.
 *    110% 는 그 위에 표본 시각 오차 여유를 둔 값이다. 예전처럼 null 로 두면 가장 바쁜 포트가 대표값(`maxOrNull`)에서 빠져 **다른
 *    포트의 낮은 값이 그 서버의 HBA 사용률**이 되고 임계 알림이 울리지 않았다(16GFC 2포트 1,650·80MB/s → 5%).
 *    조용히 보정하지 않는다 — 행의 `pctOver`·`pctClamped`·`pctRaw` 와 `fcRateNotes` 문구가 화면에 그 사실을 말한다.
 *  · 110% 를 **크게** 넘는 값(선로 속도로도 설명되지 않는다 — 카운터 이상일 수 있다)은 예전처럼 **null** + `over:true` 다. 대신 그런
 *    포트가 하나라도 있으면 서버 대표값을 **다른 포트 값으로 채우지 않는다**(`fcRepresentative` — 대표값 null + `overBlank`, 알림은 초과).
 *  · 명목(nominal) 기준의 100% 초과는 명목 속도 보고가 실제와 다른 것이라 예전대로 null 이다(클램프하지 않는다).
 *    v2.744(회귀 검토 GB-R1): '예전대로' 는 **대표값에도** 그대로다 — 그 포트는 데이터율로 판정한 적이 없으므로 위 '크게 초과'
 *    규칙(대표값 비움 + 알림 초과)에 넣지 않는다(`fcRepresentative` 의 `nominalOver` — 대표값은 나머지 포트, 알림은 초과로 보지 않는다).
 *    예전에는 basis 를 보지 않아 10 Gbit FCoE 포트의 104% 가 'FC 표준 데이터율 초과 … 카운터 이상일 수 있다' 는 critical 알림이 됐다.
 *  · 이더넷 NIC 는 이 모듈을 쓰지 않는다(링크 속도가 곧 데이터율에 가깝다 — 바꾸지 않는다).
 */
import { linkPct } from '../rates.js';
import { numOrNull } from '../../util/numOrNull.js';

/** FC 속도 등급(명목 Gbit) → 방향당 표준 데이터율(MB/s, 1MB = 10^6 바이트). */
export const FC_DATA_RATE_MBPS = Object.freeze({ 1: 100, 2: 200, 4: 400, 8: 800, 16: 1600, 32: 3200, 64: 6400, 128: 12800 });
/** v2.744(RECENT-02): 데이터율 기준 이 값(%)까지는 측정 정의 차이로 보고 100 으로 표시한다(위 머리말). 화면이 이 숫자를 서버에서 받는다. */
export const FC_OVER_CLAMP_PCT = 110;
/**
 * v2.744(감사 DEV-01): 한 방향 처리량의 **물리 상한**(B/s) — 이보다 큰 값은 카운터 이상(재설정 표지·드라이버 오류)이지 처리량이 아니다.
 *   속도를 알면 데이터율(표에 없으면 명목 bit/s ÷ 8) × 2, 모르면 1e12 B/s(128GFC 데이터율 12.8GB/s 의 80배 — 어떤 FC 회선도 닿지 못한다).
 *   ⚠ 2배는 넉넉한 경계다 — 판정(사용률)은 `fcUtilization` 이 하고, 이 상한은 '값으로 저장할 수 없는 것' 만 거른다.
 * v2.744(회귀 검토 GB-R2): 상한은 **처리량을 버리는** 판정이라 근거가 확실한 속도만 쓴다 —
 *   ① 1 Gbit 미만(`FC_MIN_LINE_BPS` — FC 의 가장 낮은 등급 1GFC 보다 낮다)은 FC 회선 속도로 볼 수 없다. iDRAC 텔레메트리 FC 속도는
 *      후보 이름(`linkspeed`·`portspeed`)으로 찾아 Mbps 로 읽는데 단위를 확인하지 못했다 — 'Gbps' 값 16 이 16e6 bit/s 가 되면 상한이
 *      4MB/s 가 되어 정상 처리량 500MB/s 를 '카운터 이상' 으로 버렸다(v2.743 은 처리량을 남겼다). 그런 속도는 '모른다' 와 같이 본다.
 *   ② 직전 표본의 속도도 함께 본다(`prevBitsPerSec` — 큰 쪽) — 주기 중 16G→4G 로 재협상되면 그 주기의 평균 처리량은 4G 상한을 넘을 수 있다.
 *   ③ 어떤 경우에도 속도 미상 상한(1e12)을 넘지 않는다(단위가 큰 쪽으로 틀린 보고가 상한을 무한히 키우지 않게).
 *   사용률(pct·over)은 예전처럼 이번 표본 속도로 판정한다 — 여기서 바꾸는 것은 '저장할 수 없는 값' 의 경계뿐이다.
 */
export const FC_UNKNOWN_SPEED_CAP_BPS = 1e12;
/** v2.744(GB-R2): FC 회선으로 볼 수 있는 가장 낮은 속도(bit/s) — 1GFC. 이보다 낮은 보고는 물리 상한의 근거로 쓰지 않는다. */
export const FC_MIN_LINE_BPS = 1e9;
function capFromSpeed(bitsPerSec) {
  const data = fcDataBytesPerSec(bitsPerSec);
  if (data != null) return data * 2;
  const l = numOrNull(bitsPerSec);
  if (l != null && l >= FC_MIN_LINE_BPS) return (l / 8) * 2;
  return null;   // 모르거나(없음·0) FC 회선 속도로 볼 수 없다
}
export function fcRateCapBps(bitsPerSec, prevBitsPerSec = null) {
  const caps = [capFromSpeed(bitsPerSec), capFromSpeed(prevBitsPerSec)].filter((v) => v != null);
  if (!caps.length) return FC_UNKNOWN_SPEED_CAP_BPS;
  return Math.min(FC_UNKNOWN_SPEED_CAP_BPS, Math.max(...caps));
}
/** 물리 상한 안의 처리량이면 그대로, 넘으면 null(값이 없으면 null). `prevBitsPerSec` = 직전 표본 속도(GB-R2 — 재협상). */
export function fcPlausibleBps(bytesPerSec, bitsPerSec, prevBitsPerSec = null) {
  const b = numOrNull(bytesPerSec);
  if (b == null) return null;
  return b > fcRateCapBps(bitsPerSec, prevBitsPerSec) ? null : b;
}

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
 * @returns {{ pct:number|null, basis:'fc-data-rate'|'nominal'|null, over:boolean, clamped?:boolean, raw?:number }}
 *   basis null = 속도를 모른다(사용률을 내지 않는다) · over = 분모보다 큰 처리량이다 ·
 *   clamped = 데이터율 기준 소폭 초과(`FC_OVER_CLAMP_PCT` 까지)라 100 으로 표시했다(over 이면서 pct 100) ·
 *   over 이면서 pct null = 크게 넘어 비웠다 · raw = 계산한 백분율(over 일 때만 — 화면이 근거로 보인다)
 */
export function fcUtilization(bytesPerSec, bitsPerSec) {
  const b = numOrNull(bytesPerSec);
  const data = fcDataBytesPerSec(bitsPerSec);
  if (data != null) {
    const pct = linkPct(b, data * 8);   // linkPct = B×8 ÷ 분모(bit) — 분모를 데이터율×8 로 주면 B ÷ 데이터율이다(반올림·100% 초과 규칙 공유)
    if (pct != null || b == null || b < 0) return { pct, basis: 'fc-data-rate', over: false };
    // v2.744(RECENT-02): linkPct 와 같은 식·같은 반올림으로 계산값을 다시 낸다(100 이하 판정이 갈리지 않게).
    const raw = Math.round(((b * 8) / (data * 8)) * 1000) / 10;
    if (raw <= FC_OVER_CLAMP_PCT) return { pct: 100, basis: 'fc-data-rate', over: true, clamped: true, raw };
    return { pct: null, basis: 'fc-data-rate', over: true, clamped: false, raw };
  }
  const l = numOrNull(bitsPerSec);
  if (l == null || l <= 0) return { pct: null, basis: null, over: false };
  const pct = linkPct(b, l);
  const over = b != null && b >= 0 && pct == null;
  return over
    ? { pct, basis: 'nominal', over: true, clamped: false, raw: Math.round(((b * 8) / l) * 1000) / 10 }
    : { pct, basis: 'nominal', over: false };
}

/** FC 행 하나에 붙일 사용률 필드(OS·iDRAC 경로가 같은 모양을 쓴다 — 두 벌로 조립하지 않는다). */
export function fcRowPctFields(u = {}) {
  return {
    pct: u.pct ?? null, pctBasis: u.basis ?? null,
    ...(u.over ? { pctOver: true, ...(u.clamped ? { pctClamped: true } : {}), ...(u.raw != null ? { pctRaw: u.raw } : {}) } : {}),
  };
}

/**
 * v2.744(감사 RECENT-02): FC 행 목록 → 서버 대표 사용률. 대표값은 '가장 높은 포트' 다(usage.js 규약).
 *   ⚠ 데이터율을 **크게** 넘어 사용률을 비운 포트(`pctOver` 이고 pct null)가 하나라도 있으면 대표값을 **다른 포트 값으로 채우지
 *   않는다** — 그 포트가 가장 바쁜 포트인데 빠지면 낮은 값이 서버 대표가 된다(오류 없이 틀린 값). 그때 `pct` 는 null 이고
 *   `overBlank` 가 참이다(알림은 초과로 본다 — alertRules `overFlag`). 소폭 초과(100 으로 표시한 포트)는 그대로 최대에 들어간다.
 * v2.744(회귀 검토 GB-R1): 위 규칙은 **데이터율 기준(`pctBasis` 'fc-data-rate')** 포트만이다. 명목 기준 포트의 100% 초과는 데이터율로
 *   판정한 적이 없고(머리말 — 속도 보고가 실제와 다른 것) 'FC 표준 데이터율 초과' 가 아니므로 `nominalOver` 로 따로 센다 —
 *   대표값은 예전대로 나머지 포트의 최대(없으면 null)이고 `overBlank` 를 세우지 않는다(알림 초과 아님). 노트가 그 사실을 말한다.
 * @returns {{ pct:number|null, overBlank:boolean, clamped:number, blanked:number, nominalOver:number }}
 */
export const isNominalOver = (x) => !!(x && x.pctOver && x.pctBasis === 'nominal' && numOrNull(x.pct) == null);
const isRateBlanked = (x) => !!(x && x.pctOver && x.pctBasis !== 'nominal' && numOrNull(x.pct) == null);
export function fcRepresentative(rows = []) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const blanked = list.filter(isRateBlanked).length;
  const nominalOver = list.filter(isNominalOver).length;
  const clamped = list.filter((x) => x.pctOver && numOrNull(x.pct) != null).length;
  if (blanked) return { pct: null, overBlank: true, clamped, blanked, nominalOver };
  let best = null;
  for (const x of list) { const v = numOrNull(x.pct); if (v != null && (best == null || v > best)) best = v; }
  return { pct: best, overBlank: false, clamped, blanked: 0, nominalOver };
}

/**
 * FC 행 목록 → 화면·상태 문구(사유 표지). 조용히 바꾸지 않는다 — 명목 기준·데이터율 초과를 개수로 밝힌다.
 * @param {Array<{bps:number|null, pctBasis?:string|null, pctOver?:boolean, pct?:number|null}>} rows
 * @param {string} label  '' 또는 'iDRAC ' 같은 출처 접두
 * @param {object} [opt]
 * @param {boolean} [opt.usedForRep=true]  v2.744(회귀 검토 GB-R4): 이 행 목록이 서버 대표값을 정했는가. iDRAC 행은 OS 값이 이미 대표면
 *   쓰이지 않는다(usage.js '빈 칸만 채운다') — 그때 '대표값도 비웠다 · 알림은 초과' 라고 적으면 화면 값(OS)과 반대되는 거짓이다.
 */
export function fcRateNotes(rows, label = '', { usedForRep = true } = {}) {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  const nominal = list.filter((x) => x && x.pctBasis === 'nominal' && x.pct != null).length;
  if (nominal) out.push(`${label}FC 표준 데이터율 표에 없는 속도의 HBA ${nominal}개는 명목 속도(Gbit)로 사용률을 냈습니다 — 포화해도 100% 에 못 미칠 수 있습니다.`);
  // v2.744(RECENT-02): 소폭 초과(100 으로 표시)와 크게 초과(비움)를 나눠 말한다 — 조치가 다르다(앞은 정상 포화, 뒤는 카운터 확인).
  const clamped = list.filter((x) => x && x.pctOver && numOrNull(x.pct) != null).length;
  if (clamped) out.push(`${label}FC 표준 데이터율을 조금 넘는(${FC_OVER_CLAMP_PCT}% 까지) 처리량이 나온 HBA ${clamped}개는 사용률을 100% 로 표시했습니다(카운터가 프레임 헤더까지 세는 측정 정의 차이 — 처리량은 그대로입니다).`);
  const blanked = list.filter(isRateBlanked).length;
  if (blanked) {
    out.push(usedForRep
      ? `${label}FC 표준 데이터율의 ${FC_OVER_CLAMP_PCT}% 를 크게 넘는 처리량이 나온 HBA ${blanked}개는 사용률(%)을 비웠고, 그 서버의 HBA 사용률 대표값도 비웠습니다(다른 포트의 낮은 값으로 대표하지 않습니다 — 카운터 이상일 수 있어 처리량을 확인하세요. 임계 알림은 초과로 봅니다).`
      : `${label}FC 표준 데이터율의 ${FC_OVER_CLAMP_PCT}% 를 크게 넘는 처리량이 나온 HBA ${blanked}개는 그 포트의 사용률(%)만 비웠습니다(카운터 이상일 수 있어 처리량을 확인하세요). 서버 HBA 사용률 대표값은 OS 측정으로 정했습니다 — 이 포트 값은 대표값·임계 알림에 쓰지 않았습니다.`);
  }
  // v2.744(회귀 검토 GB-R1): 명목 기준 100% 초과는 데이터율 초과가 아니다 — 속도 보고를 의심하라고 말하고, 대표값이 어떻게 정해졌는지 밝힌다.
  const nomOver = list.filter(isNominalOver).length;
  if (nomOver) {
    const rep = fcRepresentative(list);
    const rest = !usedForRep ? '서버 HBA 사용률 대표값은 OS 측정으로 정했습니다(이 포트 값은 대표값·임계 알림에 쓰지 않았습니다).'
      : rep.overBlank ? '서버 HBA 사용률 대표값은 데이터율을 크게 넘은 다른 포트 때문에 비웠습니다(이 포트 때문에 초과로 보지는 않습니다).'
        : rep.pct != null ? '서버 HBA 사용률 대표값은 그 포트를 뺀 나머지 포트 기준입니다(이 포트는 임계 알림에서 초과로 보지 않습니다).'
          : '나머지 포트에 사용률이 없어 서버 HBA 사용률 대표값은 비웠습니다(판정 보류 — 임계 알림은 초과로 보지 않습니다).';
    out.push(`${label}FC 표준 데이터율 표에 없는 속도라 명목 속도(Gbit)로 나눴는데 100% 를 넘은 HBA ${nomOver}개는 사용률(%)을 비웠습니다(보고된 링크 속도가 실제와 다를 수 있습니다 — 속도 보고를 확인하세요. 처리량은 그대로입니다). ${rest}`);
  }
  return out;
}
