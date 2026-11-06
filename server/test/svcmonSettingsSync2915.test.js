// v2.915 — Monitoring 설정 연동(포탈 설정 카탈로그 → svcmon 대상) · 개요 기술 뷰 · 점검 실패 알림.
// 설계: docs/design/monitoring-autoreg/README.md. 고정하는 것:
//  · 출처(origin)는 서버만 발급한다 — 가져오기·대량 등록·수정 입력의 origin 은 버린다 · 수정은 승계한다 · 저장 왕복 후 키 집합 동일
//  · 판정: 새 항목 · 연동 · 주소/포트 변경 · 사라짐 · 등록부를 못 읽으면 '보류'(사라짐 아님) · 제외 종류 · SSRF 차단은 '설정 문제'
//  · 만드는 점검은 무인증뿐(종류별) · 재동기화는 test.id 를 승계한다 · 사라짐은 기본 '중지'(삭제 아님)
//  · 카탈로그 새 6종(CVP · Veeam · Veeam EM · Bareos · 아이실론 직접 · LLM) · PDU 는 sshPort · vCenter 담당 엣지는 관측값 · 비밀 0
//  · 라우트: 설정 연동은 조회도 canEdit + fullScopeOnly · 알림 설정 저장은 adminOnly
//  · 전이: 상태가 바뀔 때만 기록 · 알림은 연속 N회째 한 번 · 복구 한 번 · 대량이면 요약 1건 · 기본 꺼짐 · 엣지 재전송은 두 번 세지 않는다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmonSync2915-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';

const SYNC = await import('../src/svcmon/settingsSync.js');
const STORE = await import('../src/svcmon/store.js');
const TR = await import('../src/svcmon/transitions.js');
const KINDS = await import('../src/linkcheck/settingsKinds.js');
const LINKS = await import('../src/linkcheck/settingsLinks.js');
const { buildDash, certDaysOf } = await import('../src/svcmon/dash.js');
const SRC = (p) => fs.readFileSync(path.join(HERE, '..', 'src', p), 'utf8');

/** 카탈로그 항목 모양(settingsLinks makeTarget 결과와 같은 키). */
const cat = (kind, ref, o = {}) => ({
  id: `${kind}|${ref}`, kind, ref, label: KINDS.SETTING_KINDS[kind].label, group: KINDS.SETTING_KINDS[kind].group,
  depth: KINDS.SETTING_KINDS[kind].depth, settings: KINDS.SETTING_KINDS[kind].settings, name: o.name || ref,
  agent: o.agent || '', vcenterId: o.vcenterId || '', enabled: o.enabled !== false, address: o.address || o.host || '',
  scheme: o.scheme || 'https', host: o.host || `${ref}.corp.example`, port: o.port || KINDS.SETTING_KINDS[kind].defaultPort || 443,
  hadScheme: true, basePath: o.basePath || '', facts: o.facts || {},
});

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

/* ── 점검 생성(무인증) ── */
test('checksFor — 종류별 무인증 점검: identity HTTP 는 200 고정 · 그 밖 HTTP 는 기대코드 비움 · SSH/SMTP/TLS/TCP', () => {
  const vc = SYNC.checksFor(cat('set:vcenter', 'vc1'));
  assert.deepEqual(vc.map((c) => c.type), ['tcp', 'cert', 'http']);
  const http = vc.find((c) => c.type === 'http');
  assert.equal(http.url, 'https://vc1.corp.example/sdk/vimServiceVersions.xml');
  assert.equal(http.expectStatus, 200);
  assert.equal(http.insecure, true, '자체서명 장비 — 인증서 신뢰는 cert 점검이 아니라 만료만 본다');
  assert.ok(vc.every((c) => c.tpl === SYNC.SYNC_TPL && c.tplKey), '재동기화 키(tpl·tplKey)');
  const nsx = SYNC.checksFor(cat('set:nsx', 'n1')).find((c) => c.type === 'http');
  assert.equal(nsx.expectStatus, undefined, '무인증이라 401/403 이 정상 — 기대 코드를 비워 500 미만을 정상으로');
  const edge = SYNC.checksFor(cat('set:collector', 'e1', { port: 8443 })).find((c) => c.type === 'http');
  assert.equal(edge.url, 'https://e1.corp.example:8443/api/health', '엣지는 토큰 없는 공개 상태 경로');
  assert.equal(edge.keyword, 'status');
  assert.deepEqual(SYNC.checksFor(cat('set:sanswitch-ssh', 's1', { port: 2222 })).map((c) => [c.type, c.port]), [['ssh', 2222]]);
  assert.deepEqual(SYNC.checksFor(cat('set:pdu', 'p1', { port: 22 })).map((c) => c.type), ['ssh'], 'PDU 는 SSH 수집 경로');
  assert.deepEqual(SYNC.checksFor(cat('set:smtp', 'm', { port: 25 })).map((c) => c.type), ['smtp']);
  assert.deepEqual(SYNC.checksFor(cat('set:smtp', 'm', { port: 465 })).map((c) => c.type), ['tcp', 'cert'], '465 는 평문 배너가 없다');
  assert.deepEqual(SYNC.checksFor(cat('set:ad', 'ad', { port: 636 })).map((c) => c.type), ['tcp', 'cert']);
  assert.deepEqual(SYNC.checksFor(cat('set:bareos-dir', 'd', { port: 9101 })).map((c) => [c.type, c.port]), [['tcp', 9101]]);
  assert.deepEqual(SYNC.checksFor(cat('set:veeam', 'v', { port: 9419 })).map((c) => c.type), ['tcp', 'cert']);
  // 점검은 저장소 정규화(cleanTest)를 그대로 통과해야 한다(SSRF·유형별 필수값).
  for (const c of [...vc, edge]) assert.doesNotThrow(() => STORE.normalizeTest(c));
  // 자격증명 필드는 만들지 않는다
  for (const k of KINDS.SETTING_KIND_KEYS) {
    for (const c of SYNC.checksFor(cat(k, 'x'))) assert.ok(!/pass|token|secret|user/i.test(Object.keys(c).join(',')), `${k} 점검에 자격증명 키`);
  }
});

/* ── 판정 ── */
test('classifyCatalog — 새 항목 · 연동 · 주소/포트 변경 · 사라짐 · 보류 · 제외 · 설정 문제', () => {
  const built = {
    targets: [
      cat('set:vcenter', 'vc-new', { vcenterId: 'vc-new' }),
      cat('set:vcenter', 'vc-linked'),
      cat('set:nsx', 'nsx-moved', { host: 'nsx-new.corp.example' }),
      cat('set:storage-api', 'st-port', { port: 8443 }),
      cat('set:webhook', 'webhook:slack', { host: 'hooks.slack.example' }),
      cat('set:idrac', 'loop', { host: '127.0.0.1' }),
    ],
    problems: [{ kind: 'set:pdu', ref: 'bad', name: 'pdu-bad', address: '::::', reason: '주소를 해석하지 못했습니다.' }],
    sourceErrors: [{ source: 'cvp', reason: '손상' }],
  };
  const o = (kind, ref, extra = {}) => ({ key: `${kind}|${ref}`, kind, ref, host: extra.host || `${ref}.corp.example`, port: extra.port || 443, syncedAt: 1 });
  const svc = [
    { id: 'g-1', name: 'vc-linked', host: 'vc-linked.corp.example', path: '설정 연동\\가상화\\전역', tests: [], origin: o('set:vcenter', 'vc-linked') },
    { id: 'g-2', name: 'nsx-moved', host: 'nsx-old.corp.example', path: 'p', tests: [], origin: o('set:nsx', 'nsx-moved', { host: 'nsx-old.corp.example' }) },
    { id: 'g-3', name: 'st-port', host: 'st-port.corp.example', path: 'p', tests: [], origin: o('set:storage-api', 'st-port', { port: 443 }) },
    { id: 'g-4', name: 'gone-one', host: 'gone.corp.example', path: 'p', tests: [], origin: o('set:sanswitch-ssh', 'gone-one') },
    { id: 'g-5', name: 'cvp-held', host: 'cvp.corp.example', path: 'p', tests: [], origin: o('set:cvp', 'cvp-held') },
    { id: 'g-6', name: 'manual', host: 'm.corp.example', path: 'p', tests: [] },
  ];
  const { rows, counts } = SYNC.classifyCatalog(built, svc, { ctx: { vcNames: new Map([['vc-new', 'VC New']]) } });
  const st = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(st['set:vcenter|vc-new'].state, 'new');
  assert.equal(st['set:vcenter|vc-new'].corp, 'VC New');
  assert.equal(st['set:vcenter|vc-new'].path, '설정 연동\\가상화\\VC New');
  assert.equal(st['set:vcenter|vc-linked'].state, 'linked');
  assert.equal(st['set:nsx|nsx-moved'].state, 'changed');
  assert.equal(st['set:nsx|nsx-moved'].prevHost, 'nsx-old.corp.example');
  assert.equal(st['set:storage-api|st-port'].state, 'changed', '포트만 바뀌어도 변경');
  assert.equal(st['set:webhook|webhook:slack'].state, 'excluded', '웹훅 URL 은 비밀');
  assert.equal(st['set:idrac|loop'].state, 'problem', '루프백은 저장소 SSRF 가드가 막는다 — 등록 가능한 척하지 않는다');
  assert.equal(st['set:pdu|bad'].state, 'problem');
  assert.equal(st['set:sanswitch-ssh|gone-one'].state, 'gone');
  assert.equal(st['set:cvp|cvp-held'].state, 'held', '출처 등록부를 못 읽으면 사라졌다고 단정하지 않는다');
  assert.ok(!rows.some((r) => r.targetId === 'g-6'), '출처 없는 수동 대상은 건드리지 않는다');
  assert.equal(counts.new, 1); assert.equal(counts.gone, 1); assert.equal(counts.held, 1);
  const vcKind = counts.byKind.find((k) => k.kind === 'set:vcenter');
  assert.deepEqual([vcKind.total, vcKind.linked], [2, 1], '커버리지 = 연동 / 설정');
});

test('SOURCE_OF_KIND — 카탈로그의 실제 로더 이름과 같다(다르면 보류 판정이 조용히 꺼진다)', () => {
  const src = SRC('linkcheck/settingsLinks.js');
  for (const k of KINDS.SETTING_KIND_KEYS) {
    const name = SYNC.SOURCE_OF_KIND[k];
    assert.ok(name, `${k} 출처 이름 없음`);
    assert.ok(src.includes(`load('${name}'`) || src.includes(`safe('${name}'`), `${k} → '${name}' 가 settingsLinks.js 로더에 없다`);
  }
});

/* ── 출처는 서버만 발급 ── */
test('origin — 대량 등록·가져오기 입력의 origin 은 버린다 · 설정 연동만 싣는다 · 수정은 승계 · 저장 왕복 동일', () => {
  STORE._resetCache();
  const forged = { key: 'set:vcenter|x', kind: 'set:vcenter', ref: 'x', host: 'h', port: 443 };
  const r1 = STORE.bulkAddTargets([{ kind: 'infra', path: 'A', name: 'forged', host: 'f.corp.example', origin: forged }]);
  assert.equal(r1.added, 1);
  assert.equal(STORE.listTargets().find((x) => x.name === 'forged').origin, undefined, '사용자 입력 origin 은 무시');
  const r2 = STORE.bulkAddTargets([{ kind: 'infra', path: 'A', name: 'trusted', host: 't.corp.example', origin: { ...forged, extra: 'drop', corp: 'C' } }], { trustedOrigin: true });
  assert.equal(r2.added, 1);
  const tr = STORE.listTargets().find((x) => x.name === 'trusted');
  assert.deepEqual(Object.keys(tr.origin).sort(), ['corp', 'host', 'key', 'kind', 'port', 'ref'], '화이트리스트');
  // 라우트 수정 경로(data 만) — 승계
  STORE.updateTarget(tr.id, { host: 'manual-edit.corp.example', origin: null });
  assert.equal(STORE.getTarget(tr.id).origin.key, 'set:vcenter|x', 'data.origin 으로 지울 수 없고 승계된다');
  // 설정 연동 경로 — 지운다(연동 해제)
  STORE.updateTarget(tr.id, {}, { origin: null });
  assert.equal(STORE.getTarget(tr.id).origin, undefined);
  // 키 모양이 틀린 출처는 버린다
  assert.equal(STORE.cleanOrigin({ key: 'set:nsx|a', kind: 'set:vcenter' }), undefined);
  assert.equal(STORE.cleanOrigin({ key: 'evil|a', kind: 'evil' }), undefined);
  // 저장 → 재로드 왕복에서 키 집합이 같다
  STORE.updateTarget(tr.id, {}, { origin: forged });
  const before = JSON.stringify(STORE.getTarget(tr.id));
  assert.equal(STORE.flushStore(), true);
  STORE._resetCache();
  assert.equal(JSON.stringify(STORE.getTarget(tr.id)), before);
});

/* ── 적용 ── */
test('planApply/executePlan — 추가(중지 기본·출처·점검) · 주소 반영(test.id 승계) · 사라짐(기본 중지 · 삭제 선택)', () => {
  STORE._resetCache();
  for (const x of [...STORE.listTargets()]) STORE.deleteTarget(x.id);
  SYNC._resetSettingsSyncForTest();
  const vc = cat('set:vcenter', 'vc-a', { host: 'vc-a.corp.example' });
  let built = { targets: [vc], problems: [], sourceErrors: [] };
  let cls = SYNC.classifyCatalog(built, STORE.listTargets());
  let plan = SYNC.planApply(cls.rows, [vc.id, 'set:nope|zz'], { builtByKey: new Map([[vc.id, vc]]) });
  assert.equal(plan.add.length, 1);
  assert.equal(plan.skip.length, 1, '카탈로그에 없는 키는 건너뜀으로 보고');
  let out = SYNC.executePlan(plan, { user: 't', now: Date.parse('2026-11-06T08:00:00Z') });
  assert.equal(out.added, 1);
  assert.match(out.batch, /^settings:\d{8}-\d{6}$/);
  const tg = STORE.listTargets().find((x) => x.origin?.key === vc.id);
  assert.equal(tg.enabled, false, '기본은 중지 등록(잘못된 주소로 실트래픽이 나가지 않게)');
  assert.equal(tg.batch, out.batch);
  assert.equal(tg.path, '설정 연동\\가상화\\전역');
  assert.equal(tg.tests.length, 3);
  assert.ok(SYNC.knownKeys().has(vc.id));
  const ids = tg.tests.map((x) => x.id);

  // 주소·포트 변경 → host 갱신 · 설정 연동 점검의 id 승계 · url/포트 갱신 · 사람이 더한 점검은 그대로
  STORE.addTest(tg.id, { type: 'ping', name: '사람이 더한 PING' });
  const moved = cat('set:vcenter', 'vc-a', { host: 'vc-a2.corp.example', port: 8443 });
  built = { targets: [moved], problems: [], sourceErrors: [] };
  cls = SYNC.classifyCatalog(built, STORE.listTargets());
  assert.equal(cls.rows[0].state, 'changed');
  plan = SYNC.planApply(cls.rows, [moved.id], { builtByKey: new Map([[moved.id, moved]]) });
  out = SYNC.executePlan(plan, { user: 't' });
  assert.equal(out.changed.length, 1);
  const tg2 = STORE.getTarget(tg.id);
  assert.equal(tg2.host, 'vc-a2.corp.example');
  assert.equal(tg2.origin.port, 8443);
  for (const id of ids) assert.ok(tg2.tests.some((x) => x.id === id), 'test.id 승계(연속 횟수·만기가 리셋되지 않게)');
  assert.equal(tg2.tests.find((x) => x.type === 'http').url, 'https://vc-a2.corp.example:8443/sdk/vimServiceVersions.xml');
  assert.ok(tg2.tests.some((x) => x.name === '사람이 더한 PING'), '사람이 더한 점검은 건드리지 않는다');
  assert.equal(SYNC.classifyCatalog(built, STORE.listTargets()).rows[0].state, 'linked');

  // 사라짐 → 기본 중지 + gone 표지(삭제하지 않는다)
  cls = SYNC.classifyCatalog({ targets: [], problems: [], sourceErrors: [] }, STORE.listTargets());
  assert.equal(cls.rows[0].state, 'gone');
  plan = SYNC.planApply(cls.rows, [vc.id], {});
  out = SYNC.executePlan(plan, { user: 't' });
  assert.equal(out.gone[0].action, 'disable');
  assert.ok(STORE.getTarget(tg.id), '지우지 않는다');
  assert.ok(STORE.getTarget(tg.id).origin.gone > 0);
  // 삭제를 고르면 지운다
  plan = SYNC.planApply(SYNC.classifyCatalog({ targets: [], problems: [], sourceErrors: [] }, STORE.listTargets()).rows, [vc.id], { goneAction: 'delete' });
  SYNC.executePlan(plan, { user: 't' });
  assert.equal(STORE.getTarget(tg.id), null);
  assert.ok(SYNC.syncEvents().length >= 3, '적용은 이벤트로 남는다');
});

test('noteDetection — 새로 나타난 키만 이벤트 · 링버퍼 · 일별 요약 · 배너 요약은 수만', () => {
  SYNC._resetSettingsSyncForTest();
  const rowsA = [{ key: 'a', state: 'new', kindLabel: 'vCenter', name: 'a' }];
  SYNC.noteDetection({ rows: rowsA }, { at: Date.parse('2026-11-06T01:00:00Z') });
  assert.equal(SYNC.syncEvents().length, 0, '첫 감지는 기준점');
  const rowsB = [...rowsA, { key: 'b', state: 'new', kindLabel: 'iDRAC', name: 'b' }, { key: 'c', state: 'gone', kindLabel: 'PDU', name: 'c' }];
  SYNC.noteDetection({ rows: rowsB }, { at: Date.parse('2026-11-06T01:05:00Z') });
  const ev = SYNC.syncEvents()[0];
  assert.match(ev.text, /새 항목 1 \(iDRAC b\)/);
  assert.match(ev.text, /사라짐 1/);
  assert.equal(SYNC.driftRing().length, 2);
  assert.deepEqual(Object.keys(SYNC.driftSummary()).sort(), ['at', 'changed', 'gone', 'held', 'new', 'unregistered']);
  assert.equal(SYNC.dailySummary().at(-1).new, 2);
  // 배너의 '새 항목' 은 미등록 전부가 아니라 기준점(첫 감지) 이후 생긴 것 — a 는 첫 감지 때 있었다(Chromium 실측 결함: 미등록 258건을 '변경' 으로 띄웠다)
  assert.equal(SYNC.driftSummary().unregistered, 2);
  assert.equal(SYNC.driftSummary().new, 1, 'b 만 새 항목');
  SYNC.ackDrift(Date.parse('2026-11-06T01:06:00Z'));
  assert.equal(SYNC.driftSummary().new, 0, '확인하면 0 — 미등록 상태는 그대로');
  assert.equal(SYNC.driftSummary().unregistered, 2);
  SYNC.noteDetection({ rows: [...rowsB, { key: 'd', state: 'new', kindLabel: 'CVP', name: 'd' }] }, { at: Date.parse('2026-11-06T01:10:00Z') });
  assert.equal(SYNC.driftSummary().new, 1, '확인 뒤 생긴 것만');
});

/* ── 카탈로그 새 6종 · PDU · vCenter 담당 엣지 ── */
test('buildSettingsTargets — CVP·Veeam·Veeam EM·Bareos·아이실론 직접·LLM 을 싣고 비밀은 싣지 않는다 · PDU sshPort · vCenter 관측 엣지', async () => {
  const SECRET = 'S3cr3t-pw-zz';
  const empty = [];
  const r = await LINKS.buildSettingsTargets({
    vcenters: [{ id: 'vc1', name: 'VC1', host: 'https://vc1.corp.example', collectMode: 'site', enabled: true, password: SECRET }],
    snapshot: { vcenters: [{ id: 'vc1', collectedBy: 'edge-fra' }] },
    nsx: empty, horizon: empty, collectors: empty, agentConfig: {}, deploy: empty, relaytopo: empty, idrac: empty, bmstor: empty,
    gpuPhysical: empty, storage: empty, sanswitch: empty,
    pdu: [{ id: 'p1', name: 'pdu1', host: '10.9.0.5', sshPort: 2022, agent: 'edge-fra', password: SECRET }],
    cvp: [{ id: 'c1', name: 'cvp1', host: 'https://cvp.corp.example', agent: 'edge-fra', token: '(가림)', hasToken: true, password: SECRET }],
    veeam: [{ id: 'v1', name: 'vbr', host: 'vbr.corp.example', port: 9419, vcenterIds: ['vc1'], agent: 'edge-fra', hasPassword: true, password: SECRET }],
    veeamEm: [{ id: 'e1', name: 'em', host: 'em.corp.example', port: 9398, password: SECRET }],
    bareos: { directors: [{ id: 'dir_fra', name: 'dir', host: 'bareos.corp.example', port: 9101, agent: 'edge-fra', password: SECRET }], sites: [{ vcenterId: 'vc1', directorId: 'dir_fra' }] },
    isidu: { targets: [{ id: 'i1', label: 'isi-direct', host: 'isi.corp.example', port: 22, password: SECRET, key: SECRET }, { id: 'i2', deviceId: 'dev-1', host: 'x' }] },
    llm: { enabled: true, url: 'http://ollama.corp.example:11434', model: 'llama', apiKey: SECRET },
    remote: {}, capture: empty, credentials: empty, mail: {}, alerts: {}, ad: {}, upgrade: {}, packages: {},
  });
  assert.deepEqual(r.sourceErrors, []);
  const by = Object.fromEntries(r.targets.map((x) => [x.kind, x]));
  for (const k of ['set:cvp', 'set:veeam', 'set:veeam-em', 'set:bareos-dir', 'set:isidu-host', 'set:llm']) assert.ok(by[k], `${k} 없음`);
  assert.equal(r.targets.filter((x) => x.kind === 'set:isidu-host').length, 1, '장치 연결 대상은 스토리지 항목과 같은 장비라 뺀다');
  assert.equal(by['set:pdu'].port, 2022, 'PDU 는 등록된 sshPort');
  assert.equal(KINDS.SETTING_KINDS['set:pdu'].probe.mode, 'ssh');
  assert.equal(by['set:vcenter'].agent, 'edge-fra', '현지 수집 vCenter 의 담당 엣지는 스냅샷 관측값');
  assert.equal(by['set:veeam'].port, 9419);
  assert.equal(by['set:bareos-dir'].vcenterId, 'vc1');
  assert.ok(!JSON.stringify(r.targets.map(LINKS.publicTarget)).includes(SECRET), '응답에 비밀 원문 0');
});

/* ── 개요 집계 ── */
test('buildDash — 상태 요약 · 출처별 · 엣지 행 조인 · 느린 TOP · 인증서 D-일 · 직접 실행 안 하면 직접 결과를 세지 않는다', () => {
  const now = Date.now();
  const targets = [
    { id: 'g1', name: 'vc-a', host: 'h1', path: '설정 연동\\가상화\\PL', enabled: true, origin: { key: 'set:vcenter|a', kind: 'set:vcenter', corp: 'PL' },
      tests: [{ id: 't1', name: 'TCP', type: 'tcp', intervalSec: 60 }, { id: 't2', name: 'cert', type: 'cert', intervalSec: 60 }] },
    { id: 'g2', name: 'manual', host: 'h2', path: 'Infra', enabled: true, tests: [{ id: 't3', name: 'PING', type: 'ping', intervalSec: 60 }] },
  ];
  const results = new Map([['t1', { status: 'ok', ms: 900, ts: now, streak: 4 }], ['t2', { status: 'warn', reply: 'D-21', ms: 5, ts: now, streak: 1 }], ['t3', { status: 'bad', reply: 'timeout', ts: now, streak: 7 }]]);
  const edgeStates = [{ agent: 'edge-a', silent: false, items: [{ state: 'unknown', path: '설정 연동\\가상화\\PL', target: 'vc-a', test: 'TCP', type: 'tcp' }] }];
  const d = buildDash({ targets, results, edgeStates, now, executes: true });
  assert.equal(d.summary.total, 4);
  assert.deepEqual([d.summary.ok, d.summary.warn, d.summary.bad, d.summary.unknown], [1, 1, 1, 1]);
  const vcO = d.byOrigin.find((x) => x.kind === 'set:vcenter');
  assert.equal(vcO.total, 3, '엣지 행도 경로·이름으로 같은 출처에 묶인다');
  assert.equal(d.groups.find((g) => g.group === 'PL').worst, 'unknown');
  assert.equal(d.slow[0].ms, 900);
  assert.equal(d.certs[0].days, 21);
  assert.equal(d.streaks[0].streak, 7);
  assert.equal(certDaysOf('만료됨 (3일 경과)'), -3);
  assert.equal(certDaysOf('2026-12-01'), null, '못 읽으면 null(0 이 아니다)');
  assert.equal(buildDash({ targets, results, edgeStates: [], now, executes: false }).summary.total, 0, '중앙(실행 안 함)은 직접 결과를 세지 않는다');
});

/* ── 전이 · 알림 ── */
test('transitions — 바뀔 때만 기록 · 연속 N회째 한 번 알림 · 복구 한 번 · 기본 꺼짐 · 범위 · 대량은 요약', async () => {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  assert.equal(TR.getAlertSettings().enabled, false, '기본 꺼짐 — 업그레이드만으로 알림이 쏟아지지 않게');
  const base = { scope: '', testId: 't1', target: { name: 'vc', path: 'Infra' }, test: { name: 'TCP', type: 'tcp' } };
  TR.noteResult({ ...base, status: 'bad', streak: 5 });
  await TR.flushAlerts();
  assert.equal(sent.length, 0, '꺼져 있으면 보내지 않는다');

  TR._setAlertSettingsForTest({ enabled: true, failCount: 3, recover: true });
  TR.noteResult({ ...base, prev: 'ok', status: 'bad', streak: 1 });
  TR.noteResult({ ...base, prev: 'bad', status: 'bad', streak: 2 });
  await TR.flushAlerts();
  assert.equal(sent.length, 0, '연속 3회 전에는 보내지 않는다');
  TR.noteResult({ ...base, prev: 'bad', status: 'bad', streak: 3 });
  TR.noteResult({ ...base, prev: 'bad', status: 'bad', streak: 4 });
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '연속 3회째 한 번');
  assert.equal(sent[0].severity, 'critical');
  assert.match(sent[0].key, /^svcmon\.test\.bad:\|t1$/);
  TR.noteResult({ ...base, prev: 'bad', status: 'ok', streak: 1 });
  TR.noteResult({ ...base, prev: 'ok', status: 'ok', streak: 2 });
  await TR.flushAlerts();
  assert.equal(sent.length, 2, '복구 한 번');
  assert.equal(sent[1].severity, 'info');
  assert.equal(TR.recentTransitions(10).length, 2, '상태가 바뀐 결과만 이력에(ok→bad, bad→ok)');
  assert.equal(TR.hourlySeries().at(-1).n, 7);

  // 범위 'settings' — 설정 연동 경로만
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, scope: 'settings' });
  TR.noteResult({ ...base, testId: 'm1', status: 'bad', streak: 1 });
  TR.noteResult({ ...base, testId: 's1', status: 'bad', streak: 1, target: { name: 'x', path: '설정 연동\\가상화\\PL' } });
  const one = TR.buildAlerts([]); assert.equal(one.length, 0);
  sent.length = 0;
  await TR.flushAlerts();
  assert.deepEqual(sent.map((a) => a.key), ['svcmon.test.bad:|s1']);

  // 대량 — 창 안에 6건 이상이면 요약 1건
  sent.length = 0;
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, scope: 'all' });
  for (let i = 0; i < 12; i++) TR.noteResult({ ...base, testId: `mass${i}`, status: 'bad', streak: 1, scope: 'edge-x' });
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '요약 1건');
  assert.match(sent[0].title, /실패 12건/);
  assert.match(sent[0].key, /:summary:\d+$/);
});

test('엣지 보고 수신 — 같은 측정의 재전송은 시간별 집계·알림에 두 번 세지 않는다', async () => {
  TR._resetTransitionsForTest({ send: async () => {} });
  const { ingestReport } = await import('../src/central/svcmonEdge.js');
  const now = Date.now();
  const body = { snapId: 7, seq: 1, total: 1, rows: [{ i: 'e-t1', s: 'bad', r: 'timeout', m: null, k: 2, a: 1000 }] };
  ingestReport('edge-z', body, now);
  ingestReport('edge-z', body, now + 37);   // 같은 측정의 재전송 — 전송 지연만큼 measuredAt 이 흔들린다(반증 M5 재현 조건)
  assert.equal(TR.hourlySeries(now).at(-1).n, 1);
  ingestReport('edge-z', { ...body, snapId: 8, rows: [{ i: 'e-t1', s: 'ok', r: '1ms', m: 1, k: 1, a: 0 }] }, now + 60_000);
  assert.equal(TR.recentTransitions(5)[0].to, 'ok');
  assert.equal(TR.recentTransitions(5)[0].scope, 'edge-z');
});

/* ── 라우트 게이트 ── */
let server; let base; let who = null;
before(async () => {
  const express = (await import('express')).default;
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use('/api/svcmon', svcmonRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/svcmon`;
});
after(() => { try { server?.close(); } catch { /* */ } });

const ADMIN = { username: 'adm', role: 'admin' };
const OPER = { username: 'op', role: 'operator' };
const VIEWER = { username: 'v', role: 'viewer' };
const SCOPED_OP = { username: 'sop', role: 'operator', scope: { vcenters: ['vc-us-east'] } };
const call = async (method, p, user, body) => {
  who = user;
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, json };
};

test('라우트 — 설정 연동은 조회도 canEdit + 전체 범위 · 개요는 조회 · 알림 설정 저장은 admin', async () => {
  assert.equal((await call('GET', '/settings-sync/catalog', VIEWER)).status, 403, 'viewer 는 설정 주소를 못 본다');
  assert.equal((await call('GET', '/settings-sync/catalog', SCOPED_OP)).status, 403, '범위 계정은 전 법인 설정 주소를 못 본다');
  assert.equal((await call('POST', '/settings-sync/apply', SCOPED_OP, { keys: ['x'] })).status, 403);
  assert.equal((await call('PUT', '/settings-sync/options', SCOPED_OP, { autoKinds: ['set:vcenter'] })).status, 403);
  assert.equal((await call('POST', '/settings-sync/ack', SCOPED_OP, {})).status, 403);
  assert.equal((await call('POST', '/settings-sync/detach/g-x', SCOPED_OP, {})).status, 403);
  assert.equal((await call('POST', '/settings-sync/ack', OPER, {})).status, 403);
  assert.equal((await call('POST', '/settings-sync/ack', ADMIN, {})).status, 200);
  assert.equal((await call('GET', '/settings-sync/catalog', OPER)).status, 403, 'operator 도 못 본다(반증 H1 — 봉인 비밀 웹훅 URL·통합 계정 매핑)');
  const ok = await call('GET', '/settings-sync/catalog', ADMIN);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json.rows));
  assert.ok(ok.json.kinds['set:cvp'], '종류 메타에 새 종류');
  assert.ok(!JSON.stringify(ok.json.edges || []).includes('sourceIp'), '엣지 주소(sourceIp)를 싣지 않는다');
  assert.equal((await call('POST', '/settings-sync/apply', ADMIN, { keys: [] })).status, 400, '고른 것이 없으면 400');
  const opt = await call('PUT', '/settings-sync/options', ADMIN, { autoKinds: ['set:vcenter', 'set:webhook', 'set:nope'] });
  assert.deepEqual(opt.json.options.autoKinds, ['set:vcenter'], '제외 종류·모르는 종류는 자동 등록에 넣지 않는다');
  const ov = await call('GET', '/overview', VIEWER);
  assert.equal(ov.status, 200);
  assert.ok(ov.json.summary && Array.isArray(ov.json.hourly) && ov.json.hourly.length === 24);
  assert.equal((await call('PUT', '/alert-settings', OPER, { enabled: true })).status, 403, '알림 설정 저장은 admin');
  assert.equal((await call('PUT', '/alert-settings', { ...ADMIN, scope: { vcenters: ['x'] } }, { enabled: true })).status, 403, '범위 admin 도 막는다');
  const put = await call('PUT', '/alert-settings', ADMIN, { enabled: true, failCount: 999, scope: 'nope' });
  assert.equal(put.status, 200);
  assert.deepEqual([put.json.settings.enabled, put.json.settings.failCount, put.json.settings.scope], [true, 100, 'all'], '범위 밖 값은 자르고 모르는 값은 기본');
  const st = await call('GET', '/state', VIEWER);
  assert.ok('settingsDrift' in st.json, '/state 에 배너 요약 키');
});

/* ── 반증 반영(v2.915) ── */
test('반증 H1 — 웹훅(봉인 비밀) 주소·통합 계정 매핑은 행에 싣지 않는다 · 주소의 사용자 정보·쿼리를 지운다', () => {
  const SECRET = 'T000/B000/SECRETTOKEN';
  const built = {
    targets: [
      cat('set:webhook', 'webhook:slack', { host: 'hooks.slack.com', address: `https://hooks.slack.com/services/${SECRET}` }),
      cat('set:credential-host', 'cred1:10.0.0.9', { host: '10.0.0.9', name: '운영계정 → 10.0.0.9' }),
      cat('set:nsx', 'n1', { host: 'nsx.corp.example', address: 'https://admin:pw@nsx.corp.example/api?token=zz#x' }),
    ],
    problems: [{ kind: 'set:webhook', ref: 'webhook:teams', name: 'teams', address: `https://x.webhook.office.com/${SECRET}`, reason: 'bad' }],
    sourceErrors: [],
  };
  const { rows } = SYNC.classifyCatalog(built, []);
  const json = JSON.stringify(rows);
  assert.ok(!json.includes(SECRET), '웹훅 경로 토큰 0');
  assert.ok(!json.includes('pw@') && !json.includes('token=zz'), '사용자 정보·쿼리 0');
  assert.equal(rows.find((r) => r.kind === 'set:credential-host').state, 'excluded');
  assert.equal(rows.find((r) => r.kind === 'set:nsx').address, 'https://nsx.corp.example/api');
});

test('반증 M3 — 사라짐(중지)된 대상이 다시 나타나면 변경으로 올라오고 적용하면 표지를 지우고 다시 켠다 · 사람이 꺼 둔 것은 켜지 않는다', () => {
  STORE._resetCache();
  for (const x of [...STORE.listTargets()]) STORE.deleteTarget(x.id);
  SYNC._resetSettingsSyncForTest();
  const x = cat('set:sanswitch-ssh', 'sw1', { host: 'sw1.corp.example', port: 22 });
  const add = SYNC.planApply(SYNC.classifyCatalog({ targets: [x] }, []).rows, [x.id], { enabled: true, builtByKey: new Map([[x.id, x]]) });
  SYNC.executePlan(add, { user: 't' });
  const id = STORE.listTargets()[0].id;
  // 사라짐 → 중지(설정 연동이 켜져 있던 것을 껐다)
  SYNC.executePlan(SYNC.planApply(SYNC.classifyCatalog({ targets: [] }, STORE.listTargets()).rows, [x.id], {}), { user: 't' });
  assert.equal(STORE.getTarget(id).enabled, false);
  assert.equal(STORE.getTarget(id).origin.goneOff, 1);
  // 다시 나타남 → changed(reappeared)
  const back = SYNC.classifyCatalog({ targets: [x] }, STORE.listTargets()).rows[0];
  assert.equal(back.state, 'changed');
  assert.equal(back.reappeared, true);
  SYNC.executePlan(SYNC.planApply([back], [x.id], { builtByKey: new Map([[x.id, x]]) }), { user: 't' });
  assert.equal(STORE.getTarget(id).enabled, true, '설정 연동이 끈 것이면 다시 켠다');
  assert.equal(STORE.getTarget(id).origin.gone, undefined);
  // 사람이 먼저 꺼 둔 대상은 사라짐→재등장 뒤에도 켜지 않는다
  STORE.updateTarget(id, { enabled: false });
  SYNC.executePlan(SYNC.planApply(SYNC.classifyCatalog({ targets: [] }, STORE.listTargets()).rows, [x.id], {}), { user: 't' });
  assert.equal(STORE.getTarget(id).origin.goneOff, undefined);
  const back2 = SYNC.classifyCatalog({ targets: [x] }, STORE.listTargets()).rows[0];
  SYNC.executePlan(SYNC.planApply([back2], [x.id], { builtByKey: new Map([[x.id, x]]) }), { user: 't' });
  assert.equal(STORE.getTarget(id).enabled, false);
});

test('반증 M2 — 손상된 등록부(던지지 않고 빈 목록)는 sourceErrors 로 올라 연동 대상이 사라짐이 아니라 보류가 된다', async () => {
  const fs2 = await import('node:fs');
  const p = path.join(TMP, 'cvp-servers.json');
  fs2.writeFileSync(p, '{not json');
  const reg = await import('../src/cvp/registry.js');
  reg._resetForTest();
  const r = await LINKS.buildSettingsTargets({ snapshot: null });
  assert.ok(r.sourceErrors.some((e) => e.source === 'cvp'), JSON.stringify(r.sourceErrors));
  const cls = SYNC.classifyCatalog(r, [{ id: 'g-c', name: 'cvp1', host: 'cvp.corp.example', path: 'p', tests: [], origin: { key: 'set:cvp|c1', kind: 'set:cvp', ref: 'c1' } }]);
  assert.equal(cls.rows.find((x) => x.key === 'set:cvp|c1').state, 'held');
});

test('반증 M4 — 요약 알림 키는 매번 달라 억제 창에 버려지지 않는다', () => {
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1 });
  const items = Array.from({ length: 8 }, (_, i) => ({ kind: 'bad', key: `|m${i}`, label: `t${i}`, where: '이 포탈', x: { streak: 1, reply: 'x', target: {}, test: {}, at: Date.now() } }));
  const a = TR.buildAlerts(items); const b = TR.buildAlerts(items);
  assert.equal(a.length, 1);
  assert.match(a[0].key, /^svcmon\.test\.bad:summary:\d+$/);
});

