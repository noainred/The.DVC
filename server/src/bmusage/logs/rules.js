/**
 * bmusage/logs/rules.js — 리눅스 성능 7a단계 **서버 로그 분석 규칙 카탈로그**(설계 PROFILES §17 · 아트보드 Logs). **파일 하나 = 카탈로그.**
 *
 * 한 규칙 = { id · 분류(cls: fault 장애 · perf 성능 · sec 보안 · issue 이슈) · 심각도 · 출처 태그 · 정규식 · 표본 1줄 · 근거 번호 · 등급 · 연계 }.
 *   · 엔진은 포탈 자체 로그 분석의 것을 **그대로 쓴다**(loganalysis/rules.js normalizeRules — id · 정규식 · 심각도 검사 / engine.js indexRules — 태그별 색인 ·
 *     ‘처음 맞는 규칙 하나’). 심각도 이름도 그 엔진의 SEVERITY_RANK(critical · high · medium · low · info)다 — 아트보드의 ‘warning’ 은 medium 으로 옮겼다.
 *   · 태그 = 출처(kernel · journal · secure · audit · gpdb · airflow). 태그가 '' 인 규칙은 모든 출처에 댄다(엔진 규약). 순서가 곧 분류다 — 구체적인 규칙을 위에.
 *   · **모든 규칙은 표본 줄로 자기 시험한다**(test/bmLogs7a*.test.js — 표본이 정규식에 맞고, 엔진에 넣으면 **그 규칙이** 처음 맞는다).
 *   · 보안 집중(SSH 실패 집중)은 정규식 규칙이 아니라 **파생 규칙**(DERIVED_RULES)이다 — 기본 규칙(SEC-SSH-FAIL · SEC-SSH-INVALID · SEC-PAM-FAIL · SEC-LOGIN-FAIL)
 *     줄을 IP 별로 창(분) 안에서 세어 임계 이상이면 그 줄을 집중 규칙으로 옮긴다(classify.js). 포탈의 로그인 실패 판정(`logs/loginFailPattern.js MSG_RE`)을
 *     **같은 정규식 객체 그대로** SEC-LOGIN-FAIL 의 정규식으로 쓴다(판정 복제 금지 — sshd 전용 규칙에 안 맞는 로그인 실패 줄을 받는다).
 *
 * ⚠⚠ 정규식 규약(루트 CLAUDE.md ‘정규식’ · ReDoS): 외부 입력(서버 로그)이다 — 줄은 MSG_MAX 로 **먼저 자르고**(classify.js) 규칙은 앵커 · 길이 한정 반복만 쓴다
 *   (`.{0,N}` · `\S{1,N}` — 무제한 `.*` 뒤에 다시 반복이 오는 꼴 금지). 테스트가 규칙마다 긴 적대 입력의 소요 비율을 잰다.
 * ⚠⚠ 정직(설계 §17 · README §6): 커널 · sshd · systemd · sudo · chrony · GPDB · Airflow 메시지 형식은 배포판 · 버전마다 다르다. 이 카탈로그의 정규식은
 *   **업스트림 메시지 문구(훈련 지식)로 만들었고 이 현장 Rocky 8 · 9 실장비 표본으로 좁히지 않았다** — 그래서 등급은 전부 ○ 다(‘실장비 표본 없이 좁힌 규칙은 ○’).
 *   예외: dmesg -x 의 줄 머리 형식(‘kern  :warn  : [   1.25] …’)은 이 개발 컨테이너(util-linux · 커널 6.18)에서 실측했다(파서 근거 — 규칙 등급과 별개).
 *   첫 실수집 뒤 ‘분류 안 됨’ 줄 수와 표본으로 규칙을 좁히고 등급을 고친다.
 */
import { MSG_RE as LOGIN_FAIL_MSG_RE } from '../../logs/loginFailPattern.js';

export const LOG_CLASSES = Object.freeze(['fault', 'perf', 'sec', 'issue']);
export const CLASS_LABEL = Object.freeze({ fault: '장애', perf: '성능', sec: '보안', issue: '이슈' });
export const LOG_SOURCES = Object.freeze(['journal', 'kernel', 'secure', 'audit', 'gpdb', 'airflow']);
/** 보안 사실 종류(log_sec.kind) — 화면 보안 패널의 행. */
export const SEC_KINDS = Object.freeze(['fail', 'ok', 'root', 'sudo', 'sudofail', 'acct', 'avc']);

/**
 * 근거 번호 → 문서(화면 ‘규칙 · 근거’ 열). 등급은 규칙에 붙는다(근거 문서가 있어도 실장비 표본이 없으면 ○).
 *   method 는 방법론 출처(플레이북 · 설계가 쓰는 이름 — NF · USE).
 */
export const LOG_EVIDENCE = Object.freeze({
  K1: 'Linux 커널 메시지 문구(MCE · EDAC · AER · OOM · watchdog · hung task · RCU · blk · nvme · scsi) — 업스트림 소스 문구(훈련 지식 · 이 세션 원문 대조 없음)',
  K2: 'util-linux dmesg -x 줄 머리 형식(facility:level: [초]) — 이 개발 컨테이너 실측(2026-11-07 · 커널 6.18)',
  S1: 'OpenSSH sshd 인증 로그 문구(Failed · Accepted · Invalid user) — auth.c auth_log(훈련 지식)',
  S2: 'sudo 로그 형식(사용자 : TTY= ; PWD= ; USER= ; COMMAND=) — sudo 문서(훈련 지식)',
  S3: 'shadow-utils useradd · usermod · groupadd · passwd(pam_unix chauthtok) 문구(훈련 지식)',
  S4: 'Linux audit 레코드 형식(type=… msg=audit(초.밀리:일련): … res=) — audit 문서(훈련 지식)',
  S5: '포탈 로그인 실패 판정(server/src/logs/loginFailPattern.js MSG_RE) — 같은 정규식 객체를 재사용',
  S6: 'SELinux AVC 거부 문구(avc:  denied) — RHEL SELinux 문서(훈련 지식)',
  D1: 'systemd 유닛 결과 문구(Failed with result · Start request repeated too quickly · dumped core) — systemd 소스 문구(훈련 지식)',
  D2: 'chronyd ‘System clock wrong by … seconds’ 문구(훈련 지식)',
  D3: 'dnf · rpm 설치 문구(Installed: kernel-…) — journald 우선순위 warning 미만이면 이 수집에 들어오지 않는다',
  G1: 'Greenplum · PostgreSQL csvlog 열 순서(event_time … error_severity · sql_state_code · message) — 문서(훈련 지식)',
  G2: 'Greenplum FTS · 세그먼트 장애 문구(훈련 지식)',
  A1: 'Apache Airflow 로그 줄 형식([시각] {파일:줄} 수준 - 메시지) · 스케줄러 문구(훈련 지식)',
  NF: 'Netflix ‘Linux Performance Analysis in 60,000 Milliseconds’ — dmesg | tail 을 먼저 본다(설계 방법론 출처)',
  USE: 'Brendan Gregg USE Method — OOM · 오류는 dmesg 에서 본다(설계 방법론 출처)',
});

const R = (o) => Object.freeze({ tag: '', grade: '○', corr: {}, ...o });

/**
 * 정규식 규칙(순서 = 분류 우선순위). 줄(msg)은 출처 파서가 머리(시각 · 호스트 · 프로세스)를 뗀 **메시지 본문**이다(audit · gpdb · airflow 는 형식 그대로 — 아래 표본).
 * corr: 연계 표지(화면 ‘연계’ 열 — 시각 매칭이 아니라 이 규칙이 가리키는 판정 · 칸) — playbook(판정 id · playbooks.js) · health(점검 소모품 칸) · cross(교차 판정 code) · faults(장애 기록 탭).
 */
export const LOG_RULES = Object.freeze([
  // ── 장애(fault) ────────────────────────────────────────────────────────────
  R({ id: 'HW-PANIC', cls: 'fault', severity: 'critical', tag: 'kernel', re: /^(?:Kernel panic - not syncing|Oops: |BUG: unable to handle (?:kernel )?(?:paging request|NULL pointer dereference))/,
    sample: 'Kernel panic - not syncing: Fatal exception in interrupt', evidence: ['K1', 'NF'], title: '커널 패닉 · Oops', corr: { playbook: 'use:hw', faults: true } }),
  R({ id: 'HW-MCE', cls: 'fault', severity: 'critical', tag: 'kernel', re: /^(?:mce: \[Hardware Error\]|\[Hardware Error\]: Machine check|Machine check events logged)/,
    sample: 'mce: [Hardware Error]: Machine check events logged', evidence: ['K1', 'NF'], title: 'MCE(하드웨어 오류)', corr: { playbook: 'cross:dimm-slot', cross: 'dimm-slot', faults: true } }),
  R({ id: 'HW-EDAC-UE', cls: 'fault', severity: 'critical', tag: 'kernel', re: /^EDAC \w{1,16}: \d{1,9} UE /,
    sample: 'EDAC MC0: 1 UE memory read error on CPU_SrcID#0_Ha#0_Chan#2_DIMM#1 (channel:2 slot:1 page:0x0 offset:0x0 grain:32)', evidence: ['K1'], title: 'EDAC 정정 불가(UE) 메모리 오류', corr: { playbook: 'cross:dimm-slot', cross: 'dimm-slot', faults: true } }),
  R({ id: 'HW-EDAC-CE', cls: 'fault', severity: 'medium', tag: 'kernel', re: /^EDAC \w{1,16}: \d{1,9} CE /,
    sample: 'EDAC MC0: 1 CE memory read error on CPU_SrcID#0_Ha#0_Chan#2_DIMM#1 (channel:2 slot:1 page:0x3e2a1f offset:0x400 grain:32 syndrome:0x0)', evidence: ['K1'], title: 'EDAC 정정됨(CE) 메모리 오류 — 반복이면 DIMM 의심', corr: { playbook: 'cross:dimm-slot', cross: 'dimm-slot', faults: true } }),
  R({ id: 'HW-AER-UNCOR', cls: 'fault', severity: 'high', tag: 'kernel', re: /\bAER: (?:Uncorrected|Multiple Uncorrected) \(?(?:Fatal|Non-Fatal)\)? error received/,
    sample: 'pcieport 0000:00:03.0: AER: Uncorrected (Non-Fatal) error received: 0000:3b:00.0', evidence: ['K1'], title: 'PCIe AER 정정 불가 오류', corr: { playbook: 'use:hw', faults: true } }),
  R({ id: 'HW-AER-COR', cls: 'fault', severity: 'medium', tag: 'kernel', re: /\bAER: (?:Multiple )?Corrected error received/,
    sample: 'pcieport 0000:00:03.0: AER: Corrected error received: 0000:3b:00.0', evidence: ['K1'], title: 'PCIe AER 정정됨 오류 — 반복이면 카드 · 슬롯 의심', corr: { playbook: 'use:hw', faults: true } }),
  R({ id: 'HW-DISK-IOERR', cls: 'fault', severity: 'high', tag: 'kernel', re: /^(?:blk_update_request: )?(?:critical (?:medium|target) error|I\/O error), dev [\w-]{1,32}, sector \d{1,20}|^Buffer I\/O error on dev [\w-]{1,32}/,
    sample: 'I/O error, dev sdb, sector 123456 op 0x0:(READ) flags 0x0 phys_seg 1 prio class 0', evidence: ['K1', 'NF'], title: '블록 장치 I/O 오류', corr: { playbook: 'use:disk', faults: true } }),
  R({ id: 'HW-NVME-DOWN', cls: 'fault', severity: 'high', tag: 'kernel', re: /^nvme nvme\d{1,4}: (?:controller is down|Removing after probe failure|Device not ready; aborting reset|frozen state error detected)/,
    sample: 'nvme nvme1: controller is down; will reset: CSTS=0xffffffff, PCI_STATUS=0xffff', evidence: ['K1'], title: 'NVMe 컨트롤러 다운 · 제거', corr: { playbook: 'use:disk', faults: true } }),
  R({ id: 'HW-FS-CORRUPT', cls: 'fault', severity: 'high', tag: 'kernel', re: /^(?:EXT4-fs error \(device [\w-]{1,32}\)|XFS \([\w-]{1,32}\): (?:Corruption|Metadata (?:corruption|I\/O error)|metadata I\/O error)|xfs_do_force_shutdown)/,
    sample: 'XFS (dm-3): Metadata corruption detected at xfs_dir3_block_read_verify+0x5e/0x110 [xfs], xfs_dir3_block block 0x2a0', evidence: ['K1'], title: '파일시스템 손상 · 강제 종료', corr: { playbook: 'use:disk', faults: true } }),
  R({ id: 'HW-PSU', cls: 'fault', severity: 'high', re: /\b(?:power supply|PSU)\b.{0,48}\b(?:fail(?:ed|ure)?|lost|absent|redundancy lost)\b/i,
    sample: 'ipmi: Power Supply 2 failure detected', evidence: ['K1'], title: '전원 공급 장치 이상(OS 로그 — iDRAC SEL 과 대조)', corr: { playbook: 'use:hw', faults: true } }),

  // ── 성능(perf) ────────────────────────────────────────────────────────────
  R({ id: 'PERF-OOM', cls: 'perf', severity: 'high', tag: 'kernel', re: /^(?:Out of memory: Kill(?:ed)? process \d{1,10}|Memory cgroup out of memory: Kill(?:ed)? process \d{1,10}|oom-kill:|\S{1,64} invoked oom-killer:)/,
    sample: 'Out of memory: Killed process 48112 (postgres) total-vm:8123456kB, anon-rss:7654321kB, file-rss:0kB, shmem-rss:0kB', evidence: ['K1', 'USE'], title: 'OOM — 프로세스 종료', corr: { playbook: 'health:oom', health: 'oom' } }),
  R({ id: 'PERF-SOFTLOCKUP', cls: 'perf', severity: 'high', tag: 'kernel', re: /^watchdog: BUG: soft lockup - CPU#\d{1,4} stuck for \d{1,6}s!/,
    sample: 'watchdog: BUG: soft lockup - CPU#21 stuck for 23s! [postgres:48112]', evidence: ['K1'], title: 'soft lockup(CPU 멈춤)', corr: { playbook: 'use:cpu' } }),
  R({ id: 'PERF-RCU-STALL', cls: 'perf', severity: 'high', tag: 'kernel', re: /^rcu: INFO: rcu_(?:sched|preempt|bh) (?:self-)?detected (?:stalls?|expedited stalls?)/,
    sample: 'rcu: INFO: rcu_sched self-detected stall on CPU', evidence: ['K1'], title: 'RCU stall', corr: { playbook: 'use:cpu' } }),
  R({ id: 'PERF-HUNGTASK', cls: 'perf', severity: 'medium', tag: 'kernel', re: /^INFO: task \S{1,64}:\d{1,10} blocked for more than \d{1,6} seconds/,
    sample: 'INFO: task postgres:48112 blocked for more than 120 seconds.', evidence: ['K1'], title: 'hung task(D 상태 장기 대기)', corr: { playbook: 'use:disk' } }),
  R({ id: 'PERF-NVME-TIMEOUT', cls: 'perf', severity: 'medium', tag: 'kernel', re: /^nvme nvme\d{1,4}: I\/O \d{1,10} (?:\(\w{1,32}\) )?QID \d{1,6} timeout/,
    sample: 'nvme nvme1: I/O 1024 QID 7 timeout, completion polled', evidence: ['K1'], title: 'NVMe I/O 시한 초과', corr: { playbook: 'use:disk' } }),
  R({ id: 'PERF-SCSI-TIMEOUT', cls: 'perf', severity: 'medium', tag: 'kernel', re: /^sd \d{1,4}:\d{1,4}:\d{1,4}:\d{1,6}: (?:\[\w{1,16}\] )?(?:timing out command|task abort|tag#\d{1,6} FAILED Result: hostbyte=DID_TIME_OUT)/,
    sample: 'sd 2:0:0:0: [sdb] tag#12 FAILED Result: hostbyte=DID_TIME_OUT driverbyte=DRIVER_OK cmd_age=30s', evidence: ['K1'], title: 'SCSI 명령 시한 초과', corr: { playbook: 'use:disk' } }),
  R({ id: 'PERF-NFS-STALL', cls: 'perf', severity: 'medium', tag: 'kernel', re: /^nfs: server \S{1,128} not responding/,
    sample: 'nfs: server nas01.example.internal not responding, still trying', evidence: ['K1'], title: 'NFS 서버 응답 없음', corr: { playbook: 'use:net' } }),
  R({ id: 'PERF-LINKFLAP', cls: 'perf', severity: 'medium', tag: 'kernel', re: /\b(?:NIC )?Link is (?:Down|Up)\b|: Link (?:down|up)$/,
    sample: 'ixgbe 0000:3b:00.0 eno1: NIC Link is Down', evidence: ['K1'], title: 'NIC 링크 Down/Up(반복이면 링크 플랩)', corr: { playbook: 'use:net', cross: 'cable-optic' } }),
  R({ id: 'PERF-THROTTLE', cls: 'perf', severity: 'medium', tag: 'kernel', re: /^CPU\d{1,4}: (?:Core|Package) temperature(?:\/speed)? (?:above threshold|normal)?.{0,40}clock throttled/,
    sample: 'CPU12: Package temperature above threshold, cpu clock throttled (total events = 4)', evidence: ['K1'], title: 'CPU 온도 스로틀', corr: { playbook: 'cross:power-thermal-limit', cross: 'power-thermal-limit' } }),
  R({ id: 'PERF-TCPMEM', cls: 'perf', severity: 'medium', tag: 'kernel', re: /^TCP: out of memory -- consider tuning tcp_mem/,
    sample: 'TCP: out of memory -- consider tuning tcp_mem', evidence: ['K1'], title: 'TCP 소켓 메모리 부족(tcp_mem)', corr: { playbook: 'use:net' } }),
  R({ id: 'PERF-CONNTRACK', cls: 'perf', severity: 'medium', tag: 'kernel', re: /^nf_conntrack: (?:nf_conntrack: )?table full, dropping packet/,
    sample: 'nf_conntrack: nf_conntrack: table full, dropping packet', evidence: ['K1'], title: 'conntrack 표 가득 — 패킷 버림', corr: { playbook: 'health:fdct', health: 'fdct' } }),

  // ── 보안(sec) — kind 는 보안 패널 행(SEC_KINDS) ───────────────────────────────
  R({ id: 'SEC-ROOT-LOGIN', cls: 'sec', severity: 'medium', re: /^Accepted [\w/-]{1,40} for root from \S{1,64} port \d{1,5}/,
    sample: 'Accepted password for root from 10.20.1.5 port 44012 ssh2', evidence: ['S1'], title: 'root 직접 로그인(정책 확인)', kind: 'root' }),
  R({ id: 'SEC-SSH-OK', cls: 'sec', severity: 'info', re: /^Accepted [\w/-]{1,40} for \S{1,64} from \S{1,64} port \d{1,5}/,
    sample: 'Accepted publickey for gpadmin from 10.20.1.5 port 52210 ssh2: ED25519 SHA256:AbCdEf0123456789', evidence: ['S1'], title: 'SSH 로그인 성공', kind: 'ok' }),
  R({ id: 'SEC-SSH-FAIL', cls: 'sec', severity: 'medium', re: /^Failed (?:password|publickey|keyboard-interactive\/pam|none) for (?:invalid user )?\S{0,64} from \S{1,64} port \d{1,5}/,
    sample: 'Failed password for root from 203.0.113.45 port 51822 ssh2', evidence: ['S1'], title: 'SSH 로그인 실패', kind: 'fail' }),
  R({ id: 'SEC-SSH-INVALID', cls: 'sec', severity: 'medium', re: /^Invalid user \S{0,64} from \S{1,64}/,
    sample: 'Invalid user admin from 198.51.100.7 port 40022', evidence: ['S1'], title: '없는 계정으로 SSH 시도', kind: 'fail' }),
  R({ id: 'SEC-PAM-FAIL', cls: 'sec', severity: 'medium', re: /^pam_unix\([\w-]{1,24}:auth\): authentication failure;/,
    sample: 'pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.45  user=root', evidence: ['S1', 'S3'], title: 'PAM 인증 실패', kind: 'fail' }),
  R({ id: 'SEC-SU-FAIL', cls: 'sec', severity: 'medium', re: /^FAILED SU \(to \S{1,64}\) \S{1,64} on /,
    sample: 'FAILED SU (to root) kim.ops on pts/1', evidence: ['S3'], title: 'su 실패', kind: 'fail' }),
  R({ id: 'SEC-SUDO-FAIL', cls: 'sec', severity: 'medium', re: /^\s{0,4}\S{1,64} : (?:\d{1,3} incorrect password attempts?|user NOT in sudoers|command not allowed)/,
    sample: 'kim.ops : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/home/kim.ops ; USER=root ; COMMAND=/usr/bin/cat /etc/shadow', evidence: ['S2'], title: 'sudo 거부 · 비밀번호 실패', kind: 'sudofail' }),
  R({ id: 'SEC-SUDO', cls: 'sec', severity: 'low', re: /^\s{0,4}\S{1,64} : (?:TTY=\S{1,32} ; )?PWD=.{0,256}? ; USER=\S{1,64} ; COMMAND=/,
    sample: 'kim.ops : TTY=pts/0 ; PWD=/home/kim.ops ; USER=root ; COMMAND=/usr/bin/systemctl restart postgresql', evidence: ['S2'], title: 'sudo 실행', kind: 'sudo' }),
  R({ id: 'SEC-ACCOUNT', cls: 'sec', severity: 'medium', re: /^(?:new (?:user|group): name=|delete (?:user|group) '|change user '|add '[^']{1,64}' to (?:shadow )?group '|pam_unix\(passwd:chauthtok\): password changed for )/,
    sample: 'new user: name=gpx, UID=1001, GID=1001, home=/home/gpx, shell=/bin/bash, from=/dev/pts/0', evidence: ['S3'], title: '계정 · 그룹 · 비밀번호 변경', kind: 'acct' }),
  R({ id: 'SEC-AVC', cls: 'sec', severity: 'medium', re: /\bavc: {1,2}denied {1,2}\{/,
    sample: 'type=AVC msg=audit(1762402800.123:456): avc:  denied  { read } for  pid=1234 comm="httpd" name="secret.conf" dev="dm-0" ino=12345 scontext=system_u:system_r:httpd_t:s0 tcontext=unconfined_u:object_r:user_home_t:s0 tclass=file permissive=0',
    evidence: ['S6', 'S4'], title: 'SELinux 거부(AVC)', kind: 'avc', corr: { playbook: 'health:tuned', health: 'tuned' } }),
  R({ id: 'SEC-AUDIT-AUTH-FAIL', cls: 'sec', severity: 'medium', tag: 'audit', re: /^type=USER_(?:AUTH|LOGIN|ACCT) msg=audit\([\d.:]{1,40}\): .{0,400}?\bres=failed/,
    sample: "type=USER_AUTH msg=audit(1762402800.123:457): pid=2211 uid=0 auid=4294967295 ses=4294967295 msg='op=PAM:authentication grantors=? acct=\"root\" exe=\"/usr/sbin/sshd\" hostname=203.0.113.45 addr=203.0.113.45 terminal=ssh res=failed'",
    evidence: ['S4'], title: 'audit 인증 실패', kind: 'fail' }),
  R({ id: 'SEC-AUDIT-ACCT', cls: 'sec', severity: 'medium', tag: 'audit', re: /^type=(?:ADD_USER|DEL_USER|ADD_GROUP|DEL_GROUP|USER_MGMT|GRP_MGMT|USER_CHAUTHTOK) msg=audit\(/,
    sample: "type=ADD_USER msg=audit(1762402800.200:458): pid=3311 uid=0 auid=1000 ses=3 msg='op=add-user id=1001 exe=\"/usr/sbin/useradd\" hostname=? addr=? terminal=pts/0 res=success'",
    evidence: ['S4'], title: 'audit 계정 변경', kind: 'acct' }),
  R({ id: 'SEC-AUDIT-CONFIG', cls: 'sec', severity: 'low', tag: 'audit', re: /^type=(?:CONFIG_CHANGE|DAEMON_ABORT|DAEMON_END) msg=audit\(/,
    sample: 'type=CONFIG_CHANGE msg=audit(1762402800.300:459): auid=1000 ses=3 op=remove_rule key="identity" list=4 res=1', evidence: ['S4'], title: 'audit 설정 변경 · 데몬 중단' }),
  // 포탈 로그인 실패 판정(logs/loginFailPattern.js)을 같은 정규식 객체로 — 위 sshd · PAM 전용 규칙에 안 맞는 로그인 실패 문장(‘authentication failed’ · ‘invalid user’ …).
  R({ id: 'SEC-LOGIN-FAIL', cls: 'sec', severity: 'medium', re: LOGIN_FAIL_MSG_RE,
    sample: 'vsftpd: login failure for user ftpuser from 198.51.100.9', evidence: ['S5'], title: '로그인 실패(포탈 판정 재사용)', kind: 'fail' }),

  // ── 이슈(issue) ───────────────────────────────────────────────────────────
  R({ id: 'ISS-RESTART-LOOP', cls: 'issue', severity: 'high', re: /^\S{1,128}\.service: Start request repeated too quickly/,
    sample: 'airflow-scheduler.service: Start request repeated too quickly.', evidence: ['D1'], title: '유닛 재시작 반복(start-limit)', corr: { playbook: 'health:units', health: 'units' } }),
  R({ id: 'ISS-UNIT-FAIL', cls: 'issue', severity: 'medium', re: /^\S{1,128}\.(?:service|socket|mount|timer|path): Failed with result '[\w-]{1,40}'/,
    sample: "postgresql.service: Failed with result 'exit-code'.", evidence: ['D1'], title: '유닛 실패', corr: { playbook: 'health:units', health: 'units' } }),
  R({ id: 'ISS-COREDUMP', cls: 'issue', severity: 'medium', re: /^Process \d{1,10} \(\S{1,64}\) of user \d{1,10} dumped core/,
    sample: 'Process 48112 (postgres) of user 1001 dumped core.', evidence: ['D1'], title: '코어 덤프' }),
  R({ id: 'ISS-SEGFAULT', cls: 'issue', severity: 'low', tag: 'kernel', re: /^\S{1,64}\[\d{1,10}\]: segfault at [0-9a-f]{1,16} ip [0-9a-f]{1,16}/,
    sample: 'python3[22101]: segfault at 0 ip 00007f3a1c2d4e10 sp 00007ffd3c1b2a90 error 4 in libc.so.6[7f3a1c200000+175000]', evidence: ['K1'], title: '프로세스 segfault' }),
  R({ id: 'ISS-FS-RO', cls: 'issue', severity: 'high', re: /\bRemounting filesystem read-only\b|\bre-?mounted read-only\b/i,
    sample: 'EXT4-fs (dm-2): Remounting filesystem read-only', evidence: ['K1'], title: '파일시스템 읽기 전용 재마운트', corr: { playbook: 'use:disk' } }),
  R({ id: 'ISS-DISKFULL', cls: 'issue', severity: 'high', re: /\bNo space left on device\b/,
    sample: 'rsyslogd: file /var/log/messages: write error - No space left on device [v8.2102.0]', evidence: ['K1'], title: '디스크 가득(No space left)', corr: { playbook: 'use:disk' } }),
  R({ id: 'ISS-CLOCK-STEP', cls: 'issue', severity: 'medium', re: /^System clock wrong by -?\d{1,10}(?:\.\d{1,9})? seconds|^Time has been changed$|^System clock was stepped by /,
    sample: 'System clock wrong by 0.912345 seconds, adjustment started', evidence: ['D2'], title: '시각 점프 · 보정', corr: { playbook: 'health:chrony', health: 'chrony' } }),
  R({ id: 'ISS-PKG-KERNEL', cls: 'issue', severity: 'medium', re: /\b(?:Installed|Upgraded|Upgrade): kernel(?:-core)?-\d/,
    sample: 'Installed: kernel-5.14.0-427.el9.x86_64', evidence: ['D3'], title: '커널 패키지 설치 — 재부팅 필요 확인', corr: { playbook: 'health:uptime', health: 'uptime' } }),

  // ── 용도(APP — 프로파일 경로의 로그 · 분류는 위 넷 중 하나) ─────────────────────────
  R({ id: 'APP-GP-PANIC', cls: 'fault', severity: 'critical', tag: 'gpdb', re: /^PANIC: /,
    sample: 'PANIC: could not write to file "pg_wal/xlogtemp.12345": No space left on device', evidence: ['G1'], title: 'GPDB · PostgreSQL PANIC', corr: { playbook: 'profile:gp.downSeg' } }),
  R({ id: 'APP-GP-SEG-DOWN', cls: 'fault', severity: 'high', tag: 'gpdb', re: /\bFTS\b.{0,80}\b(?:marking|marked) (?:segment|mirror|primary)\b.{0,40}\bdown\b|\bsegment \(dbid=\d{1,6}\).{0,40}\bis down\b/i,
    sample: 'LOG: FTS: marking mirror segment (dbid=12) as down', evidence: ['G2'], title: 'GPDB 세그먼트 다운(FTS)', corr: { playbook: 'profile:gp.downSeg' } }),
  R({ id: 'APP-GP-FATAL', cls: 'issue', severity: 'high', tag: 'gpdb', re: /^FATAL: /,
    sample: 'FATAL: the database system is in recovery mode', evidence: ['G1'], title: 'GPDB · PostgreSQL FATAL' }),
  R({ id: 'APP-PG-DEADLOCK', cls: 'perf', severity: 'medium', tag: 'gpdb', re: /^ERROR: deadlock detected/,
    sample: 'ERROR: deadlock detected', evidence: ['G1'], title: '교착(deadlock)' }),
  R({ id: 'APP-PG-CKPT-FREQ', cls: 'perf', severity: 'medium', tag: 'gpdb', re: /^LOG: checkpoints are occurring too frequently \(\d{1,6} seconds? apart\)/,
    sample: 'LOG: checkpoints are occurring too frequently (12 seconds apart)', evidence: ['G1'], title: '체크포인트가 너무 잦음' }),
  R({ id: 'APP-PG-CKPT-SLOW', cls: 'perf', severity: 'low', tag: 'gpdb', re: /^LOG: checkpoint complete: .{0,200}?\bsync=\d{2,6}\.\d{1,3} s/,
    sample: 'LOG: checkpoint complete: wrote 48112 buffers (18.4%); 0 WAL file(s) added, 0 removed, 3 recycled; write=29.9 s, sync=21.9 s, total=52.1 s', evidence: ['G1'], title: '체크포인트 sync 10초 이상' }),
  R({ id: 'APP-AF-HEARTBEAT', cls: 'issue', severity: 'high', tag: 'airflow', re: /^(?:ERROR|CRITICAL) - .{0,80}\b(?:Scheduler heartbeat got an exception|heartbeat (?:failed|timed out)|not heartbeating)/i,
    sample: 'ERROR - Scheduler heartbeat got an exception: (psycopg2.OperationalError) server closed the connection unexpectedly', evidence: ['A1'], title: 'Airflow 스케줄러 하트비트 이상', corr: { playbook: 'profile:af.heartbeat' } }),
  R({ id: 'APP-AF-DB', cls: 'issue', severity: 'high', tag: 'airflow', corr: { playbook: 'profile:af.metaDb' }, re: /^(?:ERROR|CRITICAL) - .{0,120}\b(?:OperationalError|sqlalchemy\.exc\.\w{1,40})\b/,
    sample: 'ERROR - (sqlalchemy.exc.OperationalError) could not connect to server: Connection refused', evidence: ['A1'], title: 'Airflow 메타 DB 연결 오류' }),
  R({ id: 'APP-AF-TASK-FAILED', cls: 'issue', severity: 'medium', tag: 'airflow', re: /^(?:ERROR|WARNING) - Executor reports task instance .{1,300}? finished \(failed\)/,
    sample: "ERROR - Executor reports task instance <TaskInstance: etl_daily.load run_2026-11-06 [queued]> finished (failed) although the task says it's queued.", evidence: ['A1'], title: 'Airflow 태스크 실패 보고' }),
  R({ id: 'APP-AF-ZOMBIE', cls: 'issue', severity: 'medium', tag: 'airflow', re: /^(?:ERROR|WARNING|INFO) - .{0,60}\bDetected (?:zombie job|\d{1,6} zombies?)/i,
    sample: 'ERROR - Detected zombie job: {"DAG Id": "etl_daily", "Task Id": "load"}', evidence: ['A1'], title: 'Airflow 좀비 태스크' }),
]);

/**
 * 파생 규칙 — 정규식이 아니라 기본 규칙 줄을 다시 묶어 만든다(classify.js). 표본은 기본 규칙의 줄이고, 테스트가 임계 수만큼 넣어 이 규칙이 생기는지 본다.
 */
export const DERIVED_RULES = Object.freeze([
  Object.freeze({ id: 'SEC-SSH-FAIL-BURST', cls: 'sec', severity: 'high', tag: '', grade: '○', kind: 'fail', derivedFrom: ['SEC-SSH-FAIL', 'SEC-SSH-INVALID', 'SEC-PAM-FAIL', 'SEC-LOGIN-FAIL', 'SEC-AUDIT-AUTH-FAIL'],
    sample: 'Failed password for root from 203.0.113.45 port 51822 ssh2', evidence: ['S1', 'S5'], title: 'SSH 실패 집중(같은 IP · 창 안 임계 이상)', corr: {} }),
]);
export const ALL_LOG_RULES = Object.freeze([...LOG_RULES, ...DERIVED_RULES]);
export const LOG_RULE_IDS = Object.freeze(ALL_LOG_RULES.map((r) => r.id));
const _byId = new Map(ALL_LOG_RULES.map((r) => [r.id, r]));
export const logRuleById = (id) => _byId.get(String(id || '')) || null;

/** 화면 규칙 카탈로그(정규식은 글자로 · 근거 문서 · 등급). */
export function logRuleCatalog() {
  return ALL_LOG_RULES.map((r) => ({
    id: r.id, cls: r.cls, clsLabel: CLASS_LABEL[r.cls], severity: r.severity, tag: r.tag || '', title: r.title, grade: r.grade,
    evidence: (r.evidence || []).map((e) => ({ id: e, text: LOG_EVIDENCE[e] || '' })),
    pattern: r.re ? r.re.source.slice(0, 300) : '', derived: !!r.derivedFrom, ...(r.derivedFrom ? { derivedFrom: r.derivedFrom } : {}),
    ...(r.kind ? { kind: r.kind } : {}), corr: r.corr || {},
  }));
}
