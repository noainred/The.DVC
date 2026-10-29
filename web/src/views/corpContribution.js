/**
 * views/corpContribution.js — Summary '법인(vCenter)별 기여도' 표와 스토리지 용량 계산(순수 — vitest 로 고정).
 * v2.747: V6 셸 삭제로 version_6/v6Data.js 에서 Summary 가 쓰는 부분만 옮겼다(V6 Overview·서버 메뉴 계산은 함께 지웠다).
 *
 * 정직성 규칙(이 저장소 공통):
 *   · 값이 없으면 0 이 아니라 null('—') 이고 단위를 붙이지 않는다(v2.575).
 *   · 첫 수집 중·연결 불가·비활성 vCenter 를 정상에 섞지 않는다.
 */
import { numOrNull } from '../numOrNull.js';

const n = numOrNull;

/**
 * v2.632(AX1-2632-04·WEB2632-01): '설치 스토리지 용량' — /summary storage.capacityTBAll(미상 DS 포함). 옛 응답(필드 없음)은
 * capacityTB 로 떨어진다. capacityTB 는 v2.631 부터 '사용량을 읽은 DS 만' 이라 용량 표시·프로비저닝 비교에 쓰면 과소다.
 */
export function physStorageTB(st) {
  const all = n(st?.capacityTBAll);
  return all != null ? all : n(st?.capacityTB);
}
export const CONTRIB_KEYS = Object.freeze(['hosts', 'vms', 'cpuCores', 'memTotalGB', 'storageTotalTB', 'vcpuAllocated', 'ramAllocatedGB', 'provisionedTB', 'powerKw']);
const VC_STATUS_LABEL = { pending: '첫 수집 중', unreachable: '연결 불가', disabled: '비활성', maintenance: '점검 중' };
/** 연결되지 않은 vCenter 상태 라벨 — status 가 없으면(옛 응답) null(연결로 본다). */
export function vcStatusLabel(status) {
  if (status == null || status === '' || status === 'connected') return null;
  return VC_STATUS_LABEL[status] || String(status);
}

/**
 * 법인(vCenter)별 기여도 표 + 합계 행.
 * v2.628 WEB2628-02: 서버는 첫 수집 중·연결 불가·비활성 vCenter 행을 **0 으로 채워** 보낸다(inventory.js bucket 초기값).
 * 그 0 은 값이 아니라 '모른다' 이므로 행의 수치를 null 로 바꾸고(`statusLabel` 로 상태를 말한다) 합계에서 뺀 뒤,
 * 뺀 행 수(`excluded`)와 키별 못 읽은 행 수(`missing`)를 돌려준다 — 부분 합을 '합계' 라고만 말하지 않는다.
 * v2.629 A1-2629-02: 상태만으로 지우지 않는다 — 점검 중(maintenance) vCenter 는 store 가 직전 수집 인벤토리를 스냅샷에
 * 유지하고, 연결 불가(unreachable)도 LASTGOOD 보존 창 안이면 직전 인벤토리를 이월한다. 그 값은 **실제로 있는 값**이고
 * 서버 /summary 상단 합계(counts.hosts 등)에도 들어 있으므로 여기서 지우면 같은 화면의 타일과 합계가 어긋난다.
 * 그래서 값이 없는 행만 null 이다 — 첫 수집 중·비활성, 그리고 호스트·VM 이 둘 다 0 인 연결 불가(보존 창 밖 — 인벤토리 비움).
 * 점검 중·이월 행은 값을 두고 합계에 포함하되 '직전 값' 라벨을 붙이고 개수(`carried`)를 밝힌다.
 */
const VALUELESS_STATUS = new Set(['pending', 'disabled']);
export function contribRowKind(r) {
  const st = r?.status;
  if (st == null || st === '' || st === 'connected') return 'live';
  if (VALUELESS_STATUS.has(st)) return 'none';
  // v2.630 R2630-02: 점검 중도 연결 불가와 같은 규칙이다 — store 는 인메모리 캐시(vcCache)에 직전 인벤토리가 있을 때만
  // 값을 유지하고, 없으면(중앙 재시작 직후·등록 직후 점검) 호스트·VM 없이 상태만 싣는다. 그 0 을 '직전 값' 이라 부르면 거짓이다.
  if (st === 'maintenance' || st === 'unreachable') {
    const h = n(r?.hosts), v = n(r?.vms);
    return (h || 0) > 0 || (v || 0) > 0 ? 'carried' : 'none';
  }
  return 'none'; // 모르는 상태 — 값을 믿지 않는다
}
export function corpContribution(s) {
  const src = Array.isArray(s?.byVcenter) ? s.byVcenter : [];
  let excluded = 0, carried = 0;
  const rows = src.map((r) => {
    const kind = contribRowKind(r);
    const base = vcStatusLabel(r?.status);
    if (kind === 'live') return { ...r, statusLabel: null, carried: false };
    if (kind === 'carried') { carried += 1; return { ...r, statusLabel: `${base} · 직전 값`, carried: true }; }
    excluded += 1;
    const out = { ...r, statusLabel: base, carried: false };
    for (const k of CONTRIB_KEYS) out[k] = null;
    return out;
  });
  const total = {}, missing = {};
  for (const k of CONTRIB_KEYS) {
    const vals = rows.map((r) => n(r[k])).filter((v) => v != null);
    total[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    missing[k] = rows.length - vals.length;
  }
  // v2.632(WEB2632-01): 행의 storageTotalTB 는 사용량을 읽은 DS 만이다 — 뺀 DS 수를 합해 표가 그 사실을 말하게 한다.
  const dsUnknown = rows.reduce((t, r) => t + (r.statusLabel && !r.carried ? 0 : (n(r.datastoresUsageUnknown) || 0)), 0);
  return { rows, total, excluded, carried, missing, dsUnknown };
}

/** v2.632(WEB2632-01): 기여도 표 스토리지 셀의 짧은 표지 — 사용량 미상 DS 가 있으면 '미상 N'. 없으면 ''. */
export function dsUnknownMark(r) {
  const k = n(r?.datastoresUsageUnknown);
  return k != null && k > 0 ? `미상 ${k}` : '';
}

/** 기여도 표 머리말 안내(v2.629) — 뺀 행과 직전 값 행을 나눠 말한다. 둘 다 없으면 ''. */
export function contribNote(c) {
  const parts = [];
  if (c?.excluded > 0) parts.push(`첫 수집 중·점검 중·연결 불가(보관 인벤토리 없음)·비활성 ${c.excluded}곳은 값을 모르므로 합계에서 뺐습니다`);
  if (c?.carried > 0) parts.push(`점검 중·연결 불가 ${c.carried}곳은 직전 수집 값을 합계에 포함했습니다`);
  // v2.720(감사 B1-04): 서버가 전력 보고 호스트 없는 vCenter 의 powerKw 를 null 로 준다 — 그 수를 따로 말한다(뺀 행 제외).
  const pwMissing = (Number(c?.missing?.powerKw) || 0) - (Number(c?.excluded) || 0);
  if (pwMissing > 0) parts.push(`전력 열은 전력을 보고하는 호스트가 없는 ${pwMissing}곳을 합계에서 뺐습니다`);
  if (c?.dsUnknown > 0) parts.push(`스토리지 열은 사용량을 읽은 데이터스토어만 합했습니다(사용량 미상 ${c.dsUnknown}개 제외)`);
  return parts.join(' · ');
}
/** 합계 행 라벨. */
export function contribTotalLabel(c) {
  const bits = [];
  if (c?.excluded > 0) bits.push(`${c.excluded}곳 제외`);
  if (c?.carried > 0) bits.push(`직전 값 ${c.carried}곳 포함`);
  return bits.length ? `합계(${bits.join(' · ')})` : '합계';
}
