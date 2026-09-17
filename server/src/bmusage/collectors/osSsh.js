/**
 * bmusage/collectors/osSsh.js — OS 에 SSH 로 붙어 CPU·메모리·디스크·네트워크·HBA 를 읽는다(v2.550).
 *
 * 사용자 선택: **Linux + Windows 둘 다**. 다섯 지표를 **모두** 주는 경로는 이것뿐이다
 * (iDRAC 텔레메트리는 CPU·MEM·IO 집계까지다).
 *
 * ── 왕복을 늘리지 않는다 ─────────────────────────────────────────────────────
 * Linux 는 **명령 1회**로 `/proc`·`/sys` 를 전부 받아 구획 표지로 쪼갠다. 200대 × 항목 7개를
 * 따로 물으면 왕복만 1,400회다. Windows 는 PowerShell 스크립트 1개를 **base64(-EncodedCommand)**
 * 로 보낸다 — 인용부호 이스케이프 사고가 구조적으로 없다(셸에 넘기는 문자가 base64 뿐이다).
 *
 * ── OS 판정은 캐시하고, 캐시가 틀리면 같은 세션에서 다시 시도한다 ──────────────
 * `bmstor` 등록부에는 OS 종류 필드가 없다. 그래서 첫 수집은 Linux 명령을 보내고 구획 표지가
 * 하나도 없으면 **같은 세션에서** Windows 스크립트를 시도한다(세션을 두 번 열지 않는다).
 * 결과는 호스트별로 기억해 다음 주기에 곧바로 맞는 쪽을 쓴다.
 *
 * ⚠ **누적 카운터를 여기서 비율로 바꾸지 않는다** — 원시 누적값(`counters`)을 함께 돌려주고
 *   `usage.js` 가 이전 표본과 비교한다. 첫 표본·리셋을 `null` 로 다루는 판정이 한 곳에 있어야 한다.
 * ⚠ 마운트 경로는 `bmstor/collect.js sanitizeMounts` 를 **반드시** 통과한 것만 명령에 넣는다
 *   (명령 주입 방어 — 그 함수가 단일 소스다).
 */
import { withSsh } from '../../proxy/sshExec.js';
import { sanitizeMounts, parseDfOutput } from '../../bmstor/collect.js';
import { splitSections, parseProcStat, parseMemInfo, parseDiskstats, parseNetDev, parseNetInfo, parseFcHosts, parseClkTck } from '../parse/linuxProc.js';
import { parseWinPerf } from '../parse/winPerf.js';

const READY_TIMEOUT_MS = Number(process.env.BMUSAGE_SSH_TIMEOUT_MS) || 15_000;
const CMD_TIMEOUT_MS = Number(process.env.BMUSAGE_CMD_TIMEOUT_MS) || 30_000;

/** 호스트별 OS 판정 캐시(인메모리 — 틀리면 그 주기에 스스로 고친다). */
const _osKind = new Map();
export function _resetOsKindForTest() { _osKind.clear(); }
export function osKindOf(host) { return _osKind.get(String(host || '').toLowerCase()) || ''; }

/** Linux 수집 명령 — 구획 표지로 나눈 한 방. */
export function linuxCommand(mounts = []) {
  const dfPart = mounts.length ? `df -P -k -- ${mounts.join(' ')} 2>/dev/null` : 'true';
  return [
    "echo '##STAT'", 'head -1 /proc/stat 2>/dev/null',
    "echo '##MEM'", 'cat /proc/meminfo 2>/dev/null',
    "echo '##DISK'", 'cat /proc/diskstats 2>/dev/null',
    "echo '##NET'", 'cat /proc/net/dev 2>/dev/null',
    "echo '##NETINFO'",
    // 인터페이스별 링크 속도(Mbit)와 상태. 속도를 못 읽으면 -1 → 파서가 null 로 다룬다.
    'for d in /sys/class/net/*; do n=`basename "$d"`; if [ "$n" = lo ]; then continue; fi; s=-1; if [ -r "$d/speed" ]; then s=`cat "$d/speed" 2>/dev/null || echo -1`; fi; st=`cat "$d/operstate" 2>/dev/null`; echo "$n $s $st"; done',
    "echo '##FC'",
    // FC HBA — 속도 원문에 공백이 있어 `|` 로 구분한다.
    'for d in /sys/class/fc_host/*; do if [ ! -d "$d" ]; then continue; fi; h=`basename "$d"`; ps=`cat "$d/port_state" 2>/dev/null`; sp=`cat "$d/speed" 2>/dev/null`; tx=`cat "$d/statistics/tx_words" 2>/dev/null`; rx=`cat "$d/statistics/rx_words" 2>/dev/null`; echo "$h|$ps|$sp|$tx|$rx"; done',
    "echo '##TICK'", 'getconf CLK_TCK 2>/dev/null',
    "echo '##DF'", dfPart,
    "echo '##HOST'", 'uname -srn 2>/dev/null',
  ].join('; ');
}

/**
 * Windows 수집 스크립트. ⚠⚠ **실장비 출력을 본 적이 없다**(정직 기록) — 항목마다 try/catch 라
 * 없는 클래스는 그 항목만 빠지고 나머지는 온다. 읽은 것/못 읽은 것은 파서가 `read`/`missing` 으로 낸다.
 */
export const WIN_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  '"HOSTNAME=" + $env:COMPUTERNAME',
  'try { "OS_NAME=" + (Get-CimInstance Win32_OperatingSystem).Caption } catch {}',
  "try { $c=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object {$_.Name -eq '_Total'}).PercentProcessorTime; if ($c -ne $null) { \"CPU_PCT=$c\" } } catch {}",
  'try { $o=Get-CimInstance Win32_OperatingSystem; "MEM_TOTAL_KB=" + $o.TotalVisibleMemorySize; "MEM_FREE_KB=" + $o.FreePhysicalMemory } catch {}',
  'try { $p=@{}; Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | ForEach-Object { $p[$_.Name]=$_.PercentDiskTime }; Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "DISK=" + $_.DeviceID + "|" + $p[$_.DeviceID] + "|" + $_.Size + "|" + $_.FreeSpace } } catch {}',
  "try { Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo|Pseudo' } | ForEach-Object { \"NIC=\" + $_.Name + \"|\" + $_.BytesTotalPersec + \"|\" + $_.CurrentBandwidth } } catch {}",
  "try { Get-CimInstance -Namespace 'root\\WMI' -ClassName MSFC_FibrePortHBAAttributes | ForEach-Object { \"HBA=\" + $_.InstanceName + \"|\" + $_.Attributes.PortState + \"|\" + $_.Attributes.PortSpeed } } catch {}",
].join('\n');

/** PowerShell `-EncodedCommand` 는 **UTF-16LE base64** 다(문서 규격). */
export function winCommand(script = WIN_PS) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
}

/** Linux 구획 출력 → 스냅샷 + 다음 주기용 누적값(순수 — 테스트 대상). */
export function shapeLinux(stdout, mounts = []) {
  const sec = splitSections(stdout);
  if (!Object.keys(sec).length) return null;              // 구획 표지 0개 = Linux 가 아니거나 셸이 다르다
  /*
   * ⚠⚠ **'없는 것' 과 '못 읽은 것' 을 같은 칸에 넣지 말 것**(v2.526 Unity `REMOVED` 규약과 같은 유형).
   *   FC HBA 가 아예 없는 서버를 `missing:['hba']` 로 세면 화면이 '확인 불가 1건' 이라 말해
   *   사용자가 멀쩡한 서버의 드라이버를 의심한다. 구획 표지는 **항상** 출력되므로 '구획은 왔는데
   *   내용이 0줄' 은 **구조적으로 없다**는 양성 증거다 → `absent`.
   *   ⚠ 그래도 '카드가 없다' 고 단정하지 않는다(드라이버 미로드일 수도 있다) — 화면 문구가
   *   'FC HBA 없음(또는 드라이버 미로드)' 두 가지를 함께 말한다.
   */
  const read = []; const missing = []; const absent = [];
  const mark = (n, ok) => { (ok ? read : missing).push(n); };
  const markPresence = (n, ok, sectionArrived) => {
    if (ok) read.push(n);
    else if (sectionArrived) absent.push(n);
    else missing.push(n);
  };

  const stat = parseProcStat(sec.STAT || []);
  mark('cpu', !!stat);
  const mem = parseMemInfo(sec.MEM || []);
  mark('mem', !!mem);
  const disks = parseDiskstats(sec.DISK || []);
  mark('diskio', !!disks);
  const nets = parseNetDev(sec.NET || []);
  mark('net', !!nets);
  const netInfo = parseNetInfo(sec.NETINFO || []);
  const fcs = parseFcHosts(sec.FC || []);
  markPresence('hba', !!fcs, Array.isArray(sec.FC));
  const df = parseDfOutput((sec.DF || []).join('\n'), mounts);
  // 마운트를 등록하지 않았으면 '못 읽은 것' 이 아니라 **요청하지 않은 것**이다.
  if (!mounts.length) absent.push('diskspace');
  else mark('diskspace', !!(df.mounts || []).length);
  const host = (sec.HOST || []).join(' ').trim();

  return {
    osKind: 'linux',
    hostname: host.split(/\s+/)[1] || '',
    osName: host || '',
    clkTck: parseClkTck(sec.TICK || []),
    // 마운트 사용량은 **순간값**이라 델타가 필요 없다.
    mounts: df.mounts || [], mountsMissing: df.missing || [],
    mem,
    // 누적값 — `usage.js` 가 이전 표본과 비교한다.
    counters: {
      cpu: stat,
      disks: disks || [],
      nets: (nets || []).map((n) => ({ ...n, bitsPerSec: netInfo[n.iface]?.bitsPerSec ?? null, state: netInfo[n.iface]?.state || '' })),
      hbas: fcs || [],
    },
    read, missing, absent,
  };
}

/**
 * 한 서버에서 수집한다. **자격증명은 반환값에 담지 않는다.**
 * @param {object} osHost  `bmstor` 등록 항목(host·port·username·password·mounts)
 * @param {{signal?:AbortSignal}} opt
 */
export async function collectOsUsage(osHost = {}, { signal } = {}) {
  const host = String(osHost.host || '').trim();
  if (!host) return { ok: false, error: 'OS host 가 없습니다.' };
  const { mounts } = sanitizeMounts(osHost.mounts);
  const hostKey = host.toLowerCase();
  const known = _osKind.get(hostKey) || '';

  try {
    return await withSsh({
      host, port: Number(osHost.port) || 22,
      username: String(osHost.username || 'root'),
      password: osHost.password || '', privateKey: osHost.privateKey || undefined,
      readyTimeout: READY_TIMEOUT_MS, signal,
    }, async ({ exec }) => {
      const tryLinux = async () => {
        // ⚠ `exec` 는 `(cmd, timeoutMs)` **위치 인자**다(`sshExec.js:87`). 객체를 넘기면
        //   `Math.max(1000, {…})` 이 **NaN** 이 되고 `setTimeout(fn, NaN)` 은 즉시 발화해
        //   **항상 즉시 타임아웃**된다(v2.550 자체 재검토에서 잡았다 — 목 데이터로는 드러나지 않는다).
        const r = await exec(linuxCommand(mounts), CMD_TIMEOUT_MS);
        const shaped = shapeLinux(r.stdout || '', mounts);
        return shaped ? { ...shaped, ok: true, stderr: (r.stderr || '').slice(0, 300) } : null;
      };
      const tryWin = async () => {
        const r = await exec(winCommand(), CMD_TIMEOUT_MS);
        const shaped = parseWinPerf(r.stdout || '');
        // ⚠ '출력이 비어 있지 않다' 를 '읽었다' 로 쓰지 않는다(v2.525 규약) — 실제로 읽은 항목이 있어야 한다.
        return shaped.read.length ? { ...shaped, ok: true, counters: null, mounts: [], mountsMissing: [], stderr: (r.stderr || '').slice(0, 300) } : null;
      };

      // 아는 쪽을 먼저, 실패하면 반대쪽을 **같은 세션에서** 한 번 더.
      const order = known === 'windows' ? [tryWin, tryLinux] : [tryLinux, tryWin];
      for (const fn of order) {
        const got = await fn().catch(() => null);
        if (got) { _osKind.set(hostKey, got.osKind); return got; }
      }
      return { ok: false, error: 'Linux(/proc)·Windows(PowerShell) 어느 형식으로도 읽지 못했습니다 — 셸이 제한적일 수 있습니다.' };
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}
