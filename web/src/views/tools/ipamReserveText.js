/**
 * ipamReserveText.js — IPAM 예약 만료일 표시·폼 되읽기(v2.631, 감사 R2631-02·A6-2631-02).
 *
 * 서버(ipam/overrides.js reservedUntilIso)는 날짜 입력 'YYYY-MM-DD' 를 **포탈 오프셋 기준 그 날 끝 = 다음 날 00:00** 으로
 * 저장한다. 예전 화면은 그 ISO 를 slice(0,10)(UTC 날짜)로 폼에 되채우고, 목록 툴팁은 브라우저 시간대로 보였다 —
 * 오프셋 ≤ 0 현장에서는 다른 칸만 고쳐 저장해도 만료가 하루씩 늘었고, 기본(KST)에서도 툴팁이 다음 날로 보였다.
 * 여기서는 서버 reservedUntilDay 와 같은 식(저장 시각 − 1ms 의 포탈 날짜)을 쓴다. 오프셋은 서버가 주는 tzOffsetMin 이고,
 * 없으면 서버 기본(540 = KST)이다.
 */
export const DEFAULT_TZ_OFFSET_MIN = 540;

function offsetOf(offsetMin) {
  if (offsetMin == null || offsetMin === '') return DEFAULT_TZ_OFFSET_MIN;
  const n = Number(offsetMin);
  return Number.isFinite(n) ? n : DEFAULT_TZ_OFFSET_MIN;
}

/** 저장값(ISO 또는 'YYYY-MM-DD') → 'YYYY-MM-DD'(포탈 오프셋 기준 '그 날'). 읽지 못하면 ''. */
export function reservedDayOf(v, offsetMin) {
  if (v == null || v === '') return '';
  const str = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const t = Date.parse(str);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t - 1 + offsetOf(offsetMin) * 60_000);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** 목록 툴팁 문구 — '예약 만료: 2026-10-01 까지'. 값이 없으면 ''. */
export function reservedUntilText(v, offsetMin) {
  const d = reservedDayOf(v, offsetMin);
  return d ? `${d} 까지` : '';
}

/**
 * 단건 저장 본문에서 만료일을 보낼지 — 폼을 연 뒤 **바뀌었을 때만** 보낸다(일괄 적용·새 IP 는 항상).
 * 바뀌지 않았으면 필드를 빼서 서버의 저장값을 그대로 둔다(되읽기가 어긋나도 만료가 흔들리지 않게).
 */
export function reservedFieldForSave(current, loaded, { always = false } = {}) {
  const cur = current || '';
  if (always || cur !== (loaded || '')) return { reservedUntil: cur || null };
  return {};
}
