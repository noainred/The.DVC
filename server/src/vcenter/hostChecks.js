/**
 * vcenter/hostChecks.js — ESXi 호스트 화면의 '점검' 열(iDRAC 부품 상태 · 최근 재부팅 판정 · Veeam 최근 백업) 집계(순수, v2.803 —
 *   승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1 ① 호스트 목록 '점검'·'백업' 묶음).
 *
 * 판정을 새로 하지 않는다 — 호스트·클러스터 엑셀(hostExport.js)이 쓰는 같은 함수의 결과를 호스트별 한 줄로 줄인다:
 *   · iDRAC: idrac/invView.js inventoryView 의 partState 를 hwSummary(hostExport.js)로 묶음 상태로(파트 장애와 같은 판정)
 *   · 재부팅: hostcfg/reboots.js analyzeReboots 의 행(kind · bootTime) 그대로
 *   · Veeam: veeam/backupStatus.js recentBackupYn(기본 1일 — 사용자 결정 '매일 백업') 을 이 호스트 VM 마다 세어 Y/N/모름 수로
 *   · VM 합(vm): 이 호스트 VM 의 vCPU·메모리 할당 합(표의 'VM' 묶음 — 호스트 객체에는 없고 /hosts 요약만 전체 합을 준다)
 * 못 읽은 값은 0 이 아니다 — 묶음 자체를 못 읽었으면 null('수집 안 됨'), 등록 안 됨·읽는 중은 상태로 구분한다. 템플릿은 세지 않는다.
 * 권한으로 뺀 묶음은 키 자체를 싣지 않는다(access — 라우트가 accessOf 로 판정한다).
 * ⚠ store·DB·등록부를 import 하지 않는다(라우트가 읽어 넘긴다 — 테스트가 순수 함수로 부른다).
 */
import { hwSummary } from './hostExport.js';
import { recentBackupYn } from '../veeam/backupStatus.js';

export const HW_STATES = Object.freeze(['ok', 'warn', 'fault', 'unknown', 'none', 'pending', 'error']);
export const VEEAM_YN_DAYS = 1;   // 사용자 결정(2026-10-27, veeam/backupStatus.js YN_DEFAULT_DAYS 와 같은 뜻 — '어제부터 지금까지')

/** iDRAC 한 줄 — view: inventoryView 결과 · null(등록 안 됨) · undefined(등록됐지만 인벤토리 아직 없음). */
export function hwStateOf(view) {
  if (view === undefined) return { state: 'pending', bad: null };
  if (view === null) return { state: 'none', bad: null };
  const s = hwSummary(view);
  if (!s) return { state: 'none', bad: null };
  const groups = s.groups || [];
  const state = groups.some((g) => g.state === 'fault') ? 'fault' : groups.some((g) => g.state === 'warn') ? 'warn'
    : groups.some((g) => g.state === 'unknown') ? 'unknown' : groups.length ? 'ok' : 'unknown';
  return { state, bad: Array.isArray(s.bad) ? s.bad.length : 0, health: s.health || '' };
}

/** Veeam 한 줄 — views: { linked, byId:Map } | null(수집 안 됨). vms: 이 호스트의 VM. */
export function veeamCountsOf(views, vms, now) {
  if (!views || !(views.byId instanceof Map)) return null;
  const out = { y: 0, n: 0, unknown: 0, total: 0 };
  for (const v of vms || []) {
    if (v?.template === true) continue;
    out.total += 1;
    const yn = recentBackupYn(views.byId.get(v.id), { linked: views.linked !== false, days: VEEAM_YN_DAYS, now });
    if (yn === '예') out.y += 1; else if (yn === '아니오') out.n += 1; else out.unknown += 1;
  }
  return out;
}

/** 이 호스트 VM 의 vCPU·메모리(MB) 합 — 못 읽은 VM 은 unknown 으로 따로. 템플릿은 세지 않는다(hostExport.js vmSums 와 같은 규칙). */
export function vmSumsOf(vms) {
  const out = { n: 0, on: 0, templates: 0, vcpu: 0, memMB: 0, vcpuUnknown: 0, memUnknown: 0 };
  for (const v of vms || []) {
    if (!v) continue;
    if (v.template === true) { out.templates += 1; continue; }
    out.n += 1;
    if (v.powerState === 'POWERED_ON') out.on += 1;
    const c = Number(v.cpuCount); if (Number.isFinite(c) && v.cpuCount != null && v.cpuCount !== '') out.vcpu += c; else out.vcpuUnknown += 1;
    const m = Number(v.memMB); if (Number.isFinite(m) && v.memMB != null && v.memMB !== '') out.memMB += m; else out.memUnknown += 1;
  }
  return out;
}

/**
 * 호스트별 점검 한 줄.
 * @param {object[]} hosts  범위·필터를 거친 호스트
 * @param {{ access:{hygiene:boolean,hw:boolean}, idracFor?:(host)=>object|null|undefined, reboots?:Map<string,object>|null,
 *           veeamOf?:(vcenterId)=>object|null, vmsByHost?:Map<string,object[]>, now?:number }} o
 *   idracFor 가 없는데 access.hw 면 등록부를 못 읽은 것('error').
 */
export function hostChecksOf(hosts, o = {}) {
  const now = o.now ?? Date.now();
  const access = { hygiene: false, hw: false, ...(o.access || {}) };
  const byId = {};
  const counts = { hw: 0, hwPending: 0, unexpected: 0, veeamN: 0, veeamUnknown: 0 };
  for (const h of hosts || []) {
    if (!h || !h.id) continue;
    const c = {};
    if (access.hw) {
      if (typeof o.idracFor !== 'function') c.hw = { state: 'error', bad: null };
      else {
        let v; try { v = o.idracFor(h); } catch { v = undefined; }
        c.hw = hwStateOf(v);
      }
      if (c.hw.state === 'warn' || c.hw.state === 'fault') counts.hw += 1;
      if (c.hw.state === 'pending') counts.hwPending += 1;
    }
    if (access.hygiene) {
      const r = o.reboots instanceof Map ? o.reboots.get(h.id) : null;
      c.boot = r ? { kind: r.kind, bootTime: Number.isFinite(r.bootTime) ? r.bootTime : null } : null;
      if (c.boot?.kind === 'unexpected') counts.unexpected += 1;
    }
    const views = typeof o.veeamOf === 'function' ? o.veeamOf(h.vcenterId) : null;
    const vms = o.vmsByHost instanceof Map ? (o.vmsByHost.get(`${h.vcenterId}\t${h.name}`) || []) : [];
    c.vm = vmSumsOf(vms);
    c.veeam = veeamCountsOf(views, vms, now);
    if (c.veeam) { if (c.veeam.n > 0) counts.veeamN += 1; if (c.veeam.unknown > 0 && c.veeam.y + c.veeam.n === 0) counts.veeamUnknown += 1; }
    byId[h.id] = c;
  }
  return { byId, counts, access };
}

/** 스냅샷 VM → (vCenter, 호스트 이름) 별 묶음(동명 호스트가 여러 사이트에 있어도 섞이지 않게). */
export function vmsByHostOf(vms) {
  const m = new Map();
  for (const v of vms || []) {
    if (!v || !v.host) continue;
    const k = `${v.vcenterId}\t${v.host}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  }
  return m;
}
