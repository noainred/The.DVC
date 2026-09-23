/**
 * v2.597 — 8차 점검(7축 병렬 감사 + 축별 반증 검증) 확정분 회귀 고정.
 *
 * 각 테스트는 **수정을 되돌리면 실패하도록** 입력을 골랐다(변이 검증은 릴리스 노트에 기록).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const REPO = path.resolve(HERE, '../..');
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2597-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';

/* ── RECENT-01 백업 지문이 scrypt 를 돌리지 않는다 ── */
test('RECENT-01 — 캐시에 없는 봉인 값은 열지 않는다(지문 계산이 scrypt 로 루프를 막지 않는다)', async () => {
  const vault = await import('../src/security/secretVault.js');
  const { settingsFingerprint } = await import('../src/backup/service.js');
  // 다른 프로세스가 봉인한 값을 흉내 — 이 프로세스의 파생키 캐시에는 없는 salt.
  const sealed = vault.sealSecret('pw-a', { mode: 'encrypted', level: 2 });
  assert.equal(vault.openSecretIfCached(sealed), 'pw-a', '방금 봉인한 값은 캐시에 있다');
  const alien = sealed.replace(/\$([A-Za-z0-9_-]{22})\$/, (_m, salt) => `$${salt.split('').reverse().join('')}$`);
  assert.equal(vault.openSecretIfCached(alien), null, '캐시에 없는 salt 는 null(scrypt 없음)');
  const files = { 'storage-devices.json': JSON.stringify({ devices: Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, password: alien })) }) };
  const t0 = Date.now();
  settingsFingerprint(files);
  assert.ok(Date.now() - t0 < 1_000, `지문 계산 ${Date.now() - t0}ms — 예전에는 값마다 scrypt(약 100ms)`);
  assert.ok(!/openSecretsDeep/.test(read('backup/service.js')), '지문 경로에 openSecretsDeep 을 되살리지 말 것');
});

/* ── RECENT-02 gzip;q=0 ── */
test('RECENT-02 — gzip;q=0 이면 gzip 으로 보내지 않는다', async () => {
  const { acceptsGzip } = await import('../src/util/staticGzip.js');
  assert.equal(acceptsGzip('gzip, deflate, br'), true);
  assert.equal(acceptsGzip('gzip;q=0, identity'), false);
  assert.equal(acceptsGzip('x-gzip'), false);
  assert.equal(acceptsGzip('identity'), false);
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip('*;q=1, gzip;q=0'), false);
});

/* ── RECENT-03 probe 문구 ── */
test('RECENT-03 — 비-admin probe 응답은 ping·tcp 문구(포트)를 빼고 상태·시간만', () => {
  const s = read('routes/svcmon/edge.js');
  assert.match(s, /tcp: r\.tcp \? \{ status: r\.tcp\.status, ms: r\.tcp\.ms \}/);
  assert.match(s, /ping: r\.ping \? \{ status: r\.ping\.status, ms: r\.ping\.ms \}/);
});

/* ── L2597-01 vmtrack 부분 합 표식 ── */
test('L2597-01 — 연결 실패로 빠진 vCenter 수를 합계 행에 남기고 계열이 밝힌다', async () => {
  const { takeVmSnapshot, vmtrackSeries } = await import('../src/vmtrack/service.js');
  const snap = {
    vcenters: [{ id: 'vc-a', status: 'connected' }, { id: 'vc-b', status: 'unreachable' }],
    vms: [{ id: 'vm1', vcenterId: 'vc-a', name: 'a', powerState: 'poweredOn' }],
    datastores: [],
  };
  const r = await takeVmSnapshot(snap, { now: new Date() });
  assert.equal(r.ok, true);
  const s = await vmtrackSeries({ days: 2 });
  assert.equal(s.points.at(-1).skipped, 1, '예전: 표식 없음(부분 합이 하락처럼 보였다)');
});

/* ── L2597-02 SQLite 잠금 래치 ── */
test('L2597-02 — 첫 open 잠금은 비활성으로 래치하지 않는다', async () => {
  const { isSqliteLockError } = await import('../src/storage/db.js');
  assert.equal(isSqliteLockError({ errcode: 5, message: 'database is locked' }), true);
  assert.equal(isSqliteLockError({ message: 'database is locked' }), true);
  assert.equal(isSqliteLockError({ message: "Cannot find module 'node:sqlite'" }), false);
  const s = read('storage/db.js');
  assert.match(s, /if \(isSqliteLockError\(e\)\) \{[\s\S]{0,200}_retryAt = Date\.now\(\) \+ 30_000;[\s\S]{0,200}return null;/);
  assert.match(read('metrics/db.js'), /initSqliteRetrying\(\)\.catch/);
});

/* ── L2597-03 엣지 이름 대소문자 ── */
test('L2597-03 — 엣지 설정 조회는 대소문자만 다른 이름도 같은 엣지로 본다', async () => {
  const { agentKeyOf } = await import('../src/util/agentKey.js');
  assert.equal(agentKeyOf({ 'Edge-A': 1 }, 'edge-a'), 'Edge-A');
  assert.equal(agentKeyOf({ 'edge-a': 1, 'Edge-A': 2 }, 'Edge-A'), 'Edge-A', '정확히 같은 키가 먼저');
  assert.equal(agentKeyOf({ x: 1 }, 'y'), null);
  assert.equal(agentKeyOf({ __proto__: null, a: 1 }, ''), null);
  assert.match(read('storage/intervals.js'), /agentValueOf\(d\.agents, agent\)/);
  assert.match(read('central/agentGpuGuestConfig.js'), /agentKeyOf\(byAgent, a\)/);
  assert.match(read('central/agentUsers.js'), /agentKeyOf\(byAgent, a\)/);
});

/* ── L2597-04·05 PDU push 가드·pull 정리 ── */
test('L2597-05 — PDU pull 이 빠진 장비 id 를 돌려주고 스냅샷을 지운다', async () => {
  const reg = await import('../src/pdu/registry.js');
  reg.applyPulledDevices([{ id: 'p1', host: '10.0.0.1', type: 'apc' }, { id: 'p2', host: '10.0.0.2', type: 'apc' }]);
  const r = reg.applyPulledDevices([{ id: 'p1', host: '10.0.0.1', type: 'apc' }]);
  assert.deepEqual(r.removed, ['p2']);
  assert.match(read('agent/pduConfigPull.js'), /if \(ap\?\.removed\?\.length\) forgetDevices\(ap\.removed\);/);
});
test('L2597-04 — PDU push 는 재진입 가드를 두고 진행 중 요청은 끝난 뒤 1회 더 보낸다', () => {
  const s = read('pdu/push.js');
  assert.match(s, /if \(_busy\) \{ _again = true; return _busy; \}/);
  assert.match(s, /do \{ _again = false; r = await pushPduOnce\(\); \} while \(_again\);/);
});

/* ── C2597-01 PDU 데이지체인 ── */
test('C2597-01 — 유닛 2 이상은 뱅크·상을 읽지 않는다(유닛 1 값 복제 금지)', () => {
  const s = read('pdu/collectors/apcSsh.js');
  assert.match(s, /if \(i > 1\) \{[\s\S]{0,300}unit\.banksNotCollected = true;[\s\S]{0,80}continue;/);
});

/* ── C2597-02~04 스토리지 REST 결측 ── */
test('C2597-02 — Unity REST 전체 용량 결측은 섹션 오류(0 바이트 정상 아님)', async () => {
  const { normalizeUnity } = await import('../src/storage/collectors/unity.js');
  const s = normalizeUnity({ id: 'u', name: 'u' }, { cap: { entries: [{ content: { sizeUsed: 100 } }] } });
  assert.match(String(s.sections.capacity), /^오류: sizeTotal 없음/);
  const ok = normalizeUnity({ id: 'u', name: 'u' }, { cap: { entries: [{ content: { sizeTotal: 1000, sizeUsed: 100 } }] } });
  assert.equal(ok.sections.capacity, 'ok');
  assert.equal(ok.capacity.pct, 10);
});
test('C2597-03·04 — Isilon REST: SSD·노드 통계 null 은 0 이 아니다', async () => {
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const s = normalizeIsilon({ id: 'i', name: 'i' }, {
    stats: { stats: [{ key: 'ifs.bytes.total', value: 1000 }, { key: 'ifs.bytes.used', value: 400 }, { key: 'ifs.ssd.bytes.total', value: 200 }, { key: 'ifs.ssd.bytes.used', value: null }] },
    nodes: { nodes: [{ lnn: 1, status: { health: 'OK' } }] },
    nodeStats: { stats: [{ devid: 1, key: 'node.net.ext.bytes.in.rate', value: null }, { devid: 1, key: 'node.ifs.bytes.total', value: 500 }, { devid: 1, key: 'node.ifs.bytes.used', value: null }] },
  });
  assert.equal(s.media.ssd.usedBytes, null, '예전: 0(SSD 0%)');
  assert.equal(s.media.hdd.usedBytes, null, '예전: 400(SSD 분 포함)');
  assert.equal(s.nodes.list[0].inBps, null, '예전: 0 bps');
  assert.equal(s.nodes.list[0].hdd.usedBytes, null, '예전: 0');
});
test('C2597-05 — PowerStore 어플라이언스 풀 사용량 결측은 null', () => {
  assert.ok(!/Number\(pt\?\.physical_used\) \|\| 0/.test(read('storage/collectors/powerstore.js')));
});

/* ── C2597-06 GPU 메모리 ── */
test('C2597-06 — 사용량을 못 읽은 GPU 는 메모리 사용률 분모에서 뺀다', async () => {
  const { parseNvidiaSmiCsv } = await import('../src/gpu/guestops.js');
  const r = parseNvidiaSmiCsv('50, 10, 8000, 16000, Disabled\n40, 5, [N/A], 16000, Disabled\n');
  assert.equal(r.memUsedPct, 50, '예전: 25(과소)');
  assert.equal(r.memPartial, 1);
});

/* ── C2597-07 디렉터 포트 키 ── */
test('C2597-07 — 디렉터 포트 처리량은 slot/port 로 키를 잡는다(1/10·11/0 충돌 없음)', async () => {
  const { applyRates, _resetForTest } = await import('../src/sanswitch/rates.js');
  _resetForTest();
  const mk = (a, b) => [{ index: 110, slot: 1, slotPort: '1/10', inBytes: a, outBytes: a }, { index: 110, slot: 11, slotPort: '11/0', inBytes: b, outBytes: b }];
  applyRates('dir', mk(1000, 9_000_000), 0);
  const cur = mk(2000, 9_001_000);
  applyRates('dir', cur, 10_000);
  assert.equal(cur[0].inBps, 800, '1/10: (2000-1000)/10s × 8');
  assert.equal(cur[1].inBps, 800, '11/0: 자기 이전 값과 비교(예전: 1/10 의 카운터와 섞였다)');
});

/* ── C2597-08 vCenter REST 폴백 DS ── */
test('C2597-08 — REST 폴백 DS 의 free_space 결측은 사용률 null', () => {
  const s = read('vcenter/restClient.js');
  assert.match(s, /usagePct: capBytes > 0 && usedBytes != null \?/);
  assert.ok(!/const freeBytes = d\.free_space \|\| 0;/.test(s));
});

/* ── AUTHZ ── */
test('AUTHZ-2597-01 — ping 범위는 대상의 vcenterId 를 먼저 본다', () => {
  const s = read('routes/ping.js');
  assert.match(s, /const vcOfTarget = \(t, id\) => \(t && t\.vcenterId \? String\(t\.vcenterId\) : vcIdOf\(id\)\);/);
});
test('AUTHZ-2597-02 — service-check 는 범위 계정에 함대 수치 문구를 주지 않는다', () => {
  const s = read('routes/api/checksLogs.js');
  assert.match(s, /if \(!scopedVcenterIds\(req\.user, store\.get\(\)\)\) return res\.json\(r\);[\s\S]{0,200}scoped: true/);
});

/* ── LC ── */
test('LC2597-01 — 알림 발생 상태를 파일에 남기고 기동 시 이어받는다', () => {
  const s = read('alerts.js');
  assert.match(s, /const STATE_FILE = path\.join\(config\.configDir, 'alerts-state\.json'\);/);
  assert.match(s, /since: r \? r\.since : now, lastNotified: r \? r\.lastNotified : 0/);
  assert.match(s, /registerExitFlush\('alerts-state'/);
  assert.ok(!/restored\.clear\(\)/.test(s), '복원 목록을 첫 평가에서 비우면 첫 수집 뒤 전부 재발송된다');
});
test('LC2597-02 — 물리 GPU 폴러 주기 변경을 설정 저장·엣지 pull 이 적용한다', () => {
  assert.match(read('routes/admin/gpuGuest.js'), /reschedulePhysicalPoller\(\);/);
  assert.match(read('agent/gpuGuestConfigPull.js'), /reschedulePhysicalPoller/);
});

/* ── DEPS ── */
test('DEPS2597-01 — offline·Windows 빌드의 config 정리 find 식이 같다', () => {
  const findExpr = (p) => {
    const s = fs.readFileSync(path.join(REPO, p), 'utf8');
    const m = /find "\$APP\/server\/config" -mindepth 1 -maxdepth 1 \\\n([\s\S]*?)-exec rm -rf/.exec(s);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  };
  const a = findExpr('packaging/offline/build-package.sh');
  const b = findExpr('packaging/windows/build-collector-win.sh');
  assert.ok(a && b);
  assert.equal(a, b);
  assert.match(a, /-name '\*\.txt'/);
});
test('DEPS2597-02 — 저장소 루트 config/ 는 무시되고 추적되지 않는다', () => {
  const tracked = execFileSync('git', ['ls-files', 'config/'], { cwd: REPO, encoding: 'utf8' }).trim();
  assert.equal(tracked, '');
  // check-ignore 는 무시 대상이 아니면 종료코드 1 로 던진다.
  assert.doesNotThrow(() => execFileSync('git', ['check-ignore', '-q', 'config/vm-track.db'], { cwd: REPO, stdio: 'ignore' }));
});
test('DEPS2597-05·06 — checkout 은 자격증명을 남기지 않고, CI 와 릴리스는 같은 Node 로 lockfile 그대로 설치한다', () => {
  const wf = (f) => fs.readFileSync(path.join(REPO, '.github/workflows', f), 'utf8');
  for (const f of ['ci.yml', 'release.yml', 'horizon-monitor-release.yml']) {
    const s = wf(f);
    const n = (s.match(/actions\/checkout@v4/g) || []).length;
    assert.equal((s.match(/persist-credentials: false/g) || []).length, n, `${f}: checkout 마다 persist-credentials: false`);
  }
  const rel = /NODE_VERSION: '([\d.]+)'/.exec(wf('release.yml'))[1];
  assert.match(wf('ci.yml'), new RegExp(`node-version: '${rel.replace(/\./g, '\\.')}'`));
  assert.ok(!/run: npm run install:all/.test(wf('release.yml')));
});
