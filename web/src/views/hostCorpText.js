/**
 * hostCorpText.js — ESXi 호스트 화면 '법인별' 보기의 글자·색 판정(순수, v2.811 — 승인 시안 B https://claude.ai/artifact/JGykMmoG7kAyNsa5y4uG1x).
 *
 * 숫자와 판정(위험·주의·사유·N+1)은 서버 /hosts/corp(vcenter/hostCorp.js)가 만든다 — 여기서는 그 값을 글자·색으로만 바꾼다.
 * 법인 상태 표지(낡은 값 · 첫 수집 중 · 비활성 · 연결 실패 · 인증 정지)는 corpSiteStatus 하나를 그대로 쓴다(다른 법인 화면과 같은 말).
 * 과할당 색(사용자 결정 2026-10-28 '시안 정의 그대로'): vCore:물리 2.5 이하 정상 · 4 이하 주의 · 초과 위험 / RAM 할당 100% 이하 · 150% 이하 · 초과.
 * 못 읽은 값은 '—'(단위를 붙이지 않는다).
 */
import { corpSiteStatus } from './corpSiteStatus.js';
import { numOrNull } from '../numOrNull.js';
import { REGIONS } from '../regions.js';
import { REGION_COLORS } from '../console/consoleData.js';

export const SEV_LABEL = Object.freeze({ crit: '위험', warn: '주의', ok: '정상', none: '모름' });
export const SEV_BADGE = Object.freeze({ crit: 'red', warn: 'amber', ok: 'green', none: 'gray' });
export const SEV_COLOR = Object.freeze({ crit: 'var(--red)', warn: 'var(--amber)', ok: 'var(--green)', none: 'var(--text-faint)' });
export const REGION_ORDER = REGIONS;   // 단일 소스(web/src/regions.js)
export const REGION_COLOR = REGION_COLORS;   // console/consoleData.js 하나 — 줄무늬·점 전용(글자색 금지)
export const RATIO_STEPS = Object.freeze({ vcpu: [2.5, 4], ram: [100, 150] });

/** '지금 확인' 칩 — 키는 서버 corpReasonsOf 와 같다. cluster:true 는 클러스터 구성 권한이 있을 때만 보인다. */
export const CORP_CHIPS = Object.freeze([
  { key: 'fail', label: '연결 실패', tone: 'red' },
  { key: 'stale', label: '낡은 값', tone: 'amber' },
  { key: 'hot', label: 'CPU 90% 초과', tone: 'red' },
  { key: 'down', label: '끊김 · 무응답', tone: 'red' },
  { key: 'n1', label: 'N+1 불가', tone: 'amber', cluster: true },
  { key: 'ha', label: 'HA · 수용 제어 꺼짐', tone: 'amber', cluster: true },
  { key: 'maint', label: '점검 모드', tone: 'amber' },
]);

export const fmtN = (v) => { const n = numOrNull(v); return n == null ? '—' : n.toLocaleString('en-US'); };
export const pctText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${n}%`; };
export const ratioText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${n.toFixed(1)} : 1`; };
export function gbText(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  return Math.abs(n) >= 1024 ? `${(Math.round((n / 1024) * 10) / 10).toLocaleString('en-US')} TB` : `${n.toLocaleString('en-US')} GB`;
}

/**
 * 법인 · 클러스터 한 줄의 'vCore : 물리' 칸 — 숫자는 서버 값 그대로(판정 코어 server vcenter/vmSums.js).
 *   · VM 의 vCPU 를 하나도 못 읽었으면 서버가 vcpu · vcpuPerCore 를 null 로 준다 → '—'(0.0 : 1 이 아니다 — v3.19.1).
 *   · 일부만 못 읽었으면 읽은 값의 합(최소값)이라 '≥' 를 붙이고 못 읽은 VM 수를 밝힌다(/hosts 요약 타일과 같은 표기).
 * @returns {{ text:string, title:string, partial:boolean }}
 */
export function vcoreCell(c) {
  const unknown = numOrNull(c?.vcpuUnknown) ?? 0;
  if (c?.capUnknown) return { text: '—', partial: false, title: `용량을 못 읽은 호스트 ${c.capUnknown}대 — 비율을 내지 않습니다` };
  if (unknown > 0 && numOrNull(c?.vcpu) == null) return { text: '—', partial: false, title: `VM ${fmtN(unknown)}대의 vCPU 를 하나도 읽지 못했습니다 — 할당 합과 비율을 내지 않습니다(0 이 아닙니다)` };
  const base = `할당 vCore ${fmtN(c?.vcpu)} / 물리 코어 ${fmtN(c?.cores)} · 템플릿 제외 · 눈금 2.5 · 4`;
  const r = ratioText(c?.vcpuPerCore);
  if (unknown > 0 && r !== '—') return { text: `≥${r}`, partial: true, title: `${base} · vCPU 를 못 읽은 VM ${fmtN(unknown)}대 제외(최소값)` };
  return { text: r, partial: false, title: base };
}

/** 법인 · 클러스터 한 줄의 'RAM 할당' 칸 — vcoreCell 과 같은 규칙(못 읽은 VM 수는 서버 vmMemUnknown). */
export function ramCell(c) {
  const unknown = numOrNull(c?.vmMemUnknown) ?? 0;
  if (unknown > 0 && numOrNull(c?.vmMemGB) == null) return { text: '—', partial: false, title: `VM ${fmtN(unknown)}대의 메모리를 하나도 읽지 못했습니다 — 할당 합과 비율을 내지 않습니다(0 이 아닙니다)` };
  const base = `VM 메모리 할당 ${gbText(c?.vmMemGB)} / 물리 ${gbText(c?.memTotalGB)} · 눈금 100% · 150%`;
  const p = pctText(c?.ramPct);
  if (unknown > 0 && p !== '—') return { text: `≥${p}`, partial: true, title: `${base} · 메모리를 못 읽은 VM ${fmtN(unknown)}대 제외(최소값)` };
  return { text: p, partial: false, title: unknown > 0 ? `${base} · 메모리를 못 읽은 VM ${fmtN(unknown)}대 제외` : base };
}

/** 3단계 색 — 'ok' | 'warn' | 'crit' | 'none'(못 읽음). */
export function stepTone(v, [warnAt, critAt]) {
  const n = numOrNull(v);
  if (n == null) return 'none';
  return n > critAt ? 'crit' : n > warnAt ? 'warn' : 'ok';
}
export const TONE_TEXT = Object.freeze({ ok: 'var(--text)', warn: '#fbbf24', crit: '#f87171', none: 'var(--text-dim)' });
export const TONE_BAR = Object.freeze({ ok: 'var(--accent)', warn: 'var(--amber)', crit: 'var(--red)', none: 'transparent' });

/** RTT — 핑 모니터의 마지막 값. 없으면 '—', 응답 없음은 그렇게 말한다(0ms 아님). 오래된 값은 stale. */
export function rttCell(rtt) {
  if (!rtt) return { text: '—', tone: 'none', title: '핑 모니터에 이 vCenter 대상이 없거나 아직 측정하지 않았습니다' };
  const at = numOrNull(rtt.at);
  const when = at ? new Date(at).toLocaleTimeString('ko-KR') : '';
  if (!rtt.ok) return { text: '응답 없음', tone: 'warn', title: `중앙에서 TCP 443 응답이 없습니다${when ? `(${when})` : ''} — 엣지 수집은 정상일 수 있습니다`, stale: rtt.fresh === false };
  const ms = numOrNull(rtt.rttMs);
  return { text: ms == null ? '—' : `${ms.toLocaleString('en-US')} ms`, tone: ms != null && ms >= 500 ? 'warn' : 'ok', title: `핑 모니터 마지막 측정${when ? ` ${when}` : ''}${rtt.fresh === false ? ' — 30분보다 오래된 값' : ''}`, stale: rtt.fresh === false };
}

/** 법인 상태 표지 — corpSiteStatus 를 그대로(서버 법인 행을 그 함수의 입력 모양으로 옮긴다). */
export function corpMark(c, now = Date.now()) {
  const s = corpSiteStatus({ status: c?.status, stale: c?.stale, authStopped: c?.authStopped, receivedAt: c?.receivedAt, metrics: { hosts: c?.hosts ?? 0, vms: c?.vms ?? 0 } }, now);
  return { mark: s.mark, title: s.title, stale: s.stale === true || (c?.stale === true) };
}

export const collectText = (c) => (c?.collect === 'site' ? '엣지 수집' : '직접 수집');
export const placeText = (c) => [c?.city, c?.country].filter(Boolean).join(' · ') || '';
export const regionRank = (r) => { const i = REGION_ORDER.indexOf(r); return i < 0 ? REGION_ORDER.length : i; };
/** 법인 열의 정렬 값 — 리전 › 이름(첫 화면 순서와 같다). */
export const corpSortKey = (c) => `${regionRank(c?.region)}-${String(c?.name || c?.id || '').toLowerCase()}`;

/** 칩 개수 — 서버 totals.byReason. 권한 없는 칩은 뺀다. */
export function chipList(totals, access) {
  const by = totals?.byReason || {};
  return CORP_CHIPS.filter((c) => !c.cluster || access?.cluster).map((c) => ({ ...c, n: by[c.key] || 0 }));
}

/** 묶음(다빈치·IRS)·칩으로 법인을 고른다. 칩은 '흐리게' 이므로 숨기지 않고 dim 표시만 돌려준다. */
export function corpView(corps, { group = 'all', chip = null } = {}) {
  return (corps || []).filter((c) => group === 'all' || c.group === group).map((c) => ({ corp: c, dim: !!chip && !(c.reasons || []).includes(chip) }));
}

/** 클러스터 카드의 표지 — [{label, tone}] (tone: red·amber·green·gray). 구성 권한이 없으면 호스트 상태만. */
export function clusterTags(c, cfgOk) {
  const out = [];
  if (c.hot > 0) out.push({ label: `CPU 90%↑ ${c.hot}`, tone: 'red' });
  if (c.down > 0) out.push({ label: `끊김 ${c.down}`, tone: 'red' });
  if (c.maint > 0) out.push({ label: `점검 ${c.maint}`, tone: 'amber' });
  if (!cfgOk) return out;
  if (c.n1Ok === true) out.push({ label: `N+1 가능 · 1대 장애 시 CPU ${pctText(c.cpuAfterFailPct)}`, tone: 'green' });
  else if (c.n1Ok === false) out.push({ label: `N+1 불가 · 1대 장애 시 CPU ${c.cpuAfterFailPct >= 999 ? '수용 불가' : pctText(c.cpuAfterFailPct)}`, tone: 'red' });
  else out.push({ label: 'N+1 판정 안 함', tone: 'gray' });
  if (!c.cfgCollected) { out.push({ label: '구성 아직 안 읽음', tone: 'gray' }); return out; }
  out.push(c.ha === false ? { label: 'HA 꺼짐', tone: 'red' } : c.ha === true ? { label: 'HA 켜짐', tone: 'gray' } : { label: 'HA —', tone: 'gray' });
  if (c.ha === true && c.admission === false) out.push({ label: '수용 제어 꺼짐', tone: 'amber' });
  const drs = { auto: ['DRS 자동', 'gray'], partial: ['DRS 부분 자동', 'amber'], manual: ['DRS 수동', 'amber'], off: ['DRS 꺼짐', 'amber'] }[c.drs];
  out.push(drs ? { label: drs[0], tone: drs[1] } : { label: 'DRS —', tone: 'gray' });
  out.push(c.evc === '' ? { label: 'EVC 꺼짐', tone: c.findings?.some((f) => f.code === 'evc-off-mixed') ? 'amber' : 'gray' } : c.evc ? { label: `EVC ${c.evc}`, tone: 'gray' } : { label: 'EVC —', tone: 'gray' });
  return out;
}

/** CPU 구간 누적 막대 — 구간별 비율(%). 호스트가 없으면 빈 배열. */
export function bucketSegs(buckets, keys) {
  const total = keys.reduce((a, k) => a + (buckets?.[k] || 0), 0);
  if (!total) return [];
  return keys.filter((k) => buckets?.[k] > 0).map((k) => ({ key: k, n: buckets[k], pct: (buckets[k] / total) * 100 }));
}

/** 요약 칸 — 법인 합(호스트를 모르는 법인은 더하지 않고 그 수를 밝힌다). */
export function corpKpis(data) {
  const corps = data?.corps || [];
  const t = data?.totals || {};
  const known = corps.filter((c) => c.hosts != null);
  const sum = (f) => known.reduce((a, c) => a + (numOrNull(f(c)) || 0), 0);
  const capOk = known.filter((c) => c.capUnknown === 0 && c.cores != null);
  // v3.19.1: VM 의 vCPU 를 하나도 못 읽은 법인(서버 vcpu null)은 분자 · 분모 둘 다에서 뺀다 — 0 으로 더하면 코어만 늘어 비율이 낮게 나온다.
  //   일부만 못 읽은 법인은 읽은 합(최소값)이라 '≥' 를 붙이고 못 읽은 VM 수를 밝힌다.
  const ratioOk = capOk.filter((c) => numOrNull(c.vcpu) != null);
  const cores = ratioOk.reduce((a, c) => a + c.cores, 0);
  const vcpu = ratioOk.reduce((a, c) => a + c.vcpu, 0);
  const vcpuUnknown = ratioOk.reduce((a, c) => a + (numOrNull(c.vcpuUnknown) ?? 0), 0);
  const vcpuUnreadCorps = capOk.length - ratioOk.length;
  // 뺀 것을 앞에 적는다 — 요약 칸은 좁아(1440 에서 6칸) 뒤쪽 글자가 말줄임되므로, 뒤에 두면 '제외' 가 마우스를 올려야만 보인다(Chromium 판독).
  const ratioSub = [
    vcpuUnreadCorps ? `vCPU 못 읽은 법인 ${fmtN(vcpuUnreadCorps)}곳 제외` : '',
    vcpuUnknown ? `vCPU 못 읽은 VM ${fmtN(vcpuUnknown)}대 제외(최소값)` : '',
    ratioOk.length ? `물리 코어 ${fmtN(cores)} · 할당 vCore ${fmtN(vcpu)}` : '비율을 낼 법인이 없습니다',
    capOk.length < known.length ? '용량 못 읽은 법인 제외' : '',
  ].filter(Boolean).join(' · ');
  const partial = t.corpsUnknown > 0 ? ` · 미수집 ${t.corpsUnknown}곳 제외` : '';
  return [
    { key: 'corps', label: '법인(vCenter)', value: fmtN(t.corps), sub: `연결 ${fmtN(t.corpsOk)} · 낡은 값 ${fmtN(t.corpsStale)} · 실패 ${fmtN(t.corpsFail)}` },
    { key: 'clusters', label: '클러스터', value: fmtN(t.clusters), sub: data?.access?.cluster ? `N+1 불가 ${fmtN(t.n1Fail)} · HA 꺼짐 ${fmtN(t.haOff)}` : '구성 · N+1 은 클러스터 점검 권한 필요' },
    { key: 'hosts', label: '호스트(ESXi)', value: fmtN(t.hosts), sub: `점검 ${fmtN(t.maint)} · 끊김 · 무응답 ${fmtN(t.down)}${partial}` },
    { key: 'hot', label: 'CPU 90% 초과', value: fmtN(t.hot), sub: `법인 ${fmtN(t.hotCorps)}곳 · 정격 용량 대비`, tone: t.hot > 0 ? 'crit' : 'ok' },
    { key: 'ratio', label: 'vCore : 물리', value: cores > 0 ? `${vcpuUnknown ? '≥' : ''}${ratioText(Math.round((vcpu / cores) * 10) / 10)}` : '—', sub: ratioSub },
    { key: 'kw', label: '전력', value: known.length ? `${(Math.round(sum((c) => c.powerKw) * 10) / 10).toLocaleString('en-US')} kW` : '—', sub: `VM ${fmtN(sum((c) => c.vms))}${partial}` },
  ];
}
