/**
 * idrac/biosKeys.js — 화면 · 내보내기에 보여 줄 BIOS/CMOS 설정 항목(나머지는 개수만 센다).
 * v2.973: idrac/redfish.js 에서 분리 — 엣지 축약 인벤토리(collector/compactInv.js)와 중앙 수신 정제(collector/remoteInventory.js)가
 *   **같은 목록**으로 bios.attributes 를 고른다(한쪽만 넓히면 중앙이 버린다 — v2.611 CEN2611-01 짝 규칙). 의존 없음.
 */
export const BIOS_KEYS = Object.freeze([
  'BootMode', 'SysProfile', 'SystemProfile', 'ProcVirtualization', 'LogicalProc',
  'ProcCores', 'SriovGlobalEnable', 'MemFrequency', 'MemOpMode', 'NodeInterleave',
  'IntegratedRaid', 'SecureBoot', 'TpmSecurity', 'ProcTurboMode', 'EmbSata',
  'InternalUsb', 'PowerManagement', 'SerialComm', 'OsWatchdogTimer',
]);
