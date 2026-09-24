/**
 * bmusage/parse/winPerf.js — Windows PowerShell 출력 파서(순수, v2.550).
 *
 * ⚠⚠ **정직 기록 — 이 현장 Windows 서버의 실제 출력을 본 적이 없다.** 아래 WMI/CIM 클래스는
 *   Microsoft 문서 기반이고 서버 버전·역할에 따라 **있는 것과 없는 것이 다르다**(특히 HBA).
 *   그래서 ① 스크립트가 항목마다 try/catch 로 감싸 **읽은 것만** 내보내고 ② 파서는 없는 키를
 *   `null` 로 두며 ③ 화면이 `read`/`missing` 목록을 **그대로 보여준다**(v2.522 `usedCmds` 규약).
 *   실장비 출력을 받으면 키를 좁히고 이 고지를 지울 것.
 *
 * ── 왜 KEY=VALUE 인가 ────────────────────────────────────────────────────────
 * `ConvertTo-Json` 은 PowerShell 버전에 따라 단일 원소를 배열로 접거나 펴고, BOM·줄바꿈이
 * 섞인다. 한 줄 `키=값` 은 그런 변형이 없다(v2.542 uemcli 에서 ` = ` 하나로 단순화한 것과 같은 판단).
 * 값 안의 `=` 는 **첫 `=` 로만 자른다**.
 *
 * Windows 는 `Win32_PerfFormattedData_*` 가 **이미 계산된 순간 퍼센트**를 주므로 누적 카운터
 * 델타가 필요 없다 — Linux 경로와 다른 점이고, 그래서 첫 주기부터 값이 나온다.
 */
const num = (v) => {
  /*
   * ⚠⚠ **빈 문자열을 먼저 걸러낸다** — `Number('') === 0` 이고 `Number.isFinite(0)` 이 참이라
   *   그냥 두면 **'모름' 이 0 으로 둔갑**한다(v2.525 `Number(null)===0` 규약의 변형).
   *   v2.550 초판이 실제로 그랬고 자체 테스트가 잡았다 — `DISK=D:|3|2000398934016|`(여유 공간 미상)이
   *   `usedPct: 100`(디스크 가득)으로 계산됐다. **오류 없이 틀린 값**이라 화면은 정상처럼 보인다.
   */
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** `키=값` 줄을 맵으로. 같은 키가 반복되면 배열로 모은다(디스크·NIC 여러 개). */
export function parseKv(text) {
  const map = Object.create(null);
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (!k) continue;
    if (map[k] === undefined) map[k] = v;
    else if (Array.isArray(map[k])) map[k].push(v);
    else map[k] = [map[k], v];
  }
  return map;
}

const arr = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]));

/**
 * 파싱 결과 → 우리 스냅샷 모양.
 * ⚠ 값이 없으면 **키를 만들지 않는다**(0 을 지어내지 않는다).
 */
export function parseWinPerf(text) {
  const kv = parseKv(text);
  const read = [];
  const missing = [];
  const mark = (name, ok) => { (ok ? read : missing).push(name); };

  const cpuPct = num(kv.CPU_PCT);
  mark('cpu', cpuPct != null);

  // 메모리 — Win32_OperatingSystem 은 **KB** 단위다(문서 명시).
  const memTotalKb = num(kv.MEM_TOTAL_KB);
  const memFreeKb = num(kv.MEM_FREE_KB);
  let mem = null;
  if (memTotalKb != null && memFreeKb != null && memTotalKb > 0) {
    const total = memTotalKb * 1024;
    const avail = memFreeKb * 1024;
    const used = Math.max(0, total - avail);
    mem = { totalBytes: total, availBytes: avail, usedBytes: used, usedPct: Math.round((used / total) * 1000) / 10, availSource: 'Win32_OperatingSystem.FreePhysicalMemory' };
  }
  mark('mem', !!mem);

  // 디스크 — `DISK=<이름>|<busyPct>|<totalBytes>|<freeBytes>` (없는 값은 빈 칸)
  const disks = [];
  let busyOutOfRange = 0;
  for (const row of arr(kv.DISK)) {
    const f = String(row).split('|').map((x) => x.trim());
    if (!f[0]) continue;
    const total = num(f[2]); const free = num(f[3]);
    /*
     * v2.605(COL2605-02): 사용률은 0~100 이어야 한다. 범위 밖(옛 스크립트의 PercentDiskTime 287 같은 값)은
     *   **null 로 비우고 개수를 밝힌다** — 100 으로 클램프하면 '포화' 라는 조용한 보정이다(v2.578 D3 규약).
     */
    let busyPct = num(f[1]);
    if (busyPct != null && (busyPct < 0 || busyPct > 100)) { busyPct = null; busyOutOfRange += 1; }
    disks.push({
      name: f[0],
      busyPct,
      totalBytes: total,
      freeBytes: free,
      // ⚠ 여유 공간을 모르면 사용률도 **모른다** — 100% 라고 말하면 '오류 없이 틀린 값' 이다.
      usedPct: (total != null && free != null && total > 0)
        ? Math.round(((total - free) / total) * 1000) / 10 : null,
    });
  }
  mark('disk', disks.length > 0);

  // NIC — `NIC=<이름>|<bytesTotalPerSec>|<currentBandwidthBits>|<bytesReceivedPerSec>|<bytesSentPerSec>`
  // v2.590 F9: 사용률은 방향별 max(수신, 송신) ÷ 링크 속도(전이중). 방향별 값이 없는 옛 형식(필드 3개)은 합계로 나누되
  // 그 사실을 `pctBasis:'total'` 로 밝힌다(최대 2배 과대일 수 있다).
  const nics = [];
  for (const row of arr(kv.NIC)) {
    const f = String(row).split('|').map((x) => x.trim());
    if (!f[0]) continue;
    const bps = num(f[1]);
    const bw = num(f[2]);
    const rx = num(f[3]); const tx = num(f[4]);
    const dir = rx != null && tx != null ? Math.max(rx, tx) : null;
    const basis = dir != null ? dir : bps;
    nics.push({
      iface: f[0], bytesPerSec: bps,
      bitsPerSec: bw != null && bw > 0 ? bw : null,          // 0 은 '모른다' 다(카운터 기본값)
      pct: (basis != null && bw != null && bw > 0) ? Math.min(100, Math.round(((basis * 8) / bw) * 1000) / 10) : null,
      pctBasis: dir != null ? 'direction' : 'total',
    });
  }
  mark('net', nics.length > 0);

  // HBA — `HBA=<이름>|<상태>|<속도bit>`. ⚠ Windows 에서 FC 처리량 카운터는 표준이 아니다
  //       (MSFC_* 는 속성만 주고 통계는 드라이버 의존) — 그래서 처리량은 담지 않는다.
  const hbas = [];
  for (const row of arr(kv.HBA)) {
    const f = String(row).split('|').map((x) => x.trim());
    if (!f[0]) continue;
    hbas.push({ host: f[0], state: f[1] || '', bitsPerSec: num(f[2]), txBytesPerSec: null, rxBytesPerSec: null, pct: null });
  }
  mark('hba', hbas.length > 0);

  return {
    osKind: 'windows',
    cpuPct, mem, disks, nics, hbas,
    busyOutOfRange,
    read, missing,
    hostname: String(kv.HOSTNAME || '').trim() || '',
    osName: String(kv.OS_NAME || '').trim() || '',
  };
}
