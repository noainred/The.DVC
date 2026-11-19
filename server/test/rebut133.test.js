/**
 * 전체 점검 133회차 — ① 128회차(`leftover128` · 커밋 953d4b1f) 수정 반증 ② 128회차가 추정으로 남긴 후보.
 *
 *  R1  128회차 F5(패키지 저장소 설정 폼 잠금)의 빈 곳: 잠금이 **지금 조회**의 표지만 봤다 — 못 읽은 동안의 빈 폼이 떠 있는 채로 ‘다시 확인’ 이 한 번 실패하면
 *      (화면이 조회를 비운다) 표지가 사라져 ‘저장’ 이 열렸고, 그 빈 폼(빈 칸 = 지정 해제)이 다시 읽힌 뒤 웹 지정 주소 · 경로를 지웠다. → 폼을 채운 조회의 표지로 잠근다.
 *  R2  128회차 B(SAN 목록 응답 기억): 표지가 응답 기억(snapMemo)의 키 · ETag 에 들어간다는 것을 **행동으로** 고정한다(128 은 소스 식만 — 장비 0대 등록부는
 *      표지가 키에 없으면 ‘읽힘 ↔ 못 읽음’ 이 같은 키라 옛 응답 · 304 가 나간다).
 *  E1  usage/settings(128 추정 — 재현): 수집 설정 폼은 전 칸을 함께 보낸다 — 못 읽은 동안의 기본값 폼을 다시 읽힌 뒤 저장하면 보관 일수 · 제외 계정 · 고지 문구가 덮였다.
 *  E2  pdu/thresholds(128 추정 — 재현): 임계치 창은 늘 전 키를 보낸다 — 같은 꼴 + 덮인 전 키가 엣지 배포 대상(_assigned)이 됐다. 주기 창(바꾼 칸만)은 덮지 않는다(기각 고정).
 *  E4  같은 등록부를 쓰는 다른 화면(SAN 플로우 · NSX 조회 · 관제 콘솔 스토리지)이 못 읽은 동안 ‘등록된 … 없습니다’ 라고 말했다.
 *  E7  upgrade/packageSettings(128 추정 → 결정 · 예방): 저장소 주소가 바뀌면 저장된 토큰을 승계하지 않는다(지금 이 토큰을 보내는 코드는 없다 — 재현은 되지 않았다).
 *  C   128 이 열지 못한 postJson 호출부: IP 관리 CSV 검증(dryRun) · IP 스캔 대역 CSV 가 409 본문을 결과로 읽었다(사유 없는 0건 · ‘적용 — 에이전트 0곳’).
 * 읽기 오류는 root 컨테이너라 EACCES 대신 EISDIR(파일 자리에 폴더 — 실제 fs 오류)로 재현한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut133-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';
process.env.PACKAGE_BASE_URL = 'https://env-default.example/vp/download';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const WEB = path.join(HERE, '..', '..', 'web', 'src');
const F = (n) => path.join(TMP, n);
const put = (n, v) => fs.writeFileSync(F(n), typeof v === 'string' ? v : JSON.stringify(v));
const readJson = (n) => JSON.parse(fs.readFileSync(F(n), 'utf8'));
const srcOf = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const webOf = (rel) => stripComments(fs.readFileSync(path.join(WEB, rel), 'utf8'));

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
after(() => RD._setJsonFileLoadClockForTest());
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

/** 원본을 옆에 비켜 두고 그 자리에 폴더를 둔다(실제 EISDIR) — restore() 가 원본을 되돌린다. */
function asDir(name) {
  const keep = F(`${name}.keep133`);
  if (fs.existsSync(F(name)) && !fs.statSync(F(name)).isDirectory()) fs.renameSync(F(name), keep);
  fs.mkdirSync(F(name), { recursive: true });
  return () => { fs.rmSync(F(name), { recursive: true, force: true }); if (fs.existsSync(keep)) fs.renameSync(keep, F(name)); };
}
const quiet = async (fn) => { const w = console.warn; const e = console.error; const l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; } };

/** 라우트 등록 함수에 가짜 라우터를 넘겨 마지막 핸들러(게이트 뒤)를 모은다 — 응답 머리(ETag)도 받는다. */
function handlersOf(register) {
  const handlers = {};
  const reg = (m) => (p, ...h) => { handlers[`${m} ${p}`] = h.at(-1); };
  register({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), patch: reg('PATCH'), use: () => {} });
  return async (key, req = {}) => {
    assert.ok(handlers[key], `핸들러 없음: ${key}`);
    let body = null; let code = 200; const hdr = {};
    const res = {
      json: (b) => { body = b; return res; }, status: (c) => { code = c; return res; }, set: () => res, setHeader: (k, v) => { hdr[String(k).toLowerCase()] = v; return res; },
      getHeader: (k) => hdr[String(k).toLowerCase()], type: () => res, locals: {}, on: () => res,
      end: (b) => { if (b != null && body == null) { try { body = JSON.parse(String(b)); } catch { body = b; } } return res; }, send: (b) => res.end(b), headersSent: false,
    };
    const rq = { query: {}, body: {}, params: {}, headers: {}, get: () => undefined, on: () => {}, user: { username: 'admin', role: 'admin' }, ...req };
    await handlers[key](rq, res, (e) => { if (e) throw e; });
    return { code, body, etag: hdr.etag };
  };
}
/** 표지 모양: 읽기 오류 · 사유 요약만 — 설정 폴더 경로 · 파일 이름을 싣지 않는다. */
function isReadMark(le, label, fileName) {
  assert.ok(le && typeof le === 'object', `${label}: 못 읽은 동안의 조회는 표지를 싣는다`);
  assert.equal(le.readError, true, `${label}: 읽기 오류(다시 읽히면 풀림)임을 싣는다`);
  const text = JSON.stringify(le);
  assert.ok(!text.includes(TMP), `${label}: 표지에 설정 폴더 경로를 싣지 않는다`);
  if (fileName) assert.ok(!text.includes(fileName), `${label}: 표지에 파일 이름을 싣지 않는다`);
}

/* ═══ R2 — SAN 목록 응답 기억(snapMemo) · ETag 와 등록부 표지 ═══════════════════════════════════════════════════ */
test('R2 SAN 목록: 장비 0대 등록부가 ‘읽힘 ↔ 못 읽음’ 으로 바뀌면 응답 기억 · ETag 가 함께 바뀐다 — 옛 응답(배너 없음 · 배너 있음)이 남지 않는다', () => quiet(async () => {
  const FILE = 'sanswitch-devices.json';
  const REG = await import('../src/sanswitch/registry.js');
  const call = handlersOf((await import('../src/routes/api/sanSwitch.js')).registerSanSwitch);
  put(FILE, { version: 1, devices: [] });
  REG._resetForTest();
  const a = await call('GET /tools/sanswitch');
  assert.equal(a.body.loadError, undefined);
  assert.equal(a.body.devices.length, 0);
  // 못 읽음(재시작 뒤 — 같은 프로세스의 응답 기억은 그대로 남아 있다 = 최악의 경우). 브라우저는 '표지 없는' 판본의 ETag 를 들고 있다.
  const restore = asDir(FILE);
  REG._resetForTest();
  const b = await call('GET /tools/sanswitch', { headers: { 'if-none-match': a.etag } });
  assert.equal(b.code, 200, '표지가 섰는데 옛 ETag 로 304 를 주지 않는다');
  isReadMark(b.body.loadError, 'SAN 스위치 등록부', FILE);
  assert.notEqual(b.etag, a.etag);
  assert.equal((await call('GET /tools/sanswitch', { headers: { 'if-none-match': b.etag } })).code, 304, '같은 상태는 304(응답 기억은 그대로 돈다)');
  // 다시 읽힘 — 브라우저는 '표지 있는' 판본의 ETag 를 들고 있다
  restore(); pass();
  const c = await call('GET /tools/sanswitch', { headers: { 'if-none-match': b.etag } });
  assert.equal(c.code, 200, '표지가 풀렸는데 옛 ETag 로 304 를 주지 않는다');
  assert.equal(c.body.loadError, undefined, '풀린 뒤에는 표지가 없다(옛 응답 기억이 남지 않는다)');
  // 비관리자(가림 판본)에도 표지는 나가고 주소 · 계정은 가려진 채다
  put(FILE, { version: 1, devices: [{ id: 'sw1', name: 'sw1', host: '10.77.0.11', type: 'brocade', collectMethod: 'ssh', username: 'svc-admin', enabled: true }] });
  REG._resetForTest();
  const v0 = await call('GET /tools/sanswitch', { user: { username: 'op1', role: 'operator' } });
  assert.equal(v0.body.addressHidden, true);
  assert.ok(!JSON.stringify(v0.body).includes('10.77.0.11') && !JSON.stringify(v0.body).includes('svc-admin'));
  const r2 = asDir(FILE); REG._resetForTest(); pass();
  const v1 = await call('GET /tools/sanswitch', { user: { username: 'op1', role: 'operator' } });
  isReadMark(v1.body.loadError, 'SAN 스위치 등록부(가림 판본)', FILE);
  assert.equal(v1.body.addressHidden, true);
  r2(); REG._resetForTest(); pass();
}));

/* ═══ E1 — 기능 사용 기록 수집 설정(usage/settings) ═══════════════════════════════════════════════════════════ */
test('E1 사용 기록 수집 설정: 못 읽은 동안의 조회는 기본값 + 읽기 오류 표지 — 그 폼 본문을 다시 읽힌 뒤 저장하면 서버는 받아들인다(화면이 잠가야 한다)', () => quiet(async () => {
  const FILE = 'usage-settings.json';
  const S = await import('../src/usage/settings.js');
  const saved = { enabled: true, idleMin: 12, keepDays: 730, excluded: ['thedvcdemp', 'svc-bot', 'kim'], noticeEnabled: true, notice: '사내 고지 문구(법무 검토본)', toggles: [{ at: NOW - 86_400_000, on: true, by: 'adm' }], updatedAt: NOW - 1000, updatedBy: 'adm' };
  put(FILE, saved);
  S._resetUsageSettingsCache();
  const call = handlersOf((await import('../src/routes/admin/usage.js')).registerUsageAdmin);
  assert.equal(S.usageSettingsWriteRefusal(), null, '읽히는 동안은 쓰기 거절이 없다');
  const ok = await call('GET /usage/settings');
  assert.equal(ok.body.loadError, null);
  assert.equal(ok.body.settings.keepDays, 730);
  S._resetUsageSettingsCache();
  const restore = asDir(FILE);
  pass();
  const bad = await call('GET /usage/settings');
  isReadMark(bad.body.loadError, '사용 기록 수집 설정', FILE);
  assert.equal(bad.body.settings.keepDays, 180, '못 읽은 동안의 settings 는 저장된 값이 아니라 기본값이다');
  assert.deepEqual(bad.body.settings.excluded, ['thedvcdemp']);
  assert.equal(S.usageSettingsWriteRefusal()?.readError, true, '쓰기 거절과 조회 표지는 같은 상태를 본다');
  // 화면 저장 본문(FeatureUsage save — 전 칸): 사용자가 ‘켜짐’ 하나만 바꿨다
  const f = bad.body.settings;
  const formBody = { enabled: true, idleMin: Number(f.idleMin), keepDays: Number(f.keepDays), excluded: f.excluded, noticeEnabled: f.noticeEnabled, notice: f.notice || null };
  let during = null;
  try { during = await call('PUT /usage/settings', { body: formBody }); } catch (e) { during = { code: e.status }; }
  assert.equal(during.code, 409, '읽기 오류가 이어지는 동안은 서버가 막는다');
  restore(); pass();
  assert.equal(S.usageSettingsWriteRefusal(), null, '다시 읽히면 거절이 풀린다');
  // 재현(수정 전 화면): 그 폼을 다시 읽힌 뒤 저장 — 서버는 받아들이고 보관 일수 · 제외 계정 · 고지 문구가 기본값으로 덮인다(보존본도 없다).
  const wiped = await call('PUT /usage/settings', { body: formBody });
  assert.equal(wiped.code, 200);
  const disk = readJson(FILE);
  assert.equal(disk.keepDays, 180, '서버는 그 저장을 막지 못한다 — 730일 보관이 180일로(그 차만큼의 기록이 지워진다)');
  assert.deepEqual(disk.excluded, ['thedvcdemp']);
  assert.equal(disk.notice, null);
  assert.deepEqual(fs.readdirSync(TMP).filter((x) => x.startsWith(`${FILE}.corrupt.`)), [], '읽기 오류였으므로 보존본도 없다');
  S._resetUsageSettingsCache();
  // 화면: 폼을 채운 조회가 읽기 오류였으면 저장을 잠그고(버튼 + 이중 방어) ‘다시 확인’ 이 폼을 다시 채운다(조회마다 setForm)
  const fu = webOf('views/FeatureUsage.jsx');
  assert.match(fu, /const saveLocked = saveLockedByUnread\(unreadMarkOf\(data\)\);\s*const save = async \(\) => \{\s*if \(saveLocked\) return;/);
  assert.match(fu, /disabled=\{!dirty \|\| saving \|\| saveLocked\} onClick=\{save\}/);
  assert.match(fu, /\{saveLocked && <>[^<]*<button type="button" className="btn" onClick=\{\(\) => setSeq\(\(n\) => n \+ 1\)\}>다시 확인<\/button><\/>\}/);
  assert.match(fu, /then\(\(r\) => \{ if \(!alive\) return; setData\(r\); setForm\(r\.settings\);/, '조회마다 폼을 다시 채운다(잠금과 폼이 같은 조회를 본다)');
}));

/* ═══ E2 — PDU 임계치 · 수집 주기 창 ═════════════════════════════════════════════════════════════════════════ */
test('E2 PDU 임계치: 못 읽은 동안의 조회가 읽기 오류 표지(thresholdsLoadError)를 싣는다 — 그 기본값 창의 저장은 다시 읽힌 뒤 서버가 막지 못한다 · 주기 창은 바꾼 칸만 보내 덮지 않는다', () => quiet(async () => {
  const TH = await import('../src/pdu/thresholds.js');
  const defaults = TH.loadThresholds();
  const keys = Object.keys(defaults).filter((k) => k !== 'enabled');
  const custom = { enabled: false }; for (const k of keys) custom[k] = 7;
  put('pdu-thresholds.json', custom);
  put('pdu-intervals.json', { pollMs: 600_000, pushMs: 900_000 });
  put('pdu-devices.json', { version: 1, devices: [] });
  pass();
  const call = handlersOf((await import('../src/routes/api/pdu.js')).registerPdu);
  const ok = await call('GET /tools/pdu');
  assert.equal(ok.body.thresholdsLoadError, undefined, '읽히는 동안은 표지가 없다');
  assert.equal(ok.body.thresholds[keys[0]], 7);
  assert.equal(TH.pduThresholdsWriteRefusal(), null);
  const r1 = asDir('pdu-thresholds.json'); const r2 = asDir('pdu-intervals.json');
  pass();
  const bad = await call('GET /tools/pdu');
  isReadMark(bad.body.thresholdsLoadError, 'PDU 임계치', 'pdu-thresholds.json');
  assert.equal(bad.body.thresholds[keys[0]], defaults[keys[0]], '못 읽은 동안의 thresholds 는 기본값이다');
  assert.equal(bad.body.thresholds.enabled, true);
  assert.ok(bad.body.loadErrors?.thresholds, '78회차 배너 문구(loadErrors)는 그대로다');
  // 화면 저장 본문: 임계치 창 = 늘 전 키 · 주기 창 = 바꾼 칸만(pushMs 하나)
  const thBody = { enabled: bad.body.thresholds.enabled !== false, ...Object.fromEntries(keys.map((k) => [k, bad.body.thresholds[k] ?? ''])) };
  assert.equal((await call('POST /tools/pdu/thresholds', { body: thBody })).code, 409, '읽기 오류가 이어지는 동안은 서버가 막는다');
  assert.equal((await call('POST /tools/pdu/intervals', { body: { pushMs: 120_000 } })).code, 409);
  r1(); r2(); pass();
  assert.equal((await call('GET /tools/pdu')).body.thresholdsLoadError, undefined, '다시 읽히면 표지가 없다');
  // 재현(수정 전 화면): 못 읽은 동안 연 창의 저장 — 서버는 받아들이고 전 키가 기본값 + 엣지 배포 대상이 된다.
  assert.equal((await call('POST /tools/pdu/thresholds', { body: thBody })).code, 200);
  const dth = readJson('pdu-thresholds.json');
  assert.equal(dth[keys[0]], defaults[keys[0]], '서버는 그 저장을 막지 못한다(그래서 화면이 그 창을 잠근다)');
  assert.equal(dth.enabled, true, '꺼 둔 감시가 켜진다');
  assert.ok(Array.isArray(dth._assigned) && dth._assigned.length > 0, '덮인 키가 엣지 배포 대상(_assigned)이 된다');
  // 기각 고정: 주기 창은 바꾼 칸만 보낸다 — 건드리지 않은 저장 주기(pollMs)는 그대로다
  assert.equal((await call('POST /tools/pdu/intervals', { body: { pushMs: 120_000 } })).code, 200);
  assert.deepEqual(readJson('pdu-intervals.json'), { pollMs: 600_000, pushMs: 120_000 });
  // 손상(보존본으로 옮김)은 저장이 푸는 규약이라 표지(잠금)를 싣지 않는다 — 배너 문구(loadErrors)만
  put('pdu-thresholds.json', '{ broken');
  pass();
  const cor = await call('GET /tools/pdu');
  assert.equal(cor.body.thresholdsLoadError, undefined, '손상은 읽기 오류 표지가 아니다(저장이 새 설정을 만든다)');
  assert.ok(cor.body.loadErrors?.thresholds);
  for (const x of fs.readdirSync(TMP).filter((n) => n.startsWith('pdu-thresholds.json.corrupt.'))) fs.rmSync(F(x), { force: true });
  // 화면: 창을 열 때의 상태를 기억해, 못 읽은 동안 연 창은 다시 읽힌 뒤에도 잠근다(창은 폼을 다시 채우지 않는다)
  const pt = webOf('views/tools/PduTool.jsx');
  assert.match(pt, /const thLe = data\.thresholdsLoadError \|\| null;\s*const \[openedKind\] = useState\(\(\) => unreadKind\(thLe\)\);\s*const lockWhy = staleSeedLock\(openedKind, thLe, \{ what: 'PDU 임계치' \}\);/);
  assert.match(pt, /const save = async \(\) => \{\s*if \(lockWhy\) return;\s*setBusy\(true\); setMsg\(null\);\s*try \{\s*requireChanged\(await postJson\('\/tools\/pdu\/thresholds'/);
  assert.match(pt, /disabled=\{busy \|\| !!lockWhy\} onClick=\{save\}/);
  assert.match(pt, /\{lockWhy && <div className="card error-box" role="alert"[^>]*>\{lockWhy\}<\/div>\}/, '잠근 사유를 말한다');
  assert.match(pt, /const body = changedIntervalBody\(initial, vals\);/, '주기 창은 바꾼 칸만 보낸다(기각의 전제 — 전 칸을 보내게 바꾸면 임계치 창과 같은 잠금이 필요하다)');
}));

/* ═══ E4 — 같은 등록부를 쓰는 다른 화면 ═══════════════════════════════════════════════════════════════════════ */
test('E4 SAN 플로우 · NSX 조회: 등록부를 못 읽은 동안의 빈 목록에 표지를 싣는다 — 화면 셋이 ‘등록된 … 없습니다’ 대신 그 사실을 말한다', () => quiet(async () => {
  const SAN = await import('../src/sanswitch/registry.js');
  put('sanswitch-devices.json', { version: 1, devices: [{ id: 'sw9', name: 'sw9', host: '10.0.9.11', type: 'brocade', collectMethod: 'ssh', username: 'admin', enabled: true }] });
  SAN._resetForTest();
  const flow = handlersOf((await import('../src/routes/api/sanFlow.js')).registerSanFlow);
  const f0 = await flow('GET /tools/san-flow');
  assert.equal(f0.body.loadError, undefined);
  assert.equal(f0.body.devices.length, 1);
  const r1 = asDir('sanswitch-devices.json'); SAN._resetForTest(); pass();
  const f1 = await flow('GET /tools/san-flow');
  assert.equal(f1.body.devices.length, 0, '못 읽은 동안 목록은 비어 나간다(전제 — 그래서 표지가 필요하다)');
  isReadMark(f1.body.loadError, 'SAN 스위치 등록부(SAN 플로우)', 'sanswitch-devices.json');
  r1(); SAN._resetForTest(); pass();
  assert.equal((await flow('GET /tools/san-flow')).body.loadError, undefined, '다시 읽히면 표지가 없다');

  put('nsx.json', { managers: [{ id: 'nsx1', name: 'nsx1', host: 'https://10.0.9.14', username: 'admin', enabled: true }] });
  const nsx = handlersOf((await import('../src/routes/api/overviewNsx.js')).registerOverviewNsx);
  pass();
  const n0 = await nsx('GET /nsx');
  assert.equal(n0.body.loadError, undefined, '등록부가 읽히면 표지가 없다(수집 전이라 목록은 비어 있다)');
  const r2 = asDir('nsx.json'); pass();
  const n1 = await nsx('GET /nsx');
  assert.equal(n1.body.managers.length, 0);
  isReadMark(n1.body.loadError, 'NSX 등록부(NSX 조회)', 'nsx.json');
  r2(); pass();
  assert.equal((await nsx('GET /nsx')).body.loadError, undefined);
  assert.match(srcOf('routes/api/overviewNsx.js'), /\.\.\.\(managers\.length === 0 \? registryMark\(nsxRegistryLoadError\(\)\) : \{\}\)/, '목록이 있을 때는 이 폴링 경로에서 등록부를 다시 읽지 않는다');
  // 화면 셋: 빈 목록 문구는 표지가 먼저(문구는 views/settingsUnread.js registryEmptyText 하나)
  assert.match(webOf('views/tools/SanFlowTool.jsx'), /registryEmptyText\(unreadMarkOf\(d\), 'SAN 스위치 등록부'\) \|\| '등록된 SAN 스위치가 없습니다/);
  assert.match(webOf('views/Nsx.jsx'), /registryEmptyText\(unreadMarkOf\(data\), 'NSX Manager 등록부'\) \|\| '등록된 NSX Manager가 없습니다/);
  const cs = webOf('console/pages/ConsoleStorage.jsx');
  assert.match(cs, /const sanUnreadText = registryEmptyText\(unreadMarkOf\(san\.data\), 'SAN 스위치 등록부'\);/);
  assert.match(cs, /cells\.length === 0 \? \(sanUnreadText \? <Empty><b>\{sanUnreadText\}<\/b>/, '관제 콘솔: 못 읽은 동안 ‘등록된 SAN 스위치가 없습니다’ 라고 말하지 않는다');
  assert.match(cs, /value=\{san\.data && !\(sanUnreadText && !st\.devices\) \? fmtInt\(st\.devices\) : '—'\}/, '못 읽은 대수는 0 이 아니다');
}));

/* ═══ E7 — 패키지 저장소 토큰(결정 · 예방) ═══════════════════════════════════════════════════════════════════ */
test('E7 패키지 저장소 설정: 저장소 주소가 바뀌면 저장된 토큰을 승계하지 않는다 — 같은 주소(끝 / · 대소문자) · 새 토큰 · 다른 칸 저장은 그대로', () => quiet(async () => {
  const P = await import('../src/upgrade/packageSettings.js');
  const FILE = 'packages.json';
  const seed = (o) => { put(FILE, o); P._resetPackageSettingsForTest(); };
  const A = 'https://mirror-a.corp.example/vp/download';
  const B = 'https://mirror-b.corp.example/vp/download';
  // ① 주소만 바꾼 저장 — 토큰을 버린다(파일에도 남지 않는다)
  seed({ baseUrl: A, dir: '/data/pkgs', token: 'tok-for-A' });
  assert.equal(P.getPackageToken(), 'tok-for-A');
  assert.equal(P.packageTokenDropped({ baseUrl: B, dir: '/data/pkgs' }), true);
  let s = P.savePackageSettings({ baseUrl: B, dir: '/data/pkgs' });
  assert.equal(s.baseUrl, B);
  assert.equal(s.hasToken, false, '옛 주소의 토큰을 새 주소로 승계하지 않는다');
  assert.equal(P.getPackageToken(), '');
  assert.ok(!('token' in readJson(FILE)), '키째로 지운다(빈 값으로 덮지 않는다)');
  P._resetPackageSettingsForTest();
  assert.equal(P.getPackageToken(), '', '다시 읽어도 없다');
  // ② 같은 주소(끝 '/' · 대소문자 · 공백만 다름) — 유지 · 저장 경로만 바꾼 저장 — 유지
  seed({ baseUrl: A, token: 'tok-for-A' });
  assert.equal(P.packageTokenDropped({ baseUrl: ` ${A.toUpperCase().replace('HTTPS', 'https')}/ `, dir: '' }), false);
  assert.equal(P.savePackageSettings({ baseUrl: `${A}/`, dir: '/x' }).hasToken, true);
  assert.equal(P.savePackageSettings({ dir: '/y' }).hasToken, true, '주소를 건드리지 않은 저장');
  assert.equal(P.getPackageToken(), 'tok-for-A');
  // ③ 주소와 함께 새 토큰을 줬다 — 새 토큰이 남는다 · ‘********’(유지 신호)는 새 토큰이 아니다
  seed({ baseUrl: A, token: 'tok-for-A' });
  assert.equal(P.packageTokenDropped({ baseUrl: B, token: 'tok-for-B' }), false);
  P.savePackageSettings({ baseUrl: B, token: 'tok-for-B' });
  assert.equal(P.getPackageToken(), 'tok-for-B');
  seed({ baseUrl: A, token: 'tok-for-A' });
  assert.equal(P.packageTokenDropped({ baseUrl: B, token: '********' }), true);
  assert.equal(P.savePackageSettings({ baseUrl: B, token: '********' }).hasToken, false);
  // ④ 웹 지정을 비워 env 기본 주소로 돌아가는 것도 주소 변경이다 · 지정이 env 기본과 같은 주소였으면 변경이 아니다
  seed({ baseUrl: A, token: 'tok-for-A' });
  assert.equal(P.packageTokenDropped({ baseUrl: '' }), true, '유효 주소가 A → env 기본으로 바뀐다');
  seed({ baseUrl: 'https://env-default.example/vp/download/', token: 'tok-env' });
  assert.equal(P.packageTokenDropped({ baseUrl: '' }), false, '유효 주소가 그대로다');
  // ⑤ 버릴 토큰이 없으면 폐기가 아니다(거짓 안내 금지) · 본문이 토큰을 지웠으면(빈 값) 폐기 안내가 아니다
  seed({ baseUrl: A });
  assert.equal(P.packageTokenDropped({ baseUrl: B }), false);
  seed({ baseUrl: A, token: 'tok-for-A' });
  assert.equal(P.packageTokenDropped({ baseUrl: B, token: '' }), false);
  assert.equal(P.savePackageSettings({ baseUrl: B, token: '' }).hasToken, false);
  // ⑥ 라우트: 폐기를 응답에 싣는다(v2.607 droppedSecrets 규약) · 폐기가 없으면 싣지 않는다 · 화면이 그 문구를 보인다
  seed({ baseUrl: A, dir: '/data/pkgs', token: 'tok-for-A' });
  const call = handlersOf((await import('../src/routes/admin/deployLlm.js')).registerDeployLlm);
  const moved = await call('PUT /packages/settings', { body: { baseUrl: B, dir: '/data/pkgs' } });
  assert.equal(moved.code, 200);
  assert.deepEqual(moved.body.droppedSecrets, ['token']);
  assert.match(moved.body.skipped[0].reason, /저장소 주소가 바뀌어 저장된 토큰을 폐기했습니다/);
  assert.equal(moved.body.settings.hasToken, false);
  const same = await call('PUT /packages/settings', { body: { baseUrl: B, dir: '/data/pkgs2' } });
  assert.equal(same.body.droppedSecrets, undefined);
  P._resetPackageSettingsForTest();
  fs.rmSync(F(FILE), { force: true });
  const ad = webOf('views/AgentDeploy.jsx');
  assert.match(ad, /const tokenNote = r\.ok \? droppedSecretNote\(r\) : '';\s*setResult\(\{ kind: 'pkgcfg', ok: !!r\.ok, reason: r\.reason, \.\.\.\(tokenNote \? \{ warn: tokenNote \} : \{\}\) \}\);/);
}));

/* ═══ R1 — 패키지 저장소 설정 폼 잠금(128회차 F5 의 빈 곳) ═══════════════════════════════════════════════════ */
test('R1 패키지 저장소 설정 폼: 잠금은 폼을 채운 조회의 표지를 본다 — 다시 조회가 실패해 조회가 비어도 풀리지 않는다(소스 · 순수 판정은 vitest)', () => {
  const ad = webOf('views/AgentDeploy.jsx');
  assert.match(ad, /\.then\(\(p\) => \{ setPkg\(p\); setPkgCfg\(pkgFormFromResponse\(p\)\); setPkgSeedLe\(unreadMarkOf\(p\)\); \}\)\.catch\(\(\) => setPkg\(null\)\)/, '폼을 채울 때 그 조회의 표지를 함께 둔다 · 실패한 조회는 폼도 표지도 건드리지 않는다');
  assert.match(ad, /const pkgUnread = pkgFormUnread\(pkg, pkgSeedLe\);\s*const pkgSaveLocked = saveLockedByUnread\(pkgUnread\);/);
  assert.ok(!/const pkgUnread = unreadMarkOf\(pkg\);/.test(ad), '지금 조회만 보는 판정으로 되돌리지 않는다');
  assert.match(webOf('views/pkgSettingsText.js'), /return unreadMarkOf\(pkg\) \|\| \(pkg == null && seedLe && typeof seedLe === 'object' \? seedLe : null\);/);
});

/* ═══ C — 128 이 열지 못한 postJson 호출부 ═══════════════════════════════════════════════════════════════════ */
test('C IP 관리 CSV 검증 · IP 스캔 대역 CSV: 서버는 못 읽은 동안 409 본문(report 없음)을 준다 — 화면이 그 본문을 결과로 읽지 않는다', () => quiet(async () => {
  // 관리상태 · 메모 CSV 검증(dryRun): 관리상태 파일을 못 읽는 동안 409
  const restore = asDir('ipam-overrides.json');
  const exp = handlersOf((await import('../src/routes/api/ipamExport.js')).registerIpamExport);
  const dry = await exp('POST /tools/ipam/manage/import', { body: { csv: 'ip,status\n10.1.2.3,reserved\n', dryRun: true } });
  assert.equal(dry.code, 409);
  assert.equal(dry.body.ok, false);
  assert.equal(dry.body.report, undefined, '409 본문에는 검증 결과가 없다 — 결과로 읽으면 사유 없는 0건이 된다');
  assert.ok(String(dry.body.reason || '').length > 10);
  restore();
  // IP 스캔 대역 CSV: 스캔 배정 파일을 못 읽는 동안 409(검증 · 적용 둘 다)
  const r2 = asDir('ipam-scan.json');
  // 거절은 마지막 핸들러 앞의 게이트(scanCfgWritable)가 한다 — 그 라우트의 게이트를 찾아 실제로 부른다.
  let gate = null;
  const pick = (p, ...h) => { if (p === '/ipam/scan/ranges/import') gate = h.find((fn) => typeof fn === 'function' && fn.name === 'scanCfgWritable') || null; };
  (await import('../src/routes/admin/centralIpam.js')).registerCentralIpam({ get: () => {}, post: pick, put: () => {}, delete: () => {}, patch: () => {}, use: () => {} });
  assert.ok(gate, 'IP 스캔 대역 가져오기에 쓰기 거절 게이트가 걸려 있다');
  let code = 200; let body = null; let nexted = false;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; } };
  gate({ body: { csv: 'agent,range\n__local__,10.10.0.0/24\n', dryRun: true } }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(code, 409, '검증(dryRun)도 409 다');
  assert.equal(body.ok, false);
  assert.equal(body.summary, undefined, '409 본문에는 검증 결과가 없다 — 결과로 읽으면 빈 ‘검증 결과’ · ‘적용 — 에이전트 0곳’ 이 된다');
  r2();
  const web = webOf('views/tools/IpamCsv.jsx');
  assert.match(web, /results\.push\(requireChanged\(await postJson\('\/tools\/ipam\/manage\/import', \{ csv: chunks\[i\]\.csv, dryRun: true, lineOffset: chunks\[i\]\.lineOffset \}\)\)\);/, '검증(dryRun)의 409 본문을 결과로 읽지 않는다');
  assert.match(web, /const r = requireChanged\(await postJson\('\/admin\/ipam\/scan\/ranges\/import', \{ csv: text, dryRun, mode \}\)\);/, '스캔 대역 검증 · 적용의 409 본문을 결과(‘적용 — 에이전트 0곳’)로 읽지 않는다');
  assert.equal((web.match(/await postJson\(/g) || []).length, (web.match(/requireChanged\(await postJson\(/g) || []).length, '이 화면의 postJson 은 전부 판정을 거친다');
}));

/* ═══ 분류표 ═══════════════════════════════════════════════════════════════════════════════════════════════ */
test('분류표(settingsUnreadSweep112): 133회차가 찾은 두 모듈이 쓰기 거절을 내보내 표의 그물에 걸린다', () => {
  assert.match(srcOf('usage/settings.js'), /^export function usageSettingsWriteRefusal\(\)/m);
  assert.match(srcOf('pdu/thresholds.js'), /^export function pduThresholdsWriteRefusal\(\)/m);
  const sweep = fs.readFileSync(path.join(HERE, 'settingsUnreadSweep112.test.js'), 'utf8');
  assert.match(sweep, /'usage\/settings\.js': \{ cls: 'form'/);
  assert.match(sweep, /'pdu\/thresholds\.js': \{ cls: 'form'/);
});
