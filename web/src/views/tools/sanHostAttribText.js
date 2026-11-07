/**
 * sanHostAttribText.js — SAN 도구 ‘호스트 귀속’ 보기의 문구·정렬·막대 계산(순수, v2.920 — 시안 D-③ SanAttrib).
 * 서버 /tools/sanswitch/attribution(attributeFleet) 응답을 쓴다. 확정분·추정분을 한 숫자로 합치지 않고, 값 없음은 ‘—’.
 */
import { CONF, bytesText, rwText, rateText } from '../hostSanText.js';

const fmtBytes = bytesText;

export { CONF, bytesText, rwText };
export const RANGES = Object.freeze([[24, '24시간'], [24 * 7, '7일'], [24 * 30, '30일']]);
/** v2.935(C-①): 분배 방식 세그먼트(서버 ?split=) — auto: 실측 → IPF → 포트 비율 · ipf: 실측을 건너뛴다 · ratio: A 단계 방식만. */
export const SPLITS = Object.freeze([['auto', '실측 우선 → IPF'], ['ipf', 'IPF 만'], ['ratio', '타깃 포트 비율']]);
const tot3 = (r) => (r.confirmedBytes == null && r.measuredBytes == null && r.estimatedBytes == null ? null : (r.confirmedBytes ?? 0) + (r.measuredBytes ?? 0) + (r.estimatedBytes ?? 0));

/** KPI 5. 확정 · 실측 비율 · 추정을 따로 적는다(합계 칸은 정렬 · 비교용 참고값). */
export function attribKpis(d) {
  if (!d) return [];
  const c = d.counts || {};
  const st = d.storages || [];
  const sum = (k) => st.reduce((a, s) => a + (s[k] ?? 0), 0);
  const any = (k) => st.some((s) => s[k] != null);
  const sumC = sum('confirmedBytes'); const sumM = sum('measuredBytes'); const sumE = sum('estimatedBytes');
  const anyC = any('confirmedBytes'); const anyM = any('measuredBytes'); const anyE = any('estimatedBytes');
  const tot = anyC || anyM || anyE ? sumC + sumM + sumE : null;
  const pct = (v) => (tot ? `${Math.round((v / tot) * 100)}%` : '—');
  return [
    { l: '귀속 합계(확정 + 실측 + 추정)', v: fmtBytes(tot), s: `${CONF.confirmed.glyph} ${anyC ? fmtBytes(sumC) : '—'} · ${CONF.measured.glyph} ${anyM ? fmtBytes(sumM) : '—'} · ${CONF.estimated.glyph} ${anyE ? fmtBytes(sumE) : '—'}` },
    { l: '귀속 호스트', v: String(c.ok ?? 0), s: `미확인 ${c.unseen ?? 0} · 조닝만 ${c.zonedOnly ?? 0} · HBA 없음 ${c.noHba ?? 0}` },
    { l: '근거 · 호스트×스토리지 쌍', v: `확정 ${c.confirmedPairs ?? 0} · 실측 ${c.measuredPairs ?? 0} · 추정 ${c.estimatedPairs ?? 0}`, s: `분배 불가 ${c.unsplitPairs ?? 0} · 근거 있는 몫 ${anyC || anyM ? pct(sumC + sumM) : '—'}` },
    { l: '나눈 방식 · HBA 포트', v: `실측 ${c.measuredSplitPorts ?? 0} · IPF ${c.ipfPorts ?? 0} · 비율 ${c.ratioPorts ?? 0}`, s: '후보 스토리지가 2개 이상인 포트만 센다' },
    { l: '스위치 · 호스트', v: `${(d.fabrics || []).length} · ${d.hostsWithHba ?? 0}`, s: `HBA 가진 호스트 ${d.hostsWithHba ?? 0} / 전체 ${d.hostsTotal ?? 0} · 조닝만 쌍 ${c.zonedOnlyPairs ?? 0}` },
  ];
}

/** v2.935(C-①): IPF 카드 행 — 스위치별 반복 · 열 잔차 · 수렴 · 고정 행. */
export function ipfRows(d) {
  return (Array.isArray(d?.ipf) ? d.ipf : []).map((x) => ({
    id: x.group || x.deviceId, name: x.name || x.deviceId, switches: x.switches ?? 1, rows: x.rows, cols: x.cols, fixed: x.fixedRows, free: x.freeRows, iter: x.iter,
    residual: Number.isFinite(x.residual) ? `${(x.residual * 100).toFixed(1)}%` : '—', converged: !!x.converged,
    slack: (x.slackRow > 0 ? '다른 초기자 몫 있음' : '') || (x.slackCol > 0 ? '다른 스위치 타깃 몫 있음' : ''),
  }));
}
/** v2.935(C-①): 스위치별 Fabric Vision 라이선스 — 있음 · 없음 · 못 읽음(사유). */
export function licenseRows(d) {
  return (Array.isArray(d?.fabrics) ? d.fabrics : []).map((f) => {
    const st = f?.fv?.state === 'yes' ? 'yes' : f?.fv?.state === 'no' ? 'no' : 'unknown';
    return { id: f.deviceId, name: f.name, corp: f.datacenterName || '', state: st,
      text: st === 'yes' ? `있음${f.fv.expires ? ` · ${f.fv.expires} 만료` : ''}` : st === 'no' ? '없음' : `못 읽음${f.fv?.reason ? `(${f.fv.reason})` : ''}` };
  });
}

/** 스토리지 막대 — 확정·실측·추정 폭(%)은 전체 귀속 합 기준. 값 없음은 0 폭 + ‘—’ 글자. */
export function storageBars(storages = [], max = 10) {
  const list = Array.isArray(storages) ? storages : [];
  const total = list.reduce((a, s) => a + (s.confirmedBytes ?? 0) + (s.measuredBytes ?? 0) + (s.estimatedBytes ?? 0), 0);
  const top = list.slice(0, max);
  return {
    rows: top.map((s) => {
      const c = s.confirmedBytes ?? 0; const m = s.measuredBytes ?? 0; const e = s.estimatedBytes ?? 0; const sum = c + m + e;
      return { id: s.id, name: s.name, kind: s.kind, registered: !!s.registered, hosts: s.hosts, confirmed: s.confirmedBytes, measured: s.measuredBytes ?? null, estimated: s.estimatedBytes,
        pctC: total ? (c / total) * 100 : 0, pctM: total ? (m / total) * 100 : 0, pctE: total ? (e / total) * 100 : 0, share: total && sum ? Math.round((sum / total) * 100) : null, unmeasuredHosts: s.unmeasuredHosts || 0 };
    }),
    omitted: Math.max(0, list.length - top.length), total: total || null,
  };
}

/** 표 정렬 키. */
export const SORTERS = Object.freeze({
  host: (r) => r.hostName || '', corp: (r) => r.datacenterName || '', storage: (r) => r.storageName || '', conf: (r) => ({ confirmed: 0, measured: 1, estimated: 2, unsplit: 3 }[r.conf] ?? 4),
  confirmed: (r) => r.confirmedBytes, measured: (r) => r.measuredBytes ?? null, estimated: (r) => r.estimatedBytes, total: tot3,
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
  // v2.935: ‘확정 · 실측만’ — 근거 있는 몫(확정 · ESXi 경로 실측 비율)만 남긴다.
  return (Array.isArray(rows) ? rows : []).filter((r) => (!confirmedOnly || r.conf === 'confirmed' || r.conf === 'measured') && (!s || [r.hostName, r.storageName, r.datacenterName, r.vcenterName].some((v) => String(v || '').toLowerCase().includes(s))));
}
export const rowTotalText = (r) => { const t = tot3(r); return t == null ? '—' : fmtBytes(t); };

/** 머리 상태 한 줄. */
export function attribStateText(d) {
  if (!d) return '';
  if (!(d.fabrics || []).length) return '선택한 범위에 SAN 스위치 스냅샷이 없습니다 — 등록·수집 뒤에 귀속이 가능합니다.';
  if (!d.hostsWithHba) return '선택한 법인의 vCenter 에 HBA 정보를 가진 호스트가 없습니다(법인 ↔ vCenter 지정은 설정 › 법인).';
  if (d.perfUnavailable) return '포트 사용량 DB 를 열지 못해 기간 바이트가 없습니다 — 조닝 관계만 표시합니다.';
  return '';
}

/** v2.940(C-② 시안 — ‘실측(스위치 플로우)’): 호스트 → 스토리지 행의 Flow Vision 플로우 합(읽기 / 쓰기). 속도를 읽은 플로우가 없으면 개수만 · 없으면 ‘—’. */
/** 스위치 플로우 칸 두 줄 — [속도, 보조(읽은 개수 · 오래됨)]. 표가 넓어 보조는 둘째 줄로 내린다(1440px 에서 열이 화면 밖으로 밀리던 것 — v2.940 Chromium 판독). */
export function flowSumParts(flow) {
  if (!flow || !flow.n) return ['—', ''];
  const stale = flow.stale ? `오래됨 ${flow.stale}` : '';   // v2.940 반증 M-1: 오래된 플로우는 합에 넣지 않고 따로 센다
  if (flow.rxBps == null || flow.txBps == null || !flow.measured) return [`플로우 ${flow.n}개 · 속도 없음`, stale];
  const t = `${rateText(flow.txBps)} / ${rateText(flow.rxBps)}`;   // 읽기(장비 송신) / 쓰기(장비 수신)
  return [t, [flow.measured < flow.n ? `${flow.measured}/${flow.n}개` : '', stale].filter(Boolean).join(' · ')];
}
export function flowSumText(flow) {
  const [a, b] = flowSumParts(flow);
  if (a === '—' || !b) return a;
  return /속도 없음$/.test(a) ? `${a} · ${b}` : `${a}(${b})`;
}
