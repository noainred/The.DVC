/**
 * ipam/instantAlerts.js — IP 관리 '바로 알림' 3가지(순수 · v3.7.0 재설계 묶음 라 — 설계 docs/design/ipam-redesign ⑫ · §3.4).
 *
 * 사용자 결정(2026-11-13): 바로 알림 3가지(충돌 · 중복 새로 생김 · 대역 가득 참 · 스캔 보고 끊김)를 넣는다. 충돌(의심)은 v3.1.0 의 ipamConflict 가 이미 있다 —
 * 여기는 나머지 셋이다. 셋 다 **상태형**이다(alerts.js 엔진 — 처음 넘은 때 한 번 · 회복 한 번 · 같은 상태를 다시 보내지 않는다):
 *   ipamDuplicate  — 한 vCenter 안에서 같은 IP 를 둘 이상이 쓴다(대장 duplicate — 숨김 반영 뒤 판정). 키 ipdup:<ip>
 *   ipamSubnetFull — /24 점유(대장 + 예약 + DHCP — 현황 · 대역 목록과 같은 occ)가 임계(%) 이상. 키 ipfull:<대역>
 *   ipamScanStale  — 주기 스캔을 켠 에이전트의 마지막 완료가 주기 × 임계(배)보다 오래됐다. 기록이 아예 없으면 '끊김' 이 아니라 모름 — 알리지 않는다.
 * 지금 값을 못 읽은 vCenter 의 IP(대장이 낡았다)는 판정을 보류한다(held — 해소로 기록하지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { quietLongestMs } from './scanQuiet.js'; // v3.8.1 쉬는 시간만큼 끊김 판정을 늦춘다

export const SUBNET_HOSTS = 254;
export const SUBNET_FULL_DEFAULT = 90;
export const SCAN_STALE_DEFAULT = 3;
export const DUP_ALERT_MAX = 200;   // 한 번에 낼 수 있는 중복 알림 수(대역 하나를 통째로 겹친 실수가 수백 통을 만들지 않게 — 넘으면 요약 한 건)
export const DUP_MANY_KEY = 'ipdup:__many__';   // 넘었을 때의 묶음 알림 키

/**
 * 결정(56~75 남긴 것) 62: 묶음 알림의 끝 · 묶음 회차에 보류한 IP 별 알림의 정리 문구(알림 엔진 alerts.js refreshState 가 쓴다).
 *   묶음 키가 목록에서 빠지는 것은 '중복이 없어졌다' 가 아니라 '상한 아래로 내려왔다' 일 수 있다 — 남은 중복 수를 사실대로 말한다.
 */
export function dupBundleEndTitle(left) {
  const n = Number(left) || 0;
  return n > 0
    ? `중복 IP 묶음 해제 — 상한(${DUP_ALERT_MAX}개) 아래로 내려감 · 중복 ${n}개 남음(개별 알림으로 계속)`
    : null;   // 남은 중복이 없으면 보통의 '해소' 다
}
/** 묶음 회차에 보류한 IP 별 알림이 보류 시한을 넘겼다 — 해소가 아니라 '묶음으로 대체 · 개별 상태 모름' 이다. */
export function dupBundledExpiredTitle(title) {
  return `묶음으로 대체: ${String(title || '중복 IP').slice(0, 200)} — 개별 상태 모름`;
}
export const DUP_BUNDLED_EXPIRED_DETAIL = `중복 IP 가 상한(${DUP_ALERT_MAX}개)을 넘어 한 건으로 묶인 동안 판정 보류 시한이 지나 이 IP 의 개별 알림을 정리했습니다. 해소가 아닙니다 — 묶음 알림이 계속 알리고, 상한 아래로 내려오면 개별 알림으로 다시 판정합니다.`;

/** 중복 IP — 대장 행(duplicate:true) 을 IP 로 묶는다. */
export function duplicateAlerts(rows, { unreadVc = new Set() } = {}) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.duplicate || !r.ip) continue;
    const l = by.get(r.ip) || []; l.push(r); by.set(r.ip, l);
  }
  const out = []; const held = [];
  for (const [ip, list] of by) {
    const key = `ipdup:${ip}`;
    if (list.some((r) => unreadVc.has(String(r.vcenterId)))) { held.push(key); continue; }
    const names = [...new Set(list.map((r) => r.ownerName || r.hostName || '?'))].slice(0, 4);
    out.push({ key, vcenterId: list[0].vcenterId, severity: 'warning', title: `중복 IP: ${ip}`,
      detail: `${list[0].vcenterName || list[0].vcenterId} · 같은 IP 를 ${list.length}곳이 씁니다 — ${names.join(', ')}${list.length > names.length ? ' …' : ''}` });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : 1));
  if (out.length > DUP_ALERT_MAX) {
    // 60회차 F3(재현): 묶음으로 바뀌는 회차에 IP 별 키를 **보류**로 넘긴다 — 예전에는 키 목록에서 빠져 이미 발생 중이던 IP 별 중복 알림(최대 200건)이
    //   전부 '해소' 로 기록됐다(중복은 그대로인데 — 해소 구독자에게도 나갔다). 보류는 발생 중인 키에만 뜻이 있다(새 키를 만들지 않는다).
    // 결정(56~75 남긴 것) 62: 묶음으로 보류한 키는 bundled 로도 넘긴다 — 보류 시한을 넘기면 엔진이 '해소' 가 아니라 '묶음으로 대체 — 개별 상태 모름' 으로 정리 기록한다.
    return { alerts: [{ key: DUP_MANY_KEY, severity: 'warning', title: `중복 IP ${out.length}개`, detail: `중복 IP 가 ${out.length}개입니다(앞 ${DUP_ALERT_MAX}개를 넘어 한 건으로 묶음) — IP 관리 › IP 주소의 ‘중복’ 필터로 확인하세요.` }],
      held: [...held, ...out.map((a) => a.key)], bundled: out.map((a) => a.key) };
  }
  return { alerts: out, held, bundled: [] };
}

/** 가득 찬 대역 — subnets 는 listSubnets 결과({subnet, base, used, rsv, dhcp, purpose?}). */
export function subnetFullAlerts(subnets, { threshold = SUBNET_FULL_DEFAULT } = {}) {
  const th = numOrNull(threshold) ?? SUBNET_FULL_DEFAULT;
  const out = [];
  for (const s of Array.isArray(subnets) ? subnets : []) {
    const used = Math.max(0, numOrNull(s?.used) ?? 0); const rsv = Math.max(0, numOrNull(s?.rsv) ?? 0); const dhcp = Math.max(0, numOrNull(s?.dhcp) ?? 0);
    const occ = Math.min(SUBNET_HOSTS, used + rsv + dhcp);
    const pct = Math.round((occ / SUBNET_HOSTS) * 1000) / 10;
    if (pct < th) continue;
    out.push({ key: `ipfull:${s.base}`, severity: pct >= 98 ? 'critical' : 'warning', title: `대역 가득 참 ${pct}%: ${s.subnet}${s.purpose ? ` (${s.purpose})` : ''}`,
      detail: `${s.subnet} · 점유 ${occ}/${SUBNET_HOSTS}(사용 ${used} · 예약 ${rsv} · DHCP ${dhcp}) · 남은 주소 ${SUBNET_HOSTS - occ}개` });
  }
  return out;
}

/**
 * 스캔 보고 끊김 — agents 는 listScanAgents(+이 포탈), reports 는 getAgentReports(마지막 완료 at).
 * @returns {{ alerts: object[], held: string[] }}
 */
export function scanStaleAlerts(agents, reports, { threshold = SCAN_STALE_DEFAULT, now = Date.now(), label = (a) => a } = {}) {
  const k = Math.max(1, numOrNull(threshold) ?? SCAN_STALE_DEFAULT);
  const rep = new Map(Object.entries(reports || {}).map(([n, v]) => [n.toLowerCase(), v]));
  const out = []; const held = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a?.enabled || !(a.ranges || []).length) continue;
    const key = `ipscanstale:${String(a.name).toLowerCase()}`;
    const iv = numOrNull(a.intervalMs);
    const at = numOrNull(rep.get(String(a.name).toLowerCase())?.at);
    if (!iv || at == null) { held.push(key); continue; }   // 기록이 없다 — 끊김인지 모른다
    const age = now - at;
    // v3.8.1: 쉬는 시간에는 주기 회차를 건너뛴다(그 동안 완료 기록이 늘지 않는다) — 가장 긴 쉬는 시간만큼 기준을 늘린다(쉬는 시간마다 거짓 경보 방지).
    const quietMs = quietLongestMs(a.quiet);
    if (age <= iv * k + quietMs) continue;
    const h = Math.round(age / 360_000) / 10;
    out.push({ key, scanAgent: a.name, severity: 'warning', title: `스캔 보고 끊김: ${label(a.name)}`,
      detail: `마지막 완료 ${h}시간 전 — 주기 ${Math.round(iv / 60000)}분의 ${k}배${quietMs ? ` + 쉬는 시간 ${Math.round(quietMs / 360_000) / 10}시간` : ''}을 넘었습니다(엣지 정지 · 통신 · 배정 문제일 수 있습니다). IP 관리 › 스캔 › 주기 스캔 일정에서 확인하세요.` });
  }
  return { alerts: out, held };
}
