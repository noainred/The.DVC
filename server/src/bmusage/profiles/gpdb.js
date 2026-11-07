/**
 * 용도 프로파일 — **gpdb**(Greenplum · 기능 · 설계 PROFILES §4 · 근거 G1~G4 원문 ●). 파일 1개 = 프로파일 1개(§1).
 *
 * 감지(읽기 전용): 계정 `gpadmin` 이 있고 + (프로세스 이름 `postgres` 또는 수신 포트 5432 · 6000~6999). 계정만으로는 감지하지 않는다(설치 잔재).
 *   coordinator/segment 구분은 포트로 **추정**한다(5432 = coordinator · 6000대 = segment — Greenplum 기본 포트. 현장에서 바꿨으면 틀린다 · 정직 기록).
 * ⚠ SQL 점검(gp_segment_configuration · gp_toolkit · gpcheckcat · gpstate)은 gpadmin 계정의 읽기 전용 SQL 이 필요하다 — **이 단계는 실행하지 않는다**(‘미수집’).
 *   gpcheckperf 는 DB 를 멈춰야 하므로 자동 실행하지 않는다(G4).
 * ⚠⚠ OS 요구값(G1 ‘Configuring Your Systems’)은 **역할 · OS 기본 권장값을 덮는다**(PROFILES §1 우선순위 기능 > 역할 > OS) — `catalogId` 가 있는 항목은 튜닝 탭의
 *   그 항목을 덮고 화면이 ‘누가 정했나 = gpdb’ 를 적는다. 나머지는 이 프로파일만의 요구값이다.
 * ⚠ 데이터 볼륨을 구분하지 못한다 — XFS 옵션은 시스템 마운트(/ · /boot · /var …)를 판정에서 빼고(추정), read-ahead 는 물리 디스크 전부를 본다(정직 기록).
 */
import { pairText } from '../tuning/catalog.js';

const SYSV = (k) => (tu) => (tu?.sysctl && Object.hasOwn(tu.sysctl, k) ? tu.sysctl[k] : undefined);
// v2.923(반증 R9): 묶음 값은 catalog pairText — 한쪽이 ‘—’ 면 판정하지 않는다(evalRule hasMissingPart → 확인 불가).
const SYS2 = (a, b) => (tu) => pairText(SYSV(a)(tu), SYSV(b)(tu));
const unitsOf = (tu) => (tu?.units && Array.isArray(tu.units.list) ? tu.units.list : null);
const PHYS = /^(sd|nvme|vd|xvd|hd)/;
export const SYSTEM_MOUNTS = Object.freeze(['/', '/boot', '/boot/efi', '/usr', '/var', '/home', '/tmp', '/opt']);

/** 감지(순수) — { detected, evidence[], role: 'coordinator'|'segment'|'both'|null(추정) }. */
export function detectGpdb(tu) {
  const ev = [];
  const acct = Array.isArray(tu?.accounts) && tu.accounts.includes('gpadmin');
  if (acct) ev.push({ kind: 'account', value: 'gpadmin', strong: false });
  const proc = Array.isArray(tu?.procs?.list) && tu.procs.list.includes('postgres');
  if (proc) ev.push({ kind: 'proc', value: 'postgres', strong: false });
  const ports = Array.isArray(tu?.ports?.list) ? tu.ports.list : [];
  const coord = ports.includes(5432);
  const segPorts = ports.filter((p) => p >= 6000 && p <= 6999);
  if (coord) ev.push({ kind: 'port', value: '5432', strong: false });
  if (segPorts.length) ev.push({ kind: 'port', value: `${segPorts.slice(0, 4).join(' · ')}${segPorts.length > 4 ? ` 외 ${segPorts.length - 4}` : ''}`, strong: false });
  const detected = acct && (proc || coord || segPorts.length > 0);
  const role = !detected ? null : coord && segPorts.length ? 'both' : coord ? 'coordinator' : segPorts.length ? 'segment' : null;
  return { detected, evidence: ev, role };
}

const notCollected = (reason) => () => ({ status: 'notCollected', reason });
const g1 = (o) => ({ sources: ['G1'], grade: '●', ...o });

export default Object.freeze({
  id: 'gpdb',
  kind: 'app',
  title: 'Greenplum(GPDB 7)',
  matchText: '계정 gpadmin + (프로세스 이름 postgres 또는 수신 포트 5432 · 6000대) · coordinator/segment 는 포트로 추정',
  match: (tu) => detectGpdb(tu).detected,
  detect: detectGpdb,
  accounts: ['gpadmin'],
  checks: [
    { id: 'gp.downSeg', title: '다운 세그먼트(5~10분 · IMPORTANT)', how: "SELECT * FROM gp_segment_configuration WHERE status='d' · gpstate -Q(gpadmin SQL — 실행하지 않음)",
      judge: notCollected('sqlNotRun'), evidence: '“List segments that are currently down. If any rows are returned, this should generate a warning or alert.”', sources: ['G3', 'G4'], grade: '●' },
    { id: 'gp.prefRole', title: '선호 역할 이탈(5~10분 · CRITICAL)', how: 'gp_segment_configuration role≠preferred_role(gpadmin SQL — 실행하지 않음)',
      judge: notCollected('sqlNotRun'), evidence: '“When the segments are not running in their preferred role, processing might be skewed. Run gprecoverseg -r”', sources: ['G3'], grade: '●' },
    {
      id: 'gp.diskSpace', title: '데이터 볼륨 공간(5~30분 · CRITICAL · 임계 75%)', how: 'df — 베어메탈 스토리지 등록부에 등록한 마운트 중 가장 높은 사용률',
      judge: ({ row }) => {
        const v = row?.disk_used_pct;
        if (typeof v !== 'number' || !Number.isFinite(v)) return { status: 'unknown', reason: 'notRead' };
        return { status: v >= 75 ? 'bad' : 'ok', value: `${Math.round(v * 10) / 10}%` };
      },
      evidence: '“The recommended threshold is 75% full. It is not recommended to run the system with capacities approaching 100%.” — 등록한 마운트만 본다(데이터 볼륨을 등록해야 의미가 있다).',
      sources: ['G3'], grade: '●',
    },
    {
      id: 'gp.nicRaid', title: 'NIC 오류·드롭(매시) · RAID(5분)', how: '통합 행의 네트워크 E 칸(OS) · 하드웨어 E 칸(iDRAC 부품 장애 — 컨트롤러·물리 디스크)',
      judge: ({ entry }) => {
        const net = entry?.codes?.net?.E; const hw = entry?.codes?.hw?.E;
        const judged = [net, hw].filter((c) => c === 'ok' || c === 'warn' || c === 'bad');
        if (!judged.length) return { status: 'unknown', reason: 'notRead' };
        const st = judged.includes('bad') ? 'bad' : judged.includes('warn') ? 'warn' : 'ok';
        return { status: st, value: `네트워크 E ${net || '—'} · 하드웨어 E ${hw || '—'}` };
      },
      evidence: '“Check for errors or dropped packets on the network interfaces … Check for RAID errors or degraded RAID performance.” → 통합 행이 이미 가진 값을 재사용한다(USE 판정 그대로 — 다시 판정하지 않는다).',
      sources: ['G3'], grade: '●',
    },
    { id: 'gp.catalog', title: '카탈로그 일관성(주 1회 · IMPORTANT)', how: 'gpcheckcat -O(DB 마다 — 실행하지 않음)',
      judge: notCollected('sqlNotRun'), evidence: '주 1회 권장 · 실행 중에도 가능(제한 모드면 거짓 불일치 회피).', sources: ['G3'], grade: '●' },
    { id: 'gp.vacuum', title: '통계 누락 · 블로트 · VACUUM(일 1회 · CRITICAL)', how: 'gp_toolkit.gp_stats_missing · gp_bloat_diag(실행하지 않음)',
      judge: notCollected('sqlNotRun'), evidence: '“Vacuum user tables … Recommended frequency: daily Severity: CRITICAL”', sources: ['G3'], grade: '●' },
    { id: 'gp.state', title: '상태 상세 · 로그', how: 'gpstate -s · gp_toolkit 로그 뷰(실행하지 않음)',
      judge: notCollected('sqlNotRun'), evidence: '“To get detailed status information for the Greenplum system, run gpstate -s.”', sources: ['G4'], grade: '●' },
    { id: 'gp.checkperf', title: '하드웨어 기준선(의심 시만)', how: 'gpcheckperf -d /data -r ds(수동 · DB 정지 필요)',
      judge: () => ({ status: 'info', reason: 'manualOnly' }), evidence: '“To obtain valid numbers from gpcheckperf, the database system must be stopped.” → 자동 실행 금지.', sources: ['G4'], grade: '●' },
  ],
  /** OS 요구값(G1). catalogId 가 있으면 튜닝 탭의 그 항목을 덮는다(by = profile:gpdb). */
  tunings: [
    g1({ key: 'gp.overcommit', title: 'vm.overcommit_memory · overcommit_ratio', reads: '/proc/sys/vm/overcommit_{memory,ratio}', fact: SYS2('vm.overcommit_memory', 'vm.overcommit_ratio'),
      rule: { kind: 'eqStr', value: '2 / 95', text: '2 · 95' }, evidence: '“This should be always set to 2, which is the only safe setting for the database.” overcommit_ratio 95.' }),
    g1({ key: 'gp.swappiness', catalogId: 'mem.swappiness', title: 'vm.swappiness', reads: '/proc/sys/vm/swappiness', fact: SYSV('vm.swappiness'),
      rule: { kind: 'eqNum', value: 1, text: '1' }, evidence: 'sysctl.conf 예시 “vm.swappiness = 1” — 역할 DB 의 10 보다 기능 프로파일이 우선.' }),
    g1({ key: 'gp.shm', title: 'kernel.shmall · shmmax', reads: '/proc/sys/kernel/{shmall,shmmax} · MemTotal · PAGE_SIZE', fact: SYS2('kernel.shmall', 'kernel.shmmax'),
      rule: { kind: 'custom', id: 'gpdbShm', text: '물리 메모리 절반(shmall = _PHYS_PAGES/2 · shmmax = shmall × PAGE_SIZE)' },
      evidence: '“the value for both parameters should be one half of the system physical memory.” — MemTotal 기준 근사(_PHYS_PAGES 와 수 % 차이 · 5% 안이면 적합).' }),
    g1({ key: 'gp.shmmni', title: 'kernel.shmmni', reads: '/proc/sys/kernel/shmmni', fact: SYSV('kernel.shmmni'), rule: { kind: 'eqNum', value: 32768, text: '32768' }, evidence: 'sysctl.conf 예시값.' }),
    g1({ key: 'gp.sem', title: 'kernel.sem', reads: '/proc/sys/kernel/sem', fact: SYSV('kernel.sem'), rule: { kind: 'eqStr', value: '32000 1048576000 1000 32768', text: '32000 1048576000 1000 32768' }, evidence: 'sysctl.conf 예시값.' }),
    g1({ key: 'gp.portRange', title: 'net.ipv4.ip_local_port_range', reads: '/proc/sys/net/ipv4/ip_local_port_range', fact: SYSV('net.ipv4.ip_local_port_range'),
      rule: { kind: 'eqStr', value: '10000 65535', text: '10000 65535' }, evidence: 'sysctl.conf 예시값 · Greenplum 포트와 충돌 금지.' }),
    g1({ key: 'gp.rmemMax', catalogId: 'net.rmemMax', title: 'net.core.rmem_max / wmem_max', reads: '/proc/sys/net/core/{rmem_max,wmem_max}', fact: SYS2('net.core.rmem_max', 'net.core.wmem_max'),
      rule: { kind: 'eqStr', value: '16777216 / 16777216', text: '16777216 / 16777216' }, evidence: 'sysctl.conf 예시값.' }),
    g1({ key: 'gp.rmemDefault', title: 'net.core.rmem_default / wmem_default', reads: '/proc/sys/net/core/{rmem_default,wmem_default}', fact: SYS2('net.core.rmem_default', 'net.core.wmem_default'),
      rule: { kind: 'eqStr', value: '2097152 / 2097152', text: '2097152 / 2097152' }, evidence: 'sysctl.conf 예시값.' }),
    g1({ key: 'gp.backlog', title: 'net.core.netdev_max_backlog', reads: '/proc/sys/net/core/netdev_max_backlog', fact: SYSV('net.core.netdev_max_backlog'), rule: { kind: 'eqNum', value: 10000, text: '10000' }, evidence: 'sysctl.conf 예시값.' }),
    g1({ key: 'gp.twReuse', title: 'net.ipv4.tcp_tw_reuse', reads: '/proc/sys/net/ipv4/tcp_tw_reuse', fact: SYSV('net.ipv4.tcp_tw_reuse'), rule: { kind: 'eqNum', value: 1, text: '1' }, evidence: 'sysctl.conf 예시값.' }),
    g1({ key: 'gp.zoneReclaim', title: 'vm.zone_reclaim_mode', reads: '/proc/sys/vm/zone_reclaim_mode', fact: SYSV('vm.zone_reclaim_mode'), rule: { kind: 'eqNum', value: 0, text: '0' }, evidence: 'sysctl.conf 예시값.' }),
    g1({ key: 'gp.dirty', catalogId: 'mem.dirty', title: 'vm.dirty_*', reads: '/proc/sys/vm/dirty_{ratio,background_ratio,bytes,background_bytes} · MemTotal',
      fact: (tu) => { const s = tu?.sysctl || {}; const keys = ['vm.dirty_background_bytes', 'vm.dirty_bytes', 'vm.dirty_background_ratio', 'vm.dirty_ratio']; return keys.some((k) => Object.hasOwn(s, k)) ? `bytes ${s['vm.dirty_background_bytes'] ?? '—'} / ${s['vm.dirty_bytes'] ?? '—'} · ratio ${s['vm.dirty_background_ratio'] ?? '—'} / ${s['vm.dirty_ratio'] ?? '—'}` : undefined; },
      rule: { kind: 'custom', id: 'gpdbDirty', text: '64GB 초과: background_bytes 1610612736 · dirty_bytes 4294967296(ratio 0) / 64GB 이하: ratio 3 / 10' },
      evidence: '“For host systems with more than 64GB of memory … vm.dirty_background_bytes = 1610612736 … vm.dirty_bytes = 4294967296” (64GB 이하는 ratio 3 / 10).' }),
    g1({ key: 'gp.minFree', catalogId: 'mem.minFree', title: 'vm.min_free_kbytes', reads: '/proc/sys/vm/min_free_kbytes · MemTotal', fact: SYSV('vm.min_free_kbytes'),
      rule: { kind: 'rangePctMem', min: 3, max: 5, text: '물리 메모리 3% · 5% 초과 금지' },
      evidence: '“set vm.min_free_kbytes to a recommended 3% of system physical memory … Do not set … higher than 5%” — Rocky KVM 가이드(1~2%)와 다르다 → 기능 프로파일이 이긴다.' }),
    g1({ key: 'gp.corePattern', title: 'kernel.core_pattern', reads: '/proc/sys/kernel/core_pattern', fact: SYSV('kernel.core_pattern'), rule: { kind: 'eqStr', value: '/var/core/core.%h.%t', text: '/var/core/core.%h.%t' }, evidence: 'core_pattern=/var/core/core.%h.%t.' }),
    g1({ key: 'gp.limits', title: 'limits nofile · nproc · core', reads: '/etc/security/limits.conf(읽지 않음)', fact: () => undefined,
      rule: { kind: 'hold', reason: 'notRead', text: '524288 · 131072 · unlimited' }, evidence: '“* soft nofile 524288 … * soft nproc 131072” · 20-nproc.conf 가 덮어쓰므로 확인.' }),
    g1({ key: 'gp.thp', catalogId: 'mem.thp', title: 'transparent_hugepage', reads: '/sys/kernel/mm/transparent_hugepage/enabled', fact: SYSV('thp.enabled'),
      rule: { kind: 'oneOf', values: ['never'], text: 'never' }, evidence: '“Deactivate Transparent Huge Pages (THP) as it degrades Greenplum Database performance.”' }),
    g1({ key: 'gp.xfs', title: 'XFS 마운트 옵션', reads: '/proc/mounts(xfs — 시스템 마운트는 판정에서 뺌 · 추정)', valueKind: 'xfs',
      fact: (tu) => tu?.xfs, rule: { kind: 'custom', id: 'gpdbXfs', text: 'rw,nodev,noatime,inode64' }, evidence: '데이터 디렉터리는 XFS 를 rw,nodev,noatime,inode64 로 마운트.' }),
    g1({ key: 'gp.readAhead', title: 'read-ahead(blockdev)', reads: '/sys/block/*/queue/read_ahead_kb(물리 디스크 — 데이터 장치를 구분하지 못한다)', valueKind: 'devices',
      devices: (d) => PHYS.test(String(d.name || '')), devValue: (d) => d.readAheadKb,
      rule: { kind: 'eqNum', value: 8192, text: '16384 섹터(= read_ahead_kb 8192)' },
      evidence: '“read-ahead (blockdev) value of 16384” — blockdev 값은 512바이트 섹터 단위라 read_ahead_kb 로는 8192 다. 재부팅에 남지 않으므로 rc.local 등으로.' }),
    g1({ key: 'gp.schedNvme', catalogId: 'disk.nvmeSched', title: 'NVMe scheduler', reads: '/sys/block/nvme*/queue/scheduler', valueKind: 'devices',
      devices: (d) => /^nvme/.test(String(d.name || '')), devValue: (d) => d.scheduler, rule: { kind: 'oneOf', values: ['none'], text: 'none' }, evidence: '스케줄러 표(RHEL 9 / Rocky): NVMe none.' }),
    g1({ key: 'gp.schedSsd', title: 'SSD scheduler(NVMe 아닌 비회전 디스크)', reads: '/sys/block/*/queue/scheduler(rotational=0 · nvme 제외)', valueKind: 'devices',
      devices: (d) => d.rotational === false && !/^nvme/.test(String(d.name || '')) && PHYS.test(String(d.name || '')), devValue: (d) => d.scheduler,
      rule: { kind: 'oneOf', values: ['none'], text: 'none' }, evidence: '스케줄러 표(RHEL 9 / Rocky): SSD none.' }),
    g1({ key: 'gp.schedHdd', catalogId: 'disk.hddSched', title: 'HDD scheduler', reads: '/sys/block/*/queue/scheduler(rotational=1)', valueKind: 'devices',
      devices: (d) => d.rotational === true, devValue: (d) => d.scheduler, rule: { kind: 'oneOf', values: ['mq-deadline'], text: 'mq-deadline' }, evidence: '스케줄러 표(RHEL 9 / Rocky): 그 밖 mq-deadline.' }),
    g1({ key: 'gp.removeIpc', title: 'RemoveIPC', reads: '/etc/systemd/logind.conf(.d) 의 명시 설정', fact: (tu) => (tu?.os ? (tu.os.removeIpc ?? undefined) : undefined),
      rule: { kind: 'custom', id: 'gpdbRemoveIpc', text: 'no' }, evidence: '“RemoveIPC=yes … causes gpinitsystem to fail” — RemoveIPC=no. 명시 설정이 없으면 배포판 기본값은 확인하지 않았다(확인 불가).' }),
    g1({ key: 'gp.selinux', title: 'SELinux', reads: 'getenforce', fact: (tu) => (tu?.os ? (tu.os.selinux ?? undefined) : undefined),
      rule: { kind: 'custom', id: 'gpdbSelinux', text: 'disabled 또는 허용 구성' }, evidence: '“SELinux must either be Disabled or configured to allow unconfined access” — enforcing 이면 허용 구성인지 이 단계가 확인하지 못한다.' }),
    g1({ key: 'gp.firewalld', title: 'firewalld', reads: 'running 유닛 firewalld.service', fact: (tu) => { const u = unitsOf(tu); return u ? (u.includes('firewalld.service') ? 'running' : (tu.units.capped ? undefined : 'not-running')) : undefined; },
      rule: { kind: 'custom', id: 'gpdbFirewalld', text: '끄거나 허용 구성' }, evidence: 'firewalld 는 끄거나 Greenplum 포트를 허용 — 실행 중이면 허용 규칙을 이 단계가 읽지 않는다.' }),
    g1({ key: 'gp.timeSync', title: '시각 동기화', reads: 'running 유닛 chronyd.service · ntpd.service', fact: (tu) => { const u = unitsOf(tu); if (!u) return undefined; const on = u.find((x) => x === 'chronyd.service' || x === 'ntpd.service'); return on || (tu.units.capped ? undefined : 'none'); },
      rule: { kind: 'custom', id: 'gpdbTimeSync', text: '동기(chronyd 실행)' }, evidence: '“Synchronize system clocks” — 동기 상태(chronyc tracking)는 이 단계가 읽지 않는다(데몬 실행만).' }),
  ],
  sources: ['G1', 'G2', 'G3', 'G4'],
});
