/**
 * 게스트 OS 네트워크 이슈 조사 — 게스트 안에서 인터페이스 드롭/에러 카운터를 읽는다.
 * Linux: /proc/net/dev, Windows: Get-NetAdapterStatistics(PowerShell). 누적 카운터를 반환하며,
 * 드롭/에러 '증가분(델타)'은 netIssueStore가 직전 스캔과 비교해 산출한다.
 */

import { runGuestScript } from '../gpu/guestops.js';

const LINUX_SCRIPT = 'cat /proc/net/dev 2>/dev/null';
const WIN_SCRIPT =
  '@echo off\r\npowershell -NoProfile -Command "try { Get-NetAdapterStatistics -ErrorAction Stop | ForEach-Object { ' +
  'Write-Output (\'N|\'+$_.Name+\'|\'+[int64]$_.ReceivedPacketErrors+\'|\'+[int64]$_.ReceivedDiscardedPackets+\'|\'+[int64]$_.OutboundPacketErrors+\'|\'+[int64]$_.OutboundDiscardedPackets+\'|\'+[int64]$_.ReceivedUnicastPackets+\'|\'+[int64]$_.SentUnicastPackets) } } catch { Write-Output \'NOACCESS\' }"\r\n';

/** 한 VM의 인터페이스 카운터 조사 → [{ iface, rxErr, rxDrop, txErr, txDrop, rxPkts, txPkts }]. */
export async function scanGuestNetCounters(c, vmMoref, creds, { isWindows = false, dlHosts = [] } = {}) {
  const r = await runGuestScript(c, vmMoref, creds, isWindows ? WIN_SCRIPT : LINUX_SCRIPT, { isWindows, dlHosts, timeoutMs: 20_000 });
  const out = r.stdout || '';
  const ifaces = [];
  if (isWindows) {
    for (const line of out.split(/\r?\n/)) {
      const m = /^N\|([^|]*)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)/.exec(line);
      if (!m) continue;
      ifaces.push({ iface: m[1], rxErr: +m[2], rxDrop: +m[3], txErr: +m[4], txDrop: +m[5], rxPkts: +m[6], txPkts: +m[7] });
    }
  } else {
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*([\w.@-]+):\s*(.+)$/.exec(line);
      if (!m || m[1] === 'lo') continue;
      const c2 = m[2].trim().split(/\s+/).map(Number);
      // rx: [0]bytes [1]packets [2]errs [3]drop ... tx: [8]bytes [9]packets [10]errs [11]drop
      if (c2.length < 12) continue;
      ifaces.push({ iface: m[1], rxPkts: c2[1], rxErr: c2[2], rxDrop: c2[3], txPkts: c2[9], txErr: c2[10], txDrop: c2[11] });
    }
  }
  return ifaces;
}
