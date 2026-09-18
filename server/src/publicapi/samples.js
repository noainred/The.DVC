/**
 * 공개 API 문서 페이지에 싣는 **합성 샘플 응답** (v2.564) — 순수 모듈.
 *
 * ⚠⚠ **여기에 실제 운영 데이터를 넣지 말 것.** 이 값들은 **로그인 없이 보이는 페이지**에
 * 실린다. 라이브 스냅샷에서 한 건만 떠다 써도 그 순간 vCenter 이름·호스트명·대수가 무인증
 * 으로 새어 나간다(v2.535 규약 — 이 저장소는 공개이고, 화면도 같은 기준이다).
 * 그래서 전부 **손으로 지어낸 값**이고, 보는 사람이 그것을 알 수 있게
 * ① vCenter 이름은 `vcenter-demo-*` ② 장비는 `demo-*` ③ 시각은 고정 epoch 를 쓴다.
 *
 * ⚠ **필드 이름은 지어내지 않는다.** 키 집합은 `allowlist.js` 의 `fields` 와 같아야 하고,
 *   테스트가 그것을 대조한다 — 문서가 없는 필드를 보여주면 연동 담당자가 그 필드를 쓰는
 *   코드를 짠다(v2.553 '조언이 틀리면 무음 실패보다 나쁘다' 와 같은 계열).
 *
 * ⚠ **null 을 피하지 말 것.** 이 API 의 계약이 "읽지 못한 값은 0 이 아니라 null" 이므로
 *   샘플에도 `null` 이 **실제로 들어 있어야** 소비자가 그 경우를 코딩한다. 전부 값이 찬
 *   샘플만 보여주면 그 계약이 전달되지 않는다.
 */

/** 샘플이 쓰는 고정 시각 — '지금' 을 쓰면 문서가 매번 달라져 캐시·비교가 어렵다. */
export const SAMPLE_AT = 1789700000000;        // 2026-09-18T03:33:20Z
const COLLECTED_AT = SAMPLE_AT - 12_000;

/** 봉투를 씌운다 — 화면이 봉투 계약을 그대로 보여줄 수 있게. */
export function envelopeSample(path, data, meta) {
  return { ok: true, apiVersion: 'v1', endpoint: path, generatedAt: SAMPLE_AT, data, meta };
}

/**
 * 경로 → 합성 응답.
 * ⚠ 새 엔드포인트를 `allowlist.js` 에 추가하면 **여기도 추가**해야 한다 — 테스트가
 *   '샘플 없는 엔드포인트 0건' 을 고정한다(문서에 빈 칸이 생기지 않게).
 */
export const SAMPLES = Object.freeze({
  '/inventory/summary': envelopeSample('/inventory/summary', {
    vcenters: 3, hosts: 42, vms: 517, vmsPoweredOn: 468, templates: 24,
    datastores: 11, networks: 9, clusters: 6,
    cpuCores: 1344, cpuTotalMhz: 3628800, cpuUsedMhz: 1995840,
    memTotalMB: 21495808, memUsedMB: 13330400,
    storageCapacityGB: 262144, storageUsedGB: 178601,
    vmVcpu: 2318, vmRamMB: 8912896, vmProvisionedGB: 143360,
  }, { scopedToVcenters: null, collectedAt: COLLECTED_AT }),

  '/inventory/vcenters': envelopeSample('/inventory/vcenters', [
    { id: 'vc-demo-seoul', name: 'vcenter-demo-seoul-01', status: 'connected', version: '8.0.2',
      hosts: 18, vms: 233, datastores: 5, alarms: 2, collectedAt: COLLECTED_AT },
    { id: 'vc-demo-osaka', name: 'vcenter-demo-osaka-01', status: 'connected', version: '7.0.3',
      hosts: 14, vms: 181, datastores: 4, alarms: 0, collectedAt: COLLECTED_AT },
    // ⚠ 첫 수집 전인 vCenter — status 가 'pending' 이고 수치는 0 이 아니라 '아직'이다.
    { id: 'vc-demo-warsaw', name: 'vcenter-demo-warsaw-01', status: 'pending', version: null,
      hosts: 0, vms: 0, datastores: 0, alarms: 0, collectedAt: COLLECTED_AT },
  ], { scopedToVcenters: null, count: 3, truncated: false, omitted: 0, limit: 5000 }),

  '/inventory/collection': envelopeSample('/inventory/collection', {
    registered: 3, connected: 2, pending: 1, unreachable: 0, maintenance: 0,
    generatedAt: COLLECTED_AT, source: 'vcenter', intervalMs: 30000,
  }, { note: 'pending 은 첫 수집이 끝나지 않은 것이고 unreachable 은 접속 실패입니다 — 조치가 다릅니다.' }),

  '/capacity/datastores': envelopeSample('/capacity/datastores', [
    { id: 'vc-demo-seoul:demo-ds-vsan-1', vcenterId: 'vc-demo-seoul', name: 'demo-ds-vsan-1',
      type: 'vSAN', capacityGB: 32768, usedGB: 21299, freeGB: 11469, usedPct: 65 },
    { id: 'vc-demo-seoul:demo-ds-nfs-2', vcenterId: 'vc-demo-seoul', name: 'demo-ds-nfs-2',
      type: 'NFS', capacityGB: 8192, usedGB: 3113, freeGB: 5079, usedPct: 38 },
    // ⚠ 용량을 읽지 못한 데이터스토어 — usedGB·freeGB·usedPct 가 **0 이 아니라 null** 이다.
    { id: 'vc-demo-osaka:demo-ds-iscsi-1', vcenterId: 'vc-demo-osaka', name: 'demo-ds-iscsi-1',
      type: 'VMFS', capacityGB: 16384, usedGB: null, freeGB: null, usedPct: null },
  ], { scopedToVcenters: null, count: 3, truncated: false, omitted: 0, limit: 5000 }),

  '/capacity/storage': envelopeSample('/capacity/storage', [
    { deviceId: 'demo-unity-01', name: 'DEMO-UNITY-01', type: 'unity480',
      totalBytes: 117544396521472, usedBytes: 29973250195456, usedPct: 25.5,
      collectedAt: COLLECTED_AT, usedUnknown: false },
    // ⚠ 사용량을 읽지 못한 장비 — usedBytes 가 null 이고 usedUnknown 이 true 다.
    //   이 행을 '사용량 0' 으로 세면 합계가 거짓이 된다.
    { deviceId: 'demo-isilon-01', name: 'DEMO-ISILON-01', type: 'isilon',
      totalBytes: 549755813888000, usedBytes: null, usedPct: null,
      collectedAt: COLLECTED_AT, usedUnknown: true },
  ], {
    count: 2, truncated: false, omitted: 0, limit: 5000, usedUnknownCount: 1,
    note: '사용량을 읽지 못한 장비 1대는 usedBytes 가 null 입니다 — 0 으로 채우지 않았습니다.',
  }),

  '/capacity/storage-growth': envelopeSample('/capacity/storage-growth', [
    { deviceId: 'demo-unity-01', name: 'DEMO-UNITY-01',
      usedBytes: 29973250195456, totalBytes: 117544396521472, observedDays: 412,
      // ⚠ 감소(-)를 0 으로 깎지 않는다 — 실제로 줄어든 것이다.
      growth: { '1d': 8589934592, '7d': 41875931136, '30d': -12884901888 }, unknownUsed: false },
    // ⚠ 관측이 짧아 기준선이 없는 기간은 **null**('증가 0' 이 아니다).
    { deviceId: 'demo-powerstore-01', name: 'DEMO-POWERSTORE-01',
      usedBytes: 4398046511104, totalBytes: 21990232555520, observedDays: 3,
      growth: { '1d': 2147483648, '7d': null, '30d': null }, unknownUsed: false },
  ], {
    count: 2, truncated: false, omitted: 0, limit: 5000,
    periods: ['1d', '7d', '30d'], periodsDropped: 0, unknownUsedCount: 0,
    note: '기준선이 없는 기간은 null 입니다 — 관측이 짧은 구간을 추정으로 메우지 않습니다.',
  }),

  '/faults/alarms': envelopeSample('/faults/alarms', [
    { id: 'vc-demo-seoul:demo-esxi-07:12', vcenterId: 'vc-demo-seoul', entity: 'demo-esxi-07',
      entityType: 'host', name: 'Host connection and power state', severity: 'critical',
      triggeredAt: SAMPLE_AT - 3_600_000, muted: false },
    // ⚠ 음소거된 알람도 목록에 있다(빼면 '알람 없음' 이라는 거짓이 된다) — muted 로 표시만 한다.
    { id: 'vc-demo-osaka:demo-ds-nfs-2:4', vcenterId: 'vc-demo-osaka', entity: 'demo-ds-nfs-2',
      entityType: 'datastore', name: 'Datastore usage on disk', severity: 'warning',
      triggeredAt: SAMPLE_AT - 86_400_000, muted: true },
  ], {
    scopedToVcenters: null, count: 2, truncated: false, omitted: 0, limit: 5000, mutedCount: 1,
    note: '음소거된 알람도 포함하고 muted:true 로 표시합니다 — 목록에서 빼지 않습니다.',
  }),

  '/faults/parts': envelopeSample('/faults/parts', [
    { partKey: 'idrac:DEMOTAG1:psu:PSU.Slot.2', agent: 'edge-demo-seoul', scope: 'idrac',
      deviceKey: 'DEMOTAG1', kind: 'psu', partId: 'PSU.Slot.2', state: 'fault',
      openedAt: SAMPLE_AT - 172_800_000, lastSeenAt: SAMPLE_AT - 900_000, reason: null },
    // ⚠ 장비 수집이 실패한 동안에는 장애를 **닫지 않고 보류**한다 — reason 이 그 사유다.
    { partKey: 'storage:demo-unity-01:fan:all', agent: 'edge-demo-osaka', scope: 'storage',
      deviceKey: 'demo-unity-01', kind: 'fan', partId: 'all', state: 'warn',
      openedAt: SAMPLE_AT - 604_800_000, lastSeenAt: SAMPLE_AT - 21_600_000,
      reason: 'device-failed' },
  ], {
    count: 2, truncated: false, omitted: 0, limit: 5000,
    note: '확인 불가(unknown)·빈 슬롯(absent)은 장애로 세지 않습니다 — state 를 그대로 보세요.',
  }),
});

/** 엔드포인트별 샘플(없으면 null — 화면이 '샘플 없음' 이라고 말한다). */
export const sampleFor = (p) => SAMPLES[p] || null;
