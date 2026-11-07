// v2.935(SAN·CVP 설계 C-②) SAN 플로우 모니터 — 문구 · 표 행 · KPI(순수). 화면은 SanFlowTool.jsx.
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
  if (c.ok) return { label: `통과 · ${hm(c.at)}`, tone: 'green', title: `flow --show 가 통과했습니다 — 장비 플로우 ${c.total == null ? '—' : `${c.total}개`}(포탈 ${c.portal ?? '—'}) · ${c.by || ''}` };
  return { label: CHECK_KIND[c.kind] || '오류', tone: c.kind === 'error' ? 'amber' : 'red', title: c.text || '점검이 실패했습니다' };
}

/** 스위치 행이 ‘만들기’ 를 열 수 있나 — 라이선스 없음 · 점검 안 통과면 이유를 준다. */
export function createBlock(dev) {
  if (dev?.fv?.state === 'no') return '라이선스 없음';
  if (dev?.edgeIssue) return '엣지 버전 낮음';
  if (!dev?.check) return '먼저 계정 권한 점검';
  if (!dev.check.ok) return '점검 통과 필요';
  if (!dev.collectedAt) return '수집 스냅샷 없음';
  return null;
}

export function deviceRows(d) {
  return (Array.isArray(d?.devices) ? d.devices : []).map((x) => {
    // 서버 flowCount = 점검 때 장비가 센 개수 + 그 뒤에 만든 것(상한 판정과 같은 값). 옛 응답이면 점검 개수 · 포탈 기록 수.
    const count = numOrNull(x.flowCount) ?? numOrNull(x.check?.total) ?? numOrNull(x.portalFlows);
    return { ...x, fvB: fvBadge(x.fv), chk: checkBadge(x.check), block: createBlock(x),
      countText: `${count ?? '—'} / ${x.limit}`, countSort: count ?? -1, where: x.agent ? `엣지 ${x.agent}` : '이 포탈' };
  });
}

/** 플로우 바이트/초(델타)와 ESXi 경로 실측의 차이 % — 수신 · 송신 · ESXi 가 **다** 있을 때만(한쪽만이면 부분 합 — 반증 M-5 · 시점이 달라 참고값). */
export function diffPct(f) {
  const rx = numOrNull(f?.rxBps); const tx = numOrNull(f?.txBps); const e = numOrNull(f?.esxiBps);
  if (rx == null || tx == null || e == null || e <= 0) return null;
  return (rx + tx - e) / e * 100;
}
export const diffText = (p) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);

export const shortWwn = (w) => { const s = String(w || ''); return s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-5)}` : (s || '—'); };

const STATE = Object.freeze({
  active: { label: '활성', tone: 'green' }, pending: { label: '만드는 중', tone: 'blue' },
  unknown: { label: '결과 모름', tone: 'amber', note: '만들기 결과를 받지 못했습니다 — 장비에 있을 수 있습니다(카운터 읽기 · 권한 점검으로 확인)' },
  conflict: { label: '이름 충돌', tone: 'amber', note: '같은 이름의 플로우가 장비에 이미 있습니다 — 정의가 같은지 확인하지 못했습니다' },
  gone: { label: '장비에 없음', tone: 'amber' }, failed: { label: '만들지 못함', tone: 'red' }, deleted: { label: '지움', tone: 'gray' },
  inactive: { label: '비활성', tone: 'gray', note: '장비에 플로우는 있지만 모니터를 껐습니다 — 카운터가 늘지 않습니다(다시 켜기로 켭니다)' },
});
export function flowRows(d) {
  const devName = new Map((d?.devices || []).map((x) => [x.id, x.name]));
  const toggleIssue = new Map((d?.devices || []).map((x) => [x.id, x.toggleIssue || null]));
  const portal = (Array.isArray(d?.flows) ? d.flows : []).map((f) => {
    const p = diffPct(f);
    const c = f.counters || null;
    const bytes = c && numOrNull(c.rxBytes) != null && numOrNull(c.txBytes) != null ? numOrNull(c.rxBytes) + numOrNull(c.txBytes) : null;   // 한쪽만이면 '—'(반증 M-5)
    return { key: `${f.deviceId}|${f.name}`, portal: true, name: f.name, deviceId: f.deviceId, sw: devName.get(f.deviceId) || f.deviceId,
      host: f.hostName ? `${String(f.hostName).split('.')[0]} · ${f.hba || '—'}` : '—', pair: `${shortWwn(f.srcdev)} → ${shortWwn(f.dstdev)}`, pairTitle: `${f.srcdev} → ${f.dstdev} · 포트 ${f.ingrport}`,
      target: f.targetName || '—', rate: f.stale ? '오래됨(최근에 못 읽음)' : c ? `${rateText(f.rxBps)} / ${rateText(f.txBps)}` : '—', rateSort: (numOrNull(f.rxBps) ?? -1) + (numOrNull(f.txBps) ?? 0),
      bytes: bytesText(bytes), bytesSort: bytes ?? -1, diff: diffText(p), diffSort: p == null ? null : Math.abs(p), diffWarn: p != null && Math.abs(p) > 5,
      esxi: rateText(f.esxiBps), state: STATE[f.state] || { label: f.state || '—', tone: 'gray' }, lastAt: f.lastAt || null, lastError: f.lastError || null, rawSample: f.rawSample || null,
      canDelete: f.state !== 'deleted' && f.state !== 'failed' && f.deviceKnown !== false, canForget: f.deviceKnown === false && f.state !== 'deleted',
      // 반증 L-4: 엣지가 비활성화 · 다시 켜기를 모르는 버전이면 버튼을 잠근다(누르면 OTP 를 쓰고 거부되던 것)
      canDeactivate: f.state === 'active' && f.deviceKnown !== false && !toggleIssue.get(f.deviceId), canActivate: f.state === 'inactive' && f.deviceKnown !== false && !toggleIssue.get(f.deviceId),
      toggleIssue: toggleIssue.get(f.deviceId) || null,
      // 잠근 이유를 버튼 자리에 말한다(버튼만 사라지면 왜 없는지 모른다)
      toggleLocked: !!toggleIssue.get(f.deviceId) && f.deviceKnown !== false && (f.state === 'active' || f.state === 'inactive') };
  });
  const human = [];
  const blank = { host: '—', pair: '—', pairTitle: '', target: '—', rate: '—', rateSort: -1, bytes: '—', bytesSort: -1, diff: '—', diffSort: null, diffWarn: false, esxi: '—', lastError: null, canForget: false, canDeactivate: false, canActivate: false };
  for (const x of d?.devices || []) {
    for (const n of x.check?.others || []) human.push({ ...blank, key: `${x.id}|${n}`, portal: false, name: n, deviceId: x.id, sw: x.name, state: { label: '사람이 만듦 · 보기만', tone: 'gray' }, lastAt: x.check?.at || null, canDelete: false });
    // 장비에 있는데 포탈 기록이 없는 dvc_ — 재시작 · 시한으로 기록을 놓친 것(반증 M-2). 지울 수 있다.
    for (const n of x.check?.orphans || []) human.push({ ...blank, key: `${x.id}|${n}`, portal: true, name: n, deviceId: x.id, sw: x.name, state: { label: '포탈 기록 없음', tone: 'amber', note: '장비에 있는데 포탈 기록이 없는 dvc_ 플로우입니다(포탈 재시작 · 시한으로 결과를 놓쳤을 수 있습니다)' }, lastAt: x.check?.at || null, canDelete: true });
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
  const inactive = flows.filter((f) => f.state === 'inactive').length;
  const diffs = flows.map(diffPct).filter((p) => p != null).map(Math.abs).sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const med = !diffs.length ? null : diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  const last = flows.map((f) => numOrNull(f.lastAt)).filter((t) => t != null).sort((a, b) => b - a)[0] ?? null;
  const every = numOrNull(d?.showEveryMs);
  return [
    { label: 'Fabric Vision 라이선스', value: `${yes} / ${devs.length}`, meta: `없음 ${no} · 못 읽음 ${unk}` },
    { label: '계정 권한 점검 통과', value: checked.length ? `${pass} / ${checked.length}` : '—', meta: checked.length ? `막힘 · 오류 ${checked.length - pass}` : '점검한 스위치 없음' },
    { label: '포탈이 만든 플로우', value: String(flows.length), meta: `활성 ${active}${inactive ? ` · 비활성 ${inactive}` : ''} · 그 밖 ${flows.length - active - inactive}` },
    { label: 'ESXi 경로 실측 대비', value: med == null ? '—' : `${med.toFixed(1)}%`, meta: med == null ? '둘 다 있는 짝 없음' : `차이 중앙값 · 5% 넘는 짝 ${diffs.filter((p) => p > 5).length}` },
    { label: '마지막 카운터 수집', value: hm(last), meta: every ? `${Math.round(every / 60_000)}분 주기 · flow --show` : 'flow --show' },
  ];
}

const JOB_STATUS = Object.freeze({ running: '실행 중', queued: '엣지 대기(설정 pull 전)', dispatched: '엣지 결과 기다림', done: '끝남' });
const ACTION = Object.freeze({ check: '계정 권한 점검', create: '만들기', show: '카운터 읽기', delete: '지우기', deactivate: '비활성화', activate: '다시 켜기' });
/** OTP 확인 줄 — 동작별 문구 · 라우트(지우기 · 기록 정리 · 비활성화 · 다시 켜기). */
export const CONFIRM = Object.freeze({
  delete: { path: '/tools/san-flow/delete', button: '지우기', text: (n) => `‘${n}’ 을 스위치에서 지웁니다 —`, danger: true },
  forget: { path: '/tools/san-flow/forget', button: '기록 정리', text: (n) => `‘${n}’ 기록만 정리합니다(스위치가 등록부에 없어 장비에는 명령을 보내지 않습니다) —`, danger: false },
  deactivate: { path: '/tools/san-flow/deactivate', button: '비활성화', text: (n) => `‘${n}’ 의 모니터를 끕니다(플로우는 장비에 남고 상한 개수에도 셉니다) —`, danger: false },
  activate: { path: '/tools/san-flow/activate', button: '다시 켜기', text: (n) => `‘${n}’ 의 모니터를 다시 켭니다 —`, danger: false },
});
export function jobTitle(j) {
  if (!j) return '';
  const st = j.status === 'done' ? (j.result?.ok ? '완료' : j.timedOut && !j.lateApplied ? '결과 모름' : '실패') : (JOB_STATUS[j.status] || j.status);
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
/** 이 스위치에서 이 초기자로 이미 있는(활성 · 만드는 중이 아닌 지움 제외) 포탈 플로우의 타깃 WWN — 같은 정의 중복 만들기 방지(서버 planCreate 와 같은 규칙). */
export function existingPairs(flows, deviceId, initWwn) {
  if (!initWwn) return [];
  return (Array.isArray(flows) ? flows : []).filter((f) => f.deviceId === deviceId && f.srcdev === initWwn && f.state === 'active').map((f) => f.dstdev);
}
/** 마지막 카운터 주기 — 시작 · 건너뛴 사유(무음 금지 — 반증 M-6 · H-2). */
export function cycleText(c) {
  if (!c) return '';
  const sk = Object.entries(c.skipped || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
  return `마지막 카운터 주기 ${hm(c.at)} — 스위치 ${c.devices}대 중 ${c.started}대 시작${sk ? ` · 건너뜀 ${sk}` : ''}`;
}
/** 엣지 작업 시한 안내 — 서버 값(edgeDeadlineMs). */
export function deadlineText(ms) {
  const m = numOrNull(ms) != null ? Math.round(numOrNull(ms) / 60_000) : null;
  return `엣지 위임 작업은 시작부터 ${m == null ? '정해진 시간' : `${m}분`} 안에 결과가 없으면 '결과 모름' 으로 닫고, 늦게 온 결과도 반영합니다. 기록에 비밀번호는 없습니다.`;
}
