// v2.933(SAN·CVP 설계 C-②) SAN 플로우 모니터 — 문구 · 표 행 · KPI(순수). 화면은 SanFlowTool.jsx.
//   값이 없으면 ‘—’(0 으로 단정하지 않는다 — numOrNull) · 명령은 서버 미리보기(/tools/san-flow/preview)가 만든 것을 그대로 보여 준다.
import { numOrNull } from '../../numOrNull.js';
import { bytesText, rateText } from '../hostSanText.js';

const hm = (t) => { const n = numOrNull(t); if (n == null) return '—'; const d = new Date(n); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const timeText = hm;

/** Fabric Vision 라이선스 → 배지. 스냅샷에 없는 것(없음)과 못 읽은 것(못 읽음)을 가른다. */
export function fvBadge(fv) {
  const s = fv?.state;
  if (s === 'yes') return { label: fv.expires ? `있음 · ${fv.expires}` : '있음', tone: 'green', title: '스냅샷 라이선스 목록에 Fabric Vision 이 있습니다' };
  if (s === 'no') return { label: '없음', tone: 'red', title: '스냅샷 라이선스 목록에 Fabric Vision 이 없습니다 — 이 스위치는 ESXi 경로 실측 · IPF 로 봅니다' };
  return { label: '못 읽음', tone: 'gray', title: fv?.reason ? `라이선스 목록을 읽지 못했습니다: ${fv.reason} — 없음으로 단정하지 않습니다` : '라이선스 목록을 읽지 못했습니다 — 없음으로 단정하지 않습니다' };
}

const CHECK_KIND = Object.freeze({
  license: '라이선스 없음', 'no-command': '막힘 · 명령 없음', permission: '막힘 · 권한 없음', error: '오류', missing: '오류', exists: '오류',
});
/** 계정 권한 점검(flow --show) 결과 → 배지. 점검 안 했으면 회색. */
export function checkBadge(c) {
  if (!c) return { label: '점검 안 함', tone: 'gray', title: '계정 권한 점검(flow --show — 읽기만)을 아직 하지 않았습니다' };
  if (c.ok) return { label: `통과 · ${hm(c.at)}`, tone: 'green', title: `flow --show 가 통과했습니다 — 장비 플로우 ${c.total ?? '—'}개(포탈 ${c.portal ?? '—'}) · ${c.by || ''}` };
  return { label: CHECK_KIND[c.kind] || '오류', tone: c.kind === 'error' ? 'amber' : 'red', title: c.text || '점검이 실패했습니다' };
}

/** 스위치 행이 ‘만들기’ 를 열 수 있나 — 라이선스 없음 · 점검 안 통과면 이유를 준다. */
export function createBlock(dev) {
  if (dev?.fv?.state === 'no') return '라이선스 없음';
  if (!dev?.check) return '먼저 계정 권한 점검';
  if (!dev.check.ok) return '점검 통과 필요';
  if (!dev.collectedAt) return '수집 스냅샷 없음';
  return null;
}

export function deviceRows(d) {
  return (Array.isArray(d?.devices) ? d.devices : []).map((x) => {
    const total = numOrNull(x.check?.total);
    return { ...x, fvB: fvBadge(x.fv), chk: checkBadge(x.check), block: createBlock(x),
      countText: `${total ?? x.portalFlows ?? '—'} / ${x.limit}`, countSort: total ?? x.portalFlows ?? -1, where: x.agent ? `엣지 ${x.agent}` : '이 포탈' };
  });
}

/** 플로우 바이트/초(델타)와 ESXi 경로 실측의 차이 % — 둘 다 있을 때만(시점이 달라 참고값). */
export function diffPct(f) {
  const rx = numOrNull(f?.rxBps); const tx = numOrNull(f?.txBps); const e = numOrNull(f?.esxiBps);
  if (rx == null && tx == null) return null;
  if (e == null || e <= 0) return null;
  return ((rx ?? 0) + (tx ?? 0) - e) / e * 100;
}
export const diffText = (p) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);

export const shortWwn = (w) => { const s = String(w || ''); return s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-5)}` : (s || '—'); };

const STATE = Object.freeze({ active: { label: '활성', tone: 'green' }, failed: { label: '만들지 못함', tone: 'red' }, deleted: { label: '지움', tone: 'gray' } });
export function flowRows(d) {
  const devName = new Map((d?.devices || []).map((x) => [x.id, x.name]));
  const portal = (Array.isArray(d?.flows) ? d.flows : []).map((f) => {
    const p = diffPct(f);
    const c = f.counters || null;
    const bytes = c && (numOrNull(c.rxBytes) != null || numOrNull(c.txBytes) != null) ? (numOrNull(c.rxBytes) ?? 0) + (numOrNull(c.txBytes) ?? 0) : null;
    return { key: `${f.deviceId}|${f.name}`, portal: true, name: f.name, deviceId: f.deviceId, sw: devName.get(f.deviceId) || f.deviceId,
      host: f.hostName ? `${String(f.hostName).split('.')[0]} · ${f.hba || '—'}` : '—', pair: `${shortWwn(f.srcdev)} → ${shortWwn(f.dstdev)}`, pairTitle: `${f.srcdev} → ${f.dstdev} · 포트 ${f.ingrport}`,
      target: f.targetName || '—', rate: c ? `${rateText(f.rxBps)} / ${rateText(f.txBps)}` : '—', rateSort: (numOrNull(f.rxBps) ?? -1) + (numOrNull(f.txBps) ?? 0),
      bytes: bytesText(bytes), bytesSort: bytes ?? -1, diff: diffText(p), diffSort: p == null ? null : Math.abs(p), diffWarn: p != null && Math.abs(p) > 5,
      esxi: rateText(f.esxiBps), state: STATE[f.state] || { label: f.state || '—', tone: 'gray' }, lastAt: f.lastAt || null, lastError: f.lastError || null };
  });
  const human = [];
  for (const x of d?.devices || []) for (const n of x.check?.others || []) {
    human.push({ key: `${x.id}|${n}`, portal: false, name: n, deviceId: x.id, sw: x.name, host: '—', pair: '—', pairTitle: '', target: '—', rate: '—', rateSort: -1, bytes: '—', bytesSort: -1,
      diff: '—', diffSort: null, diffWarn: false, esxi: '—', state: { label: '사람이 만듦 · 보기만', tone: 'gray' }, lastAt: x.check?.at || null, lastError: null });
  }
  return [...portal, ...human];
}

/** 위쪽 KPI 다섯 장. */
export function flowKpis(d) {
  const devs = Array.isArray(d?.devices) ? d.devices : [];
  const yes = devs.filter((x) => x.fv?.state === 'yes').length;
  const no = devs.filter((x) => x.fv?.state === 'no').length;
  const unk = devs.length - yes - no;
  const checked = devs.filter((x) => x.check);
  const pass = checked.filter((x) => x.check.ok).length;
  const flows = (d?.flows || []).filter((f) => f.state !== 'deleted');
  const active = flows.filter((f) => f.state === 'active').length;
  const diffs = flows.map(diffPct).filter((p) => p != null).map(Math.abs).sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const med = !diffs.length ? null : diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  const last = flows.map((f) => numOrNull(f.lastAt)).filter((t) => t != null).sort((a, b) => b - a)[0] ?? null;
  const every = numOrNull(d?.showEveryMs);
  return [
    { label: 'Fabric Vision 라이선스', value: `${yes} / ${devs.length}`, meta: `없음 ${no} · 못 읽음 ${unk}` },
    { label: '계정 권한 점검 통과', value: checked.length ? `${pass} / ${checked.length}` : '—', meta: checked.length ? `막힘 · 오류 ${checked.length - pass}` : '점검한 스위치 없음' },
    { label: '포탈이 만든 플로우', value: String(flows.length), meta: `활성 ${active} · 만들지 못함 ${flows.length - active}` },
    { label: 'ESXi 경로 실측 대비', value: med == null ? '—' : `${med.toFixed(1)}%`, meta: med == null ? '둘 다 있는 짝 없음' : `차이 중앙값 · 5% 넘는 짝 ${diffs.filter((p) => p > 5).length}` },
    { label: '마지막 카운터 수집', value: hm(last), meta: every ? `${Math.round(every / 60_000)}분 주기 · flow --show` : 'flow --show' },
  ];
}

const JOB_STATUS = Object.freeze({ running: '실행 중', queued: '엣지 대기(설정 pull 전)', dispatched: '엣지 실행 중', done: '끝남' });
const ACTION = Object.freeze({ check: '계정 권한 점검', create: '만들기', show: '카운터 읽기', delete: '지우기' });
export function jobTitle(j) {
  if (!j) return '';
  const st = j.status === 'done' ? (j.result?.ok ? '완료' : '실패') : (JOB_STATUS[j.status] || j.status);
  return `${ACTION[j.action] || j.action} · ${j.deviceName || j.deviceId} · ${st}${j.user ? ` · ${j.user}` : ''}`;
}
export const jobTone = (j) => (!j ? 'gray' : j.status !== 'done' ? 'blue' : j.result?.ok ? 'green' : 'red');
export function traceLines(j) {
  return (Array.isArray(j?.trace) ? j.trace : []).map((t, i) => ({ key: i, t: `+${Math.round((numOrNull(t.t) ?? 0) / 1000)}초`, msg: String(t.msg || ''), level: t.level || 'info' }));
}
export const isJobActive = (j) => !!j && j.status !== 'done';

/** 만들기 폼 — 고른 스위치에 로그인한 HBA 만(같은 호스트가 다른 패브릭에도 있다). */
export function hbaOptions(cand, deviceId) {
  return (Array.isArray(cand?.hbas) ? cand.hbas : []).filter((h) => h.deviceId === deviceId);
}
export function targetOptions(hba) {
  const out = [];
  for (const t of hba?.targets || []) for (const w of t.wwns || []) out.push({ wwn: w, name: t.name || '—', kind: t.kind || '' });
  return out.slice(0, 32);
}
