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
 *  · v2.719(감사 B1-01·02·03·08): 읽기 상한으로 앞쪽 이벤트가 잘렸으면(readFrom) 그 시각부터만 잰다(잘린 '끔' 을 모른 채
 *    첫 '켬' 앞을 정지로 세지 않게) · 마지막 이벤트가 '켬' 인데 지금 꺼져 있으면(끔 이벤트 누락) 판정 보류 · 기간 중 생긴 VM 은
 *    첫 '켬' 부터 잰다(생성~첫 켬은 서비스 시작 전) · 측정 구간이 0 이하(시계 어긋남)면 측정하지 않고 따로 센다.
 *  · v2.731(점검 r1 A2-01): 측정 구간의 **끝**도 '이벤트를 받고 있던 구간' 으로 자른다. 끝이 언제나 '지금' 이면 이벤트 수집이
 *    멈춘 vCenter 의 꼬리(수집하지 못한 구간)가 '정지 이벤트 없음 = 가동' 으로 세어진다. 끝 = 그 vCenter 의 이벤트가 온전한
 *    마지막 시각(coverageOf 의 okAt — 로그 폴러의 마지막 수집 성공. 기록이 없으면 lastTs — 마지막으로 받은 이벤트 시각)이고,
 *    지금과의 차이가 허용치(tailToleranceMs — 수집 주기 기준) 안이면 예전처럼 '지금' 이다. 잘린 vCenter 의 VM 은 그 시각까지만
 *    재고(그때까지 이벤트가 온전하므로 그 시각의 전원 상태는 이벤트로 안다) 개수를 staleTail 로 밝힌다. 끝이 기간 시작보다
 *    이르면 측정 구간이 없다 — 판정하지 않고 stoppedEarly 로 센다(시계 어긋남이 아니다).
 *  · v2.733(점검 3회차 C1-01): coverageOf 가 why(이 포탈이 **지금** 그 vCenter 이벤트를 수집하지 않는 사유 — 엣지 위임·비활성·점검중,
 *    logs/coverage.js)를 주면 측정 끝은 허용치 없이 마지막으로 받은 이벤트 시각이다(그 뒤를 받을 일이 없다는 것을 안다 — 남은 옛 이벤트로
 *    지금까지를 가동으로 세지 않는다). 그 vCenter 들은 cov.notCollectedVcenters·notCollectedVms 로 따로 세고 vcenters[].notCollected 로 싣는다.
 */
import { AVAIL_TYPES } from '../vmchanges/eventDetail.js';

export const ROWS_MAX = 2000;
const OFF = new Set(['VmPoweredOffEvent', 'VmSuspendedEvent']);
const ON = 'VmPoweredOnEvent';
// 기간 중에 생긴 VM — 생긴 시각부터 잰다(그 전을 '꺼져 있었다' 로 세면 새 VM 이 전부 가동률 미달이 된다).
const BORN = new Set(['VmCreatedEvent', 'VmClonedEvent', 'VmDeployedEvent', 'VmRegisteredEvent']);
const SYSTEM_USERS = /^(vpxd|vpxuser|com\.vmware\.|vsphere-webclient|system)/i;

// v2.731(A2-01): 측정 끝을 자르지 않는 허용치 기본값(라우트는 로그 수집 주기 × 3 과 이 값 중 큰 것을 넘긴다).
export const TAIL_TOLERANCE_MS = 3_600_000;

/**
 * 측정 끝(v2.731 A2-01, 순수) — 그 vCenter 의 이벤트가 온전한 마지막 시각.
 * c.okAt(로그 폴러의 마지막 수집 성공 — 상한에 걸렸으면 마지막으로 읽은 이벤트 시각)이 있으면 그것과 마지막 이벤트 시각 중 늦은 것,
 * 없으면(재시작 직후·계속 실패) 마지막 이벤트 시각이다. 지금과의 차이가 tolMs 이내면 '지금'(한 주기 안의 틈은 정상이고 스냅샷의
 * 현재 전원 상태가 메운다). source: 'collect' | 'last-event' | null(근거 없음 — 호출부가 이미 판정 제외).
 */
export function measureEndOf(c, now, tolMs = TAIL_TOLERANCE_MS) {
  const okAt = Number.isFinite(c?.okAt) && c.okAt > 0 ? c.okAt : null;
  const last = Number.isFinite(c?.lastTs) && c.lastTs > 0 ? c.lastTs : null;
  const basis = okAt != null ? Math.max(okAt, last ?? 0) : last;
  const source = okAt != null ? 'collect' : last != null ? 'last-event' : null;
  if (basis == null) return { end: now, cut: false, source };
  const until = Math.min(now, basis);
  const tol = Number.isFinite(tolMs) && tolMs >= 0 ? tolMs : TAIL_TOLERANCE_MS;
  return now - until > tol ? { end: until, cut: true, source } : { end: now, cut: false, source };
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const pctOf = (downMs, spanMs) => (spanMs > 0 ? r3(Math.max(0, 100 - (downMs / spanMs) * 100)) : null);
/** 사람이 끈 정지인가 — 사용자 기록이 있고 시스템 계정이 아니다. 모르면 false(계획으로 단정하지 않는다). */
export const userInitiated = (user) => typeof user === 'string' && user.trim() !== '' && !SYSTEM_USERS.test(user.trim());

/**
 * @param rows   opsEvents 행(AVAIL_TYPES — 순서 무관)
 * @param vms    스냅샷 VM(범위로 이미 거른 것 · 템플릿 제외는 여기서)
 * @param opts   { days, now, target(%), vcName:Map, coverageOf:(vcId)=>({firstTs,lastTs,okAt?})|null, q, onlyBelow,
 *                 readFrom:(ms|null) — 읽기 상한으로 이 시각 이하 이벤트가 잘렸을 수 있다(최신 먼저 읽었으므로 그 뒤는 온전하다),
 *                 tailToleranceMs — v2.731: 측정 끝을 자르지 않는 허용치(measureEndOf) }
 */
export function analyzeAvailability(rows, vms, { days = 30, now = Date.now(), target = 99.9, vcName = new Map(), coverageOf = () => null, q = '', onlyBelow = false, readFrom = null, tailToleranceMs = TAIL_TOLERANCE_MS } = {}) {
  const since = now - days * 86_400_000;
  // v2.719(감사 B1-01): 잘린 경계 시각의 이벤트는 같은 ts 묶음 중 일부만 남았을 수 있어 경계 자체도 버린다.
  const cut = Number.isFinite(readFrom) && readFrom >= since ? readFrom : null;
  const byVm = new Map();
  for (const r of rows || []) {
    if (!(AVAIL_TYPES.includes(r.type) || BORN.has(r.type)) || !(r.ts >= since && r.ts <= now)) continue;
    if (cut != null && r.ts <= cut) continue;
    const k = `${r.vcenterId}\u0000${r.entity}`;
    if (!byVm.has(k)) byVm.set(k, []);
    byVm.get(k).push(r);
  }
  // v2.719: readCut(상한으로 앞이 잘려 짧게 잰 VM) · missedOff(끔 이벤트 누락 — 판정 보류) · clockSkew(측정 구간 0 이하 — 판정 보류)
  // v2.731(A2-01): staleTail(수집이 멈춰 측정 끝을 자른 VM — 측정됨) · stoppedEarly(수집이 측정 시작 전에 멈춰 측정 구간이 없는 VM — 판정 안 함)
  const cov = { vms: 0, measured: 0, noEvents: 0, partialWindow: 0, inconsistent: 0, missedOff: 0, offAll: 0, clockSkew: 0, readCut: 0, belowTarget: 0,
    staleTail: 0, stoppedEarly: 0, tailVcenters: 0, tailMaxAgeMs: null, tailFromLastEvent: 0,
    notCollectedVcenters: 0, notCollectedVms: 0, tailNotCollected: 0 };
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
    const vc = perVc.get(v.vcenterId) || { vcenterId: v.vcenterId, name: vcName.get(v.vcenterId) || v.vcenterId, vms: 0, measured: 0, below: 0, downMs: 0, spanMs: 0, min: null, noEvents: 0, from: null, tail: null, stoppedEarly: 0, staleTail: 0,
      why: typeof c?.why === 'string' && c.why ? c.why : null };
    perVc.set(v.vcenterId, vc);
    vc.vms += 1;
    if (vc.why) cov.notCollectedVms += 1;
    if (!c || !Number.isFinite(c.lastTs) || !c.lastTs) { cov.noEvents += 1; vc.noEvents += 1; continue; }
    // v2.731(A2-01): 측정 끝 — 그 vCenter 의 이벤트가 온전한 마지막 시각(vCenter 마다 한 번).
    // v2.733(C1-01): 지금 수집하지 않는 vCenter 는 허용치 0 — 마지막으로 받은 이벤트 시각에서 끊는다.
    if (!vc.tail) vc.tail = measureEndOf(c, now, vc.why ? 0 : tailToleranceMs);
    const end = vc.tail.end;
    const tailCut = vc.tail.cut;
    const born = (byVm.get(k) || []).filter((e) => BORN.has(e.type) && e.ts <= end).reduce((m, e) => Math.max(m, e.ts), 0);
    const covFrom0 = Math.max(since, Number.isFinite(c.firstTs) && c.firstTs > 0 ? c.firstTs : since);
    // v2.719(감사 B1-01): 상한으로 잘렸으면 그 경계부터만 잰다(경계 이전 상태는 모른다).
    const cutHere = cut != null && cut > covFrom0;
    const covFrom = cutHere ? cut : covFrom0;
    let from = Math.max(covFrom, born);
    const evs = (byVm.get(k) || []).filter((e) => e.ts >= from && e.ts <= end && !BORN.has(e.type)).sort((a, b) => a.ts - b.ts);
    // v2.719(감사 B1-03): 기간 중 생긴 VM 의 첫 전원 이벤트가 '켬' 이면 생성~첫 켬은 서비스 시작 전이다 — 첫 켬부터 잰다.
    const firstPower0 = evs.find((e) => e.type === ON || OFF.has(e.type));
    if (born > 0 && born >= covFrom && firstPower0?.type === ON) from = firstPower0.ts;
    const span = end - from;
    // v2.731(A2-01): 측정 끝이 잘렸는데 시작보다 이르면 수집이 측정 시작 전에 멈춘 것이다 — 측정 구간이 없다(시계 어긋남이 아니다).
    if (!(span > 0) && tailCut) { cov.stoppedEarly += 1; vc.stoppedEarly += 1; continue; }
    // v2.719(감사 B1-08): 측정 구간이 0 이하(수집 시작이 지금보다 뒤 — vCenter 시계가 앞섬)면 가동률을 낼 수 없다.
    if (!(span > 0)) { cov.clockSkew += 1; continue; }
    if (covFrom > since) cov.partialWindow += 1;
    if (cutHere) cov.readCut += 1;
    vc.from = vc.from == null ? from : Math.max(vc.from, from);
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
    // v2.731(A2-01): 측정 끝을 잘랐으면 이벤트가 그 시각까지 온전하다 — 끝 시각의 전원 상태는 이벤트로 알고, 지금 상태와 다른 것은
    //   잘린 꼬리(수집 못 한 구간)에서 바뀐 것이다(놓친 이벤트가 아니다). 그래서 아래 두 판정 보류는 끝이 '지금' 일 때만 한다.
    if (!isOn) {
      if (onNow && !tailCut) { cov.inconsistent += 1; continue; }   // 켬 이벤트를 놓쳤다 — 정지 시간을 알 수 없다
      const d = end - offAt; down += d; if (offByUser) userDown += d;
    } else if (!onNow && !tailCut) {
      // v2.719(감사 B1-02): 마지막 전원 이벤트는 '켬' 인데 지금 꺼져 있다 — 끔 이벤트를 놓쳤거나 아직 수집 전이다.
      //   언제 꺼졌는지 모르므로 계산하지 않는다(지금까지의 꺼짐을 0 으로 세면 가동률이 실제보다 높게 나온다).
      cov.missedOff += 1; continue;
    }
    const availability = pctOf(down, span);
    const unplanned = pctOf(down - userDown, span);
    cov.measured += 1;
    if (tailCut) { cov.staleTail += 1; vc.staleTail += 1; }
    vc.measured += 1; vc.downMs += down; vc.spanMs += span;
    vc.min = vc.min == null ? availability : Math.min(vc.min, availability);
    const below = availability != null && availability < target;
    if (below) { cov.belowTarget += 1; vc.below += 1; }
    out.push({
      id: v.id, name: v.name, vcenterId: v.vcenterId, vcenterName: vc.name, cluster: v.cluster || '', powerState: v.powerState,
      availability, unplanned, downMs: down, userDownMs: userDown, offs, userOffs, reboots, resets, ha, failed,
      windowFrom: from, partial: covFrom > since, readCut: cutHere, bornInWindow: born > 0, below,
      windowTo: end, tailCut,
    });
  }
  const qq = String(q || '').toLowerCase();
  let shown = out;
  if (onlyBelow) shown = shown.filter((r) => r.below);
  else shown = shown.filter((r) => r.below || r.offs || r.reboots || r.resets || r.ha || r.failed);
  if (qq) shown = shown.filter((r) => [r.name, r.vcenterName, r.cluster].some((x) => String(x || '').toLowerCase().includes(qq)));
  shown.sort((a, b) => a.availability - b.availability || b.ha - a.ha || String(a.name).localeCompare(String(b.name)));
  // v2.731(A2-01): 측정 끝을 잘라 잰 VM 이 있는 vCenter — 개수·가장 오래 멈춘 시간·그중 수집 성공 기록이 없어 마지막 이벤트 시각을 쓴 곳.
  //   (측정 구간이 아예 없는 vCenter 는 stoppedEarly 가 따로 말한다)
  for (const x of perVc.values()) {
    if (x.why) cov.notCollectedVcenters += 1;
    if (!x.tail?.cut || !x.staleTail) continue;
    cov.tailVcenters += 1;
    if (x.why) cov.tailNotCollected += 1;
    // v2.733: 지금 수집하지 않는 vCenter 는 '수집 성공 기록이 없다(재시작 직후·계속 실패)' 가 아니다 — tailNotCollected 가 따로 말한다.
    if (x.tail.source === 'last-event' && !x.why) cov.tailFromLastEvent += 1;
    const age = now - x.tail.end;
    if (cov.tailMaxAgeMs == null || age > cov.tailMaxAgeMs) cov.tailMaxAgeMs = age;
  }
  const vcenters = [...perVc.values()].map((x) => ({
    vcenterId: x.vcenterId, name: x.name, vms: x.vms, measured: x.measured, below: x.below, noEvents: x.noEvents,
    // 합산 가동률 = 전체 정지 시간 ÷ 전체 측정 시간(VM 평균이 아니다 — 측정 구간이 다른 VM 을 같은 무게로 두지 않는다)
    availability: x.spanMs > 0 ? pctOf(x.downMs, x.spanMs) : null, min: x.min, windowFrom: x.from,
    // v2.731(A2-01): 측정 끝 — 잘렸으면 그 시각(아니면 null = 지금), 근거('collect' 수집 성공 · 'last-event' 마지막 이벤트 · null 판정 안 함)
    tailCut: !!x.tail?.cut, measuredUntil: x.tail?.cut ? x.tail.end : null, untilSource: x.tail?.source ?? null, stoppedEarly: x.stoppedEarly,
    notCollected: x.why,   // v2.733: 이 포탈이 지금 이 vCenter 이벤트를 수집하지 않는 사유(아니면 null)
  })).sort((a, b) => (a.availability ?? 101) - (b.availability ?? 101));
  let dAll = 0; let sAll = 0;
  for (const x of perVc.values()) { dAll += x.downMs; sAll += x.spanMs; }
  const totals = {
    availability: sAll > 0 ? pctOf(dAll, sAll) : null,
    ha: out.reduce((a, r) => a + r.ha, 0), resets: out.reduce((a, r) => a + r.resets, 0),
    reboots: out.reduce((a, r) => a + r.reboots, 0), failed: out.reduce((a, r) => a + r.failed, 0),
    offs: out.reduce((a, r) => a + r.offs, 0), userOffs: out.reduce((a, r) => a + r.userOffs, 0),
  };
  return { days, since, target, readFrom: cut, coverage: cov, totals, vcenters, matched: shown.length, vms: shown.slice(0, ROWS_MAX), omitted: Math.max(0, shown.length - ROWS_MAX) };
}
