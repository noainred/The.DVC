/**
 * sanHostAttribText.js — SAN 도구 ‘호스트 귀속’ 보기의 문구·정렬·막대 계산(순수, v2.915 — 시안 D-③ SanAttrib).
 * 서버 /tools/sanswitch/attribution(attributeFleet) 응답을 쓴다. 확정분·추정분을 한 숫자로 합치지 않고, 값 없음은 ‘—’.
 */
import { CONF, bytesText, rwText } from '../hostSanText.js';

const fmtBytes = bytesText;

export { CONF, bytesText, rwText };
export const RANGES = Object.freeze([[24, '24시간'], [24 * 7, '7일'], [24 * 30, '30일']]);

/** KPI 5. */
export function attribKpis(d) {
  if (!d) return [];
  const c = d.counts || {};
  const sumC = (d.storages || []).reduce((a, s) => a + (s.confirmedBytes ?? 0), 0);
  const sumE = (d.storages || []).reduce((a, s) => a + (s.estimatedBytes ?? 0), 0);
  const anyC = (d.storages || []).some((s) => s.confirmedBytes != null); const anyE = (d.storages || []).some((s) => s.estimatedBytes != null);
  const tot = anyC || anyE ? sumC + sumE : null;
  const pct = (v) => (tot ? `${Math.round((v / tot) * 100)}%` : '—');
  return [
    { l: '귀속 합계(확정 + 추정)', v: fmtBytes(tot), s: `${CONF.confirmed.glyph} ${anyC ? fmtBytes(sumC) : '—'} · ${CONF.estimated.glyph} ${anyE ? fmtBytes(sumE) : '—'}` },
    { l: '귀속 호스트', v: String(c.ok ?? 0), s: `미확인 ${c.unseen ?? 0} · 조닝만 ${c.zonedOnly ?? 0} · HBA 없음 ${c.noHba ?? 0}` },
    { l: '스토리지(트래픽 있음)', v: String((d.storages || []).length), s: `조닝만(트래픽 없음) 쌍 ${c.zonedOnlyPairs ?? 0}` },
    { l: '신뢰도 · 호스트×스토리지 쌍', v: `${CONF.confirmed.glyph} ${c.confirmedPairs ?? 0} · ${CONF.estimated.glyph} ${c.estimatedPairs ?? 0}`, s: `분배 불가 ${c.unsplitPairs ?? 0} · 확정 비중 ${anyC ? pct(sumC) : '—'}` },
    { l: '스위치 · 호스트', v: `${(d.fabrics || []).length} · ${d.hostsWithHba ?? 0}`, s: `HBA 가진 호스트 ${d.hostsWithHba ?? 0} / 전체 ${d.hostsTotal ?? 0}` },
  ];
}

/** 스토리지 막대 — 확정·추정 폭(%)은 전체 귀속 합 기준. 값 없음은 0 폭 + ‘—’ 글자. */
export function storageBars(storages = [], max = 10) {
  const list = Array.isArray(storages) ? storages : [];
  const total = list.reduce((a, s) => a + (s.confirmedBytes ?? 0) + (s.estimatedBytes ?? 0), 0);
  const top = list.slice(0, max);
  return {
    rows: top.map((s) => {
      const c = s.confirmedBytes ?? 0; const e = s.estimatedBytes ?? 0; const sum = c + e;
      return { id: s.id, name: s.name, kind: s.kind, registered: !!s.registered, hosts: s.hosts, confirmed: s.confirmedBytes, estimated: s.estimatedBytes,
        pctC: total ? (c / total) * 100 : 0, pctE: total ? (e / total) * 100 : 0, share: total && sum ? Math.round((sum / total) * 100) : null, unmeasuredHosts: s.unmeasuredHosts || 0 };
    }),
    omitted: Math.max(0, list.length - top.length), total: total || null,
  };
}

/** 표 정렬 키. */
export const SORTERS = Object.freeze({
  host: (r) => r.hostName || '', corp: (r) => r.datacenterName || '', storage: (r) => r.storageName || '', conf: (r) => ({ confirmed: 0, estimated: 1, unsplit: 2 }[r.conf] ?? 3),
  confirmed: (r) => r.confirmedBytes, estimated: (r) => r.estimatedBytes, total: (r) => (r.confirmedBytes == null && r.estimatedBytes == null ? null : (r.confirmedBytes ?? 0) + (r.estimatedBytes ?? 0)),
});
/** null 은 항상 뒤로(STable 규약과 같다). */
export function sortRows(rows = [], key = 'total', dir = 'desc') {
  const get = SORTERS[key] || SORTERS.total;
  const s = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a); const y = get(b);
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    if (typeof x === 'string') return x.localeCompare(y) * s;
    return (x - y) * s;
  });
}
export function filterRows(rows = [], { q = '', confirmedOnly = false } = {}) {
  const s = String(q || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => (!confirmedOnly || r.conf === 'confirmed') && (!s || [r.hostName, r.storageName, r.datacenterName, r.vcenterName].some((v) => String(v || '').toLowerCase().includes(s))));
}
export const rowTotalText = (r) => (r.confirmedBytes == null && r.estimatedBytes == null ? '—' : fmtBytes((r.confirmedBytes ?? 0) + (r.estimatedBytes ?? 0)));

/** 머리 상태 한 줄. */
export function attribStateText(d) {
  if (!d) return '';
  if (!(d.fabrics || []).length) return '선택한 범위에 SAN 스위치 스냅샷이 없습니다 — 등록·수집 뒤에 귀속이 가능합니다.';
  if (!d.hostsWithHba) return '선택한 법인의 vCenter 에 HBA 정보를 가진 호스트가 없습니다(법인 ↔ vCenter 지정은 설정 › 법인).';
  if (d.perfUnavailable) return '포트 사용량 DB 를 열지 못해 기간 바이트가 없습니다 — 조닝 관계만 표시합니다.';
  return '';
}
