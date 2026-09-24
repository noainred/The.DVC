// v2.605 감사 그룹 c — 수집기 정확성.
//   COL2605-01 가상 NIC 가짜 속도 · COL2605-02 Windows 디스크 I/O 범위 · COL2605-03 vGPU 표본 없음 ≠ 0 ·
//   COL2605-04 iDRAC Sensors ioPct · COL2605-05 흡기 0℃ Unknown · TIM2605-02 REST 수집기 signal ·
//   TIM2605-04 시한 env 정규화 · RECENT2605-03 Isilon 정확/반올림 혼재 · RECENT2605-04 PowerMax 빈 SRP ·
//   LEFT2605-03 parseJsonLoose O(n) + 옛 구현과 결과 동일성(결정적 난수 대조).
//   ⚠ 픽스처는 전부 합성값이다(공개 저장소 — v2.513 규약). 기준 시각에 Date.now() 를 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2605c-'));
process.env.CONFIG_DIR = TMP;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.DATA_SOURCE = 'live';
// 모듈 로드 시점에 읽히는 env — import 전에 둔다.
process.env.STORAGE_HTTP_TIMEOUT_MS = '4000';
process.env.BMUSAGE_SESSION_BUDGET_MS = '3000000000';   // TIM2605-04 재현값(2^31 초과)

const SRC = path.resolve(import.meta.dirname, '../src');
const bare = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const PiB = 1024 ** 5;
const T0 = 1_000_000_000_000;   // 고정 기준 시각

// ── COL2605-01 ────────────────────────────────────────────────────────────────
const linuxOut = (rx1, rx2, fourth = true) => `##STAT\ncpu 100 0 100 1000 0 0 0 0 0 0\n##MEM\nMemTotal: 1000 kB\nMemAvailable: 500 kB\n##DISK\n##NET\nInter-|\n face |\n  eth0: ${rx1} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n  tap7: ${rx2} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n##NETINFO\neth0 10000 up${fourth ? ' 1' : ''}\ntap7 10 unknown${fourth ? ' 0' : ''}\n##FC\n##TICK\n100\n##DF\n##HOST\nLinux h 5\n`;

test('COL2605-01: 가상 인터페이스(tap/tun)의 고정 속도로 네트워크 사용률(%)을 내지 않는다 — 처리량만', async () => {
  const { shapeLinux, linuxCommand } = await import('../src/bmusage/collectors/osSsh.js');
  const { buildUsage } = await import('../src/bmusage/usage.js');
  // 명령이 물리 여부(넷째 필드)를 싣는다
  assert.match(linuxCommand(), /\$d\/device/);
  assert.match(linuxCommand(), /\$d\/bonding/);
  const a = shapeLinux(linuxOut(0, 0)); const b = shapeLinux(linuxOut(60_000_000, 30_000_000));
  const u = buildUsage({ target: { key: 'k' }, os: { ...b, ok: true }, prev: { counters: a.counters, at: T0 }, now: T0 + 60_000 });
  // 예전: tap7(speed 10) 30MB/60s = 4Mbit/10Mbit = 40% → net_pct 40(거짓 '포화' 쪽). 물리 eth0 은 0.1%.
  assert.equal(u.row.net_pct, 0.1);
  const tap = u.detail.interfaces.find((x) => x.iface === 'tap7');
  assert.equal(tap.pct, null);
  assert.equal(tap.virtual, true);
  assert.ok(tap.bps > 0, '처리량은 그대로 낸다');
  assert.ok(u.notes.some((n2) => /가상 인터페이스.*1개/.test(n2)), JSON.stringify(u.notes));
  assert.ok(!u.notes.some((n2) => /링크 속도를 읽지 못한/.test(n2)), '가상 인터페이스를 "속도를 못 읽음" 으로 말하지 않는다');
  // 넷째 필드가 없는 옛 출력은 판정 근거가 없으므로 예전처럼(속도를 믿는다)
  const a2 = shapeLinux(linuxOut(0, 0, false)); const b2 = shapeLinux(linuxOut(60_000_000, 30_000_000, false));
  const u2 = buildUsage({ target: { key: 'k' }, os: { ...b2, ok: true }, prev: { counters: a2.counters, at: T0 }, now: T0 + 60_000 });
  assert.equal(u2.row.net_pct, 40);
});

// ── COL2605-02 ────────────────────────────────────────────────────────────────
test('COL2605-02: Windows 디스크 I/O 는 100 − PercentIdleTime 이고 0~100 밖은 null + 개수', async () => {
  const { WIN_PS } = await import('../src/bmusage/collectors/osSsh.js');
  const { parseWinPerf } = await import('../src/bmusage/parse/winPerf.js');
  const { buildUsage } = await import('../src/bmusage/usage.js');
  assert.match(WIN_PS, /PercentIdleTime/);
  assert.doesNotMatch(WIN_PS, /PercentDiskTime/);
  const w = parseWinPerf('HOSTNAME=x\nCPU_PCT=5\nDISK=C:|287|1000|500\nDISK=D:|42|1000|500\n');
  assert.equal(w.disks[0].busyPct, null);          // 예전: 287
  assert.equal(w.disks[1].busyPct, 42);
  assert.equal(w.busyOutOfRange, 1);
  const u = buildUsage({ target: { key: 'k' }, os: { ...w, ok: true, osKind: 'windows' }, now: T0 });
  assert.equal(u.row.disk_busy_pct, 42);           // 예전: 287(차트 y축 밖 · 임계 판정에 그대로)
  assert.ok(u.notes.some((n2) => /범위를 벗어나 비웠습니다/.test(n2)), JSON.stringify(u.notes));
});

// ── COL2605-03 ────────────────────────────────────────────────────────────────
test('COL2605-03: vGPU 사용률 — 표본이 없는 호스트를 0%(유휴)로 기록하지 않는다', () => {
  const s = bare('vcenter/soapClient.js');
  assert.doesNotMatch(s, /pct:\s*map\.get\(ref\)\s*\?\?\s*0/, "예전: map.get(ref) ?? 0 — 표본 없음·-1·연결 끊김이 0%");
  assert.match(s, /pct:\s*got\s*\?\s*map\.get\(ref\)\s*:\s*null/);
  assert.match(s, /e\.pct != null && \(host\.gpus/, '미수집(null)을 호스트에 0 으로 적용하지 않는다');
});

// ── COL2605-04 ────────────────────────────────────────────────────────────────
test('COL2605-04: Sensors 이름 → 필드 — SystemBoardIOUsage 는 ioPct(sysPct 가 아니다)', async () => {
  const { sensorFieldOf } = await import('../src/idrac/redfish.js');
  assert.equal(typeof sensorFieldOf, 'function');
  assert.equal(sensorFieldOf('SystemBoardCPUUsage'), 'cpuPct');
  assert.equal(sensorFieldOf('SystemBoardIOUsage'), 'ioPct');
  assert.equal(sensorFieldOf('iDRAC.Embedded.1_SystemBoardIOUsage'), 'ioPct');
  assert.equal(sensorFieldOf('SystemBoardMEMUsage'), 'memPct');
  assert.equal(sensorFieldOf('SystemBoardSYSUsage'), 'sysPct');
  assert.equal(sensorFieldOf('CPU1 Temp'), null);
  // 탐색 루프는 이 함수 하나로 필드를 정한다(예전 루프는 이미 찾은 필드의 두 번째 이름을 sys 로 흘렸다)
  assert.match(bare('idrac/redfish.js'), /const field = sensorFieldOf\(name\);/);
});

// ── COL2605-05 ────────────────────────────────────────────────────────────────
test('COL2605-05: 판독 0 + healthState unknown 흡기 센서를 0℃ 로 채택하지 않는다', async () => {
  const { parseTemps } = await import('../src/vcenter/soapClient.js');
  const sensor = (name, reading, mod, key) => `<HostNumericSensorInfo xsi:type="HostNumericSensorInfo"><name>${name}</name><healthState><label>${key}</label><summary>x</summary><key>${key}</key></healthState><currentReading>${reading}</currentReading><unitModifier>${mod}</unitModifier><baseUnits>Degrees C</baseUnits><sensorType>temperature</sensorType></HostNumericSensorInfo>`;
  const xml = sensor('System Board 1 Inlet Temp', 0, 0, 'unknown') + sensor('Processor 1 CPU Temp', 5400, -2, 'green');
  const r = parseTemps(xml);
  assert.equal(r.tempC, 54);          // 예전: 0(흡기 0℃ 급냉)
  assert.equal(r.tempMaxC, 54);
  // 정상 상태의 판독은 그대로 받는다(0 이어도 healthState 가 있으면 값이다)
  const r2 = parseTemps(sensor('System Board 1 Inlet Temp', 0, 0, 'green'));
  assert.equal(r2.tempC, 0);
});

// ── TIM2605-02 ────────────────────────────────────────────────────────────────
function hangServer() {
  const socks = new Set();
  const srv = net.createServer((sock) => { socks.add(sock); sock.on('error', () => {}); });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({
    port: srv.address().port,
    close: () => { for (const s of socks) s.destroy(); srv.close(); },
  })));
}

test('TIM2605-02: XtremIO REST 수집은 장비 시한 signal 을 받아 실제로 끊긴다', async () => {
  const h = await hangServer();
  process.env.STORAGE_XMS_PORT = String(h.port);
  try {
    const { collect } = await import('../src/storage/collectors/xtremio.js');
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('deadline')), 300);
    const t = Date.now();
    await collect({ id: 'x', name: 'x', type: 'xtremio', host: '127.0.0.1', username: 'u', password: 'p' }, { signal: ac.signal });
    const el = Date.now() - t;
    // 예전: signal 을 받지 않아 요청마다 요청 시한(4초)까지 기다렸다
    assert.ok(el < 2500, `시한 뒤에도 요청이 계속됐다(${el}ms)`);
  } finally { h.close(); delete process.env.STORAGE_XMS_PORT; }
});

test('TIM2605-02: Isilon REST 수집은 opts.signal 만 와도 끊긴다', async () => {
  const h = await hangServer();
  process.env.STORAGE_ISILON_PORT = String(h.port);   // isilon.js 는 로드 시점에 읽는다 — 이 테스트가 처음 import 한다
  try {
    const { collect } = await import('../src/storage/collectors/isilon.js');
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('deadline')), 300);
    const t = Date.now();
    await collect({ id: 'i', name: 'i', type: 'isilon', host: '127.0.0.1', username: 'u', password: 'p', collectMethod: 'api' }, { signal: ac.signal });
    const el = Date.now() - t;
    assert.ok(el < 2500, `시한 뒤에도 요청이 계속됐다(${el}ms)`);
  } finally { h.close(); }
});

test('TIM2605-02: 스윕 — storage/collectors 의 REST collect 는 signal 을 받고 makeGetter 에 넘긴다', () => {
  const dir = path.join(SRC, 'storage/collectors');
  const miss = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const s = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const m of s.matchAll(/make(?:Raw)?Getter\(device,\s*\{([^}]*)\}\)/g)) {
      if (f === 'restCommon.js') continue;
      if (!/signal/.test(m[1])) miss.push(`${f}: ${m[0]}`);
    }
    if (/make(?:Raw)?Getter\(device/.test(s) && f !== 'restCommon.js' && !/export async function collect\(device,\s*\{\s*signal/.test(s)) miss.push(`${f}: collect 가 signal 을 받지 않는다`);
  }
  const isi = bare('storage/collectors/isilon.js');
  if (!/export async function collect\(device,\s*\{\s*signal/.test(isi)) miss.push('isilon.js: collect 가 signal 을 받지 않는다');
  assert.deepEqual(miss, []);
});

// ── TIM2605-04 ────────────────────────────────────────────────────────────────
test('TIM2605-04: bmusage OS SSH·Isilon REST 시한 env 는 reqTimeoutMs 로 정규화된다', async () => {
  const { SESSION_BUDGET_MS } = await import('../src/bmusage/collectors/osSsh.js');
  assert.ok(SESSION_BUDGET_MS <= 600_000, `2^31 초과 env 가 그대로 타이머로 갔다(${SESSION_BUDGET_MS})`);
  for (const rel of ['bmusage/collectors/osSsh.js', 'storage/collectors/isilon.js']) {
    const s = bare(rel);
    const bad = [...s.matchAll(/Number\(process\.env\.[A-Z_]*(?:TIMEOUT|BUDGET)[A-Z_]*\)\s*\|\|/g)].map((m) => m[0]);
    assert.deepEqual(bad, [], rel);
  }
});

// ── RECENT2605-03 ─────────────────────────────────────────────────────────────
const isiStatus = (size, used, pct) => `Cluster Name: synth-isi
Cluster Health:     [  OK ]
Cluster Storage:  HDD                 SSD Storage
Size:             ${size} (2.3P Raw)     0 (0 Raw)
VHS Size:         45.2T
Used:             ${used} (${pct}%)          0 (n/a)
Avail:            990.1T (44%)        0 (n/a)

Critical Events:
Time            LNN  Event
`;

test('RECENT2605-03: 반올림 주기를 본 장비는 정확 값 주기에도 해상도 표지(mixed)를 유지하고, 증가량이 그것을 싣는다', async () => {
  const isi = await import('../src/storage/collectors/isilonSsh.js');
  assert.equal(typeof isi.markMixedBasis, 'function');
  isi._resetApproxSeenForTest();
  const dev = { id: 'isi-mix', name: 'isi-mix' };
  const parsed = isi.parseIsiStatus(isiStatus('2.2P', '1.2P', 56));
  // ① 반올림 주기(isi statistics 실패)
  const approx = isi.markMixedBasis(isi.normalizeIsiStatus(dev, parsed), dev.id);
  assert.equal(approx.extra.capacityApprox.source, 'isi status');
  // ② 다음 주기는 정확 값 — 예전에는 capacityApprox 가 사라져 증가량 화면의 해상도 표지도 사라졌다
  const exact = isi.markMixedBasis(isi.normalizeIsiStatus(dev, parsed, { exact: { total: 2.25 * PiB, used: 1.23 * PiB } }), dev.id);
  assert.equal(exact.capacity.totalBytes, 2.25 * PiB);
  assert.deepEqual(exact.extra.capacityApprox, { source: 'mixed', mixed: true, resolutionBytes: 0.1 * PiB });
  assert.match(exact.extra.capacityBasisNote, /반올림 표기/);
  assert.doesNotMatch(exact.extra.capacityBasisNote, /`/);
  // 반올림 주기를 본 적 없는 장비는 정확 값에 표지를 붙이지 않는다
  const other = isi.markMixedBasis(isi.normalizeIsiStatus({ id: 'isi-x' }, parsed, { exact: { total: 2.25 * PiB, used: 1.23 * PiB } }), 'isi-x');
  assert.equal(other.extra.capacityApprox, undefined);

  const { growthMatrix } = await import('../src/storage/growth.js');
  const D0 = 20000;
  const row = (day, used) => ({ device_id: 'isi-mix', day, last_ts: day * 86_400_000, total_bytes: 2.25 * PiB, used_bytes: used, max_used: used, samples: 4 });
  // 전날은 반올림(1.2P), 오늘은 정확(1.23P) — 하루 증가량 0.03P 는 해상도(0.1P) 반 칸 미만
  const rows = [row(D0 - 1, 1.2 * PiB), row(D0, 1.23 * PiB)];
  const m = growthMatrix(rows, { asOfDay: D0, periods: [{ key: '1d', days: 1, label: '1일' }], meta: new Map([['isi-mix', { capacityApprox: exact.extra.capacityApprox }]]) });
  const d = m.devices[0];
  assert.deepEqual(d.capacityApprox, { resolutionBytes: 0.1 * PiB, mixed: true });
  assert.equal(d.growth['1d'].belowResolution, true);
});

// ── RECENT2605-04 ─────────────────────────────────────────────────────────────
test('RECENT2605-04: 빈(0 TB) SRP 는 형식 미인식이 아니고, 적재된 어레이에 "적재하지 않습니다" 를 쓰지 않는다', async () => {
  const pm = await import('../src/storage/collectors/powermax.js');
  const { capacityPointEligible } = await import('../src/storage/db.js');
  assert.equal(typeof pm.powermaxSrpIsEmpty, 'function');
  const empty = { srpId: 'SRP_2', fba_srp_capacity: { effective: { physical_capacity: { used_tb: 0, total_tb: 0 } }, usable_total_tb: 0, usable_used_tb: 0 } };
  assert.equal(pm.powermaxSrp(empty), null);
  assert.equal(pm.powermaxSrpIsEmpty(empty), true);
  assert.equal(pm.powermaxSrpIsEmpty({ srpId: 'X' }), false);                       // 용량 블록 없음 = 여전히 형식 미인식
  assert.equal(pm.powermaxSrpIsEmpty({ fba_srp_capacity: { usable_total_tb: 5 } }), false);
  const TB = 1e12;
  const dev = { id: 'p', name: 'p', type: 'powermax' };
  const srps = { A1: [{ id: 'SRP_1', usedBytes: 50 * TB, totalBytes: 150 * TB, basis: 'fba_srp_capacity.effective.physical_capacity' }] };
  // ① 문서화되지 않은 기준 + 빈 SRP 하나 → SRP 합이 완전하므로 적재된다(예전: partial-pools 로 매 주기 미적재)
  const s1 = pm.normalizePowermax(dev, { arrays: [{ symmetrixId: 'A1' }], caps: { A1: { totalBytes: 200 * TB, usedBytes: 60 * TB, basis: 'physicalCapacity', documented: false } }, srps, srpState: { A1: { listed: 2, parsed: 1, failed: 0, unrecognized: 0, empty: 1, omitted: 0 } } });
  assert.equal(s1.extra.poolsUnreadable, undefined);
  assert.equal(s1.capacity.totalBytes, 150 * TB);
  assert.deepEqual(capacityPointEligible(s1), { ok: true });
  // ② 문서화된 기준 + SRP 하나 형식 미인식 → 적재되므로 '적재하지 않습니다' 는 거짓이다
  const s2 = pm.normalizePowermax(dev, { arrays: [{ symmetrixId: 'A1' }], caps: { A1: { totalBytes: 200 * TB, usedBytes: 60 * TB, basis: 'system_capacity.usable', documented: true } }, srps, srpState: { A1: { listed: 2, parsed: 1, failed: 0, unrecognized: 1, omitted: 0 } } });
  assert.deepEqual(capacityPointEligible(s2), { ok: true });
  assert.doesNotMatch(s2.extra.capacityBasisNote, /적재하지 않습니다/);
  assert.match(s2.extra.capacityBasisNote, /SRP 상세만 빠졌습니다/);
  // ③ 문서화되지 않은 기준 + 형식 미인식은 여전히 보수적으로 막고 그 사실을 말한다
  const s3 = pm.normalizePowermax(dev, { arrays: [{ symmetrixId: 'A1' }], caps: { A1: { totalBytes: 200 * TB, usedBytes: 60 * TB, basis: 'physicalCapacity', documented: false } }, srps, srpState: { A1: { listed: 2, parsed: 1, failed: 0, unrecognized: 1, omitted: 0 } } });
  assert.deepEqual(capacityPointEligible(s3), { ok: false, reason: 'partial-pools' });
  assert.match(s3.extra.capacityBasisNote, /적재하지 않습니다/);
});

// ── LEFT2605-03 ───────────────────────────────────────────────────────────────
/** 옛 구현(감사 기준 커밋 판본 그대로) — 결과 동일성 대조용. */
function parseJsonLooseOld(text) {
  const s = String(text || '');
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  for (let end = s.length; end > start; end -= 1) {
    const slice = s.slice(start, end);
    const last = slice.trimEnd().slice(-1);
    if (last !== '}' && last !== ']') continue;
    try { return JSON.parse(slice); } catch { /* 더 짧게 재시도 */ }
  }
  return null;
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('LEFT2605-03: parseJsonLoose — 옛 구현과 결정적 난수 입력 6,000개에서 결과가 같다', async () => {
  const { parseJsonLoose } = await import('../src/storage/collectors/cliSsh.js');
  const rnd = mulberry32(2605);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const ALPHA = ['[', ']', '{', '}', '"', '\\', ',', ':', ' ', '\n', 'a', '1', 'x', ' ', 'true', 'null', '-'];
  const randVal = (d) => {
    const r = rnd();
    if (d > 3 || r < 0.3) return pick([1, -2.5, 'a"b', 'q\\z', 'br]ce}', true, null, '', '{"x":1}']);
    if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => randVal(d + 1));
    const o = {}; for (let i = 0; i < Math.floor(rnd() * 4); i += 1) o[pick(['k', 'a b', 'q"', '[', '}'])] = randVal(d + 1); return o;
  };
  const cases = [];
  for (let i = 0; i < 6000; i += 1) {
    const kind = i % 4;
    if (kind === 0) cases.push(Array.from({ length: Math.floor(rnd() * 30) }, () => pick(ALPHA)).join(''));
    else {
      const banner = pick(['', 'Banner: ok\n', 'x = 1 [note]\n', 'Welcome {user}\n', '  \n']);
      const js = JSON.stringify(randVal(0), null, rnd() < 0.3 ? 2 : 0);
      const tail = pick(['', '\n', '  ', '\nDone.', ']', '}', '\n{"b":2}', ' trailing [x]']);
      let t = banner + js + tail;
      if (kind === 2) t = t.slice(0, Math.floor(rnd() * t.length));          // 잘린 출력
      if (kind === 3 && t.length) { const p = Math.floor(rnd() * t.length); t = t.slice(0, p) + pick(ALPHA) + t.slice(p); }  // 한 글자 오염
      cases.push(t);
    }
  }
  let diff = 0; const first = [];
  for (const c of cases) {
    const a = JSON.stringify(parseJsonLooseOld(c)); const b = JSON.stringify(parseJsonLoose(c));
    if (a !== b) { diff += 1; if (first.length < 3) first.push({ c, a, b }); }
  }
  assert.equal(diff, 0, JSON.stringify(first));
  // 대조가 공허하지 않다 — 성공·실패 양쪽 결과가 충분히 섞여 있다
  const nonNull = cases.filter((c) => parseJsonLoose(c) !== null).length;
  assert.ok(nonNull > 1000 && nonNull < 5500, `nonNull=${nonNull}`);
});

test('LEFT2605-03: 잘린 JSON 160KB 가 선형 시간에 끝난다(예전 26.7초)', async () => {
  const { parseJsonLoose } = await import('../src/storage/collectors/cliSsh.js');
  const big = `[${Array.from({ length: 20000 }, () => '{"a":1}').join(',')},{"a":`;   // 잘린 꼬리
  const t = performance.now();
  assert.equal(parseJsonLoose(big), null);
  const ok = parseJsonLoose(`Banner\n${big.slice(0, -6)}]`);
  const el = performance.now() - t;
  assert.equal(ok.length, 20000);
  assert.ok(el < 1000, `${el}ms`);   // 회귀(수십 초)와 확실히 갈리는 상한 — 병렬 부하 여유를 둔다
});
