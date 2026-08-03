/**
 * 일일 헬스체크 리포트(vCheck 스타일) — 커뮤니티 표준 아침 점검 항목을 스냅샷 + 인증서
 * 캐시만으로 집계한다. 각 섹션은 { status: ok|warn|crit, count, items } 형태로, 화면과
 * 웹훅 텍스트 리포트가 같은 결과를 공유한다. 순수 함수(now·certs 주입)라 테스트 가능.
 */

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

  // ① vCenter 도달성
  const vcDown = (snap.vcenters || []).filter((v) => v.status === 'unreachable')
    .map((v) => ({ name: v.name || v.id, id: v.id, error: v.error || '' }));
  S('vcenters', vcDown.length ? 'crit' : 'ok', vcDown.length, vcDown.slice(0, 50), 'vCenter 수집 실패');

  // ② 호스트 연결 끊김
  const hostsDown = (snap.hosts || []).filter((h) => h.connectionState === 'DISCONNECTED')
    .map((h) => ({ name: h.name, vcenterId: h.vcenterId, cluster: h.cluster || '' }));
  S('hosts', hostsDown.length ? 'crit' : 'ok', hostsDown.length, hostsDown.slice(0, 50), '호스트 연결 끊김');

  // ③ 데이터스토어 용량
  const dsHot = (snap.datastores || []).filter((d) => (d.usagePct || 0) >= dsWarnPct)
    .map((d) => ({ name: d.name, vcenterId: d.vcenterId, usagePct: d.usagePct, freeGB: d.freeGB }))
    .sort((a, b) => b.usagePct - a.usagePct);
  S('datastores', lv(dsHot.length, dsHot.filter((d) => d.usagePct >= dsCritPct).length), dsHot.length, dsHot.slice(0, 50),
    `데이터스토어 사용률 ${dsWarnPct}% 이상`);

  // ④ 오래된 스냅샷
  const oldSnaps = (snap.vms || []).filter((v) => (v.snapshotCount || 0) > 0 && v.snapshotOldestTs && (now - v.snapshotOldestTs) >= snapAgeDays * DAY)
    .map((v) => ({ name: v.name, vcenterId: v.vcenterId, ageDays: Math.floor((now - v.snapshotOldestTs) / DAY), sizeGB: v.snapshotSizeGB || 0, count: v.snapshotCount }))
    .sort((a, b) => b.ageDays - a.ageDays);
  S('snapshots', lv(oldSnaps.length), oldSnaps.length, oldSnaps.slice(0, 50), `${snapAgeDays}일 이상 된 스냅샷 보유 VM`);

  // ⑤ Tools 미실행(전원 ON VM)
  const noTools = (snap.vms || []).filter((v) => v.powerState === 'POWERED_ON' && !v.template && v.toolsStatus !== 'RUNNING')
    .map((v) => ({ name: v.name, vcenterId: v.vcenterId, host: v.host || '' }));
  S('tools', lv(noTools.length), noTools.length, noTools.slice(0, 50), 'VMware Tools 미실행(전원 ON)');

  // ⑥ 고아/접근불가 VM
  const orphaned = (snap.vms || []).filter((v) => v.connectionState && v.connectionState !== 'connected')
    .map((v) => ({ name: v.name, vcenterId: v.vcenterId, connectionState: v.connectionState }));
  S('orphaned', lv(orphaned.length, orphaned.length), orphaned.length, orphaned.slice(0, 50), '고아/접근불가 VM');

  // ⑦ 위험 알람
  const critAlarms = (snap.alarms || []).filter((a) => a.severity === 'critical')
    .map((a) => ({ entity: a.entity, vcenterId: a.vcenterId, message: a.message }));
  S('alarms', lv(critAlarms.length, critAlarms.length), critAlarms.length, critAlarms.slice(0, 50), '위험(critical) 알람');

  // ⑧ 인증서 만료(certMonitor 캐시가 주어졌을 때만)
  if (certs && Array.isArray(certs.items)) {
    const bad = certs.items.filter((c) => c.status === 'expired' || c.status === 'critical' || c.status === 'expiring')
      .map((c) => ({ name: c.name, host: c.host, status: c.status, daysLeft: c.daysLeft }));
    S('certs', lv(bad.length, bad.filter((c) => c.status !== 'expiring').length), bad.length, bad.slice(0, 50), 'TLS 인증서 만료/임박');
  }

  const sections = Object.values(sec);
  const overall = sections.some((s) => s.status === 'crit') ? 'crit' : sections.some((s) => s.status === 'warn') ? 'warn' : 'ok';
  return {
    generatedAt: now,
    config: { snapshotAgeDays: snapAgeDays, dsWarnPct, dsCritPct },
    overall,
    summary: {
      vcenters: (snap.vcenters || []).length,
      hosts: (snap.hosts || []).length,
      vms: (snap.vms || []).length,
      issues: sections.reduce((a, s) => a + (s.status !== 'ok' ? s.count : 0), 0),
    },
    sections,
  };
}

/** 리포트 → 웹훅/Slack 발송용 텍스트(마크다운 최소화 — Teams/Slack/일반 웹훅 공용). */
export function buildDailyReportText(report, portalName = 'VMware Portal') {
  const icon = { ok: '✅', warn: '🟠', crit: '🔴' };
  const lines = [
    `${icon[report.overall] || ''} ${portalName} 일일 헬스체크 (${new Date(report.generatedAt).toLocaleString('ko-KR')})`,
    `vCenter ${report.summary.vcenters} · 호스트 ${report.summary.hosts} · VM ${report.summary.vms} · 발견 이슈 ${report.summary.issues}건`,
    '',
  ];
  for (const s of report.sections) {
    lines.push(`${icon[s.status]} ${s.label}: ${s.count}건`);
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
