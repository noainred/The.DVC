/**
 * test/portalMiscAudit72.test.js — 전체 점검 72회차(포탈 공통 · 기타 모듈 1차: bmfolders · intro · toolcats · settingsStatus · usermenu ·
 * edgelog · nsx · reports).
 *
 *  F1  라이트사이징 리포트(GET /tools/report/rightsizing)가 범위 계정에 **함대 전체** 누적 메타(stats.tracked = 추적 VM 수 · sinceTs)를
 *      실었다 — 범위 밖 VM 수 유출, 화면 '관측 시작' 도 범위 밖 VM 기준(reports/vmStats.js vmStatsMeta(ids)).
 *  F2  설정 메뉴 상태 배지(settingsStatus/sources.js)가 손상 보존본만 남은 설정을 '꺼짐 · 미설정 · 표시 없음' 으로 보였다 —
 *      중계 서버(remote-access.json → '중계 서버 없음') · 호스트 접근 제어(host-access.json → 표시 없음) · 업그레이드(upgrade.json).
 *      그리고 damaged() 를 로더보다 **먼저** 봐서, 캐시 없는 로더(nsx)는 손상 직후 첫 계산이 '꺼짐(등록 없음)' 이었다.
 *  F3  엣지 로그 진행상태의 글자 값 속 비밀(엣지 *Status() 열 곳 넘게 싣는 centralUrl 의 `user:pw@`)을 가리지 않았다 — v2.599 가
 *      로그 줄에서 가린 같은 비밀의 형제 경로(edgelog/redact.js redactDeep). 개선: 중앙(central/edgeLogStore.js)도 한 번 더 가린다(멱등).
 *  F4  특수 기능 카테고리 저장(PUT /admin/tool-categories)이 `{toString:1}` 같은 값에서 String() 이 던져 400 이 아니라 500 이었다.
 *
 * 기준 시각은 쓰지 않는다(시각 판정 없음). 임시 파일은 os.tmpdir() 아래에만 만든다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit72-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

/* ── F2 설정 상태 배지 — 손상 보존본만 남은 설정은 주의 ───────────────────── */
test('F2 손상된 remote-access · host-access · upgrade · nsx 설정은 꺼짐 · 미설정 · 표시 없음이 아니라 주의(첫 계산부터)', async () => {
  // 아무 모듈도 이 파일들을 아직 읽지 않았다 — 첫 계산이 손상을 만나는 순간을 그대로 재현한다.
  for (const f of ['remote-access.json', 'host-access.json', 'upgrade.json', 'nsx.json']) fs.writeFileSync(path.join(DIR, f), '{"broken": ');
  const { settingsStatusSources } = await import('../src/settingsStatus/sources.js');
  const { buildSettingsStatus } = await import('../src/settingsStatus/grade.js');
  const { items } = buildSettingsStatus(settingsStatusSources(), { superAdmin: true });
  for (const k of ['proxy', 'host-access', 'upgrade', 'nsx-admin']) {
    assert.equal(items[k]?.grade, 'warn', `${k}: ${JSON.stringify(items[k])} — 손상 보존본만 남은 설정을 정상 · 꺼짐 · 미설정으로 보였다`);
    assert.match(items[k].text, /읽지 못함/);
  }
  // 손상본은 보존돼 있다(배지가 가리키는 근거)
  for (const f of ['remote-access.json', 'host-access.json', 'upgrade.json', 'nsx.json']) {
    assert.ok(fs.readdirSync(DIR).some((n) => n.startsWith(`${f}.corrupt.`)), `${f} 보존본`);
  }
});

/* ── F3 엣지 로그 — 진행상태 글자 값 속 비밀 ───────────────────────────────── */
test('F3 redactDeep 은 글자 값 속 URL 비밀번호 · KEY=값 을 가리고, 두 번 지나도 개수가 늘지 않는다', async () => {
  const { redactDeep, MASK } = await import('../src/edgelog/redact.js');
  const src = { centralUrl: 'https://edge:SuperSecret9@central.example:8443', last: { error: 'connect failed (PROXY_SSH_PASS=hunter22)' }, ok: 'https://central.example' };
  const r = redactDeep(src);
  assert.equal(r.value.centralUrl, `https://edge:${MASK}@central.example:8443`, '계정 이름은 진단 정보로 남기고 비밀번호만 가린다');
  assert.doesNotMatch(JSON.stringify(r.value), /SuperSecret9|hunter22/);
  assert.equal(r.masked, 2);
  assert.equal(r.value.ok, 'https://central.example', '비밀이 없는 글자는 그대로');
  const again = redactDeep(r.value);
  assert.equal(again.masked, 0, '이미 가린 값(키 · 글자)을 다시 세지 않는다');
  assert.deepEqual(again.value, r.value);
  assert.equal(redactDeep({ password: MASK }).masked, 0);
  // 아주 긴 글자는 앞부분만 훑고 자른다(정규식 입력 상한) — 길이 상한 표지 + truncated
  const long = redactDeep({ v: 'x'.repeat(40_000) });
  assert.ok(long.truncated && long.value.v.length < 20_000);
});

test('F3 실제 경로 — CENTRAL_URL 에 사용자정보가 있는 엣지의 진행상태(collectStatus)에 비밀번호가 실리지 않는다', async () => {
  const { config } = await import('../src/config.js');
  const { collectStatus } = await import('../src/edgelog/collect.js');
  const prev = { url: config.agent.centralUrl, name: config.agent.name };
  try {
    config.agent.centralUrl = 'https://edge:SuperSecret9@127.0.0.1:9';
    config.agent.name = 'edge-a72';
    const st = await collectStatus();
    const inv = st.items.find((x) => x.key === 'push.inventory');
    assert.ok(inv?.ok, `push.inventory 진행상태: ${JSON.stringify(inv)}`);
    assert.match(String(inv.value?.centralUrl || ''), /^https:\/\/edge:\[가림\]@/, 'inventoryPushStatus 의 centralUrl 이 가려진다');
    assert.doesNotMatch(JSON.stringify(st.items), /SuperSecret9/, '어느 진행상태 값에도 비밀번호가 남지 않는다');
    assert.ok(st.maskedFields >= 1);
  } finally {
    config.agent.centralUrl = prev.url; config.agent.name = prev.name;
  }
});

test('F3(개선) 중앙 보관도 한 번 더 가린다 — 옛 규칙으로 가린 엣지의 줄 · 값 · 오류에 남은 비밀', async () => {
  const S = await import('../src/central/edgeLogStore.js');
  S._resetForTest();
  const rec = S.putEdgeLog('edge-old', {
    ok: true, maskedFields: 2,
    logs: { lastId: 3, items: [
      { id: 1, time: 't', level: 'info', msg: '[inv-push] started → https://u:OldPw77@central:8443 every 60s' },
      { id: 2, time: 't', level: 'warn', msg: `{"centralToken":"[가림]","x":"PASSWORD: 'a b c'"}` },
    ] },
    status: [
      { key: 'push.inventory', ok: true, value: { centralUrl: 'https://u:OldPw77@central:8443', password: '[가림]' } },
      { key: 'push.fleet', ok: false, error: 'fetch https://u:OldPw77@central:8443 failed', value: null },
    ],
  });
  const out = JSON.stringify(rec);
  assert.doesNotMatch(out, /OldPw77/, '줄 · 값 · 오류 어디에도 비밀번호가 남지 않는다');
  assert.doesNotMatch(out, /' b c'/, '홑따옴표 값의 나머지 단어도 남지 않는다');
  assert.equal(rec.maskedFields, 3, '엣지가 가린 2 + 중앙이 더 가린 값 1(이미 가린 password 는 다시 세지 않는다)');
  // 이미 다 가린 봉투는 그대로(멱등) — 개수도 늘지 않는다
  const clean = S.putEdgeLog('edge-new', { ok: true, maskedFields: 1, logs: { items: [{ id: 1, msg: 'password=[가림] ok' }] }, status: [{ key: 'k', ok: true, value: { token: '[가림]', n: 3 } }] });
  assert.equal(clean.maskedFields, 1);
  assert.equal(clean.logs.items[0].msg, 'password=[가림] ok');
  assert.deepEqual(clean.status[0].value, { token: '[가림]', n: 3 });
  S._resetForTest();
});

/* ── F4 특수 기능 카테고리 — 글자가 아닌 값 ─────────────────────────────── */
test('F4 PUT /admin/tool-categories — 글자가 아닌 이름 · id · 도구 키 · 색은 500 이 아니라 400', async () => {
  const C = await import('../src/toolcats/catalog.js');
  const obj = { toString: 1 };
  assert.doesNotThrow(() => C.validate({ categories: [{ id: 'a', label: obj }] }));
  assert.match(C.validate({ categories: [{ id: 'a', label: obj }] })[0], /이름을 입력하세요/);
  assert.match(C.validate({ categories: [{ id: obj, label: 'x' }] })[0], /id 는/);
  assert.match(C.validate({ categories: [{ id: 'a', label: 'x', tools: [obj] }] })[0], /도구 키 형식 오류/);
  assert.match(C.validate({ stages: [{ id: 's', label: 'x', color: obj }] }).join(' '), /팔레트/);
  assert.doesNotThrow(() => C.normOverride({ label: obj, stage: obj }));
  assert.deepEqual(C.normCategory({ id: 'net', label: 'N', tools: ['nsx', obj, '', null] }).tools, ['nsx'], '정상 키만 남는다(예전 동작 그대로)');

  const express = (await import('express')).default;
  const { registerToolCategories } = await import('../src/routes/admin/toolCategories.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  const r = express.Router(); registerToolCategories(r); app.use('/admin', r);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ ok: false, reason: String(err?.message || err) }));
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const put = (body) => fetch(`${base}/admin/tool-categories`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const bad = await put({ categories: [{ id: 'a', label: { toString: 1 }, tools: [] }] });
  assert.equal(bad.status, 400, `글자가 아닌 이름: ${bad.status} ${await bad.text()}`);
  const ok = await put({ enabled: true, categories: [{ id: 'net', label: '네트워크', tools: ['nsx'] }] });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).settings.categories[0].tools, ['nsx']);
});

/* ── F1 라이트사이징 — 범위 계정의 누적 메타 ──────────────────────────────── */
test('F1 vmStatsMeta(ids) 는 그 VM 들만 센다 — 주지 않으면 예전처럼 전부', async () => {
  const V = await import('../src/reports/vmStats.js');
  V._resetVmStats();
  const now = Date.now();
  V.updateVmStats({ vms: [
    { id: 'a', vcenterId: 'vc1', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20 },
    { id: 'b', vcenterId: 'vc2', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20 },
  ] }, now - 60_000);
  V.updateVmStats({ vms: [{ id: 'c', vcenterId: 'vc2', powerState: 'POWERED_ON', cpuUsagePct: 5, memUsagePct: 5 }] }, now);
  assert.deepEqual(V.vmStatsMeta(), { tracked: 3, sinceTs: now - 60_000 });
  assert.deepEqual(V.vmStatsMeta(['c', 'zz']), { tracked: 1, sinceTs: now }, '범위 VM 만 · 없는 id 는 세지 않는다');
  assert.deepEqual(V.vmStatsMeta([]), { tracked: 0, sinceTs: null });
  V._resetVmStats();
});

test('F1 실제 라우터 — 범위 계정의 rightsizing stats 는 범위 안 VM 만(함대 전체 추적 수를 싣지 않는다)', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { api } = await import('../src/routes/api.js');
  const V = await import('../src/reports/vmStats.js');
  await store.refresh({ force: true });
  const snap = store.get();
  const vcIds = [...new Set(snap.vms.map((v) => v.vcenterId))];
  assert.ok(vcIds.length >= 2, '목 스냅샷에 vCenter 가 둘 이상');
  const mine = vcIds[0];
  V._resetVmStats();
  V.updateVmStats(snap, Date.now());
  const fleet = V.vmStatsMeta().tracked;
  const inScope = snap.vms.filter((v) => v.vcenterId === mine && v.powerState === 'POWERED_ON' && !v.template).length;
  assert.ok(fleet > inScope && inScope > 0, `함대 ${fleet} · 범위 ${inScope}`);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const scoped = req.get('x-scoped') === '1';
    req.user = { username: scoped ? 'sc' : 'adm', role: 'admin', scope: scoped ? { vcenters: [mine] } : null };
    next();
  });
  app.use('/api', api);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (scoped) => (await fetch(`${base}/api/tools/report/rightsizing`, { headers: scoped ? { 'x-scoped': '1' } : {} })).json();
  const sc = await get(true);
  assert.equal(sc.stats.tracked, inScope, `범위 계정에 함대 전체 추적 수(${fleet})가 실렸다: ${JSON.stringify(sc.stats)}`);
  const full = await get(false);
  assert.equal(full.stats.tracked, fleet, '전체 범위 계정은 예전 그대로');
  V._resetVmStats();
});

test('72회차 범위 밖(메인): /vcenters/import-file 400 사유가 JSON.parse 원문(파일 조각)을 싣지 않는다 — safeLoadText', async () => {
  const { safeLoadText } = await import('../src/util/atomicWrite.js');
  let err; try { JSON.parse('{"vcenters":[{"host":"vc1","password": "SuperSecret99'); } catch (e) { err = e; }
  assert.ok(err);
  assert.doesNotMatch(safeLoadText(err), /SuperSecret99/);
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/nsxImport.js', import.meta.url), 'utf8'));
  assert.match(src, /파일 읽기 실패: \$\{safeLoadText\(err\)\}/);
  assert.doesNotMatch(src, /파일 읽기 실패: \$\{err\.message\}/);
});
