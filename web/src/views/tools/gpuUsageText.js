/**
 * GPU 사용 표시 문구(v2.650 — 사용률·메모리 할당/사용·온도·동작 판정). 순수 함수 — vitest 가 고정한다.
 * 판정은 서버(gpu/activity.js)가 하고 이 모듈은 **읽기만** 한다. 값이 없으면 단위를 붙이지 않는다('— ℃' 는 0 처럼 읽힌다).
 */
import { numOrNull } from '../../numOrNull.js';

export const ACTIVITY_TEXT = Object.freeze({
  busy: { short: '연산', label: '연산 중', tone: 'green', title: '사용률이 기준 이상 — GPU 가 연산을 하고 있습니다' },
  held: { short: '점유', label: '메모리 점유·유휴', tone: 'amber', title: 'VRAM 은 잡고 있지만 연산은 거의 없습니다(모델을 올려 두고 요청이 없는 서버 등) — 할당을 줄이거나 회수할 후보' },
  idle: { short: '유휴', label: '유휴', tone: 'gray', title: '연산도 메모리 점유도 거의 없습니다' },
  unknown: { short: '불가', label: '판정 불가', tone: 'gray', title: '사용률을 읽지 못했습니다(게스트 수집 미설정·미수집·MIG) — 정상으로도 유휴로도 세지 않습니다' },
  off: { short: '꺼짐', label: '꺼짐', tone: 'gray', title: 'VM 전원이 꺼져 있어 게스트에서 읽을 수 없습니다(vGPU 는 꺼지면 프레임버퍼를 잡지 않습니다)' },
});
export const activityOf = (s) => ACTIVITY_TEXT[s] || ACTIVITY_TEXT.unknown;

const gb1 = (mb) => (mb / 1024 >= 100 ? Math.round(mb / 1024) : Math.round((mb / 1024) * 10) / 10);

/** '42 / 160 GB' — 둘 중 하나라도 없으면 '—'. */
export function memText(usedMB, totalMB) {
  const u = numOrNull(usedMB); const t = numOrNull(totalMB);
  if (u == null || t == null || t <= 0) return '—';
  return `${gb1(u)} / ${gb1(t)} GB`;
}
export function gbText(gb) { const n = numOrNull(gb); return n == null ? '—' : `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10} GB`; }
export function tempText(c) { const n = numOrNull(c); return n == null ? '—' : `${Math.round(n)}℃`; }

/**
 * 호스트의 GPU 메모리 할당 문구. vGPU 는 프로파일 합(GB), 패스스루는 한 장 통째라 '장' 으로 말한다.
 * 용량이 모델명 추정이면 그 사실을 붙인다.
 */
export function allocText(h) {
  if (!h) return '—';
  const parts = [];
  // v2.657: 할당률의 분모는 명목 용량(allocCapacityGB — 모델명 기준)이다. 없으면(구버전 서버) 보고 용량.
  const cap = numOrNull(h.allocCapacityGB) ?? numOrNull(h.capacityGB);
  const a = numOrNull(h.allocGB);
  if (a != null) parts.push(`vGPU ${gbText(a)}${cap ? ` / ${gbText(cap)}` : ''}${numOrNull(h.allocPct) != null ? ` (${h.allocPct}%)` : ''}`);
  if (numOrNull(h.passthroughOn) > 0) parts.push(`패스스루 ${h.passthroughOn}장`);
  if (numOrNull(h.allocUnknown) > 0) parts.push(`프로파일 해석 불가 ${h.allocUnknown}대`);
  return parts.length ? parts.join(' · ') : '할당 없음(켜진 GPU VM 없음)';
}

/**
 * 할당 칸 툴팁(v2.657) — 분모가 무엇인지 말한다. vCenter 는 A40(명목 48GB)을 45GB 로 보고하는데 vGPU 프로파일은
 * 명목 단위(24Q = 24GB)라, 보고값으로 나누면 카드 최대 구성이 107% '초과' 로 보였다. 두 값이 다르면 둘 다 적는다.
 */
export function allocTitle(h) {
  if (!h || numOrNull(h.allocGB) == null) return '';
  const nom = numOrNull(h.allocCapacityGB); const rep = numOrNull(h.capacityGB);
  const bits = ['할당 = 켜진 VM 의 vGPU 프로파일 크기 합(vCenter 설정값 — 게스트 수집과 무관)'];
  if (h.allocCapacityBasis === 'nominal' && nom != null) {
    bits.push(`할당률 분모 = GPU 모델 명목 용량 ${gbText(nom)}${rep != null && rep !== nom ? ` (vCenter 보고 용량은 ${gbText(rep)} — 명목보다 작게 보고됩니다. 예약분으로 추정)` : ''}`);
  } else if (nom != null) bits.push(`할당률 분모 = vCenter 가 보고한 GPU 메모리 ${gbText(nom)}`);
  if (numOrNull(h.allocPct) > 100) bits.push('100% 를 넘습니다 — vGPU 는 프레임버퍼를 나눠 주는 방식이라 실제로 넘길 수 없으므로 프로파일 해석이나 모델 용량 추정이 어긋났을 수 있습니다.');
  return bits.join('\n');
}

/** 용량 출처 각주 — 패스스루는 모델명으로 추정한다. */
export function capacityNote(h) {
  if (!h || numOrNull(h.capacityGB) == null) return 'GPU 메모리 용량을 알 수 없습니다(모델명에서 용량을 찾지 못함).';
  return h.capacityEstimated ? '용량은 GPU 모델명으로 추정한 값입니다(패스스루 GPU 는 vCenter 가 메모리 크기를 주지 않습니다).' : '용량은 vCenter 가 보고한 값입니다.';
}

/** 게스트 수집 범위 문구 — 사용량·온도는 켜진 VM 중 수집된 것만이다. */
export function coverageText(h) {
  if (!h) return '';
  const on = numOrNull(h.vmsOn) ?? 0; const read = numOrNull(h.vmsRead) ?? 0;
  if (!on) return '켜진 GPU VM 이 없어 사용량·온도를 읽을 대상이 없습니다.';
  if (!read) return `켜진 GPU VM ${on}대 중 게스트 수집값이 없습니다 — 설정 › GPU 게스트 수집에서 계정을 등록하면 사용량·온도가 표시됩니다.`;
  return read < on ? `사용량·온도는 켜진 GPU VM ${on}대 중 **${read}대**의 게스트 수집값입니다(나머지 ${on - read}대는 미수집 — 합계에서 빠졌습니다).` : `사용량·온도는 켜진 GPU VM ${on}대 전부의 게스트 수집값입니다.`;
}

/** 동작 판정 기준 각주(서버가 준 숫자만 쓴다). */
export function activityRuleNote(rule) {
  if (!rule) return '';
  return `동작 판정: 사용률 ${rule.busyUtilPct}% 이상 = 연산 중 · 그 아래이면서 메모리 점유 ${rule.heldMemPct}% 이상 = 메모리 점유·유휴. 온도는 판정에 쓰지 않고 근거로 함께 보여 줍니다(모델·냉각마다 정상 범위가 달라 임계를 정하지 않습니다).`;
}

/** 상태 개수 한 줄 — 0 인 상태는 생략, 전부 0 이면 ''. short=true 는 표 칸용 짧은 표기(연산 3 · 점유 1). */
export function activitySummary(a, { short = false } = {}) {
  if (!a) return '';
  return ['busy', 'held', 'idle', 'unknown'].filter((k) => numOrNull(a[k]) > 0).map((k) => `${short ? ACTIVITY_TEXT[k].short : ACTIVITY_TEXT[k].label} ${a[k]}`).join(' · ');
}

/**
 * v2.680 D-02: 호스트 GPU 온도·메모리 칸의 출처 문구. v2.653 부터 게스트 값이 없으면 서버가 ESXi 카운터로 채우고
 * tempSource·memSource 로 밝힌다 — 그것을 '게스트 nvidia-smi' 라 적으면 거짓이다(엣지·미수집 현장이 바로 그 경우다).
 */
export function tempSubText(h) {
  if (!h || numOrNull(h.tempC) == null) return '게스트·ESXi 수집값 없음';
  return h.tempSource === 'esxi' ? 'ESXi gpu.temperature(게스트 값 없음)' : '게스트 nvidia-smi';
}
export function memSubText(h) {
  if (!h || (numOrNull(h.memUsedMB) == null && numOrNull(h.memUsedPct) == null)) return '게스트·ESXi 수집값 없음';
  if (h.memSource === 'esxi') return 'ESXi 성능 카운터(게스트 값 없음)';
  const n = numOrNull(h.memVms);
  return n == null ? '게스트 nvidia-smi 합' : `켜진 VM ${n}대 합`;
}

/**
 * 메모리 사용 칸 본문 — 'used / total GB' → 퍼센트만 → 사용량만 → '—' 순. 값이 없는 것에 단위·'%' 를 붙이지 않는다
 * ('null%' · '— (%)' 금지 — v2.680 D-02).
 */
export function memMainText(usedMB, totalMB, pct) {
  if (numOrNull(usedMB) != null && numOrNull(totalMB) != null && numOrNull(totalMB) > 0) return memText(usedMB, totalMB);
  if (numOrNull(pct) != null) return `${numOrNull(pct)}%`;
  if (numOrNull(usedMB) != null) return `${gb1(numOrNull(usedMB))} GB 사용(용량 모름)`;
  return '—';
}
/** 본문이 'used / total' 일 때만 붙이는 퍼센트 꼬리 — 퍼센트가 없으면 ''. */
export function memPctSuffix(usedMB, totalMB, pct) {
  const p = numOrNull(pct);
  if (p == null) return '';
  return (numOrNull(usedMB) != null && numOrNull(totalMB) != null && numOrNull(totalMB) > 0) ? ` (${p}%)` : '';
}
