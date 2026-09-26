/**
 * version_5/overviewData.js — V5 Overview 카드 3장의 계산(순수, v2.616).
 *
 * 원천은 기존 API 그대로다 — `/overview`(롤업·사이트·물리 서버) · `/alarms` · `/hosts`(영향 VM 계산).
 * 새 판정을 만들지 않고 consoleData.js 의 siteRows·levelOf·tsMs 를 쓴다.
 *
 * 정직성 규칙(CLAUDE.md):
 *   · **판정 대기(첫 수집 중·REST 폴백으로 경보를 모르는 곳)를 정상에 흡수하지 않는다** — 따로 센다.
 *   · 점검중(maintenance)은 장애가 아니다 — 정상·위험 어느 쪽에도 넣지 않고 따로 센다.
 *   · 값이 없으면 null(화면 '—'). `Number(null) === 0` 함정 — numOrNull 로 먼저 거른다.
 *   · 알람에는 VM 엔티티가 없다(host·datastore·vcenter) — '영향 VM' 은 **영향 호스트에 올라간 VM 수**이고
 *     그렇게 이름 붙인다. 호스트 목록을 못 읽으면 null 이다(0 이 아니다).
 */
import { siteRows, levelOf, tsMs } from '../console/consoleData.js';
import { numOrNull } from '../numOrNull.js';

/** 사이트(vCenter) 1곳의 상태 등급 — ok | warn | crit | wait | maint | off(v2.617: 설정에서 꺼 둔 vCenter — 수집하지 않으므로 판정 대상이 아니다). */
export function siteLevel(row) {
  if (!row) return 'wait';
  const st = String(row.status || '');
  if (st === 'maintenance') return 'maint';
  if (st === 'disabled') return 'off';
  if (st === 'unreachable') return 'crit';
  if (st !== 'connected') return 'wait'; // pending·미상 — 확인 전이다
  if ((row.alarmsCritical || 0) > 0) return 'crit';
  const lv = levelOf(row.worst);
  if (lv === 2) return 'crit';
  if ((row.alarmsWarning || 0) > 0 || lv === 1) return 'warn';
  // 사용률도 못 읽었고 경보도 모른다(REST 폴백) — 정상이라 단정하지 않는다.
  if (lv == null && row.alarmsUnknown) return 'wait';
  return 'ok';
}

/**
 * v2.617: 주의 목록 — 위험을 먼저, 같은 등급이면 경보 수·사용률이 큰 순. 예전에는 사용률 순 목록을 그대로 잘라
 * 위험 법인이 5개 밖으로 밀릴 수 있었다. `why` 는 그 등급의 근거(연결 실패 / 경보 수 / 사용률)를 말한다 — 사용률 때문에
 * 위험인 법인이 '위험 0 · 주의 3' 으로만 보이면 왜 빨간지 알 수 없다(v2.617 스크린샷 판독에서 발견).
 */
export function attentionSites(rows, max = 5) {
  const rank = { crit: 0, warn: 1 };
  return (rows || [])
    .map((r) => ({ r, lv: siteLevel(r) }))
    .filter((x) => x.lv === 'crit' || x.lv === 'warn')
    .sort((a, b) => rank[a.lv] - rank[b.lv]
      || ((b.r.alarmsCritical || 0) - (a.r.alarmsCritical || 0))
      || ((b.r.alarmsWarning || 0) - (a.r.alarmsWarning || 0))
      || ((b.r.worst ?? -1) - (a.r.worst ?? -1)))
    .slice(0, max)
    .map(({ r, lv }) => {
      let why;
      if (r.status === 'unreachable') why = '연결 실패';
      else {
        const parts = [`위험 ${r.alarmsCritical || 0} · 주의 ${r.alarmsWarning || 0}`];
        const ul = levelOf(r.worst);
        if (ul != null && ul >= 1) parts.push(`사용률 ${Math.round(r.worst)}%`);
        why = parts.join(' · ');
      }
      return { ...r, level: lv, why };
    });
}

/** 범위(vCenter id)가 있으면 그 사이트만. */
export function scopedSites(ov, scopeId) {
  const rows = siteRows(ov?.sites || []);
  return scopeId ? rows.filter((r) => r.id === scopeId) : rows;
}

/**
 * 카드 1 — 현재 운영 상태.
 * @returns {{ok,warn,crit,wait,maint,total, affectedSites, affectedHosts, affectedVms}}
 */
export function opsStatus({ ov, alarms, hosts, scopeId = '' } = {}) {
  const rows = scopedSites(ov, scopeId);
  const c = { ok: 0, warn: 0, crit: 0, wait: 0, maint: 0, off: 0 };
  for (const r of rows) c[siteLevel(r)] += 1;
  const items = Array.isArray(alarms?.items) ? alarms.items : null;
  let affectedSites = null, affectedHosts = null, affectedVms = null;
  if (items) {
    const live = items.filter((a) => (a.severity === 'critical' || a.severity === 'warning') && !a.acknowledged
      && (!scopeId || a.vcenterId === scopeId));
    affectedSites = new Set(live.map((a) => a.vcenterId).filter(Boolean)).size;
    const hostKeys = new Set(live.filter((a) => a.entityType === 'host').map((a) => `${a.vcenterId}|${a.entity}`));
    affectedHosts = hostKeys.size;
    const hostList = Array.isArray(hosts?.items) ? hosts.items : null;
    if (hostList) {
      let sum = 0;
      for (const h of hostList) if (hostKeys.has(`${h.vcenterId}|${h.name}`)) sum += numOrNull(h.vmCount) || 0;
      affectedVms = sum;
    } else if (hostKeys.size === 0) {
      affectedVms = 0; // 영향 호스트가 없으면 목록 없이도 0 이 맞다
    }
  }
  // total 은 판정 대상(비활성 제외)이다 — 항등식 total = ok + warn + crit + wait + maint. 비활성은 off 로 따로 센다.
  return { ...c, total: rows.length - c.off, affectedSites, affectedHosts, affectedVms };
}

/**
 * 카드 2 — 인프라 규모. 범위가 있으면 그 사이트 롤업·그 법인 물리 서버.
 * @returns {{vcenters, physical, physicalNote, hosts, vms, vmsOn, storageUsedTB, storageTotalTB, storagePct}}
 */
export function infraTotals(ov, scopeId = '') {
  if (!ov) return null;
  if (scopeId) {
    const r = scopedSites(ov, scopeId)[0];
    const phys = ov.physicalByCorp && !ov.physicalByCorp.error ? numOrNull(ov.physicalByCorp.byVcenter?.[scopeId]) : null;
    if (!r) return { vcenters: 0, physical: phys, hosts: null, vms: null, vmsOn: null, storageUsedTB: null, storageTotalTB: null, storagePct: null };
    return {
      vcenters: 1, physical: phys, physicalNote: phys == null ? '이 법인에 연결된 iDRAC 서버 없음' : null,
      hosts: r.hosts, vms: r.vms, vmsOn: r.vmsOn,
      storageUsedTB: r.storageUsedTB, storageTotalTB: r.storageTotalTB, storagePct: r.sto,
    };
  }
  const g = ov.global;
  if (!g) return null;
  const total = numOrNull(g.storageTotalTB);
  return {
    vcenters: numOrNull(g.vcenters),
    physical: numOrNull(ov.physical?.servers),
    physicalNote: null,
    hosts: numOrNull(g.hosts), vms: numOrNull(g.vms), vmsOn: numOrNull(g.vmsPoweredOn),
    storageUsedTB: numOrNull(g.storageUsedTB), storageTotalTB: total,
    storagePct: numOrNull(g.datastores) > 0 && total > 0 ? numOrNull(g.storageUsagePct) : null,
  };
}

/**
 * 카드 3 — 데이터 신뢰도. vCenter 보고율은 /health(헤더와 같은 원천) 기준.
 * v2.617: 비활성(disabled) vCenter 는 분모에서 빼고 `disabled` 로 따로 센다 — 예전에는 범위 모드에서 '첫 수집 중'
 *   으로, 전체 모드에서 보고율 100% 미만으로 보였다(기다려도 채워지지 않는다).
 * @returns {{generatedMs, connected, total, pending, unreachable, maintenance, disabled, ratePct, restFallback, alarmsUnknown}}
 */
export function trustSummary({ health, ov, scopeId = '' } = {}) {
  const rows = scopedSites(ov, scopeId);
  let connected, total, pending, unreachable, maintenance, disabled;
  if (scopeId) {
    disabled = rows.filter((r) => r.status === 'disabled').length;
    total = rows.length - disabled;
    connected = rows.filter((r) => r.status === 'connected').length;
    pending = rows.filter((r) => !['connected', 'unreachable', 'maintenance', 'disabled'].includes(r.status)).length;
    unreachable = rows.filter((r) => r.status === 'unreachable').length;
    maintenance = rows.filter((r) => r.status === 'maintenance').length;
  } else {
    // 구버전 서버(vcentersDisabled 없음)면 사이트 목록에서 센다.
    disabled = numOrNull(health?.vcentersDisabled) ?? rows.filter((r) => r.status === 'disabled').length;
    const t = numOrNull(health?.vcenters);
    total = t == null ? null : Math.max(0, t - disabled);
    connected = numOrNull(health?.vcentersConnected);
    pending = numOrNull(health?.vcentersPending) || 0;
    unreachable = numOrNull(health?.vcentersUnreachable) || 0;
    maintenance = numOrNull(health?.vcentersMaintenance) || 0;
  }
  const ratePct = total > 0 && connected != null ? Math.round(((connected + maintenance) / total) * 100) : null;
  return {
    generatedMs: tsMs(health?.generatedAt ?? ov?.generatedAt),
    connected, total, pending, unreachable, maintenance, disabled, ratePct,
    restFallback: rows.filter((r) => r.restFallback).length,
    alarmsUnknown: rows.filter((r) => r.alarmsUnknown).length,
  };
}

/** 하단 상태 카드 — 통신 지도 응답(켜진 엣지가 있으면)으로 'Main · Edge', 없으면 vCenter 기준('Edge 0/0' 은 뜻이 없다). */
export function statusCard({ health, commMap } = {}) {
  const edges = Array.isArray(commMap?.edges) ? commMap.edges : null;
  const edgeParts = [];
  let head;
  const onEdges = edges ? edges.filter((e) => e.state !== 'disabled') : [];
  if (edges && onEdges.length) {
    // 꺼진 엣지는 분모에서 뺀다. 기록이 없는 엣지(unknown)는 정상이 아니다 — 따로 센다(통신 지도 판정 그대로).
    const on = onEdges;
    const n = (s) => on.filter((e) => e.state === s).length;
    const ok = n('ok'), fail = n('fail'), warn = n('warn'), unk = n('unknown');
    if (fail) edgeParts.push(`엣지 실패 ${fail}`);
    if (warn) edgeParts.push(`엣지 주의 ${warn}`);
    if (unk) edgeParts.push(`엣지 확인 불가 ${unk}`);
    head = {
      label: `Main · Edge ${ok}/${on.length}${on.length && ok === on.length ? ' 정상' : ''}`,
      tone: on.length === 0 ? 'neutral' : fail ? 'crit' : ok === on.length ? 'ok' : 'warn', kind: 'edge',
    };
  } else if (health) {
    const total = numOrNull(health.vcenters) || 0;
    const conn = numOrNull(health.vcentersConnected) || 0;
    const maint = numOrNull(health.vcentersMaintenance) || 0;
    const unreach = numOrNull(health.vcentersUnreachable) || 0;
    const pending = numOrNull(health.vcentersPending) || 0;
    const off = numOrNull(health.vcentersDisabled) || 0; // v2.617: 비활성은 분모에서 뺀다
    const judged = Math.max(0, total - off);
    head = {
      label: `Main · vCenter ${conn}/${judged}`,
      tone: unreach > 0 ? 'crit' : pending > 0 ? 'warn' : judged === 0 ? 'neutral' : conn + maint === judged ? 'ok' : 'warn',
      kind: 'vcenter',
    };
  } else {
    head = { label: '연결 중…', tone: 'neutral', kind: 'none' };
  }
  const parts = [...edgeParts];
  const pending = numOrNull(health?.vcentersPending) || 0;
  const unreach = numOrNull(health?.vcentersUnreachable) || 0;
  const maint = numOrNull(health?.vcentersMaintenance) || 0;
  // pending 과 unreachable 을 합치지 않는다(loadState 규약 — '기다리면 됨' 과 '조치 필요' 가 뭉개진다).
  if (pending) parts.push(`첫 수집 중 ${pending}`);
  if (unreach) parts.push(`연결 실패 ${unreach}`);
  if (maint) parts.push(`점검 ${maint}`);
  const off = numOrNull(health?.vcentersDisabled) || 0;
  if (off) parts.push(`비활성 ${off}`);
  return { ...head, detail: parts.join(' · '), generatedMs: tsMs(health?.generatedAt) };
}
