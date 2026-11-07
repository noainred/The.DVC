/**
 * hostSanText.js — 호스트 상세 ‘SAN 경로·트래픽’ 묶음의 문구·판정(순수, v2.920 — 시안 D-① HostSan).
 * 서버 /hosts/:id/san-attribution 응답(sanswitch/attribution.js)을 화면 글자로 바꾼다. 값이 없으면 ‘—’(0 금지), 확정분·추정분을 합치지 않는다.
 */
import { numOrNull } from '../numOrNull.js';

/** 귀속 신뢰도 표기 — 조닝 그림의 ●/◐ 와 같은 식구(sanZoningView CONFIDENCE_LABEL). */
export const CONF = Object.freeze({
  confirmed: { glyph: '●', label: '확정', tone: 'green', note: '닿을 수 있는 스토리지가 하나 · 타깃 역할 네임서버 확정 — 포트 카운터 전부가 이 스토리지' },
  // v2.929(C-①): ESXi 경로 카운터(호스트 쪽 실측)가 잰 타깃별 비율 — 라이선스 불필요. 바이트 합은 스위치 포트 카운터.
  measured: { glyph: '●', label: '실측 비율', tone: 'blue', note: 'ESXi 경로 카운터가 잰 타깃별 전송 비율로 HBA 포트 바이트를 나눔(라이선스 불필요 · 매시 최근 창 표본)' },
  estimated: { glyph: '◐', label: '추정', tone: 'amber', note: '후보 2개 이상 → IPF 보정(행합 · 열합 맞춤) 또는 같은 스위치 타깃 포트 바이트 비율로 분배(또는 타깃 역할이 추정)' },
  unsplit: { glyph: '—', label: '분배 불가', tone: 'gray', note: '후보 2개 이상인데 타깃 포트 바이트가 없어 나누지 못함 — 호스트 합계에는 들어가고 스토리지에는 주지 않음' },
  none: { glyph: '—', label: '타깃 없음', tone: 'gray', note: 'zone 이 없거나 zone 안에 타깃 쪽 끝점이 없음' },
  'zoned-only': { glyph: '○', label: '조닝만', tone: 'gray', note: 'zone 멤버이지만 어느 스위치에도 로그인해 있지 않음(정리 후보)' },
});
export const STATUS_LABEL = Object.freeze({ 'logged-in': '로그인', 'zoned-only': '조닝만', unseen: '미확인', 'no-wwn': 'WWN 없음' });
/** v2.929(C-①): 후보 2개 이상인 포트를 무엇으로 나눴나(row.split). */
export const SPLIT_LABEL = Object.freeze({ measured: 'ESXi 경로 비율', ipf: 'IPF 보정', ratio: '타깃 포트 비율' });

/** 바이트 → 글자. util/fmt.fmtBytes 는 GB 까지라 SAN 기간 합(수십~수백 TB)이 '198238.4 GB' 로 나온다 — TB·PB 까지(1024 진법 · 같은 규칙: 없으면 ‘—’). */
export function bytesText(n) {
  const v0 = numOrNull(n);
  if (v0 == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let v = v0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
/** 바이트/초 → bps 글자(×8). 없으면 ‘—’. */
export function rateText(bytesPerSec) {
  const n = numOrNull(bytesPerSec);
  if (n == null) return '—';
  const b = n * 8;
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} Gbps`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} Mbps`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(b)} bps`;
}
export const rwText = (read, write) => (numOrNull(read) == null && numOrNull(write) == null ? '—' : `${rateText(read)} / ${rateText(write)}`);
export const confOf = (k) => CONF[k] || CONF.none;
export const confText = (k) => { const c = confOf(k); return `${c.glyph} ${c.label}`; };

/** 묶음 머리의 한 줄(sub). */
export function sanSubText(d) {
  if (!d) return '';
  const t = d.totals || {};
  const hbaN = new Set((d.hbas || []).map((r) => r.hba)).size;   // 행은 로그인 스위치마다 하나 — 어댑터 수는 이름으로 센다
  const parts = [`HBA ${hbaN}`, `로그인 ${t.loggedIn ?? 0}`];
  if (t.zonedOnly) parts.push(`조닝만 ${t.zonedOnly}`);
  if (t.unseen) parts.push(`미확인 ${t.unseen}`);
  parts.push(`스토리지 ${d.storages?.length ?? 0}`);
  if (d.corpLimited) parts.push(d.corpMissing ? '이 vCenter 의 법인이 지정되지 않아 SAN 스위치를 고를 수 없음' : '이 법인 스위치만');
  return parts.join(' · ');
}

/** 상태 문구 — 데이터가 없을 때 화면이 단정하지 않고 이유를 말한다. */
export function sanStateText(d) {
  if (!d) return '';
  if (d.corpMissing) return '범위 계정은 자기 법인의 SAN 스위치만 봅니다 — 이 호스트의 vCenter 에 법인이 지정되어 있지 않습니다(설정 › 법인).';
  if (!d.switches) return 'SAN 스위치 스냅샷이 없습니다 — 등록된 스위치가 없거나 아직 수집 전입니다(특수 기능 › SAN 스위치 모니터링).';
  if (d.status === 'no-hba') return '이 호스트에 HBA(스토리지 어댑터) 정보가 없습니다.';
  if (d.status === 'unseen') return `수집된 SAN 스위치 ${d.switches}대 어디에도 이 호스트의 HBA WWN 이 없습니다 — 다른 패브릭(수집 밖 스위치)이거나 FC 가 아닌 어댑터입니다.`;
  if (d.status === 'zoned-only') return 'zone 에는 있지만 어느 스위치에도 로그인한 HBA 포트가 없습니다 — 링크 다운이거나 정리 안 된 zone 입니다.';
  return '';
}

/** ESXi 경로 KBps 합 → 바이트/초(1KB = 1024 바이트 — vSphere 카운터 단위 KBps). 값이 없으면 null. */
const kbpsSum = (list, k) => { let v = null; for (const t of list || []) { const n = numOrNull(t?.[k]); if (n != null) v = (v ?? 0) + n; } return v == null ? null : v * 1024; };
const hm = (ts) => { const n = numOrNull(ts); if (n == null || n <= 0) return '—'; const d = new Date(n); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const sumOrNull = (...xs) => (xs.every((x) => numOrNull(x) == null) ? null : xs.reduce((a, x) => a + (numOrNull(x) ?? 0), 0));

/** KPI 5개(hd-kpis). 값이 없으면 ‘—’. 확정 · 실측 비율 · 추정을 한 숫자로 합치지 않는다(v2.929 — 확정 + 실측은 둘 다 근거가 있는 몫이라 한 칸에 두되 아래 줄에 따로 적는다). */
export function sanKpis(d) {
  const t = d?.totals || {};
  const label = d?.hours === 24 || d?.hours == null ? '24h' : d.hours % 24 === 0 ? `${d.hours / 24}일` : `${d.hours}h`;
  const cov = t.measuredPorts + t.unmeasuredPorts > 0 ? `측정 ${t.measuredPorts}/${t.measuredPorts + t.unmeasuredPorts} 포트` : '측정 없음';
  const hb = d?.hbas || [];
  const nIpf = hb.filter((r) => r.split === 'ipf').length; const nRatio = hb.filter((r) => r.split === 'ratio').length;
  const sp = d?.spath || null;
  const pathS = !sp ? (d?.storPathScan === false ? '경로 카운터 수집 꺼짐(STORPATH_SCAN)' : '아직 측정 전 — 매시 한 번 최근 창을 읽습니다')
    : `표본 ${hm(sp.at)}${sp.samples ? ` · ${Math.round((sp.samples * (sp.sampleSec || 20)) / 60)}분 창` : ''} · 경로 ${sp.instances ?? '—'}${sp.unparsed ? ` · 이름 못 푼 경로 ${sp.unparsed}` : ''}`;
  return [
    { l: `${label} 전송 합 · HBA 포트`, v: bytesText(t.hostBytes), s: `${cov} · 읽기+쓰기 합산(portperfshow)` },
    { l: '근거 있는 몫 · 확정 + 실측 비율', v: bytesText(sumOrNull(t.confirmedBytes, t.pathMeasuredBytes)),
      s: `${CONF.confirmed.glyph} 확정 ${bytesText(t.confirmedBytes)} · ${CONF.measured.glyph} 실측 비율 ${bytesText(t.pathMeasuredBytes)}` },
    { l: '추정 몫 · IPF · 포트 비율', v: t.estimatedBytes == null ? '—' : `≈ ${bytesText(t.estimatedBytes)}`,
      s: `IPF ${nIpf} · 포트 비율 ${nRatio} 포트${t.unsplitBytes != null ? ` · 분배 불가 ${bytesText(t.unsplitBytes)}` : ''}` },
    { l: '지금 읽기 / 쓰기 · 스위치', v: rwText(t.nowRead, t.nowWrite), s: '스위치 Tx = 읽기 · Rx = 쓰기 · 직전 수집 델타' },
    { l: '지금 읽기 / 쓰기 · ESXi 경로', v: sp ? rwText(kbpsSum(sp.targets, 'rKBps'), kbpsSum(sp.targets, 'wKBps')) : '—',
      s: `${pathS}${d?.mpTargets != null ? ` · 멀티패스 타깃 ${d.mpTargets}` : ' · 멀티패스 타깃 아직 안 읽음'}` },
  ];
}

/** v2.929(C-①): ‘경로별 실측’ 표 행 — 최근 표본(spath.targets)을 화면 행으로. 속도는 바이트/초(KBps × 1024). */
export function pathRows(d) {
  const list = Array.isArray(d?.spath?.targets) ? d.spath.targets : [];
  return list.map((t) => ({
    key: `${t.adapter || t.init || '?'}|${t.wwn}`, adapter: t.adapter || '—', wwn: t.wwn,
    storage: t.storage?.name || null, registered: !!t.storage?.registered,
    sw: t.switch ? `${t.switch.name}${t.port ? ` ${t.port.slotPort ?? t.port.index}` : ''}` : null,
    paths: numOrNull(t.paths), live: numOrNull(t.mp?.live), dead: numOrNull(t.mp?.dead),
    read: numOrNull(t.rKBps) == null ? null : t.rKBps * 1024, write: numOrNull(t.wKBps) == null ? null : t.wKBps * 1024,
    windowBytes: sumOrNull(t.readKB, t.writeKB) == null ? null : sumOrNull(t.readKB, t.writeKB) * 1024,
    latR: numOrNull(t.latR), latW: numOrNull(t.latW), partial: !!t.partial,
  }));
}
/** 경로 상태 칸 — 멀티패스(hcfg)의 살아 있는/죽은 경로 수. 모르면 ‘—’. */
export function pathStateText(r) {
  if (r?.live == null && r?.dead == null) return r?.paths != null ? `경로 ${r.paths}` : '—';
  return `살아 있음 ${r.live ?? 0}${r.dead ? ` · 죽음 ${r.dead}` : ''}`;
}
/** 지연 칸 — 값이 없으면 단위 없이 ‘—’. */
export const latText = (a, b) => (numOrNull(a) == null && numOrNull(b) == null ? '—' : `${numOrNull(a) == null ? '—' : `${a} ms`} / ${numOrNull(b) == null ? '—' : `${b} ms`}`);

/** v2.929(C-①): Fabric Vision 라이선스 띠 — 이 화면이 스위치 쪽 플로우 실측 없이 냈다는 사실과 스위치별 상태. */
export function licenseBand(fabrics = []) {
  const list = Array.isArray(fabrics) ? fabrics : [];
  const n = { yes: 0, no: 0, unknown: 0 };
  for (const f of list) n[f?.fv?.state === 'yes' ? 'yes' : f?.fv?.state === 'no' ? 'no' : 'unknown'] += 1;
  if (!list.length) return null;
  const parts = [];
  if (n.yes) parts.push(`있음 ${n.yes}`);
  if (n.no) parts.push(`없음 ${n.no}`);
  if (n.unknown) parts.push(`못 읽음 ${n.unknown}`);
  const text = n.yes === list.length
    ? `Fabric Vision 라이선스가 있는 스위치입니다(${parts.join(' · ')}) — 스위치 쪽 플로우 실측은 SAN 플로우 모니터에서 만들 수 있습니다. 이 화면의 분배는 ESXi 경로 비율 · IPF · 타깃 포트 비율입니다.`
    : `스위치 쪽 Flow Vision 실측 없이 냅니다(Fabric Vision ${parts.join(' · ')}) — 스토리지별 몫은 **ESXi 경로 카운터(실측 비율)** 와 **IPF 보정(추정)** 으로 나누고, 포트 합계는 스위치 카운터 그대로입니다.`;
  return { text, ...n, total: list.length };
}

/** HBA 행의 스토리지 칸 글자 — ‘PMAX-1 ● 75%’ 식. */
export function hbaTargetsText(row) {
  if (!row?.targets?.length) return row?.status === 'zoned-only' ? '조닝만' : '—';
  return row.targets.map((t) => `${t.name}${t.share != null && t.share < 1 ? ` ${Math.round(t.share * 100)}%` : ''}`).join(' · ');
}

/** 스토리지 행 비고. */
export function storageNoteText(s) {
  const p = [];
  if (!s) return '';
  if (s.registered) p.push(`등록 ${s.registered.type || ''}`.trim()); else p.push(s.kind === 'array' ? '어레이(미등록 · 심볼릭 이름)' : '어레이 미확인(평평한 이름)');
  if (s.measuredPorts?.length) p.push(`실측 비율 ${s.measuredPorts.length}`);
  if (s.unsplitPorts?.length) p.push(`분배 불가 ${s.unsplitPorts.length}`);
  if (s.unmeasuredPorts?.length) p.push(`측정 없음 ${s.unmeasuredPorts.length}`);
  if (s.zonedOnlyPorts?.length) p.push(`조닝만 ${s.zonedOnlyPorts.length}`);
  return p.join(' · ');
}

/** 차트 행 — 버킷별 bytes/sec 합 → Gbps(null 은 그대로, 부분 합은 서버가 null 로 비웠다). */
export function seriesRows(series) {
  if (!series?.buckets?.length) return [];
  return series.buckets.map((ts, i) => ({ ts, gbps: series.sum[i] == null ? null : Math.round(series.sum[i] * 8 / 1e7) / 100 }));
}

/** 각주 — 출처·계산 시각·기억. */
export function sanFootText(d, now = Date.now()) {
  if (!d) return '';
  const p = [];
  const src = d.source?.kind === 'rollup' ? '집계 표 + 원본 자투리' : d.source?.kind === 'demo' ? '데모 수식' : d.source?.kind === 'raw' ? '원본' : '';
  if (src) p.push(`기간 바이트 출처 ${src}`);
  if (d.series?.partialBuckets) p.push(`일부 포트만 표본이 있는 버킷 ${d.series.partialBuckets}개는 그리지 않음`);
  if (Number.isFinite(d.computedAt)) p.push(`계산 ${Math.max(0, Math.round((now - d.computedAt) / 1000))}초 전`);
  if (d.perfUnavailable) p.push('포트 사용량 DB 를 열지 못해 기간 바이트가 없음');
  if (d.fabrics?.some((f) => !f.nsKnown)) p.push('네임서버 역할이 없는 스위치가 있어 그 패브릭의 귀속은 추정');
  if (d.fabrics?.some((f) => !f.portsComplete)) p.push('문제 포트만 올라온 스위치가 있어 로그인 판정이 불완전할 수 있음');
  if (d.pathWeights?.samples) p.push(`실측 비율은 ESXi 경로 표본 ${d.pathWeights.samples}개(${hm(d.pathWeights.firstAt)}~${hm(d.pathWeights.lastAt)})로`);
  const ipfBad = (d.ipf || []).filter((x) => !x.converged).length;
  if (ipfBad) p.push(`IPF 가 수렴하지 않은 패브릭 ${ipfBad}개는 타깃 포트 비율로`);
  return p.join(' · ');
}
