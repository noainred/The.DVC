// v2.632 감사 그룹 a — 설정 배포·엣지 pull 회귀 고정.
//   AX1-2632-01 RMA rma-poll 503 settingsUnreadable 은 '연결됨' — 무연결 명령 오발 방지
//   AX1-2632-02 설정 파일 로드 오류가 서비스 점검·콘솔·bmusage 배포 인출 기록에 드러난다
//   EDGE2632-01 성능점검 배정 파일 손상 → /svcmon-config 503(엣지가 central:* 배치를 지우지 않게)
//   EDGE2632-02 SAN 포트 사용량 설정 손상 → /sanswitch-config 가 perf 를 빼고 perfSettingsUnreadable
//   EDGE2632-03 스토리지·PDU 주기 · 통신 점검 · IP 스캔 설정 손상 → 기본값 200 금지(엣지는 직전 값 유지)
//   A6-2632-03  bmusage 배포 인출 기록 상한이 검증된 기록을 밀어내지 않는다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2632a-'));
process.env.CONFIG_DIR = tmp;
process.env.CENTRAL_TOKEN = 'ctok-2632a';
process.env.COLLECTOR_TOKEN = 'coltok-2632a';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.LINKCHECK_ENABLED;

// 기준 시각은 경계에서 떨어뜨려 고정(CLAUDE.md — Date.now() 를 기준으로 쓰지 않는다)
const NOW = Date.UTC(2026, 8, 20, 3, 30, 0);

// 배포되는 중앙 설정 파일을 **손상된 채로** 둔다(모듈을 불러오기 전에).
const CORRUPT = ['central-svcmon-assign.json', 'sanswitch-perf-settings.json', 'storage-intervals.json', 'pdu-intervals.json', 'linkcheck-settings.json', 'ipam-scan.json'];
for (const f of CORRUPT) fs.writeFileSync(path.join(tmp, f), '{ 손상된 JSON');

const quiet = async (fn, sink) => {
  const w = console.warn; const l = console.log;
  console.warn = (...a) => sink?.push(['warn', a.join(' ')]); console.log = (...a) => sink?.push(['log', a.join(' ')]);
  try { return await fn(); } finally { console.warn = w; console.log = l; }
};

const servers = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let base; let edgeTok;
// 목 중앙(엣지 쪽 pull 을 실제로 호출하기 위한) — 경로별 응답을 바꾼다.
const replies = new Map();
let mockBase;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use('/api/central', express.json({ limit: '16mb' }), centralRouter);
  const srv = http.createServer(app);
  servers.push(srv);
  base = `http://127.0.0.1:${await listen(srv)}/api/central`;
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  edgeTok = issueAgentToken('edge-a').token;

  const mock = http.createServer((q, r) => {
    const ch = []; q.on('data', (c) => ch.push(c));
    q.on('end', () => {
      const p = q.url.split('?')[0];
      const fn = replies.get(p);
      const out = fn ? fn(q.url) : { status: 200, json: { ok: true } };
      r.writeHead(out.status, { 'content-type': 'application/json' }); r.end(JSON.stringify(out.json));
    });
  });
  servers.push(mock);
  mockBase = `http://127.0.0.1:${await listen(mock)}`;
});
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const cget = (p, tok = edgeTok) => fetch(`${base}${p}`, { headers: { 'X-Central-Token': tok, 'X-Agent-Name': 'edge-a' } });

// ── EDGE2632-01 ────────────────────────────────────────────────────────────
test('EDGE2632-01: 성능점검 배정 파일 손상 → /svcmon-config 503 settingsUnreadable(assigned:false 200 금지)', async () => {
  const sink = [];
  const r = await quiet(() => cget('/svcmon-config?agent=edge-a'), sink);
  const j = await r.json();
  assert.equal(r.status, 503, `수정 전: 200 assigned:false → 엣지가 central:* 배치를 전부 삭제 — ${JSON.stringify(j)}`);
  assert.equal(j.reason, 'settingsUnreadable');
  assert.ok(!('assigned' in j), '배정 여부를 싣지 않는다');
  // 재시작 흉내 — 원본이 .corrupt 로 옮겨진 뒤에도(보존본만) 여전히 못 읽은 것
  assert.ok(!fs.existsSync(path.join(tmp, 'central-svcmon-assign.json')));
  const sa = await import('../src/central/svcmonAssign.js');
  sa._resetAssignCache();
  assert.ok(sa.svcmonAssignLoadError(), '보존본만 남아도 오류');
  assert.equal((await quiet(() => cget('/svcmon-config?agent=edge-a'))).status, 503);
  // 비관리 저장(주기 기록·pull 표시)은 빈 배정을 파일로 굳히지 않는다
  sa.noteExpectMs('edge-a', 60_000);
  assert.ok(!fs.existsSync(path.join(tmp, 'central-svcmon-assign.json')), '빈 배정을 쓰지 않는다');
  // 관리자 저장 → 풀린다
  sa.setAssignment('edge-a', { kind: 'group', path: '/' }, [{ kind: 'server', path: '/a', name: 'a', host: '10.0.0.1', tests: [{ type: 'ping' }] }]);
  assert.equal(sa.svcmonAssignLoadError(), null);
  const ok = await cget('/svcmon-config?agent=edge-a');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).assigned, true);
});

// ── EDGE2632-02 ────────────────────────────────────────────────────────────
test('EDGE2632-02: SAN 포트 사용량 설정 손상 → sanswitch-config 가 perf 를 빼고 perfSettingsUnreadable(장비 목록은 그대로)', async () => {
  const sink = [];
  const r = await quiet(() => cget('/sanswitch-config?agent=edge-a'), sink);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.ok(Array.isArray(j.devices), '장비 목록은 등록부가 원천이라 그대로');
  assert.ok(!('perf' in j), `수정 전: perf{enabled:false,retentionDays:90} 이 배포돼 엣지가 저장 — ${JSON.stringify(j.perf)}`);
  assert.ok(j.perfSettingsUnreadable && /손상 보존본|읽지 못/.test(j.perfSettingsUnreadable.reason), JSON.stringify(j.perfSettingsUnreadable));
  assert.ok(sink.some(([, m]) => /포트 사용량 설정 파일을 읽지 못해/.test(m)), '중앙 콘솔에 남긴다');
  const ps = await import('../src/sanswitch/perfSettings.js');
  ps._resetForTest();
  assert.ok(ps.perfSettingsLoadError(), '재시작 뒤(보존본만)에도 오류');
  ps.savePerfSettings({ enabled: true, retentionDays: 3650 });
  assert.equal(ps.perfSettingsLoadError(), null);
  const j2 = await (await cget('/sanswitch-config?agent=edge-a')).json();
  assert.equal(j2.perf?.retentionDays, 3650);
});

// ── EDGE2632-03 ────────────────────────────────────────────────────────────
test('EDGE2632-03: 스토리지·PDU 주기 설정 손상 — 새 엣지(intervalsHold=1)는 intervals 없이 사유, 구버전 엣지는 503', async () => {
  for (const [p, mod, errFn] of [['/storage-config', '../src/storage/intervals.js', 'storageIntervalsLoadError'], ['/pdu-config', '../src/pdu/intervals.js', 'pduIntervalsLoadError']]) {
    const old = await quiet(() => cget(`${p}?agent=edge-a`));
    const jo = await old.json();
    assert.equal(old.status, 503, `${p} 구버전 엣지: 503(수정 전 200 intervals:{} → 중앙 지정 주기 해제) — ${JSON.stringify(jo)}`);
    assert.equal(jo.reason, 'settingsUnreadable');
    const neu = await quiet(() => cget(`${p}?agent=edge-a&intervalsHold=1`));
    const jn = await neu.json();
    assert.equal(neu.status, 200, JSON.stringify(jn));
    assert.ok(!('intervals' in jn), `${p}: intervals 를 싣지 않는다`);
    assert.ok(jn.intervalsUnreadable?.reason, `${p}: 사유를 싣는다`);
    assert.ok(Array.isArray(jn.devices));
    const m = await import(mod);
    assert.ok(m[errFn](), `${p}: 로드 오류`);
  }
  const si = await import('../src/storage/intervals.js');
  si.saveIntervalConfig({ global: { pollMs: 7_200_000 } });
  const j = await (await cget('/storage-config?agent=edge-a')).json();
  assert.equal(j.intervals.pollMs, 7_200_000, '저장하면 풀린다');
  const pi = await import('../src/pdu/intervals.js');
  pi.saveIntervals({ pollMs: 600_000 });
  assert.equal(pi.pduIntervalsLoadError(), null);
});

test('EDGE2632-03: 통신 점검·IP 스캔 설정 손상 → 503(enabled:false · assigned:false 200 금지)', async () => {
  const lc = await quiet(() => cget('/link-check-config?agent=edge-a'));
  const jl = await lc.json();
  assert.equal(lc.status, 503, `수정 전: 200 enabled:false(화면 '점검 꺼짐') — ${JSON.stringify(jl)}`);
  assert.equal(jl.reason, 'settingsUnreadable');
  const ip = await quiet(() => cget('/ip-scan-assignment?agent=edge-a'));
  const ji = await ip.json();
  assert.equal(ip.status, 503, `수정 전: 200 assigned:false(엣지 스캔 중단) — ${JSON.stringify(ji)}`);
  const ls = await import('../src/linkcheck/settings.js');
  ls.saveLinkCheckSettings({ enabled: false });
  assert.equal(ls.linkCheckSettingsLoadError(), null);
  assert.equal((await cget('/link-check-config?agent=edge-a')).status, 200);
  const ss = await import('../src/ipam/scanStore.js');
  ss.saveScanSettings('edge-a', { enabled: true, ranges: ['10.9.0.0/30'] });
  assert.equal(ss.scanSettingsLoadError(), null);
  const ja = await (await cget('/ip-scan-assignment?agent=edge-a')).json();
  assert.equal(ja.assigned, true);
});

test('EDGE2632-03: 엣지는 intervalsUnreadable 이면 주기를 적용하지 않고 직전 값을 유지한다(storage·pdu)', async () => {
  const { config } = await import('../src/config.js');
  const prevUrl = config.agent.centralUrl; const prevTok = config.agent.centralToken; const prevName = config.agent.name;
  config.agent.centralUrl = mockBase; config.agent.centralToken = 'x'; config.agent.name = 'edge-a';
  try {
    const si = await import('../src/storage/intervals.js');
    const pi = await import('../src/pdu/intervals.js');
    si.applyCentralIntervals({ pollMs: 7_200_000 });
    pi.applyCentralIntervals({ pollMs: 900_000 });
    const seenQ = [];
    const unread = { intervalsUnreadable: { reason: '설정 파일이 없고 손상 보존본만 있습니다', since: NOW } };
    replies.set('/api/central/storage-config', (url) => { seenQ.push(url); return { status: 200, json: { ok: true, devices: [], collectNow: [], ...unread } }; });
    replies.set('/api/central/pdu-config', (url) => { seenQ.push(url); return { status: 200, json: { ok: true, devices: [], collectNow: [], ...unread } }; });
    const sp = await import('../src/agent/storageConfigPull.js');
    const pp = await import('../src/agent/pduConfigPull.js');
    const sink = [];
    const r1 = await quiet(() => sp.pullStorageConfigNow(), sink);
    const r2 = await quiet(() => pp.pullPduConfigNow(), sink);
    assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.ok(seenQ.every((u) => /intervalsHold=1/.test(u)), '엣지가 규약을 안다고 알린다');
    assert.equal(si.runtimeIntervals().pollMs, 7_200_000, '수정 전: {} 적용으로 로컬 주기로 되돌아갔다');
    assert.equal(pi.runtimeIntervals().pollMs, 900_000);
    assert.ok(sink.some(([, m]) => /주기 설정을 읽지 못해/.test(m)), '엣지 콘솔에 남긴다');
  } finally {
    replies.delete('/api/central/storage-config'); replies.delete('/api/central/pdu-config');
    config.agent.centralUrl = prevUrl; config.agent.centralToken = prevTok; config.agent.name = prevName;
  }
});

// ── AX1-2632-02 ────────────────────────────────────────────────────────────
test('AX1-2632-02: 설정 파일 로드 오류가 서비스 점검 한 줄로 드러난다(보존본만 남은 설정도)', async () => {
  // 한 번도 로드되지 않은 설정도 보존본만 있으면 보인다.
  fs.writeFileSync(path.join(tmp, 'rma-schedules.json.corrupt.1700000000000'), '{');
  const { listSettingsLoadErrors } = await import('../src/util/settingsLoadError.js');
  await import('../src/rma/schedules.js');
  const errs = listSettingsLoadErrors();
  assert.ok(errs.some((e) => e.file === 'rma-schedules.json'), JSON.stringify(errs));
  const { getServiceCheck } = await import('../src/health/services.js');
  const row = getServiceCheck().checks.find((c) => c.key === 'settings-files');
  assert.ok(row, '서비스 점검에 행이 있다');
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /rma-schedules\.json/);
});

test('AX1-2632-02: 손상 중 bmusage-config 는 503 전에 인출 기록(사유 settings-unreadable)을 남긴다', async () => {
  fs.writeFileSync(path.join(tmp, 'bmusage-distribute.json'), '{ 손상');
  const bm = await import('../src/bmusage/settings.js');
  bm._resetForTest();
  const r = await quiet(() => cget('/bmusage-config?agent=edge-a&applied=abc'));
  assert.equal(r.status, 503);
  const row = bm.distributionStatus(['edge-a']).rows.find((x) => x.agent === 'edge-a');
  assert.ok(row.lastPullAt > 0, '수정 전: 인출 기록 없음(중립)으로만 보였다');
  assert.equal(row.pullReason, 'settings-unreadable');
  assert.equal(row.verified, true);
});

// ── A6-2632-03 ─────────────────────────────────────────────────────────────
test('A6-2632-03: 미검증 이름 512개가 검증된 엣지의 인출 기록을 밀어내지 않는다 · 가짜 행은 개수만', async () => {
  const bm = await import('../src/bmusage/settings.js');
  bm._resetForTest();
  bm.recordBmUsagePull('Edge-Real', { appliedSig: 's1', verified: true, now: NOW });
  for (let i = 0; i < 600; i++) bm.recordBmUsagePull(`fake${i}`, { verified: false, now: NOW + 1000 + i });
  const d = bm.distributionStatus(['Edge-Real']);
  const real = d.rows.find((x) => x.agent === 'Edge-Real');
  assert.equal(real.lastPullAt, NOW, '수정 전: lastPullAt 0 · verified null(밀려남)');
  assert.equal(real.verified, true);
  const fakes = d.rows.filter((x) => /^fake/.test(x.agent));
  assert.ok(fakes.length <= 32, `가짜 행은 상한까지만(${fakes.length})`);
  assert.ok(d.unknownUnverifiedOmitted > 0, '나머지는 개수로 밝힌다');
  assert.ok(d.pullsOmitted > 0, '상한으로 거절한 미검증 인출 수');
  // 검증된 새 엣지는 여전히 기록된다(미검증을 밀어낸다)
  bm.recordBmUsagePull('Edge-Two', { appliedSig: 's1', verified: true, now: NOW + 5000 });
  assert.equal(bm.distributionStatus(['Edge-Two']).rows.find((x) => x.agent === 'Edge-Two').verified, true);
  // 오래(1시간 넘게) 인출하지 않은 미검증은 새 미검증이 밀어낼 수 있다
  const before = bm.distributionStatus([]).pullsOmitted;
  bm.recordBmUsagePull('late-shared', { verified: false, now: NOW + 2 * 3_600_000 });
  assert.equal(bm.distributionStatus([]).pullsOmitted, before, '거절되지 않고 기록된다');
  bm._resetForTest();
});

// ── AX1-2632-01 ────────────────────────────────────────────────────────────
test('AX1-2632-01: rma-poll 503 settingsUnreadable 은 연락으로 센다(무연결 명령 오발 방지) · 그 밖 503 은 아니다', async () => {
  process.env.CENTRAL_URL = mockBase;
  replies.set('/api/central/rma-poll', () => ({ status: 503, json: { ok: false, reason: 'settingsUnreadable', detail: '중앙 RMA 점검 스케줄 설정 파일을 읽지 못했습니다' } }));
  try {
    const rma = await import('../src/rma/agent.js');
    const before = rma.rmaContactState().lastContact;
    await new Promise((r) => setTimeout(r, 15));
    const err = await quiet(async () => { try { await rma.pollOnce(); return null; } catch (e) { return e; } });
    assert.ok(err, '백오프를 위해 오류로 던진다');
    assert.equal(err.settingsUnreadable, true);
    assert.ok(rma.rmaContactState().lastContact > before, '수정 전: lastContact 미갱신 → RMA_OFFLINE_MINUTES 뒤 무연결 명령');
    assert.match(rma.rmaContactState().lastRefused?.reason || '', /settingsUnreadable/);
    replies.set('/api/central/rma-poll', () => ({ status: 503, json: { ok: false, reason: 'busy' } }));
    const c0 = rma.rmaContactState().lastContact;
    await new Promise((r) => setTimeout(r, 15));
    const e2 = await quiet(async () => { try { await rma.pollOnce(); return null; } catch (e) { return e; } });
    assert.ok(e2); assert.notEqual(e2.settingsUnreadable, true);
    assert.equal(rma.rmaContactState().lastContact, c0);
  } finally { replies.delete('/api/central/rma-poll'); }
});
