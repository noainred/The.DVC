/**
 * decide3G1.test.js — 남은 결정(76~105회차) 권장안 구현 그룹 G1(2026-11-20 · 사용자 "결정 필요한 것은 권장 사항으로 진행해줘").
 *
 *  A1 장비 등록부(util/registryCore.js makeLoadError 계열)의 읽기 오류 · 손상 · 보존본만 남음이 **서비스 점검**에 없었다(그 도구 화면의 배너뿐).
 *     → 등록부마다 이름(label) · 파일을 한 줄로 등록 · 서비스 점검에 **표시 전용** 행 'registry-files'(확정 버튼 · 확정 경로 없음 — 'settings-files' 와 섞지 않는다).
 *     범위 계정 응답에는 파일 목록이 실리지 않는다(130회차 D-c — 가림은 응답 경로 전부). 사유는 요약(원문 = 자격증명 파일 조각일 수 있다).
 *  A6 위임 인벤토리 · 함대 파일 읽기 오류 창 동안 소유(TOFU)가 비어 첫 push 엣지가 소유를 잡는다 → **동작은 현행 유지**(막으면 위임 법인 화면이 통째로 빈다)
 *     + 그 창에서 잡힌 소유(건마다)와 다시 읽혀 합칠 때 되돌린 수를 **감사 로그 · 콘솔**에 남긴다(콘솔은 창마다 한 번 · 주체 이름은 개별 토큰으로 인증된 것만).
 *
 * ⚠ 저장소 server/config 오염 방지 — 모듈 import 전에 CONFIG_DIR 을 임시 폴더로 고정한다. 읽기 오류는 '파일 자리에 폴더'(EISDIR) 또는
 *   자식 프로세스에서 fs.readFileSync 를 그 파일에서만 던지게 해 만든다(컨테이너가 root 라 chmod 로는 EACCES 를 재현할 수 없다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const CFG = tmpDir('decide3g1-');
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock' });
const SECRET = 'SuperSecret123!';
// A1 ③ · ④ 의 실제 등록부 — 어느 모듈보다 먼저 만든다(서비스 점검이 폴러를 거쳐 등록부를 일찍 읽어 '없음' 을 캐시한다):
//   PDU 등록부 파일 자리에 폴더(읽기 오류) · 엣지 개별 토큰 파일 손상(비밀 조각) · 원격 접속 설정 파일 자리에 폴더(읽기 오류).
fs.mkdirSync(path.join(CFG, 'pdu-devices.json'));
fs.writeFileSync(path.join(CFG, 'central-agent-tokens.json'), `{"tokens": [{"agent": "e1", "hash": ${SECRET}}]}`);
fs.mkdirSync(path.join(CFG, 'remote-access.json'));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRCDIR = path.join(HERE, '..', 'src');
/** 정시 경계로 떨어뜨린 기준 시각(테스트 시계) — Date.now() 직접 · 고정 epoch 둘 다 쓰지 않는다. */
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000;

/* ── A1 ─────────────────────────────────────────────────────────────── */
test('A1 ① registryCore — label 을 준 등록부만 등록 · 사유는 요약(원문 조각 없음) · 보존본만 남음은 표시만(상태를 세우지 않음)', async () => {
  const core = await import('../src/util/registryCore.js');
  const n0 = core.registryStatusCount();
  core.makeLoadError();   // label 없음 — 예전과 같다(등록하지 않는다)
  assert.equal(core.registryStatusCount(), n0, 'label 없는 makeLoadError 는 서비스 점검에 등록하지 않는다');

  // 손상(JSON 형식 오류) — 사유 원문(V8 메시지)은 파일 조각을 싣는다. 목록에는 요약만.
  const corruptF = path.join(CFG, 'g1-corrupt.json');
  const L1 = core.makeLoadError({ label: '시험 손상 등록부', file: () => corruptF });
  let perr; try { JSON.parse(`{"password": ${SECRET}}`); } catch (e) { perr = e; }
  L1.set(perr);
  assert.ok(String(L1.get().reason).includes('SuperSecre'), '전제: 원문 사유에는 파일 조각이 있다');
  // 읽기 오류 — 파일 자리에 폴더(EISDIR). 원본을 옮기지 않는 공용 읽기(read).
  const dirF = path.join(CFG, 'g1-readerr.json');
  fs.mkdirSync(dirF);
  const L2 = core.makeLoadError({ label: '시험 읽기 오류 등록부', file: dirF });
  assert.equal(L2.read(dirF).kind, 'read-error');
  // 보존본만 남음 — 아직 로드되지 않은 등록부(상태 없음)도 표시는 한다. 그 모듈의 표지는 건드리지 않는다.
  const onlyF = path.join(CFG, 'g1-only.json');
  fs.writeFileSync(`${onlyF}.corrupt.${BASE}`, '{');
  const L3 = core.makeLoadError({ label: '시험 보존본 등록부', file: onlyF });
  // 던지는 getter 는 그 줄만 건너뛴다(목록 전체가 깨지지 않는다)
  core.registerRegistryStatus({ label: '시험 던지는 등록부', file: path.join(CFG, 'g1-throw.json'), get: () => { throw new Error('x'); } });

  const admin = core.listRegistryLoadErrors({ admin: true });
  const other = core.listRegistryLoadErrors();
  const pick = (list, label) => list.find((e) => e.label === label);
  assert.equal(pick(admin, '시험 손상 등록부').code, 'parse-error');
  assert.equal(pick(admin, '시험 손상 등록부').file, 'g1-corrupt.json', '파일은 기본 이름만(경로 없음)');
  assert.equal(pick(admin, '시험 읽기 오류 등록부').code, 'read-error');
  assert.equal(pick(admin, '시험 읽기 오류 등록부').sysCode, 'EISDIR');
  assert.equal(pick(admin, '시험 보존본 등록부').code, 'corrupt-only');
  assert.equal(L3.get(), null, '조회는 그 모듈의 표지를 세우지 않는다(503 을 켜지 않는다)');
  assert.equal(pick(admin, '시험 던지는 등록부'), undefined);
  for (const list of [admin, other]) {
    const s = JSON.stringify(list);
    assert.ok(!s.includes('SuperSecre') && !s.includes('password'), `사유에 원문 조각이 없다: ${s}`);
    assert.ok(!s.includes(CFG), '절대 경로가 없다');
    for (const e of list) assert.equal('confirmable' in e, false, '확정 표지가 없다(표시 전용)');
  }
  assert.equal(pick(other, '시험 읽기 오류 등록부').reason, '등록부 읽기 오류', '관리자가 아니면 분류 문구만');
  assert.equal(pick(admin, '시험 읽기 오류 등록부').reason, '등록부 읽기 오류(EISDIR)');
  // 해제되면 빠진다
  L1.clear();
  assert.equal(pick(core.listRegistryLoadErrors({ admin: true }), '시험 손상 등록부'), undefined, '저장 성공(clear) 뒤에는 빠진다');
});

test('A1 ② 서비스 점검 행 — registryFilesRow 는 표시 전용(확정 표지 없음) · settings-files 목록 · 확정 함수는 등록부 파일을 모른다', async () => {
  const { registryFilesRow, getServiceCheck } = await import('../src/health/services.js');
  const ok = registryFilesRow([], 16, BASE);
  assert.equal(ok.status, 'ok'); assert.match(ok.detail, /16개 확인/); assert.equal('files' in ok, false);
  const errs = [{ file: 'pdu-devices.json', label: 'PDU 등록부', at: BASE - 5_000, code: 'read-error', reason: '등록부 읽기 오류' }, { file: 'x.json', label: 'X', at: null, code: 'corrupt-only', reason: '보존본만' }];
  const w = registryFilesRow(errs, 16, BASE);
  assert.equal(w.status, 'warn');
  assert.equal(w.at, BASE - 5_000, '가장 이른 시각(시각 미상은 빼고)');
  assert.match(w.detail, /PDU 등록부\(pdu-devices\.json · 등록부 읽기 오류\)/);
  assert.match(w.detail, /표시 전용/);
  assert.doesNotMatch(w.detail, /기본값으로 확정/, '확정 안내를 하지 않는다');
  assert.deepEqual(w.files, errs);

  const svc = getServiceCheck({ isAdmin: true });
  const row = svc.checks.find((c) => c.key === 'registry-files');
  assert.ok(row, '서비스 점검에 장비 등록부 파일 행이 있다');
  assert.equal(row.label, '장비 등록부 파일');
  assert.equal(row.status, 'warn', JSON.stringify(row).slice(0, 300));
  assert.ok(row.files.some((f) => f.label === '시험 읽기 오류 등록부'));
  assert.equal(row.files.find((f) => f.label === '시험 읽기 오류 등록부').reason, '등록부 읽기 오류(EISDIR)', '관리자 판본은 시스템 오류 코드까지');
  const plain = getServiceCheck({ isAdmin: false }).checks.find((c) => c.key === 'registry-files');
  assert.equal(plain.files.find((f) => f.label === '시험 읽기 오류 등록부').reason, '등록부 읽기 오류', '관리자가 아니면 분류 문구만');
  const sf = svc.checks.find((c) => c.key === 'settings-files');
  assert.ok(!JSON.stringify(sf).includes('g1-readerr.json'), "'settings-files' 행(확정 버튼)에 섞이지 않는다");

  const { confirmSettingsDefault, listSettingsLoadErrors } = await import('../src/util/settingsLoadError.js');
  assert.ok(!listSettingsLoadErrors().some((e) => e.file === 'g1-readerr.json'));
  assert.equal(confirmSettingsDefault('g1-readerr.json', { by: 'adm' }).code, 'unknown-file', '확정 경로가 등록부 파일을 모른다');
});

test('A1 ③ 실제 등록부 — 대상 15곳은 label · file 을 넘기고(소스) · PDU · 엣지 개별 토큰 · 원격 접속 설정이 실제로 행에 실린다', async () => {
  const want = {
    'pdu/registry.js': 'PDU 등록부', 'storage/registry.js': '스토리지 등록부', 'sanswitch/registry.js': 'SAN 스위치 등록부', 'cvp/registry.js': 'CVP 등록부',
    'bmstor/registry.js': 'OS 계정 등록부', 'focusmon/registry.js': '집중 모니터링 등록부', 'idrac/registry.js': 'iDRAC 등록부', 'veeam/registry.js': 'Veeam 서버 등록부',
    'veeam/em/registry.js': 'Veeam Enterprise Manager 등록부', 'gpu/physicalRegistry.js': '물리 GPU 서버 등록부', 'collector/registry.js': '수집 서버 등록부',
    'vcenter/registry.js': 'vCenter 등록부', 'nsx/registry.js': 'NSX 등록부', 'bareos/registry.js': 'Bareos 백업 대상 원장', 'central/agentTokens.js': '엣지 개별 토큰',
  };
  for (const [rel, label] of Object.entries(want)) {
    const src = stripComments(fs.readFileSync(path.join(SRCDIR, rel), 'utf8'));
    assert.ok(src.includes(`makeLoadError({ label: '${label}', file: FILE })`), `${rel}: 서비스 점검 등록(label · file)`);
  }
  assert.match(stripComments(fs.readFileSync(path.join(SRCDIR, 'proxy/registry.js'), 'utf8')), /registerRegistryStatus\(\{\s*label: '원격 접속 설정', file: FILE,/);

  // 실제 모듈(파일은 맨 위에서 만들었다)
  const pdu = await import('../src/pdu/registry.js');
  const tok = await import('../src/central/agentTokens.js');
  const prx = await import('../src/proxy/registry.js');
  assert.ok(pdu.registryLoadError(), '전제: PDU 등록부 읽기 오류');
  assert.ok(tok.agentTokensLoadError(), '전제: 토큰 파일 손상');
  assert.ok(prx.registryReadError(), '전제: 원격 접속 설정 읽기 오류');
  const { listRegistryLoadErrors } = await import('../src/util/registryCore.js');
  const list = listRegistryLoadErrors({ admin: true });
  const by = (label) => list.find((e) => e.label === label);
  assert.deepEqual([by('PDU 등록부')?.file, by('PDU 등록부')?.code], ['pdu-devices.json', 'read-error']);
  assert.equal(by('엣지 개별 토큰')?.file, 'central-agent-tokens.json');
  assert.equal(by('엣지 개별 토큰')?.code, 'parse-error');
  assert.deepEqual([by('원격 접속 설정')?.file, by('원격 접속 설정')?.code, by('원격 접속 설정')?.sysCode], ['remote-access.json', 'read-error', 'EISDIR']);
  assert.ok(Number.isFinite(by('원격 접속 설정')?.at), '언제부터(처음 시각)');
  assert.ok(!JSON.stringify(list).includes('SuperSecre'), '손상 토큰 파일의 조각이 실리지 않는다');
});

async function call(router, user, method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.close(); }
}

test('A1 ④ 라우트 — 전체 범위 관리자에는 파일 목록 · 범위 계정 응답에는 파일 이름 · 목록 없음(상태는 보임) · 확정 라우트는 등록부 파일을 404', async () => {
  const { api } = await import('../src/routes/api.js');
  const ADMIN = { username: 'adm', role: 'admin', scope: {} };
  const ADMIN_SCOPED = { username: 'adm2', role: 'admin', scope: { vcenters: ['vc-a'] } };
  const full = await call(api, ADMIN, 'GET', '/tools/service-check');
  assert.equal(full.status, 200, JSON.stringify(full.body).slice(0, 300));
  const row = full.body.checks.find((c) => c.key === 'registry-files');
  assert.equal(row.status, 'warn');
  assert.ok(row.files.some((f) => f.file === 'pdu-devices.json' && f.reason === '등록부 읽기 오류(EISDIR)'), JSON.stringify(row.files));
  assert.ok(row.files.every((f) => !('confirmable' in f)), '확정 표지 없음');

  const scoped = await call(api, ADMIN_SCOPED, 'GET', '/tools/service-check');
  assert.equal(scoped.status, 200);
  const srow = scoped.body.checks.find((c) => c.key === 'registry-files');
  assert.equal(srow.status, 'warn', '상태(주의)는 그대로 — 무음이 되지 않는다');
  assert.equal('files' in srow, false, '범위 계정 응답에 파일 목록이 없다');
  for (const name of ['pdu-devices.json', 'central-agent-tokens.json', 'remote-access.json']) assert.ok(!JSON.stringify(scoped.body).includes(name), `범위 계정 응답에 ${name} 가 없다`);

  const conf = await call(api, ADMIN, 'POST', '/tools/service-check/settings-files/confirm', { file: 'pdu-devices.json' });
  assert.equal(conf.status, 404, JSON.stringify(conf.body));
  assert.equal(conf.body.code, 'unknown-file');
  assert.ok(fs.statSync(path.join(CFG, 'pdu-devices.json')).isDirectory(), '등록부 자리는 그대로(아무것도 쓰지 않았다)');
});

/* ── A6 ─────────────────────────────────────────────────────────────── */
function runChild(dir, deny, body, extraEnv = {}) {
  const script = `
    import fs from 'node:fs';
    const realRead = fs.readFileSync; const DENY = ${JSON.stringify(deny)};
    globalThis.__deny = true;
    fs.readFileSync = function (p, ...a) { if (globalThis.__deny && DENY.includes(String(p))) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realRead.call(this, p, ...a); };
    const warns = []; const realWarn = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
    const out = {};
    const auditOf = (prefix) => { try { return realRead(${JSON.stringify(path.join(dir, 'audit.ndjson'))}, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.action.startsWith(prefix)); } catch { return []; } };
    ${body}
    console.warn = realWarn;
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const res = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: dir, ...extraEnv }, encoding: 'utf8', timeout: 90_000 });
  return JSON.parse(res.split('\n').find((l) => l.startsWith('@@')).slice(2));
}

test('A6 ① 인벤토리 · 함대 읽기 오류 창 — push 는 받고(현행) · 잡힌 소유는 감사 로그(인증된 이름) · 콘솔 한 번 · 합칠 때 되돌린 수를 감사 로그 · 콘솔에', () => {
  const dir = tmpDir('decide3g1-inv-');
  const I = path.join(dir, 'central-inventory.json');
  const FL = path.join(dir, 'central-fleet.json');
  const at = BASE - 60_000;
  fs.writeFileSync(I, JSON.stringify({ inventory: { 'vc-a': { at, agent: 'edge-a', data: { hosts: [{ id: 'h1' }], vms: [] } }, 'vc-b': { at, agent: 'edge-b', data: { hosts: [], vms: [] } } } }));
  fs.writeFileSync(FL, JSON.stringify({ fleet: { 'edge-a': { at, generatedAt: null, baremetal: [{ fleetId: 'f1', name: 'bm1' }] }, 'edge-evil': { at, generatedAt: null, baremetal: [] } } }));
  fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: ['vc-a', 'vc-b', 'vc-c', 'vc-d'].map((id, i) => ({ id, name: id, host: `https://10.9.0.${i + 1}`, collectMode: 'site' })) }));
  const out = runChild(dir, [I, FL], `
    const T = await import(${JSON.stringify(path.join(SRCDIR, 'central/agentTokens.js'))});
    const tok = T.issueAgentToken('edge-evil').token;
    const inv = await import(${JSON.stringify(path.join(SRCDIR, 'central/inventory.js'))});
    const fleet = await import(${JSON.stringify(path.join(SRCDIR, 'central/fleet.js'))});
    const { runExitFlush } = await import(${JSON.stringify(path.join(SRCDIR, 'util/exitFlush.js'))});
    const express = (await import('express')).default;
    const { centralRouter } = await import(${JSON.stringify(path.join(SRCDIR, 'routes/central.js'))});
    const app = express(); app.use(express.json({ limit: '16mb' })); app.use('/api/central', centralRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const post = (p, body, token) => fetch('http://127.0.0.1:' + srv.address().port + '/api/central' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    const slice = (id) => ({ vcenterId: id, vcenter: { id, name: id, status: 'connected' }, hosts: [{ id: id + '-h', name: 'esx', vcenterId: id }], vms: [] });
    out.blocked = [inv.inventoryReadBlocked(), fleet.fleetReadBlocked()];
    out.p1 = (await post('/inventory', slice('vc-b'), tok)).status;                                  // 개별 토큰 — 파일 소유(edge-b)와 다른 엣지가 빈 소유를 잡는다
    out.p2 = (await post('/inventory', { ...slice('vc-c'), agent: 'edge-x' }, 'tok-g1-shared')).status; // 공유 토큰 — 이름은 본문 주장
    out.p3 = (await post('/inventory', slice('vc-d'), tok)).status;                                  // 같은 사유 두 번째 — 콘솔은 다시 찍지 않는다
    out.p4 = (await post('/inventory', slice('vc-d'), tok)).status;                                  // 이미 잡힌 소유 — 새 기록 없음
    out.f1 = (await post('/fleet', { baremetal: [{ fleetId: 'f9', name: 'bm9' }] }, tok)).status;
    out.claims = auditOf('central-inventory.owner-claim-unread').map((x) => ({ user: x.user, target: x.target, detail: x.detail }));
    out.mergeBefore = auditOf('central-inventory.unread-window-merge').length;
    out.claimWarns = warns.filter((w) => w.includes('첫 push 로 소유를 잡은')).length;
    out.ownerDuring = inv.getInventory('vc-b')?.agent;
    globalThis.__deny = false;
    const realNow = Date.now; Date.now = () => realNow() + 31_000;
    runExitFlush('test');
    Date.now = realNow;
    srv.close();
    out.ownerAfter = inv.getInventory('vc-b')?.agent;
    out.merge = auditOf('central-inventory.unread-window-merge').map((x) => ({ user: x.user, detail: x.detail }));
    out.fleetMerge = auditOf('central-fleet.unread-window-merge').map((x) => ({ user: x.user, detail: x.detail }));
    out.mergeWarns = warns.filter((w) => w.includes('central-inventory.json 다시 읽었습니다')).length;
    out.fleetWarns = warns.filter((w) => w.includes('central-fleet.json 다시 읽었습니다')).length;
    out.blockedAfter = [inv.inventoryReadBlocked(), fleet.fleetReadBlocked()];
  `, { CENTRAL_TOKEN: 'tok-g1-shared', CENTRAL_FLEET_TTL_MS: String(10 * 86_400_000), DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
  assert.deepEqual(out.blocked, [true, true], '전제: 두 파일 모두 읽기 오류로 시작');
  assert.deepEqual([out.p1, out.p2, out.p3, out.p4, out.f1], [200, 200, 200, 200, 200], '동작은 현행 유지 — 읽기 오류 창에도 push 를 받는다');
  assert.equal(out.ownerDuring, 'edge-evil', '전제: 창 동안 첫 push 가 소유를 잡는다(TOFU)');
  assert.deepEqual(out.claims.map((c) => [c.user, c.target]), [['edge:edge-evil', 'vc-b'], ['edge:(공유 토큰)', 'vc-c'], ['edge:edge-evil', 'vc-d']], '잡힌 소유마다 감사 로그 — 주체는 인증된 이름(공유 토큰은 이름을 주체로 쓰지 않는다)');
  assert.match(out.claims[1].detail, /공유 토큰 · 이름 ‘edge-x’\(미검증\)/);
  assert.equal(out.mergeBefore, 0);
  assert.equal(out.claimWarns, 1, '콘솔은 창마다 한 번(같은 사유 반복 금지)');
  assert.equal(out.ownerAfter, 'edge-b', '합칠 때 파일 소유로 되돌린다(예전 동작 그대로)');
  assert.equal(out.merge.length, 1, JSON.stringify(out.merge));
  assert.equal(out.merge[0].user, 'system');
  assert.match(out.merge[0].detail, /첫 push 로 잡힌 소유 3건\(파일과 같음 0 · 파일에 없어 그대로 2\)/);
  assert.match(out.merge[0].detail, /파일 쪽으로 되돌린 소유 1건\(vc-b: edge-evil → edge-b\)/);
  assert.match(out.merge[0].detail, /파일에서 되살린 vCenter 1/);
  assert.equal(out.mergeWarns, 1, '합친 결과 콘솔 한 줄');
  assert.equal(out.fleetMerge.length, 1, JSON.stringify(out.fleetMerge));
  assert.match(out.fleetMerge[0].detail, /창 동안 push 한 엣지 1\(그중 이름 미검증 0\) · 그 push 가 파일 값을 대신한 엣지 1 · 파일에서 되살린 엣지 1/);
  assert.equal(out.fleetWarns, 1);
  assert.deepEqual(out.blockedAfter, [false, false]);
});

test('A6 ② 창 밖의 첫 push 는 기록하지 않고(평소 TOFU) · 창 안 건별 감사 로그에는 상한이 있다(합계는 합칠 때)', () => {
  const dir = tmpDir('decide3g1-cap-');
  const I = path.join(dir, 'central-inventory.json');
  fs.writeFileSync(I, JSON.stringify({ inventory: {} }));
  const normal = runChild(dir, [], `
    const inv = await import(${JSON.stringify(path.join(SRCDIR, 'central/inventory.js'))});
    out.r = inv.setInventory('vc-n', { vcenter: { id: 'vc-n', status: 'connected' }, hosts: [], vms: [] }, 'edge-n', null, { verified: true });
    out.claims = auditOf('central-inventory.owner-claim-unread').length;
    out.warns = warns.filter((w) => w.includes('첫 push 로 소유를 잡은')).length;
  `);
  assert.deepEqual(normal.r, { held: false });
  assert.equal(normal.claims, 0); assert.equal(normal.warns, 0);

  const capped = runChild(dir, [I], `
    const inv = await import(${JSON.stringify(path.join(SRCDIR, 'central/inventory.js'))});
    inv.setInventory('vc-h', { vcenter: { id: 'vc-h', status: 'connected' }, hosts: [{ id: 'h' }], vms: [] }, '', null);   // 이름 없는 push — 소유 없음(기록 없음)
    out.held = inv.setInventory('vc-h', { vcenter: { id: 'vc-h', status: 'unreachable' }, hosts: [], vms: [] }, 'edge-h', null, { verified: true });   // 목록 보존 갈래도 빈 소유를 채운다
    for (let i = 0; i < 70; i += 1) out.last = inv.setInventory('vc-' + i, { vcenter: { id: 'vc-' + i, status: 'connected' }, hosts: [], vms: [] }, 'edge-z', null, { verified: true });
    out.claims = auditOf('central-inventory.owner-claim-unread').length;
    out.capNote = auditOf('central-inventory.owner-claim-unread').filter((x) => x.detail.includes('건별 기록 상한')).length;
    globalThis.__deny = false;
    const realNow = Date.now; Date.now = () => realNow() + 31_000;
    const { runExitFlush } = await import(${JSON.stringify(path.join(SRCDIR, 'util/exitFlush.js'))});
    runExitFlush('test');
    Date.now = realNow;
    out.merge = auditOf('central-inventory.unread-window-merge').map((x) => x.detail);
  `);
  assert.deepEqual(capped.held, { held: true, claimedWhileUnread: true }, '목록 보존(held) 갈래에서 잡힌 소유도 기록한다');
  assert.deepEqual(capped.last, { held: false, claimedWhileUnread: true });
  assert.equal(capped.claims, 64, '창 하나의 건별 감사 로그 상한');
  assert.equal(capped.capNote, 1, '상한에 닿았다는 사실을 마지막 건이 밝힌다');
  assert.equal(capped.merge.length, 1);
  assert.match(capped.merge[0], /첫 push 로 잡힌 소유 71건/, '합계는 상한과 무관하게 전부');
});
