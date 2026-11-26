/**
 * idrac/partLife.js — 물리서버 **부품 수명 지표**(v3.51 · 설계 docs/design/bm-feature-proposals ⑧). 순수.
 *
 *  · SSD 잔여 수명: Redfish Drive 표준 속성 `PredictedMediaLifeLeftPercent`(0~100). 인벤토리가 디스크마다 이미 GET 하는 응답에 있다 — **추가 요청 0**.
 *    장비가 값을 주는지는 iDRAC · iLO 판마다 다를 수 있다(실장비로 확인하지 못했다 — 화면이 ‘장비가 보고한 값’ 이라 밝힌다). 못 읽으면 null(0 이 아니다).
 *    HDD 는 이 값이 없다(목록에 넣지 않는다).
 *  · 90일 추세는 이력 저장소가 없어 내지 않는다 — 대신 **같은 서버 · 같은 모델 SSD 의 가운데값보다 크게 낮은 것**을 밝힌다(혼자 빨리 닳는 SSD).
 *  · 메모리 교정 오류: 장비가 DIMM 별 교정 오류 **건수**를 주는지 확인하지 못했다. 대신 하드웨어 이벤트 로그(SEL)의 **교정 오류 경고 기록**을 슬롯별로 센다
 *    (Dell MEM 계열 ‘Correctable memory error rate exceeded for DIMM_B3’ · HPE ‘Corrected Memory Error … Memory Module 3’). 오류 건수 자체가 아니다(화면이 밝힌다).
 *    읽은 기록이 그 기간을 다 덮지 못하면(쪽 상한 · 건너뜀 · 시한) ‘다 셌다’ 고 하지 않는다(covered:false — 0 을 ‘없음’ 으로 단정하지 않게).
 *  · 장애 판정이 아니다 — 장애는 지금처럼 물리 부품 장애가 판정한다. 경계 수(낮음 · 같은 모델 대비 차이)는 이 파일의 상수 하나.
 */
import { numOrNull } from '../util/numOrNull.js';

export const LIFE_LOW_PCT = 10;        // 이 값 이하 — ‘낮음’(교체 계획 대상)
export const LIFE_PEER_GAP = 20;       // 같은 서버 · 같은 모델 SSD 가운데값보다 이만큼(%p) 이상 낮으면 ‘혼자 빨리 닳음’
export const LIFE_PEER_MIN = 2;        // 비교할 다른 SSD 가 이만큼 있어야 비교한다(자기 포함 3)
export const LIFE_ROWS_MAX = 64;       // 화면 줄 상한(요약 수 · 최솟값은 전부에서)
export const MEMCE_DAYS = 30;
export const MEMCE_SLOTS_MAX = 64;

const s = (v) => (typeof v === 'string' ? v.trim() : '');
/** 0~100 의 수만(소수 허용 · 반올림 한 자리). 못 읽음 · 범위 밖 · 수가 아님 → null. */
export function lifePctOf(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = numOrNull(v);
  return n != null && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
}
/**
 * SSD 판정 하나 — 하드웨어 요약(hwSummary.js)도 이것을 쓴다(두 벌이면 요약의 ssd 수와 수명 n 이 어긋났다 — 반증 A14).
 *   매체 ‘SSD’ 이거나 인터페이스 NVMe. 매체를 못 읽은(빈칸) 디스크는 SSD 로도 HDD 로도 세지 않는다(모름).
 */
export function mediaKindOf(d) {
  const m = s(d?.media).toUpperCase();
  if (m === 'SSD') return 'ssd';
  if (m === 'HDD' || m === 'SMR') return 'hdd';
  return '';
}
export const isSsd = (d) => mediaKindOf(d) === 'ssd' || /nvme/i.test(s(d?.protocol));

/**
 * 인벤토리 디스크 목록 → SSD 수명 줄. 디스크를 못 읽었으면(배열이 아님) null · SSD 가 없으면 [].
 * @returns {Array<{ name:string, model:string, gb:number|null, life:number|null, low:boolean, gap:number|null }>|null}
 *   gap = 같은 모델 가운데값 − 이 값(%p · LIFE_PEER_GAP 이상일 때만 · 아니면 null)
 */
export function ssdLifeRows(disks) {
  if (!Array.isArray(disks)) return null;
  // 판정(낮음 · 같은 모델 대비)은 SSD 전부(1,024개까지)로 하고, 줄은 LIFE_ROWS_MAX 개 — 넘치면 **가장 닳은 것부터** 고른다(디버깅 1회차 화면 U5:
  //   앞 64개만 보면 81번째 3% 디스크가 줄에도 머리에도 없었다). 고른 줄은 인벤토리 순서 그대로.
  const ssd = disks.filter((d) => d && typeof d === 'object' && isSsd(d)).slice(0, 1024);
  const rows = ssd.map((d) => {
    const life = lifePctOf(d.lifeLeftPct);
    const gb = numOrNull(d.capacityGB);
    // stale — 수명 값을 읽기 전 판이 저장한 인벤토리(키 자체가 없음). ‘장비가 값을 주지 않음’ 과 가른다(반증 B7)
    return { name: s(d.name).slice(0, 128) || s(d.id).slice(0, 128), model: s(d.model).slice(0, 128), gb: gb != null && gb >= 0 ? gb : null, life, low: life != null && life <= LIFE_LOW_PCT, gap: null, ...(d.lifeLeftPct === undefined ? { stale: true } : {}) };
  });
  const byModel = new Map();
  for (const r of rows) if (r.life != null && r.model) { const g = byModel.get(r.model) || []; g.push(r); byModel.set(r.model, g); }
  // 자기를 뺀 가운데값 — 한 번 정렬하고 자리 계산으로(예전에는 줄마다 나머지를 다시 정렬해 SSD 1,024개에 O(n² log n) · 113ms — 디버깅 2회차 성능 Q7)
  for (const g of byModel.values()) {
    if (g.length < LIFE_PEER_MIN + 1) continue;
    const sorted = g.map((r, j) => [r.life, j]).sort((a, b) => a[0] - b[0]);
    const pos = new Array(g.length); sorted.forEach((x, k) => { pos[x[1]] = k; });
    const m = g.length - 1;   // 자기를 뺀 수
    g.forEach((r, j) => {
      const i = pos[j]; const at = (k) => sorted[k < i ? k : k + 1][0];
      const med = m % 2 ? at(m >> 1) : (at(m / 2 - 1) + at(m / 2)) / 2;
      const gap = Math.round((med - r.life) * 10) / 10;
      if (gap >= LIFE_PEER_GAP) r.gap = gap;
    });
  }
  if (rows.length <= LIFE_ROWS_MAX) return rows;
  const rank = (r) => (r.low ? 0 : r.gap != null ? 1 : r.life != null ? 2 : 3);
  const keep = new Set(rows.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0].life ?? 101) - (b[0].life ?? 101) || a[1] - b[1]).slice(0, LIFE_ROWS_MAX).map((x) => x[1]));
  return rows.filter((_, i) => keep.has(i));
}
/** 요약(목록 · 엣지 push) — SSD 가 없으면 null. { n: SSD 수, read: 값을 읽은 수, min: 가장 낮은 값|null }. 줄 상한과 관계없이 **전부**에서 센다(반증 A15). */
export function lifeSummaryOf(disks) {
  if (!Array.isArray(disks)) return null;
  const ssd = disks.filter((d) => d && typeof d === 'object' && isSsd(d));
  if (!ssd.length) return null;
  const vals = ssd.map((d) => lifePctOf(d.lifeLeftPct)).filter((x) => x != null);
  return { n: Math.min(ssd.length, 1024), read: Math.min(vals.length, 1024), min: vals.length ? Math.min(...vals) : null };
}

// ───────── 메모리 교정 오류 경고(SEL) ─────────
// 교정 오류 경고로 보는 문구(대소문자 무시 · 길이는 이미 잘린 글자 — 선형). ‘uncorrectable’ 은 교정 오류가 아니다(먼저 거른다).
//   ‘교정 · 교정됨’ 바로 뒤에 (memory)(ECC) error 가 와야 한다 — ‘Memory configuration error corrected after reboot’ 같은 설정 문구를 세지 않게(반증 A19).
//   Dell ‘Correctable memory error rate exceeded …’ · HPE ‘Corrected Memory Error threshold exceeded …’ 꼴(실장비 문구 표본으로 확인하지 못했다 — 기억 · 문서 요약 기준).
const CE_RE = /\b(?:correctable|corrected)\s{1,3}(?:memory\s{1,3})?(?:ecc\s{1,3})?errors?\b/i;
const UNCORR_RE = /\buncorrect/i;
/**
 * SEL 글자에서 DIMM 위치를 뽑는다. Dell ‘DIMM_B3’ · ‘DIMM B3’ · ‘DIMM.Socket.B3’ → ‘B3’ / HPE ‘Processor 1, Memory Module 3’ → ‘P1-M3’. 모르면 ''.
 */
export function dimmSlotOf(msg) {
  const m = String(msg ?? '').slice(0, 300);
  const d = /\bDIMM[ _.]?(?:Socket\.)?([A-Z]\d{1,2})\b/i.exec(m);
  if (d) return d[1].toUpperCase();
  const h = /\b(?:Processor|CPU)\s{0,3}(\d{1,2})\s{0,3},\s{0,3}(?:Memory\s{0,3}Module|DIMM)\s{0,3}(\d{1,2})\b/i.exec(m);
  if (h) return `P${h[1]}-M${h[2]}`;
  const sl = /\bSlot\s{0,3}(\d{1,2})\s{0,3},\s{0,3}Memory\s{0,3}Module\s{0,3}(\d{1,2})\b/i.exec(m);
  if (sl) return `S${sl[1]}-M${sl[2]}`;
  return '';
}
export const isMemCeRow = (r) => !!r && typeof r === 'object' && !UNCORR_RE.test(String(r.msg ?? '').slice(0, 300)) && CE_RE.test(String(r.msg ?? '').slice(0, 300));
/** 인벤토리 DIMM 위치 → 이벤트 로그와 같은 꼴(‘DIMM.Socket.A1’ · ‘A1’ → ‘A1’). 모르면 ''. */
export function dimmLocatorKey(v) {
  const x = s(v).slice(0, 64);
  const m = /(?:^|[ _.])([A-Z]\d{1,2})$/i.exec(x) || /^([A-Z]\d{1,2})$/i.exec(x);
  return m ? m[1].toUpperCase() : '';
}

/**
 * 이벤트 로그 줄(가장 새 것부터 · at = ms|null) → 지난 MEMCE_DAYS 일 슬롯별 교정 오류 경고 기록 수.
 * @param {object} log  /hwlog 결과(status · rows · stopped · gap · total · read)
 * @param {{ now?:number, dimms?:string[] }} o  dimms = 인벤토리 DIMM 위치(있으면 0 인 슬롯도 줄로 — 이 노드 서버만)
 * @returns {{ covered:boolean, days:number, total:number, slots:Array<[string, number]>, unknownSlot:number, oldest:number|null } | null}
 *   covered = 읽은 기록이 기간을 다 덮었는가(장비 전체를 읽었거나 가장 오래된 읽은 기록이 기간 밖) · 못 읽었으면 null
 */
export function memCeOf(log, { now = Date.now(), dimms = [] } = {}) {
  if (!log || typeof log !== 'object' || !Array.isArray(log.rows) || !['ok', 'empty'].includes(log.status)) return null;
  const from = now - MEMCE_DAYS * 86_400_000;
  const rows = log.rows;
  const times = rows.map((r) => numOrNull(r?.at)).filter((x) => x != null);
  const oldest = times.length ? Math.min(...times) : null;
  // 덮음 — 장비가 준 것을 다 읽었고(멈춤 · 건너뜀 없음 · 전체 수 ≤ 읽은 수) 그 안에서 화면 줄(가장 새 HWLOG 300)이 기간을 덮을 때만.
  //   일부만 읽었으면(쪽 상한 · 시한 · 건너뜀) 장비 정렬을 몰라 0 을 ‘없음’ 으로 단정하지 않는다(반증 A9).
  const read = numOrNull(log.read) ?? rows.length; const totalAll = numOrNull(log.total);
  const complete = !log.stopped && !(numOrNull(log.gap) > 0) && (totalAll == null || totalAll <= read);
  const covered = log.status === 'empty' || (complete && (read <= rows.length || (oldest != null && oldest < from)));
  const counts = new Map();
  for (const k of (Array.isArray(dimms) ? dimms : []).map(dimmLocatorKey).filter(Boolean).slice(0, MEMCE_SLOTS_MAX)) counts.set(k, 0);
  let unknownSlot = 0; let total = 0; let untimed = 0; const uslots = new Map();   // 시각 모름 경고의 슬롯(그 슬롯이 0 으로 보이지 않게 — 디버깅 2회차 판정 #6)
  for (const r of rows) {
    const at = numOrNull(r?.at);
    if (!isMemCeRow(r)) continue;
    // 시각을 못 읽은 경고(빈 시각 · 1970 등)는 기간 안인지 모른다 — 세지는 않되 ‘다 셌다’ 고 하지 않는다(디버깅 1회차 판정 #7)
    if (at == null || at < 946_684_800_000) {
      untimed += 1;
      const uk = dimmSlotOf(r.msg);
      if (uk && (uslots.size < MEMCE_SLOTS_MAX || uslots.has(uk))) uslots.set(uk, (uslots.get(uk) || 0) + 1);
      continue;
    }
    if (at < from) continue;
    total += 1;
    const k = dimmSlotOf(r.msg);
    if (!k) { unknownSlot += 1; continue; }
    if (counts.size < MEMCE_SLOTS_MAX || counts.has(k)) counts.set(k, (counts.get(k) || 0) + 1);
    else unknownSlot += 1;   // 슬롯 상한을 넘은 것도 어딘가엔 센다(반증 S4)
  }
  const slots = [...counts].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
  // covered = 기록이 기간을 덮었는가(시각 모름 경고와 따로 — 다 읽었는데 ‘다 읽지 못함’ 이라 쓰지 않게: 디버깅 2회차 화면 D5). 시각 모름은 untimed 로 — 화면이 ‘없음’ 이라 하지 않는다
  return { covered, days: MEMCE_DAYS, total, slots, unknownSlot, oldest, ...(untimed ? { untimed } : {}), ...(uslots.size ? { uslots: [...uslots] } : {}) };
}
