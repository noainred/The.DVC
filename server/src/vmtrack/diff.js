/**
 * vmtrack/diff.js — VM 수량 추이의 순수 로직(v2.345): 슬롯 키 계산 + 스냅샷 diff.
 * DB·시각 의존성을 배제해 단위테스트로 고정한다(now 주입 가능).
 *
 * 슬롯: 사용자 요구 "매일 00시·12시 기준" — 로컬 시간대의 00:00 / 12:00 두 슬롯.
 *   키는 'YYYY-MM-DDT00' | 'YYYY-MM-DDT12'. 같은 슬롯에 두 번 수집되면 DB 가 UPSERT 로
 *   덮어써 중복 행이 생기지 않는다(수동 스냅샷도 같은 슬롯이면 최신 값으로 갱신).
 */

const pad = (n) => String(n).padStart(2, '0');

/** 로컬 시각 → 슬롯 키. 00:00~11:59 → …T00, 12:00~23:59 → …T12. */
export function slotKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const half = d.getHours() < 12 ? '00' : '12';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${half}`;
}

/** 슬롯 키 → 그 슬롯의 시작 시각(ms). 차트 x축 정렬용(수집이 몇 분 늦어도 눈금은 일정). */
export function slotStartMs(slot) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(00|12)$/.exec(String(slot || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), 0, 0, 0).getTime();
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
    cpu: Number.isFinite(Number(v.cpuCount)) ? Number(v.cpuCount) : null,
    memMB: Number.isFinite(Number(v.memMB)) ? Number(v.memMB) : null,
    storageGB: Number.isFinite(Number(v.storageGB)) ? Number(v.storageGB) : null,
    guestOS: v.guestOS || '',
  };
}

/**
 * 한 vCenter 의 diff 계산.
 * @param {Array} vms       현재 스냅샷의 그 vCenter VM 목록(원본 객체)
 * @param {Map}   prevRoster 직전 로스터 Map<vmId, row>(DB roster). 빈 Map 이면 baseline.
 * @returns {{ total, onCount, added:Array, removed:Array, live:Array, baseline:boolean }}
 *   baseline=true(직전 로스터 없음)면 added/removed 를 비운다 — 최초 1회가 전량 '신규'로
 *   잡혀 차트·목록이 왜곡되는 것을 막는다(기준선만 세우고 증감은 다음 슬롯부터).
 */
export function diffVcenter(vms, prevRoster) {
  const live = (vms || []).map(normalizeVm).filter((v) => v.vmId);
  const total = live.length;
  const onCount = live.filter((v) => v.powerState === 'POWERED_ON').length;
  const baseline = !prevRoster || prevRoster.size === 0;
  if (baseline) return { total, onCount, added: [], removed: [], live, baseline: true };

  const nowIds = new Set(live.map((v) => v.vmId));
  const added = live.filter((v) => !prevRoster.has(v.vmId));
  const removed = [];
  for (const [vmId, r] of prevRoster) {
    if (nowIds.has(vmId)) continue;
    removed.push({
      vmId, name: r.name || '', cluster: r.cluster || '', host: r.host || '',
      datastore: r.datastore || '', powerState: r.power_state || '',
      cpu: r.cpu ?? null, memMB: r.mem_mb ?? null, storageGB: r.storage_gb ?? null, guestOS: r.guest_os || '',
    });
  }
  return { total, onCount, added, removed, live, baseline: false };
}

/** 전체 합계 행 — vCenter별 결과를 더한다(증감도 합산). */
export function totalsOf(perVc) {
  const t = { total: 0, onCount: 0, added: 0, removed: 0, baseline: false };
  let allBaseline = perVc.length > 0;
  for (const vc of perVc) {
    t.total += vc.total; t.onCount += vc.onCount;
    t.added += vc.added.length; t.removed += vc.removed.length;
    if (!vc.baseline) allBaseline = false;
  }
  t.baseline = allBaseline; // 전 vCenter 가 기준선일 때만 전체도 기준선 표기
  return t;
}
