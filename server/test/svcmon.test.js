/**
 * 성능점검(svcmon) — 저장소·폴더·체커·워커풀·CSV 로그·부하 특성 검증.
 * 임시 CONFIG_DIR 을 쓰며 외부 네트워크에 의존하지 않는다(로컬 리스너만).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-'));
process.env.SVCMON_WORKERS = '0';        // 테스트는 인라인 폴백 경로로(워커 기동 시간 절약)

const store = await import('../src/svcmon/store.js');
const { runCheck, DEFAULT_PORTS } = await import('../src/svcmon/checker.js');
const poller = await import('../src/svcmon/poller.js');
const csvlog = await import('../src/svcmon/csvlog.js');
const logset = await import('../src/svcmon/logsettings.js');

/* ── 저장소 검증 ── */
test('addTarget: 이름/경로/호스트 검증 + SSRF 차단(루프백·링크로컬)', () => {
  assert.throws(() => store.addTarget({ path: 'A', name: '', host: '10.0.0.1' }), /이름/);
  assert.throws(() => store.addTarget({ path: 'A', name: 't', host: 'bad host;rm' }), /호스트 형식/);
  assert.throws(() => store.addTarget({ path: 'A', name: 't', host: '127.0.0.1' }), /차단/);
  assert.throws(() => store.addTarget({ path: 'A', name: 't', host: '169.254.169.254' }), /차단/);
  const t = store.addTarget({ path: 'B.Service\\SBP\\01.HQ', name: 'SBP_Admin01', host: '192.168.10.55' });
  assert.ok(t.id);
  assert.equal(t.kind, 'infra');
});

test('대상 추가 시 경로의 모든 폴더가 자동 등록된다(트리에 즉시 보이게)', () => {
  const paths = store.listFolders().filter((f) => f.kind === 'infra').map((f) => f.path);
  assert.ok(paths.includes('B.Service'));
  assert.ok(paths.includes('B.Service\\SBP'));
  assert.ok(paths.includes('B.Service\\SBP\\01.HQ'));
});

test('폴더 CRUD: 빈 폴더 생성·이름변경(하위 경로 일괄)·비어있지 않으면 삭제 거부', () => {
  const f = store.addFolder({ kind: 'infra', path: 'A.Infrastructure\\Region Network' });
  assert.ok(f.id);
  assert.throws(() => store.addFolder({ kind: 'infra', path: 'A.Infrastructure\\Region Network' }), /이미 있는/);
  assert.throws(() => store.addFolder({ kind: 'infra', path: 'bad\\seg:name' }), /쓸 수 없는 문자|형식/);

  // 이름 변경 — 하위 폴더/대상 경로가 함께 바뀌어야 한다
  store.addTarget({ kind: 'infra', path: 'A.Infrastructure\\Region Network', name: 'KR-Seoul', host: '192.168.1.1' });
  const r = store.renameFolder({ kind: 'infra', path: 'A.Infrastructure\\Region Network', newName: 'Region-NET' });
  assert.equal(r.path, 'A.Infrastructure\\Region-NET');
  assert.ok(store.listTargets().some((t) => t.path === 'A.Infrastructure\\Region-NET' && t.name === 'KR-Seoul'));

  // 대상이 있으면 삭제 거부(강제 시 함께 삭제)
  assert.throws(() => store.deleteFolder({ kind: 'infra', path: 'A.Infrastructure\\Region-NET' }), /대상 1개/);
  const del = store.deleteFolder({ kind: 'infra', path: 'A.Infrastructure\\Region-NET', force: true });
  assert.equal(del.removedTargets, 1);
  assert.ok(!store.listTargets().some((t) => t.name === 'KR-Seoul'));
});

test('정렬 모드 저장 — kind 별로 독립', () => {
  const s1 = store.setSort({ kind: 'infra', mode: 'name' });
  assert.equal(s1.infra, 'name');
  assert.equal(s1.service, 'manual');
});

test('점검 CRUD: 유형별 필수값·기본 포트·SSRF·주기 하한', () => {
  const target = store.listTargets().find((t) => t.name === 'SBP_Admin01');
  assert.throws(() => store.addTest(target.id, { name: 'x', type: 'tcp', port: 0 }), /포트/);
  assert.throws(() => store.addTest(target.id, { name: 'x', type: 'http' }), /URL/);
  assert.throws(() => store.addTest(target.id, { name: 'x', type: 'http', url: 'http://127.0.0.1/' }), /차단/);
  const smtp = store.addTest(target.id, { name: 'SMTP', type: 'smtp' });
  assert.equal(smtp.port, DEFAULT_PORTS.smtp, '포트 미지정 시 유형 기본 포트가 채워져야 함');
  const ping = store.addTest(target.id, { name: 'Ping', type: 'ping', intervalSec: 1 });
  assert.equal(ping.intervalSec, 10, '주기 하한 10초로 클램프');
  assert.equal(store.deleteTest(target.id, ping.id), true);
});

test('storeRevision: 변경마다 증가(폴러 인덱스 재구성 신호)', () => {
  const before = store.storeRevision();
  store.setSort({ kind: 'service', mode: 'name' });
  assert.ok(store.storeRevision() > before);
});

test('저장 파일 왕복 — 디바운스 flush 후 캐시를 비워도 유지', () => {
  store.flushStore();
  const before = store.listTargetsCopy().length;
  const folders = store.listFolders().length;
  store._resetCache();
  assert.equal(store.listTargetsCopy().length, before);
  assert.equal(store.listFolders().length, folders);
});

test('bulkAddTargets: 대량 등록 1회 저장 + 행별 오류 리포트', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    kind: 'infra', path: 'B.Service\\Bulk', name: `srv-${i}`, host: `10.20.${Math.floor(i / 254)}.${(i % 254) + 1}`,
    tests: [{ name: 'Ping', type: 'ping', intervalSec: 60 }],
  }));
  rows.push({ kind: 'infra', path: 'B.Service\\Bulk', name: 'bad', host: '127.0.0.1' }); // 루프백 → 거부
  const r = store.bulkAddTargets(rows);
  assert.equal(r.added, 300);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /차단/);
  assert.ok(store.totalTests() >= 300);
});

/* ── 체커 ── */
test('checker tcp: 로컬 리스너 열림/닫힘 실측', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  assert.equal((await runCheck({ type: 'tcp', port }, '127.0.0.1')).status, 'ok');
  srv.close();
  assert.equal((await runCheck({ type: 'tcp', port }, '127.0.0.1')).status, 'bad');
});

test('checker 배너: 기대 패턴 일치=ok, 불일치=warn (SMTP 모사 리스너)', async () => {
  const good = net.createServer((s) => s.write('220 mail.example.com ESMTP ready\r\n')).listen(0, '127.0.0.1');
  await new Promise((r) => good.once('listening', r));
  const okRes = await runCheck({ type: 'smtp', port: good.address().port }, '127.0.0.1');
  assert.equal(okRes.status, 'ok');
  assert.match(okRes.reply, /^220 /);
  good.close();

  const junk = net.createServer((s) => s.write('HELLO WRONG PROTOCOL\r\n')).listen(0, '127.0.0.1');
  await new Promise((r) => junk.once('listening', r));
  const warnRes = await runCheck({ type: 'smtp', port: junk.address().port }, '127.0.0.1');
  assert.equal(warnRes.status, 'warn');
  junk.close();
});

test('checker http: 실행 직전 SSRF 재검증(루프백 차단)', async () => {
  const r = await runCheck({ type: 'http', url: 'http://127.0.0.1:9/' }, 'x');
  assert.equal(r.status, 'bad');
  assert.match(r.reply, /차단/);
});

test('checker 알 수 없는 유형은 bad 로 격리(예외 전파 없음)', async () => {
  const r = await runCheck({ type: 'nope' }, '10.0.0.1');
  assert.equal(r.status, 'bad');
});

/* ── 폴러 / 부하 특성 ── */
test('poller: 만기 인덱싱으로 실행·streak 증가·재진입 가드', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const target = store.listTargets().find((t) => t.name === 'SBP_Admin01');
  const t = store.addTest(target.id, { name: 'poll-tcp', type: 'tcp', port: srv.address().port, intervalSec: 10 });
  assert.equal(await poller.runNow(), true);
  const r1 = poller.getResults().get(t.id);
  assert.ok(r1, '결과 적재');
  assert.equal(r1.streak, 1);
  assert.equal(await poller.runNow(), true);
  assert.equal(poller.getResults().get(t.id).streak, 2, '같은 상태 연속 → streak 증가');
  srv.close();
});

test('poller: 틱당 상한(MAX_PER_TICK)과 통계 노출 — 대규모에서 폭주하지 않게', async () => {
  const st = poller.pollerStats();
  assert.ok(st.maxPerTick >= 100);
  assert.ok(st.items > 300, `인덱스에 대량 항목이 올라와야 함(현재 ${st.items})`);
  assert.equal(typeof st.pool.workers, 'number');
});

/* ── CSV 로그 ── */
test('csvlog: 분할 파일명 규칙(시간/일/주/월/분기 + 크기 파트)', () => {
  const ts = new Date('2026-08-07T14:23:00+09:00').getTime();
  assert.match(csvlog.fileNameFor(ts, 'hour'), /^results-\d{8}-\d{2}\.csv$/);
  assert.match(csvlog.fileNameFor(ts, 'day'), /^results-\d{8}\.csv$/);
  assert.match(csvlog.fileNameFor(ts, 'week'), /^results-\d{4}-W\d{2}\.csv$/);
  assert.match(csvlog.fileNameFor(ts, 'month'), /^results-\d{6}\.csv$/);
  assert.match(csvlog.fileNameFor(ts, 'quarter'), /^results-\d{4}Q[1-4]\.csv$/);
  assert.equal(csvlog.fileNameFor(ts, 'day', 3), csvlog.fileNameFor(ts, 'day').replace('.csv', '-p03.csv'));
});

test('csvlog: 대량 적재가 동기 블로킹 없이 처리되고 BOM+헤더가 붙는다', async () => {
  logset.setLogSettings({ enabled: true, mode: 'all', rotate: 'day', keepFiles: 5 });
  const target = { path: 'B.Service\\X', name: 'srv', host: '10.0.0.9' };
  const t0 = Date.now();
  for (let i = 0; i < 20000; i += 1) {
    csvlog.appendResult({
      ts: Date.now(), target, test: { name: `chk-${i}`, type: 'ping' },
      result: { status: 'ok', reply: '1 ms', ms: 1, streak: i }, changed: i === 0,
    });
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `2만 행 push 가 ${elapsed}ms — 동기 I/O 였다면 훨씬 느리다`);
  csvlog.closeCsvLog();                       // 잔여 버퍼 flush
  await new Promise((r) => setTimeout(r, 300));
  const dir = logset.logDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
  assert.ok(files.length >= 1, 'CSV 파일이 생성되어야 함');
  const head = fs.readFileSync(path.join(dir, files[0]), 'utf8').slice(0, 200);
  assert.ok(head.startsWith('﻿'), 'UTF-8 BOM(엑셀 한글)');
  assert.ok(head.includes('시각,경로,대상,호스트,점검명'), '헤더 열 구성');
  const stats = csvlog.logStats();
  assert.ok(stats.written >= 20000);
});

test('csvlog: 상태 변화만 기록 모드', async () => {
  const dir = logset.logDir();
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  logset.setLogSettings({ mode: 'changes' });
  const target = { path: 'P', name: 'n', host: '10.0.0.1' };
  csvlog.appendResult({ ts: Date.now(), target, test: { name: 'a', type: 'ping' }, result: { status: 'ok', reply: 'x' }, changed: false });
  csvlog.closeCsvLog();
  await new Promise((r) => setTimeout(r, 200));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
  assert.equal(files.length, 0, 'changed=false 는 기록하지 않아야 함');
  logset.setLogSettings({ mode: 'all' });
});

test('csvlog: 보관 파일 수 초과분 삭제 + 경로 탈출 차단', () => {
  const dir = logset.logDir();
  for (const n of ['results-20260101.csv', 'results-20260102.csv', 'results-20260103.csv']) {
    fs.writeFileSync(path.join(dir, n), 'x');
  }
  const removed = csvlog.pruneOld(dir, { keepFiles: 1, maxTotalMB: 0 });
  assert.ok(removed >= 2);
  assert.equal(csvlog.logFilePath('../../etc/passwd'), null);
  assert.equal(csvlog.logFilePath('results-20260103.csv') !== null, true);
});

test('로그 설정 정규화: 분할 단위 화이트리스트·수치 클램프', () => {
  const s = logset.setLogSettings({ rotate: 'nope', keepFiles: 99999, maxFileMB: 1, maxTotalMB: 5 });
  assert.equal(s.rotate, 'day');
  assert.equal(s.keepFiles, 3650);
  assert.equal(s.maxFileMB, 8, '최소 8MB 로 클램프');
  assert.equal(s.maxTotalMB, 100, '최소 100MB 로 클램프');
});
