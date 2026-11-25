/**
 * rebut62.test.js — 전체 점검 62회차(60 · 61회차 수정 반증) 확정분.
 *  R1 60회차 F1 · F2 의 '재시작 뒤에도 못 읽은 것' — 손상 보존본만 남은 채 다시 시작하면(파일 없음) 로드 오류가 서야 저장이 막힌다.
 *     변이: read() · load() 의 missing() 을 지워도 60회차 시험이 모두 통과했다(같은 프로세스 안의 corrupt() 만 봤다) — 여기서 고정한다.
 *  R2 60회차 F3 의 형제: '대역 가득 참' 바로 알림의 상한(300) 꼬리를 slice 로 버려 발생 중인 키가 해소로 기록됐다 → holdTail(보류).
 *  R3 61회차 F3 의 형제: 베어메탈 상태 칸 '인증서'(bmusage certForServer)가 꺼진 점검 · 낡은 결과의 옛 'D-n' 을 지금 값으로 썼다.
 *  R4 61회차 F2 의 형제: 로그 디렉터리를 만들 수 없으면 logStatus 가 던져 GET /svcmon/log 500 — 경로를 고칠 화면이 열리지 않았다.
 *  R5 60회차 F1 의 형제: vCenter 별 대역 CSV 가져오기의 미리보기(dryRun)가 못 읽은 파일을 빈 맵으로 보고 전부 '추가' 라 했다 → 409.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut62-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const VC_FILE = path.join(tmp, 'ipam-vcenter-ranges.json');
const NOTE_FILE = path.join(tmp, 'ipam-subnet-notes.json');
// 앞 프로세스가 손상을 보존본으로 옮긴 뒤 다시 시작한 상태 — 원본은 없고 보존본만 있다(모듈이 처음 읽기 전에 놓는다)
fs.writeFileSync(`${VC_FILE}.corrupt.1700000000000`, '{"vcenters":{"vcA":{"ranges":["10.0.0.0/24"]},"vcB":');
fs.writeFileSync(`${NOTE_FILE}.corrupt.1700000000000`, '{"10.1.1":{"purpose":"DB"},"10.1.2":');
// 기준 시각 — 실제 시각에서 정시로 떨어뜨려 고정(docs/rules/common.md)
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;

const R = await import('../src/ipam/rangeStore.js');
const N = await import('../src/ipam/subnetNotes.js');
const express = (await import('express')).default;
const FULL = { username: 'root', role: 'admin', scope: null };

async function call(mount, method, url, body) {
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = FULL; next(); });
  mount(app);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _q, res, _n) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.close(); }
}

test('R1 재시작 뒤(보존본만 있음) — vCenter 별 대역 · 대역 용도 저장이 그 하나만 든 파일을 만들지 않는다', () => {
  // 서비스 점검 목록(listSettingsLoadErrors)은 스스로 missing() 을 부르므로 먼저 부르지 않는다 — 저장 경로 자체가 막아야 한다
  assert.ok(R.vcRangesLoadError(), '재시작 뒤에도 로드 오류(손상 보존본만 있음)');
  const r = R.saveVcRanges('vcC', { ranges: ['10.3.0.0/24'] });
  assert.equal(r.code, 'settings-unreadable', JSON.stringify(r));
  assert.ok(!fs.existsSync(VC_FILE), 'vcC 하나만 든 파일을 쓰지 않았다');
  assert.ok(N.subnetNotesLoadError(), '대역 용도도 같은 판정');
  assert.equal(N.setSubnetNote('10.9.9', { purpose: 'x' }, 'u').code, 'settings-unreadable');
  assert.ok(!fs.existsSync(NOTE_FILE));
});

test('R5 못 읽은 동안 vCenter 별 대역 CSV 미리보기도 409(빈 맵 기준 \'추가\' 판정을 내지 않는다)', async () => {
  const { adminRouter } = await import('../src/routes/admin.js');
  const mount = (app) => app.use('/api/admin', adminRouter);
  const res = await call(mount, 'POST', '/api/admin/ipam/vc-ranges/import', { csv: 'vcenter,ranges,enabled\nvcA,10.0.0.0/24,true\n', dryRun: true });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'settings-unreadable');
});

test('R2 \'대역 가득 참\' 알림 — 상한 300 을 넘은 꼬리는 보류(해소로 기록하지 않는다)', async () => {
  const S = await import('../src/alerts.js');
  const L = await import('../src/ipam/ledger.js');
  const vms = Array.from({ length: 305 }, (_, i) => { const ip = `10.${Math.floor(i / 250)}.${i % 250}.5`; return { id: `vc1:vm-${i}`, name: `vm${i}`, vcenterId: 'vc1', ipAddress: ip, ipAddresses: [ip], powerState: 'poweredOn' }; });
  const snap = { generatedAt: T0, vcenters: [{ id: 'vc1', name: 'VC1', status: 'ok', receivedAt: Date.now() }], vms, hosts: [], datastores: [], alarms: [] };
  L.buildIpamRows(snap, '', null);   // 평가는 원장 캐시가 있을 때만 판정한다(peekIpamRows)
  const a = S.evaluate(snap, { rules: { ipamSubnetFull: { enabled: true, threshold: 0 } } });
  const subs = L.listSubnets(snap, '', null).map((s) => `ipfull:${s.base}`);
  assert.equal(subs.length, 305);
  const keys = new Set(a.map((x) => x.key));
  assert.equal(keys.size, 300, '한 번에 내는 수는 그대로 300');
  const resolved = subs.filter((k) => !keys.has(k) && !a.held.has(k));
  assert.deepEqual(resolved, [], `수정 전: ${resolved.length}건이 목록에도 보류에도 없어 엔진이 '해소' 로 기록했다`);
});

test('R3 베어메탈 상태 \'인증서\' — 꺼진 점검 · 낡은 결과의 옛 D-n 을 지금 값으로 쓰지 않는다(svcmon testState)', async () => {
  const H = await import('../src/bmusage/health.js');
  const { certDaysOf } = await import('../src/svcmon/dash.js');
  const { testState } = await import('../src/svcmon/status.js');
  const now = T0;
  const srv = { key: 'k', name: 'srv1', osHost: { host: '10.1.1.1' } };
  const tg = (id, enabled, ts, reply) => ({ id, host: '10.1.1.1', enabled, tests: [{ id: `${id}c`, type: 'cert', intervalSec: 86400 }], _r: [`${id}c`, { status: 'ok', reply, ts }] });
  const stale = tg('t1', true, now - 40 * 86_400_000, 'D-35');   // 40일 전 'D-35' — 지금은 만료됐다
  const off = tg('t2', false, now - 400 * 86_400_000, 'D-200');
  const fresh = tg('t3', true, now - 3_600_000, 'D-20');
  const src = (list) => ({ targets: list, results: new Map(list.map((x) => x._r)), certDaysOf, testState });
  const c1 = H.certForServer(srv, src([stale, off]), now);
  assert.deepEqual(c1, { days: null, count: 1 }, '꺼진 점검은 세지 않고 낡은 결과는 남은 일수로 쓰지 않는다(수정 전: days 35 · count 2)');
  assert.equal(H.judgeHealth({ hfacts: {}, cert: c1, now }).cells.cert.code, 'missing', '수정 전: \'ok\'(D-35 > 30)');
  assert.deepEqual(H.certForServer(srv, src([stale, off, fresh]), now), { days: 20, count: 2 }, '지금 결과만 남은 일수로');
  assert.equal(H.certForServer(srv, src([off]), now), null, '꺼진 점검뿐이면 등록 없음(na)');
  // testState 를 넘기지 않는 호출(옛 계약)은 예전과 같다
  assert.deepEqual(H.certForServer(srv, { targets: [stale], results: new Map([stale._r]), certDaysOf }), { days: 35, count: 1 });
  // 실제 원천(certSource)이 판정 코어를 함께 준다 — 사본 판정 금지
  const strip = (await import('./_stripComments.js')).stripComments;
  const ops = strip(fs.readFileSync(new URL('../src/bmusage/cycleOps.js', import.meta.url), 'utf8'));
  assert.match(ops, /import\('\.\.\/svcmon\/status\.js'\)/);
  assert.match(ops, /certDaysOf, testState \}/);
  assert.match(ops, /certForServer\(tg, cert, now\)/);
});

test('R4 로그 디렉터리를 만들 수 없으면 현황이 500 대신 \'못 읽음\'(경로는 보인다)', async () => {
  const L = await import('../src/svcmon/logsettings.js');
  const C = await import('../src/svcmon/csvlog.js');
  const blocker = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');   // 경로 중간이 파일 — root 로 도는 시험에서도 mkdir 이 실패한다(ENOTDIR)
  const bad = path.join(blocker, 'logs');
  fs.writeFileSync(path.join(tmp, 'svcmon-log.json'), JSON.stringify({ enabled: true, dirPath: bad }));
  L._resetLogSettingsCache();
  try {
    assert.throws(() => L.logDir(), '전제: 디렉터리를 만들 수 없다');
    const s = C.logStatus();   // 수정 전: ENOTDIR 로 던졌다(라우트 500 → 설정 화면 두 곳이 오류 상자만)
    assert.equal(s.filesUnreadable, true);
    assert.equal(s.fileCount, null);
    assert.equal(s.totalBytes, null);
    assert.equal(s.dir, bad, '고칠 경로를 보여 준다');
  } finally {
    fs.rmSync(path.join(tmp, 'svcmon-log.json'), { force: true });
    L._resetLogSettingsCache();
  }
  assert.equal(C.logStatus().filesUnreadable, undefined, '기본 위치로 돌아오면 표지가 없다');
});

/*
 * R6 60회차 F1 · F2 가 새로 단 로드 오류가 읽기 오류(EACCES · EISDIR)를 손상과 같이 다뤘다(재현 — EISDIR): 원본을 보존본으로 치우고
 *    '손상 보존본으로 옮겼습니다' · 확정 가능(= 빈 맵으로 덮기)으로 보였다. 20회차 반증 F4 규약(svcmon logsettings 등) — 옮기지 않고 확정 불가.
 */
test('R6 읽기 오류(EISDIR)는 손상이 아니다 — 원본을 옮기지 않고 확정할 수 없다', async () => {
  const U = await import('../src/util/settingsLoadError.js');
  fs.mkdirSync(VC_FILE); fs.writeFileSync(path.join(VC_FILE, 'keep'), 'x');
  fs.mkdirSync(NOTE_FILE);
  N._resetSubnetNotesForTest();
  try {
    const e1 = R.vcRangesLoadError(); const e2 = N.subnetNotesLoadError();
    assert.equal(e1?.readError, true, JSON.stringify(e1));
    assert.equal(e2?.readError, true, JSON.stringify(e2));
    assert.ok(fs.statSync(VC_FILE).isDirectory() && fs.statSync(NOTE_FILE).isDirectory(), '원본을 옮기지 않았다(수정 전: .corrupt 로 치움)');
    const rows = U.listSettingsLoadErrors().filter((x) => x.file === 'ipam-vcenter-ranges.json' || x.file === 'ipam-subnet-notes.json');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.confirmable === false), '확정(빈 맵으로 덮기) 불가');
    assert.equal(R.saveVcRanges('vcC', { ranges: ['10.3.0.0/24'] }).code, 'settings-unreadable');
  } finally {
    fs.rmSync(VC_FILE, { recursive: true, force: true }); fs.rmSync(NOTE_FILE, { recursive: true, force: true });
  }
});
