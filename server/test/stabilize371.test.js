// v3.7.1 안정화 — ① 쉬는 시간 × 끊김/늦음 거짓 경보 ② 엣지 쉬는 시간이 실패 기록을 덮음 ③ 정기 보고 '지난 보고 대비' 기준
// ④ 알림 평가의 동기 원장 재구성 · ⑤ bmstor 순번(audit2622c) · ⑥ 가짜 ping 정리(_fakePing.js — audit2732d · audit2733b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quietLongestMs } from '../src/ipam/scanQuiet.js';
import { scanStaleAlerts } from '../src/ipam/instantAlerts.js';
import { buildScanSchedule } from '../src/ipam/scanSchedule.js';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const u = (p) => pathToFileURL(path.join(SRC, p)).href;
const HOUR = 3_600_000;

test('① quietLongestMs — 가장 긴 연속 쉬는 시간(이어 붙은 창 · 자정 넘김 · 요일 무시 · 24시간 상한)', () => {
  assert.equal(quietLongestMs([]), 0);
  assert.equal(quietLongestMs(null), 0);
  assert.equal(quietLongestMs([{ from: '01:00', to: '05:00' }]), 4 * HOUR);
  assert.equal(quietLongestMs([{ from: '22:00', to: '02:00' }, { from: '02:00', to: '06:00', days: [1] }]), 8 * HOUR, '이어 붙은 두 창(요일은 넉넉하게 무시)');
  assert.equal(quietLongestMs([{ from: '01:00', to: '02:00' }, { from: '13:00', to: '16:00' }]), 3 * HOUR, '떨어진 창은 긴 쪽');
  assert.ok(quietLongestMs([{ from: '12:00', to: '11:59' }]) <= 24 * HOUR);
});

test('① 스캔 보고 끊김 — 쉬는 시간만큼 늦춘다(쉬는 동안 거짓 경보 없음 · 그 뒤에는 그대로 울림)', () => {
  const now = 100 * HOUR;
  const agent = { name: 'edge-q', enabled: true, intervalMs: HOUR, ranges: ['10.0.0.0/24'], quiet: [{ from: '01:00', to: '05:00' }] };
  // 마지막 완료 3.5시간 전 — 예전 기준(주기 1시간 × 3)이면 경보. 쉬는 시간 4시간을 더하면 아직 아니다.
  assert.deepEqual(scanStaleAlerts([agent], { 'edge-q': { at: now - 3.5 * HOUR } }, { threshold: 3, now }).alerts, [], '쉬는 시간 안 — 경보 없음');
  const late = scanStaleAlerts([agent], { 'edge-q': { at: now - 7.5 * HOUR } }, { threshold: 3, now });
  assert.equal(late.alerts.length, 1, '주기 × 3 + 쉬는 시간 4시간을 넘으면 울린다');
  assert.match(late.alerts[0].detail, /쉬는 시간 4시간/);
  const noQuiet = scanStaleAlerts([{ ...agent, quiet: [] }], { 'edge-q': { at: now - 3.5 * HOUR } }, { threshold: 3, now });
  assert.equal(noQuiet.alerts.length, 1, '쉬는 시간이 없으면 예전 기준 그대로');
});

test('① 주기 스캔 일정 — 늦음도 같은 여유(주기 × 2 + 쉬는 시간)', () => {
  const now = Date.UTC(2026, 10, 14, 6, 0);
  const agents = [{ name: 'edge-q', enabled: true, intervalMs: HOUR, ranges: ['x'], quiet: [{ from: '01:00', to: '05:00' }] }, { name: 'edge-n', enabled: true, intervalMs: HOUR, ranges: ['x'] }];
  const reports = { 'edge-q': { at: now - 3 * HOUR }, 'edge-n': { at: now - 3 * HOUR } };
  const by = Object.fromEntries(buildScanSchedule({ agents, log: [], reports, now }).rows.map((r) => [r.agent, r.state]));
  assert.equal(by['edge-q'], 'ok', '3시간 < 2 + 4시간');
  assert.equal(by['edge-n'], 'late', '쉬는 시간 없는 에이전트는 예전처럼 늦음');
});

test('② 엣지 — 쉬는 시간 건너뛰기가 직전 결과 보고 실패 기록을 덮지 않는다(무음 실패 금지)', async () => {
  const http = await import('node:http');
  const d = new Date();
  const hm = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  const cur = d.getHours() * 60 + d.getMinutes();
  const quiet = [{ from: hm(cur - 30), to: hm(cur + 30) }];   // 자식 프로세스의 현지 시각으로 지금을 감싼다(같은 TZ)
  let results = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (x) => { b += x; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/central/ip-scan-assignment')) return res.end(JSON.stringify({ assigned: true, ranges: [], ports: [80], intervalMs: HOUR, quiet }));
      if (req.url.startsWith('/api/central/ip-scan-result')) { results++; res.statusCode = 403; return res.end('{"ok":false}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'stab371-edge-'));
  const env = { ...process.env, CONFIG_DIR: cfg, CENTRAL_URL: `http://127.0.0.1:${srv.address().port}`, AGENT_NAME: 'edge-q', CENTRAL_TOKEN: 'x', SSRF_ALLOW_LOOPBACK: 'true' };
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `
      const w = await import(${JSON.stringify(u('agent/ipScanWorker.js'))});
      console.warn = () => {};
      const first = await w.runIpScanAgentOnce();                                         // 수동 — 스캔 후 결과 보고 403
      const quietTick = await w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() + 2 * ${HOUR} });   // 주기 지남 + 쉬는 시간
      process.stdout.write(JSON.stringify({ first, quietTick, status: w.ipScanAgentStatus().last }));
      process.exit(0);
    `], { env });
    let o = ''; let e = '';
    p.stdout.on('data', (x) => { o += x; }); p.stderr.on('data', (x) => { e += x; });
    p.on('exit', (code) => (code === 0 ? resolve(o) : reject(new Error(e))));
  });
  try {
    const o = JSON.parse(out);
    assert.equal(results, 1, '수동 스캔만 결과를 보냈다(쉬는 시간 회차는 스캔하지 않음)');
    assert.match(o.first.error || '', /result 403/);
    assert.equal(o.quietTick.error, o.first.error, '쉬는 시간 기록이 실패를 덮지 않는다');
    assert.equal(o.quietTick.phase, 'report');
    assert.ok(o.quietTick.quiet, "'쉬는 중' 표시는 더한다");
    assert.equal(o.status.error, o.first.error, '엣지 로그 상태에도 실패가 남는다');
  } finally { srv.close(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('③ 정기 보고 — 기준(prevOcc)은 이번에 법인 메일이 실제로 나간 법인만 갱신한다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/ipam/report.js', import.meta.url), 'utf8'));
  assert.match(src, /if \(rec\.state === 'sent'\) delivered\.push\(c\);/);
  assert.match(src, /if \(!manual && delivered\.length\) \{ const st = state\(\); for \(const c of delivered\) st\.prevOcc\[c\.id\] = c\.occMap; save\(\); \}/);
  assert.doesNotMatch(src, /for \(const c of real\) st\.prevOcc/, '예전: 예약 발송 한 번마다 모든 법인을 갱신했다');
  assert.match(src, /if \(moved\) save\(\);/, '받는 사람 없는 법인의 회차 기록도 저장');
});

test('④ 알림 평가 — 원장이 캐시에 없으면 다시 만들지 않고 그 종류를 보류한다 · 캐시가 있으면 판정', async () => {
  const al = await import('../src/alerts.js');
  const led = await import('../src/ipam/ledger.js');
  const snap = { generatedAt: `stab371-${Date.now()}`, vcenters: [{ id: 'vc1', name: 'VC1', status: 'connected' }], hosts: [],
    vms: [{ id: 'v1', name: 'a', vcenterId: 'vc1', ipAddresses: ['10.71.0.5'], powerState: 'POWERED_ON' }, { id: 'v2', name: 'b', vcenterId: 'vc1', ipAddresses: ['10.71.0.5'], powerState: 'POWERED_ON' }],
    datastores: [], alarms: [] };
  const cfg = { ...al.loadAlertConfig(), rules: { ...al.loadAlertConfig().rules, ipamDuplicate: { enabled: true }, ipamSubnetFull: { enabled: true, threshold: 90 } } };
  assert.equal(led.peekIpamRows(snap, '', null), null, '전제: 캐시 없음');
  const t0 = performance.now();
  const cold = al.evaluate(snap, cfg);
  assert.equal(led.peekIpamRows(snap, '', null), null, '평가가 원장을 만들지 않았다');
  assert.deepEqual([...cold.heldPrefixes].sort(), ['ipdup:', 'ipfull:'], '그 회차는 보류 — 발생 중인 것을 해소로 기록하지 않게');
  assert.equal(cold.filter((a) => String(a.key).startsWith('ipdup:')).length, 0);
  assert.ok(performance.now() - t0 < 5000);
  led.buildIpamRows(snap, '', null);   // store 의 원장 동기화가 끝난 뒤와 같은 상태
  const warm = al.evaluate(snap, cfg);
  assert.deepEqual(warm.filter((a) => String(a.key).startsWith('ipdup:')).map((a) => a.key), ['ipdup:10.71.0.5']);
  assert.equal(warm.heldPrefixes.size, 0);
  const src = stripComments(fs.readFileSync(new URL('../src/alerts.js', import.meta.url), 'utf8'));
  assert.match(src, /if \(held\.has\(key\) \|\| heldPrefixes\.some\(\(p\) => key\.startsWith\(p\)\)/, '해소 단계가 앞부분 보류를 본다');
  assert.doesNotMatch(src, /buildIpamRows\(/, '알림 평가는 원장을 만들지 않는다');
});

test('⑤⑥ 이식 — bmstor 순번 · 가짜 ping 소유 확인(소스 계약)', () => {
  const jobs = stripComments(fs.readFileSync(new URL('../src/bmstor/jobs.js', import.meta.url), 'utf8'));
  assert.match(jobs, /o\.ackedAt && o\.order > j\.order/);
  assert.doesNotMatch(jobs, /\(o\.createdAt \|\| 0\) > \(j\.createdAt \|\| 0\)/);
  for (const f of ['audit2732d_scanDeadline.test.js', 'audit2733b_scanHold.test.js']) {
    const t = fs.readFileSync(path.join(HERE, f), 'utf8');
    assert.match(t, /installFakePing\(/, f); assert.match(t, /killOwned\(\);/, f);
    assert.doesNotMatch(t, /for \(const pid of pids\(\)\) \{ try \{ process\.kill/, `${f} — 확인 없이 PID 를 죽이지 않는다`);
  }
});
