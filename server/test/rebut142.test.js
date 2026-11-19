/**
 * 142회차(136회차 반증 — WinRM WS-Man 읽기 · 서버 정보 Windows 해석) 회귀.
 *  ① winrm/wsman.js — 태그 안 칸을 `[^>]{0,N}` 으로 읽으면 ‘<Stream <Stream …’ 처럼 시작점이 조밀한 응답에서 시작점마다 창(300 · 400 · 200자)을 다시 훑었다
 *     (136 수정 뒤에도 Stream · ShellId · CommandId · ExitCode · CommandState · Fault Text/Message · WSManFault — 640KB 응답 하나 28~100ms, 정상 응답의 3.3~12.8배).
 *     `[^<>]`(다음 ‘<’ 에서 멈춤 — XML 속성 값에는 ‘<’ 가 올 수 없다) + WSManFault 는 태그 시작에 묶었다. 같은 크기 정상 응답과의 **비율**로 고정(루트 CLAUDE.md — ReDoS 회귀는 비율로).
 *  ② 정상 응답은 예전과 같이 읽는다(접두 · 여러 줄 속성 · 자기 닫힘 WSManFault · xmlns 가 앞선 Code).
 *  ③ serverinfo/profiles.js parseWindows — Windows PowerShell 5.1 의 ConvertTo-Json 이 [psobject] 로 감싼 배열을 {"value":[...],"Count":n} 으로 내는 꼴을
 *     배열과 같은 결과로 읽는다(136 E1 · 결정 → 방어 구현 — 실기 미확인). 꼴이 정확할 때만 푼다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const WS = await import('../src/winrm/wsman.js');
const P = await import('../src/serverinfo/profiles.js');

test('① WS-Man 읽기 — 시작점이 조밀한 640KB 응답도 같은 크기 정상 응답보다 크게 느리지 않다(창을 다시 훑지 않음)', () => {
  const N = 640 * 1024;
  const fill = (unit) => unit.repeat(Math.floor(N / unit.length));
  const benign = `<rsp:Stream Name="stdout" CommandId="x">${'QUFB'.repeat(Math.floor((N - 60) / 4))}</rsp:Stream>`;
  const shapes = {
    'Stream 조밀': () => WS.parseReceive(fill('<Stream ')),
    'rsp:Stream 조밀': () => WS.parseReceive(fill('<rsp:Stream ')),
    'CommandState 조밀': () => WS.parseReceive(fill('<CommandState ')),
    'ExitCode 조밀(Done 뒤)': () => WS.parseReceive(`<rsp:CommandState State="http://x/CommandState/Done">${fill('<ExitCode ')}`),
    'ShellId 조밀': () => { try { WS.parseShellId(fill('<ShellId ')); } catch { /* ShellId 없음 */ } },
    'CommandId 조밀': () => { try { WS.parseCommandId(fill('<CommandId ')); } catch { /* CommandId 없음 */ } },
    'Fault Text 조밀': () => WS.faultReason(`<s:Fault>${fill('<Text ')}`),
    'Fault Message 조밀': () => WS.faultReason(`<s:Fault>${fill('<Message ')}`),
    'WSManFault 조밀': () => WS.faultReason(`<s:Fault>${fill('WSManFault')}`),
  };
  const time = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  // 정상 · 공격 모양을 번갈아 5회 재고 각각 최솟값(같은 시점의 부하를 함께 받게 — docs/rules/common.md 비율 시험 규칙)
  // WSManFault 는 창이 200자라 정상 Receive(base64 풀기 포함) 대비로는 차이가 작다(되돌리면 약 3배) — 같은 크기 정상 Fault 응답과 따로 견준다(되돌리면 약 20배)
  const benignFault = `<s:Fault><s:Reason><s:Text>${'a'.repeat(N - 60)}</s:Text></s:Reason></s:Fault>`;
  let base = Infinity; let baseFault = Infinity; const best = Object.fromEntries(Object.keys(shapes).map((k) => [k, Infinity]));
  for (let i = 0; i < 5; i += 1) {
    base = Math.min(base, time(() => WS.parseReceive(benign)));
    baseFault = Math.min(baseFault, time(() => WS.faultReason(benignFault)));
    for (const [k, fn] of Object.entries(shapes)) best[k] = Math.min(best[k], time(fn));
  }
  base = Math.max(base, 1);
  for (const [k, ms] of Object.entries(best)) {
    assert.ok(ms / base < 2.5, `${k}: 정상 ${base.toFixed(1)}ms 대비 ${ms.toFixed(1)}ms(×${(ms / base).toFixed(1)}) — 시작점마다 창을 다시 훑는다`);
  }
  baseFault = Math.max(baseFault, 2);
  const wsf = best['WSManFault 조밀'];
  assert.ok(wsf / baseFault < 4, `WSManFault 조밀: 정상 Fault ${baseFault.toFixed(1)}ms 대비 ${wsf.toFixed(1)}ms(×${(wsf / baseFault).toFixed(1)}) — 시작점마다 창을 다시 훑는다`);
});

test('② 정상 응답은 예전과 같이 읽는다 — 접두 · 여러 줄 속성 · 자기 닫힘 WSManFault · xmlns 가 앞선 Code', () => {
  const r = WS.parseReceive('<rsp:ReceiveResponse><rsp:Stream\n  Name="stdout"\tCommandId="AB-1">aGk=</rsp:Stream><p:Stream End="true" Name="stderr" CommandId="AB-1">ZQ==</p:Stream>'
    + '<rsp:Stream Name="stdout" CommandId="AB-1" End="true"></rsp:Stream>'
    + '<rsp:CommandState CommandId="AB-1"\n State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"><rsp:ExitCode>3</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>');
  assert.equal(Buffer.concat(r.stdout).toString(), 'hi'); assert.equal(Buffer.concat(r.stderr).toString(), 'e');
  assert.equal(r.done, true); assert.equal(r.exitCode, 3);
  assert.equal(WS.parseShellId('<rsp:Shell><rsp:ShellId xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">11111111-2222-3333-4444-555555555555</rsp:ShellId></rsp:Shell>'), '11111111-2222-3333-4444-555555555555');
  assert.equal(WS.parseCommandId('<rsp:CommandResponse><rsp:CommandId>AAAAAAAA-BBBB</rsp:CommandId></rsp:CommandResponse>'), 'AAAAAAAA-BBBB');
  const fault = '<s:Fault><s:Code><s:Value>s:Receiver</s:Value><s:Subcode><s:Value>w:TimedOut</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en-US">The WS-Management service cannot complete the operation within the time specified in OperationTimeout.</s:Text></s:Reason>'
    + '<s:Detail><f:WSManFault xmlns:f="http://schemas.microsoft.com/wbem/wsman/1/wsmanfault" Code="2150858793" Machine="file01"><f:Message>timed out</f:Message></f:WSManFault></s:Detail></s:Fault>';
  assert.match(WS.faultReason(fault), /^The WS-Management service cannot complete .* \(WSMan 2150858793\)$/);
  assert.equal(WS.isReceiveTimeout(fault), true);
  assert.match(WS.faultReason('<s:Fault><s:Text>Access is denied.</s:Text><f:WSManFault Code="5"/></s:Fault>'), /Access is denied\. \(WSMan 5\)/);
  assert.match(WS.faultReason('<s:Fault><Message>m</Message><WSManFault\n Code="7"></WSManFault></s:Fault>'), /^m \(WSMan 7\)$/);
});

test('③ parseWindows — PowerShell 5.1 의 {"value":[...],"Count":n} 꼴도 배열과 같은 결과 · 꼴이 정확할 때만 푼다', () => {
  const plain = {
    err: [], os: { caption: 'Microsoft Windows Server 2019 Standard', version: '10.0.17763', build: '17763', memKB: 134217728 }, cs: { maker: '가상제조', model: 'GX-2', name: 'kr-app-02', domain: 'corp.example' },
    bios: { serial: 'VSN2', version: '1.0', maker: '가상' },
    cpu: [{ Name: '가상 CPU A', NumberOfCores: 12, NumberOfLogicalProcessors: 24 }, { Name: '가상 CPU A', NumberOfCores: 12, NumberOfLogicalProcessors: 24 }],
    disk: [{ Index: 0, Model: '가상 SSD', SerialNumber: 'S0', Size: 480103981056, InterfaceType: 'SCSI' }, { Index: 1, Model: '가상 HDD', SerialNumber: 'S1', Size: 4000787030016, InterfaceType: 'SCSI' }],
    pd: [{ DeviceId: '0', MediaType: 4, HealthStatus: 0, BusType: 10 }, { DeviceId: '1', MediaType: 3, HealthStatus: 1, BusType: 11 }],
    vol: [{ DeviceID: 'C:', FileSystem: 'NTFS', Size: 214748364800, FreeSpace: 53687091200, VolumeName: 'OS' }, { DeviceID: 'D:', FileSystem: 'ReFS', Size: 1000, FreeSpace: 250, VolumeName: 'DATA' }],
  };
  const wrap = (a) => ({ value: a, Count: a.length });
  const ps51 = { ...plain, err: wrap([]), cpu: wrap(plain.cpu), disk: wrap(plain.disk), pd: wrap(plain.pd), vol: wrap(plain.vol) };
  const a = P.parseWindows(`##WINJSON\r\n${JSON.stringify(plain)}\r\n`);
  const b = P.parseWindows(`##WINJSON\r\n${JSON.stringify(ps51)}\r\n`);
  assert.deepEqual(b, a);
  assert.equal(b.base.cpuSockets.value, 2); assert.equal(b.base.cpuCores.value, 24); assert.equal(b.base.cpuThreads.value, 48);
  assert.deepEqual(b.disks.map((d) => [d.dev, d.media, d.health]), [['Disk 0', 'SSD', 'Healthy'], ['Disk 1', 'HDD', 'Warning']]);
  assert.deepEqual(b.fs.map((f) => [f.mount, f.usePct]), [['C:', 75], ['D:', 75]]);
  // 실패 목록도 감싼 꼴로 올 수 있다 — 그 칸은 못 읽음(빈 목록 · 읽음이 아니다)
  const failed = P.parseWindows(`##WINJSON\n${JSON.stringify({ ...ps51, err: wrap(['vol']), vol: wrap([]) })}`);
  assert.equal(failed.fs, null); assert.deepEqual(failed.failed, ['vol']);
  // 감싼 빈 디스크 목록은 읽기 실패(Linux 와 같은 규칙)
  assert.equal(P.parseWindows(`##WINJSON\n${JSON.stringify({ ...ps51, disk: wrap([]) })}`).disks, null);
  // 꼴이 정확하지 않으면 풀지 않는다(Count 불일치 · 다른 칸이 더 있음) — CPU 로 읽히지 않는다(코어 못 읽음)
  for (const odd of [{ value: plain.cpu, Count: 3 }, { value: plain.cpu, Count: 2, Name: 'x' }]) {
    const p = P.parseWindows(`##WINJSON\n${JSON.stringify({ ...plain, cpu: odd })}`);
    assert.equal(p.base.cpuCores.value, null, JSON.stringify(odd).slice(0, 60));
  }
});
