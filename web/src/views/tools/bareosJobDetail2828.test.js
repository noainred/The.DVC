// v2.828 Bareos 작업 결과 상세 — 크기 단위 · 카드 부제 · 로그 줄 분류 · 세부(TLS·장치·볼륨·백업 항목) · 타임라인.
// 픽스처는 현장 JobId 13(LESANXMPOB01 · 2026-10-30 · Backup OK · Full) 로그를 옮긴 것이다. 화면에서 잘려 보이지 않던
// 디스크 경로 끝부분('[VPLEX-…] …', '[DVC.Un…] …', 'LESANXM…'), 스크롤에 가려진 Full-0010 가득 참 두 줄(22:36:29)은 같은 모양으로 채웠다 — 판정과 무관하다.
import { describe, it, expect } from 'vitest';
import {
  parseJobReport, reportCards, reportText, issueHint, issueTone, ISSUE_TONE_LABEL, REPORT_KEYS,
  decBytesText, reportSizeText, rateText, elapsedKo, durKo, pctText, volumeNames, clockOf, clockSec,
  classifyLogLine, splitHit, filterLogLines, parseJobDetail, jobTimeline, LOG_WHO_LABEL,
} from './bareosText.js';

const D = '2026-10-30';
const L = (time, who, msg) => `${D} ${time} ${who} JobId 13: ${msg}`;
const R = (time, key, val) => `${D} ${time}   ${key}:${' '.repeat(Math.max(1, 24 - key.length))}${val}`;
const VM = '/VMS/Datacenter/A.MGMT/00.Console/theDVC/LESANXMPOB01/';
const FD = 'LESANXMPOB02-fd';
const TLS = 'encryption: TLS_CHACHA20_POLY1305_SHA256 TLSv1.3';

export const JOB13 = [
  L('22:30:21', 'bareos-dir', 'Version: 25.1.2~pre73.3e32b07ea (26 October 2026) Rocky Linux 9.4 (Blue Onyx)'),
  L('22:30:21', 'bareos-dir', 'Start Backup JobId 13, Job=pv-54220daf-vm-152460.2026-10-30_22.14.35_57'),
  L('22:30:21', 'bareos-dir', `Connected Storage daemon at LESANXMPOB02:9103, ${TLS}`),
  L('22:30:21', 'bareos-dir', ' Encryption: TLS_CHACHA20_POLY1305_SHA256 TLSv1.3'),
  L('22:30:21', 'bareos-dir', `Connected Client: bareos-fd at localhost:9102, ${TLS}`),
  L('22:30:21', 'bareos-dir', ' Handshake: Immediate TLS'),
  L('22:30:21', 'bareos-dir', ' Encryption: TLS_CHACHA20_POLY1305_SHA256 TLSv1.3'),
  L('22:30:21', FD, "Warning: python3-fd-mod: BareosFdPluginVMware: Overriding plugin option vcserver:'192.168.21.200' from config file /etc/bareos/vmware/OC2.ini"),
  L('22:30:21', 'bareos-sd', 'Using just in time reservation for job 13'),
  L('22:30:21', 'bareos-dir', 'Using Device "JustInTime Device" to write.'),
  L('22:30:21', FD, `Connected Storage daemon at LESANXMPOB02:9103, ${TLS}`),
  L('22:30:21', FD, ' Encryption: TLS_CHACHA20_POLY1305_SHA256 TLSv1.3'),
  L('22:30:21', FD, 'Extended attribute support is enabled'),
  L('22:30:21', 'bareos-sd', 'Version: 25.1.2~pre73.3e32b07ea (26 October 2026) Rocky Linux 9.4 (Blue Onyx)'),
  L('22:30:21', FD, 'ACL support is enabled'),
  L('22:30:21', FD, 'python3-fd-mod: Successfully connected to VSphere API on host 192.168.21.200 with user administrator@vsphere.local'),
  L('22:30:21', FD, 'python3-fd-mod: Error vm LESANXMPOB01 is not CBT enabled, enabling it now.'),
  L('22:30:34', FD, 'Version: 25.1.2~pre73.3e32b07ea (26 October 2026) Rocky Linux 9.4 (Blue Onyx)'),
  L('22:30:34', FD, `python3-fd-mod: Starting backup of ${VM}vm_config.json`),
  L('22:30:34', FD, `python3-fd-mod: Starting backup of ${VM}vm_info.json`),
  L('22:30:34', FD, `python3-fd-mod: Starting backup of ${VM}vm_metadata.json`),
  L('22:30:34', 'bareos-sd', 'JustInTime Reservation: Finding drive to reserve.'),
  L('22:30:34', FD, `python3-fd-mod: Starting backup of ${VM}LESANXMPOB01.nvram`),
  L('22:30:34', 'bareos-sd', 'Using Device "FileStorage0001" (/mnt/theDVC/bareos) to write.'),
  L('22:30:34', FD, `python3-fd-mod: Starting backup of ${VM}[VPLEX-DS01] LESANXMPOB01/LESANXMPOB01.vmdk`),
  L('22:30:34', FD, `python3-fd-mod: Starting backup of ${VM}[VPLEX-DS01] LESANXMPOB01/LESANXMPOB01_1.vmdk`),
  L('22:30:34', 'bareos-sd', 'Moving to end of data on volume "Full-0010"'),
  L('22:36:29', 'bareos-sd', 'User defined maximum volume capacity 53,687,091,200 exceeded on device "FileStorage0001" (/mnt/theDVC/bareos).'),
  L('22:36:29', 'bareos-sd', 'End of medium on Volume "Full-0010" Bytes=53,686,042,800 Blocks=51,200 at 30-Oct-2026 22:36.'),
  L('22:36:32', 'bareos-dir', 'Created new Volume "Full-0011" in catalog.'),
  L('22:36:32', 'bareos-sd', 'Labeled new Volume "Full-0011" on device "FileStorage0001" (/mnt/theDVC/bareos).'),
  L('22:36:32', 'bareos-sd', 'Moving to end of data on volume "Full-0011"'),
  L('22:36:32', 'bareos-sd', 'Ready to append to end of Volume "Full-0011" size=214'),
  L('22:36:32', 'bareos-sd', 'New volume "Full-0011" mounted on device "FileStorage0001" (/mnt/theDVC/bareos) at 30-Oct-2026 22:36.'),
  L('22:41:12', FD, `python3-fd-mod: Starting backup of ${VM}[DVC.Unity01] LESANXMPOB01/LESANXMPOB01_2.vmdk`),
  L('22:41:12', FD, `python3-fd-mod: Starting backup of ${VM}[DVC.Unity01] LESANXMPOB01/LESANXMPOB01_3.vmdk`),
  L('22:42:28', 'bareos-sd', 'User defined maximum volume capacity 53,687,091,200 exceeded on device "FileStorage0001" (/mnt/theDVC/bareos).'),
  L('22:42:28', 'bareos-sd', 'End of medium on Volume "Full-0011" Bytes=53,686,042,830 Blocks=51,200 at 30-Oct-2026 22:42.'),
  L('22:42:31', 'bareos-dir', 'Created new Volume "Full-0012" in catalog.'),
  L('22:42:31', 'bareos-sd', 'Labeled new Volume "Full-0012" on device "FileStorage0001" (/mnt/theDVC/bareos).'),
  L('22:42:31', 'bareos-sd', 'Moving to end of data on volume "Full-0012"'),
  L('22:42:31', 'bareos-sd', 'Ready to append to end of Volume "Full-0012" size=214'),
  L('22:42:31', 'bareos-sd', 'New volume "Full-0012" mounted on device "FileStorage0001" (/mnt/theDVC/bareos) at 30-Oct-2026 22:42.'),
  L('22:46:18', 'bareos-sd', 'User defined maximum volume capacity 53,687,091,200 exceeded on device "FileStorage0001" (/mnt/theDVC/bareos).'),
  L('22:46:18', 'bareos-sd', 'End of medium on Volume "Full-0012" Bytes=53,686,042,818 Blocks=51,200 at 30-Oct-2026 22:46.'),
  L('22:46:21', 'bareos-dir', 'Created new Volume "Full-0013" in catalog.'),
  L('22:46:21', 'bareos-sd', 'Labeled new Volume "Full-0013" on device "FileStorage0001" (/mnt/theDVC/bareos).'),
  L('22:46:21', 'bareos-sd', 'Moving to end of data on volume "Full-0013"'),
  L('22:46:21', 'bareos-sd', 'Ready to append to end of Volume "Full-0013" size=214'),
  L('22:46:21', 'bareos-sd', 'New volume "Full-0013" mounted on device "FileStorage0001" (/mnt/theDVC/bareos) at 30-Oct-2026 22:46.'),
  L('22:54:47', FD, 'python3-fd-mod: Cleaning up snapshot BareosTmpSnap_jobId_13 from VM LESANXMPOB01'),
  L('22:55:53', 'bareos-sd', 'Releasing device "FileStorage0001" (/mnt/theDVC/bareos).'),
  L('22:55:53', 'bareos-sd', 'Elapsed time=00:25:25, Transfer rate=124.9 M Bytes/second'),
  L('22:55:53', 'bareos-dir', 'Insert of attributes batch table with 3 entries start'),
  L('22:55:53', 'bareos-dir', 'Insert of attributes batch table done'),
  L('22:55:53', 'bareos-dir', 'Bareos bareos-dir 25.1.2~pre73.3e32b07ea (26Oct26):'),
  R('22:55:53', 'OS Information', 'Rocky Linux 9.4 (Blue Onyx)'),
  R('22:55:53', 'JobId', '13'),
  R('22:55:53', 'Job', 'pv-54220daf-vm-152460.2026-10-30_22.14.35_57'),
  R('22:55:53', 'Backup Level', 'Full'),
  R('22:55:53', 'Client', '"bareos-fd" 25.1.2~pre73.3e32b07ea (26Oct26) Rocky Linux 9.4 (Blue Onyx),redhat'),
  R('22:55:53', 'FileSet', '"PortalVmwareGeneric" 2026-10-30 07:38:07'),
  R('22:55:53', 'Pool', '"Full" (From Job resource)'),
  R('22:55:53', 'Catalog', '"MyCatalog" (From Client resource)'),
  R('22:55:53', 'Storage', '"File" (From Job resource)'),
  R('22:55:53', 'Scheduled time', '30-Oct-2026 22:14:35'),
  R('22:55:53', 'Start time', '30-Oct-2026 22:30:21'),
  R('22:55:53', 'End time', '30-Oct-2026 22:55:53'),
  R('22:55:53', 'Elapsed time', '25 mins 32 secs'),
  R('22:55:53', 'Priority', '10'),
  R('22:55:53', 'Allow Mixed Priority', 'no'),
  R('22:55:53', 'FD Files Written', '8'),
  R('22:55:53', 'SD Files Written', '8'),
  R('22:55:53', 'FD Bytes Read', '622,513,630,072 (622.5 GB)'),
  R('22:55:53', 'FD Bytes Written', '190,492,284,391 (190.4 GB)'),
  R('22:55:53', 'SD Bytes Written', '190,492,305,747 (190.4 GB)'),
  R('22:55:53', 'Rate', '124342.2 KB/s'),
  R('22:55:53', 'Software Compression', '69.4 % (lz4)'),
  R('22:55:53', 'VSS', 'no'),
  R('22:55:53', 'Encryption', 'no'),
  R('22:55:53', 'Accurate', 'no'),
  R('22:55:53', 'Volume name(s)', 'Full-0010|Full-0011|Full-0012|Full-0013'),
  R('22:55:53', 'Volume Session Id', '7'),
  R('22:55:53', 'Volume Session Time', '1793320698'),
  R('22:55:53', 'Last Volume Bytes', '31,934,418,509 (31.93 GB)'),
  R('22:55:53', 'Non-fatal FD errors', '0'),
  R('22:55:53', 'SD Errors', '0'),
  R('22:55:53', 'FD termination status', 'OK'),
  R('22:55:53', 'SD termination status', 'OK'),
  R('22:55:53', 'Bareos binary info', 'Bareos community build (UNSUPPORTED): Get professional support from https://www.bareos.com'),
  R('22:55:53', 'Job triggered by', 'User'),
  R('22:55:53', 'Termination', 'Backup OK'),
];

describe('v2.828 크기·속도·소요 표기 — Bareos 보고서와 같은 단위', () => {
  it('10진 단위 · 앞 4자리 버림(Bareos 규칙) · 못 읽음은 —', () => {
    expect(decBytesText(622513630072)).toBe('622.5 GB');
    expect(decBytesText(31934418509)).toBe('31.93 GB');
    expect(decBytesText(5833172285)).toBe('5.833 GB');
    expect(decBytesText(999)).toBe('999 B');
    expect(decBytesText(0)).toBe('0 B');
    expect(decBytesText(999_960_000_000)).toBe('999.9 GB');   // 버림 — '1000.0 GB' 로 올라가지 않는다
    expect(decBytesText(1_000_000_000_000)).toBe('1.000 TB');
    expect(decBytesText(53_687_091_200)).toBe('53.68 GB');    // 50 GiB 볼륨 상한 — Bareos 도 53.68 GB 로 적는다
    expect(decBytesText(1000)).toBe('1.000 KB');
    expect(decBytesText(1234.9)).toBe('1.234 KB');
    for (const v of [null, undefined, '', 'x', -5]) expect(decBytesText(v)).toBe('—');
  });
  it('Bareos 보고서의 괄호 값과 포탈 계산이 모든 크기 줄에서 같다(카드·효율 막대·이력 표가 0.1 씩 어긋나지 않게)', () => {
    const sized = JOB13.map((l) => /: +([\d,]{1,30}) \((\d{1,6}\.\d{1,4} [KMGTP]B)\)$/.exec(l)).filter(Boolean);
    expect(sized.length).toBeGreaterThanOrEqual(4);
    for (const [, num, paren] of sized) expect(decBytesText(Number(num.replace(/,/g, '')))).toBe(paren);
  });
  it('보고서 크기는 바이트 수에서 계산(실제 보고서에서는 괄호 값과 같다) — 못 읽으면 —', () => {
    expect(reportSizeText('622,513,630,072 (622.5 GB)')).toBe('622.5 GB');
    expect(reportSizeText('1,000 (1 KB)')).toBe('1.000 KB');   // 바이트 수에서 계산 — 모양이 다른 괄호 값을 그대로 옮기지 않는다
    expect(reportSizeText('10,229,694,436 (10.230 GB)')).toBe('10.22 GB');
    expect(reportSizeText(', (1 GB)')).toBe('—');            // 숫자 없이 쉼표만이면 0 B 가 아니라 못 읽음
    expect(reportSizeText('190492305747')).toBe('190.4 GB');
    expect(reportSizeText('190,492,305,747 (weird)')).toBe('190.4 GB');
    expect(reportSizeText('')).toBe('—');
    expect(reportSizeText(undefined)).toBe('—');
  });
  it('속도 KB/s → MB/s(1000) · 소요는 한글 · 모르는 모양은 원문', () => {
    expect(rateText('124342.2 KB/s')).toBe('124.3 MB/s');
    expect(rateText('850.0 KB/s')).toBe('850 KB/s');
    expect(rateText('1234567.0 KB/s')).toBe('1.23 GB/s');   // '1234.6 MB/s' 로 보이지 않게
    expect(rateText('weird')).toBe('weird');
    expect(rateText('')).toBe('—');
    expect(elapsedKo('25 mins 32 secs')).toBe('25분 32초');
    expect(elapsedKo('1 hour 12 mins 24 secs')).toBe('1시간 12분 24초');
    expect(elapsedKo('1 day 2 hours')).toBe('1일 2시간');
    expect(elapsedKo('51 secs')).toBe('51초');
    expect(elapsedKo('later')).toBe('later');
    expect(elapsedKo(undefined)).toBe('—');
    expect(durKo(946)).toBe('15분 46초');
    expect(durKo(41)).toBe('41초');
    expect(durKo(3720)).toBe('1시간 2분');
    expect(durKo(-1)).toBe('—');
    expect(durKo(null)).toBe('—');
    expect(pctText(0.306)).toBe('30.6%');
    expect(pctText(null)).toBe('—');
  });
  it('볼륨 이름 · 시계 · 현지 시각 빼기(날짜 넘김 포함)', () => {
    expect(volumeNames('Full-0010|Full-0011| |Full-0013')).toEqual(['Full-0010', 'Full-0011', 'Full-0013']);
    expect(volumeNames(undefined)).toEqual([]);
    expect(clockOf('30-Oct-2026 22:30:21')).toBe('22:30:21');
    expect(clockOf('')).toBe('');
    expect(clockSec('30-Oct-2026 22:30:21') - clockSec('30-Oct-2026 22:14:35')).toBe(946);
    expect(clockSec('2026-10-31 00:00:05') - clockSec('2026-10-30 23:59:55')).toBe(10);
    expect(clockSec('2026-10-30 22:30:21')).toBe(clockSec('30-Oct-2026 22:30:21'));
    expect(clockSec('30-Foo-2026 22:30:21')).toBeNull();
    expect(clockSec('')).toBeNull();
  });
});

describe('v2.828 요약 카드 — JobId 13 실데이터', () => {
  const rep = parseJobReport(JOB13);
  it('보고 블록 — 예약 시각도 읽는다', () => {
    expect(rep.found).toBe(true);
    expect(rep.verdict).toEqual({ cls: 'green', label: '성공' });
    expect(rep.fields['Scheduled time']).toBe('30-Oct-2026 22:14:35');
    expect(REPORT_KEYS['Scheduled time']).toBe('예약');
  });
  it('카드 값·부제 — 622.5 GB · 190.4 GB(예전 화면의 580 GB · 177 GB 가 아니다)', () => {
    const c = Object.fromEntries(reportCards(rep.fields).map((x) => [x.k, x]));
    expect(c.read.value).toBe('622.5 GB');
    expect(c.read.meta).toBe('622,513,630,072 B');
    expect(c.stored.value).toBe('190.4 GB');
    expect(c.stored.meta).toBe('190,492,305,747 B · 볼륨 4개');
    expect(c.comp.value).toBe('69.4 % (lz4)');
    expect(c.comp.meta).toBe('저장 30.6% · 절감 432.0 GB');
    expect(c.rate.value).toBe('124.3 MB/s');
    expect(c.rate.meta).toBe('124342.2 KB/s');
    expect(c.elapsed.value).toBe('25분 32초');
    expect(c.elapsed.meta).toBe('22:30:21 → 22:55:53');
    expect(c.vol.value).toBe('4개');
    expect(c.vol.meta).toBe('Full-0010 · Full-0011 · Full-0012 · Full-0013');
  });
  it('못 읽은 값은 — 이고 부제는 비운다(0 으로 보이지 않게)', () => {
    for (const c of reportCards({})) { expect(c.value).toBe('—'); expect(c.meta).toBe(''); }
  });
  it('복사 글도 같은 단위', () => {
    const t = reportText(rep, { vmName: 'LESANXMPOB01', jobid: 13 });
    expect(t).toMatch(/읽은 양\(VM 디스크\): 622\.5 GB/);
    expect(t).toMatch(/LESANXMPOB01 · jobid 13 · 성공/);
    expect(t).not.toContain('`');
  });
  it('경고·오류 — CBT 켬은 안내(문구는 Error), Overriding 은 경고 + 해석, 모르는 Error 는 오류', () => {
    expect(rep.issues.length).toBe(2);
    const cbt = rep.issues.find((x) => /CBT/.test(x.text));
    const ovr = rep.issues.find((x) => /Overriding/.test(x.text));
    expect(issueTone(cbt.text)).toBe('info');
    expect(issueHint(cbt.text)).toMatch(/CBT\(변경 블록 추적\)/);
    expect(issueTone(ovr.text)).toBe('warn');
    expect(issueHint(ovr.text)).toMatch(/정상 동작/);
    expect(issueTone('bareos-sd JobId 9: Fatal error: Permission denied')).toBe('err');
    expect(issueTone('LESA-fd JobId 9: python3-fd-mod: Error something unknown')).toBe('err');
    expect(ISSUE_TONE_LABEL.info).toBe('안내');
  });
});

describe('v2.828 로그 줄 분류 · 거르기 · 강조', () => {
  const rows = JOB13.map(classifyLogLine);
  it('데몬 · 보고 블록 · 시각 · 본문', () => {
    expect(rows[1]).toMatchObject({ date: D, time: '22:30:21', who: 'dir', host: 'bareos', level: 'plain' });
    expect(rows[1].text).toMatch(/^Start Backup JobId 13/);
    expect(rows.find((r) => r.host === 'LESANXMPOB02').who).toBe('fd');
    expect(rows.filter((r) => r.who === 'rep').length).toBe(36);
    expect(LOG_WHO_LABEL.rep).toBe('보고');
  });
  it('색 — 경고 · 안내 · 완료, 보고의 오류 수 0 은 평문, 0 보다 크면 경고', () => {
    expect(rows.find((r) => /Overriding/.test(r.text)).level).toBe('warn');
    expect(rows.find((r) => /CBT/.test(r.text)).level).toBe('info');
    expect(rows.find((r) => /^\s+Termination:/.test(r.text)).level).toBe('ok');
    expect(rows.find((r) => /SD Errors:/.test(r.text)).level).toBe('plain');
    expect(classifyLogLine(`${D} 22:55:53   SD Errors:              6`).level).toBe('warn');
    expect(classifyLogLine(`${D} 22:55:53   Termination:            *** Backup Error ***`).level).toBe('err');
    expect(classifyLogLine('').who).toBe('');
    expect(classifyLogLine(null).text).toBe('');
  });
  it('거르기 — 데몬 · 경고·오류만 · 검색어(대소문자 무시), 원래 줄 번호 유지', () => {
    const numbered = rows.map((r, i) => ({ ...r, n: i + 1 }));
    expect(filterLogLines(numbered, { who: 'fd' }).every((r) => r.who === 'fd')).toBe(true);
    const iss = filterLogLines(numbered, { issuesOnly: true });
    expect(iss.map((r) => r.n)).toEqual([8, 17]);
    expect(filterLogLines(numbered, { q: 'full-0013' }).length).toBe(6);
    expect(filterLogLines(numbered, { who: 'rep', q: 'termination' }).length).toBe(3);
    expect(filterLogLines(null, {})).toEqual([]);
  });
  it('강조 — 처음 맞는 곳 하나', () => {
    expect(splitHit('Moving to end of data on volume "Full-0010"', 'VOLUME')).toEqual(['Moving to end of data on ', 'volume', ' "Full-0010"']);
    expect(splitHit('abc', '')).toEqual(['abc', '', '']);
    expect(splitHit('abc', 'zz')).toEqual(['abc', '', '']);
  });
});

describe('v2.828 세부 — TLS · 장치 · 볼륨 · 백업 항목', () => {
  const d = parseJobDetail(JOB13);
  it('TLS — 세 구간(Dir↔SD · Dir↔FD · FD↔SD) 같은 암호', () => {
    expect(d.tls).toEqual([{ text: 'TLS_CHACHA20_POLY1305_SHA256 · TLSv1.3', n: 3 }]);
  });
  it('장치 — JustInTime 가짜 장치가 아닌 실제 장치 · 볼륨 상한', () => {
    expect(d.device).toEqual({ name: 'FileStorage0001', path: '/mnt/theDVC/bareos' });
    expect(d.capacity).toBe(53687091200);
  });
  it('볼륨 4개 — 이어 쓴 것과 새로 만든 것 · 가득 찬 시각·바이트', () => {
    expect(d.volumes.map((v) => v.name)).toEqual(['Full-0010', 'Full-0011', 'Full-0012', 'Full-0013']);
    expect(d.volumes[0]).toMatchObject({ created: false, fullAt: '22:36:29', fullBytes: 53686042800 });
    expect(d.volumes[1]).toMatchObject({ created: true, mountedAt: '22:36:32', fullAt: '22:42:28', fullBytes: 53686042830 });
    expect(d.volumes[3]).toMatchObject({ created: true, fullAt: '', fullBytes: null });
  });
  it('백업 항목 8개 — VM 폴더를 떼고(디스크 경로 안의 / 는 남긴다) 종류 구분', () => {
    expect(d.itemDir).toBe(VM);
    expect(d.items.length).toBe(8);
    expect(d.items.map((x) => x.kind)).toEqual(['config', 'config', 'config', 'other', 'disk', 'disk', 'disk', 'disk']);
    expect(d.items[4].name).toBe('[VPLEX-DS01] LESANXMPOB01/LESANXMPOB01.vmdk');
  });
  it('vSphere · CBT · 스냅샷 정리', () => {
    expect(d.vsphere).toBe('192.168.21.200');
    expect(d.cbt).toBe(true);
    expect(d.snapshotAt).toBe('22:54:47');
  });
  it('빈 로그 · 이상한 입력 — 못 읽음은 null·빈 배열', () => {
    const e = parseJobDetail(undefined);
    expect(e).toMatchObject({ tls: [], device: null, capacity: null, volumes: [], items: [], itemDir: '', vsphere: '', cbt: false, snapshotAt: '' });
    expect(parseJobDetail([`${D} 22:00:00 x-fd JobId 1: python3-fd-mod: Starting backup of /a/b/c`]).items).toEqual([{ path: '/a/b/c', name: 'c', kind: 'other' }]);
  });
});

describe('v2.828 타임라인', () => {
  const rep = parseJobReport(JOB13);
  const tl = jobTimeline(JOB13, rep.fields);
  it('대기 15분 46초 · 실행 25분 32초 · 구간 합 = 예약~종료', () => {
    expect(tl.waitSec).toBe(946);
    expect(tl.runSec).toBe(1532);
    expect(tl.segs.map((s) => s.k)).toEqual(['wait', 'prep', 'data', 'tail']);
    expect(tl.segs.reduce((a, s) => a + s.sec, 0)).toBe(946 + 1532);
    expect(tl.segs.find((s) => s.k === 'prep').sec).toBe(13);
  });
  it('단계 — 시각 순 · 예약·시작·FD 연결·vSphere·CBT·데이터·볼륨 3회·스냅샷·장치 해제·종료', () => {
    expect(tl.steps.map((s) => s.title)).toEqual([
      '예약', '시작', 'FD 연결', 'vSphere 접속', 'CBT 켬', '데이터 백업 시작',
      '볼륨 Full-0010 가득 참 → Full-0011', '볼륨 Full-0011 가득 참 → Full-0012', '볼륨 Full-0012 가득 참 → Full-0013',
      '임시 스냅샷 정리', '장치 해제', '종료',
    ]);
    for (let i = 1; i < tl.steps.length; i++) expect(tl.steps[i].sec).toBeGreaterThanOrEqual(tl.steps[i - 1].sec);
    expect(tl.steps.find((s) => s.title === '데이터 백업 시작').sub).toBe('항목 8개');
    expect(tl.steps.find((s) => s.title === 'FD 연결').sub).toBe('bareos-fd at localhost:9102 · TLS_CHACHA20_POLY1305_SHA256 TLSv1.3');
    expect(tl.steps.find((s) => /Full-0011 가득/.test(s.title)).sub).toBe('53.68 GB · 교체 3초');
    expect(tl.steps.at(-1)).toMatchObject({ at: '22:55:53', sub: 'Backup OK', tone: 'green' });
    expect(tl.steps[0]).toMatchObject({ at: '22:14:35', title: '예약' });
  });
  it('보고 없음(실행 중) — 예약·종료 없이 로그 단계만, 구간은 아는 것만', () => {
    const running = jobTimeline(JOB13.slice(0, 30), {});
    expect(running.steps[0].title).toBe('시작');
    expect(running.steps.some((s) => s.title === '종료' || s.title === '예약')).toBe(false);
    expect(running.waitSec).toBeNull();
    expect(running.segs.every((s) => s.sec > 0)).toBe(true);
  });
  it('오류는 단계로 — 최대 5개', () => {
    const errs = Array.from({ length: 8 }, (_, i) => `${D} 22:3${i}:00 bareos-sd JobId 9: Fatal error: disk ${i}`);
    expect(jobTimeline(errs, {}).steps.filter((s) => s.tone === 'err').length).toBe(5);
  });
  it('복원 시작 줄(JobId 없는 모양)도 시작으로', () => {
    const r = jobTimeline([`${D} 10:00:00 bareos-dir JobId 20: Start Restore Job RestoreFiles.2026-10-30_10.00.00_05`], {});
    expect(r.steps[0]).toMatchObject({ title: '시작', sub: 'Restore' });
  });
  it('빈 입력', () => {
    expect(jobTimeline(undefined, undefined)).toEqual({ steps: [], segs: [], waitSec: null, runSec: null });
  });
});

describe('v2.828 외부 입력 — 긴 줄도 선형', () => {
  it('5만 자 줄 400개를 0.5초 안에 — 줄 길이와 무관(줄마다 앞부분만 본다)', () => {
    // JSON 왕복으로 서버 응답과 같은 평평한 문자열을 만든다(+ 로 이은 문자열은 처음 자를 때 펼치는 비용이 들어가 우리 코드가 아니라 그것을 잰다 — 실측).
    const make = (len) => JSON.parse(JSON.stringify(Array.from({ length: 400 }, (_, i) => `${D} 22:30:${String(i % 60).padStart(2, '0')} ${'A'.repeat(len)}-fd JobId 1: ${'(Error '.repeat(len / 10)}`)));
    const run = (lines) => { const t0 = performance.now(); lines.map(classifyLogLine); parseJobDetail(lines); jobTimeline(lines, {}); return performance.now() - t0; };
    const long = run(make(50000));
    expect(long).toBeLessThan(500);
    expect(long).toBeLessThan(run(make(5000)) * 5 + 100);   // 10배 긴 줄이 10배 걸리지 않는다(줄마다 앞부분만 본다)
  });
});
