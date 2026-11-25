/**
 * 외부 공개 API 의 허용 목록 카탈로그 (v2.562) — **순수 모듈**. 판정은 이 파일 하나가 소유한다.
 *
 * ⚠⚠ **거부 기본값이다.** 이 저장소의 `/api/*` 라우트는 천 개가 넘고(정확한 수 · 조회/변경 분포는 생성 문서 `docs/API.md` 요약 —
 *   손으로 적은 수는 릴리스마다 낡는다: v2.562 당시의 수(686)를 적은 줄이 v3.41(1,626) 시점까지 남아 있었다)
 * 거기에는 RMA 원격 명령 실행 · VM 프로비저닝 · `shutdown` · 호스트 방화벽 변경 ·
 * 백업 다운로드(= `AUTH_SECRET`·TOTP 시크릿 사본)가 섞여 있다. "전부 노출" 은 외부 포탈의 키
 * 하나가 인프라 전체를 조작할 수 있다는 뜻이므로, **여기 적힌 것만** 나간다.
 *
 * ⚠⚠ **상태변경을 여기 넣지 말 것.** `ENDPOINTS` 의 모든 항목은 GET 이고
 * `test/publicApi2562.test.js` 가 소스에서 그것을 고정한다. 쓰기를 열어야 하면 별건으로
 * 다루고, 그때도 '관리자가 명시적으로 고른 경로만' 이라는 축을 유지할 것.
 *
 * ⚠⚠ **내부 경로를 그대로 노출하지 않는다.** 이 저장소의 응답은 자체 UI 전용으로 만들어져
 * 필드가 자유롭게 바뀐다 — 실제로 `zoning.zones` 가 숫자→배열로, `capacityNote`→
 * `capacityBasisNote` 로 바뀐 전례가 있다. 외부 소비자가 내부 형태에 붙으면 그 변경이
 * **남의 포탈을 깨뜨린다**. 그래서 `/api/v1/...` 은 **선언된 필드만** 투사(projection)하고,
 * 내부 필드가 사라지면 테스트가 먼저 깨진다(소비자가 아니라 우리가 먼저 안다).
 *
 * 분류(`groups`)는 키마다 켠다. 분류를 나눈 기준은 **노출되는 식별자의 민감도**다:
 *   · `inventory` — 개수·합계·상태. 이름·IP 를 주지 않는다(가장 짧은 범위).
 *   · `capacity`  — 용량·사용률 추이. **장비명·법인**이 들어가므로 vCenter scope 가 걸린다.
 *   · `faults`    — 알람·부품 장애. 장비·엔티티 이름이 들어간다.
 *
 * ⚠⚠ **'포탈 자신의 상태' 분류는 1차에서 만들지 않았다**(관리자가 고르지 않았다). 초판에
 * `/portal/status` 를 넣어 뒀는데, 그것이 **선언 필드와 핸들러가 어긋난 채로** 있었다 —
 * 선언은 `uptimeSec`·`source`·`generatedAt` 인데 핸들러는 `startedAt`·`dataSource` 를 만들어
 * `project()` 가 **3개를 영원히 null 로** 채웠고, 근거로 읽던 `config.startedAt`·
 * `collector.lastSeenAt` 은 **이 저장소에 존재하지 않는 필드**였다(grep 0건 — `edgesFresh` 가
 * 언제나 0 이 된다). 요청되지 않은 분류를 '있으니까' 로 함께 실으면 이렇게 검증이 얕아진다.
 * 다시 필요해지면 **근거 필드를 코드로 확인한 뒤** 별건으로 추가할 것.
 */

/** 분류 정의 — 라벨·설명은 화면이 그대로 쓴다(문구를 화면에 복제하지 말 것). */
export const GROUPS = Object.freeze([
  {
    key: 'inventory',
    label: '인벤토리 지표',
    desc: 'vCenter·호스트·VM·데이터스토어·알람의 개수와 합계, 수집 상태. 이름·IP 를 주지 않습니다.',
    sensitivity: 'low',
  },
  {
    key: 'capacity',
    label: '용량 · 사용량 추이',
    desc: '스토리지 용량과 증가량, 데이터스토어 사용률. 장비명·법인이 들어가므로 키의 vCenter 범위가 걸립니다.',
    sensitivity: 'medium',
  },
  {
    key: 'faults',
    label: '장애 · 알람 현황',
    desc: 'vCenter 알람과 물리 부품 장애. 장비·엔티티 이름이 들어갑니다.',
    sensitivity: 'medium',
  },
  {
    key: 'san',
    label: 'SAN 스토리지 성능',
    desc: 'SAN 스위치 포트 사용량으로 본 스토리지 어레이별 처리량 · 편중 · 성능 점검 판정과 어레이 측(디렉터 · 노드 · SP) 값. 어레이 이름 · 시리얼 · 법인이 들어가고 vCenter 범위로 나눌 수 없어 전체 범위 키만 씁니다(v2.950).',
    sensitivity: 'medium',
  },
  /*
   * v3.42.0(사용자 요청 '없는 API 추가해줘' · 선택 '1차 핵심 조회'): 새 경로 9개는 **기존 분류에 넣지 않고 새 분류 넷**으로 나눴다.
   *   기존 분류에 넣으면 이미 발급된 키(예: capacity 만 켠 키)가 관리자 조작 없이 호스트 · VM 이름 · IP 를 보게 된다 — 거부 기본값의 취지와 반대다.
   *   새 분류는 관리자가 키마다 켜야 열린다(test/publicApi3420.test.js 가 '기존 분류 키로는 403' 을 고정한다).
   */
  {
    key: 'objects',
    label: '자원 목록 (이름 · IP)',
    desc: '호스트 · VM · 네트워크 · 클러스터의 개별 목록. 이름 · IP · 서비스태그 · 호스트 배치가 들어가 민감도가 가장 높습니다. 키의 vCenter 범위가 걸립니다.',
    sensitivity: 'high',
  },
  {
    key: 'compliance',
    label: '점검 · 준수',
    desc: 'vCenter 라이선스 만료와 VM 스냅샷 나이. 스냅샷 목록에 VM 이름 · 호스트 · 클러스터가 들어갑니다(IP 는 없음). 라이선스 키 값과 스냅샷 이름 · 설명은 주지 않습니다. 키의 vCenter 범위가 걸립니다.',
    sensitivity: 'medium',
  },
  {
    key: 'backup',
    label: '백업 현황',
    desc: '법인(vCenter)별 백업 정책 · 최근 결과 · RPO 집계. VM 이름은 주지 않습니다. 키의 vCenter 범위가 걸립니다.',
    sensitivity: 'medium',
  },
  {
    key: 'resources',
    label: '전력 · GPU',
    desc: '전체 소비 전력 합계(서버 · 네트워크 · 스토리지)와 GPU 장착 호스트별 장수 · 사용률. GPU 목록에 호스트 이름 · 클러스터가 들어갑니다(할당 VM 이름은 없음). 전력은 vCenter 범위로 나눌 수 없어 범위 없는 키만 조회합니다.',
    sensitivity: 'medium',
  },
]);

export const GROUP_KEYS = Object.freeze(GROUPS.map((g) => g.key));
export const GROUP_BY_KEY = Object.freeze(Object.fromEntries(GROUPS.map((g) => [g.key, g])));

/**
 * 공개 엔드포인트 선언. `path` 는 `/api/v1` 아래의 경로다.
 *
 * `fields` 는 **계약**이다 — 여기 적힌 것만 응답에 나가고, 테스트가 실제 응답 키와 대조한다.
 * `scoped: true` 면 키의 vCenter 범위가 적용된다(빈 범위 = 전체).
 * `list` 는 `data` 가 배열(행 목록)인가 — OpenAPI 스키마가 이 값을 쓴다(67회차 F3: 예전에는 선언이 없어 필드에 id · deviceId · partKey 가
 *   있는지로 추측했고, `key` 를 쓰는 `/san-storage/*` 두 경로가 실제로는 배열인데 문서에는 객체 하나로 나갔다). 새 경로는 반드시 적는다
 *   (`test/contentApiAudit67.test.js` 가 핸들러의 project/projectAll 과 대조한다).
 */
/** v3.42.0: 목록 경로 공통 쿼리 인자 — 키의 범위 안 vCenter 하나로 좁힌다(범위 밖 · 없는 id 는 같은 404 — 존재를 흘리지 않는다). */
const VC_PARAM = Object.freeze({ name: 'vcenterId', type: 'string', desc: '이 vCenter 하나만(키의 범위 밖이거나 없는 id 는 404 unknown-vcenter)' });

export const ENDPOINTS = Object.freeze([
  {
    path: '/inventory/summary', list: false, group: 'inventory', method: 'GET', scoped: true,
    // v2.632: storageCapacityGB·storageUsedGB 는 **사용량을 읽은 DS 만**(내부 /summary 와 같은 기준 — 사용률 계산용).
    //   설치 용량 전체는 storageCapacityAllGB, 사용량을 못 읽어 뺀 DS 수는 datastoresUsageUnknown.
    // v2.727(C-01): vmProvisionedGB 는 스토리지를 읽은 VM 만의 합 — 못 읽어 뺀 VM 수는 vmStorageUnknown.
    // v3.19.2: vmVcpu · vmRamMB 도 읽은 VM 만의 합(값은 예전 그대로) — 못 읽어 뺀 VM 수는 vmVcpuUnknown · vmRamUnknown.
    summary: '전 vCenter 합계 — 개수와 자원 총량(스토리지 용량·사용은 사용량을 읽은 DS 기준, 설치 용량 전체는 storageCapacityAllGB)',
    fields: ['vcenters', 'hosts', 'vms', 'vmsPoweredOn', 'templates', 'datastores', 'networks', 'clusters',
      'cpuCores', 'cpuTotalMhz', 'cpuUsedMhz', 'memTotalMB', 'memUsedMB', 'storageCapacityGB', 'storageUsedGB',
      'storageCapacityAllGB', 'datastoresUsageUnknown',
      'vmVcpu', 'vmRamMB', 'vmVcpuUnknown', 'vmRamUnknown', 'vmProvisionedGB', 'vmStorageUnknown'],
  },
  {
    path: '/inventory/vcenters', list: true, group: 'inventory', method: 'GET', scoped: true,
    summary: 'vCenter 별 개수·상태 — 이름과 id 는 주고 자격증명·주소는 주지 않는다',
    // v2.732(점검 2회차 B2-01·B2-05): collectedAt 은 그 값을 실제로 받은 시각(위임 → 엣지 push 수신 · 접속 실패 이월 → 마지막
    //   정상 수집), stale 은 그 값이 낡았는가(true/false), alarms 는 경보를 조회하지 않은 vCenter(REST 폴백)면 null.
    fields: ['id', 'name', 'status', 'version', 'hosts', 'vms', 'datastores', 'alarms', 'collectedAt', 'stale'],
  },
  {
    // v2.599(AUTHZ-2599-04): 범위 키에는 그 범위 vCenter 만 센다 — 내부 /health(v2.583)와 같은 기준.
    path: '/inventory/collection', list: false, group: 'inventory', method: 'GET', scoped: true,
    summary: '수집 상태 — 첫 수집 중(pending)과 접속 실패(unreachable)를 구분해 준다',
    /*
     * ⚠ 상태값은 스냅샷의 실제 값(`connected`·`pending`·`unreachable`·`maintenance`)을
     *   그대로 센다 — `/health`(`routes/api/overviewNsx.js:88`)와 **같은 기준**이다.
     *   추측 정규식으로 분류하면 두 화면이 다른 수를 말한다.
     */
    // v2.732(점검 2회차 B2-01): stale — 담당 엣지의 push 가 기준 시간을 넘긴 위임 vCenter 수(상태 개수와 겹치는 별도 축,
    //   /health vcentersStale 과 같은 판정).
    fields: ['registered', 'connected', 'pending', 'unreachable', 'maintenance', 'stale', 'generatedAt', 'source', 'intervalMs'],
    // v3.42.0(반증 B-1): 첫 병합 전 골격 스냅샷(store.publishSkeleton — initial:true)에도 답하는 유일한 경로 — 수집 상태(pending 수)가 이 경로의 값 자체다.
    //   나머지 경로는 골격이면 503 not-collected(문서 · OpenAPI 가 약속한 대로 — 골격의 0 · 빈 배열을 '없다' 로 주지 않는다).
    servesSkeleton: true,
  },
  {
    path: '/capacity/datastores', list: true, group: 'capacity', method: 'GET', scoped: true,
    summary: '데이터스토어 용량·사용률',
    fields: ['id', 'vcenterId', 'name', 'type', 'capacityGB', 'usedGB', 'freeGB', 'usedPct'],
  },
  {
    path: '/capacity/storage', list: true, group: 'capacity', method: 'GET', scoped: false, requiresFullScope: true,
    summary: '스토리지 장비 용량 — 읽지 못한 값은 null 이고 0 으로 채우지 않는다',
    fields: ['deviceId', 'name', 'type', 'totalBytes', 'usedBytes', 'usedPct', 'collectedAt', 'usedUnknown'],
  },
  {
    path: '/capacity/storage-growth', list: true, group: 'capacity', method: 'GET', scoped: false, requiresFullScope: true,
    summary: '스토리지 증가량 — 기준선이 없으면 null(추정으로 메우지 않는다)',
    // v2.604: resolutionBytes — 반올림 표기 용량 장비의 해상도(정확하면 null).
    // v2.682(R3A-07): excludedFromTotals — 'retired'|'stale'|null(meta 합계 기준에서 빠졌는가).
    // v2.733(C2-03): growthSpanDays — 기간별 실제 비교 구간(일). meta.maxSpanDays 를 넘는 칸은 요청 기간보다 긴 증가라
    //   포탈 합계에서 뺀다(그 수는 meta.inexactCount) — 행을 더하는 상대 포탈이 같은 기준을 쓸 수 있게.
    fields: ['deviceId', 'name', 'usedBytes', 'totalBytes', 'observedDays', 'growth', 'growthSpanDays', 'unknownUsed', 'resolutionBytes', 'excludedFromTotals'],
  },
  {
    path: '/faults/alarms', list: true, group: 'faults', method: 'GET', scoped: true,
    summary: 'vCenter 알람 — 음소거된 것은 제외하지 않고 muted 로 밝힌다',
    fields: ['id', 'vcenterId', 'entity', 'entityType', 'name', 'severity', 'triggeredAt', 'muted'],
  },
  {
    // ⚠⚠ v2.574 SEC-08 — `requiresFullScope` 가 빠져 있었다. 내부 동등 라우트
    //   `GET /api/tools/part-faults`(`routes/api/partFaults.js:131`)는 `fullScopeOnly` 로 **403**
    //   인데(머리말 `:11` 이 근거를 적고 있다) 공개 API 키 경로로는 **전량이 나갔다** — 같은
    //   데이터가 세션 경로에서 거절되고 키 경로에서 열리던 비대칭이다. 응답 필드 `agent`(법인 엣지
    //   이름)·`deviceKey`(서비스태그)가 그대로 실린다.
    //   부품 장애는 **agent(법인 엣지) 축**이라 vCenter 범위와 교집합할 수 없다 → 전체 범위 키만.
    path: '/faults/parts', list: true, group: 'faults', method: 'GET', scoped: false, requiresFullScope: true,
    summary: '물리 부품 장애 — 확인 불가(unknown)를 정상으로도 장애로도 세지 않는다',
    fields: ['partKey', 'agent', 'scope', 'deviceKey', 'kind', 'partId', 'state', 'openedAt', 'lastSeenAt', 'reason'],
  },
  // v2.953 — SAN 스토리지 성능(법인 축만 · vCenter 범위 미적용 → `requiresFullScope` 로 게이트가 403 needs-full-scope · 어레이 이름·시리얼이 들어간다).
  {
    path: '/san-storage/arrays', list: true, group: 'san', method: 'GET', scoped: false, requiresFullScope: true,
    summary: '어레이별 스위치 측 처리량 — 지금 · 회선 사용률 · 24시간 평균/피크 · 7일 대비 · 편중 · 수집 상태 · 30일 용량 증가(짝 지은 스토리지)',
    fields: ['key', 'name', 'vendor', 'serial', 'datacenterId', 'datacenterName', 'state', 'nowBps', 'nowAt', 'utilPct', 'avg24Bps', 'peak24Bps', 'delta7dPct',
      'imbalanceGroup', 'imbalanceRatio', 'directors', 'ports', 'switches', 'storageDeviceId', 'capacityPct', 'alertsUnresolved', 'growth30dBytes', 'daysToFull'],
  },
  {
    path: '/san-storage/check', list: true, group: 'san', method: 'GET', scoped: false, requiresFullScope: true,
    summary: '어레이별 성능 점검 판정 — 종합 · 미확인 수 · 항목별 상태(스위치 측 4 + 어레이 측 5) · 어레이 측 표본 유무',
    fields: ['key', 'name', 'datacenterId', 'datacenterName', 'overall', 'uncheckedCount', 'items', 'arraySideKeys', 'arraySideLastSampleAt', 'judgedAt'],
  },
  // ── v3.42.0 2차(새 분류 넷 — 위 GROUPS 의 머리말). `params` 는 OpenAPI 의 쿼리 인자 선언이다(핸들러가 같은 이름을 읽는다 — 테스트가 대조).
  {
    path: '/objects/hosts', list: true, group: 'objects', method: 'GET', scoped: true,
    params: [VC_PARAM],
    summary: 'ESXi 호스트 목록 — 연결 상태 · 버전 · 하드웨어 · CPU/메모리 용량과 사용률(끊긴 호스트의 사용률은 null)',
    fields: ['id', 'vcenterId', 'name', 'cluster', 'connectionState', 'powerState', 'version', 'vendor', 'model', 'cpuModel', 'serviceTag',
      'cpuSockets', 'cpuCores', 'cpuThreads', 'memTotalMB', 'cpuUsagePct', 'memUsagePct', 'vmCount', 'usageUnknown', 'bootTime'],
  },
  {
    path: '/objects/vms', list: true, group: 'objects', method: 'GET', scoped: true, paged: true,
    params: [VC_PARAM,
      { name: 'offset', type: 'integer', desc: '건너뛸 행 수(기본 0) — meta.nextOffset 으로 다음 쪽을 받습니다' },
      { name: 'limit', type: 'integer', max: 5000, desc: '한 쪽의 행 수(1~5000 · 기본 5000)' }],
    summary: 'VM 목록 — 전원 · 게스트 OS · vCPU/메모리/디스크 할당 · 배치(호스트 · 클러스터) · IP · Tools · 사용률 · 스냅샷 수(id 순 · 쪽 나눔)',
    fields: ['id', 'vcenterId', 'name', 'instanceUuid', 'powerState', 'template', 'guestOS', 'cpuCount', 'memMB', 'storageGB', 'host', 'cluster',
      'ipAddresses', 'toolsStatus', 'cpuUsagePct', 'memUsagePct', 'snapshotCount'],
  },
  {
    path: '/objects/networks', list: true, group: 'objects', method: 'GET', scoped: true,
    params: [VC_PARAM],
    summary: '가상화 네트워크(포트그룹) 목록 — 종류 · VLAN · 연결 호스트/VM 수',
    fields: ['id', 'vcenterId', 'name', 'type', 'vlanId', 'hostCount', 'vmCount'],
  },
  {
    path: '/objects/clusters', list: true, group: 'objects', method: 'GET', scoped: true,
    params: [VC_PARAM],
    summary: '클러스터 목록 — 호스트 수 · HA/DRS/EVC 구성 · 규칙 수 · 점검 결과(구성을 못 읽은 클러스터의 HA/DRS 는 null)',
    fields: ['vcenterId', 'name', 'ref', 'vcDatacenter', 'sameName', 'hosts', 'hostsDisconnected', 'collected', 'collectedAt',
      'haEnabled', 'drsEnabled', 'drsBehavior', 'evcMode', 'rulesTotal', 'severity', 'findings'],
  },
  {
    path: '/compliance/licenses', list: true, group: 'compliance', method: 'GET', scoped: true,
    params: [VC_PARAM],
    summary: 'vCenter 라이선스 만료 — 제품 · 에디션 · 용량/사용 · 만료일 · 상태 · 남은 일수(키 값은 주지 않는다 · NSX/Horizon 은 이 경로에 없다)',
    fields: ['vcenterId', 'name', 'family', 'edition', 'product', 'productVersion', 'total', 'used', 'expires', 'status', 'daysLeft'],
  },
  {
    path: '/compliance/snapshots', list: true, group: 'compliance', method: 'GET', scoped: true,
    params: [VC_PARAM],
    summary: '스냅샷이 있는 VM — 개수 · 크기 · 가장 오래된 시각 · 나이 구간 · 기준 초과 여부(기준 = VM 구성 점검 설정)',
    fields: ['vmId', 'vcenterId', 'vmName', 'cluster', 'host', 'powerState', 'template', 'snapshotCount', 'sizeGB', 'oldestAt', 'ageDays', 'band',
      'judged', 'skip', 'overAge', 'overCount', 'overSize', 'consolidationNeeded', 'stale'],
  },
  {
    path: '/backup/summary', list: true, group: 'backup', method: 'GET', scoped: true,
    params: [VC_PARAM],
    summary: '법인(vCenter)별 백업 집계 — 정책(Veeam · Bareos · SSH · 백업 안 함 · 확인 필요) · 보호 안 됨 · RPO(1/3/7일) · 24시간 결과 · 7일 성공 · 마지막 성공 · 다음 실행',
    fields: ['vcenterId', 'name', 'inventoryUnknown', 'vms', 'poweredOn', 'backedUp', 'policy', 'policyUnknown', 'unprotected', 'unverified', 'rpo', 'results24h',
      'success7d', 'running', 'lastSuccessAt', 'nextRunAt', 'veeamState', 'veeamTruncated', 'veeamServers', 'veeamFailed', 'veeamStale', 'bareosUnknown'],
  },
  {
    path: '/resources/power', list: false, group: 'resources', method: 'GET', scoped: false, requiresFullScope: true,
    summary: '전체 소비 전력 합(W) — 서버 · 네트워크 · 스토리지 각각의 합과 측정/못 읽음/오래됨 장비 수(Overview 카드와 같은 합)',
    fields: ['totalWatts', 'servers', 'network', 'storage'],
  },
  {
    path: '/resources/gpu', list: true, group: 'resources', method: 'GET', scoped: true,
    params: [VC_PARAM],
    summary: 'GPU 장착 호스트 — 장수 · 모델 · 메모리 · 모드 · 사용률(출처) · 할당 VM 수 · 할당률 · 메모리 사용률 · 온도',
    fields: ['hostId', 'host', 'vcenterId', 'cluster', 'gpuCount', 'model', 'memGB', 'mode', 'utilPct', 'utilSource', 'assignedVms', 'allocPct', 'memUsedPct', 'tempC'],
  },
]);

export const ENDPOINT_BY_PATH = Object.freeze(Object.fromEntries(ENDPOINTS.map((e) => [e.path, e])));

/**
 * 이 키가 이 경로를 쓸 수 있는가 — **거부 기본값**.
 *
 * ⚠ 판정을 화면·라우트에서 다시 쓰지 말 것(v2.555 `effectiveToolAccess` 규약). 세 곳이
 *   각자 해석하면 "화면은 숨겼는데 API 는 열려 있는" 상태가 된다.
 *
 * @returns {{ok:boolean, reason?:string, code?:string, endpoint?:object}}
 */
export function endpointAllowed(key, apiPath) {
  const ep = ENDPOINT_BY_PATH[String(apiPath || '')];
  if (!ep) return { ok: false, code: 'unknown-endpoint', reason: '공개되지 않은 경로입니다.' };
  const groups = new Set(key?.groups || []);
  if (!groups.size) {
    return { ok: false, code: 'no-groups', endpoint: ep,
      reason: '이 키에 허용 분류가 하나도 없습니다 — 설정 › 연동 키에서 분류를 골라야 합니다.' };
  }
  if (!groups.has(ep.group)) {
    return { ok: false, code: 'group-denied', endpoint: ep,
      reason: `이 키에는 ‘${GROUP_BY_KEY[ep.group]?.label || ep.group}’ 분류가 없습니다.` };
  }
  /*
   * ⚠⚠ **법인 축이 없는 자원은 범위 키에 부분 데이터를 주지 않는다 — 거절한다**(v2.525 규약).
   *   스토리지 장비는 `datacenterId`(자유 라벨)만 있고 `vcenterId` 가 없어 vCenter 범위와
   *   교집합할 수 없다. 내부 라우트도 같은 이유로 `fullScopeOnly` 다
   *   (`routes/api/storageMon.js:46`). 빈 목록을 주면 '장비 0대' 라는 거짓이 되고,
   *   전량을 주면 범위를 어긴다 — 그래서 403 이다.
   */
  if (ep.requiresFullScope && (key?.vcenters || []).length) {
    return { ok: false, code: 'needs-full-scope', endpoint: ep,
      reason: '이 경로는 vCenter 범위로 나눌 수 없는 자원입니다 — 범위를 지정하지 않은(전체) 키만 조회할 수 있습니다.' };
  }
  return { ok: true, endpoint: ep };
}

/**
 * 선언된 필드만 남긴다 — **계약 집행부**.
 *
 * ⚠⚠ 내부 객체를 그대로 스프레드하지 말 것(v2.500 D/M1 relaycheck · v2.503 S-3 와 같은 사고).
 *   `{...row}` 뒤에 몇 개만 덮어쓰면 하위 객체의 내부 필드가 그대로 나간다.
 * ⚠ 선언에 있는데 원본에 없는 필드는 **`null` 로 채운다** — 소비자가 키 부재와 값 부재를
 *   구분하지 않아도 되게(계약이 안정적이어야 하는 이유다).
 */
export function project(row, fields) {
  const out = {};
  for (const f of fields) out[f] = row != null && Object.hasOwn(row, f) ? row[f] : null;
  return out;
}

/** 목록 투사. */
export function projectAll(rows, fields) {
  return (Array.isArray(rows) ? rows : []).map((r) => project(r, fields));
}
