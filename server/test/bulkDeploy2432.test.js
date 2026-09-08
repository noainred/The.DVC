/**
 * v2.432 — Edge 노드 대량 배포: 텍스트 파싱(헤더/위치/구분자·공통 기본값)·검증·텍스트 왕복 내보내기 +
 * 잡 실행기(동시성·저장 없이 배포·성공분만 저장·취소·타임아웃·재진입 가드·비밀 무노출) + 라우트.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk2432-'));
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const DEFAULTS = { username: 'root', password: 'CommonPw!', centralUrl: 'http://192.168.20.143:4000', portalPort: '4000' };

test('deployText.parseTargetsText: 헤더 없는 위치 형식 + 공통 기본값 병합 + host:port 축약 + 주석/빈 줄', async () => {
  const { parseTargetsText } = await import('../src/agent/deployText.js');
  const text = [
    '# 주석은 무시',
    '10.112.158.221\tAZ\t',
    '10.113.158.221\tGM1\tops\tRowPw1',
    '10.114.158.221:2222\tGM2',
    '',
    '   ',
  ].join('\n');
  const { rows, skipped } = parseTargetsText(text, DEFAULTS);
  assert.equal(rows.length, 3); assert.equal(skipped.length, 0);
  assert.equal(rows[0].host, '10.112.158.221'); assert.equal(rows[0].username, 'root', '공통 계정 사용');
  assert.equal(rows[0].password, 'CommonPw!', '공통 비밀번호 사용');
  assert.equal(rows[0].agentName, 'AZ'); assert.equal(rows[0].collectorDatacenter, 'AZ', '이름↔법인 상호 보완');
  assert.equal(rows[0].centralUrl, 'http://192.168.20.143:4000');
  assert.equal(rows[1].username, 'ops'); assert.equal(rows[1].password, 'RowPw1', '행 값이 공통값보다 우선');
  assert.equal(rows[2].port, '2222', 'host:port 축약');
  assert.equal(rows[0].port, '22', '기본 SSH 포트');
});

test('deployText.parseTargetsText: 헤더 인식(별칭·열 순서 자유) / 공백 구분 / 잘못된 행 skipped', async () => {
  const { parseTargetsText } = await import('../src/agent/deployText.js');
  const h = parseTargetsText('법인\tip\t계정\t포탈포트\nAZ\t10.1.1.1\tadmin\t4100\n', DEFAULTS);
  assert.ok(h.header, '헤더로 인식');
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].host, '10.1.1.1'); assert.equal(h.rows[0].username, 'admin');
  assert.equal(h.rows[0].collectorDatacenter, 'AZ'); assert.equal(h.rows[0].portalPort, '4100');
  // 공백 구분(탭·쉼표가 없을 때만)
  const sp = parseTargetsText('10.2.2.2   AZ   root\n10.3.3.3 GM1 root\n', DEFAULTS);
  assert.deepEqual(sp.rows.map((r) => r.host), ['10.2.2.2', '10.3.3.3']);
  // host 가 비면 건너뛰고 사유를 남긴다
  const bad = parseTargetsText('\t\tAZ\n10.4.4.4\tOK\n', DEFAULTS);
  assert.equal(bad.rows.length, 1); assert.equal(bad.skipped.length, 1);
  assert.match(bad.skipped[0].reason, /host/);
  // 헤더가 host 하나만 있으면 데이터 행으로 본다(오인 방지)
  const one = parseTargetsText('host\n10.5.5.5\tAZ\n', DEFAULTS);
  assert.equal(one.header, null); assert.equal(one.rows[0].host, 'host');
});

test('deployText.analyzeBulkDeploy: 자격증명 없음·중복·SSRF 차단·문법 오류 판정, 응답에 비밀 없음', async () => {
  const { parseTargetsText, analyzeBulkDeploy } = await import('../src/agent/deployText.js');
  const { ipBlockReason } = await import('../src/collector/registry.js');
  const text = ['10.1.1.1\tAZ', '10.1.1.1\tAZ', '169.254.169.254\tMETA', '10.2.2.2\tGM1'].join('\n');
  const { rows } = parseTargetsText(text, { username: 'root', password: 'pw' });
  const { report, summary } = analyzeBulkDeploy(rows, { existingId: (h) => (h === '10.2.2.2' ? 'id-1' : undefined), blockReason: ipBlockReason });
  assert.equal(summary.ready, 2); assert.equal(summary.error, 2);
  assert.match(report[1].reason, /중복/);
  assert.match(report[2].reason, /링크로컬|메타데이터/);
  assert.equal(report[3].existing, true, '기존 저장 대상은 known 으로 표시');
  assert.equal(summary.known, 1); assert.equal(summary.new, 1);
  assert.equal(JSON.stringify(report).includes('pw"'), false);
  for (const r of report) assert.equal(r.password, undefined, '판정 결과에 비밀 필드 없음');
  assert.equal(report[0].auth, 'password', '방식만 표시');
  // 자격증명이 아예 없으면 오류
  const none = analyzeBulkDeploy(parseTargetsText('10.9.9.9\tAZ', { username: 'root' }).rows, {});
  assert.match(none.report[0].reason, /비밀번호\/개인키/);
});

test('deployText.targetsToText ↔ parseTargetsText 왕복(비밀 제외가 기본)', async () => {
  const { targetsToText, parseTargetsText } = await import('../src/agent/deployText.js');
  const list = [{ host: '10.1.1.1', port: 22, username: 'root', agentName: 'AZ', collectorDatacenter: 'AZ', centralUrl: 'http://c:4000', portalPort: 4000, password: 'SECRET', autoUpgrade: true, pushInventory: true, enabled: true }];
  const txt = targetsToText(list);
  assert.equal(txt.includes('SECRET'), false, '기본 내보내기에 비밀 없음');
  assert.equal(targetsToText(list, { includeSecrets: true }).includes('SECRET'), true);
  const { rows } = parseTargetsText(txt, { password: 'FromForm' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, '10.1.1.1'); assert.equal(rows[0].agentName, 'AZ'); assert.equal(rows[0].portalPort, '4000');
  assert.equal(rows[0].password, 'FromForm', '비운 비밀 열은 공통 자격증명으로 채워진다');
});

test('bulkDeploy: 저장 없이 배포 → 성공분만 저장, 실패는 레지스트리 미오염, 동시성 준수, 비밀 무노출', async () => {
  const bulk = await import('../src/agent/bulkDeploy.js');
  const { parseTargetsText } = await import('../src/agent/deployText.js');
  const reg = await import('../src/agent/deployRegistry.js');
  bulk._resetForTest();
  const before = reg.listTargets().length;
  let peak = 0, cur = 0; const seen = [];
  const deploy = async (target) => {
    cur++; peak = Math.max(peak, cur); seen.push({ host: target.host, hasPw: !!target.password, hasSignal: !!target.signal });
    await new Promise((r) => setTimeout(r, 20));
    cur--;
    return target.host === '10.0.0.2' ? { ok: false, reason: 'install.sh 실패' } : { ok: true, active: 'active', installer: 'pkg.tar.gz' };
  };
  const { rows } = parseTargetsText('10.0.0.1\tAZ\n10.0.0.2\tGM1\n10.0.0.3\tGM2\n', { username: 'root', password: 'pw', portalPort: '4000' });
  const started = bulk.startBulkDeploy(rows, { deploy, concurrency: 2, saveTargets: true, registerCollector: false, by: 'tester' });
  assert.equal(started.ok, true);
  // 진행 중 재진입 거부
  assert.equal(bulk.startBulkDeploy(rows, { deploy }).ok, false);
  let run = bulk.getRun(started.runId);
  assert.equal(run.status, 'running');
  while (bulk.getRun(started.runId).status === 'running') await new Promise((r) => setTimeout(r, 10));
  run = bulk.getRun(started.runId);
  assert.equal(run.status, 'done');
  assert.equal(run.counts.ok, 2); assert.equal(run.counts.fail, 1);
  assert.ok(peak <= 2, `동시 실행이 2 이하 (실측 ${peak})`);
  assert.ok(seen.every((s) => s.hasPw && s.hasSignal), 'deployAgent 에 자격증명과 취소 signal 이 전달된다');
  assert.equal(JSON.stringify(run).includes('"pw"'), false, '잡 조회 응답에 비밀 없음');
  for (const it of run.items) { assert.equal(it.password, undefined); assert.equal(it._row, undefined); }
  const after = reg.listTargets();
  assert.equal(after.length, before + 2, '성공한 2대만 저장(실패 1대는 미저장)');
  assert.equal(after.some((t) => t.host === '10.0.0.2'), false);
  assert.equal(run.items.find((i) => i.host === '10.0.0.1').saved.saved, true);
});

test('bulkDeploy: saveTargets=false 면 저장하지 않는다(입력 전 배포) / 취소 / 노드 타임아웃', async () => {
  const bulk = await import('../src/agent/bulkDeploy.js');
  const { parseTargetsText } = await import('../src/agent/deployText.js');
  const reg = await import('../src/agent/deployRegistry.js');
  bulk._resetForTest();
  const before = reg.listTargets().length;
  const quick = async () => ({ ok: true, active: 'active' });
  const { rows } = parseTargetsText('10.0.1.1\tAZ\n', { username: 'root', password: 'pw' });
  const a = bulk.startBulkDeploy(rows, { deploy: quick, saveTargets: false, registerCollector: false });
  while (bulk.getRun(a.runId).status === 'running') await new Promise((r) => setTimeout(r, 10));
  assert.equal(bulk.getRun(a.runId).counts.ok, 1);
  assert.equal(reg.listTargets().length, before, 'saveTargets=false 면 레지스트리 불변');

  // 취소 — signal 이 실제로 전달되고 큐에 남은 항목은 cancelled
  bulk._resetForTest();
  const slow = (target) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: true, active: 'active' }), 5000);
    target.signal?.addEventListener('abort', () => { clearTimeout(t); resolve({ ok: false, reason: '중단' }); }, { once: true });
  });
  const many = parseTargetsText('10.0.2.1\tA\n10.0.2.2\tB\n10.0.2.3\tC\n', { username: 'root', password: 'pw' }).rows;
  const c = bulk.startBulkDeploy(many, { deploy: slow, concurrency: 1, saveTargets: false, registerCollector: false });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bulk.cancelRun(c.runId).ok, true);
  while (bulk.getRun(c.runId).status === 'running') await new Promise((r) => setTimeout(r, 10));
  const cr = bulk.getRun(c.runId);
  assert.equal(cr.status, 'cancelled');
  assert.equal(cr.counts.cancelled, 3, '실행 중 1 + 대기 2 전부 취소');
  assert.equal(bulk.cancelRun(c.runId).ok, false, '이미 끝난 실행은 취소 불가');

  // 노드 타임아웃 — 기한이 지나면 signal 로 끊고 사유를 남긴다
  bulk._resetForTest();
  const hang = (target) => new Promise((resolve) => {
    target.signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }), { once: true });
  });
  const t1 = bulk.startBulkDeploy(parseTargetsText('10.0.3.1\tA\n', { username: 'root', password: 'pw' }).rows,
    { deploy: hang, timeoutMs: 10_000, saveTargets: false, registerCollector: false });
  while (bulk.getRun(t1.runId).status === 'running') await new Promise((r) => setTimeout(r, 20));
  const tr = bulk.getRun(t1.runId);
  assert.equal(tr.counts.fail, 1);
  assert.match(tr.items[0].reason, /타임아웃/);
});

test('bulkDeploy: SSRF 차단 호스트는 접속 시도 없이 실패, 500대 상한', async () => {
  const bulk = await import('../src/agent/bulkDeploy.js');
  bulk._resetForTest();
  let called = 0;
  const deploy = async () => { called++; return { ok: true, active: 'active' }; };
  const r = bulk.startBulkDeploy([{ _line: 1, host: '169.254.169.254', port: 22, username: 'root', password: 'pw' }],
    { deploy, saveTargets: false, registerCollector: false });
  while (bulk.getRun(r.runId).status === 'running') await new Promise((x) => setTimeout(x, 10));
  assert.equal(called, 0, 'SSRF 차단 호스트에는 SSH 를 시도하지 않는다');
  assert.match(bulk.getRun(r.runId).items[0].reason, /링크로컬|메타데이터/);
  bulk._resetForTest();
  const big = Array.from({ length: 501 }, (_, i) => ({ _line: i, host: `10.9.${Math.floor(i / 256)}.${i % 256}`, username: 'root', password: 'p' }));
  assert.match(bulk.startBulkDeploy(big, { deploy }).reason, /최대 500/);
});

test('routes: bulk preview(오류 표시·비밀 무반환) / run(오류 행 제외) / 조회 / 취소 / 텍스트 내보내기', async () => {
  const express = (await import('express')).default;
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const bulk = await import('../src/agent/bulkDeploy.js');
  bulk._resetForTest();
  const app = express(); app.use(express.json({ limit: '2mb' }));
  const r = express.Router(); registerDeployLlm(r); app.use('/api/admin', r);
  const srv = app.listen(0); await new Promise((x) => srv.once('listening', x));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const text = '10.20.0.1\tAZ\n169.254.169.254\tBAD\n10.20.0.1\tDUP\n';
    let j = await (await post('/agent-deploy/bulk/preview', { text, defaults: { username: 'root', password: 'SECRETPW' } })).json();
    assert.equal(j.ok, true); assert.equal(j.total, 3);
    assert.equal(j.summary.ready, 1); assert.equal(j.summary.error, 2);
    assert.equal(JSON.stringify(j).includes('SECRETPW'), false, '미리보기 응답에 비밀 없음');

    // 설치 패키지가 없는 환경이므로 실제 배포는 deployAgent 가 즉시 실패한다 — 잡이 생성되고
    // 오류 행이 제외되는지(1대만 큐잉)를 확인한다.
    j = await (await post('/agent-deploy/bulk/run', { text, defaults: { username: 'root', password: 'SECRETPW' }, saveTargets: false, registerCollector: false })).json();
    assert.equal(j.ok, true); assert.equal(j.total, 1, '오류 2행은 제외');
    assert.equal(j.skippedErrors, 2);
    const runId = j.runId;
    const view = await (await fetch(`${base}/agent-deploy/bulk/${runId}`)).json();
    assert.equal(view.runId, runId);
    assert.equal(JSON.stringify(view).includes('SECRETPW'), false, '잡 조회 응답에 비밀 없음');
    const listed = await (await fetch(`${base}/agent-deploy/bulk`)).json();
    assert.equal(listed.runs[0].runId, runId);
    assert.equal((await fetch(`${base}/agent-deploy/bulk/nope`)).status, 404);
    // 배포 가능한 행이 없으면 400
    const none = await post('/agent-deploy/bulk/run', { text: '169.254.169.254\tBAD\n', defaults: { username: 'root', password: 'p' } });
    assert.equal(none.status, 400);
    while (bulk.getRun(runId)?.status === 'running') await new Promise((x) => setTimeout(x, 20));

    const txt = await (await fetch(`${base}/agent-deploy/targets/export.txt`)).text();
    assert.match(txt, /^# Edge 노드 배포 대상/);
    assert.equal(txt.includes('SECRETPW'), false);
    const sample = await (await fetch(`${base}/agent-deploy/targets/sample.txt`)).text();
    assert.match(sample, /열 순서/); assert.match(sample, /root@10\.116\.158\.221/);
  } finally { srv.close(); }
});

/* ── v2.432.1 추가 요구: 열 순서 선택(ip/id/pw · ip/pw) · user@host · 토큰 자동 · CSV ───────── */

test('deployText: 열 순서 프리셋 — ip/id/pw, ip/pw 를 정확히 매핑(3열 추측 금지)', async () => {
  const { parseTargetsText, COLUMN_PRESETS, DEFAULT_PRESET, resolveColumns } = await import('../src/agent/deployText.js');
  const line = '10.1.1.1\tops\tSecret!1\n';
  // 기본 프리셋(host·이름·계정)에서는 3열이 '이름/계정'으로 읽힌다 — 그래서 선택이 필요하다.
  const base = parseTargetsText(line, {}, { columns: DEFAULT_PRESET }).rows[0];
  assert.equal(base.agentName, 'ops'); assert.equal(base.username, 'Secret!1');
  // ip id pw
  const idpw = parseTargetsText(line, {}, { columns: 'host-user-pass' }).rows[0];
  assert.equal(idpw.username, 'ops'); assert.equal(idpw.password, 'Secret!1'); assert.equal(idpw.agentName, '');
  // ip pw (계정은 공통값)
  const ippw = parseTargetsText('10.1.1.1\tSecret!1\n', { username: 'root' }, { columns: 'host-pass' }).rows[0];
  assert.equal(ippw.username, 'root'); assert.equal(ippw.password, 'Secret!1');
  // 프리셋 키가 이상하면 기본으로 폴백, 배열도 허용
  assert.deepEqual(resolveColumns('nope'), COLUMN_PRESETS[DEFAULT_PRESET].columns);
  assert.deepEqual(resolveColumns(['host', 'password']), ['host', 'password']);
  // 헤더가 있으면 프리셋보다 헤더가 우선
  const hdr = parseTargetsText('host\tpassword\n10.2.2.2\tPw!\n', {}, { columns: 'host-user-pass' });
  assert.equal(hdr.rows[0].password, 'Pw!'); assert.equal(hdr.rows[0].username, 'root');
});

test('deployText.splitHostPort: user@host[:port] — 행의 계정이 공통 계정을 이긴다', async () => {
  const { splitHostPort, parseTargetsText } = await import('../src/agent/deployText.js');
  assert.deepEqual(splitHostPort('ops@10.1.1.1:2222'), { user: 'ops', host: '10.1.1.1', port: '2222' });
  assert.deepEqual(splitHostPort('10.1.1.1'), { user: '', host: '10.1.1.1', port: '' });
  assert.deepEqual(splitHostPort('2001:db8::1'), { user: '', host: '2001:db8::1', port: '' }, 'IPv6 은 포트로 나누지 않는다');
  const r = parseTargetsText('ops@10.1.1.1:2222\tPw!\n', { username: 'root' }, { columns: 'host-pass' }).rows[0];
  assert.equal(r.username, 'ops'); assert.equal(r.port, '2222'); assert.equal(r.password, 'Pw!');
});

test('deployText.fillAutoTokens: 중앙 토큰 공통 · 수집 토큰은 노드마다 다른 값 · 기존 값 보존', async () => {
  const { parseTargetsText, fillAutoTokens, analyzeBulkDeploy } = await import('../src/agent/deployText.js');
  const { rows } = parseTargetsText('10.1.1.1\tA\n10.1.1.2\tB\n10.1.1.3\tC\n', { username: 'root', password: 'pw', collectorToken: '' });
  rows[2].collectorToken = 'MINE';              // 표/공통값으로 이미 지정한 행
  let n = 0;
  fillAutoTokens(rows, { centralToken: 'CT', autoCollectorToken: true, gen: () => `tok${++n}` });
  assert.deepEqual(rows.map((r) => r.centralToken), ['CT', 'CT', 'CT'], '중앙은 하나이므로 공통');
  assert.equal(new Set(rows.slice(0, 2).map((r) => r.collectorToken)).size, 2, '수집 토큰은 노드마다 다르다');
  assert.equal(rows[2].collectorToken, 'MINE', '이미 값이 있으면 덮어쓰지 않는다');
  const { report } = analyzeBulkDeploy(rows, {});
  assert.deepEqual(report.map((r) => r.collectorToken), ['auto', 'auto', 'set']);
  assert.deepEqual(report.map((r) => r.centralToken), ['auto', 'auto', 'auto']);
  assert.equal(JSON.stringify(report).includes('tok1'), false, '판정 결과에 토큰 값이 없다');
  assert.equal(JSON.stringify(report).includes('MINE'), false);
});

test('deployText.sampleTextCsv / targetsToTextCsv: 엑셀 CSV(BOM·수식 가드) 왕복', async () => {
  const { sampleTextCsv, targetsToTextCsv, parseTargetsText } = await import('../src/agent/deployText.js');
  const csv = sampleTextCsv();
  assert.match(csv, /^﻿host,port,username/);
  const back = parseTargetsText(csv, {});
  assert.equal(back.rows.length, 2, '샘플 CSV 를 그대로 다시 읽을 수 있다');
  assert.equal(back.rows[0].host, '10.112.158.221'); assert.equal(back.rows[0].agentName, 'AZ');
  // 수식 인젝션 가드(csvLine) — '=' 로 시작하는 값이 그대로 나가지 않는다
  const evil = targetsToTextCsv([{ host: '10.1.1.1', agentName: '=cmd|\'/c calc\'!A1', port: 22, username: 'root' }]);
  assert.equal(evil.includes(',=cmd'), false, 'CSV 수식 인젝션 가드');
});

test('routes: presets 목록 · columns 전달 · 토큰 자동 · CSV 내보내기/샘플', async () => {
  const express = (await import('express')).default;
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const app = express(); app.use(express.json({ limit: '2mb' }));
  const r = express.Router(); registerDeployLlm(r); app.use('/api/admin', r);
  const srv = app.listen(0); await new Promise((x) => srv.once('listening', x));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const pre = await (await fetch(`${base}/agent-deploy/bulk/presets`)).json();
    assert.ok(pre.presets.some((p) => p.key === 'host-user-pass'), 'ip/id/pw 프리셋 제공');
    assert.equal(pre.defaultPreset, 'host-name-user-pass');

    // columns='host-user-pass' → 3열이 host/계정/비밀번호로 매핑되고, 수집 토큰은 자동 생성 표시
    const j = await (await post('/agent-deploy/bulk/preview', {
      text: '10.30.0.1\tops\tSecret!1\n', columns: 'host-user-pass', autoCollectorToken: true, defaults: {},
    })).json();
    assert.equal(j.ok, true); assert.equal(j.summary.ready, 1);
    assert.equal(j.report[0].username, 'ops');
    assert.equal(j.report[0].auth, 'password');
    assert.equal(j.report[0].collectorToken, 'auto');
    assert.equal(JSON.stringify(j).includes('Secret!1'), false, '미리보기 응답에 비밀번호 없음');
    assert.deepEqual(j.columns, ['host', 'username', 'password']);

    const csv = await fetch(`${base}/agent-deploy/targets/export.txt?format=csv`);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /agent-deploy-targets\.csv/);
    const sc = await fetch(`${base}/agent-deploy/targets/sample.txt?format=csv`);
    assert.match(sc.headers.get('content-disposition'), /sample\.csv/);
    // fetch().text() 는 UTF-8 BOM 을 제거한다 — BOM 자체는 위 sampleTextCsv 단위 테스트에서 고정.
    assert.match(await sc.text(), /^host,port,username/);
  } finally { srv.close(); }
});
