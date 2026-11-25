/**
 * rebut106.test.js — 전체 점검 106회차: 105회차(105a `95247630` · 105b `fe32f724`) 수정의 적대적 재검토.
 *
 *  R1 storage/intervals(105a A5 남긴 것): 기동 때 주기 파일이 읽기 오류면 중앙 자신의 주기에 빈 지정을 적용했고, 다시 읽혀도 재적용이 없어
 *     화면은 저장된 주기 · 표지 없음인데 실제로는 env · 기본 주기로 돌았다 → 읽기 오류 동안 적용 보류 + 재읽기 간격마다 다시 판정
 *  R2 bmusage/tuning/overrides(105a A5 회귀): 읽기 오류 → 그 자리를 치움 → 재읽기 간격 안의 저장 직후, 미뤄 둔 옛 읽기 오류가 방금 저장한 온전한 파일에
 *     다시 서서 판정을 거부했다(최대 30초) → 파일이 없으면 읽기 상태를 비운다
 *  R3 통신 점검 설정(105a A5 · A8 덜 고침): 조회 응답이 '설정을 못 읽어 기본값' 이라는 사실을 싣지 않아 화면이 기본값으로 폼을 채웠고, 다시 읽힌 뒤의 저장
 *     (서버 409 는 읽기 오류가 이어지는 동안만)이 저장된 설정을 기본값으로 덮었다 → 조회에 settingsLoadError · 화면이 저장 잠금 + 폼 다시 채움
 *  R5 storage/intervals(재현 — v2.597 회귀 · R1 을 보다 발견): 빈 이름 키('' = 중앙 자신)의 주기 지정을 공용 조회(agentValueOf)가 '이름 없음' 으로 보아
 *     중앙 자신에게 한 번도 적용하지 않았다(전역 칸만) → '' 키는 글자 그대로 찾는다
 *  R4 포탈 백업 정책(103 F18 · 105a A8 덜 고침): 같은 꼴 — 화면이 읽기 오류 때 받은 임시 기본값 폼을 끝까지 들고 있었다(웹 — 순수 함수는 vitest rebut106)
 *
 * 읽기 오류는 root 컨테이너라 EACCES 대신 EISDIR(파일 자리에 폴더)로 재현한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut106-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';
delete process.env.LINKCHECK_ENABLED;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const WEB = path.join(HERE, '..', '..', 'web', 'src');
const { stripComments } = await import('./_stripComments.js');

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
after(() => RD._setJsonFileLoadClockForTest());
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

function asDir(name) {
  const keep = F(`${name}.keep106`);
  if (fs.existsSync(F(name)) && !fs.statSync(F(name)).isDirectory()) fs.renameSync(F(name), keep);
  fs.mkdirSync(F(name), { recursive: true });
  return () => { fs.rmSync(F(name), { recursive: true, force: true }); if (fs.existsSync(keep)) fs.renameSync(keep, F(name)); };
}

test('R1 스토리지 수집 주기: 기동 때 읽기 오류면 중앙 자신의 주기 적용을 미루고, 다시 읽히면 저장된 지정으로 적용한다(재시작 · 저장 없이)', async (t) => {
  const I = await import('../src/storage/intervals.js');
  const spec = I.INTERVAL_SPEC[0];
  const want = Math.min(spec.max || 24 * 3_600_000, Math.max(spec.min, 3_600_000));
  fs.writeFileSync(F('storage-intervals.json'), JSON.stringify({ version: 1, global: { [spec.key]: want }, agents: {} }));   // 전역 지정 — '' 키(R5)와 따로 본다
  I._resetForTest();
  const restore = asDir('storage-intervals.json');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const a = I.applyOwnIntervals();
    assert.equal(a.applied, false);
    assert.equal(a.held, true, '못 읽은 동안은 빈 지정을 적용하지 않고 미룬다');
    assert.equal(I._ownRetryPendingForTest(), true, '읽기 오류 동안 재적용 타이머가 있어야 한다(없으면 저장 · 재시작 전까지 env · 기본 주기로 돈다)');
    assert.deepEqual(I.centralIntervalsInfo().override, {});
    // 아직 못 읽는다 — 타이머가 돌아도 적용하지 않고 다시 건다
    pass();
    t.mock.timers.tick(RD.READ_RETRY_MS + 1_000);
    assert.deepEqual(I.centralIntervalsInfo().override, {});
    assert.equal(I._ownRetryPendingForTest(), true);
    assert.ok(fs.statSync(F('storage-intervals.json')).isDirectory(), '원본 자리를 건드리지 않는다');
    assert.deepEqual(corruptOf('storage-intervals.json'), []);
    // 다시 읽힌다 — 타이머가 저장된 지정으로 적용한다
    restore();
    pass();
    t.mock.timers.tick(RD.READ_RETRY_MS + 1_000);
    assert.equal(I.storageIntervalsLoadError(), null);
    assert.equal(I.centralIntervalsInfo().override[spec.key], want, '다시 읽히면 저장된 지정이 중앙 자신의 주기에 적용된다');
    assert.equal(I.runtimeIntervals()[spec.key], want);
    assert.equal(I._ownRetryPendingForTest(), false, '읽힌 뒤에는 타이머를 남기지 않는다');
  } finally { t.mock.timers.reset(); I._resetForTest(); }
});

test('R5 스토리지 수집 주기: 중앙 자신(빈 이름 키)에 지정한 주기가 실제로 적용된다 — 전역 위에 덮고, 엣지 이름 조회(대소문자 무시)는 그대로', async () => {
  const I = await import('../src/storage/intervals.js');
  const spec = I.INTERVAL_SPEC[0];
  const hour = Math.min(spec.max || 24 * 3_600_000, Math.max(spec.min, 3_600_000));
  const two = Math.min(spec.max || 24 * 3_600_000, hour * 2);
  fs.rmSync(F('storage-intervals.json'), { recursive: true, force: true });
  I._resetForTest();
  const r = I.saveIntervalConfig({ global: { [spec.key]: hour }, agents: { '': { [spec.key]: two }, 'Edge-A': { [spec.key]: hour } } });
  assert.equal(r.ok, true);
  assert.equal(I.intervalsForAgent('')[spec.key], two, "'' 키(중앙 자신)의 지정이 전역 위에 덮인다 — 예전에는 전역 값만 나왔다");
  assert.equal(I.intervalsForAgent('edge-a')[spec.key], hour, '엣지 이름은 예전처럼 대소문자 무시');
  assert.equal(I.intervalsForAgent('edge-none')[spec.key], hour, '지정 없는 엣지는 전역');
  const own = I.applyOwnIntervals();
  assert.equal(own.applied, true, JSON.stringify(own));
  assert.equal(I.runtimeIntervals()[spec.key], two, '중앙 자신의 실효 주기');
  // '' 키가 없으면 전역만(상속된 이름을 값으로 읽지 않는다)
  I.saveIntervalConfig({ global: { [spec.key]: hour }, agents: {} });
  assert.deepEqual(I.intervalsForAgent(''), { [spec.key]: hour });
  I._resetForTest();
  fs.rmSync(F('storage-intervals.json'), { force: true });
});

test('R2 튜닝 권장값 덮어쓰기: 읽기 오류 → 그 자리를 치움 → 재읽기 간격 안에 저장해도 방금 쓴 파일을 읽기 오류라 하지 않는다', async () => {
  const O = await import('../src/bmusage/tuning/overrides.js');
  const C = await import('../src/bmusage/tuning/catalog.js');
  const item = C.TUNING_ITEMS.find((x) => x.overridable && x.valueKind !== 'num');
  assert.ok(item, '덮어쓸 수 있는 항목');
  O._resetTuningOverridesForTest();
  fs.rmSync(F('bmusage-tuning.json'), { recursive: true, force: true });
  fs.mkdirSync(F('bmusage-tuning.json'));
  assert.equal(O.tuningOverridesLoadError()?.readError, true);
  fs.rmdirSync(F('bmusage-tuning.json'));
  pass(5_000);   // 재읽기 간격(30초) 안
  assert.equal(O.tuningOverridesLoadError(), null, '파일이 없으면 읽기 오류가 아니다(보존본도 없다)');
  const s = O.saveTuningOverride({ scope: 'all', role: 'general', itemId: item.id, value: 'x' }, { by: 'admin' });
  assert.equal(s.ok, true, JSON.stringify(s));
  pass(1_000);
  assert.equal(O.tuningOverridesLoadError(), null, '방금 저장한 온전한 파일에 옛 읽기 오류를 다시 세우면 안 된다');
  const j = O.overridesFor({ role: 'general' });
  assert.equal(j.error, null, '판정을 거부하면 안 된다');
  assert.equal(j.map[item.id]?.value, 'x');
});

test('R3 통신 점검 조회: 설정 파일을 못 읽은 동안 settings 가 기본값이라는 사실(settingsLoadError)을 싣고, 읽히면 싣지 않는다', async () => {
  const L = await import('../src/linkcheck/settings.js');
  const saved = { enabled: true, intervalMs: 3_600_000, pairs: [{ from: 'edge-a', to: 'edge-b' }] };
  fs.writeFileSync(F('linkcheck-settings.json'), JSON.stringify(saved));
  const { registerLinkCheck } = await import('../src/routes/api/linkCheck.js');
  const handlers = {};
  const reg = (m) => (p, ...h) => { handlers[`${m} ${p}`] = h.at(-1); };
  registerLinkCheck({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), patch: reg('PATCH') });
  const call = async (key, req = {}) => {
    let body = null; let code = 200;
    const res = { json: (b) => { body = b; return res; }, status: (c) => { code = c; return res; } };
    await handlers[key]({ query: {}, body: {}, user: { username: 'admin', role: 'admin' }, ...req }, res);
    return { code, body };
  };
  const ok = await call('GET /tools/link-check');
  assert.equal(ok.body.settings.enabled, true);
  assert.equal(ok.body.settingsLoadError, undefined, '읽힌 설정에는 표지가 없다');

  const restore = asDir('linkcheck-settings.json');
  pass();
  const bad = await call('GET /tools/link-check');
  assert.equal(bad.body.settings.enabled, false, '못 읽은 동안 settings 는 기본값(꺼짐)이다');
  assert.equal(bad.body.settingsLoadError?.readError, true, '그 값이 저장된 설정이 아니라는 표지가 있어야 화면이 저장을 잠그고 폼을 다시 채운다');
  assert.match(bad.body.settingsLoadError.reason, /읽지 못했습니다/);
  // 기본값으로 채운 폼의 저장: 읽기 오류가 이어지는 동안은 서버가 409 로 막는다(105회차 A5)
  const formOfDefaults = { ...bad.body.settings };
  const refused = await call('PUT /tools/link-check/settings', { body: formOfDefaults });
  assert.equal(refused.code, 409);
  // 다시 읽힌 뒤에는 서버가 그 저장을 막을 길이 없다(그 폼이 어디서 왔는지 모른다) — 그래서 조회의 표지로 화면이 잠근다. 표지가 사라지는 것은 다시 조회했을 때다.
  restore(); pass();
  const again = await call('GET /tools/link-check');
  assert.equal(again.body.settingsLoadError, undefined);
  assert.equal(again.body.settings.enabled, true, '다시 읽히면 저장된 설정');
  assert.deepEqual(L.loadLinkCheckSettings().pairs, saved.pairs);

  // 손상(보존본으로 옮김)은 읽기 오류가 아니다 — 표지는 싣되 readError 는 false(저장이 해제 길이라 잠그지 않는다)
  fs.writeFileSync(F('linkcheck-settings.json'), '{ broken');
  const corrupt = await call('GET /tools/link-check');
  assert.equal(corrupt.body.settingsLoadError?.readError, false);
  assert.equal(corruptOf('linkcheck-settings.json').length, 1);
  for (const f of corruptOf('linkcheck-settings.json')) fs.rmSync(F(f), { force: true });
  L.loadLinkCheckSettings();
});

test('R3 · R4 웹 배선: 설정을 못 읽은 조회로 채운 폼은 저장을 잠그고 다시 읽히면 서버값으로 바꾼다(통신 점검 · 포탈 백업)', () => {
  const w = (rel) => stripComments(fs.readFileSync(path.join(WEB, rel), 'utf8'));
  const lc = w('views/tools/LinkCheck.jsx');
  assert.match(lc, /onClick=\{saveSettings\} disabled=\{busy \|\| !!data\?\.settingsLoadError\?\.readError\}/, '읽기 오류면 설정 저장을 잠근다');
  assert.match(lc, /if \(reseedAfterUnread\(baseUnread\.current, d\.settingsLoadError\)\) formDirty\.current = false;/, '못 읽은 값 위의 편집은 다시 읽힌 조회에서 버린다');
  assert.match(lc, /baseUnread\.current = lastUnread\.current;/);
  assert.match(lc, /data\?\.settingsLoadError && <div className="banner warn"/, '기본값을 보이는 이유를 말한다');
  const pb = w('views/PortalBackup.jsx');
  assert.match(pb, /setS\(\(cur\) => adoptBackupSettings\(cur, r\.settings\)\)/, '못 읽은 값으로 채운 폼을 끝까지 들고 있지 않는다');
  assert.ok(!/setS\(\(cur\) => cur \|\| r\.settings\)/.test(pb));
  assert.match(pb, /disabled=\{busy === 'save' \|\| !!s\.loadError\} onClick=\{saveSettings\}/, '읽기 오류 동안 정책 저장을 잠근다');
  assert.match(pb, /s\.loadError && <div className="banner warn"/);
  // 서버 쪽 전제: 읽기 오류 동안 상태 응답의 settings 는 loadError 를 싣는다(화면이 이것으로 판정한다)
  const bs = stripComments(fs.readFileSync(path.join(SRC, 'backup/settings.js'), 'utf8'));
  assert.match(bs, /loadError: \{ readError: true, code: _readErr\.code, since: _readErr\.at \}/);
});
