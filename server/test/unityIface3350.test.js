/**
 * test/unityIface3350.test.js — v3.35.0 Unity SAN · NAS 인터페이스(속도 · 사용량 모니터링/트래킹 — 설계 docs/design/unity-iface).
 *  ① 속도 해석(글자 · REST enum) · 링크 용량은 SAN capBpsOf 와 같은 환산 · 사용률 = 큰 쪽 방향 ÷ 링크 속도(못 읽으면 null)
 *  ② uemcli 파서(/net/port/fc · /net/port/eth · /net/if — ⚠ 문서 예시 모양 · 실장비 미확인) · REST 파서(fcPort · ethernetPort · iscsiPortal · fileInterface)
 *  ③ 판정 하나(judgePort): 다운 ↔ 미연결(직전 업 여부) · 저하 ↔ 고정 · 포화 · 유휴 · 못 읽음은 따로
 *  ④ 변화 비교(diffPortStates): 처음 본 포트는 기준선 · 모름(null)은 변화가 아니다 · 업 → 다운 · 속도 변화 · lastUpAt
 *  ⑤ 엣지 정제(sanitizeEdgeIfaces · narrowStorageSnapshot 경로): 객체만 · 아는 필드만 · 상한 · 시각 자르기
 *  ⑥ 5분 표본: FC 쓰기 = in · 읽기 = out(bps) · 이더넷 kind 'eth' 는 부모 뒤 · SAN 스토리지 성능(unitsForArray)에서 빠진다
 *  ⑦ SSH 수집: 세 명령은 맨 뒤 lowPriority · 건너뜀/실패/형식 못 읽음/0개를 가른다
 *  ⑧ 알림(ifaceAlertsOf): 수집 실패 · 낡음은 장비 접두 보류 · 상태 표 모름은 다운 보류 · 사용률 못 읽음은 포화 보류
 *  ⑨ 비-admin 가림: 인터페이스 IP 와 CLI 원문 속 그 IP
 *  ⑩ DB: 상태 · 변화 적재(같은 스냅샷 두 번은 변화 0) → 칸 요약 · portRow
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과와 무관 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const tmp = tmpDir('unityiface3350-');
process.env.CONFIG_DIR = tmp;
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const MIN = 60_000; const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR + 17 * MIN;   // 정시 경계에서 떨어뜨려 고정(CLAUDE.md)
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

let F; let A; let AS; let SSH; let U; let S; let M; let E;
before(async () => {
  F = await import('../src/storage/ifaces.js');
  A = await import('../src/storage/collectors/arrayPerf.js');
  AS = await import('../src/sanswitch/arraySide.js');
  SSH = await import('../src/storage/collectors/unitySsh.js');
  U = await import('../src/storage/collectors/unity.js');
  S = await import('../src/storage/ifaceSummary.js');
  M = await import('../src/auth/addressMask.js');
  E = await import('../src/central/storageEdge.js');
});

const FC_TEXT = `1:    ID                 = spa_fc4
      Role               = Front-end
      SP                 = spa
      WWN                = 50:06:01:60:C7:E0:1C:4A:50:06:01:64:47:E0:1C:4A
      Speed              = 8 Gbps
      Requested speed    = auto
      Available speeds   = 4 Gbps, 8 Gbps, 16 Gbps, auto
      Health state       = OK (5)
      Health details     = "The port is operating normally."

2:    ID                 = spb_fc4
      Role               = Front-end
      SP                 = spb
      WWN                = 50:06:01:68:C7:E0:1C:4A:50:06:01:6C:47:E0:1C:4A
      Speed              =
      Requested speed    = 16 Gbps
      Available speeds   = 4 Gbps, 8 Gbps, 16 Gbps, auto
      Health state       = Degraded/Warning (10)
      Health details     = "The port link is down."
`;
const ETH_TEXT = `1:    ID                 = spa_eth2
      Role               = frontend
      SP                 = spa
      Protocols          = file, net, iscsi
      MTU size           = 9000
      Speed              = 1 Gbps
      Requested speed    = auto
      Supported speeds   = 1 Gbps, 10 Gbps, auto
      Health state       = OK (5)

2:    ID                 = spa_eth5
      SP                 = spa
      Speed              =
      Requested speed    = auto
      Supported speeds   = 10 Gbps, auto
      Health state       = Degraded/Warning (10)
      Health details     = "The SFP is not present."
`;
const IF_TEXT = `1:    ID                 = if_0
      Type               = iscsi
      NAS server         =
      Port               = spa_eth2
      VLAN ID            = 120
      IP address         = 10.20.30.41
      SP                 = spa

2:    ID                 = if_8
      Type               = file
      NAS server         = nas_1
      Port               = spa_eth3
      VLAN ID            = 0
      IP address         = 10.20.40.11
      Role               = production
`;

test('① 속도 해석 · 링크 용량 · 사용률', () => {
  assert.equal(F.speedTextGbps('16 Gbps'), 16);
  assert.equal(F.speedTextGbps('1000 Mbps'), 1);
  assert.equal(F.speedTextGbps('25G'), 25);
  assert.equal(F.speedTextGbps('auto'), null);
  assert.equal(F.speedTextGbps(''), null);
  assert.equal(F.speedTextGbps('0 Gbps'), null, '0 은 속도가 아니다(못 읽음)');
  assert.equal(F.speedTextGbps('x'.repeat(5000)), null, '긴 입력은 먼저 자른다');
  assert.equal(F.maxSpeedOfList('4 Gbps, 8 Gbps, 16 Gbps, auto'), 16);
  assert.equal(F.requestedOf('auto'), 'auto');
  assert.equal(F.requestedOf('16 Gbps'), 16);
  assert.equal(F.requestedOf(''), null);
  assert.equal(F.restSpeedGbps(16, 'fc'), 16);
  assert.equal(F.restSpeedGbps(10000, 'eth'), 10);
  assert.equal(F.restSpeedGbps(0, 'fc'), null);
  assert.equal(F.restRequested(0, 'eth'), 'auto');
  // SAN 포트 사용량의 capBpsOf('16G') 와 같은 환산(두 화면의 분모를 맞춘다)
  assert.equal(F.linkBytesPs(16), (16 * 1e9) / 8);
  assert.equal(F.utilPct(8e9, 2e9, 16), 50, '큰 쪽 방향 ÷ 링크');
  assert.equal(F.utilPct(null, 4e9, 16), 25, '한쪽만 읽히면 그쪽(최소값)');
  assert.equal(F.utilPct(null, null, 16), null);
  assert.equal(F.utilPct(1e9, 1e9, null), null, '속도를 모르면 null — 0 이 아니다');
});

test('② uemcli 파서 — FC · 이더넷 · 인터페이스', () => {
  const fc = F.parseUemcliFcPorts(FC_TEXT);
  assert.equal(fc.length, 2);
  assert.deepEqual([fc[0].id, fc[0].sp, fc[0].speedGbps, fc[0].requested, fc[0].maxGbps, fc[0].linkUp, fc[0].health], ['spa_fc4', 'spa', 8, 'auto', 16, true, 'ok']);
  assert.deepEqual([fc[1].linkUp, fc[1].speedGbps, fc[1].requested], [false, null, 16], '다운 포트는 속도 null · 요청 고정 16');
  const eth = F.parseUemcliEthPorts(ETH_TEXT);
  assert.deepEqual([eth[0].id, eth[0].speedGbps, eth[0].maxGbps, eth[0].mtu, eth[0].linkUp], ['spa_eth2', 1, 10, 9000, true]);
  assert.deepEqual([eth[1].linkUp, eth[1].sfp], [false, 'absent']);
  const ifs = F.parseUemcliIfs(IF_TEXT);
  assert.deepEqual(ifs.map((x) => [x.id, x.kind, x.port, x.vlan, x.ip]), [['if_0', 'iscsi', 'spa_eth2', 120, '10.20.30.41'], ['if_8', 'nas', 'spa_eth3', 0, '10.20.40.11']]);
  assert.equal(ifs[1].nasServer, 'nas_1');
  assert.deepEqual(F.parseUemcliFcPorts('아무 출력 없음'), []);
});

test('② REST 파서 — fcPort · ethernetPort · iscsiPortal · fileInterface', () => {
  const fc = F.restFcPorts({ entries: [{ content: { id: 'spa_fc4', currentSpeed: 16, requestedSpeed: 0, availableSpeeds: [4, 8, 16], health: { value: 5 }, storageProcessor: { id: 'spa' }, wwn: 'x' } },
    { content: { id: 'spb_fc4', requestedSpeed: 0, availableSpeeds: [8, 16], health: { value: 10, descriptions: ['The port link is down.'] } } }] });
  assert.deepEqual([fc[0].speedGbps, fc[0].requested, fc[0].maxGbps, fc[0].linkUp, fc[0].sp, fc[0].health], [16, 'auto', 16, true, 'spa', 'ok']);
  assert.deepEqual([fc[1].linkUp, fc[1].sp, fc[1].health], [false, 'spb', 'degraded']);
  const eth = F.restEthPorts({ entries: [{ content: { id: 'spa_eth2', speed: 10000, requestedSpeed: 0, supportedSpeeds: [1000, 10000], mtu: 1500, isLinkUp: true, health: { value: 5 } } },
    { content: { id: 'spa_eth4', isLinkUp: false, health: { value: 5 } } }] });
  assert.deepEqual([eth[0].speedGbps, eth[0].maxGbps, eth[0].linkUp], [10, 10, true]);
  assert.equal(eth[1].linkUp, false, 'isLinkUp 이 있으면 그 값이 이긴다');
  const isc = F.restIscsiIfs({ entries: [{ content: { id: 'if_1', ethernetPort: { id: 'spa_eth2' }, ipAddress: '10.0.0.5', vlanId: 7 } }, { content: { id: 'no_port' } }] });
  assert.deepEqual(isc.map((x) => [x.id, x.port, x.vlan]), [['if_1', 'spa_eth2', 7]]);
  const nas = F.restFileIfs({ entries: [{ content: { id: 'if_8', ipPort: { id: 'spa_eth3' }, nasServer: { id: 'nas_1', name: 'nas-prod' }, role: 1 } }] });
  assert.deepEqual([nas[0].nasServer, nas[0].role, nas[0].kind], ['nas-prod', 'backup', 'nas']);
  // applyUnityIfaces: 종류별 실패 사유를 probe 에 · 다른 종류는 그대로
  const ex = {};
  U.applyUnityIfaces(ex, { ifFc: { entries: [{ content: { id: 'spa_fc0', currentSpeed: 16, availableSpeeds: [16], requestedSpeed: 0, health: { value: 5 } } }] }, ifEthErr: '422 invalid field', ifIscsi: { entries: [] }, ifNas: { entries: [] } }, NOW);
  assert.equal(ex.ifaces.ports.length, 1);
  assert.equal(ex.ifaces.probe.fc.state, 'ok');
  assert.equal(ex.ifaces.probe.eth.state, 'failed');
  assert.match(ex.ifaces.probe.eth.detail, /422/);
  const none = {}; U.applyUnityIfaces(none, {}); assert.equal(none.ifaces, undefined, '조회 전 중단이면 싣지 않는다');
});

test('③ 판정 하나 — 다운/미연결 · 저하/고정 · 포화 · 유휴 · 못 읽음', () => {
  const up = { id: 'p', linkUp: true, speedGbps: 16, maxGbps: 16, requested: 'auto' };
  assert.equal(F.judgePort({ ...up, linkUp: false }, null, { lastUpAt: NOW - HOUR }).state, 'down');
  assert.equal(F.judgePort({ ...up, linkUp: false }, null, { lastUpAt: null }).state, 'unused', '처음부터 비어 있던 포트는 문제 아님');
  assert.equal(F.judgePort({ ...up, linkUp: false }, null, { lastUpAt: null }).issue, false);
  assert.equal(F.judgePort({ ...up, speedGbps: 8 }, null).state, 'slow');
  assert.equal(F.judgePort({ ...up, speedGbps: 8, requested: 8 }, null).state, 'ok', '사람이 고정한 속도는 저하가 아니다');
  assert.ok(F.isFixedBelowMax({ ...up, speedGbps: 8, requested: 8 }));
  assert.equal(F.judgePort(up, { peakPct: 85, samples: 10 }, { busyPct: 80 }).state, 'busy');
  assert.equal(F.judgePort(up, { peakPct: 0.3, samples: 10 }).state, 'idle');
  const r = F.judgePort(up, null);
  assert.deepEqual([r.state, r.unread, r.issue], ['ok', true, false], '처리량을 못 읽으면 unread 로 따로 — 정상 판정을 거짓으로 만들지 않는다');
  assert.equal(F.judgePort({ ...up, linkUp: null }, null).state, 'unknown');
});

test('④ 변화 비교 — 기준선 · 모름 · 업→다운 · 속도', () => {
  const t0 = NOW - 2 * HOUR; const t1 = NOW - HOUR;
  const a = F.diffPortStates(new Map(), [{ id: 'p1', linkUp: true, speedGbps: 16 }, { id: 'p2', linkUp: false }], t0);
  assert.deepEqual(a.changes, [], '처음 본 포트는 변화가 아니다');
  const prev = new Map(a.next.map((n) => [n.port, n]));
  assert.equal(prev.get('p1').lastUpAt, t0);
  assert.equal(prev.get('p2').lastUpAt, null);
  const b = F.diffPortStates(prev, [{ id: 'p1', linkUp: true, speedGbps: 8 }, { id: 'p2', linkUp: null }], t1);
  assert.deepEqual(b.changes, [{ port: 'p1', field: 'speed', before: '16 Gb', after: '8 Gb' }], '모름(null)은 변화가 아니다');
  const prev2 = new Map(b.next.map((n) => [n.port, n]));
  assert.equal(prev2.get('p2').linkUp, false, '모르면 직전 값을 지킨다');
  const c = F.diffPortStates(prev2, [{ id: 'p1', linkUp: false }], NOW);
  assert.deepEqual(c.changes, [{ port: 'p1', field: 'link', before: '8 Gb', after: 'down' }]);
  assert.equal(c.next[0].lastUpAt, t1, '다운이 되어도 마지막 업 시각은 남는다(다운 판정의 근거)');
});

test('⑤ 엣지 정제 — 객체만 · 아는 필드만 · 상한 · 시각', () => {
  const big = Array.from({ length: F.IFACE_PORT_MAX + 5 }, (_, i) => ({ id: `p${i}`, kind: 'fc', speedGbps: '16', evil: { x: 1 }, name: { a: 1 } }));
  const o = { extra: { ifaces: { at: NOW + 10 * HOUR, ports: [...big, null, 'x', { id: 'q', kind: 'weird' }], interfaces: [{ id: 'i1', port: 'p1', ip: 'a b\u0007c', vlan: 99999 }], probe: { fc: { state: 'hack', source: 1 } }, junk: 1 } } };
  F.sanitizeEdgeIfaces(o, NOW);
  const v = o.extra.ifaces;
  assert.equal(v.ports.length, F.IFACE_PORT_MAX);
  assert.ok(v.portsDropped >= 5);
  assert.equal(v.ports[0].speedGbps, 16, '문자열 수치는 수로');
  assert.equal(v.ports[0].evil, undefined, '모르는 필드는 담지 않는다');
  assert.equal(v.ports[0].name, 'p0', '객체 이름은 id 로');
  assert.equal(v.at, NOW, '엣지 시각은 수신 시각 이하로');
  assert.equal(v.interfaces[0].ip, 'abc');
  assert.equal(v.interfaces[0].vlan, null);
  assert.equal(v.probe.fc.state, 'failed');
  assert.equal(v.junk, undefined);
  const bad = { extra: { ifaces: 'x' } }; F.sanitizeEdgeIfaces(bad, NOW); assert.equal(bad.extra.ifaces, null);
  // 실제 수신 경로(narrowStorageSnapshot)를 거친다
  const { snap } = E.narrowStorageSnapshot({ deviceId: 'u1', extra: { ifaces: { ports: [{ id: 'a', kind: 'fc', x: 1 }] } } });
  assert.deepEqual(Object.keys(snap.extra.ifaces.ports[0]).includes('x'), false);
});

test('⑥ 5분 표본 — FC 쓰기 = in · 읽기 = out · 이더넷은 부모 뒤 · SAN 화면에서 빠진다', () => {
  const ent = (ts, values) => ({ ts, values });
  const r = (a, b) => A.unityCounterRate([ent(NOW, a), ent(NOW - 60_000, b)]);
  const rb = r({ spa: { spa_fc0: 600e6 } }, { spa: { spa_fc0: 0 } });   // 읽기 10 MB/s
  const wb = r({ spa: { spa_fc0: 300e6 } }, { spa: { spa_fc0: 0 } });   // 쓰기 5 MB/s
  const ein = r({ spa: { spa_eth2: 120e6 } }, { spa: { spa_eth2: 0 } });
  const eout = r({ spa: { spa_eth2: 60e6 } }, { spa: { spa_eth2: 0 } });
  const z = { perSp: {}, perPort: {}, intervalS: null };
  const { units } = A.unityUnits({ cpu: { spa: 10 }, rb, wb, rd: z, wr: z, ein, eout });
  const fc = units.find((u) => u.name === 'SPA FC0'); const eth = units.find((u) => u.name === 'SPA ETH2');
  assert.equal(fc.in, 5e6 * 8, '쓰기(어레이로 들어온 것) = in');
  assert.equal(fc.out, 10e6 * 8, '읽기(나간 것) = out');
  assert.equal(eth.kind, 'eth');
  assert.equal(eth.hbps, undefined, '이더넷은 hbps(FC 합)에 섞지 않는다');
  const s = A.buildFeSample({ ts: NOW, type: 'unity480', units });
  assert.equal(s.units[0].kind, 'sp', '부모가 먼저');
  const n = s.nodes.find((x) => x.id === s.units.find((u) => u.name === 'SPA ETH2').id);
  assert.equal(n.in, 2e6 * 8);
  const cat = AS.unitsForArray(s.units, {});
  assert.ok(!cat.some((u) => u.kind === 'eth'), 'SAN 스토리지 성능 단위 목록에 이더넷이 없다');
});

test('⑦ SSH — 세 명령은 맨 뒤 lowPriority · 사유를 가른다', () => {
  const tail = SSH.SPECS.slice(-3);
  assert.deepEqual(tail.map((x) => x.key), ['ifFc', 'ifEth', 'ifList']);
  assert.ok(tail.every((x) => x.lowPriority && !x.required && x.cmds.length === 1));
  const ex = {};
  SSH.applyUnitySshIfaces(ex, { out: { ifFc: FC_TEXT, ifEth: '1:    Foo = bar\n' }, skipped: ['ifList'], errors: {} }, NOW);
  assert.equal(ex.ifaces.probe.fc.state, 'ok');
  assert.equal(ex.ifaces.probe.fc.count, 2);
  assert.equal(ex.ifaces.probe.eth.state, 'unparsed', '레코드는 있는데 ID 를 못 읽음 = 형식 문제');
  assert.equal(ex.ifaces.probe.ifs.state, 'skipped');
  const ex2 = {}; SSH.applyUnitySshIfaces(ex2, { out: {}, skipped: [], errors: { ifFc: '권한 없음' } }, NOW);
  assert.equal(ex2.ifaces.probe.fc.state, 'failed');
  assert.match(ex2.ifaces.probe.fc.detail, /권한/);
});

test('⑧ 알림 — 보류 · 발생', () => {
  const rules = { unityIfaceDown: { enabled: true }, unityIfaceSlow: { enabled: true }, unityIfaceBusy: { enabled: true, threshold: 80 } };
  const dev = { id: 'u1', name: 'UNITY-1', type: 'unity480' };
  const port = (o) => ({ id: 'spa_fc0', kind: 'fc', linkUp: true, speedGbps: 16, maxGbps: 16, requested: 'auto', state: 'ok', flags: [], nowPct: null, lastUpAt: null, ...o });
  const view = (ports, extra = {}) => ({ ports, statesKnown: true, ...extra });
  const okSnap = { ok: true, collectedAt: NOW - MIN };
  // 수집 실패 → 장비 접두 보류
  let r = S.ifaceAlertsOf([{ device: dev, snap: { ok: false, collectedAt: NOW }, view: view([port()]) }], rules, { now: NOW });
  assert.deepEqual([r.alerts.length, r.heldPrefixes], [0, ['unityif:u1:']]);
  // 낡은 스냅샷 → 보류
  r = S.ifaceAlertsOf([{ device: dev, snap: { ok: true, collectedAt: NOW - 10 * HOUR }, view: view([port()]) }], rules, { now: NOW });
  assert.deepEqual(r.heldPrefixes, ['unityif:u1:']);
  // 다운 · 저하 · 포화 발생
  r = S.ifaceAlertsOf([{ device: dev, snap: okSnap, view: view([port({ state: 'down', linkUp: false, lastUpAt: NOW - HOUR }), port({ id: 'spa_fc1', speedGbps: 8, flags: ['slow'], state: 'slow', nowPct: 91 })]) }], rules, { now: NOW });
  assert.deepEqual(r.alerts.map((a) => a.key).sort(), ['unityif:u1:spa_fc0:down', 'unityif:u1:spa_fc1:busy', 'unityif:u1:spa_fc1:slow']);
  assert.equal(r.alerts.find((a) => a.key.endsWith(':down')).severity, 'critical');
  // 상태 표를 못 읽음 → 다운 보류(해소 금지) · 사용률 못 읽음 → 포화 보류
  r = S.ifaceAlertsOf([{ device: dev, snap: okSnap, view: view([port()], { statesKnown: false }) }], rules, { now: NOW });
  assert.ok(r.held.includes('unityif:u1:spa_fc0:down'));
  assert.ok(r.held.includes('unityif:u1:spa_fc0:busy'));
  assert.equal(r.alerts.length, 0);
  // 규칙이 다 꺼져 있으면 아무것도 하지 않는다
  r = S.ifaceAlertsOf([{ device: dev, snap: okSnap, view: view([port({ state: 'down' })]) }], {}, { now: NOW });
  assert.deepEqual([r.alerts.length, r.held.length, r.heldPrefixes.length], [0, 0, 0]);
});

test('⑨ 비-admin 가림 — 인터페이스 IP 와 CLI 원문 속 그 IP', () => {
  const snap = { deviceId: 'u1', host: '192.0.2.10', extra: {
    ifaces: { ports: [], interfaces: [{ id: 'if_0', port: 'spa_eth2', ip: '10.20.30.41' }] },
    cliRaw: [{ key: 'ifList', cmd: 'uemcli /net/if show -detail', ok: true, sample: 'IP address = 10.20.30.41\nPort = spa_eth2' }] } };
  const m = M.maskSnapAddress(snap);
  assert.equal(m.extra.ifaces.interfaces[0].ip, '');
  assert.ok(!m.extra.cliRaw[0].sample.includes('10.20.30.41'), 'CLI 원문에 새로 실린 데이터 IP 도 가린다');
  assert.ok(m.extra.cliRaw[0].sample.includes('spa_eth2'));
  assert.equal(snap.extra.ifaces.interfaces[0].ip, '10.20.30.41', '원본은 바꾸지 않는다');
});

test('⑩ DB — 상태 · 변화 적재 → 칸 요약 · portRow', { skip: !sqlite }, async () => {
  const db = await import('../src/storage/db.js');
  const snap = (t, fc1Speed, eth3Up) => ({ ok: true, type: 'unity480', deviceId: 'dev-u1', collectedAt: t,
    extra: { ifaces: F.buildIfaces({ at: t, ports: [
      { id: 'spa_fc1', kind: 'fc', linkUp: true, speedGbps: fc1Speed, maxGbps: 16, requested: 'auto' },
      { id: 'spb_eth3', kind: 'eth', linkUp: eth3Up, speedGbps: eth3Up ? 10 : null, maxGbps: 10, requested: 'auto' }] }) } });
  assert.equal((await db.saveIfaceState(snap(NOW - 3 * HOUR, 16, true))).changes, 0, '처음은 기준선');
  assert.equal((await db.saveIfaceState(snap(NOW - 3 * HOUR, 16, true))).changes, 0, '같은 스냅샷 재전송은 변화 0');
  assert.equal((await db.saveIfaceState(snap(NOW - 2 * HOUR, 8, false))).changes, 2);
  const ch = await db.ifaceChanges({ deviceId: 'dev-u1' });
  assert.deepEqual(ch.rows.map((r) => [r.port, r.field, r.before, r.after]).sort(), [['spa_fc1', 'speed', '16 Gb', '8 Gb'], ['spb_eth3', 'link', '10 Gb', 'down']]);
  const st = await db.ifaceStatesOf('dev-u1');
  assert.equal(st.get('spb_eth3').lastUpAt, NOW - 3 * HOUR);
  assert.equal((await db.saveIfaceState({ ok: true, type: 'isilon', deviceId: 'x', extra: { ifaces: { ports: [{ id: 'a' }] } } })).reason, 'no-ports', 'Unity 만');
  // 칸 요약 → portRow
  const from = NOW - 24 * HOUR;
  const rows = [{ node: 7, ts: from + 3 * HOUR, v: { in: 1e9, out: 2e9 }, mx: { in: 3e9, out: 12e9 }, n: { in: 12, out: 12 } },
    { node: 7, ts: from + 5 * HOUR, v: { in: 1e9, out: 1e9 }, mx: { in: 2e9, out: 2e9 }, n: { in: 12, out: 12 } }];
  const stat = S.bucketStats(rows, { from, bucketMs: HOUR }).get(7);
  assert.equal(stat.peakBps, 12e9);
  assert.equal(stat.peakAt, from + 3 * HOUR);
  assert.equal(stat.cells[3].outMax, 12e9);
  assert.equal(stat.cells[0].inMax, null, '값 없는 칸은 null(0 이 아니다)');
  const row = S.portRow({ id: 'spa_fc1', kind: 'fc', linkUp: true, speedGbps: 16, maxGbps: 16, requested: 'auto' }, { stat, last: { ts: NOW - MIN, in: 1e9, out: 4e9 }, state: st.get('spa_fc1'), now: NOW });
  assert.equal(row.peakPct, 75);
  assert.equal(row.nowPct, 25);
  assert.equal(row.readBps, 4e9, 'FC 읽기 = out');
  assert.equal(row.cells.length, S.IFACE_CELLS);
  const stale = S.portRow({ id: 'p', kind: 'fc', linkUp: true, speedGbps: 16 }, { last: { ts: NOW - 5 * HOUR, in: 1e9, out: 1e9 }, now: NOW });
  assert.deepEqual([stale.nowPct, stale.stale], [null, true], '오래된 표본은 최근 값으로 쓰지 않는다');
});

/* ── v3.36.1 사용자 신고 '사용량이 보이지 않음'(실제 현장 496 포트 전부 못 읽음) — 이유 판정 · 근거 · FC 대체 경로 ── */
test('v3.36.1 ⑪ 이유 판정(throughputWhyOf) — 짝 실패 · 포트 단위 없음 · 표본 실패가 빈 사유 · 틀린 문구로 새지 않는다', () => {
  const base = { ports: 10, method: 'api', db: true, units: 6, portUnits: 4, upPorts: 4, unmatched: 0, withData: 3 };
  assert.equal(S.throughputWhyOf(base), '');
  assert.equal(S.throughputWhyOf({ ...base, unmatched: 4, withData: 0 }), 'no-match', '예전에는 사유가 빈 글자였다');
  assert.equal(S.throughputWhyOf({ ...base, portUnits: 0, withData: 0 }), 'no-port-units', '예전에는 ‘아직 표본이 없습니다’ 로 틀리게 말했다');
  assert.equal(S.throughputWhyOf({ ...base, units: 0, portUnits: 0, withData: 0, diag: { ok: false } }), 'sample-failed');
  assert.equal(S.throughputWhyOf({ ...base, units: 0, portUnits: 0, withData: 0, diag: null }), 'no-samples');
  assert.equal(S.throughputWhyOf({ ...base, withData: 0 }), 'no-recent');
  // v3.46.0(사용자 요청 'SSH 장비도 사용량은 REST 로, 안 되면 SSH 로'): SSH 장비도 표본을 읽으므로 'ssh' 사유는 없어졌다.
  assert.equal(S.throughputWhyOf({ ...base, method: 'ssh' }), '', 'SSH 장비도 표본이 있으면 사유 없음');
  assert.equal(S.throughputWhyOf({ ...base, ports: 0, snapFailed: true }), 'collect-failed');
});

test('v3.36.1 ⑫ 표본 진단(sampleDiag) — 경로별 항목 수 · 오류를 상한으로 남긴다', async () => {
  const D = await import('../src/storage/sampleDiag.js');
  D._resetSampleDiagForTest();
  D.noteSampleDiag('u9', { at: NOW, ok: true, source: 'edge', sample: { units: [{ kind: 'sp' }, { kind: 'sp' }, { kind: 'port' }, { kind: { x: 1 } }],
    probe: { paths: { cpu: 4, readBytes: 0, ethIn: 'error', 'bad key!': 1 }, errors: ['ethIn: 422 x'.repeat(50)], fcPath: 'fePort' } } });
  const g = D.sampleDiagOf('u9');
  assert.deepEqual(g.kinds, { sp: 2, port: 1, unknown: 1 });
  assert.deepEqual(g.paths, { cpu: 4, readBytes: 0, ethIn: 'error' });
  assert.ok(g.errors[0].length <= 160);
  assert.equal(g.fcPath, 'fePort');
  assert.equal(D.sampleDiagOf('nope'), null);
});

test('v3.36.1 ⑬ FC 대체 경로 — target 이 비면 fePort 를 묻고 어느 쪽인지 probe.fcPath 로 밝힌다', async () => {
  const asked = [];
  const ent = (ts, values) => ({ content: { path: 'x', timestamp: new Date(ts).toISOString(), interval: 60, values } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url)); asked.push(u);
    let body = { entries: [] };
    if (u.includes('cpu.summary')) body = { entries: [ent(NOW, { spa: 10, spb: 20 })] };
    else if (u.includes('fibreChannel.fePort.*.readBytes')) body = { entries: [ent(NOW, { spa: { spa_iom_0_fc0: 600e6 } }), ent(NOW - 60_000, { spa: { spa_iom_0_fc0: 0 } })] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const s = await A.sampleUnity({ id: 'u1', type: 'unity480', host: '127.0.0.1', username: 'u', password: 'p' }, { now: NOW });
    assert.equal(s.probe.fcPath, 'fePort');
    assert.ok(asked.some((u) => u.includes('fibreChannel.target.*.readBytes')), '먼저 target');
    assert.ok(asked.some((u) => u.includes('fibreChannel.fePort.*.readBytes')), '비면 fePort');
    const port = s.units.find((u) => u.name === 'SPA IOM 0 FC0');
    assert.ok(port, 'fePort 값으로 포트 단위가 생긴다');
    assert.equal(S.unitIdByPort(s.units).get(F.portMatchKey('spa_iom_0_fc0')), port.id, '구성 포트 id 와 짝지어진다');
  } finally { globalThis.fetch = realFetch; }
});
