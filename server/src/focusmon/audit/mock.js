/**
 * focusmon/audit/mock.js — 데모(mock) 대상의 디스크 점검 출력(v3.11.0). 실제 프로그램의 글자 꼴(rhel_disk_audit.py emit) 그대로 만든다 —
 * 중앙의 해석 · 요약 · 묶어 보기 · 화면이 실데이터와 같은 길을 탄다. 값은 가상이고 화면이 데모라고 밝힌다.
 */
import { programSha, wrapperSha, pathsFor, dirsToCheck } from './bundle.js';
import { DEMO_TARGETS } from '../mock.js';

const nameOf = (id) => DEMO_TARGETS.find((t) => t.id === id)?.name || '';
/** 데모 서버별 상태 — hit(기록 있음) · clean · nosudo · nopy · version */
const STATE = { 'kr-db-01': 'hit', 'pl-db-01': 'iohit', 'us-db-01': 'nosudo', 'us-bak-01': 'nopy', 'pl-file-01': 'version' };
/** 데모 서버 모델 · 물리 디스크(모델 · 크기 · 종류 · 수) — 가상 머신은 물리 디스크가 없다 */
function hwOf(name) {
  const role = String(name).split('-')[1] || '';
  const site = String(name).split('-')[0];
  if (role === 'was' || role === 'web' || role === 'mes' || role === 'mon') return { vendor: 'VMware, Inc.', product: 'VMware Virtual Platform', disks: [] };
  if (role === 'db') return { vendor: 'Dell Inc.', product: 'PowerEdge R740xd', disks: site === 'pl' ? [['MG04ACA400N', '3.637 TB', 'HDD', 8], ['ST4000NM0035-1V4107', '3.637 TB', 'HDD', 4]] : [['ST4000NM0035-1V4107', '3.637 TB', 'HDD', site === 'kr' && name.endsWith('02') ? 6 : 8], ...(name === 'kr-db-02' ? [['SSDSC2KB480G8', '447.1 GB', 'SSD', 2]] : [])] };
  return { vendor: 'Dell Inc.', product: 'PowerEdge R640', disks: [['SSDSC2KB480G8', '447.1 GB', 'SSD', 2]] };
}
const hex = (n, w) => n.toString(16).padStart(w, '0');
function seedOf(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }

/** v3.17.0: 설치 위치(dir — '' 기본 경로)에 맞춘 준비 줄 — 데모에서 설치 디렉터리를 바꿔 설치해도 실데이터와 같은 해석을 탄다. */
function readyLines(name, dir = '') {
  const st = STATE[name] || 'clean'; const hw = hwOf(name);
  const P = pathsFor(dir) || pathsFor('');
  const pSha = st === 'version' ? 'a'.repeat(64) : programSha(); const wSha = wrapperSha(P.dir);
  const inst = st !== 'nopy';
  return [
    '##DR 1', st === 'nopy' ? '##DR py -' : '##DR py 3.6.8',
    inst ? `##DR file ${P.program} ${pSha} 0:0:644` : `##DR file ${P.program} - -`,
    inst ? `##DR file ${P.wrapper} ${wSha} 0:0:755` : `##DR file ${P.wrapper} - -`,
    ...dirsToCheck(P).all.map((d, i) => `##DR dir ${d} ${inst || i > 0 || P.dir === '' ? '0:0:755' : '-'}`),
    st === 'nosudo' || !inst ? '##DR sudo no' : '##DR sudo ok', `##DR dmi ${hw.vendor}|${hw.product}`, '##DR end',
  ];
}

function runLines(name) {
  const st = STATE[name] || 'clean'; const hw = hwOf(name); const sd = seedOf(name);
  const N = ((sd >>> 0).toString(16).padStart(8, '0') + ((sd * 2654435761) >>> 0).toString(16).padStart(8, '0')).slice(0, 16); // 실행 표지(데모 — 이름에서 고정)
  const L = [`##DA BEGIN 2 ${N}`, `RHEL 디스크 오류 이력 점검 | ${name} | 2026-11-15T08:12:00.000000+09:00`, '보고서 | /tmp/dvc-disk-audit.demo/rhel_disk_audit_demo.txt', '', '[로그 수집 범위]',
    '  /usr/bin/journalctl --list-boots --no-pager | 종료값 0',
    `  journalctl 전체 보존 부트 | ${(800_000 + (sd % 2_000_000)).toLocaleString('en-US')}줄, 후보 ${st === 'hit' ? 2 : st === 'iohit' ? 6 : 0}줄, 해석 실패 0줄 | 2026-08-19T03:10:00+00:00 ~ 2026-11-14T23:11:00+00:00`,
    `  /var/log/messages | ${(40_000 + (sd % 90_000)).toLocaleString('en-US')}줄, 후보 ${st === 'hit' ? 1 : 0}줄, 해석 실패 0줄 | 시간 비교 불가 ~ 시간 비교 불가`,
    ...(st === 'hit' ? ['  일부만 읽음 /var/log/messages-20260921.gz | Compressed file ended before the end-of-stream marker was reached'] : []),
    '  /usr/bin/dmesg --color=never | 종료값 0', '  dmesg (현재 부트, 상대 시간) | 2,988줄, 후보 0줄, 해석 실패 0줄 | 시간 비교 불가 ~ 시간 비교 불가', '', '[PERC/StorCLI 조회]'];
  const phys = []; let slot = 0;
  for (const [model, size, med, n] of hw.disks) for (let i = 0; i < n; i += 1) { phys.push({ slot: `/c0/e32/s${slot}`, sn: `Z${hex((sd + slot * 7919) >>> 0, 7).toUpperCase().slice(0, 7)}`, wwn: `5000c500${hex((sd + slot) >>> 0, 8)}`, model, size, med }); slot += 1; }
  if (!phys.length) L.push('  수집 불가 | perccli/storcli (RAID 구성이라면 물리 디스크 가시성 제한)');
  else { L.push('  /opt/MegaRAID/perccli/perccli64 show J | 종료값 0', '  /opt/MegaRAID/perccli/perccli64 /c0/eall/sall show all | 종료값 0'); for (const p of phys) L.push(`    ${p.slot} | media error count = ${st === 'hit' && p === phys[5] ? 14 : 0}`); }
  L.push('', '[OS/SMART 조회]', '  /usr/bin/lsblk -J -p -o NAME,KNAME,TYPE,MODEL,SERIAL,WWN,TRAN,FSTYPE,MOUNTPOINT | 종료값 0', '', '[RAID 경유 물리 SMART 조회]');
  if (phys.length) L.push('  /usr/sbin/smartctl --scan-open | 종료값 0'); else L.push('    smartctl이 발견한 MegaRAID/PERC 물리 SMART 경로 없음.');
  L.push('', '[현재 디스크 인벤토리]');
  for (const p of phys) L.push(`  ${p.slot} | RAID 물리 디스크 | SN=${p.sn} WWN=${p.wwn} | 마운트/스왑 표시 물리 디스크에서 판단 불가`);
  L.push(`  /dev/sda | 가상/논리 또는 RAID 경유 OS 장치 | 식별자 없음 | 마운트/스왑 표시 있음`);
  L.push('', '[판정]');
  const bad = phys[5];
  const ev = [];
  if (st === 'hit' && bad) {
    ev.push(['매체 오류 기록', 'journalctl 전체 보존 부트:1482211', '2026-10-02T08:31:09+00:00', '식별자 없음', ' | 장치 sdb', `kernel boot=7c1e9a host=${name} | blk_update_request: critical medium error, dev sdb, sector 1953120264`]);
    ev.push(['매체 오류 기록', 'PERC/StorCLI 카운터', '시간 비교 불가', `SN=${bad.sn} WWN=${bad.wwn}`, ` | ${bad.slot}`, `${bad.slot} | media error count = 14`]);
    ev.push(['매체 오류 기록', '/c0 컨트롤러 이벤트:8841', '시간 비교 불가', '식별자 없음', '', 'perc-event seq=0x00002a11 Fri Oct  2 17:31:10 2026 | Unrecoverable medium error during recovery on PD 05(e0x20/s5) at 746b0c8']);
    ev.push(['I/O·경로 오류 기록', '/var/log/messages-20261004:20931', '시간 비교 불가', '식별자 없음', ' | 장치 sdb1', `kernel host=${name} Oct  2 17:31:09 | Buffer I/O error on dev sdb1, logical block 244140033, async page read`]);
    ev.push(['I/O·경로 오류 기록', 'dmesg (현재 부트, 상대 시간):2210', '시간 비교 불가', '식별자 없음', ' | 장치 sdb', 'kernel | blk_update_request: I/O error, dev sdb, sector 1953120264']);
    ev.push(['재할당 기록', 'smartctl /dev/bus/0 -d sat+megaraid,5', '시간 비교 불가', `SN=${bad.sn} WWN=${bad.wwn}`, ' | 장치 /dev/bus/0', 'SMART ID 5 Reallocated_Sector_Ct RAW_VALUE = 8']);
  }
  if (st === 'iohit') for (let i = 0; i < 6; i += 1) ev.push(['I/O·경로 오류 기록', `journalctl 전체 보존 부트:${900_100 + i * 37}`, `2026-11-0${3 + (i % 3)}T0${i}:12:4${i}+00:00`, '식별자 없음', ' | 장치 sdc', `kernel boot=31aa02 host=${name} | sd 0:0:2:0: [sdc] tag#${i} FAILED Result: hostbyte=DID_TIME_OUT driverbyte=DRIVER_OK`]);
  const cnt = (k) => ev.filter((e) => e[0] === k).length;
  if (ev.length) {
    L.push('  [확정] 수집 자료에서 다음 오류 또는 카운터 기록 관측 (줄 기준, 중복 가능)');
    for (const k of ['매체 오류 기록', 'I/O·경로 오류 기록', '재할당 기록']) if (cnt(k)) L.push(`    ${k} | ${cnt(k)}건`);
  } else L.push('  [불명] 가용 자료에서 대상 오류 패턴 미검출. 과거 무장애 여부는 알 수 없음.');
  L.push(`  파일시스템 생성 성공 패턴 0줄, 명령/시도 패턴 ${st === 'hit' ? 1 : 0}줄`);
  const noId = ev.filter((e) => e[3] === '식별자 없음').length;
  if (!ev.length) L.push('  [불명] 포맷 후 재사용 및 교체 여부를 연결할 장애 디스크 식별 근거 부족.');
  if (noId) L.push(`  [불명] 오류 기록 ${noId}줄의 물리 식별자를 연결할 수 없음.`);
  if (st === 'hit' && bad) {
    L.push(`  SN=${bad.sn} WWN=${bad.wwn} ${bad.slot} | 오류 근거 #2`, `    [확정] 현재 인벤토리에 식별자 일치 | ${bad.slot}`, '    [불명] 매체 오류 이후 포맷 및 현재 재사용을 함께 입증할 근거 부족.');
    L.push(`  SN=${bad.sn} WWN=${bad.wwn} | 오류 근거 #6`, `    [확정] 현재 인벤토리에 식별자 일치 | ${bad.slot}`, '    [불명] 매체 오류 이후 포맷 및 현재 재사용을 함께 입증할 근거 부족.');
  }
  L.push('', '[상세 근거]');
  ev.forEach((e, i) => L.push(`  #${i + 1} [${e[0]}] ${e[1]} | ${e[2]} | ${e[3]}${e[4]} | ${e[5]}`));
  if (st === 'hit') L.push(`  [파일시스템 생성 명령] journalctl 전체 보존 부트:2210773 | 2026-10-28T02:14:51+00:00 | 식별자 없음 | 장치 /dev/sdc1 | sudo boot=7c1e9a host=${name} | ops-kim : TTY=pts/1 ; USER=root ; COMMAND=/usr/sbin/mkfs.xfs /dev/sdc1`);
  L.push('', '[해석 범위]', `  확인하지 못했거나 일부만 수집한 소스/항목 ${phys.length ? (st === 'hit' ? 1 : 0) : 1}개.`,
    '  삭제·회전·덮어쓰기·휘발성 로그, 오프호스트 로그 및 다른 journal namespace는 범위 밖.', '  일반 I/O 오류는 케이블·경로·컨트롤러·가상디스크 등에서도 발생할 수 있음.',
    '  서로 다른 소스에 복제된 기록은 각각 표시. 건수는 장애 횟수가 아님.', '', '완료 | /tmp/dvc-disk-audit.demo/rhel_disk_audit_demo.txt', `##DA ${N} EXIT 0`, `##DA ${N} DISKS`,
    `NAME="sda" TYPE="disk" MODEL="${phys.length ? 'PERC H740P Mini' : 'Virtual disk'}" SERIAL="" WWN="0x6d0946607a1b2c00271f3e5a0c9d4411" SIZE="${phys.length ? '14.6T' : '100G'}" ROTA="1" TRAN=""`);
  if (phys.length) { L.push(`##DA ${N} RAID`); for (const p of phys) L.push(`Drive ${p.slot} :`, `${p.slot.split('/e')[1].replace('/s', ':')}     ${p.slot.split('/s')[1]} Onln   0 ${p.size} SATA ${p.med} N   N  512B ${p.model} U  -`, `Drive ${p.slot} Device attributes :`, `SN = ${p.sn}`, `Model Number = ${p.model}`, `WWN = ${p.wwn.toUpperCase()}`); }
  L.push(`##DA ${N} END`);
  return L;
}

/** @returns {{ready:string[], out:string[], outBytes:number, truncated:boolean, code:number|null, stderr:string}} */
export function demoAuditOutput(id, mode, dir = '') {
  const name = nameOf(id);
  const ready = readyLines(name, dir);
  const st = STATE[name] || 'clean';
  const canRun = mode === 'run' && !['nosudo', 'nopy', 'version'].includes(st);
  const out = canRun ? runLines(name) : [];
  return { ready, out, outBytes: out.reduce((a, l) => a + Buffer.byteLength(l) + 1, 0), truncated: false, code: null, stderr: '' };
}
/** 데모 서버의 법인(데모 표시용 — 실제 법인 목록과 별개). */
export function demoCorpOf(name) { const s = String(name).split('-')[0]; return s === 'kr' ? { id: 'demo-kr', name: '한국(데모)' } : s === 'pl' ? { id: 'demo-pl', name: '폴란드(데모)' } : s === 'us' ? { id: 'demo-us', name: '미국(데모)' } : null; }
