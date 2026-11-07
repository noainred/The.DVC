/**
 * bmusage/playbooks.js — 리눅스 성능 6단계 **진단 플레이북**(읽기 전용 런북 · 설계 PROFILES §16 E · 아트보드 Runbook). **파일 하나 = 카탈로그.**
 *
 * 판정이 ‘후보’ 로 끝난 뒤 사람이 할 다음 조사를 표준화한다: ① 포탈에서 먼저 확인(자동 채움) → ② 서버 명령(복사용 · **읽기 전용만** · Netflix 60초 / USE 순서) →
 *   ③ 설정 · DB 대조(튜닝 탭 권장값) → ④ 하드웨어 의심 → ⑤ 조치 후보 · 기록.
 * ⚠⚠ **포탈은 실행하지 않는다** — 명령은 화면에 복사용 글자로만 나간다(SSH · API 로 보내는 경로가 없다 — 테스트가 소스 스윕으로 고정).
 * ⚠⚠ 명령은 읽기 전용 화이트리스트(isReadOnlyCommand)를 통과한 것만 내보낸다 — 쓰기 · 재시작 · 리다이렉트 · 셸 치환 금지(카탈로그 테스트가 전 명령을 대고,
 *   런타임도 한 번 더 거른다 — 방어선 두 겹). 자리표시(‘{장치}’ 등)는 포탈 값으로 채우되 채울 값도 이름 화이트리스트(장치 · 인터페이스 · 마운트)만.
 * 판정 id(이 노드가 내는 것 전부 — 테스트가 ‘모든 판정 id 에 플레이북이 있다’ 를 고정): use:<자원> · cross:<교차 결론> · port:<대조 ⑤> · health:<소모품 칸> · profile:<용도 점검 id>.
 * 근거 번호는 튜닝 · 용도 근거(tuning/sources.js)와 방법론 출처(NF · USE · SRE · DELL — 웹 SOURCE_TAGS 와 같은 이름)만(테스트가 대조).
 * 현장이 고친 단계는 위키에 덮어쓰기(포탈 판은 기본값) — wikiTitle 로 위키 검색 링크를 만든다.
 */
import { ALL_SOURCES } from './tuning/sources.js';
import { HEALTH_CELLS } from './health.js';
import { PROFILES } from './profiles/index.js';
import { COMPARE_VERDICTS } from './portCompare.js';

/** 교차 판정 결론 code(useJudge crossJudge — candidate · clear 의 code). 소스 스윕이 useJudge 와 대조한다. */
export const CROSS_CODES = Object.freeze(['power-thermal-limit', 'cpu-demand', 'replace-candidate', 'io-volume', 'dimm-slot', 'kernel-queue', 'cable-optic']);
export const USE_RES = Object.freeze(['cpu', 'mem', 'disk', 'net', 'hw']);
export const PORT_BAD = Object.freeze(COMPARE_VERDICTS.filter((v) => ['mismatch', 'port-errors', 'server-drops'].includes(v)));
export const METHOD_SOURCES = Object.freeze(['NF', 'USE', 'SRE', 'DELL']);
const SOURCE_IDS = new Set([...ALL_SOURCES.map((s) => s.id), ...METHOD_SOURCES]);
export const STEP_KINDS = Object.freeze(['portal', 'command', 'config', 'hardware', 'action']);

/** 이 노드가 낼 수 있는 판정 id 전부(테스트 · 화면 목록). */
export function allJudgmentIds() {
  return [
    ...USE_RES.map((r) => `use:${r}`),
    ...CROSS_CODES.map((c) => `cross:${c}`),
    ...PORT_BAD.map((v) => `port:${v}`),
    ...HEALTH_CELLS.map((c) => `health:${c}`),
    ...PROFILES.flatMap((p) => (p.checks || []).map((c) => `profile:${c.id}`)),
  ];
}

/* ── 읽기 전용 명령 화이트리스트 ─────────────────────────────────────────── */
/** 파이프 조각의 첫 낱말 → 허용 여부(+ 그 도구의 금지 인자). */
const READ_TOOLS = Object.freeze({
  cat: null, grep: null, head: null, tail: null, sort: null, uniq: null, wc: null, ls: null, stat: null, uptime: null, uname: null, id: null, date: null,
  awk: null, free: null, vmstat: null, mpstat: null, pidstat: null, iostat: null, sar: null, lscpu: null, lsblk: null, df: null, numastat: null, findmnt: null,
  ps: null, ss: null, nstat: null, getenforce: null, sestatus: null,
  dmesg: /(^|\s)(-c|-C|--clear|--read-clear|--console-(off|on|level)|-D|-E|-n)\b/,
  sed: /(^|\s)(-i|--in-place)/, sysctl: /(^|\s)(-w|--write|-p|--load|--system)\b|=/, ip: /(^|\s)(set|add|del|delete|change|replace|flush|link\s+set|route\s+(add|del))\b/,
  // ethtool 은 보기 인자(-S 통계 · -g 링 · -l 채널 · -i 드라이버 · -k 오프로드 · -m 모듈 · -a · -c · -T)만 — 바꾸는 인자 · 자가 시험 · 깜빡임 금지.
  ethtool: /(^|\s)(-(s|G|L|K|A|C|E|W|X|N|U|P|f|r|p|t|u|n|e)\b|--(change|set|config|reset|flash|identify|test|negotiate|offload|coalesce|ring|pause|features|show-eee))/,
  journalctl: /--(vacuum|rotate|flush|sync|relinquish|setup-keys)/,
  nvme: /^(?!\s*(smart-log|list|id-ctrl|id-ns|error-log)\b)/, smartctl: /(^|\s)(-s|--smart|-t|--test|-X|--abort|-o|--offlineauto|-S|--saveauto)\b/,
  systemctl: /^(?!\s*(status|list-units|list-unit-files|is-active|is-enabled|is-failed|show|--failed|list-timers)\b)/,
  'tuned-adm': /^(?!\s*(active|list|recommend|verify)\b)/, chronyc: /^(?!\s*(-c\s+)?(tracking|sources|sourcestats|activity)\b)/,
  'firewall-cmd': /^(?!\s*(--state|--list-all|--get-active-zones|--list-ports)\b)/,
  'needs-restarting': /^(?!\s*-r\b)/, dnf: /^(?!\s*(history(\s+(list|info))?|list\s+--installed|repolist)\b)/, rpm: /(^|\s)-(e|U|i|F)\b|--(erase|upgrade|install|freshen|import)/,
  airflow: /^(?!\s*(jobs\s+check|version|info|config\s+get-value)\b)/, gpstate: /(^|\s)--?(?!s\b|Q\b|e\b|m\b|f\b|c\b|i\b)\w/,
  psql: /^(?!.*-c\s+"(SELECT|select)\s)/, ipmitool: /^(?!\s*(sensor\s+list|sdr\s+list|sel\s+list|fru\s+print)\b)/,
});
/** 셸 전체에 금지 — 리다이렉트 · 순서 · 치환 · 권한 상승 · 백그라운드. 주석(#) 뒤는 글자 설명으로 본다. */
const SHELL_BAD = /(>|<|;|&&|\|\||\$\(|`|\bsudo\b|\bsu\b|\bdoas\b|&\s*$|\btee\b|\bxargs\b|\beval\b|\bexec\b)/;
/** 따옴표 밖의 | 로만 나눈다(grep -E 'a|b' 의 | 는 셸 파이프가 아니다). 닫히지 않은 따옴표면 null(거부). */
export function splitPipes(code) {
  const out = []; let cur = ''; let q = '';
  for (const ch of code) {
    if (q) { if (ch === q) q = ''; cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '|') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (q) return null;
  out.push(cur);
  return out;
}
/** 명령 한 줄이 읽기 전용인가(순수 — 카탈로그 테스트 · 런타임 거름이 같은 함수). 주석(‘ # ’ 뒤)은 설명이라 빼고 본다. */
export function isReadOnlyCommand(line) {
  const s = String(line ?? '');
  if (!s.trim() || s.length > 300) return false;
  const code = s.replace(/\s#\s.*$/, '').trim();
  if (!code || SHELL_BAD.test(code)) return false;
  const segs = splitPipes(code);
  if (!segs) return false;
  for (const seg of segs) {
    const m = /^\s*([A-Za-z][\w.-]*)(.*)$/.exec(seg);
    if (!m) return false;
    const [, cmd, rest] = m;
    if (!Object.hasOwn(READ_TOOLS, cmd)) return false;
    const bad = READ_TOOLS[cmd];
    if (bad && bad.test(rest)) return false;
  }
  return true;
}
/** 자리표시 값 화이트리스트(장치 · 인터페이스 · 마운트 이름 — 셸 의미 문자 없음). */
const FILL_RE = Object.freeze({ '{장치}': /^[A-Za-z0-9._-]{1,32}$/, '{인터페이스}': /^[A-Za-z0-9._@:-]{1,32}$/, '{마운트}': /^\/[A-Za-z0-9._/-]{0,120}$/ });
export function fillCommand(line, fill = {}) {
  let s = String(line);
  for (const [ph, re] of Object.entries(FILL_RE)) { const v = fill?.[ph]; if (typeof v === 'string' && re.test(v) && !v.includes('..')) s = s.split(ph).join(v); }
  return s;
}

/* ── 카탈로그 ───────────────────────────────────────────────────────────── */
const portal = (metrics, look, title = '포탈에서 먼저 확인') => ({ kind: 'portal', title, metrics, look });
export const PLAYBOOKS = Object.freeze([
  { id: 'disk-await', title: '디스크 await 급등 · SMART 깨끗(교차 ② I/O 양)', appliesTo: ['cross:io-volume', 'use:disk'], steps: [
    portal(['disk_await_ms', 'disk_busy_pct', 'disk_aqu', 'psi_io_full10'], ['focus', 'trend', 'compare', 'changes', 'annotations']),
    { kind: 'command', title: '서버에서 지금 I/O 를 누가 내는지 — Netflix 60초 체크리스트 순서(오류 · 포화 먼저)', sources: ['NF', 'USE'], commands: [
      'dmesg -T | tail -30', 'iostat -xz 1 5 # await · aqu-sz · %util — 포탈 값과 대조', 'pidstat -d 1 5 # 프로세스별 kB_rd/s kB_wr/s', 'cat /proc/pressure/io # some/full avg10 avg60'] },
    { kind: 'config', title: '쓰기 폭주면 writeback 설정과 DB 체크포인트를 본다', sources: ['G1', 'H4'], tuning: ['mem.dirty'], commands: [
      "grep -E 'Dirty|Writeback' /proc/meminfo", 'sysctl vm.dirty_bytes vm.dirty_background_bytes vm.dirty_ratio vm.dirty_background_ratio'],
      note: 'PostgreSQL/GPDB: checkpoint_timeout · checkpoint_completion_target · 최근 checkpoint 로그는 DB 담당이 본다. 64GB 초과 호스트는 dirty_bytes 방식(튜닝 탭 권장값).' },
    { kind: 'hardware', title: '디스크 자체를 의심하면 — SMART 가 깨끗해도 펌웨어 · 큐 설정', sources: ['H2'], tuning: ['disk.nvmeSched', 'disk.nrReqRa'], commands: [
      'cat /sys/block/{장치}/queue/scheduler /sys/block/{장치}/queue/nr_requests', 'nvme smart-log /dev/{장치} # 설치돼 있을 때 · iDRAC 디스크 상태와 대조'] },
    { kind: 'action', title: '조치 후보와 기록', items: ['무거운 배치를 백업 · 한가한 창으로 옮기기', '크론 소유자 확인(변경 이벤트 띠의 cron 해시)', '이슈에 집중 모니터링 결론 첨부', '운영 주석 남기기'] },
  ] },
  { id: 'disk-replace', title: '디스크 고장 전조(교차 ② 교체 후보)', appliesTo: ['cross:replace-candidate'], steps: [
    portal(['disk_await_ms', 'disk_busy_pct'], ['faults', 'trend', 'hw']),
    { kind: 'command', title: '커널이 본 디스크 오류 · 재시도', sources: ['USE'], commands: ["dmesg -T | grep -iE 'I/O error|medium|reset|timeout' | tail -30", 'iostat -xz 1 5', 'lsblk -o NAME,MODEL,SERIAL,SIZE,ROTA'] },
    { kind: 'hardware', title: 'SMART · iDRAC 예측 고장 대조', sources: ['DELL'], commands: ['smartctl -H -A /dev/{장치} # 설치돼 있을 때', 'nvme smart-log /dev/{장치}'], note: 'iDRAC 의 예측 고장(PredictiveFailure)과 부품 장애 이력은 포탈 장애 기록 탭에 있다.' },
    { kind: 'action', title: '조치 후보와 기록', items: ['교체 일정(RAID 재구성 시간 고려)', '백업 확인', '부품 장애 이슈와 연결', '운영 주석'] },
  ] },
  { id: 'cpu-saturation', title: 'CPU 포화 · 수요(교차 ① CPU 수요)', appliesTo: ['use:cpu', 'cross:cpu-demand'], steps: [
    portal(['cpu_pct', 'runq_per_core', 'psi_cpu_some10', 'cpu_iowait_pct'], ['focus', 'trend', 'compare', 'changes']),
    { kind: 'command', title: '누가 CPU 를 쓰는지 — Netflix 60초 순서', sources: ['NF', 'USE'], commands: [
      'uptime', 'dmesg -T | tail -30', 'vmstat 1 5 # r(실행 대기) · us/sy/wa', 'mpstat -P ALL 1 3 # 한 코어만 바쁜지', 'pidstat 1 5', 'cat /proc/pressure/cpu'] },
    { kind: 'config', title: 'CPU 주파수 · TuneD · 인터럽트 분산', sources: ['H5', 'H6', 'H1'], tuning: ['cpu.governor', 'tuned.active', 'cpu.irqbalance'], commands: ['tuned-adm active', 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'systemctl is-active irqbalance'] },
    { kind: 'hardware', title: '전력 · 열 제한이 아닌지(교차 ①)', sources: ['DELL'], commands: ["grep MHz /proc/cpuinfo | sort | uniq -c | sort -rn | head -5"], note: '전력 cap 대비 · 흡기 온도는 포탈 하드웨어 탭(iDRAC).' },
    { kind: 'action', title: '조치 후보와 기록', items: ['원인 프로세스 소유자 확인', '배치 시간 조정', '증설 · 분산 검토', '운영 주석'] },
  ] },
  { id: 'power-thermal', title: '전력 · 열 제한(교차 ① 전력 cap · 흡기)', appliesTo: ['cross:power-thermal-limit'], steps: [
    portal(['cpu_pct', 'runq_per_core'], ['hw', 'trend']),
    { kind: 'command', title: 'CPU 가 클럭을 낮췄는지', sources: ['H6'], commands: ["grep MHz /proc/cpuinfo | sort | uniq -c | sort -rn | head -5", 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq', "dmesg -T | grep -iE 'thermal|throttl|power limit' | tail -20"] },
    { kind: 'hardware', title: 'iDRAC 전력 cap · 흡기 · 팬', sources: ['DELL'], commands: ['ipmitool sensor list # 설치돼 있을 때(읽기)'], note: '전력 cap 정책 · 공조는 전산실 담당과 확인한다.' },
    { kind: 'action', title: '조치 후보와 기록', items: ['전력 cap 정책 검토', '공조 · 랙 배치 확인(외부 요인 주석)', '운영 주석'] },
  ] },
  { id: 'mem-pressure', title: '메모리 포화(스왑아웃) · OOM', appliesTo: ['use:mem', 'health:oom'], steps: [
    portal(['mem_pct', 'swap_out_ps', 'psi_mem_full10'], ['focus', 'trend', 'changes']),
    { kind: 'command', title: '누가 메모리를 쓰는지 · 회수 압력', sources: ['NF', 'USE'], commands: ['free -m', 'vmstat 1 5 # si/so · free', 'cat /proc/pressure/memory', 'ps -eo pid,comm,rss --sort=-rss | head -10', "dmesg -T | grep -i 'out of memory' | tail -10"] },
    { kind: 'config', title: 'swappiness · THP · 최소 여유', sources: ['H3', 'H8', 'H4'], tuning: ['mem.swappiness', 'mem.thp', 'mem.minFree'], commands: ['sysctl vm.swappiness vm.min_free_kbytes', 'cat /sys/kernel/mm/transparent_hugepage/enabled'] },
    { kind: 'hardware', title: 'DIMM 이상이 아닌지', sources: ['DELL'], commands: ['numastat -m | head -30'], note: 'ECC · DIMM 상태는 포탈 하드웨어 탭(교차 ③).' },
    { kind: 'action', title: '조치 후보와 기록', items: ['메모리 누수 의심 프로세스 담당 확인', '서비스 재시작은 담당 승인 뒤(포탈은 하지 않는다)', '증설 검토', '운영 주석'] },
  ] },
  { id: 'ecc-mce', title: 'ECC · MCE · DIMM 위치(교차 ③) · 하드웨어 오류', appliesTo: ['cross:dimm-slot', 'use:hw'], steps: [
    portal(['mem_pct'], ['hw', 'faults']),
    { kind: 'command', title: '커널이 본 기계 검사 오류', sources: ['USE'], commands: ["dmesg -T | grep -iE 'mce|edac|hardware error|corrected' | tail -30", 'grep -r . /sys/devices/system/edac/mc/mc0/ce_count /sys/devices/system/edac/mc/mc0/ue_count'] },
    { kind: 'hardware', title: 'iDRAC SEL · 부품 장애', sources: ['DELL'], commands: ['ipmitool sel list # 설치돼 있을 때(읽기)'], note: 'DIMM 슬롯 · SEL 은 포탈 장애 기록 탭이 이미 모았다.' },
    { kind: 'action', title: '조치 후보와 기록', items: ['DIMM 교체 일정', '부품 장애 이슈와 연결', '운영 주석'] },
  ] },
  { id: 'net-drop', title: '네트워크 드롭 · 오류(교차 ④ 드롭 층)', appliesTo: ['cross:kernel-queue', 'cross:cable-optic', 'use:net'], steps: [
    portal(['net_pct', 'net_drop_delta', 'net_err_delta', 'tcp_retrans_pct'], ['trend', 'ports', 'changes']),
    { kind: 'command', title: '어느 층에서 버리는지 — NIC · 링 · softnet · TCP', sources: ['NF', 'R2', 'H7'], commands: [
      'ip -s link show {인터페이스}', "ethtool -S {인터페이스} | grep -iE 'drop|miss|err|fifo|crc' | head -30", 'cat /proc/net/softnet_stat', 'nstat -az | grep -iE "retrans|drop|overflow"', 'ss -s'] },
    { kind: 'config', title: '링 버퍼 · 큐 · softnet 예산', sources: ['R2', 'H7'], tuning: ['net.ring', 'net.softnet', 'net.channels', 'net.txqueuelen'], commands: ['ethtool -g {인터페이스}', 'ethtool -l {인터페이스}', 'sysctl net.core.netdev_budget net.core.netdev_max_backlog'] },
    { kind: 'hardware', title: '케이블 · 광모듈(CRC 가 있으면)', sources: ['DELL'], commands: ['ethtool -m {인터페이스} # 지원할 때(광 레벨)'], note: '스위치 쪽 포트 오류는 CVP 대조(추이 탭 포트 절)와 함께 본다.' },
    { kind: 'action', title: '조치 후보와 기록', items: ['케이블 · 광모듈 교체(CRC)', '링 · 큐 조정은 담당 승인 뒤(포탈은 적용하지 않는다)', '네트워크 담당과 스위치 포트 확인', '운영 주석'] },
  ] },
  { id: 'port-mismatch', title: '서버 ↔ 스위치 포트 불일치(교차 ⑤)', appliesTo: PORT_BAD.map((v) => `port:${v}`), steps: [
    portal(['net_pct', 'net_drop_delta', 'net_err_delta'], ['ports', 'trend']),
    { kind: 'command', title: '서버 쪽 카운터 · 링크 상태', sources: ['R2'], commands: ['ip -s link show {인터페이스}', 'ethtool {인터페이스} # 속도 · 이중 · 링크', "ethtool -S {인터페이스} | grep -iE 'err|drop|crc' | head -20"] },
    { kind: 'hardware', title: '매핑이 맞는지 — 수동 매핑 · 설명 후보', sources: ['DELL'], commands: ['cat /sys/class/net/{인터페이스}/address'], note: 'MAC · LLDP 매핑은 만들지 않았다 — 포트 설명 · 수동 매핑으로 대조한다(추이 탭 포트 절).' },
    { kind: 'action', title: '조치 후보와 기록', items: ['수동 매핑 확인 · 정정', '스위치 포트 오류면 네트워크 담당 이슈', '운영 주석'] },
  ] },
  { id: 'airflow-scheduler', title: 'Airflow 스케줄러 하트비트 · 실행 슬롯', appliesTo: PROFILES.find((p) => p.id === 'airflow').checks.map((c) => `profile:${c.id}`), steps: [
    portal(['cpu_pct', 'mem_pct', 'runq_per_core'], ['profile', 'focus']),
    { kind: 'command', title: '스케줄러가 살아 있는지(읽기 전용 명령)', sources: ['A1', 'A3'], commands: ['airflow jobs check --job-type SchedulerJob --hostname "$HOSTNAME"', "systemctl list-units --type=service | grep -i airflow", 'ss -ltn'] },
    { kind: 'config', title: '실행기 · 메타 DB · 슬롯', sources: ['A2', 'A4', 'A6'], commands: ['airflow config get-value core executor', 'airflow config get-value core parallelism'], note: '메타 DB 연결 문자열에는 비밀번호가 있어 포탈이 읽지 않는다 — 담당이 확인한다.' },
    { kind: 'action', title: '조치 후보와 기록', items: ['스케줄러 재시작은 담당 승인 뒤(포탈은 하지 않는다)', 'DAG 임포트 오류 확인', '운영 주석'] },
  ] },
  { id: 'gpdb-segment', title: 'GPDB 다운 세그먼트 · 선호 역할 · 공간', appliesTo: PROFILES.find((p) => p.id === 'gpdb').checks.map((c) => `profile:${c.id}`), steps: [
    portal(['disk_busy_pct', 'disk_await_ms', 'net_drop_delta'], ['profile', 'compare', 'focus']),
    { kind: 'command', title: '세그먼트 상태(gpadmin · 읽기 전용)', sources: ['G3', 'G4'], commands: ['gpstate -e # 문제 세그먼트', 'gpstate -m # 미러', 'psql -c "SELECT * FROM gp_segment_configuration WHERE status = \'d\'"', 'df -h {마운트}'] },
    { kind: 'config', title: 'OS 요구값(튜닝 탭 GPDB 프로파일)', sources: ['G1', 'G2'], tuning: ['mem.dirty', 'mem.thp'], commands: ['sysctl kernel.shmall kernel.shmmax vm.overcommit_memory', 'findmnt -o TARGET,FSTYPE,OPTIONS {마운트}'] },
    { kind: 'action', title: '조치 후보와 기록', items: ['세그먼트 복구(gprecoverseg)는 DB 담당이 판단 · 실행(포탈은 하지 않는다)', '같은 용도 그룹에서 한 대만 높으면 서버 비교 표의 스큐 후보 확인', '공간 75% 기준 — 정리 · 증설', '운영 주석'] },
  ] },
  { id: 'os-baseline', title: 'OS 기본 점검(Rocky 9 · 시각 동기 · 유닛 · TuneD · 재부팅)', appliesTo: [...PROFILES.find((p) => p.id === 'rocky9-base').checks.map((c) => `profile:${c.id}`), 'health:chrony', 'health:units', 'health:tuned', 'health:uptime'], steps: [
    portal([], ['summary', 'tuning', 'changes']),
    { kind: 'command', title: '상태 읽기', sources: ['R1', 'R3', 'H1'], commands: ['systemctl --failed', 'chronyc -c tracking', 'tuned-adm active', 'needs-restarting -r', 'dnf history list', 'cat /etc/os-release'] },
    { kind: 'config', title: '튜닝 탭 권장값과 대조', sources: ['H1'], tuning: ['tuned.active'], commands: ['getenforce', 'firewall-cmd --state'] },
    { kind: 'action', title: '조치 후보와 기록', items: ['실패 유닛 담당 확인', '재부팅은 정비 창에서(포탈은 하지 않는다)', '운영 주석'] },
  ] },
  { id: 'os-consumables', title: 'FD · conntrack · 인증서 · 커널 오류(점검 소모품)', appliesTo: ['health:fdct', 'health:cert', 'health:dmesg'], steps: [
    portal([], ['summary', 'snap']),
    { kind: 'command', title: '한계 가까운 자원 읽기', sources: ['USE'], commands: ['cat /proc/sys/fs/file-nr', 'cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max', 'dmesg -T --level=err,warn | tail -30'] },
    { kind: 'config', title: '한계 설정 대조', sources: ['R1'], commands: ['sysctl fs.file-max net.netfilter.nf_conntrack_max'], note: '인증서 만료는 포탈 성능점검(svcmon) 인증서 점검이 근거다.' },
    { kind: 'action', title: '조치 후보와 기록', items: ['인증서 갱신 일정', '한계 조정은 담당 승인 뒤', '운영 주석'] },
  ] },
]);

/** 화면용 카탈로그 — 명령은 읽기 전용 검사를 다시 통과한 것만(방어선 두 겹). */
export function playbookCatalog() {
  return PLAYBOOKS.map((p) => ({
    id: p.id, title: p.title, appliesTo: p.appliesTo, wikiTitle: `베어메탈 플레이북 — ${p.title}`,
    steps: p.steps.map((s) => ({ ...s, ...(s.commands ? { commands: s.commands.filter(isReadOnlyCommand) } : {}), ...(s.sources ? { sources: s.sources.filter((x) => SOURCE_IDS.has(x)) } : {}) })),
  }));
}
/** 판정 id → 플레이북 id 들(순수). */
export function playbooksFor(ids = []) {
  const want = new Set(ids);
  return PLAYBOOKS.filter((p) => p.appliesTo.some((x) => want.has(x))).map((p) => ({ id: p.id, ids: p.appliesTo.filter((x) => want.has(x)) }));
}
/**
 * 한 서버의 지금 판정 id(순수) — 성능 항목(entry · 목록용이면 code 만) · 소모품 칸 · 용도 점검 결과에서. 판정은 이미 수집 노드가 했다(여기는 id 로 옮기기만).
 */
export function judgmentIdsOf({ entry = null, health = null, profile = null } = {}) {
  const ids = [];
  for (const r of USE_RES) if (['bottleneck', 'saturated', 'errors'].includes(entry?.perResource?.[r])) ids.push(`use:${r}`);
  for (const x of Array.isArray(entry?.cross) ? entry.cross : []) if ((x?.state === 'candidate' || x?.state === 'clear') && CROSS_CODES.includes(x.code)) ids.push(`cross:${x.code}`);
  for (const [c, v] of Object.entries(health?.cells || {})) if (HEALTH_CELLS.includes(c) && (v?.code === 'warn' || v?.code === 'bad')) ids.push(`health:${c}`);
  for (const p of Array.isArray(profile?.profiles) ? profile.profiles : []) for (const ch of Array.isArray(p?.checks) ? p.checks : []) if (ch?.status === 'bad' || ch?.status === 'warn') ids.push(`profile:${ch.id}`);
  return [...new Set(ids)];
}
/**
 * 자리표시 값(포탈이 이미 아는 장치 이름 — 성능 상세 detail 의 가장 바쁜 디스크(busyPct) · 드롭/오류가 가장 많은 NIC · 가장 찬 마운트).
 * 못 찾으면 그 칸은 비운다(지어내지 않는다 — 화면에 ‘{장치}’ 그대로 남는다). 값은 이름 화이트리스트(FILL_RE)를 통과한 것만.
 */
export function fillOf(detail) {
  const out = {};
  const top = (arr, f) => (Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object' && Number.isFinite(f(x))).sort((a, b) => f(b) - f(a))[0] || null : null);
  const d = top(detail?.disks, (x) => Number(x.busyPct ?? x.awaitMs));
  const nn = top(detail?.nics, (x) => Number(x.dropDelta ?? 0) + Number(x.errDelta ?? 0)) || (Array.isArray(detail?.nics) ? detail.nics.find((x) => x && x.iface) : null);
  const m = top(detail?.mounts, (x) => Number(x.usedPct ?? x.used_pct));
  if (d && FILL_RE['{장치}'].test(String(d.name ?? ''))) out['{장치}'] = String(d.name);
  if (nn && FILL_RE['{인터페이스}'].test(String(nn.iface ?? ''))) out['{인터페이스}'] = String(nn.iface);
  if (m && FILL_RE['{마운트}'].test(String(m.mount ?? '')) && !String(m.mount).includes('..')) out['{마운트}'] = String(m.mount);
  return out;
}
