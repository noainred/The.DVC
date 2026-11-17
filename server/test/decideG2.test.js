/**
 * decideG2.test.js — 결정(56~75 남긴 것) 그룹 G2: 읽기 오류 ≠ 손상 · 공용 로더(util/jsonFileLoad.js).
 *
 * 배경(57 · 58 · 60 · 62 · 65 · 69 · 70 · 73 · 74 회차가 모듈마다 따로 고친 꼴): '읽기 → JSON.parse → 실패면 preserveCorrupt' 를 catch 하나로 받아
 *   읽기 오류(EACCES · EIO · EISDIR · EMFILE)에도 온전한 원본을 .corrupt 로 옮긴 뒤 빈 값으로 돌았다 — 다음 저장이 한 건만 든 파일을 썼다.
 *  U  공용 로더: 넷(missing · read-error · corrupt · ok)을 단계로 가른다 · 읽기 오류는 옮기지 않고 30초 간격으로만 다시 읽는다 · 확정 불가
 *  70 ① fleet-tags · fleet-assign   73 ① 게시판 · 공지 · 메일 · DataCenter   73 ③ GET /admin/mail 범위 관리자 가림
 *  60/62 IPAM 예약 · 메모(읽기 오류) · GET 표지 · 쓰기 409 통일 · CSV 내보내기 409   60 VM DNS 정책 표지 · 409
 *  65 ① 통신 점검 배정(등록부 손상 → null · 503)   65 ② VM 백업 NFS 정의   57 PowerScale 점검 설정(보존본만 남은 재시작 뒤에도 보류)
 *  71 cost · vmhygiene · tags 재읽기 간격   스윕: 위 모듈에 '읽기 오류를 preserveCorrupt 로 보내는 catch' 가 다시 생기지 않게
 * 읽기 오류는 root 컨테이너라 EACCES 대신 **EISDIR**(파일 자리에 폴더 — 실제 fs 오류)와 fs.readFileSync 주입 **EIO** 로 재현한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'decideG2-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
/** 파일 자리에 폴더를 두어 실제 읽기 오류(EISDIR)를 만든다 — 지우면 풀린다. */
const asDir = (n) => { fs.rmSync(F(n), { recursive: true, force: true }); fs.mkdirSync(F(n)); };
const unDir = (n) => fs.rmSync(F(n), { recursive: true, force: true });
/** fs.readFileSync 에 EIO 를 주입한다(그 파일 이름만). */
function withEio(name, fn) {
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === name) { reads += 1; const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return orig.call(fs, f, ...a); };
  try { fn(); } finally { fs.readFileSync = orig; }
  return reads;
}

// 기준 시각: 실제 시각을 정시 경계로 떨어뜨려 고정 · 재읽기 간격 판정은 이 시계로
let clockAt = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const J = await import('../src/util/jsonFileLoad.js');
J._setJsonFileLoadClockForTest(() => clockAt);
const advance = () => { clockAt += J.READ_RETRY_MS + 1_000; };
const U = await import('../src/util/settingsLoadError.js');
const express = (await import('express')).default;
const FULL = { username: 'root', role: 'admin', scope: null };

async function call(mount, user, method, url, body) {
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = user; next(); });
  mount(app);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _q, res, _n) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* CSV 등 */ }
    return { status: res.status, body: json, text };
  } finally { srv.close(); }
}

/* ── U 공용 로더 ─────────────────────────────────────────────────── */
test('U: readJsonFile 은 넷을 단계로 가른다 — 읽기 오류는 옮기지 않고, 파싱 · 형식 실패만 보존본으로 옮긴다', () => {
  assert.equal(J.readJsonFile(F('u-none.json')).kind, 'missing');
  asDir('u-dir.json');
  const rd = J.readJsonFile(F('u-dir.json'));
  assert.equal(rd.kind, 'read-error'); assert.equal(rd.error.code, 'EISDIR');
  assert.ok(fs.statSync(F('u-dir.json')).isDirectory(), '읽기 오류인 원본(폴더)을 옮기지 않는다');
  assert.deepEqual(corruptOf('u-dir.json'), []);
  fs.writeFileSync(F('u-bad.json'), '{ broken');
  assert.equal(J.readJsonFile(F('u-bad.json')).kind, 'corrupt');
  assert.equal(corruptOf('u-bad.json').length, 1, '손상은 예전처럼 보존');
  // parse 가 code 붙은 오류를 던져도 손상이다(단계로 가른다 — e.code 유무가 아니다)
  fs.writeFileSync(F('u-code.json'), '{}');
  assert.equal(J.readJsonFile(F('u-code.json'), { parse: () => { const e = new Error('x'); e.code = 'EACCES'; throw e; } }).kind, 'corrupt');
  fs.writeFileSync(F('u-ok.json'), '{"a":1}');
  const ok = J.readJsonFile(F('u-ok.json'));
  assert.equal(ok.kind, 'ok'); assert.deepEqual(ok.value, { a: 1 });
  assert.equal(J.readJsonFile(F('u-arr.json'), {}).kind, 'missing');
  fs.writeFileSync(F('u-arr.json'), '[1]');
  assert.equal(J.readJsonFile(F('u-arr.json')).kind, 'corrupt', '객체가 아닌 JSON 은 손상(parseJsonObject)');
});

test('U: 읽기 오류 뒤 다시 읽기는 30초 간격 — 간격 안에서는 디스크를 보지 않는다(71) · 읽기 오류는 확정 불가 · 사유가 다시 읽음을 말한다', () => {
  fs.writeFileSync(F('u-retry.json'), '{"v":7}');
  const L = J.makeJsonFileLoader(() => F('u-retry.json'), { label: 't', confirm: () => {} });
  let n = withEio('u-retry.json', () => { for (let i = 0; i < 5; i++) assert.equal(L.load().kind, 'read-error'); });
  assert.equal(n, 1, `간격 안의 4회는 디스크를 다시 읽지 않는다(실제 읽기 ${n}회)`);
  const e = L.loadError();
  assert.equal(e.readError, true);
  assert.match(e.reason, /30초마다 다시 읽고/);
  assert.equal(L.refusal('시험').code, 'settings-unreadable');
  assert.match(L.refusal('시험').reason, /읽기 오류이고 원본은 그대로/);
  assert.equal(U.confirmSettingsDefault('u-retry.json').code, 'not-confirmable', '읽기 오류는 확정(빈 값으로 덮기)할 수 없다');
  n = withEio('u-retry.json', () => { advance(); L.load(); });
  assert.equal(n, 1, '간격이 지나면 다시 읽는다');
  advance();
  const r = L.load();
  assert.equal(r.kind, 'ok'); assert.equal(r.value.v, 7);
  assert.equal(L.loadError(), null, '다시 읽히면 재시작 없이 풀린다');
  assert.deepEqual(corruptOf('u-retry.json'), []);
});

/* ── 70 ① fleet-tags · fleet-assign ─────────────────────────────── */
test('70 ①: fleet-tags 읽기 오류 — 원본을 옮기지 않고 · 쓰기 거절(409 코드) · 표지 · 간격 뒤 다시 읽어 값이 돌아온다', async () => {
  const T = await import('../src/insights/fleetTags.js');
  asDir('fleet-tags.json');
  assert.deepEqual(T.loadFleetTags(), {});
  const m = T.fleetTagsLoadError();
  assert.ok(m && m.readError, '표지(수정 전: 없음 — 원본을 .corrupt 로 옮기고 빈 값)');
  const r = T.setFleetTag('abc1234', 'exclude');
  assert.equal(r.ok, false); assert.equal(r.code, 'settings-unreadable');
  assert.equal(T.setFleetPurpose('abc1234', null).code, 'settings-unreadable');
  assert.equal(T.setFleetTagsBatch([{ key: 'k', tag: 'exclude' }]).code, 'settings-unreadable');
  assert.equal(T.pruneFleetTags(new Set()), 0);
  assert.ok(fs.statSync(F('fleet-tags.json')).isDirectory(), '원본 자리를 그대로 둔다');
  assert.deepEqual(corruptOf('fleet-tags.json'), []);
  // 권한을 고친 것처럼 — 폴더를 지우고 원래 파일을 둔다 → 간격 뒤 다시 읽는다
  unDir('fleet-tags.json');
  fs.writeFileSync(F('fleet-tags.json'), JSON.stringify({ tags: { keep1: 'exclude' } }));
  advance();
  assert.deepEqual(T.loadFleetTags(), { keep1: 'exclude' });
  assert.equal(T.fleetTagsLoadError(), null);
  assert.equal(T.setFleetTag('abc1234', 'baremetal').ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(F('fleet-tags.json'), 'utf8')).tags, { keep1: 'exclude', abc1234: 'baremetal' }, '원본 위에 더해 썼다');
});

test('70 ①: fleet-assign 손상 — 보존 · 쓰기 거절 · 서비스 점검 확정 뒤 다시 쓸 수 있다 · 라우트 409', async () => {
  const A = await import('../src/insights/fleetAssign.js');
  fs.writeFileSync(F('fleet-assign.json'), '{"assign":{"x":"vc-a"');
  assert.deepEqual(A.loadFleetAssign(), {});
  assert.equal(corruptOf('fleet-assign.json').length, 1);
  assert.equal(A.setFleetAssign('svc1', 'vc-a').code, 'settings-unreadable');
  assert.equal(A.setFleetAssignMany([['svc1', 'vc-a']]).code, 'settings-unreadable');
  assert.ok(!fs.existsSync(F('fleet-assign.json')), '한 건만 든 새 파일을 쓰지 않았다');
  assert.ok(U.listSettingsLoadErrors().some((x) => x.file === 'fleet-assign.json' && x.confirmable), '서비스 점검 등재');
  // 라우트: 일괄 귀속은 레지스트리를 바꾸기 전에 409
  const { insightsRouter } = await import('../src/routes/insights.js');
  const res = await call((app) => app.use('/api/insights', insightsRouter), FULL, 'PUT', '/api/insights/fleet/assign-bulk', { items: [{ key: 'svc1' }], vcenterId: '' });
  assert.equal(res.status, 409, JSON.stringify(res.body)); assert.equal(res.body.code, 'settings-unreadable');
  const c = U.confirmSettingsDefault('fleet-assign.json', { by: 't' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(A.setFleetAssign('svc1', 'vc-a').ok, true);
  assert.equal(corruptOf('fleet-assign.json').length, 1, '보존본은 남는다');
});

/* ── 73 ① 게시판 · 공지 ─────────────────────────────────────────── */
test('73 ①: 게시판 읽기 오류(EIO) — 빈 목록 + 표지 · 글쓰기 409 · 원본 그대로 · 간격 뒤 글이 다시 보인다', async () => {
  const B = await import('../src/bulletin/store.js');
  fs.writeFileSync(F('board.json'), JSON.stringify({ posts: [{ id: 'aaaaaaaaaaaaaaaa', title: '원본 글', body: 'x', author: 'u', createdAt: 1, updatedAt: 1, comments: [], likes: [] }] }));
  B._resetBulletinCache();
  withEio('board.json', () => {
    assert.equal(B.listPosts().total, 0);
    const le = B.bulletinLoadError('board');
    assert.ok(le && le.readError, '표지(수정 전: 없음)');
    assert.throws(() => B.createPost({ title: 't', body: 'b' }, 'u'), (e) => e.status === 409 && e.extra?.code === 'settings-unreadable');
    assert.throws(() => B.setLike('aaaaaaaaaaaaaaaa', null, 'u', true), (e) => e.status === 409);
  });
  assert.deepEqual(corruptOf('board.json'), [], '읽기 오류로 원본을 옮기지 않았다(수정 전: .corrupt 로 옮김)');
  assert.equal(JSON.parse(fs.readFileSync(F('board.json'), 'utf8')).posts.length, 1);
  advance();
  assert.equal(B.listPosts().total, 1, '간격이 지나면 다시 읽는다(빈 목록을 캐시하지 않았다)');
  assert.equal(B.bulletinLoadError('board'), null);
});

test('73 ①: 공지 손상 — 보존 · 쓰기 409 · 확정 뒤 다시 쓸 수 있다 · 라우트 409 + code · 목록 표지', async () => {
  const B = await import('../src/bulletin/store.js');
  fs.writeFileSync(F('notices.json'), '{"notices": 3}');
  B._resetBulletinCache();
  assert.deepEqual(B.listNotices(), []);
  assert.equal(corruptOf('notices.json').length, 1);
  assert.throws(() => B.createNotice({ title: '새 공지' }, 'root'), (e) => e.status === 409);
  const { registerBulletin } = await import('../src/routes/api/bulletin.js');
  const mount = (app) => { const r = express.Router(); registerBulletin(r); app.use('/api', r); };
  const g = await call(mount, FULL, 'GET', '/api/notices');
  assert.equal(g.status, 200); assert.ok(g.body.loadError, '목록 응답 표지');
  const p = await call(mount, FULL, 'POST', '/api/notices', { title: '새 공지' });
  assert.equal(p.status, 409, JSON.stringify(p.body)); assert.equal(p.body.code, 'settings-unreadable');
  assert.ok(!fs.existsSync(F('notices.json')), '한 건만 든 새 공지 파일을 쓰지 않았다');
  assert.equal(U.confirmSettingsDefault('notices.json', { by: 't' }).ok, true);
  assert.equal(B.createNotice({ title: '새 공지' }, 'root').title, '새 공지');
  B.flushBulletinNow();
});

/* ── 73 ① 메일 · 73 ③ 가림 ──────────────────────────────────────── */
test('73 ①: 메일 설정 읽기 오류 — 기본값(꺼짐)을 캐시하지 않고 · 저장 409 · 원본 그대로 · 간격 뒤 다시 읽는다', async () => {
  const M = await import('../src/mail/settings.js');
  fs.writeFileSync(F('mail.json'), JSON.stringify({ enabled: true, smtp: { host: 'relay.corp.local', user: 'svc-mail', from: 'p@corp.com' }, defaultTo: ['a@corp.com', 'b@corp.com'], kinds: { alert: { to: ['ops@corp.com'] } } }));
  M.invalidate();
  withEio('mail.json', () => {
    assert.equal(M.load().enabled, false, '읽지 못한 동안은 기본값(발송 꺼짐)');
    assert.ok(M.mailSettingsLoadError()?.readError);
    assert.equal(M.mailSaveRefusal().code, 'settings-unreadable');
    assert.throws(() => M.save({ enabled: true }), (e) => e.status === 409);
  });
  assert.deepEqual(corruptOf('mail.json'), []);
  assert.equal(JSON.parse(fs.readFileSync(F('mail.json'), 'utf8')).smtp.user, 'svc-mail', '원본(SMTP 계정)이 그대로');
  advance();
  assert.equal(M.load().enabled, true);
  assert.equal(M.mailSettingsLoadError(), null);
});

test('73 ③: GET /admin/mail — 범위 관리자(조회 또는 쓰기 범위 제한)에게 SMTP 계정 · 전 종류 수신자 목록을 가린다 · 전체 범위는 원문', async () => {
  const { registerMail, scopeMailSettings } = await import('../src/routes/admin/mail.js');
  const mount = (app) => { const r = express.Router(); registerMail(r); app.use('/api/admin', r); };
  const full = await call(mount, FULL, 'GET', '/api/admin/mail');
  assert.equal(full.status, 200);
  assert.equal(full.body.settings.smtp.user, 'svc-mail');
  assert.deepEqual(full.body.settings.defaultTo, ['a@corp.com', 'b@corp.com']);
  assert.equal(full.body.settings.scopedMasked, undefined);
  for (const user of [{ username: 'kr', role: 'admin', scope: { vcenters: ['vc-kr'] } }, { username: 'w', role: 'admin', scope: { writeVcenters: ['vc-kr'] } }]) {
    const s = await call(mount, user, 'GET', '/api/admin/mail');
    assert.equal(s.status, 200);
    const st = s.body.settings;
    assert.equal(st.scopedMasked, true, JSON.stringify(user.scope));
    assert.equal(st.smtp.user, ''); assert.equal(st.smtp.hasUser, true);
    assert.deepEqual(st.defaultTo, []); assert.equal(st.defaultToCount, 2);
    assert.deepEqual(st.kinds.alert.to, []); assert.equal(st.kinds.alert.toCount, 1);
    assert.ok(!JSON.stringify(s.body).includes('svc-mail') && !JSON.stringify(s.body).includes('ops@corp.com'), '응답 어디에도 원문이 없다');
    assert.equal(st.smtp.host, 'relay.corp.local', '서버 주소는 그대로(계정 · 수신자 목록이 아니다)');
  }
  assert.equal(scopeMailSettings({ smtp: { user: 'x' } }, true).smtp.user, 'x');
});

/* ── 73 ① DataCenter ────────────────────────────────────────────── */
test('73 ①: DataCenter 등록부 읽기 오류 — 원본 유지 · 추가 · 백필(ensure) · 할당 거절 · 표지', async () => {
  const D = await import('../src/datacenter/store.js');
  asDir('datacenters.json');
  assert.deepEqual(D.listDatacenters(), []);
  assert.ok(D.datacentersLoadError()?.readError);
  assert.equal(D.addDatacenter({ id: 'kr', name: 'KR' }).code, 'settings-unreadable');
  assert.equal(D.ensureDatacenter({ id: 'kr' }).code, 'settings-unreadable', '수집 서버 백필도 읽지 못한 등록부 위에 쓰지 않는다');
  assert.equal(D.setVcenterDatacenterMany([['vc1', 'kr']]).code, 'settings-unreadable');
  assert.deepEqual(corruptOf('datacenters.json'), []);
  unDir('datacenters.json');
  D.resetDatacenters();
});

/* ── 60/62 IPAM ─────────────────────────────────────────────────── */
test('62: IPAM 예약(override) 읽기 오류 — 원본 유지 · 확정 불가 · 단건 PUT · bulk · 메모 PUT 모두 409(통일) · GET 표지 · CSV 409', async () => {
  const O = await import('../src/ipam/overrides.js');
  const A = await import('../src/ipam/annotations.js');
  asDir('ipam-overrides.json');
  fs.writeFileSync(F('ipam-annotations.json'), '{"10.0.0.5":');   // 메모는 손상
  assert.equal(O.getOverride('10.0.0.5'), null);
  assert.ok(O.overridesLoadError()?.readError, '읽기 오류(수정 전: 손상과 같이 보존본으로 옮기고 확정을 열었다)');
  assert.deepEqual(corruptOf('ipam-overrides.json'), []);
  assert.equal(U.confirmSettingsDefault('ipam-overrides.json').code, 'not-confirmable');
  assert.equal(O.setOverride('10.0.0.5', { status: 'reserved' }, FULL).readError, true);
  assert.ok(A.annotationsLoadError() && !A.annotationsLoadError().readError, '메모는 손상(보존)');
  assert.equal(corruptOf('ipam-annotations.json').length, 1);
  const { registerIpamExport } = await import('../src/routes/api/ipamExport.js');
  const mount = (app) => { const rt = express.Router(); registerIpamExport(rt); app.use('/api', rt); };
  const put = await call(mount, FULL, 'PUT', '/api/tools/ipam/ip/10.0.0.5', { status: 'reserved' });
  assert.equal(put.status, 409, `단건 PUT(수정 전 400): ${JSON.stringify(put.body)}`); assert.equal(put.body.code, 'settings-unreadable');
  const bulk = await call(mount, FULL, 'POST', '/api/tools/ipam/bulk', { ips: ['10.0.0.5', '10.0.0.6'], status: 'reserved' });
  assert.equal(bulk.status, 409, `bulk(수정 전 400): ${JSON.stringify(bulk.body)}`);
  const ann = await call(mount, FULL, 'PUT', '/api/tools/ipam/annotation', { ip: '10.0.0.5', memo: 'x' });
  assert.equal(ann.status, 409, `메모 PUT(수정 전 400): ${JSON.stringify(ann.body)}`);
  const g = await call(mount, FULL, 'GET', '/api/tools/ipam/ip/10.0.0.5');
  assert.ok(g.body.loadError?.readError, '예약 GET 표지');
  const ga = await call(mount, FULL, 'GET', '/api/tools/ipam/annotation?ip=10.0.0.5');
  assert.ok(ga.body.loadError && !ga.body.loadError.readError, '메모 GET 표지');
  const meta = await call(mount, FULL, 'GET', '/api/tools/ipam/manage-meta');
  assert.ok(meta.body.loadError?.overrides && meta.body.loadError?.annotations);
  const csv = await call(mount, FULL, 'GET', '/api/tools/ipam/manage.csv');
  assert.equal(csv.status, 409, '빈 CSV 를 온전한 내보내기로 주지 않는다');
  const dry = await call(mount, FULL, 'POST', '/api/tools/ipam/manage/import', { csv: 'ip,status\n10.0.0.9,reserved\n', dryRun: true });
  assert.equal(dry.status, 409, '미리보기도 빈 맵으로 판정하지 않는다');
  // vCenter 별 대역 — 손상 중 GET 표지 · CSV 409
  fs.writeFileSync(F('ipam-vcenter-ranges.json'), '{"vcenters":');
  const vr = await call(mount, FULL, 'GET', '/api/tools/ipam/vc-ranges');
  assert.ok(vr.body.loadError, 'vc-ranges GET 표지(수정 전: 빈 목록만)');
  const vcsv = await call(mount, FULL, 'GET', '/api/tools/ipam/vc-ranges.csv');
  assert.equal(vcsv.status, 409);
  // 권한을 고친 것처럼 — 간격 뒤 다시 읽어 예약이 돌아오고, 원장 캐시 키(overridesRev)가 바뀐다(빈 예약으로 만든 원장을 붙잡지 않게)
  const rev0 = O.overridesRev();
  unDir('ipam-overrides.json');
  fs.writeFileSync(F('ipam-overrides.json'), JSON.stringify({ '10.0.0.5': { status: 'reserved', owner: 'ops' } }));
  advance();
  assert.equal(O.getOverride('10.0.0.5')?.owner, 'ops', '읽기 오류 동안의 빈 값을 캐시하지 않았다');
  assert.equal(O.overridesLoadError(), null);
  assert.ok(O.overridesRev() > rev0, '읽기 오류 구간을 나오면 리비전이 바뀐다');
});

/* ── 60 VM DNS 정책 ──────────────────────────────────────────────── */
test('60: VM DNS 정책 — 읽기 오류는 원본 유지 · 손상은 보존 — 둘 다 표지 · 저장 409 · 확정', async () => {
  const P = await import('../src/vmdns/policy.js');
  fs.writeFileSync(F('vm-dns-policy.json'), JSON.stringify({ corps: { vc1: ['10.20.0.53'] }, publicUnapproved: false }));
  P.invalidateVmDnsPolicy();
  withEio('vm-dns-policy.json', () => {
    const p = P.loadVmDnsPolicy();
    assert.ok(p.loadError?.readError);
    assert.equal(P.saveVmDnsPolicy({ publicUnapproved: true }, 'u').code, 'settings-unreadable', 'publicUnapproved 만 바꾸는 저장이 빈 법인 목록으로 덮지 않는다');
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(F('vm-dns-policy.json'), 'utf8')).corps, { vc1: ['10.20.0.53'] });
  advance();
  assert.deepEqual(P.loadVmDnsPolicy().corps, { vc1: ['10.20.0.53'] });
  fs.writeFileSync(F('vm-dns-policy.json'), '[1,2]');
  P.invalidateVmDnsPolicy();
  const p2 = P.loadVmDnsPolicy();
  assert.ok(p2.loadError && !p2.loadError.readError, '손상 표지(수정 전: 표지 없이 기본값 — 화면이 설정 없음으로 보였다)');
  assert.equal(corruptOf('vm-dns-policy.json').length, 1);
  assert.equal(P.saveVmDnsPolicy({ corps: {} }, 'u').code, 'settings-unreadable');
  assert.equal(U.confirmSettingsDefault('vm-dns-policy.json', { by: 't' }).ok, true);
  assert.equal(P.saveVmDnsPolicy({ corps: { vc2: ['10.0.0.1'] } }, 'u').ok, true);
});

/* ── 65 ② VM 백업 NFS 정의 · 65 ① 통신 점검 배정 ───────────────────── */
test('65 ②: NFS 데이터스토어 정의 읽기 오류 — 원본 유지 · 추가 거절(code) · 표지', async () => {
  const N = await import('../src/vmclone/nfsDs.js');
  fs.writeFileSync(F('vm-clone-nfsds.json'), JSON.stringify({ version: 1, items: [{ id: 'nfsds-1', vcenterId: 'vc1', name: 'bk', hosts: {} }] }));
  N._resetNfsDsForTest();
  withEio('vm-clone-nfsds.json', () => {
    assert.deepEqual(N.listNfsDs(), []);
    assert.ok(N.nfsDsLoadError()?.readError);
    assert.throws(() => N.createNfsDs({ vcenterId: 'vc1', name: 'n2', server: '10.0.0.9', exportPath: '/x', nfsVersion: '3' }, 'u'), (e) => e.code === 'settings-unreadable');
    assert.equal(N.applyAttachResult('nfsds-1', [{ hostId: 'h1', ok: true }]), false, '빈 목록에 결과를 써 파일을 덮지 않는다');
  });
  assert.deepEqual(corruptOf('vm-clone-nfsds.json'), []);
  assert.equal(JSON.parse(fs.readFileSync(F('vm-clone-nfsds.json'), 'utf8')).items.length, 1);
  advance();
  assert.equal(N.listNfsDs().length, 1);
});

test('65 ①: 수집 서버 등록부 손상이면 배정은 빈 목록이 아니라 null · 보고는 503(registryUnreadable)로 보류', async () => {
  fs.writeFileSync(F('collectors.json'), '{"collectors":[');
  const L = await import('../src/central/linkCheckEdge.js');
  assert.equal(L.assignedEdgeLinkIds('edge-kr'), null, '수정 전: 빈 Set(배정 0 — 전부 notAssigned 로 거절)');
  const out = await L.putEdgeLinkReport('edge-kr', { results: [] });
  assert.equal(out.ok, false); assert.equal(out.registryUnreadable, true); assert.equal(out.reason, 'registryUnreadable');
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/central/opsRoutes.js'), 'utf8'));
  assert.match(src, /if \(out\?\.registryUnreadable\) return res\.status\(503\)\.set\(PERSISTENT_503_HEADERS\)/);
  fs.writeFileSync(F('collectors.json'), JSON.stringify({ collectors: [] }));
  assert.ok(L.assignedEdgeLinkIds('edge-kr') instanceof Set, '읽히면 다시 판정한다');
});

/* ── 57 PowerScale 점검 설정 ────────────────────────────────────── */
test('57: PowerScale 점검 설정 손상 — 보존본만 남은 재시작 뒤에도 기본값(켜짐)으로 돌지 않고 보류 · 다음 회차 시각 없음 · 저장 409 · 읽기 오류는 원본 유지', async () => {
  const S = await import('../src/storage/inspect/schedule.js');
  // 재시작 뒤 상태: 원본 없이 손상 보존본만
  fs.writeFileSync(F('storage-inspect.json.corrupt.2026-11-01T00-00-00'), '{"enabled":false');
  S._resetScheduleForTest();
  assert.ok(S.settingsLoadError(), '수정 전: null(파일 없음 = 기본값 enabled:true 로 주간 점검이 켜졌다)');
  assert.equal((await S.inspectTick(clockAt)).action, 'unreadable');
  assert.equal(S.inspectScheduleStatus(clockAt).nextRunAt, null, '돌지 않을 회차 시각을 지어내지 않는다');
  const r = S.saveSettings({ enabled: false });
  assert.equal(r.code, 'settings-unreadable');
  assert.ok(U.listSettingsLoadErrors().some((x) => x.file === 'storage-inspect.json' && x.confirmable));
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/psInspect.js'), 'utf8'));
  assert.match(src, /r\.code === 'settings-unreadable' \? 409 : 400/);
  // 읽기 오류: 원본을 옮기지 않는다(수정 전: preserveCorrupt)
  fs.rmSync(F('storage-inspect.json.corrupt.2026-11-01T00-00-00'));
  fs.writeFileSync(F('storage-inspect.json'), JSON.stringify({ enabled: false }));
  S._resetScheduleForTest();
  withEio('storage-inspect.json', () => { assert.ok(S.settingsLoadError()?.readError); });
  assert.deepEqual(corruptOf('storage-inspect.json'), []);
  advance();
  S._resetScheduleForTest();
  assert.equal(S.loadSettings().enabled, false, '꺼 둔 값이 그대로');
  _stopInspect(S);
});
function _stopInspect(S) { try { S._resetScheduleForTest(); } catch { /* */ } }

/* ── 스윕 ───────────────────────────────────────────────────────── */
test('스윕: G2 모듈은 공용 로더로 읽는다 — 읽기와 파싱을 한 try 에 묶어 preserveCorrupt 로 보내는 catch 가 다시 생기지 않게', () => {
  const MODS = ['insights/fleetTags.js', 'insights/fleetAssign.js', 'bulletin/store.js', 'mail/settings.js', 'datacenter/store.js',
    'ipam/annotations.js', 'ipam/overrides.js', 'vmdns/policy.js', 'vmclone/nfsDs.js', 'storage/inspect/schedule.js',
    'cost/settings.js', 'vmhygiene/settings.js', 'tags/policy.js'];
  for (const rel of MODS) {
    const s = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    assert.match(s, /from '(?:\.\.\/)+util\/jsonFileLoad\.js'/, `${rel}: 공용 로더를 쓰지 않는다`);
    // 이 모듈들의 설정 파일 읽기는 로더가 한다 — 같은 try 안에서 readFileSync 와 preserveCorrupt 를 함께 부르는 꼴 금지(상태 파일 등 다른 파일은 별도 함수)
    for (const m of s.matchAll(/try\s*\{([\s\S]*?)\}\s*catch\s*(?:\([^)]*\))?\s*\{([^}]*)\}/g)) {
      const both = /readFileSync\(/.test(m[1]) && /preserveCorrupt\(/.test(m[2]);
      const ok = rel === 'storage/inspect/schedule.js' && /STATE_FILE\(\)/.test(m[1]);   // 상태 파일(설정 아님 — 이번 범위 밖)
      assert.ok(!both || ok, `${rel}: 읽기 오류를 preserveCorrupt 로 보내는 catch — ${m[0].slice(0, 160)}`);
    }
    // (PowerScale 점검의 상태 파일 STATE_FILE 은 설정이 아니라 이번 범위 밖 — 그 한 줄만 뺀다)
    assert.doesNotMatch(s.replace(/JSON\.parse\(fs\.readFileSync\(STATE_FILE\(\)/g, ''), /JSON\.parse\(fs\.readFileSync\(/, `${rel}: 읽기와 파싱을 한 식에 묶었다`);
  }
  // 로더 자신: 읽기 단계 실패는 preserveCorrupt 로 가지 않는다
  const u = stripComments(fs.readFileSync(path.join(SRC, 'util/jsonFileLoad.js'), 'utf8'));
  assert.match(u, /try \{ text = fs\.readFileSync\(file, 'utf8'\); \} catch \(e\) \{\s*if \(e\?\.code === 'ENOENT'\) return \{ kind: 'missing' \};\s*return \{ kind: 'read-error', error: e \};/);
});
