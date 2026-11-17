/**
 * svcmonFullAudit26.test.js — 전체 점검 26회차(서비스 모니터링) 확정분 + 27회차(23~25회차 반증) 보완.
 *  26: F1 로그 보관 설정 손상 → 설정 상한으로만 정리 · 저장 409 · 확정은 최대 보관 · 읽기 오류는 원본 유지 · 알림 설정 손상 표지
 *      F3 배정 삭제 확인창 · 문서 정정 · F4 단건 추가 · 수정 중복 검사 · F5 엣지 caps/poller/log 정제 · 가림 · F6 batch 는 서버만 발급
 *      F10 비-HTTP 점검 실행 시점 lookup 검증(dgram 은 이름만) · F11 응답 평균 null(web) · F12 엣지 주기 상한 · F13 문구 · P1 인증서 만료일 NaN
 *  27: D-2 409 를 성공으로 보이지 않게(웹) · D-6 수정 중복 검사는 키가 바뀔 때만 · D-8 배정 파일 손상 중 대역 이전 보류 · D-9 일 요약 total/used 짝
 *  (F2 콘솔 타일은 web src/console/svcmonTile26.test.js)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripComments } from './_stripComments.js';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const tmp = tmpDir('svfa26-');
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
process.env.DATA_SOURCE = 'live';
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '../src');
const WEB = path.join(HERE, '../../web/src');
const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const J = (p) => JSON.stringify(path.join(SRC, p));

const sub = (setup, code) => {
  const d = tmpDir('svfa26s-');
  try {
    setup(d);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d }, encoding: 'utf8' });
    const line = r.stdout.trim().split('\n').pop();
    try { return { out: JSON.parse(line), dir: d, files: fs.readdirSync(d) }; } catch { throw new Error(`${r.stdout}\n${r.stderr}`); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
};

test('F1 — 로그 보관 설정 손상: 표지 · 설정 상한(3650개)으로만 정리 · 저장 409 · 확정은 최대 보관', () => {
  const { out } = sub((d) => {
    fs.writeFileSync(path.join(d, 'svcmon-log.json'), '{"keepFiles": 365, "rot');
    const ld = path.join(d, 'svcmon-logs'); fs.mkdirSync(ld);
    const t0 = Date.now() - 400 * 86_400_000;
    for (let i = 0; i < 300; i += 1) { const f = path.join(ld, `results-2025${String(i).padStart(4, '0')}.csv`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, new Date(t0 + i * 86_400_000), new Date(t0 + i * 86_400_000)); }
  }, `const L = await import(${J('svcmon/logsettings.js')}); const C = await import(${J('svcmon/csvlog.js')});
     const err = !!L.logSettingsLoadError(); const removed = C.pruneOld(L.logDir(), L.getLogSettings());
     let save = null; try { L.setLogSettings({ keepFiles: 30 }); } catch (e) { save = { code: e.code, status: e.status }; }
     const st = C.logStatus();
     const u = await import(${J('util/settingsLoadError.js')});
     const row = u.listSettingsLoadErrors().find((x) => x.file === 'svcmon-log.json');
     const c = row ? u.confirmSettingsDefault(row.file, { by: 't' }) : null;
     console.log(JSON.stringify({ err, removed, save, unreadable: st.settingsUnreadable, row: !!row, conf: c?.ok ?? null, keepAfter: L.getLogSettings().keepFiles, errAfter: !!L.logSettingsLoadError() }));`);
  assert.equal(out.err, true, '손상 표지(수정 전: 표지 없이 기본값 90)');
  assert.equal(out.removed, 0, '설정 상한으로만 정리 — 300개 그대로(수정 전: 210개 삭제)');
  assert.deepEqual(out.save, { code: 'settings-unreadable', status: 409 });
  assert.equal(out.unreadable, true, '화면이 저장을 잠그는 근거');
  assert.equal(out.row, true, '서비스 점검 목록');
  assert.equal(out.conf, true); assert.equal(out.errAfter, false);
  assert.equal(out.keepAfter, 3650, '확정은 최대 보관(기본 90 으로 확정하면 다음 회전이 이력을 지운다)');
  const route = rd('routes/svcmon/logs.js');
  assert.match(route, /if \(e\?\.code === 'settings-unreadable'\) return res\.status\(409\)/);
});

test('F1 — 읽기 오류(EISDIR)는 원본을 옮기지 않고 확정할 수 없다 · 알림 설정 손상도 서비스 점검에 오른다', () => {
  const { out, files } = sub((d) => {
    fs.mkdirSync(path.join(d, 'svcmon-log.json'));
    fs.writeFileSync(path.join(d, 'svcmon-alert.json'), '{"enabled": tr');
  }, `const L = await import(${J('svcmon/logsettings.js')}); const A = await import(${J('svcmon/alertSettings.js')});
     const le = L.logSettingsLoadError(); A.getAlertSettings(); const ae = A.alertSettingsLoadError();
     const u = await import(${J('util/settingsLoadError.js')});
     const rows = u.listSettingsLoadErrors();
     console.log(JSON.stringify({ readError: !!le?.readError, alert: !!ae, alertRow: rows.find((x) => x.file === 'svcmon-alert.json')?.confirmable ?? null, logRow: rows.find((x) => x.file === 'svcmon-log.json')?.confirmable ?? null }));`);
  assert.equal(out.readError, true);
  assert.equal(out.logRow, false, '읽기 오류는 확정 불가(권한을 고쳐야 한다)');
  assert.ok(files.includes('svcmon-log.json'), '원본(디렉터리)을 옮기지 않았다');
  assert.equal(out.alert, true, '알림 설정 손상(수정 전: 조용히 enabled:false)');
  assert.equal(out.alertRow, true);
});

test('F4 — 단건 추가 · 수정의 (구분 · 경로 · 이름 소문자) 중복 검사 · 키를 바꾸지 않는 수정은 이미 있던 중복도 허용', async () => {
  const S = await import('../src/svcmon/store.js');
  const a = S.addTarget({ kind: 'infra', path: '법인A\\웹', name: 'web01', host: '10.1.1.1' });
  assert.throws(() => S.addTarget({ kind: 'infra', path: '법인A\\웹', name: 'WEB01', host: '10.1.1.2' }), /같은 이름의 대상/, '대소문자만 다른 이름도 거부(수정 전: 성공)');
  const other = S.addTarget({ kind: 'infra', path: '법인B\\웹', name: 'web01', host: '10.1.1.3' });
  assert.ok(other.id, '다른 폴더는 허용');
  const c = S.addTarget({ kind: 'infra', path: '법인A\\웹', name: 'web03', host: '10.1.1.4' });
  assert.throws(() => S.updateTarget(c.id, { name: 'Web01' }), /같은 이름의 대상/, '수정으로 겹치게 바꾸기 거부(수정 전: 성공)');
  assert.equal(S.updateTarget(a.id, { host: '10.1.1.9' }).host, '10.1.1.9', '자기 이름 유지 수정은 허용');
  // 이미 있던 중복(대량 dedup:false 로 들어간 것)은 키를 바꾸지 않는 수정까지 잠그지 않는다(27회차 D-6 교훈)
  const r = S.bulkAddTargets([{ kind: 'infra', path: '법인C', name: 'dup', host: '10.2.0.1' }, { kind: 'infra', path: '법인C', name: 'DUP', host: '10.2.0.2' }], { dedup: false });
  assert.equal(r.added, 2);
  const dupB = S.listTargets().find((t) => t.path === '법인C' && t.name === 'DUP');
  assert.equal(S.updateTarget(dupB.id, { enabled: false }).enabled, false);
});

test('F6 — batch 는 서버만 발급: 추가 · 수정 · 대량 행의 batch 는 무시 · 엣지 롤백(trustedBatch)만 행 태그 사용', async () => {
  const S = await import('../src/svcmon/store.js');
  const t = S.addTarget({ kind: 'service', path: 'F6', name: 'a', host: '10.3.0.1', batch: 'mock-demo' });
  assert.equal(t.batch, undefined, "수정 전: 'mock-demo' 저장 → live 폴러가 데모로 보고 건너뜀");
  const u = S.updateTarget(t.id, { batch: 'central:0123456789abcdef' });
  assert.equal(u.batch, undefined);
  const b = S.bulkAddTargets([{ kind: 'service', path: 'F6', name: 'b', host: '10.3.0.2', batch: 'b-someone1' }], { batch: 'b-mine' });
  assert.equal(b.added, 1);
  assert.equal(S.listTargets().find((x) => x.path === 'F6' && x.name === 'b').batch, 'b-mine', '행 batch 가 아니라 서버 태그');
  const back = S.bulkAddTargets([{ kind: 'service', path: 'F6', name: 'c', host: '10.3.0.3', batch: 'central:abc' }], { trustedBatch: true });
  assert.equal(back.added, 1);
  assert.equal(S.listTargets().find((x) => x.path === 'F6' && x.name === 'c').batch, 'central:abc', '엣지 롤백은 원래 태그를 되살린다');
  assert.match(rd('agent/svcmonConfigPull.js'), /bulkAddTargets\(snapshot, \{ atomic: true, dedup: true, trustedBatch: true \}\)/);
  assert.doesNotMatch(stripComments(rd('svcmon/store.js')), /text\(data\.batch/);
});

test('F5 · F12 — 엣지 보고 정제(아는 필드) · 비관리자 판본은 caps.portalPort · log.lastError 를 가린다 · expectMs/iv 범위', async () => {
  const E = await import('../src/central/svcmonEdge.js');
  const { redactEdgeSummary, ADMIN_ONLY_TEXT } = await import('../src/auth/scopeStatus.js');
  E.ingestReport('edge-f5', { snapId: 's1', seq: 1, total: 1, expectMs: 1e15, caps: { portalPort: 8443, anything: 'x'.repeat(100), pingMode: 'cli' }, log: { lastError: "EACCES '/data/svcmon-logs/results-20261115.csv'", written: '5' }, rows: [] });
  const a = E.getAgentRaw('edge-f5');
  assert.equal(a.caps.anything, undefined);
  assert.equal(a.log.written, 5);
  assert.equal(a.expectMs, E.EDGE_EXPECT_MS.max, '수정 전: 1e15 그대로 → 영원히 무보고 아님');
  assert.equal(a.expectMsRaw, 1e15, '원본은 따로');
  assert.ok(E.silenceLimitMs(a) <= 3 * E.EDGE_EXPECT_MS.max);
  const s = E.edgeSummary().find((x) => x.agent === 'edge-f5');
  const hid = redactEdgeSummary([s], false)[0];
  assert.equal(hid.caps.portalPort, null, '수정 전: 8443(최상위 portalPort 가림 무력)');
  assert.equal(hid.log.lastError, ADMIN_ONLY_TEXT, '수정 전: 파일 경로 원문');
  const full = redactEdgeSummary([s], true)[0];
  assert.equal(full.caps.portalPort, 8443); assert.match(full.log.lastError, /EACCES/);
  assert.match(rd('central/svcmonEdge.js'), /iv: \(\(\) => \{ const v = num\(m\?\.iv\); return v > 0 \? Math\.min\(EDGE_IV_SEC\.max, Math\.max\(EDGE_IV_SEC\.min, v\)\) : 60; \}\)\(\)/);
});

test('F10 — 비-HTTP 접속은 검증 lookup · dgram 은 이름만 검증(bind 주소 0.0.0.0 은 통과) · P1 만료일 해석 실패는 경고', async () => {
  const { dgramLookup } = await import('../src/svcmon/checker.js');
  const bind = await new Promise((r) => dgramLookup('0.0.0.0', 4, (e, addr) => r(e ? e.code : addr)));
  assert.equal(bind, '0.0.0.0', 'bind 주소가 막히면 UDP · NTP 점검이 전부 EADDRNOTAVAIL(실측)');
  const name = await new Promise((r) => dgramLookup('localhost', 4, (e, addr) => r(e ? e.code : addr)));
  assert.ok(name === 'ESSRFBLOCKED' || name === 'ENOTFOUND' || name === 'EAI_AGAIN', `루프백으로 풀리는 이름은 막는다: ${name}`);
  const src = stripComments(rd('svcmon/checker.js'));
  assert.match(src, /if \(!Number\.isFinite\(days\)\) return \{ status: 'warn', reply: '인증서 만료일 해석 실패', ms \};/);
});

test('F3 · F13 — 배정 삭제 확인창 · 문서 · 상태 문구가 실제 동작과 같다', () => {
  const assign = fs.readFileSync(path.join(WEB, 'views/svcmon/AssignTab.jsx'), 'utf8');
  assert.doesNotMatch(assign, /엣지에 이미 적용된 대상은 이 삭제로 지워지지 않습니다/);
  assert.match(assign, /이 중앙이 배포한 점검 대상\$\{n\}을 엣지에서 지웁니다/);
  const doc = fs.readFileSync(path.join(HERE, '../../docs/SVCMON-ARCHITECTURE.md'), 'utf8');
  assert.doesNotMatch(doc, /^- 배정 삭제는 엣지의 기존 정의를 지우지 않습니다/m);
  assert.doesNotMatch(doc, /^- \*\*개별 점검의 정상→실패 전이 알림은 없습니다\.\*\*/m);
  assert.match(rd('agent/svcmonConfigPull.js'), /deleteTargetsByBatch\(tag\)/, '문구의 근거(배정 해제 시 central:* 삭제)가 아직 있다');
  assert.doesNotMatch(rd('central/svcmonSilence.js'), /전이 알림은 아직 없습니다/);
});

test('27 D-2 — 409(설정 파일 손상 중 거절)를 성공으로 보이지 않게: 스토리지 증가량 · CVP 설정 · IPAM CSV 적용', () => {
  for (const [f, re] of [
    ['views/tools/StorageGrowthTool.jsx', /requireChanged\(await postJson\('\/tools\/storage-growth\/settings'/],
    ['views/tools/CvpTool.jsx', /requireChanged\(await putJson\('\/tools\/cvp\/settings'/],
    ['views/tools/IpamCsv.jsx', /results\.push\(requireChanged\(await postJson\('\/tools\/ipam\/manage\/import'/],
  ]) assert.match(fs.readFileSync(path.join(WEB, f), 'utf8'), re, f);
});

test('27 D-6 — 수정 중복 검사는 키가 바뀔 때만(이미 있던 중복 두 대가 잠기지 않게) · SAN 은 상대 스위치를 밝힌다', () => {
  const { out } = sub((d) => {
    fs.writeFileSync(path.join(d, 'sanswitch-devices.json'), JSON.stringify({ devices: [
      { id: 'sw-a', type: 'brocade', name: 'SW-A', host: 'SW1.corp.local', username: 'admin' },
      { id: 'sw-b', type: 'brocade', name: 'SW-B', host: 'sw1.corp.local', username: 'admin' },
      { id: 'sw-c', type: 'brocade', name: 'SW-C', host: 'sw9.corp.local', username: 'admin' }] }));
    fs.writeFileSync(path.join(d, 'storage-devices.json'), JSON.stringify({ devices: [
      { id: 'st-a', type: 'powerstore', name: 'A', host: '10.9.9.1', username: 'admin' },
      { id: 'st-b', type: 'powerstore', name: 'B', host: '10.9.9.1', username: 'admin' }] }));
  }, `const SW = await import(${J('sanswitch/registry.js')}); const ST = await import(${J('storage/registry.js')});
     const r = {};
     try { r.sanKeep = SW.saveDevice({ id: 'sw-b', type: 'brocade', name: 'SW-B2', host: 'sw1.corp.local', username: 'admin' }).name; } catch (e) { r.sanKeep = 'ERR ' + e.message; }
     try { SW.saveDevice({ id: 'sw-c', type: 'brocade', name: 'SW-C', host: 'SW1.CORP.LOCAL', username: 'admin' }); r.sanMove = 'ok'; } catch (e) { r.sanMove = e.message; }
     try { r.stKeep = ST.saveDevice({ id: 'st-b', type: 'powerstore', name: 'B2', host: '10.9.9.1', username: 'admin' }).name; } catch (e) { r.stKeep = 'ERR ' + e.message; }
     console.log(JSON.stringify(r));`);
  assert.equal(out.sanKeep, 'SW-B2', '수정 전: 둘 다 잠겨 비활성화 · 이름 저장도 거부');
  assert.match(out.sanMove, /같은 host 의 스위치가 이미 등록되어 있습니다 — 'SW-A'/, '다른 스위치로 겹치게 바꾸는 수정은 거부 + 상대 이름');
  assert.equal(out.stKeep, 'B2');
  assert.match(rd('cvp/registry.js'), /const keyChanged = !existing \|\| baseUrlOf\(existing\.host\)\.base !== baseUrlOf\(f\.host\)\.base \|\| !agentKeyEq\(existing\.agent, srv\.agent\);/);
});

test('27 D-8 — 배정 파일 손상 중에는 vCenter 대역 자동 이전을 시작하지 않는다(failed + done 으로 굳지 않게)', () => {
  const { out, files } = sub((d) => {
    fs.writeFileSync(path.join(d, 'ipam-scan.json'), '{"agents":{"edge-a":');
    fs.writeFileSync(path.join(d, 'ipam-vcenter-ranges.json'), JSON.stringify({ vcenters: { vcA: { ranges: ['10.0.0.0/24'] } } }));
  }, `const M = await import(${J('ipam/vcRangeMigrate.js')});
     const r = M.runVcRangeMigration();
     console.log(JSON.stringify({ ran: r.ran, reason: r.reason || null, state: M.readMigrationState() }));`);
  assert.equal(out.ran, false);
  assert.match(out.reason, /배정 파일을 읽지 못해/);
  assert.equal(out.state?.done ?? null, null, "상태를 'done' 으로 쓰지 않았다");
  assert.ok(!files.some((f) => /vcrange-migration|v2\.691/.test(f) && !f.endsWith('.bak')), files.join(','));
});

test('27 D-9 — 일 요약: 용량은 짝이 되는 사용량과 같은 관측일 때만 바꾼다(다른 시점의 total · used 가 섞이지 않게)', async () => {
  const db = await import('../src/storage/db.js');
  const day0 = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
  const r1 = await db.saveCapacityPoint({ deviceId: 'dev-d9', ok: true, capacity: { totalBytes: 100e12, usedBytes: 90e12 }, collectedAt: day0 + 3 * 3_600_000 });   // S-6 과 같은 시각(포탈 하루 경계 안)
  if (r1.reason === 'db-unavailable') return;
  await db.saveCapacityPoint({ deviceId: 'dev-d9', ok: true, capacity: { totalBytes: 50e12, usedBytes: null }, collectedAt: day0 + 6 * 3_600_000 });
  const rows = await db.dailySeries('dev-d9', 0);
  const last = rows[rows.length - 1];
  const total = Number(last.total_bytes ?? last.totalBytes); const used = Number(last.used_bytes ?? last.usedBytes);
  assert.equal(used, 90e12);
  assert.equal(total, 100e12, `수정 전: total 50T · used 90T(180%) ${JSON.stringify(last)}`);
});

/* ── 28회차(26 · 27회차 수정 반증) ── */
test('28 N-1 · N-2 · N-3 — 로그 설정 확정은 총량 무제한 · null/[]/0 도 손상 · 손상 중에는 CSV 기록을 멈춘다', () => {
  for (const body of ['null', '[]', '0']) {
    const { out } = sub((d) => {
      fs.writeFileSync(path.join(d, 'svcmon-log.json'), body);
      const ld = path.join(d, 'svcmon-logs'); fs.mkdirSync(ld);
      const t0 = Date.now() - 400 * 86_400_000;
      for (let i = 0; i < 120; i += 1) { const f = path.join(ld, `results-2025${String(i).padStart(4, '0')}.csv`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, new Date(t0 + i * 86_400_000), new Date(t0 + i * 86_400_000)); }
    }, `const L = await import(${J('svcmon/logsettings.js')}); const C = await import(${J('svcmon/csvlog.js')});
       const err = !!L.logSettingsLoadError(); const removed = C.pruneOld(L.logDir(), L.getLogSettings());
       C.appendResult({ ts: Date.now(), target: { path: 'p', name: 'n', host: 'h' }, test: { name: 't', type: 'tcp' }, result: { status: 'ok', reply: 'r' }, changed: true });
       const paused = C.logStats().pausedUnreadable || 0; const buffered = C.logStats().buffered;
       const u = await import(${J('util/settingsLoadError.js')});
       const c = u.confirmSettingsDefault('svcmon-log.json', { by: 't' });
       const s = L.getLogSettings();
       console.log(JSON.stringify({ err, removed, paused, buffered, conf: c.ok, keep: s.keepFiles, total: s.maxTotalMB }));`);
    assert.equal(out.err, true, `${body}: 손상(수정 전: 조용히 기본 90개)`);
    assert.equal(out.removed, 0, body);
    assert.equal(out.paused, 1, `${body}: 손상 중 기록 멈춤(수정 전: 기본 위치에 총량 상한 없이 쌓임)`);
    assert.equal(out.buffered, 0);
    assert.equal(out.conf, true);
    assert.equal(out.keep, 3650);
    assert.equal(out.total, 0, `${body}: 확정은 총량 무제한(수정 전: 51200 — 확정 직후 정리가 이력을 지웠다)`);
  }
});

test('28 N-5 · N-6 — 점검 lookup 은 점검 시한 · 차단 사유를 결과에 · 같은 이름 경고는 한 번', async () => {
  const C = await import('../src/svcmon/checker.js');
  assert.equal(C.checkLookup(4000), C.checkLookup(4000), '시한별 lookup 재사용');
  assert.notEqual(C.checkLookup(4000), C.checkLookup(6000));
  const warns = []; const orig = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const rs = [];
    for (let i = 0; i < 3; i += 1) rs.push(await C.runCheck({ id: `n5-${i}`, type: 'tcp', port: 9 }, 'localhost'));
    const blocked = rs.filter((r) => /차단된 대상/.test(r.reply)).length;
    const notFound = rs.filter((r) => /이름 해석/.test(r.reply)).length;
    assert.ok(blocked === 3 || notFound === 3, `차단 · 해석 실패 사유가 결과 문구에 있다: ${rs.map((r) => r.reply).join(' | ')}`);
    assert.ok(warns.filter((w) => /\[ssrf\]/.test(w) && /localhost/.test(w)).length <= 1, `같은 이름 경고는 한 줄: ${warns.length}`);
  } finally { console.warn = orig; }
});

test('28 N-7 · P-3 · P-4 · P-5 — 유예 중 엣지는 따로 · 알림 설정 손상 표시 · 대역 이전 보류 사유 · 확정 문구', () => {
  const edge = stripComments(rd('central/svcmonEdge.js'));
  assert.match(edge, /if \(s\.assignedOnly\) \{ if \(s\.awaitingFirstReport\) t\.awaitingFirstReport \+= 1; else t\.assignedNoReport \+= 1; continue; \}/);
  assert.match(rd('routes/svcmon/settingsSync.js'), /\.\.\.\(le \? \{ loadError: \{ at: le\.at, reason: le\.reason \} \} : \{\}\)/);
  assert.match(fs.readFileSync(path.join(WEB, 'views/svcmon/AlertTab.jsx'), 'utf8'), /\{d\.loadError \?/);
  assert.match(rd('routes/admin/centralIpam.js'), /else if \(r\.reason\) held = String\(r\.reason\)\.slice\(0, 300\);/);
  assert.match(fs.readFileSync(path.join(WEB, 'views/tools/ScanRangeMigration.jsx'), 'utf8'), /\{m\.held \?/);
});
