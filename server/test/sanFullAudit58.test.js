/**
 * sanFullAudit58.test.js — 전체 점검 58회차(SAN 스위치 2차) 확정분.
 *  F1 단건 경로(포트 상세 · 조닝 · 점검 · 플로우 인증 정지)가 **먼저 보관된 엣지**의 사본을 골랐다 — 위임을 옮긴 뒤 옛 엣지의 한 달 전 값을 판정
 *  F2 Flow Vision 명령에 VF 컨텍스트(`setcontext N;`)가 빠져 vfId 스위치에서 기본 논리 스위치에 실행됐다(수집기는 붙인다)
 *  F3 장비 시한 식이 폴러 · 수집기 두 벌이라 'Infinity' · '-Infinity' 에서 세션 예산이 실제 시한보다 길었다(받은 출력 전부 소실)
 *  F4 웹 '문제만' 필터가 에러 카운터 7종 중 일부만 봤다(서버 점검 · 엣지 축약과 다른 기준)
 *  F5 SAN 스토리지 성능 알림 · 보고서 메일 · 점검 임계값 · 분류 매핑 설정 손상이 재시작 뒤 **조용히 기본값**(알림 · 발송 꺼짐)이 되고 저장이 열렸다 ·
 *     읽기 오류(디렉터리 · 권한)도 원본을 옮겼다 → 공용 makeSettingsLoadError
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ssh2 from 'ssh2';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('sanfa58-');
process.env.CONFIG_DIR = DIR;
process.env.DB_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.SSH_HOSTKEY_POLICY = 'observe';   // 호스트키가 주제가 아니다(sanSwitchTest2421 과 같은 이유)
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '../src');
const { stripComments } = await import('./_stripComments.js');
const rd = (f) => stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const reg = await import('../src/sanswitch/registry.js');
const edge = await import('../src/central/sanSwitchEdge.js');

// 기준 시각: 실제 시각을 정시 경계로 떨어뜨려 고정(common.md 규약)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

test('F1 — 같은 장비를 두 엣지가 보관하면 단건 경로도 가장 늦은 수집 사본(목록과 같은 규칙)', async () => {
  const dev = reg.saveDevice({ type: 'brocade', name: 'SW58', host: '10.58.1.1', username: 'u', password: 'p', agent: 'edge-new' });
  const snap = (at, tag) => ({ deviceId: dev.id, type: 'brocade', name: `SW-${tag}`, ok: true, collectedAt: at,
    ports: { total: 1, list: [{ index: 0, state: 'online' }] }, sections: { ports: 'ok' },
    extra: { authStopped: tag === 'old' ? { since: 1, at: 1, attempts: 3, reason: '옛 엣지 정지' } : null } });
  edge.saveEdgeSanSwitch('edge-old', [snap(NOW - 30 * 86_400_000, 'old')]);   // 철거된 옛 엣지(먼저 보관)
  edge.saveEdgeSanSwitch('edge-new', [snap(NOW - 60_000, 'new')]);
  assert.equal(edge.edgeSanSwitchSnapshotFor(dev.id).name, 'SW-new');
  assert.equal(edge.edgeSanSwitchSnapshotFor(dev.id).agent, 'edge-new');
  assert.equal(edge.edgeSanSwitchSnapshotFor('nope'), null);

  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'root', role: 'admin', scope: null }; n(); });
  app.use('/api', api);
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const base = `http://127.0.0.1:${s.address().port}/api/tools/sanswitch`;
    const j = async (p) => (await fetch(base + p)).json();
    assert.equal((await j('')).devices.find((d) => d.id === dev.id).snap.name, 'SW-new', '목록');
    assert.equal((await j(`/devices/${dev.id}/ports`)).name, 'SW-new', '포트 상세 — 수정 전: SW-old');
    assert.equal((await j(`/devices/${dev.id}/zoning`)).name, 'SW-new', '조닝 — 수정 전: SW-old');
    const hc = await j(`/devices/${dev.id}/healthcheck`);
    assert.equal(hc.ok, true);
    assert.equal(hc.result.collectedAt, NOW - 60_000, '점검은 새 엣지 수집분 — 수정 전: 30일 전 값');
  } finally { s.close(); }
  const { edgeAuthStopOf } = await import('../src/routes/api/sanFlow.js');
  assert.equal(edgeAuthStopOf(dev.id), null, '플로우 인증 정지 — 옛 엣지의 낡은 정지 기록을 쓰지 않는다');
  // 소스: 단건 경로에 .find 첫 일치가 다시 생기지 않게
  for (const f of ['routes/api/sanSwitch.js', 'routes/api/sanFlow.js']) assert.doesNotMatch(rd(f), /edgeSanSwitchSnapshots\(\)\.find\(/, f);
});

test('F2 — vfId 스위치의 플로우 명령은 setcontext 를 붙여 실행하고, 기록 · 대조는 접두 없는 명령으로', { timeout: 60_000 }, async () => {
  const { vfPrefixOf, buildFlowCommands } = await import('../src/sanswitch/flowCmd.js');
  assert.equal(vfPrefixOf({ vfId: 5 }), 'setcontext 5; ');
  for (const v of [null, undefined, '', 0, 129, 2.5, 'abc', '5; reboot']) assert.equal(vfPrefixOf({ vfId: v }), '', String(v));
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  const seen = [];
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [key] }, (c) => {
    clients.add(c);
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (a) => { const se = a(); se.on('exec', (acc, _r, info) => { seen.push(info.command); const st = acc(); st.write('ok\n'); st.exit(0); st.end(); }); }));
    c.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { runFlowCommands } = await import('../src/sanswitch/flowJobs.js');
    const flow = { name: 'dvc_host1abcde_01', ingrport: '3/12', srcdev: '10:00:00:00:c9:00:00:01', dstdev: '50:00:00:00:00:00:00:02' };
    const b = buildFlowCommands('create', [flow]);
    const port = server.address().port;
    const r = await runFlowCommands({ id: 'sw-vf58', host: '127.0.0.1', sshPort: port, username: 'u', password: 'p', vfId: 5 }, b.cmds);
    assert.deepEqual(seen, b.cmds.map((c) => `setcontext 5; ${c}`), '수정 전: setcontext 없이 기본 컨텍스트에서 실행');
    assert.deepEqual(r.outputs.map((o) => o.cmd), b.cmds, '결과의 cmd 는 접두 없는 원문(applyResult 대조)');
    seen.length = 0;
    await runFlowCommands({ id: 'sw-novf58', host: '127.0.0.1', sshPort: port, username: 'u', password: 'p', vfId: null }, b.cmds);
    assert.deepEqual(seen, b.cmds, 'VF 없는 스위치는 예전 그대로');
  } finally {
    for (const c of clients) { try { c.end(); } catch { /* */ } }
    await new Promise((r) => { const t = setTimeout(r, 2000); t.unref?.(); server.close(() => { clearTimeout(t); r(); }); });
  }
  assert.match(rd('routes/api/sanFlow.js'), /cmds: built\.cmds\.map\(\(c\) => `\$\{vfPrefixOf\(p\.dev\)\}\$\{c\}`\)/, '미리보기도 실제로 보낼 글자');
});

test('F3 — 장비 시한은 fosSsh 하나 · 어떤 env 에서도 세션 예산 < 실제 시한', () => {
  assert.match(rd('sanswitch/poller.js'), /const DEVICE_TIMEOUT_MS = fosSsh\.DEVICE_TIMEOUT_MS;/);
  assert.doesNotMatch(rd('sanswitch/poller.js'), /process\.env\.SANSW_DEVICE_TIMEOUT_MS/);
  assert.doesNotMatch(rd('sanswitch/collectRequests.js'), /process\.env\.SANSW_DEVICE_TIMEOUT_MS/);
  const code = `const f = await import('./src/sanswitch/collectors/fosSsh.js'); const { deadlineMs } = await import('./src/util/deadline.js');
    console.log(JSON.stringify({ dev: f.DEVICE_TIMEOUT_MS, budget: f.SESSION_BUDGET_MS, real: deadlineMs(f.DEVICE_TIMEOUT_MS) }));`;
  for (const v of ['Infinity', '-Infinity', '1e400', '-5', '', 'abc', '45000', '3000000000']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(HERE, '..'), env: { ...process.env, SANSW_DEVICE_TIMEOUT_MS: v }, encoding: 'utf8' });
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.ok(o.budget < o.real, `env=${JSON.stringify(v)} 예산 ${o.budget} < 실제 시한 ${o.real}(수정 전 Infinity: 폴러 60초 · 예산 100초)`);
  }
});

test('F4 — 웹 에러 카운터 목록 = 서버 ERROR_KEYS(문제만 필터 · 축약 · 점검이 같은 7종)', async () => {
  const { ERROR_KEYS } = await import('../src/sanswitch/healthCheck.js');
  const web = await import('../../web/src/views/tools/sanSwitchPorts.js');
  assert.deepEqual([...web.PORT_ERROR_KEYS], [...ERROR_KEYS]);
  const list = [{ index: 1, state: 'online', errEncIn: 3 }, { index: 2, state: 'online', errLossSig: 1 }, { index: 3, state: 'online', discC3: 9 },
    { index: 4, state: 'online', errEncOut: 2 }, { index: 5, state: 'online', errCrc: 0, errEncIn: null }];
  assert.deepEqual(web.filterPorts(list, 'problem').map((p) => p.index), [1, 2, 3, 4], '수정 전: [] (enc in · loss sig · disc c3 · enc out 단독은 빠졌다)');
});

/** 손상 → (같은 프로세스) → 재시작 흉내 → 표지 유지 · 저장 거절 · 서비스 점검 확정으로 풀림. */
async function corruptCycle({ file, mod, reset, loadErr, save, label }) {
  const p = path.join(DIR, file);
  fs.writeFileSync(p, '{"enabled":true,');
  reset();
  assert.ok(loadErr(), `${label}: 같은 프로세스 — 못 읽음`);
  reset();   // 재시작(원본은 .corrupt 로 옮겨졌다)
  assert.ok(!fs.existsSync(p));
  const e = loadErr();
  assert.ok(e && /손상 보존본/.test(e.reason), `${label}: 재시작 뒤에도 못 읽음 — 수정 전: null(조용히 기본값)`);
  assert.ok(save().issue, `${label}: 못 읽은 동안 저장 거절 — 수정 전: 저장이 열렸다`);
  const { listSettingsLoadErrors, confirmSettingsDefault } = await import('../src/util/settingsLoadError.js');
  assert.ok(listSettingsLoadErrors().some((x) => x.file === file && x.confirmable), `${label}: 서비스 점검 목록에 확정 가능으로`);
  const c = confirmSettingsDefault(file, { by: 'root' });
  assert.equal(c.ok, true, `${label}: 확정 ${JSON.stringify(c)}`);
  assert.equal(loadErr(), null);
  assert.ok(fs.existsSync(p), `${label}: 확정이 기본값 파일을 썼다`);
  assert.ok(!save().issue, `${label}: 확정 뒤 저장`);
  // 읽기 오류(디렉터리) — 원본을 옮기지 않는다
  for (const n of fs.readdirSync(DIR)) if (n.startsWith(file)) fs.rmSync(path.join(DIR, n), { recursive: true, force: true });
  fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'x'), '1');
  reset();
  assert.ok(loadErr()?.readError, `${label}: 읽기 오류 표지`);
  assert.ok(fs.statSync(p).isDirectory(), `${label}: 원본 자리를 옮기지 않았다 — 수정 전: .corrupt 로 옮김(알림 · 보고서)`);
  assert.ok(save().issue, `${label}: 읽기 오류 중 저장 거절`);
  fs.rmSync(p, { recursive: true, force: true });
  reset();
  void mod;
}

test('F5 — SAN 스토리지 성능 알림 · 보고서 메일 · 임계값 · 분류 매핑: 손상은 재시작 뒤에도 못 읽음 · 저장 거절 · 확정 · 읽기 오류는 원본 유지', async () => {
  const N = await import('../src/sanswitch/storagePerfNotifyStore.js');
  await corruptCycle({ file: 'san-storage-notify.json', mod: N, reset: () => N._resetNotifyForTest(), loadErr: () => N.notifyLoadError(),
    save: () => N.saveNotifySettings({ enabled: true }), label: '알림' });
  const R = await import('../src/sanswitch/storagePerfReportMail.js');
  await corruptCycle({ file: 'san-storage-report.json', mod: R, reset: () => R._resetReportForTest(), loadErr: () => R.reportLoadError(),
    save: () => R.saveReportSettings({ enabled: true, dayOfMonth: 2, time: '07:10' }), label: '보고서 메일' });
  const C = await import('../src/sanswitch/storageCheckSettings.js');
  await corruptCycle({ file: 'storage-perf-check.json', mod: C, reset: () => C._resetForTest(), loadErr: () => C.checkSettingsLoadError(),
    save: () => C.saveCheckSettings({ values: {} }, { by: 'root' }), label: '임계값' });
  assert.equal(C.publicCheckSettings().loadError, undefined, '정상이면 loadError 없음');
  const M = await import('../src/sanswitch/directorMap.js');
  await corruptCycle({ file: 'san-storage-map.json', mod: M, reset: () => M._resetForTest(), loadErr: () => M.directorMapLoadError(),
    save: () => M.saveDirectorMap({ kinds: {}, directors: {} }, { by: 'root' }), label: '분류 매핑' });
  // 화면 표지(임계값 GET 원천)
  fs.writeFileSync(path.join(DIR, 'storage-perf-check.json'), '[1]');
  C._resetForTest();
  assert.ok(C.publicCheckSettings().loadError?.reason, '임계값 공개 모양에 loadError');
  fs.rmSync(path.join(DIR, 'storage-perf-check.json'), { force: true });
});
