/**
 * availability/analyze.js — 특수 기능 'VM 가용성(SLA)'(도구 키 `vm-availability`, v2.707 — C6) 판정(순수).
 * 입력은 logs DB 의 전원·가용성 이벤트(opsEvents — AVAIL_TYPES)와 스냅샷의 VM 현재 전원 상태. vCenter 왕복 0.
 *
 * 정직 규칙
 *  · 가동률은 **이 포탈이 그 vCenter 이벤트를 받고 있던 구간** 에서만 잰다. 수집 시작이 기간 시작보다 늦으면 그 vCenter 의
 *    VM 은 '측정 구간' 이 짧아지고 화면이 그 사실을 말한다. 이벤트를 받은 적 없는 vCenter 는 판정하지 않는다(100% 가 아니다).
 *  · 정지 시간 = 전원 끔(PoweredOff)·일시 정지(Suspended) 이벤트부터 다음 전원 켬(PoweredOn) 까지.
 *    재설정(Resetting)·게스트 재부팅·HA 재시작은 **정지 시간을 이벤트로 알 수 없어** 횟수로만 센다(0초로 계산하지도, 지어내지도 않는다).
 *  · 기록과 현재 상태가 어긋나면(마지막 이벤트는 '끔' 인데 지금 켜져 있다 = 켬 이벤트를 놓쳤다) 그 VM 은 계산하지 않고 따로 센다.
 *  · 기간 내내 꺼져 있던 VM 은 '서비스 중이 아닌 VM' 으로 따로 센다(가동률 0% 로 평균을 끌어내리지 않는다).
 *  · 사람이 끈 정지(사용자 기록이 있는 PoweredOff)는 '계획 정지' 후보다 — 계획 여부는 포탈이 알 수 없으므로 두 가동률(전체 / 사람이 끈 정지 제외)을 함께 낸다.
 *  · 기간 중에 만든 VM 은 마지막 생성·복제·배포·등록 이벤트부터 잰다(그 전을 정지로 세지 않는다).
 *  · VM 은 이벤트 이름으로 묶는다(동명 VM 구분 불가 — 화면이 말한다).
 */
import { AVAIL_TYPES } from '../vmchanges/eventDetail.js';

export const ROWS_MAX = 2000;
const OFF = new Set(['VmPoweredOffEvent', 'VmSuspendedEvent']);
const ON = 'VmPoweredOnEvent';
// 기간 중에 생긴 VM — 생긴 시각부터 잰다(그 전을 '꺼져 있었다' 로 세면 새 VM 이 전부 가동률 미달이 된다).
const BORN = new Set(['VmCreatedEvent', 'VmClonedEvent', 'VmDeployedEvent', 'VmRegisteredEvent']);
const SYSTEM_USERS = /^(vpxd|vpxuser|com\.vmware\.|vsphere-webclient|system)/i;

const r3 = (x) => Math.round(x * 1000) / 1000;
const pctOf = (downMs, spanMs) => (spanMs > 0 ? r3(Math.max(0, 100 - (downMs / spanMs) * 100)) : null);
/** 사람이 끈 정지인가 — 사용자 기록이 있고 시스템 계정이 아니다. 모르면 false(계획으로 단정하지 않는다). */
export const userInitiated = (user) => typeof user === 'string' && user.trim() !== '' && !SYSTEM_USERS.test(user.trim());

/**
 * @param rows   opsEvents 행(AVAIL_TYPES — 순서 무관)
 * @param vms    스냅샷 VM(범위로 이미 거른 것 · 템플릿 제외는 여기서)
 * @param opts   { days, now, target(%), vcName:Map, coverageOf:(vcId)=>({firstTs,lastTs})|null, q, onlyBelow }
 */
export function analyzeAvailability(rows, vms, { days = 30, now = Date.now(), target = 99.9, vcName = new Map(), coverageOf = () => null, q = '', onlyBelow = false } = {}) {
  const since = now - days * 86_400_000;
  const byVm = new Map();
  for (const r of rows || []) {
    if (!(AVAIL_TYPES.includes(r.type) || BORN.has(r.type)) || !(r.ts >= since && r.ts <= now)) continue;
    const k = `${r.vcenterId}\u0000${r.entity}`;
    if (!byVm.has(k)) byVm.set(k, []);
    byVm.get(k).push(r);
  }
  const cov = { vms: 0, measured: 0, noEvents: 0, partialWindow: 0, inconsistent: 0, offAll: 0, belowTarget: 0 };
  const perVc = new Map();
  const out = [];
  const seen = new Set();
  for (const v of vms || []) {
    if (v.template) continue;
    const k = `${v.vcenterId}\u0000${v.name}`;
    if (seen.has(k)) continue;   // 동명 VM — 이벤트로 구분하지 못하므로 한 번만 센다
    seen.add(k);
    cov.vms += 1;
    const c = coverageOf(v.vcenterId);
    const vc = perVc.get(v.vcenterId) || { vcenterId: v.vcenterId, name: vcName.get(v.vcenterId) || v.vcenterId, vms: 0, measured: 0, below: 0, downMs: 0, spanMs: 0, min: null, noEvents: 0, from: null };
    perVc.set(v.vcenterId, vc);
    vc.vms += 1;
    if (!c || !Number.isFinite(c.lastTs) || !c.lastTs) { cov.noEvents += 1; vc.noEvents += 1; continue; }
    const born = (byVm.get(k) || []).filter((e) => BORN.has(e.type)).reduce((m, e) => Math.max(m, e.ts), 0);
    const covFrom = Math.max(since, Number.isFinite(c.firstTs) && c.firstTs > 0 ? c.firstTs : since);
    const from = Math.max(covFrom, born);
    if (covFrom > since) cov.partialWindow += 1;
    vc.from = vc.from == null ? from : Math.max(vc.from, from);
    const span = now - from;
    const evs = (byVm.get(k) || []).filter((e) => e.ts >= from && !BORN.has(e.type)).sort((a, b) => a.ts - b.ts);
    const onNow = v.powerState === 'POWERED_ON';
    let down = 0; let userDown = 0; let offs = 0; let userOffs = 0;
    let reboots = 0; let resets = 0; let ha = 0; let failed = 0;
    // 시작 상태 — 첫 전원 이벤트로 거꾸로 안다. 전원 이벤트가 없으면 지금 상태가 기간 내내 이어졌다고 본다.
    const firstPower = evs.find((e) => e.type === ON || OFF.has(e.type));
    let isOn = firstPower ? firstPower.type !== ON : onNow;
    if (!evs.some((e) => e.type === ON || OFF.has(e.type)) && !onNow) { cov.offAll += 1; continue; }
    let offAt = isOn ? null : from;
    let offByUser = false;
    for (const e of evs) {
      if (OFF.has(e.type)) {
        if (isOn) { isOn = false; offAt = e.ts; offs += 1; offByUser = userInitiated(e.user); if (offByUser) userOffs += 1; }
      } else if (e.type === ON) {
        if (!isOn) { const d = e.ts - offAt; down += d; if (offByUser) userDown += d; isOn = true; offAt = null; offByUser = false; }
      } else if (e.type === 'VmGuestRebootEvent') reboots += 1;
      else if (e.type === 'VmResettingEvent' || e.type === 'VmDasBeingResetEvent') resets += 1;
      else if (e.type === 'VmRestartedOnAlternateHostEvent') ha += 1;
      else if (e.type === 'VmFailedToPowerOnEvent') failed += 1;
    }
    if (!isOn) {
      if (onNow) { cov.inconsistent += 1; continue; }   // 켬 이벤트를 놓쳤다 — 정지 시간을 알 수 없다
      const d = now - offAt; down += d; if (offByUser) userDown += d;
    }
    const availability = pctOf(down, span);
    const unplanned = pctOf(down - userDown, span);
    cov.measured += 1;
    vc.measured += 1; vc.downMs += down; vc.spanMs += span;
    vc.min = vc.min == null ? availability : Math.min(vc.min, availability);
    const below = availability < target;
    if (below) { cov.belowTarget += 1; vc.below += 1; }
    out.push({
      id: v.id, name: v.name, vcenterId: v.vcenterId, vcenterName: vc.name, cluster: v.cluster || '', powerState: v.powerState,
      availability, unplanned, downMs: down, userDownMs: userDown, offs, userOffs, reboots, resets, ha, failed,
      windowFrom: from, partial: covFrom > since, bornInWindow: born > 0, below,
    });
  }
  const qq = String(q || '').toLowerCase();
  let shown = out;
  if (onlyBelow) shown = shown.filter((r) => r.below);
  else shown = shown.filter((r) => r.below || r.offs || r.reboots || r.resets || r.ha || r.failed);
  if (qq) shown = shown.filter((r) => [r.name, r.vcenterName, r.cluster].some((x) => String(x || '').toLowerCase().includes(qq)));
  shown.sort((a, b) => a.availability - b.availability || b.ha - a.ha || String(a.name).localeCompare(String(b.name)));
  const vcenters = [...perVc.values()].map((x) => ({
    vcenterId: x.vcenterId, name: x.name, vms: x.vms, measured: x.measured, below: x.below, noEvents: x.noEvents,
    // 합산 가동률 = 전체 정지 시간 ÷ 전체 측정 시간(VM 평균이 아니다 — 측정 구간이 다른 VM 을 같은 무게로 두지 않는다)
    availability: x.spanMs > 0 ? pctOf(x.downMs, x.spanMs) : null, min: x.min, windowFrom: x.from,
  })).sort((a, b) => (a.availability ?? 101) - (b.availability ?? 101));
  let dAll = 0; let sAll = 0;
  for (const x of perVc.values()) { dAll += x.downMs; sAll += x.spanMs; }
  const totals = {
    availability: sAll > 0 ? pctOf(dAll, sAll) : null,
    ha: out.reduce((a, r) => a + r.ha, 0), resets: out.reduce((a, r) => a + r.resets, 0),
    reboots: out.reduce((a, r) => a + r.reboots, 0), failed: out.reduce((a, r) => a + r.failed, 0),
    offs: out.reduce((a, r) => a + r.offs, 0), userOffs: out.reduce((a, r) => a + r.userOffs, 0),
  };
  return { days, since, target, coverage: cov, totals, vcenters, matched: shown.length, vms: shown.slice(0, ROWS_MAX), omitted: Math.max(0, shown.length - ROWS_MAX) };
}
