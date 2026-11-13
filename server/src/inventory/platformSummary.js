/**
 * inventory/platformSummary.js — '서버 › 가상화 플랫폼' 허브(v2.915 · 설계 docs/design/virt-platform-menu §4.0-4 · 컨펌 2026-11-07 '시안 A · 표준 검증')의
 * 엔티티 탭 배지 · 바로가기 칩 숫자 요약. 순수(store · DB import 없음 — 라우트가 범위로 거른 vcenters · hosts · vms 와 판정 함수를 넘긴다).
 *
 * 왜 한 응답인가: 세 탭(vCenter · 호스트 · VM)이 어느 탭에 있든 다른 두 탭의 '지금 볼 것'(확인 대상 호스트 · 조치 필요 VM)을 보여 줘야 하는데,
 *   그 수는 /hosts(전량) · /hosts/checks(무거운 집계) · /vms?signals=1 에서 나온다 — 탭을 바꿀 때마다 그 셋을 다시 부르지 않게 한 번에 센다(라우트 memoJson 30초).
 * 판정은 복제하지 않는다:
 *   · 호스트 확인 대상 = 웹 hostTriage.hostReasons 의 세 규칙(점검 · 끊김/무응답 · CPU > 90)과 같은 결과 — readable(h) 로 읽은 값만 센다(끊긴 호스트의 0 은 못 읽음).
 *     번들 경계라 두 벌이므로 server/test/platformHub2915.test.js 가 같은 입력으로 웹 함수와 대조한다(hostCorp2811 ① 과 같은 방식).
 *   · VM 조치 필요 = vmSignals.signalCounts(같은 ctx). 템플릿은 따로 센다(개수에는 들어간다 — /vms totals 와 같은 기준).
 *   · 알람 = vCenter metrics — REST 폴백 vCenter 는 경보를 조회하지 않았으므로 '모름'(unknown) 이지 0 이 아니다(웹 restFallbackText.alarmsUnknown 과 같은 판정).
 *   · 개수를 모르는 법인(첫 수집 중 · 비활성 · 연결 실패이며 받은 항목 0)은 호스트 · VM 칸을 null — '0대' 라는 거짓 금지(hostCorp.corpUnknownOf).
 *   · hosts · vms 가 null 이면(권한 없음) 그 칸은 null 이고 합계도 null — 화면은 '—'.
 */
import { numOrNull } from '../util/numOrNull.js';
import { corpUnknownOf } from '../vcenter/hostCorp.js';
import { signalCounts } from './vmSignals.js';

export const HOST_CPU_ATTENTION_PCT = 90;
const DOWN_STATES = Object.freeze(['DISCONNECTED', 'NOT_RESPONDING']);

/** 이 vCenter 의 경보 수를 모르는가(REST 폴백은 경보를 조회하지 않는다) — 웹 restFallbackText.alarmsUnknown 과 같은 판정. */
export function alarmsUnknownOf(vc) {
  if (!vc || typeof vc !== 'object') return false;
  if (vc.alarmsUnknown === true) return true;
  if (Array.isArray(vc.restUnknown) && vc.restUnknown.includes('alarms')) return true;
  return vc.collectSource === 'rest' || vc.collectMethod === 'rest';
}

/** 호스트 확인 사유 종류 — 웹 hostTriage.hostReasons 와 같은 세 규칙(kind 만). */
export function hostReasonKinds(h, readable) {
  const out = [];
  if (!h || typeof h !== 'object') return out;
  if (h.connectionState === 'MAINTENANCE') out.push('maint');
  if (DOWN_STATES.includes(h.connectionState)) out.push('down');
  const c = readable(h) ? numOrNull(h.cpuUsagePct) : null;
  if (c != null && c > HOST_CPU_ATTENTION_PCT) out.push('cpu');
  return out;
}

const EMPTY_HOSTS = Object.freeze({ total: 0, connected: 0, maint: 0, down: 0, hot: 0, unread: 0, attention: 0, clusters: 0 });
const NULL_HOSTS = Object.freeze({ total: null, connected: null, maint: null, down: null, hot: null, unread: null, attention: null, clusters: null });
const NULL_VMS = Object.freeze({ total: null, on: null, off: null, templates: null, usageUnknown: null, attention: null, signals: null });

function hostsSection(list, readable) {
  let connected = 0; let maint = 0; let down = 0; let hot = 0; let unread = 0; let attention = 0;
  const clusters = new Set();
  for (const h of list) {
    if (h.connectionState === 'CONNECTED') connected += 1;
    const kinds = hostReasonKinds(h, readable);
    if (kinds.includes('maint')) maint += 1;
    if (kinds.includes('down')) down += 1;
    if (kinds.includes('cpu')) hot += 1;
    if (kinds.length) attention += 1;
    // 연결은 됐는데 사용률을 못 읽은 호스트(값이 없거나 수가 아님) — '미수집'(끊김 · 무응답과 따로 센다 — 웹 cpuBucket 'na' 중 끊김이 아닌 것)
    if (!DOWN_STATES.includes(h.connectionState) && (readable(h) ? numOrNull(h.cpuUsagePct) : null) == null) unread += 1;
    if (h.cluster) clusters.add(`${h.vcenterId}\t${h.cluster}`);
  }
  return { total: list.length, connected, maint, down, hot, unread, attention, clusters: clusters.size };
}

function vmsSection(list, ctx) {
  let on = 0; let templates = 0;
  for (const v of list) {
    if (v.template === true) templates += 1;
    if (v.powerState === 'POWERED_ON') on += 1;
  }
  const signals = signalCounts(list, ctx);
  return { total: list.length, on, off: list.length - on, templates, usageUnknown: signals.usageUnknown, attention: signals.any, signals };
}

function addInto(sum, part, keys) {
  for (const k of keys) {
    if (part[k] == null) continue;
    sum[k] = (sum[k] || 0) + part[k];
  }
}

/**
 * @param {object} p
 * @param {object[]} p.vcenters   범위(·요청 필터)를 적용한 vCenter 목록
 * @param {object[]|null} p.hosts 범위를 적용한 호스트 — null 이면 권한 없음(칸을 싣지 않는다)
 * @param {object[]|null} p.vms   범위를 적용한 VM — null 이면 권한 없음
 * @param {object} p.ctx          vmSignals.signalContext
 * @param {(h)=>boolean} p.readable  store.usageReadable
 * @param {(vc)=>boolean} [p.staleOf] store.siteInventoryStale
 */
export function platformSummaryOf({ vcenters = [], hosts = null, vms = null, ctx, readable = () => true, staleOf = () => false } = {}) {
  const hostsBy = new Map(); const vmsBy = new Map();
  if (Array.isArray(hosts)) for (const h of hosts) { if (!h || typeof h !== 'object') continue; const l = hostsBy.get(h.vcenterId) || []; l.push(h); hostsBy.set(h.vcenterId, l); }
  if (Array.isArray(vms)) for (const v of vms) { if (!v || typeof v !== 'object') continue; const l = vmsBy.get(v.vcenterId) || []; l.push(v); vmsBy.set(v.vcenterId, l); }

  const byVc = [];
  const tv = { total: 0, connected: 0, stale: 0, unreachable: 0, pending: 0, maintenance: 0, disabled: 0, authStopped: 0, rest: 0, site: 0 };
  const ta = { total: 0, critical: 0, warning: 0, unknownVcs: 0 };
  const th = Array.isArray(hosts) ? { ...EMPTY_HOSTS, unknownVcs: 0 } : null;
  const tm = Array.isArray(vms) ? { total: 0, on: 0, off: 0, templates: 0, usageUnknown: 0, attention: 0, unknownVcs: 0 } : null;
  for (const vc of vcenters) {
    if (!vc || typeof vc !== 'object') continue;
    const status = String(vc.status || '');
    const stale = status === 'connected' && (vc.stale === true || staleOf(vc) === true);
    const rest = alarmsUnknownOf(vc);
    const m = vc.metrics || {};
    const hl = hostsBy.get(vc.id) || [];
    const vl = vmsBy.get(vc.id) || [];
    const hostsUnknown = Array.isArray(hosts) ? corpUnknownOf(vc, hl.length) : true;
    const vmsUnknown = Array.isArray(vms) ? corpUnknownOf(vc, vl.length) : true;
    const row = {
      id: vc.id, name: vc.name || vc.id, status: status || null, stale, authStopped: vc.authStopped === true,
      region: vc.location?.region || null, collect: vc.collectSource === 'site' ? 'site' : 'direct', rest,
      alarms: rest ? { critical: null, warning: null, unknown: true } : { critical: numOrNull(m.alarmsCritical) ?? 0, warning: numOrNull(m.alarmsWarning) ?? 0, unknown: false },
      hosts: !Array.isArray(hosts) ? null : (hostsUnknown ? { ...NULL_HOSTS } : hostsSection(hl, readable)),
      vms: !Array.isArray(vms) ? null : (vmsUnknown ? { ...NULL_VMS } : vmsSection(vl, ctx)),
    };
    byVc.push(row);
    tv.total += 1;
    if (status === 'connected') tv.connected += 1;
    if (stale) tv.stale += 1;
    if (status === 'unreachable') tv.unreachable += 1;
    if (status === 'pending') tv.pending += 1;
    if (status === 'maintenance') tv.maintenance += 1;
    if (status === 'disabled') tv.disabled += 1;
    if (vc.authStopped === true) tv.authStopped += 1;
    if (rest) tv.rest += 1;
    if (row.collect === 'site') tv.site += 1;
    if (rest) ta.unknownVcs += 1; else { ta.critical += row.alarms.critical; ta.warning += row.alarms.warning; ta.total += row.alarms.critical + row.alarms.warning; }
    if (th) { if (row.hosts.total == null) th.unknownVcs += 1; else addInto(th, row.hosts, Object.keys(EMPTY_HOSTS)); }
    if (tm) { if (row.vms.total == null) tm.unknownVcs += 1; else addInto(tm, row.vms, ['total', 'on', 'off', 'templates', 'usageUnknown', 'attention']); }
  }
  byVc.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { byVc, totals: { vcenters: tv, alarms: ta, hosts: th, vms: tm } };
}
