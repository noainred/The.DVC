/**
 * v2.749 — 게스트 파티션 사용률 경보: 판정 코어·무시 규칙(Windows/Linux)·설정 저장·DB 최신 값·범위·메일 첨부·라우트 게이트.
 * DB 를 쓰는 테스트는 실제 시각(정시 경계로 떨어뜨린 NOW)을 쓴다(docs/rules/common.md — 제품이 실제 시각으로 자르는 데이터).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpart2749-'));
process.env.CONFIG_DIR = DIR;
process.env.GUESTDISK_DB_PATH = path.join(DIR, 'guest-disk.db');
const R = await import('../src/guestpart/rules.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;   // 정시에서 30분 떨어뜨린 실제 시각

test('osOfPath: 드라이브 문자·UNC 는 Windows, / 는 Linux, 그 밖은 other', () => {
  assert.equal(R.osOfPath('C:\\'), 'win');
  assert.equal(R.osOfPath('d:\\Data\\'), 'win');
  assert.equal(R.osOfPath('\\\\?\\Volume{abc}\\'), 'win');
  assert.equal(R.osOfPath('/var/log'), 'lnx');
  assert.equal(R.osOfPath('Volume1'), 'other');
  assert.equal(R.osOfPath(''), 'other');
});

test('globMatch: * 만 특수 문자 · 대소문자 옵션 · 긴 입력에도 선형에 가깝다(정규식 미사용)', () => {
  assert.equal(R.globMatch('/data/*', '/data/x/y'), true);
  assert.equal(R.globMatch('/data', '/data/x'), false);
  assert.equal(R.globMatch('C:\\Cluster*', 'c:\\clusterstorage\\v1', true), true);
  assert.equal(R.globMatch('C:\\Cluster*', 'c:\\clusterstorage\\v1', false), false);
  assert.equal(R.globMatch('*a*b*c*d*e*', 'x'.repeat(5000)), false);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) R.globMatch('*a*a*a*a*a*b', 'a'.repeat(1024));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `와일드카드 매칭이 느리다: ${ms}ms`);
});

test('ignoreReason: Windows 드라이브·예약·ISO 추정·폴더 마운트·패턴', () => {
  const rules = R.rulesOf({ win: { letters: ['e'], mountdir: true, patterns: ['C:\\ClusterStorage\\*'] } });
  assert.equal(R.ignoreReason({ path: 'E:\\', capGB: 100, usedGB: 99 }, rules), 'win-letter');
  assert.equal(R.ignoreReason({ path: 'e:\\Backup\\', capGB: 100, usedGB: 99 }, rules), 'win-letter', '드라이브 통째 — 그 드라이브의 폴더 마운트도');
  assert.equal(R.ignoreReason({ path: '\\\\?\\Volume{1}\\', capGB: 0.5, usedGB: 0.4 }, R.rulesOf({ tinyOn: false })), 'win-reserved');
  assert.equal(R.ignoreReason({ path: 'F:\\', capGB: 4, usedGB: 4 }, rules), 'win-iso');
  assert.equal(R.ignoreReason({ path: 'F:\\', capGB: 40, usedGB: 40 }, rules), null, '용량이 크면 ISO 로 추정하지 않는다');
  assert.equal(R.ignoreReason({ path: 'C:\\Mount\\db\\', capGB: 100, usedGB: 90 }, rules), 'win-mountdir');
  assert.equal(R.ignoreReason({ path: 'C:\\', capGB: 100, usedGB: 90 }, rules), null, 'C:\\ 루트는 폴더 마운트가 아니다');
  assert.equal(R.ignoreReason({ path: 'C:\\ClusterStorage\\Volume1\\', capGB: 100, usedGB: 90 }, R.rulesOf({ win: { patterns: ['C:\\ClusterStorage\\*'] } })), 'win-pattern');
});

test('ignoreReason: Linux 기본 규칙·패턴(대소문자 구분)·공통(작은 파티션·VM 이름)', () => {
  const d = R.rulesOf(null);
  assert.equal(R.ignoreReason({ path: '/boot', capGB: 1, usedGB: 0.9 }, d), 'lnx-boot');
  assert.equal(R.ignoreReason({ path: '/boot/efi', capGB: 2, usedGB: 0.1 }, d), 'lnx-boot');
  assert.equal(R.ignoreReason({ path: '/bootstrap', capGB: 20, usedGB: 19 }, d), null, '/boot 로 시작하는 다른 이름은 아니다');
  assert.equal(R.ignoreReason({ path: '/run/user/0', capGB: 3, usedGB: 0 }, d), 'lnx-virt');
  assert.equal(R.ignoreReason({ path: '/snap/core/1', capGB: 2, usedGB: 2 }, d), 'lnx-snap');
  assert.equal(R.ignoreReason({ path: '/media/iso', capGB: 4, usedGB: 4 }, d), 'lnx-iso');
  assert.equal(R.ignoreReason({ path: '/var/lib/docker/overlay2/x', capGB: 50, usedGB: 45 }, d), null, 'docker 는 기본 꺼짐');
  const p = R.rulesOf({ lnx: { patterns: ['/opt/backup/*'] } });
  assert.equal(R.ignoreReason({ path: '/opt/backup/a', capGB: 50, usedGB: 45 }, p), 'lnx-pattern');
  assert.equal(R.ignoreReason({ path: '/OPT/backup/a', capGB: 50, usedGB: 45 }, p), null, 'Linux 는 대소문자를 구분한다');
  assert.equal(R.ignoreReason({ path: '/data', capGB: 0.5, usedGB: 0.5 }, d), 'tiny');
  assert.equal(R.ignoreReason({ path: '/data', capGB: 50, usedGB: 45, vmName: 'web-TMPL-01' }, R.rulesOf({ vmPatterns: ['*-tmpl-*'] })), 'vm');
});

test('normalizeRules: 틀린 패턴·드라이브 문자는 저장하지 않고 이유(조용히 빼지 않는다) · 빠진 칸은 이전 값', () => {
  assert.equal(R.normalizeRules({ win: { patterns: ['/x'] } }, null).field, 'rules.win.patterns');
  assert.equal(R.normalizeRules({ lnx: { patterns: ['data'] } }, null).field, 'rules.lnx.patterns');
  assert.equal(R.normalizeRules({ lnx: { patterns: ['/a b'] } }, null).field, 'rules.lnx.patterns');
  assert.equal(R.normalizeRules({ win: { letters: ['AB'] } }, null).field, 'rules.win.letters');
  assert.equal(R.normalizeRules({ tinyGB: 500 }, null).field, 'rules.tinyGB');
  const prev = R.rulesOf({ lnx: { patterns: ['/keep/*'] }, win: { letters: ['D'] } });
  const r = R.normalizeRules({ win: { reserved: false } }, prev).rules;
  assert.deepEqual(r.lnx.patterns, ['/keep/*']);
  assert.deepEqual(r.win.letters, ['D']);
  assert.equal(r.win.reserved, false);
});

test('evaluate: 사용률 모름은 null(0 이 아님)·무시는 판정에서 빠짐·vCenter 별 임계·VM 합계 판정', () => {
  const parts = [
    { vmId: 'a', vmName: 'a', vcenterId: 'vc1', path: 'C:\\', capGB: 100, usedGB: 85, unknown: false },
    { vmId: 'a', vmName: 'a', vcenterId: 'vc1', path: 'D:\\', capGB: 900, usedGB: 100, unknown: false },
    { vmId: 'b', vmName: 'b', vcenterId: 'vc2', path: '/', capGB: 50, usedGB: 42, unknown: false },
    { vmId: 'b', vmName: 'b', vcenterId: 'vc2', path: '/data', capGB: null, usedGB: null, unknown: true },
    { vmId: 'c', vmName: 'c', vcenterId: 'vc1', path: '/boot', capGB: 1, usedGB: 0.99, unknown: false },
  ];
  const s = { threshold: 80, vcThresholds: { vc2: 90 } };
  const ev = R.evaluate(parts, s);
  const by = (vm, p) => ev.parts.find((x) => x.vmId === vm && x.path === p);
  assert.equal(by('a', 'C:\\').over, true);
  assert.equal(by('b', '/').over, false, 'vc2 는 임계 90%');
  assert.equal(by('b', '/data').pct, null);
  assert.equal(by('c', '/boot').ignored, 'lnx-boot');
  assert.equal(by('c', '/boot').over, false);
  assert.deepEqual(R.overKeys(ev), ['a\u0000C:\\']);
  const vm = R.evaluate(parts, s, { mode: 'vm' });
  assert.equal(vm.vms.get('a').pct, 18.5, '합계 185/1000');
  assert.equal(vm.vms.get('a').over, false, 'VM 합계면 큰 D: 가 C: 를 가린다(화면 문구가 이를 밝힌다)');
  const scr = R.evaluate(parts, s, { thrOverride: 70 });
  assert.equal(scr.parts.find((x) => x.vmId === 'b' && x.path === '/').over, true, '화면 임계는 vCenter 별 임계보다 우선');
});

test('etaDays·histogram: 증가가 없거나 모르면 예상하지 않는다 · 구간 경계는 이상 쪽', () => {
  assert.equal(R.etaDays(10, 7), 10);
  assert.equal(R.etaDays(10, 0), null);
  assert.equal(R.etaDays(10, null), null);
  const h = R.histogram([{ pct: 80 }, { pct: 79.9 }, { pct: 95 }, { pct: null }, { pct: 99, ignored: 'tiny' }]);
  assert.equal(h.find((b) => b.from === 80).count, 1);
  assert.equal(h.find((b) => b.from === 70).count, 1);
  assert.equal(h.find((b) => b.from === 95).count, 1);
});

test('settings.save: 형식 오류는 저장 거부 · 통합 메일 since 는 켤 때 지금 · vCenter 메일 null 은 삭제 · 공개 판본에 메일 없음', async () => {
  const S = await import('../src/guestpart/settings.js');
  assert.equal(S.save({ threshold: 45 }).field, 'threshold');
  assert.equal(S.save({ mail: { from: 'not-an-email' } }).field, 'mail.from');
  assert.equal(S.save({ mail: { digest: { enabled: true, days: [] } } }).field, 'mail.digest.days');
  assert.equal(S.save({ mail: { digest: { time: '25:00' } } }).field, 'mail.digest.time');
  assert.match(S.save({ mail: { vcenters: { 'vc-1': { when: 'x' } } } }).error, /수집이 끝날 때마다/);
  const r = S.save({ threshold: 85, mail: { from: 'alert@example.com', commonTo: 'a@example.com, b@example.com', digest: { enabled: true, days: [1], time: '09:00', to: 'c@example.com' },
    vcenters: { 'vc-1': { to: ['o@example.com'], when: 'schedule', days: [2], time: '08:30' } } } }, 1000);
  assert.ok(r.settings);
  assert.equal(r.settings.mail.digest.since, 1000);
  assert.deepEqual(r.settings.mail.commonTo, ['a@example.com', 'b@example.com']);
  assert.equal(r.settings.mail.vcenters['vc-1'].since, 1000);
  const r2 = S.save({ mail: { digest: { topN: 20 } } }, 5000);
  assert.equal(r2.settings.mail.digest.since, 1000, '요일·시각이 같으면 since 유지(소급 발송 방지 규칙)');
  const r3 = S.save({ mail: { vcenters: { 'vc-1': null } } });
  assert.equal(r3.settings.mail.vcenters['vc-1'], undefined);
  const pub = S.publicSettings();
  assert.equal(pub.mail, undefined);
  assert.equal(pub.threshold, 85);
});

test('DB part_latest: vCenter 단위 교체 · 값 모름 파티션은 unknown · 빈 수집은 지우지 않음 · 커밋 알림', async () => {
  const db = await import('../src/guestdisk/db.js');
  const got = [];
  db.onGuestDiskCommitted((x) => got.push(x.vcenterId));
  const vmA = { vmId: 'vc-a:vm1', vmName: 'vm1', allocGB: 150, usedGB: 120, partCount: 2, parts: [{ path: 'C:\\', capGB: 100, usedGB: 90 }, { path: 'D:\\', capGB: 50, usedGB: 30 }], partsUnknown: 1, unknownPaths: ['E:\\'] };
  const vmB = { vmId: 'vc-b:vm2', vmName: 'vm2', allocGB: 50, usedGB: 45, partCount: 1, parts: [{ path: '/', capGB: 50, usedGB: 45 }] };
  assert.ok((await db.commitCollection('vc-a', 'VC-A', [vmA], { ts: NOW - 8 * 86_400_000 })).ok);
  assert.ok((await db.commitCollection('vc-a', 'VC-A', [{ ...vmA, usedGB: 125, parts: [{ path: 'C:\\', capGB: 100, usedGB: 95 }, vmA.parts[1]] }], { ts: NOW })).ok);
  assert.ok((await db.commitCollection('vc-b', 'VC-B', [vmB], { ts: NOW })).ok);
  let rows = await db.listPartLatest(null);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((r) => r.path === 'C:\\').usedGB, 95, '이번 수집 값(변화 기준 미만이어도)');
  const e = rows.find((r) => r.path === 'E:\\');
  assert.equal(e.unknown, true); assert.equal(e.usedGB, null);
  assert.equal((await db.commitCollection('vc-a', 'VC-A', [], { ts: NOW + 1 })).skippedEmpty, true);
  rows = await db.listPartLatest(['vc-a']);
  assert.equal(rows.length, 3, '빈 수집은 직전 값을 지우지 않는다');
  const base = await db.partUsedAt(['vc-a:vm1'], NOW - 7 * 86_400_000);
  assert.equal(base.get('vc-a:vm1\u0000C:\\'), 90, '7일 전 기준 = 그때 유효하던 기록');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(got.includes('vc-a') && got.includes('vc-b'));
  const pr = await db.pruneOrphanVcenters(new Set(['vc-a']));
  assert.ok(pr.ok);
  assert.equal((await db.listPartLatest(['vc-b'])).length, 0, '지운 vCenter 의 최신 값도 지운다');
});

test('report.overview: 범위(allowed)는 DB 행을 읽은 뒤 화면 필터보다 먼저 — 범위 밖 vCenter 의 행이 나가지 않는다', async () => {
  const db = await import('../src/guestdisk/db.js');
  const { overview, vcenterDetail, _resetPartsCache } = await import('../src/guestpart/report.js');
  await db.commitCollection('vc-b', 'VC-B', [{ vmId: 'vc-b:vm2', vmName: 'vm2', allocGB: 50, usedGB: 48, partCount: 1, parts: [{ path: '/', capGB: 50, usedGB: 48 }] }], { ts: NOW });
  _resetPartsCache();
  const all = await overview({ allowed: null, now: NOW });
  assert.ok(all.rows.some((r) => r.vcenterId === 'vc-b'));
  assert.ok(all.rows.some((r) => r.vcenterId === 'vc-a'));
  const only = await overview({ allowed: new Set(['vc-a']), now: NOW });
  assert.ok(only.rows.length > 0 && only.rows.every((r) => r.vcenterId === 'vc-a'));
  assert.ok(only.vcenters.every((v) => v.id === 'vc-a'));
  assert.equal(await vcenterDetail('vc-b', { allowed: new Set(['vc-a']) }), null, '범위 밖 단건은 null(라우트가 404)');
  const row = only.rows.find((r) => r.path === 'C:\\');
  assert.equal(row.growth7dGB, 5, '7일 전 90 → 지금 95');
});

test('smtp.buildMime: 첨부는 multipart/mixed · 파일 이름·형식은 화이트리스트(헤더 주입 차단) · 첨부 없으면 예전 모양', async () => {
  const { buildMime } = await import('../src/util/smtp.js');
  const plain = buildMime({ from: 'a@b.co', to: ['c@d.co'], subject: 's', html: '<b>x</b>', text: 'x' });
  assert.match(plain, /multipart\/alternative/);
  assert.doesNotMatch(plain, /multipart\/mixed/);
  const m = buildMime({ from: 'a@b.co', to: ['c@d.co'], subject: 's', html: '<b>x</b>', text: 'x', attachments: [{ filename: 'over-80.csv', contentType: 'text/csv', content: 'a,b\n1,2' }] });
  assert.match(m, /multipart\/mixed/);
  assert.match(m, /multipart\/alternative/);
  assert.match(m, /Content-Disposition: attachment; filename="over-80.csv"/);
  assert.match(m, new RegExp(Buffer.from('a,b\n1,2').toString('base64')));
  assert.throws(() => buildMime({ from: 'a@b.co', to: ['c@d.co'], subject: 's', text: 'x', attachments: [{ filename: 'a"\r\nBcc: x@y.z', content: '1' }] }), /이름/);
  assert.throws(() => buildMime({ from: 'a@b.co', to: ['c@d.co'], subject: 's', text: 'x', attachments: [{ filename: 'a.csv', contentType: 'text/csv\r\nX: y', content: '1' }] }), /형식/);
});

test('notify: 받는 사람이 없으면 보내지 않고 기록(공용 서비스가 빈 목록을 기본 수신자로 바꾸지 않게)', async () => {
  const S = await import('../src/guestpart/settings.js');
  S.save({ mail: { commonTo: [], digest: { enabled: true, days: [1], includeAdmin: false, to: [] } } });
  const N = await import('../src/guestpart/notify.js');
  const r = await N.sendDigest({ manual: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-recipients');
  const s = N.mailStatus();
  assert.equal(s.history[0].code, 'no-recipients');
  assert.equal(JSON.stringify(s).includes('@'), false, '상태·기록에 주소가 없다');
});

test('라우트 게이트: 조회는 tools 권한, CSV 는 data.csv, 설정 저장·메일은 관리자 + 전체 범위 · 도구 키 매핑·메일 종류 등록', () => {
  const src = fs.readFileSync(path.join(HERE, '../src/routes/api/toolsGuestPart.js'), 'utf8');
  assert.match(src, /api\.get\('\/tools\/guest-partition', toolsPerm,/);
  assert.match(src, /api\.get\('\/tools\/guest-partition\/vcenter\/:id', toolsPerm,/);
  assert.match(src, /api\.get\('\/tools\/guest-partition\/export\.csv', csvPerm, toolsPerm,/);
  assert.match(src, /api\.put\('\/tools\/guest-partition\/settings', adminOnly, fullScopeOnly,/);
  for (const p of ['mail', 'mail/preview', 'mail/send', 'mail/test']) assert.match(src, new RegExp(`'/tools/guest-partition/${p.replace('/', '\\/')}', adminOnly, fullScopeOnly,`));
  const ta = fs.readFileSync(path.join(HERE, '../src/auth/toolAccess.js'), 'utf8');
  assert.match(ta, /'guest-partition': 'guest-partition'/);
  const k = fs.readFileSync(path.join(HERE, '../src/mail/kinds.js'), 'utf8');
  assert.match(k, /id: 'guestpart'/);
});
