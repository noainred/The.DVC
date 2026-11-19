/**
 * serverinfo/profiles.js — 기능 ‘서버 정보’ 의 **읽기 묶음**(고정 명령 + 해석 · 순수 — 설계 docs/design/server-access §4.5 · ⑦ Reads · D3 기본 구성 + 디스크 · D5 sudo 없음).
 *
 * 규칙(설계 ‘읽기 묶음의 규칙’):
 *  · 명령은 **상수**다 — 이 모듈 밖의 값(서버 이름 · 마운트 · 사용자 입력)을 넣지 않는다(시험이 `${` · sudo 를 소스 스윕).
 *  · 멈출 수 있는 명령에는 안쪽 시한(timeout N) — **안쪽 시한 합 + 여유 ≤ exec 시한**(시험이 산수를 고정 · bmTop8bBudget 과 같은 규칙).
 *  · 구획마다 줄 수 · 글자 수 상한(head -n · cut -c) — 파서도 다시 자른다(linuxProc.splitSections 상한).
 *  · root 가 필요한 칸(DMI 시리얼 등)은 권한이 없으면 그 칸만 ‘못 읽음 · 권한’ — 나머지는 읽는다. 못 읽은 칸은 null(0 이 아니다 — 루트 CLAUDE.md).
 *  · Windows 는 OpenSSH Server 의 기본 셸(cmd 또는 PowerShell) 어디서든 같은 한 줄 — `powershell -EncodedCommand`(UTF-16LE base64).
 *    스크립트가 짧아 cmd 명령 줄 한도(8,191자) 안이다(시험이 길이를 고정) — 넘으면 압축 부트스트랩이 필요하다(지금은 쓰지 않는다).
 * ⚠ Windows 출력 형식은 실제 Windows 서버로 아직 확인하지 못했다(정직 기록 — 설계 README §7). 형식은 PowerShell 의 ConvertTo-Json 문서를 따랐다.
 */
import { splitSections } from '../bmusage/parse/linuxProc.js';
import { parseDisks } from '../focusmon/audit/parse.js';
import { numOrNull } from '../util/numOrNull.js';

/* ── Linux ─────────────────────────────────────────────────────────────── */

/** 구획 순서(명령이 이 순서로 내고 splitSections 가 이 순서로만 받는다 — 표지 위조 방어 v2.923). */
export const LINUX_SECTIONS = Object.freeze(['OSREL', 'KERNEL', 'HOST', 'DMI', 'CPU', 'MEM', 'DISKS', 'FS', 'END']);
/**
 * 안쪽 시한(초) — 바깥 프로그램(DNS 를 볼 수 있는 hostname · lscpu · lsblk · df)은 전부 `timeout N` 으로 감싼다(반증 F5 — hostname -f 와 lsblk 탐침이 맨몸이라 exec 시한을 넘었다).
 * 한 번에 도는 것의 합(hostname 은 -f 실패 시 한 번 더 · lsblk 는 탐침 + 둘 중 하나) + 여유 ≤ LINUX_EXEC_TIMEOUT_MS. 셸 내장 · /proc · /sys 읽기(grep · head · cut · printf)는 멈추지 않는다.
 */
export const LINUX_INNER_TIMEOUTS_S = Object.freeze({ hostname: 3, hostnameShort: 2, lscpu: 5, lsblkProbe: 3, lsblk: 5, lsblkFallback: 5, df: 6 });
export const LINUX_EXEC_TIMEOUT_MS = 35_000;
export const LINUX_SLACK_S = 5;
/** 한 번에 도는 안쪽 시한의 최악 합(초) — 시험이 이 값 + 여유 ≤ exec 시한을 고정한다. */
export const LINUX_INNER_WORST_S = LINUX_INNER_TIMEOUTS_S.hostname + LINUX_INNER_TIMEOUTS_S.hostnameShort + LINUX_INNER_TIMEOUTS_S.lscpu + LINUX_INNER_TIMEOUTS_S.lsblkProbe
  + Math.max(LINUX_INNER_TIMEOUTS_S.lsblk, LINUX_INNER_TIMEOUTS_S.lsblkFallback) + LINUX_INNER_TIMEOUTS_S.df;
const DMI_FIELDS = Object.freeze(['sys_vendor', 'product_name', 'product_serial', 'board_vendor', 'board_name', 'bios_vendor', 'bios_version']);

/** 셸 조각(상수 — POSIX sh). DMI 는 읽을 수 없으면(root 전용 칸) `이름=!perm`, 없으면 줄 없음. */
const LINUX_SHELL = [
  'export LC_ALL=C',
  "echo '##OSREL'; grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release 2>/dev/null | head -n 3 | cut -c1-160",
  "echo '##KERNEL'; uname -sr 2>/dev/null | head -n 1 | cut -c1-120",
  `echo '##HOST'; (timeout ${LINUX_INNER_TIMEOUTS_S.hostname} hostname -f 2>/dev/null || timeout ${LINUX_INNER_TIMEOUTS_S.hostnameShort} hostname 2>/dev/null) | head -n 1 | cut -c1-200`,
  `echo '##DMI'; for f in ${DMI_FIELDS.join(' ')}; do p=/sys/class/dmi/id/$f; if [ -r "$p" ]; then printf '%s=' "$f"; head -c 120 "$p" | tr -d '\\n\\r' | cut -c1-120; echo; elif [ -e "$p" ]; then echo "$f=!perm"; fi; done`,
  `echo '##CPU'; timeout ${LINUX_INNER_TIMEOUTS_S.lscpu} lscpu 2>/dev/null | grep -E '^(Architecture|CPU\\(s\\)|Model name|Socket\\(s\\)|Core\\(s\\) per socket|Thread\\(s\\) per core):' | head -n 8 | cut -c1-200`,
  "echo '##MEM'; grep -E '^(MemTotal|SwapTotal):' /proc/meminfo 2>/dev/null | head -n 2",
  // SERIAL 칸이 없는 옛 util-linux 면 SERIAL 없이 한 번 더(디스크 점검 묶음과 같은 방식 — focusmon/audit/bundle.js)
  `echo '##DISKS'; if timeout ${LINUX_INNER_TIMEOUTS_S.lsblkProbe} lsblk -d -n -o SERIAL >/dev/null 2>&1; then timeout ${LINUX_INNER_TIMEOUTS_S.lsblk} lsblk -d -n -b -P -o NAME,TYPE,MODEL,SERIAL,WWN,SIZE,ROTA,TRAN 2>/dev/null | head -n 256 | cut -c1-400; else timeout ${LINUX_INNER_TIMEOUTS_S.lsblkFallback} lsblk -d -n -b -P -o NAME,TYPE,MODEL,WWN,SIZE,ROTA,TRAN 2>/dev/null | head -n 256 | cut -c1-400; fi`,
  `echo '##FS'; timeout ${LINUX_INNER_TIMEOUTS_S.df} df -P -k -T -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | head -n 257 | cut -c1-400`,
  "echo '##END'",
];
export const LINUX_COMMAND = LINUX_SHELL.join('\n');

const kv = (lines, sep = '=') => {
  const o = Object.create(null);
  for (const l of lines) { const i = l.indexOf(sep); if (i > 0 && i < 64) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return o;
};
const unq = (s) => String(s ?? '').replace(/^"(.{0,200})"$/, '$1').slice(0, 200);
const clip = (s, n = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

/** 칸 하나 — 값 · 못 읽음(이유). */
const cell = (value, reason = '') => (value == null || value === '' ? { value: null, missing: true, reason: reason || 'unread' } : { value, missing: false });

/**
 * Linux 출력 → { base, disks, fs, truncated }.
 *  · base 칸마다 { value | missing + reason('permission' · 'absent' · 'unread') }
 *  · disks: [{ dev, model, serial, wwn, sizeBytes, media, tran }] — 못 읽으면 null(빈 배열이 아니다)
 *  · fs: [{ mount, type, sizeKB, usedKB, availKB, usePct }] — 못 읽으면 null
 */
export function parseLinux(text) {
  const sec = splitSections(String(text ?? '').slice(0, 512 * 1024), { order: LINUX_SECTIONS });
  const truncated = !Object.hasOwn(sec, 'END');
  const has = (k) => Array.isArray(sec[k]);
  const lines = (k) => (has(k) ? sec[k].filter((l) => l.trim() !== '') : []);
  const osr = kv(lines('OSREL'));
  const dmi = kv(lines('DMI'));
  const dmiCell = (f) => (dmi[f] === '!perm' ? cell(null, 'permission') : (has('DMI') ? cell(clip(dmi[f]), dmi[f] == null ? 'absent' : 'unread') : cell(null)));
  const cpu = kv(lines('CPU'), ':');
  const mem = kv(lines('MEM'), ':');
  const kb = (v) => { const m = /^(\d{1,15})\s*kB$/i.exec(String(v ?? '').trim()); return m ? Number(m[1]) * 1024 : null; };
  const sockets = numOrNull(cpu['Socket(s)']);
  const coresPer = numOrNull(cpu['Core(s) per socket']);
  const base = {
    os: cell(clip(unq(osr.PRETTY_NAME) || [unq(osr.ID), unq(osr.VERSION_ID)].filter(Boolean).join(' '))),
    kernel: cell(clip(lines('KERNEL')[0])),
    hostname: cell(clip(lines('HOST')[0], 200)),
    vendor: dmiCell('sys_vendor'),
    model: dmiCell('product_name'),
    serial: dmiCell('product_serial'),
    bios: dmi.bios_version === '!perm' ? cell(null, 'permission') : cell(clip([dmi.bios_vendor, dmi.bios_version].filter((x) => x && x !== '!perm').join(' '))),
    cpuModel: cell(clip(cpu['Model name'], 160)),
    cpuSockets: cell(sockets),
    cpuCores: cell(sockets != null && coresPer != null ? sockets * coresPer : null),
    cpuThreads: cell(numOrNull(cpu['CPU(s)'])),
    memBytes: cell(kb(mem.MemTotal)),
    swapBytes: cell(kb(mem.SwapTotal)),
  };
  // 디스크 · 파일시스템 — 구획이 와도 **읽은 흔적이 없으면 못 읽음**(null + 이유)이다: 안쪽 시한에 죽은 lsblk · df 는 빈 구획을 낸다(반증 F7 — ‘0개 · 읽음’ 으로 보였다).
  //   디스크가 하나도 없는 서버는 없다고 본다(블록 장치 0 은 읽기 실패) · df 는 머리줄(Filesystem)이 있어야 읽은 것이다.
  let disks = null;
  if (has('DISKS')) {
    disks = parseDisks(lines('DISKS')).map((d) => ({
      dev: d.dev, model: d.model, serial: d.sn || '', wwn: d.wwn || '', sizeBytes: numOrNull(d.size), media: d.media || '', tran: d.tran || '',
    }));
  }
  let fs = null;
  const fsLines = lines('FS');
  if (has('FS') && fsLines.length && /^Filesystem\s/.test(fsLines[0])) {
    fs = [];
    for (const l of fsLines.slice(1, 257)) {
      // Filesystem Type 1024-blocks Used Available Capacity Mounted-on — 마운트에 공백이 있을 수 있어 앞 6칸만 나눈다
      const m = /^(\S{1,200})\s+(\S{1,32})\s+(\d{1,18})\s+(\d{1,18})\s+(\d{1,18})\s+(\d{1,3})%\s+(\/.{0,300})$/.exec(l);
      if (!m) continue;
      fs.push({ source: clip(m[1], 120), type: clip(m[2], 32), sizeKB: Number(m[3]), usedKB: Number(m[4]), availKB: Number(m[5]), usePct: Number(m[6]), mount: clip(m[7], 300) });
    }
  }
  if (disks && !disks.length) disks = null;
  return { base, disks, fs, truncated, missing: { disks: disks == null, fs: fs == null } };
}

/* ── Windows(PowerShell — OpenSSH Server 로) ───────────────────────────── */

/**
 * PowerShell 스크립트(상수). 결과는 표지 줄 다음 JSON 한 줄.
 *  · 조회마다 시한(`-OperationTimeoutSec`) · 실패는 그 칸만 null + `err` 목록에 이름(반증 F7 — 거부가 ‘빈 목록 · 읽음’ 으로 보이지 않게) ·
 *    빈 목록은 `,@()` 로 배열 그대로(PowerShell 함수는 빈 배열을 $null 로 풀어 버린다) · 물리 디스크는 CIM(MSFT_PhysicalDisk — 시한을 걸 수 있다).
 *  · 조회 7개 × 시한 + 여유 ≤ WIN_EXEC_TIMEOUT_MS(시험).
 */
export const WIN_QUERY_TIMEOUT_S = 5;
export const WIN_QUERIES = 7;
export const WIN_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$o=[ordered]@{err=@()}',
  `$T=${WIN_QUERY_TIMEOUT_S}`,
  'function Q($n,[scriptblock]$s){ try { & $s } catch { $script:o.err += $n; $null } }',
  "$o.os=Q 'os' { $x=Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec $T; @{caption=$x.Caption;version=$x.Version;build=$x.BuildNumber;memKB=$x.TotalVisibleMemorySize} }",
  "$o.cs=Q 'cs' { $x=Get-CimInstance Win32_ComputerSystem -OperationTimeoutSec $T; @{maker=$x.Manufacturer;model=$x.Model;name=$x.DNSHostName;domain=$x.Domain;mem=$x.TotalPhysicalMemory} }",
  "$o.bios=Q 'bios' { $x=Get-CimInstance Win32_BIOS -OperationTimeoutSec $T; @{serial=$x.SerialNumber;version=$x.SMBIOSBIOSVersion;maker=$x.Manufacturer} }",
  "$o.cpu=Q 'cpu' { ,@(Get-CimInstance Win32_Processor -OperationTimeoutSec $T | Select-Object -First 16 Name,NumberOfCores,NumberOfLogicalProcessors) }",
  "$o.disk=Q 'disk' { ,@(Get-CimInstance Win32_DiskDrive -OperationTimeoutSec $T | Select-Object -First 64 Index,Model,SerialNumber,Size,MediaType,InterfaceType) }",
  "$o.pd=Q 'pd' { ,@(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_PhysicalDisk -OperationTimeoutSec $T | Select-Object -First 64 DeviceId,FriendlyName,MediaType,HealthStatus,BusType,Size) }",
  "$o.vol=Q 'vol' { ,@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -OperationTimeoutSec $T | Select-Object -First 64 DeviceID,FileSystem,Size,FreeSpace,VolumeName) }",
  "'##WINJSON'",
  '$o | ConvertTo-Json -Depth 4 -Compress',
].join('; ');
export const WIN_EXEC_TIMEOUT_MS = 40_000;
export const WIN_SLACK_S = 5;
/** UTF-16LE base64(-EncodedCommand). cmd · PowerShell 기본 셸 어디서든 같은 한 줄이다. */
export const WIN_COMMAND = `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64')}`;
/** cmd.exe 명령 줄 한도(8,191자) — 이 명령은 그 안이어야 한다(시험). */
export const CMD_LINE_MAX = 8191;

const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
// 열거값 → 글(MSFT_PhysicalDisk). Map 이라 장비가 보낸 ‘__proto__’ 같은 값이 객체를 꺼내지 않는다(반증 F9).
const MEDIA = new Map([[3, 'HDD'], [4, 'SSD'], [5, 'SCM'], ['3', 'HDD'], ['4', 'SSD'], ['5', 'SCM'], ['HDD', 'HDD'], ['SSD', 'SSD'], ['SCM', 'SCM']]);
const HEALTH = new Map([[0, 'Healthy'], [1, 'Warning'], [2, 'Unhealthy'], [5, 'Unknown']]);
const BUS = new Map([[1, 'SCSI'], [2, 'ATAPI'], [3, 'ATA'], [6, 'FC'], [7, 'USB'], [8, 'RAID'], [9, 'iSCSI'], [10, 'SAS'], [11, 'SATA'], [12, 'SD'], [13, 'MMC'], [15, 'Virtual'], [16, 'Storage Spaces'], [17, 'NVMe']]);
const enumText = (map, v) => { if (v == null || v === '') return ''; const n = Number(v); if (map.has(n)) return map.get(n); if (typeof v === 'string' && map.has(v)) return map.get(v); return typeof v === 'string' ? clip(v, 16) : ''; };

/** Windows 출력 → { base, disks, fs, truncated }(Linux 와 같은 모양). JSON 이 없거나 깨졌으면 전부 못 읽음 · 조회가 실패한 칸은 못 읽음(빈 목록이 아니다). */
export function parseWindows(text) {
  const s = String(text ?? '').slice(0, 512 * 1024);
  const i = s.indexOf('##WINJSON');
  let j = null;
  if (i >= 0) {
    const rest = s.slice(i + 9).trim();
    try { j = JSON.parse(rest.split(/\r?\n/)[0]); } catch { j = null; }
  }
  const truncated = !j || typeof j !== 'object' || Array.isArray(j);
  const o = truncated ? {} : j;
  const failed = new Set(arr(o.err).filter((x) => typeof x === 'string'));
  const ok = (k) => !truncated && !failed.has(k) && o[k] != null;
  const cpus = ok('cpu') ? arr(o.cpu).filter((c) => c && typeof c === 'object') : [];
  const sumOf = (k) => (cpus.length && cpus.every((c) => numOrNull(c[k]) != null) ? cpus.reduce((a, c) => a + Number(c[k]), 0) : null);
  const memKB = ok('os') ? numOrNull(o.os.memKB) : null;
  const osv = ok('os') ? o.os : {}; const csv = ok('cs') ? o.cs : {}; const bv = ok('bios') ? o.bios : {};
  const base = {
    os: cell(clip([osv.caption, osv.version ? `(${osv.version})` : ''].filter(Boolean).join(' '), 160)),
    kernel: cell(clip(osv.build ? `build ${osv.build}` : '')),
    hostname: cell(clip([csv.name, csv.domain].filter(Boolean).join('.'), 200)),
    vendor: cell(clip(csv.maker)),
    model: cell(clip(csv.model)),
    serial: cell(clip(bv.serial)),
    bios: cell(clip([bv.maker, bv.version].filter(Boolean).join(' '))),
    cpuModel: cell(clip(cpus[0]?.Name, 160)),
    cpuSockets: cell(cpus.length ? cpus.length : null),
    cpuCores: cell(sumOf('NumberOfCores')),
    cpuThreads: cell(sumOf('NumberOfLogicalProcessors')),
    memBytes: cell(memKB != null ? memKB * 1024 : numOrNull(csv.mem)),
    swapBytes: cell(null, 'absent'),
  };
  let disks = null;
  if (ok('disk')) {
    const pdById = new Map((ok('pd') ? arr(o.pd) : []).filter((p) => p && typeof p === 'object').map((p) => [String(p.DeviceId ?? ''), p]));
    disks = arr(o.disk).filter((d) => d && typeof d === 'object').slice(0, 64).map((d) => {
      const p = pdById.get(String(d.Index ?? '')) || null;
      return { dev: `Disk ${numOrNull(d.Index) ?? '?'}`, model: clip(d.Model), serial: clip(d.SerialNumber, 80), wwn: '', sizeBytes: numOrNull(d.Size),
        media: enumText(MEDIA, p?.MediaType), tran: enumText(BUS, p?.BusType) || clip(d.InterfaceType, 16), health: enumText(HEALTH, p?.HealthStatus) };
    });
    if (!disks.length) disks = null;   // 디스크 0 은 읽기 실패로 본다(Linux 와 같은 규칙)
  }
  let fs = null;
  if (ok('vol')) {
    fs = arr(o.vol).filter((v) => v && typeof v === 'object').slice(0, 64).map((v) => {
      const size = numOrNull(v.Size); const free = numOrNull(v.FreeSpace);
      const used = size != null && free != null ? size - free : null;
      return { source: clip(v.VolumeName, 120), type: clip(v.FileSystem, 32), mount: clip(v.DeviceID, 16),
        sizeKB: size != null ? Math.round(size / 1024) : null, usedKB: used != null ? Math.round(used / 1024) : null, availKB: free != null ? Math.round(free / 1024) : null,
        usePct: size && used != null ? Math.round((used / size) * 100) : null };   // 반증 F8: 남은 칸을 못 읽으면 0% 가 아니라 null
    });
  }
  return { base, disks, fs, truncated, failed: [...failed].slice(0, 8), missing: { disks: disks == null, fs: fs == null } };
}

/** WinRM(3단계)으로 돌릴 때 — 같은 스크립트를 PowerShell 프로그램 + 인자로(cmd 셸을 거치지 않는다 · WINRS_SKIP_CMD_SHELL). */
export const WIN_WINRM = Object.freeze({ command: 'powershell', args: Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64')]) });

/** readServer 에 넘기는 계획(OS 마다 고정 명령 하나 · Windows 는 SSH 한 줄과 WinRM 프로그램 + 인자 둘 다). */
export const SERVER_INFO_PLAN = Object.freeze({
  linux: Object.freeze({ command: LINUX_COMMAND, timeoutMs: LINUX_EXEC_TIMEOUT_MS }),
  windows: Object.freeze({ command: WIN_COMMAND, timeoutMs: WIN_EXEC_TIMEOUT_MS, winrm: WIN_WINRM }),
});
/** OS 별 해석. Linux 로 읽었는데 표지가 하나도 없고 cmd 오류 꼴이면 Windows 일 수 있다고 알린다(저절로 다른 OS 로 다시 읽지 않는다). */
export function parseFor(os, text, stderr = '') {
  if (os === 'windows') return parseWindows(text);
  const p = parseLinux(text);
  if (!text.includes('##OSREL') && /is not recognized as an internal or external command|'echo' is not|The term '.{1,40}' is not recognized/i.test(String(stderr) + String(text))) p.hint = 'maybe-windows';
  return p;
}
