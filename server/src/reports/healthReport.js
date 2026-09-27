/**
 * 일일 헬스체크 리포트(vCheck 스타일) — 커뮤니티 표준 아침 점검 항목을 스냅샷 + 인증서
 * 캐시만으로 집계한다. 각 섹션은 { status: ok|warn|crit, count, items } 형태로, 화면과
 * 웹훅 텍스트 리포트가 같은 결과를 공유한다. 순수 함수(now·certs 주입)라 테스트 가능.
 */

import { localStamp } from '../util/dayKey.js'; // v2.583 #25: 프로세스 TZ 가 아니라 포탈 오프셋
import { numOrNull } from '../util/numOrNull.js';
import { dsUsageReadable, dsUsedOf, dsUsageUnknownOf, usageReadable } from '../store.js'; // v2.622(감사 RECENT-02): 판정 한 벌

const DAY = 86_400_000;

export function computeHealthReport(snap, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const snapAgeDays = Number(opts.snapshotAgeDays) || 3;   // vCheck 기본: 오래된 스냅샷 임계
  const dsWarnPct = Number(opts.dsWarnPct) || 85;
  const dsCritPct = Number(opts.dsCritPct) || 95;
  const certs = opts.certs || null; // certMonitor 캐시(선택)

  const sec = {};
  const S = (key, status, count, items, label, detail = '') => { sec[key] = { key, label, status, count, items, detail }; };
  const lv = (count, critCount = 0) => (critCount > 0 ? 'crit' : count > 0 ? 'warn' : 'ok');
  // v2.621(감사 DATA-02 — 재현): 발견 0건인데 **확인하지 못한 부분**이 있으면 '정상(✅)' 이 아니라 'unknown'(확인 불가)이다.
  //   발견이 있으면 그 판정(warn/crit)이 이긴다 — 확인 불가 개수는 섹션의 unknown·detail 로 함께 밝힌다.
  const withUnknown = (status, unknownN) => (status === 'ok' && unknownN > 0 ? 'unknown' : status);
  const unknown = { pending: 0, stale: 0, maintenance: 0, alarmsUnknown: 0, dsUsageUnknown: 0 };
  // v2.629(감사 DATA2629-03): Tools 상태 미수집 VM 수 — summary.unknown(vCenter·경보·DS 축)과 단위가 달라(VM) 따로 싣는다.
  let toolsUnknown = 0;

  // ① vCenter 도달성
  const vcDown = (snap.vcenters || []).filter((v) => v.status === 'unreachable')
    .map((v) => ({ name: v.name || v.id, id: v.id, error: v.error || '' }));
  // v2.621(감사 DATA-02): 첫 수집 중(pending)·낡은 위임 보고(stale — 상태는 엣지가 준 connected 그대로)·점검중(수집 중단 —
  //   agent/inventoryPush.js UNREAD_STATUSES 와 같은 판단)은 '수집 실패 0건' 에 넣지 않고 **확인 불가**로 센다.
  //   unreachable 은 위 vcDown(위험)이 이미 센다 — 이중으로 세지 않는다.
  for (const v of snap.vcenters || []) {
    if (!v || v.status === 'unreachable' || v.status === 'disabled') continue;
    if (v.status === 'maintenance' || v.maintenance === true) unknown.maintenance += 1;
    else if (v.status === 'pending') unknown.pending += 1;
    else if (v.stale === true) unknown.stale += 1;
  }
  const vcUnknownN = unknown.pending + unknown.stale + unknown.maintenance;
  S('vcenters', withUnknown(vcDown.length ? 'crit' : 'ok', vcUnknownN), vcDown.length, vcDown.slice(0, 50), 'vCenter 수집 실패',
    unknownDetail([['첫 수집 중', unknown.pending, '곳'], ['낡은 위임 보고', unknown.stale, '곳'], ['점검중(수집 중단)', unknown.maintenance, '곳']]));
  sec.vcenters.unknown = vcUnknownN;

  // ② 호스트 연결 끊김
  // v2.629(감사 DATA2629-06): REST 폴백은 connection_state 를 대문자화만 해 'NOT_RESPONDING' 이 온다 — 끊김 판정은
  //   store.usageReadable 한 벌(DISCONNECTED·NOT_RESPONDING 둘 다). 예전 === 'DISCONNECTED' 는 무응답 호스트를 ✅ 로 셌다.
  const hostsDown = (snap.hosts || []).filter((h) => h && !usageReadable(h))
    .map((h) => ({ name: h.name, vcenterId: h.vcenterId, cluster: h.cluster || '', connectionState: h.connectionState }));
  S('hosts', hostsDown.length ? 'crit' : 'ok', hostsDown.length, hostsDown.slice(0, 50), '호스트 연결 끊김');

  // ③ 데이터스토어 용량
  // v2.621(감사 DATA-02): 사용률을 못 읽은 DS(usagePct null — v2.597 REST 폴백 결측)는 `(usagePct||0)` 으로 정상 쪽에
  //   흡수하지 않고 '사용량 미상' 으로 센다(numOrNull — Number(null)===0 함정).
  // v2.622(감사 RECENT-02 — 재현: 용량 0 DS 하나로 종합이 매일 '확인 불가'): '사용량 미상' 은 store 롤업
  //   datastoresUsageUnknown 과 같은 기준(dsUsageUnknownOf — used·free 둘 다 없고 용량>0)이다. usagePct 가 없어도 used/free 로
  //   계산할 수 있으면 그 값으로 임계를 판정하고, 용량 미상(0)인 DS 는 롤업처럼 판정 대상에서 뺀다(미상으로도 세지 않는다).
  const dsPctOf = (d) => {
    const p = numOrNull(d?.usagePct);
    if (p != null) return p;
    const cap = numOrNull(d?.capacityGB);
    if (!d || !dsUsageReadable(d) || cap == null || cap <= 0) return null;
    return Math.round((dsUsedOf(d) / cap) * 1000) / 10;
  };
  const dsHot = (snap.datastores || []).filter((d) => {
    const p = dsPctOf(d);
    if (p == null) { if (dsUsageUnknownOf(d)) unknown.dsUsageUnknown += 1; return false; }
    return p >= dsWarnPct;
  })
    .map((d) => ({ name: d.name, vcenterId: d.vcenterId, usagePct: dsPctOf(d), freeGB: d.freeGB }))
    .sort((a, b) => b.usagePct - a.usagePct);
  S('datastores', withUnknown(lv(dsHot.length, dsHot.filter((d) => d.usagePct >= dsCritPct).length), unknown.dsUsageUnknown), dsHot.length, dsHot.slice(0, 50),
    `데이터스토어 사용률 ${dsWarnPct}% 이상`, unknownDetail([['사용량 미상 데이터스토어', unknown.dsUsageUnknown, '개']]));
  sec.datastores.unknown = unknown.dsUsageUnknown;

  // ④ 오래된 스냅샷
  const oldSnaps = (snap.vms || []).filter((v) => (v.snapshotCount || 0) > 0 && v.snapshotOldestTs && (now - v.snapshotOldestTs) >= snapAgeDays * DAY)
    .map((v) => ({ name: v.name, vcenterId: v.vcenterId, ageDays: Math.floor((now - v.snapshotOldestTs) / DAY), sizeGB: v.snapshotSizeGB || 0, count: v.snapshotCount }))
    .sort((a, b) => b.ageDays - a.ageDays);
  S('snapshots', lv(oldSnaps.length), oldSnaps.length, oldSnaps.slice(0, 50), `${snapAgeDays}일 이상 된 스냅샷 보유 VM`);

  // ⑤ Tools 미실행(전원 ON VM)
  // v2.629(감사 DATA2629-03 — 재현): REST 폴백 VM 은 toolsStatus 를 수집하지 않는다(restClient.js — 필드 없음).
  //   없는 값을 '미실행' 으로 세면 그 vCenter 의 전원 켜진 VM 전부가 경고가 된다 — 수집하지 않은 VM 은 확인 불가로 센다.
  const noTools = (snap.vms || []).filter((v) => {
    if (v.powerState !== 'POWERED_ON' || v.template) return false;
    if (v.toolsStatus == null || v.toolsStatus === '') { toolsUnknown += 1; return false; }
    return v.toolsStatus !== 'RUNNING';
  })
    .map((v) => ({ name: v.name, vcenterId: v.vcenterId, host: v.host || '' }));
  S('tools', withUnknown(lv(noTools.length), toolsUnknown), noTools.length, noTools.slice(0, 50), 'VMware Tools 미실행(전원 ON)',
    unknownDetail([['Tools 상태 미수집 VM', toolsUnknown, '대']]));
  sec.tools.unknown = toolsUnknown;

  // ⑥ 고아/접근불가 VM
  const orphaned = (snap.vms || []).filter((v) => v.connectionState && v.connectionState !== 'connected')
    .map((v) => ({ name: v.name, vcenterId: v.vcenterId, connectionState: v.connectionState }));
  S('orphaned', lv(orphaned.length, orphaned.length), orphaned.length, orphaned.slice(0, 50), '고아/접근불가 VM');

  // ⑦ 위험 알람
  const critAlarms = (snap.alarms || []).filter((a) => a.severity === 'critical')
    .map((a) => ({ entity: a.entity, vcenterId: a.vcenterId, message: a.message }));
  // v2.621(감사 DATA-02): REST 폴백 수집 vCenter 는 경보를 **조회하지 않았다**(restClient.js alarmsUnknown:true · alarms:[]) —
  //   '위험 알람 0건' 이 아니다(alerts.js v2.607 LEFT2607-04 가 해소 판정을 보류하는 것과 같은 판단의 형제 누락).
  //   위임 vCenter 는 store 가 collectSource 를 'site' 로 덮으므로 보존된 collectMethod:'rest' 도 본다.
  unknown.alarmsUnknown = (snap.vcenters || []).filter((v) => v && v.status !== 'disabled' && (v.alarmsUnknown === true || v.collectMethod === 'rest')).length;
  S('alarms', withUnknown(lv(critAlarms.length, critAlarms.length), unknown.alarmsUnknown), critAlarms.length, critAlarms.slice(0, 50), '위험(critical) 알람',
    unknownDetail([['경보 미조회 vCenter', unknown.alarmsUnknown, '곳']]));
  sec.alarms.unknown = unknown.alarmsUnknown;

  // ⑧ 인증서 만료(certMonitor 캐시가 주어졌을 때만)
  if (certs && Array.isArray(certs.items)) {
    const bad = certs.items.filter((c) => c.status === 'expired' || c.status === 'critical' || c.status === 'expiring')
      .map((c) => ({ name: c.name, host: c.host, status: c.status, daysLeft: c.daysLeft }));
    S('certs', lv(bad.length, bad.filter((c) => c.status !== 'expiring').length), bad.length, bad.slice(0, 50), 'TLS 인증서 만료/임박');
  }

  const sections = Object.values(sec);
  // v2.621(감사 DATA-02): 확인 불가가 남아 있으면 종합도 'ok' 로 올리지 않는다(crit > warn > unknown > ok).
  const overall = sections.some((s) => s.status === 'crit') ? 'crit' : sections.some((s) => s.status === 'warn') ? 'warn'
    : sections.some((s) => s.status === 'unknown') ? 'unknown' : 'ok';
  return {
    generatedAt: now,
    config: { snapshotAgeDays: snapAgeDays, dsWarnPct, dsCritPct },
    overall,
    summary: {
      vcenters: (snap.vcenters || []).length,
      hosts: (snap.hosts || []).length,
      vms: (snap.vms || []).length,
      issues: sections.reduce((a, s) => a + (s.status !== 'ok' ? s.count : 0), 0),
      toolsUnknown,   // v2.629 DATA2629-03: Tools 상태 미수집(전원 ON) VM 수
      unknown,   // v2.621(감사 DATA-02): 확인 불가 축별 개수(발견 이슈와 다른 축 — issues 에 더하지 않는다)
    },
    sections,
  };
}

/** v2.621(감사 DATA-02): 확인 불가 설명(개수가 0 인 항목은 빼고, 전부 0 이면 빈 문자열). */
function unknownDetail(parts) {
  const txt = parts.filter(([, n]) => n > 0).map(([label, n, unit]) => `${label} ${n}${unit}`).join(' · ');
  return txt ? `확인 불가: ${txt}` : '';
}

/** 리포트 → 웹훅/Slack 발송용 텍스트(마크다운 최소화 — Teams/Slack/일반 웹훅 공용). */
export function buildDailyReportText(report, portalName = 'VMware Portal') {
  const icon = { ok: '✅', warn: '🟠', crit: '🔴', unknown: '❔' };   // v2.621(감사 DATA-02): 확인 불가
  const lines = [
    `${icon[report.overall] || ''} ${portalName} 일일 헬스체크 (${localStamp(report.generatedAt)})`,
    `vCenter ${report.summary.vcenters} · 호스트 ${report.summary.hosts} · VM ${report.summary.vms} · 발견 이슈 ${report.summary.issues}건`,
  ];
  // v2.621(감사 DATA-02): 확인하지 못한 부분을 머리에 한 번 적는다 — 그 항목의 '0건' 은 '정상' 이라는 뜻이 아니다.
  const u = report.summary?.unknown || {};
  const unk = [['첫 수집 중 vCenter', u.pending, '곳'], ['낡은 위임 보고', u.stale, '곳'], ['점검중 vCenter', u.maintenance, '곳'],
    ['경보 미조회 vCenter', u.alarmsUnknown, '곳'], ['사용량 미상 데이터스토어', u.dsUsageUnknown, '개']]
    .filter(([, n]) => Number(n) > 0).map(([label, n, unit]) => `${label} ${n}${unit}`);
  if (unk.length) lines.push(`❔ 확인 불가: ${unk.join(' · ')} — 해당 항목의 0건은 '정상' 이라는 뜻이 아닙니다`);
  lines.push('');
  for (const s of report.sections) {
    lines.push(`${icon[s.status] || ''} ${s.label}: ${s.count}건${s.detail ? ` (${s.detail})` : ''}`);
    if (s.status !== 'ok') {
      for (const it of (s.items || []).slice(0, 5)) {
        const desc = it.name || it.entity || it.host || '';
        const extra = it.usagePct != null ? ` ${it.usagePct}%` : it.ageDays != null ? ` ${it.ageDays}일` : it.daysLeft != null ? ` D-${it.daysLeft}` : it.connectionState ? ` ${it.connectionState}` : '';
        lines.push(`   · ${desc}${it.vcenterId ? ` (${it.vcenterId})` : ''}${extra}`);
      }
      if (s.count > 5) lines.push(`   · … 외 ${s.count - 5}건`);
    }
  }
  return lines.join('\n');
}
