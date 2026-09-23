/**
 * vmtrack/diff.js — VM 수량 추이의 순수 로직(v2.345): 슬롯 키 계산 + 스냅샷 diff.
 * DB·시각 의존성을 배제해 단위테스트로 고정한다(now 주입 가능).
 *
 * 슬롯: 사용자 요구 "매일 00시·12시 기준" — 포탈 시간대(기본 KST)의 00:00 / 12:00 두 슬롯(v2.586).
 *   키는 'YYYY-MM-DDT00' | 'YYYY-MM-DDT12'. 같은 슬롯에 두 번 수집되면 DB 가 UPSERT 로
 *   덮어써 중복 행이 생기지 않는다(수동 스냅샷도 같은 슬롯이면 최신 값으로 갱신).
 */
import { numOrNull } from '../util/numOrNull.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';

const pad = (n) => String(n).padStart(2, '0');

/**
 * 시각 → 슬롯 키. 00:00~11:59 → …T00, 12:00~23:59 → …T12.
 *
 * ⚠ v2.586 — **포탈 오프셋(`util/dayKey.js DAY_OFFSET_MIN`, 기본 KST)으로 자른다.** 예전에는 `getHours()`·
 *   `getDate()`(프로세스 TZ)였는데 패키지 유닛(`vmware-portal.service`)은 TZ 를 지정하지 않아, 호스트가 UTC 면
 *   사용자 요구 "매일 00시·12시" 가 **KST 09시·21시**가 됐다(v2.583 이 '별건' 으로 적어 둔 것).
 *   · 호스트 TZ 가 이미 KST 면 **결과가 한 글자도 바뀌지 않는다**(마이그레이션 불필요 — 테스트가 고정).
 *   · 호스트가 UTC 였던 현장은 교체 순간 한 번 불연속이 생긴다: 옛 키는 UTC 기준이라 차트 x(`slotStartMs`)가
 *     9시간 앞당겨 보이고, 교체 시각에 따라 같은 문자열의 슬롯 1개가 새 수집으로 덮일 수 있다(UPSERT).
 *     키 형식이 날짜 문자열뿐이라 옛 행이 어느 TZ 로 만들어졌는지 알 길이 없다 — 지어내 보정하지 않는다.
 */
export function slotKey(now = new Date(), offsetMin = DAY_OFFSET_MIN) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const d = new Date(t + offsetMin * 60_000); // 포탈 벽시계를 UTC 필드로 읽는다
  const half = d.getUTCHours() < 12 ? '00' : '12';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${half}`;
}

/** 슬롯 키 → 그 슬롯의 시작 시각(ms, 포탈 오프셋 기준). 차트 x축 정렬용(수집이 몇 분 늦어도 눈금은 일정). */
export function slotStartMs(slot, offsetMin = DAY_OFFSET_MIN) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(00|12)$/.exec(String(slot || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), 0, 0, 0) - offsetMin * 60_000;
}

/**
 * VM 스냅샷 항목 정규화 — store 스냅샷의 VM 객체에서 추적에 필요한 필드만 뽑는다.
 * vmId 는 스냅샷의 v.id('<vcId>:<moref>')를 그대로 쓴다(moref 는 vCenter 안에서 불변이라
 * 이름 변경·이동에도 동일 VM 으로 추적된다 — 이름 기준이면 rename 이 삭제+생성으로 오탐).
 */
export function normalizeVm(v) {
  return {
    vmId: String(v.id || v.moref || v.name || ''),
    name: v.name || '',
    cluster: v.cluster || '',
    host: v.host || '',
    // 데이터스토어: 스냅샷은 배열(여러 개 사용) 또는 단일 문자열일 수 있다 — 표시용으로 합친다.
    datastore: Array.isArray(v.datastores) ? v.datastores.join(', ') : (v.datastore || ''),
    powerState: v.powerState || '',
    // ⚠ v2.574 BUG-09 — `Number(null) === 0` 형태였다. **도달 경로는 확정하지 못했다**
    //   (생산자 3곳 `soapClient.js:1453`·`restClient.js:204`·`mock/generator.js:257` 이 `null` 을
    //   내는 경우를 증명하지 못했다) — 그래서 '결함 수정' 이 아니라 **형태 교정**이다.
    //   그래도 고치는 이유: 여기서 0 이 되면 '0 vCPU'·'0MB' 라는 **오류 없이 틀린 값**이고
    //   그것이 추이 diff 에 '사양 변경' 으로 기록된다. 판정은 `numOrNull` 하나가 갖는다(v2.561).
    cpu: numOrNull(v.cpuCount),
    memMB: numOrNull(v.memMB),
    storageGB: numOrNull(v.storageGB),
    guestOS: v.guestOS || '',
  };
}

const isOn = (s) => s === 'POWERED_ON';

/**
 * 한 vCenter 의 diff 계산.
 * @param {Array} vms       현재 스냅샷의 그 vCenter VM 목록(원본 객체)
 * @param {Map}   prevRoster 직전 로스터 Map<vmId, row>(DB roster). 빈 Map 이면 baseline.
 * @returns {{ total, onCount, offCount, added:Array, removed:Array,
 *            poweredOn:Array, poweredOff:Array, live:Array, baseline:boolean }}
 *   baseline=true(직전 로스터 없음)면 added/removed/전환을 비운다 — 최초 1회가 전량 '신규'로
 *   잡혀 차트·목록이 왜곡되는 것을 막는다(기준선만 세우고 증감은 다음 슬롯부터).
 *   전원 전환(v2.347)은 **양쪽 스냅샷에 모두 존재하는 VM** 만 센다 — 새로 생성된 켜진 VM 은
 *   added 로만, 삭제된 켜진 VM 은 removed 로만 집계해 중복(생성=전원켜짐)을 만들지 않는다.
 */
export function diffVcenter(vms, prevRoster) {
  const live = (vms || []).map(normalizeVm).filter((v) => v.vmId);
  const total = live.length;
  const onCount = live.filter((v) => isOn(v.powerState)).length;
  const offCount = total - onCount;
  const baseline = !prevRoster || prevRoster.size === 0;
  if (baseline) return { total, onCount, offCount, added: [], removed: [], poweredOn: [], poweredOff: [], live, baseline: true };

  const nowIds = new Set(live.map((v) => v.vmId));
  const added = [];
  const poweredOn = [];
  const poweredOff = [];
  for (const v of live) {
    const prev = prevRoster.get(v.vmId);
    if (!prev) { added.push(v); continue; } // 신규 — 전환 집계 대상 아님
    const was = isOn(prev.power_state);
    const now = isOn(v.powerState);
    if (was === now) continue;
    // 전환 항목은 '현재 위치 + 이전 상태'를 함께 담아 상세 화면이 'Off → On' 을 보여줄 수 있게.
    const item = { ...v, prevPowerState: prev.power_state || '' };
    if (now) poweredOn.push(item); else poweredOff.push(item);
  }
  const removed = [];
  for (const [vmId, r] of prevRoster) {
    if (nowIds.has(vmId)) continue;
    removed.push({
      vmId, name: r.name || '', cluster: r.cluster || '', host: r.host || '',
      datastore: r.datastore || '', powerState: r.power_state || '',
      cpu: r.cpu ?? null, memMB: r.mem_mb ?? null, storageGB: r.storage_gb ?? null, guestOS: r.guest_os || '',
    });
  }
  return { total, onCount, offCount, added, removed, poweredOn, poweredOff, live, baseline: false };
}

// ── 데이터스토어 사용량 추적(v2.348, 사용자 요구: "vCenter 와 연결된 데이터스토어 사용량") ──

// '의미 있는 사용량 변화' 임계(GB). 이보다 작은 흔들림은 ds_changes 에 남기지 않는다 —
// 수백 DS × 2회/일 × 28 vCenter 를 전부 적재하면 연 수백만 행이 되고, 목록도 노이즈가 된다.
// 합계 시계열(ds_used_gb)은 임계와 무관하게 항상 정확하다(차트는 그 값을 쓴다).
const DS_DELTA_MIN_GB = Number(process.env.VMTRACK_DS_DELTA_MIN_GB) || 1;

const num = numOrNull;   // v2.561: 판정은 util/numOrNull.js 하나가 갖는다(Number(null)===0 함정)

/** 스냅샷 데이터스토어 → 추적 필드. id 는 스냅샷 id('<vcId>:<name>')를 그대로 쓴다. */
export function normalizeDs(d) {
  const capGB = num(d.capacityGB);
  const usedGB = num(d.usedGB);
  const freeGB = num(d.freeGB) ?? (capGB != null && usedGB != null ? capGB - usedGB : null);
  return {
    dsId: String(d.id || d.name || ''),
    name: d.name || '',
    type: d.storageType || d.type || '',
    capGB, usedGB, freeGB,
    usagePct: (capGB && usedGB != null) ? Math.round((usedGB / capGB) * 1000) / 10 : null,
  };
}

/**
 * 한 vCenter 의 데이터스토어 집계 + 변경 계산.
 * @returns {{count, capGB, usedGB, freeGB, usagePct, added, removed, changed, live, baseline}}
 *   changed: 직전 슬롯 대비 사용량이 임계(기본 1GB) 이상 바뀐 DS(prevUsedGB·deltaGB 포함).
 *   added/removed: 연결/해제된 DS(사용량 증감과 별개로 항상 기록 — 규모 변화 원인 추적).
 */
export function diffDatastores(datastores, prevRoster) {
  const live = (datastores || []).map(normalizeDs).filter((d) => d.dsId);
  let capGB = 0, usedGB = 0;
  for (const d of live) { capGB += d.capGB || 0; usedGB += d.usedGB || 0; }
  const agg = {
    count: live.length,
    capGB: Math.round(capGB * 10) / 10,
    usedGB: Math.round(usedGB * 10) / 10,
    freeGB: Math.round((capGB - usedGB) * 10) / 10,
    usagePct: capGB > 0 ? Math.round((usedGB / capGB) * 1000) / 10 : 0,
    live,
  };
  const baseline = !prevRoster || prevRoster.size === 0;
  // 데이터스토어별 시계열 기록 대상(v2.353, 사용자 요구: "연결된 데이터스토어별 증감 추이") —
  // 첫 관측(신규/기준선) 또는 사용량·용량이 임계 이상 바뀐 DS 만 남긴다. 전 DS 를 매 슬롯
  // 적재하면 1,100 DS × 2회/일 = 연 80만 행이지만, 대부분의 VMFS 는 사용량이 안 변하므로
  // '값이 바뀐 순간'만 기록하고 조회 시 마지막 관측값을 이어붙인다(step) — 합계와 같은 diff-압축.
  const series = [];
  for (const d of live) {
    const prev = baseline ? null : prevRoster.get(d.dsId);
    if (!prev) { series.push(d); continue; } // 첫 관측(기준선 포함) — 시계열의 시작점
    // v2.590 P4/P5: 로더가 '마지막으로 기록한 값' 을 붙여 주면(series_known) 그것과 비교한다 — 로스터(직전 슬롯)와
    // 비교하면 슬롯당 임계 미만의 꾸준한 증가가 영원히 기록되지 않는다. 기록이 없으면(prune 뒤) 첫 관측으로 다시 쓴다.
    if (prev.series_known === false) { series.push(d); continue; }
    const hasSeries = prev.series_known === true;
    const prevUsed = num(hasSeries ? prev.series_used_gb : prev.used_gb);
    const prevCap = num(hasSeries ? prev.series_cap_gb : prev.cap_gb);
    // 직전 값이 없다가 생긴 것도 '변화'로 기록(Infinity ≥ 임계). 양쪽 다 없으면 판단 불가 → 스킵.
    const dU = (d.usedGB != null && prevUsed != null) ? Math.abs(d.usedGB - prevUsed) : (d.usedGB != null ? Infinity : 0);
    const dC = (d.capGB != null && prevCap != null) ? Math.abs(d.capGB - prevCap) : (d.capGB != null ? Infinity : 0);
    if (dU >= DS_DELTA_MIN_GB || dC >= DS_DELTA_MIN_GB) series.push(d);
  }
  if (baseline) return { ...agg, added: [], removed: [], changed: [], series, baseline: true };

  const nowIds = new Set(live.map((d) => d.dsId));
  const added = [];
  const changed = [];
  for (const d of live) {
    const prev = prevRoster.get(d.dsId);
    if (!prev) { added.push(d); continue; } // 신규 연결 — 사용량 변화가 아니라 '추가'로
    const prevUsed = num(prev.used_gb);
    if (prevUsed == null || d.usedGB == null) continue;
    const deltaGB = Math.round((d.usedGB - prevUsed) * 10) / 10;
    if (Math.abs(deltaGB) < DS_DELTA_MIN_GB) continue;
    changed.push({ ...d, prevUsedGB: prevUsed, deltaGB });
  }
  const removed = [];
  for (const [dsId, r] of prevRoster) {
    if (nowIds.has(dsId)) continue;
    removed.push({
      dsId, name: r.name || '', type: r.type || '',
      capGB: num(r.cap_gb), usedGB: num(r.used_gb), freeGB: num(r.free_gb),
      usagePct: (num(r.cap_gb) && num(r.used_gb) != null) ? Math.round((num(r.used_gb) / num(r.cap_gb)) * 1000) / 10 : null,
    });
  }
  return { ...agg, added, removed, changed, series, baseline: false };
}

/** 전체 합계 행 — vCenter별 결과를 더한다(증감·전원 전환·데이터스토어도 합산). */
export function totalsOf(perVc) {
  const t = { total: 0, onCount: 0, offCount: 0, added: 0, removed: 0, poweredOn: 0, poweredOff: 0,
    dsCount: 0, dsCapGB: 0, dsUsedGB: 0, baseline: false };
  let allBaseline = perVc.length > 0;
  for (const vc of perVc) {
    t.total += vc.total; t.onCount += vc.onCount; t.offCount += (vc.offCount ?? (vc.total - vc.onCount));
    t.added += vc.added.length; t.removed += vc.removed.length;
    t.poweredOn += (vc.poweredOn || []).length; t.poweredOff += (vc.poweredOff || []).length;
    t.dsCount += vc.ds?.count || 0;
    t.dsCapGB += vc.ds?.capGB || 0;
    t.dsUsedGB += vc.ds?.usedGB || 0;
    if (!vc.baseline) allBaseline = false;
  }
  t.dsCapGB = Math.round(t.dsCapGB * 10) / 10;
  t.dsUsedGB = Math.round(t.dsUsedGB * 10) / 10;
  t.baseline = allBaseline; // 전 vCenter 가 기준선일 때만 전체도 기준선 표기
  return t;
}
