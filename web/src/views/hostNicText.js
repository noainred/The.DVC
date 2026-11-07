// v2.925(B-③ — 시안 san-cvp-traffic §4.2·§4.3): 호스트 vmnic 드롭·에러(/hosts/:id/nic-stats — vCenter 실시간 최근 1시간) 문구 · 판정(순수).
//   '어느 쪽 드롭인가' 는 ESXi 쪽과 스위치(CVP) 쪽 값이 **같은 창(최근 1시간)에 둘 다** 있을 때만 판정한다(시안 §4.2). 방향은 짝을 맞춘다 —
//     서버 수신(스위치 → 서버) = 스위치 Out 드롭 ↔ ESXi droppedRx · 서버 송신(서버 → 스위치) = 스위치 In 드롭 ↔ ESXi droppedTx.
//   못 읽은 값·결측이 섞인 0 은 '없음' 이 아니다 — 판정을 보류한다(numOrNull 규약).
import { numOrNull } from '../numOrNull.js';
import { uplinksByNic, portLabel } from './hostNetText.js';

/** 개수 → '1,234' · 못 읽음 → '—'. */
export function countText(v) {
  const n = numOrNull(v);
  return n == null ? '—' : n.toLocaleString('en-US');
}

/** 한 행의 한 키(droppedRx…) 셀 — 결측이 섞였으면 '(일부)' 를 붙이고 이유를 title 로. */
export function countCell(row, key) {
  const v = numOrNull(row?.[key]);
  if (v == null) return { text: '—', title: 'vCenter 가 이 계열을 돌려주지 않았습니다', partial: false };
  const valid = numOrNull(row?.valid?.[key]);
  const total = numOrNull(row?.samples);
  const partial = valid != null && total != null && total > 0 && valid < total;
  return { text: `${v.toLocaleString('en-US')}${partial ? ' (일부)' : ''}`, title: partial ? `값이 있는 표본 ${valid} / ${total}개만 더했습니다(수집 공백은 0 으로 세지 않습니다)` : `20초 표본 ${total ?? '—'}개 합`, partial };
}

/**
 * 한 방향 판정. esxi·sw 는 그 방향의 드롭 수(못 읽음 null), *Partial 은 결측이 섞였는가.
 *   결측이 섞인 0 은 '없음' 이라 말할 수 없어 못 읽음과 같이 다룬다(0 보다 크면 그 드롭은 실제로 있었다).
 * @returns {{ side: 'esxi'|'switch'|'both'|'none'|'unknown', text: string, tone: string, why?: string }}
 */
export function sideVerdict(esxi, sw, { esxiPartial = false, swPartial = false } = {}) {
  let e = numOrNull(esxi); let s = numOrNull(sw);
  const eGap = e === 0 && esxiPartial; const sGap = s === 0 && swPartial;
  if (eGap) e = null;
  if (sGap) s = null;
  if (e == null || s == null) {
    if ((e ?? 0) > 0 || (s ?? 0) > 0) {
      // 한쪽만 드롭이 보이고 다른 쪽은 모른다 — 그쪽에 드롭이 있다는 것만 말한다(다른 쪽은 단정하지 않는다).
      return (e ?? 0) > 0
        ? { side: 'unknown', text: 'ESXi 쪽 드롭(스위치 값 없음)', tone: 'amber', why: '스위치 쪽 값을 못 읽어 양쪽 비교는 못 했습니다' }
        : { side: 'unknown', text: '스위치 쪽 드롭(ESXi 값 없음)', tone: 'amber', why: 'ESXi 쪽 값을 못 읽어 양쪽 비교는 못 했습니다' };
    }
    const eWhy = eGap ? 'ESXi 0 이지만 수집 공백이 섞임' : 'ESXi 값 없음';
    const sWhy = sGap ? '스위치 0 이지만 드롭 없는 표본이 섞임' : '스위치 값 없음(매칭 포트 없음 · 드롭 수집 전 포함)';
    return { side: 'unknown', text: '판정 보류', tone: 'gray', why: [e == null && eWhy, s == null && sWhy].filter(Boolean).join(' · ') };
  }
  if (e > 0 && s > 0) return { side: 'both', text: '양쪽', tone: 'red' };
  if (e > 0) return { side: 'esxi', text: 'ESXi 쪽', tone: 'amber' };
  if (s > 0) return { side: 'switch', text: '스위치 쪽', tone: 'amber' };
  return { side: 'none', text: '드롭 없음', tone: 'green' };
}

/** 업링크의 최근 1시간 합(net-uplinks hour) → { inDrop, outDrop, partial } — 표본이 없으면 둘 다 null. */
function hourOf(u) {
  const h = u?.hour;
  if (!h || !(numOrNull(h.samples) > 0)) return { inDrop: null, outDrop: null, partial: false };
  return { inDrop: numOrNull(h.inDrop), outDrop: numOrNull(h.outDrop), partial: numOrNull(h.dropN) != null && h.dropN < h.samples };
}

/**
 * nic-stats 행 + (있으면) CVP 업링크 → 화면 행. uplinks 를 모르면(CVP 도구 미허용) 스위치 칸은 null.
 *   한 vmnic 에 매칭 포트가 둘 이상이면 어느 포트 값을 쓸지 모르므로 스위치 칸을 비우고 판정을 보류한다.
 */
export function nicRows(data, uplinks = null) {
  const rows = Array.isArray(data?.nics) ? data.nics.filter((r) => r && typeof r === 'object' && r.nic) : [];
  const byNic = Array.isArray(uplinks) ? uplinksByNic(uplinks) : null;
  return rows.map((r) => {
    const ups = byNic ? (byNic.get(r.nic) || []) : null;
    const one = ups && ups.length === 1 ? ups[0] : null;
    const h = one ? hourOf(one) : { inDrop: null, outDrop: null, partial: false };
    const ePart = { rx: countCell(r, 'droppedRx').partial, tx: countCell(r, 'droppedTx').partial };
    const multi = ups && ups.length > 1;
    const rx = multi ? { side: 'unknown', text: '판정 보류', tone: 'gray', why: `매칭 포트 ${ups.length}개` } : sideVerdict(r.droppedRx, h.outDrop, { esxiPartial: ePart.rx, swPartial: h.partial });
    const tx = multi ? { side: 'unknown', text: '판정 보류', tone: 'gray', why: `매칭 포트 ${ups.length}개` } : sideVerdict(r.droppedTx, h.inDrop, { esxiPartial: ePart.tx, swPartial: h.partial });
    return {
      ...r,
      port: ups == null ? null : one ? portLabel(one) : multi ? `매칭 포트 ${ups.length}개` : '',
      swRx: h.outDrop, swTx: h.inDrop, swPartial: h.partial,
      rx, tx,
    };
  });
}

/** 판정 칸 한 줄 — '수신 스위치 쪽 · 송신 드롭 없음'. */
export function verdictText(row) {
  return `수신 ${row?.rx?.text || '판정 보류'} · 송신 ${row?.tx?.text || '판정 보류'}`;
}
/** 판정 칸 색 — 두 방향 중 더 나쁜 쪽. */
export function verdictTone(row) {
  const rank = { red: 3, amber: 2, gray: 1, green: 0 };
  const a = row?.rx?.tone || 'gray'; const b = row?.tx?.tone || 'gray';
  return (rank[a] ?? 1) >= (rank[b] ?? 1) ? a : b;
}

const hhmm = (iso) => {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const KEY_LABEL = { droppedRx: '수신 드롭', droppedTx: '송신 드롭', errorsRx: '수신 에러', errorsTx: '송신 에러', packetsRx: '수신 패킷', packetsTx: '송신 패킷' };

/** 표 위 한 줄 + 주석들. */
export function nicSummary(data) {
  const rows = Array.isArray(data?.nics) ? data.nics : [];
  const n = numOrNull(data?.samples);
  const win = data?.windowStart && data?.windowEnd ? ` ${hhmm(data.windowStart)}~${hhmm(data.windowEnd)}` : '';
  const sum = (k) => rows.reduce((a, r) => { const v = numOrNull(r?.[k]); return v == null ? a : (a ?? 0) + v; }, null);
  const notes = [];
  const miss = (Array.isArray(data?.missingCounters) ? data.missingCounters : []).map((k) => KEY_LABEL[k] || String(k));
  if (miss.length) notes.push(`vCenter 카운터 목록에 없는 항목: ${miss.join(' · ')}(그 칸은 —)`);
  if (data?.instancesTruncated) notes.push('vmnic 이 너무 많아 앞의 일부만 보여 줍니다');
  if (!rows.length) notes.push('vCenter 가 vmnic 계열을 돌려주지 않았습니다(호스트 연결 끊김 · 실시간 통계 없음 등 — 이유는 응답만으로 단정할 수 없습니다)');
  if (rows.some((r) => r?.partial)) notes.push('(일부) 는 수집 공백이 섞인 합입니다 — 0 이어도 ‘드롭 없음’ 으로 판정하지 않습니다');
  const text = rows.length
    ? `vmnic ${rows.length}개 · 실시간 최근 1시간${win}(20초 표본 ${n ?? '—'}개) · 수신 드롭 합 ${countText(sum('droppedRx'))} · 송신 드롭 합 ${countText(sum('droppedTx'))}`
    : `실시간 최근 1시간${win}`;
  return { text, notes };
}
