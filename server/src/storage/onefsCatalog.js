/**
 * storage/onefsCatalog.js — OneFS Platform API 전 영역 수집 카탈로그(v2.308).
 *
 * 사용자가 지정한 40개 영역 표(2026-08-15)를 조회 가능한 GET 엔드포인트로 매핑한다.
 * 영역마다 후보 경로 배열(버전별 차이 폴백 — isilon.js getAny 와 동일 철학)을 두고,
 * 수집기는 영역별 성공/실패를 기록한다(부분 실패 은폐 금지 — sections 철학).
 *
 * ⚠ 정직 표기:
 *  - 전부 **조회(GET) 전용** — 표의 '생성/삭제'(Directory/File 등) 같은 쓰기 기능은 모니터링
 *    수집 범위가 아니다(수집 도구가 장비를 변경하면 안 됨).
 *  - enabled:false 영역은 자동 전수 수집이 부적합하거나(경로 인자 필요) 버전 의존이 커서
 *    기본 비활성 — reason 에 사유를 명시하고 UI 가 그대로 보여준다.
 *  - 경로는 OneFS 8.x~9.x Platform API 문서 지식 기반이며 실장비 검증 전 — 영역별 오류
 *    문구(HTTP 404 등)가 그대로 저장되므로 첫 수집 후 폴백 경로를 보정하면 된다.
 *  - 응답 원문은 수집 노드의 SQLite(storage-history.db)에 저장(사용자 요구 'DB 저장').
 *    엣지 수집 장비의 원문은 엣지 DB 에 있고 중앙에는 영역 요약이 push 된다(대역폭 —
 *    40영역 원문을 매번 WAN 전송하지 않음. 원문 중앙 동기화는 후속).
 */

export const ONEFS_AREAS = [
  { key: 'cluster', label: 'Cluster', endpoints: ['/platform/1/cluster/config', '/platform/3/cluster/identity', '/platform/3/cluster/time'] },
  { key: 'node', label: 'Node', endpoints: ['/platform/3/cluster/nodes'] },
  { key: 'hardware', label: 'Hardware', endpoints: ['/platform/3/cluster/nodes/all/drives', '/platform/1/cluster/nodes/all/drives'] },
  { key: 'capacity', label: 'Capacity / Storage Pool', endpoints: ['/platform/1/storagepool/storagepools', '/platform/1/storagepool/nodepools', '/platform/1/storagepool/tiers'] },
  { key: 'filesystem', label: 'Filesystem', endpoints: ['/platform/1/filesystem/settings', '/platform/1/fsa/settings'] },
  { key: 'file', label: 'Directory / File', enabled: false, reason: '경로 인자가 필요한 namespace API — 자동 전수 수집 부적합(필요 시 데이터스토어 브라우즈처럼 별도 화면으로)', endpoints: [] },
  { key: 'quota', label: 'Quota', endpoints: ['/platform/1/quota/quotas?limit=500', '/platform/1/quota/reports?limit=10'] },
  { key: 'snapshot', label: 'Snapshot', endpoints: ['/platform/1/snapshot/snapshots?limit=500', '/platform/1/snapshot/snapshots-summary'] },
  { key: 'smb', label: 'SMB', endpoints: ['/platform/1/protocols/smb/shares?limit=500', '/platform/1/protocols/smb/settings/global'] },
  { key: 'nfs', label: 'NFS', endpoints: ['/platform/1/protocols/nfs/exports?limit=500', '/platform/2/protocols/nfs/settings/global'] },
  { key: 'hdfs', label: 'HDFS', endpoints: ['/platform/1/protocols/hdfs/settings'] },
  { key: 's3', label: 'S3 / Object', endpoints: ['/platform/10/protocols/s3/buckets', '/platform/10/protocols/s3/settings/global'] },
  { key: 'protocol', label: 'Protocol 통계', endpoints: ['/platform/1/statistics/current?key=cluster.protostats.nfs.total&key=cluster.protostats.smb.total&key=cluster.protostats.hdfs.total'] },
  { key: 'performance', label: 'Performance', endpoints: ['/platform/1/statistics/current?key=cluster.net.ext.bytes.in.rate&key=cluster.net.ext.bytes.out.rate&key=cluster.cpu.sys.avg&key=cluster.disk.busy.avg'] },
  { key: 'statistics', label: 'Statistics(요약)', endpoints: ['/platform/3/statistics/summary/system', '/platform/3/statistics/summary/client?limit=50'] },
  { key: 'network', label: 'Network', endpoints: ['/platform/4/network/groupnets', '/platform/3/network/interfaces'] },
  { key: 'smartconnect', label: 'SmartConnect(IP pool)', endpoints: ['/platform/4/network/pools'] },
  { key: 'users', label: 'User / Group', endpoints: ['/platform/1/auth/users?limit=500', '/platform/1/auth/groups?limit=500'] },
  { key: 'auth', label: 'Authentication', endpoints: ['/platform/1/auth/providers/summary', '/platform/1/auth/settings/global'] },
  { key: 'rbac', label: 'RBAC', endpoints: ['/platform/1/auth/roles?limit=200'] },
  { key: 'zones', label: 'Access Zone', endpoints: ['/platform/1/zones'] },
  { key: 'audit', label: 'Audit', endpoints: ['/platform/1/audit/settings', '/platform/3/audit/settings/global'] },
  { key: 'events', label: 'Events', endpoints: ['/platform/3/event/eventgroup-occurrences?resolved=false&limit=100'] },
  { key: 'healthcheck', label: 'Health Check', endpoints: ['/platform/7/healthcheck/evaluations?limit=20', '/platform/7/healthcheck/checklists'] },
  { key: 'job', label: 'Job Engine', endpoints: ['/platform/1/job/jobs', '/platform/1/job/types?limit=200'] },
  { key: 'synciq', label: 'SyncIQ', endpoints: ['/platform/1/sync/policies', '/platform/1/sync/reports?limit=20', '/platform/3/sync/settings'] },
  { key: 'dedupe', label: 'Dedupe', endpoints: ['/platform/1/dedupe/settings', '/platform/1/dedupe/reports?limit=10'] },
  { key: 'filepool', label: 'FilePool / SmartPools', endpoints: ['/platform/1/filepool/policies', '/platform/1/storagepool/settings'] },
  { key: 'cloudpools', label: 'CloudPools', endpoints: ['/platform/3/cloud/pools', '/platform/3/cloud/settings'] },
  { key: 'worm', label: 'WORM / SmartLock', endpoints: ['/platform/1/worm/domains', '/platform/1/worm/settings'] },
  { key: 'antivirus', label: 'Antivirus', endpoints: ['/platform/3/antivirus/settings', '/platform/3/antivirus/servers'] },
  { key: 'license', label: 'License', endpoints: ['/platform/5/license/licenses', '/platform/1/license/licenses'] },
  { key: 'certificate', label: 'Certificate', endpoints: ['/platform/4/certificate/server'] },
  { key: 'keymanager', label: 'Key Manager', endpoints: ['/platform/7/keymanager/kmip/servers', '/platform/7/keymanager/settings'] },
  { key: 'upgrade', label: 'Upgrade', endpoints: ['/platform/3/upgrade/cluster', '/platform/3/upgrade/cluster/nodes'] },
  { key: 'hardening', label: 'Hardening', endpoints: ['/platform/6/hardening/state', '/platform/6/hardening/reports'] },
  { key: 'ipmi', label: 'IPMI', endpoints: ['/platform/10/ipmi/settings', '/platform/10/ipmi/config'] },
  { key: 'configbackup', label: 'Configuration Backup', enabled: false, reason: 'OneFS 버전/구성 의존(전용 API 부재 버전 다수) — 실장비 확인 후 활성화', endpoints: [] },
  { key: 'metadataiq', label: 'MetadataIQ', enabled: false, reason: '지원 버전 한정(최신 OneFS) — 실장비 확인 후 활성화', endpoints: [] },
];

export const enabledAreas = () => ONEFS_AREAS.filter((a) => a.enabled !== false);
export const AREA_LABEL = Object.fromEntries(ONEFS_AREAS.map((a) => [a.key, a.label]));
