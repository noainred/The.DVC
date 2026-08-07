/**
 * 성능점검 점검 템플릿(svcmon/templates.js) — 저장·치환 3단 방어·적용 멱등성 검증.
 * 임시 CONFIG_DIR 만 쓰며 외부 네트워크에 의존하지 않는다.
 *
 * 주의: `config.configDir` 은 모듈 로드 시점에 고정되므로 CONFIG_DIR 은 **import 전에** 세운다.
 *
 * 검증 범위 메모(뒤에서 추가된 회귀 방지 케이스 — 전부 실측으로 재현된 결함이다):
 *   - 범위(scope) 해석 실패가 전체 대상으로 넓어지지 않는지, overwrite/dryRun/includeSub 이
 *     문자열 `'false'` 에 반전되지 않는지.
 *   - 치환 결과의 길이 초과·제어문자(CRLF)가 절단·주입이 아니라 행 오류가 되는지.
 *   - 식별자(id/key)가 **재기동을 끼운 재적용**에서도 안정적인지 — 이 모듈의 핵심 위험이라
 *     `_resetTemplateCache()` 로 재기동을 시뮬레이션해 반복 적용한다.
 *   - '파싱은 되지만 templates 배열이 아닌' 파일이 백업 없이 덮어써지지 않는지.
 *   - 저장 실패(파일 자리에 디렉터리를 두어 rename EISDIR 유발)를 CRUD 가 감추지 않는지.
 *
 * 테스트 순서 주의: 마지막 T21 이 템플릿 수를 상한(100)까지 채우므로 **새 케이스는 그 앞에** 둔다.
 * 손상/저장실패 케이스는 파일을 조작한 뒤 원상복구하거나 빌트인 재시드 상태로 남긴다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-tpl-'));
process.env.CONFIG_DIR = DIR;
process.env.SVCMON_WORKERS = '0';

const store = await import('../src/svcmon/store.js');
const tpl = await import('../src/svcmon/templates.js');

const STORE_FILE = path.join(DIR, 'svcmon.json');
const TPL_FILE = path.join(DIR, 'svcmon-templates.json');

let seq = 0;
const mkTarget = (name, host = `192.168.60.${(seq += 1) % 250}`) =>
  store.addTarget({ kind: 'infra', path: 'TPL', name, host });

/** 저장소 파일을 직접 편집해 넣는다(정상 API 로는 만들 수 없는 상태를 재현할 때만). */
function injectRawTarget(target) {
  store.flushStore();
  const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  raw.targets.push(target);
  fs.writeFileSync(STORE_FILE, JSON.stringify(raw));
  store._resetCache();
}

/** 템플릿 파일에 손편집 템플릿을 심는다(hydrate 경로 검증 — API 로는 만들 수 없는 상태). */
function injectRawTemplate(t) {
  const raw = JSON.parse(fs.readFileSync(TPL_FILE, 'utf8'));
  raw.templates.push(t);
  fs.writeFileSync(TPL_FILE, JSON.stringify(raw));
  tpl._resetTemplateCache();
}
/** 손편집 항목 1개 — 정제를 통과한 저장 형태를 그대로 흉내낸다(로드는 값 검증을 하지 않는다). */
const rawItem = (o) => ({ intervalSec: 300, enabled: true, insecure: false, warnDays: 30, ...o });
const corruptBaks = () => fs.readdirSync(DIR).filter((f) => f.startsWith('svcmon-templates.json.corrupt.'));

/* ── 기본 ── */

test('빌트인 6종이 파일 없을 때 시드되고 표준 포트만 쓴다', () => {
  const list = tpl.listTemplates();
  for (const id of tpl.BUILTIN_IDS) assert.ok(list.some((t) => t.id === id), `${id} 누락`);
  assert.equal(tpl.BUILTIN_IDS.length, 6);
  for (const t of list) {
    assert.ok(t.items.length >= 1 && t.items.length <= tpl.MAX_ITEMS);
    assert.equal(t.items.filter((x) => x.type === 'ping').length <= tpl.MAX_PING_ITEMS, true);
    for (const it of t.items) {
      assert.ok(it.intervalSec >= 120, `${t.id}/${it.name} 주기 ${it.intervalSec}`);
      assert.equal(it.insecure, false);
      assert.match(it.key, /^k-[0-9a-f]{8}$/);
      assert.equal(Object.hasOwn(it, 'order'), false);   // order 필드를 만들지 않는다
    }
  }
  const web = tpl.getTemplate('tpl-web-tls');
  assert.equal(web.kind, 'service');
  assert.equal(web.items.find((x) => x.type === 'cert').port, 443);
  assert.equal(web.items.find((x) => x.type === 'http').url, 'https://{host}/');
  const mail = tpl.getTemplate('tpl-mail');
  assert.equal(mail.items.find((x) => x.type === 'smtp').send, 'EHLO test');
  assert.deepEqual(mail.items.map((x) => x.port), [25, 587, 143, 110, 993]);
});

test('빌트인 항목 키는 결정적이다(재시드에서 tplKey 가 어긋나지 않게)', () => {
  const before = tpl.getTemplate('tpl-dns-server').items.map((x) => x.key);
  fs.rmSync(TPL_FILE);
  tpl._resetTemplateCache();
  const after = tpl.getTemplate('tpl-dns-server').items.map((x) => x.key);
  assert.deepEqual(after, before);
});

/* ── T10 ── */

test('T10 tpl/tplKey 가 저장 후 보존된다(빠지면 재적용이 매번 중복 생성)', async () => {
  const t = tpl.addTemplate({
    name: '단순 TCP',
    kind: 'infra',
    items: [{ name: '포트 80', type: 'tcp', port: 80, intervalSec: 300 }],
  }, { user: 'tester' });
  assert.match(t.id, /^tpl-[0-9a-f]{8}$/);
  assert.equal(t.rev, 1);
  assert.equal(t.builtin, false);
  assert.equal(t.updatedBy, 'tester');

  const g = mkTarget('t10-web');
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, user: 'tester' });
  assert.equal(r.create, 1);
  assert.equal(r.update, 0);
  assert.equal(r.skip, 0);
  assert.equal(r.errorCount, 0);
  assert.equal(r.committed, true);
  assert.equal(r.saved, true);
  assert.equal(r.targets, 1);
  assert.equal(r.tests, 1);

  const saved = store.getTarget(g.id).tests[0];
  assert.equal(saved.tpl, t.id);
  assert.equal(saved.tplKey, t.items[0].key);
  assert.equal(saved.port, 80);
  // 파일에도 남아야 한다(메모리에만 있으면 재시작 후 재적용이 중복 생성한다).
  const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  const rawTest = raw.targets.find((x) => x.id === g.id).tests[0];
  assert.equal(rawTest.tpl, t.id);
  assert.equal(rawTest.tplKey, t.items[0].key);
});

/* ── T11 ── */

test('T11 같은 템플릿 2회 적용 → 점검 수 불변 + test.id 불변', async () => {
  const t = tpl.addTemplate({
    name: '멱등 확인',
    items: [
      { name: 'PING', type: 'ping', intervalSec: 120 },
      { name: '포트 443', type: 'tcp', port: 443, intervalSec: 300 },
    ],
  });
  const g = mkTarget('t11-host');
  const first = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  assert.equal(first.create, 2);
  const ids1 = store.getTarget(g.id).tests.map((x) => x.id);

  const second = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  assert.equal(second.create, 0);
  assert.equal(second.update, 0);
  assert.equal(second.skip, 2);
  const ids2 = store.getTarget(g.id).tests.map((x) => x.id);
  assert.deepEqual(ids2, ids1);       // poller 의 results/nextDue/streak 키가 test.id 다

  // overwrite=true 도 id 를 승계한다
  const third = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true });
  assert.equal(third.create, 0);
  assert.deepEqual(store.getTarget(g.id).tests.map((x) => x.id), ids1);
});

/* ── T12 ── */

test('T12 overwrite=false 에서 사용자가 고친 임계값이 보존된다', async () => {
  const t = tpl.addTemplate({
    name: '임계 보존',
    items: [{ name: '포트 8080', type: 'tcp', port: 8080, intervalSec: 300 }],
  });
  const g = mkTarget('t12-host');
  await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  const test0 = store.getTarget(g.id).tests[0];
  store.updateTest(g.id, test0.id, { ...test0, intervalSec: 900 });
  assert.equal(store.getTarget(g.id).tests[0].intervalSec, 900);

  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  assert.equal(r.skip, 1);
  assert.equal(r.update, 0);
  assert.equal(store.getTarget(g.id).tests[0].intervalSec, 900);

  // overwrite=true 면 템플릿 값으로 되돌린다(같은 test.id 유지)
  const o = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true });
  assert.equal(o.update, 1);
  assert.equal(store.getTarget(g.id).tests[0].intervalSec, 300);
  assert.equal(store.getTarget(g.id).tests[0].id, test0.id);
});

/* ── T13 ── */

test('T13 overwrite=true 의 diff 는 정제 통과 결과 기준(변경 없으면 skip)', async () => {
  // {type:'cert'} 처럼 정제가 기본값을 채우는 유형으로 확인한다 — 템플릿 원본과 저장값을
  // 그대로 비교하면 port 443·warnDays 30 차이로 'same' 이 구조적으로 0 이 된다.
  const t = tpl.addTemplate({
    name: 'diff 확인',
    items: [
      { name: '인증서', type: 'cert', intervalSec: 86400 },
      { name: 'HTTP', type: 'http', url: 'https://{host}/status', intervalSec: 300, expectStatus: 200 },
    ],
  });
  const g = mkTarget('t13-host');
  const first = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true });
  assert.equal(first.create, 2);
  const cert = store.getTarget(g.id).tests.find((x) => x.type === 'cert');
  assert.equal(cert.port, 443);          // 정제가 채운 기본 포트
  assert.equal(cert.warnDays, 30);

  const again = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true });
  assert.equal(again.update, 0, 'JSON 비교 기준이 틀리면 전량 update 가 된다');
  assert.equal(again.skip, 2);

  // 템플릿을 실제로 바꾸면 그때만 update 로 잡힌다
  const items = t.items.map((x) => (x.type === 'cert' ? { ...x, warnDays: 45 } : x));
  const u = tpl.updateTemplate(t.id, { items }, { user: 'admin' });
  assert.equal(u.rev, 2);
  const changed = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true });
  assert.equal(changed.update, 1);
  assert.equal(changed.skip, 1);
  assert.equal(store.getTarget(g.id).tests.find((x) => x.type === 'cert').warnDays, 45);
});

test('items 를 바꾸지 않은 수정은 rev 를 올리지 않는다(설명만 변경)', () => {
  const t = tpl.addTemplate({ name: 'rev 확인', items: [{ name: 'x', type: 'tcp', port: 22 }] });
  const u = tpl.updateTemplate(t.id, { name: 'rev 확인2', desc: '설명' }, { user: 'a' });
  assert.equal(u.rev, t.rev);
  assert.deepEqual(u.items.map((x) => x.key), t.items.map((x) => x.key));
});

/* ── T14 ── */

test('T14 미치환 변수 잔여 → 그 행 오류, 생성 0건', async () => {
  // 방어 1 — 저장 단계에서 허용 목록 밖 토큰 거부
  assert.throws(() => tpl.addTemplate({
    name: '나쁜 토큰',
    items: [{ name: 'health', type: 'http', url: 'http://{app}:8080/health', intervalSec: 300 }],
  }), /알 수 없는 치환 변수 \{app\}/);
  assert.throws(() => tpl.addTemplate({
    name: '대소문자',
    items: [{ name: 'h', type: 'http', url: 'https://{HOST}/', intervalSec: 300 }],
  }), /알 수 없는 치환 변수 \{HOST\}/);
  assert.throws(() => tpl.addTemplate({
    name: '짝 안 맞음',
    items: [{ name: 'h', type: 'http', url: 'https://{host/', intervalSec: 300 }],
  }), /중괄호/);

  // 방어 2 — 손으로 편집된 파일(방어 1 을 통과하지 않은 값)은 적용에서 잡는다.
  // ssrfBlockReason('http://{app}:8080/health') 는 null(통과) 이라 여기서 막지 않으면 저장된다.
  const raw = JSON.parse(fs.readFileSync(TPL_FILE, 'utf8'));
  raw.templates.push({
    id: 'tpl-handedit',
    name: '손편집',
    desc: '',
    kind: '',
    builtin: false,
    rev: 1,
    updatedAt: 0,
    updatedBy: '',
    items: [{ key: 'k-aaaaaaaa', name: 'health', type: 'http', url: 'http://{app}:8080/health', intervalSec: 300, enabled: true, insecure: false, warnDays: 30 }],
  });
  fs.writeFileSync(TPL_FILE, JSON.stringify(raw));
  tpl._resetTemplateCache();

  const g = mkTarget('t14-host');
  const r = await tpl.applyTemplate('tpl-handedit', { scope: { targetIds: [g.id] } });
  assert.equal(r.create, 0);
  assert.equal(r.errorCount, 1);
  assert.match(r.errors[0].reason, /치환되지 않은 변수/);
  assert.equal(r.errors[0].targetName, 't14-host');
  assert.equal(r.committed, false);
  assert.equal(store.getTarget(g.id).tests.length, 0);
});

/* ── T15 ── */

test('T15 템플릿 http://{host}/ + 루프백 대상 → 적용 시 차단', async () => {
  const t = tpl.addTemplate({
    name: '웹 점검',
    items: [{ name: 'HTTP', type: 'http', url: 'http://{host}/', intervalSec: 300 }],
  });
  // 루프백 호스트는 addTarget 이 거부하므로(정상 동작) 파일에 직접 심어 재현한다.
  injectRawTarget({
    id: 'g-loopback', kind: 'infra', path: 'TPL', name: 'loopback-host', host: '127.0.0.1',
    enabled: true, order: 1, tests: [],
  });
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: ['g-loopback'] } });
  assert.equal(r.create, 0);
  assert.equal(r.errorCount, 1);
  assert.match(r.errors[0].reason, /차단/);
  assert.equal(store.getTarget('g-loopback').tests.length, 0);

  // server/record 도 목적지다 — 링크로컬 메타데이터 주소가 치환돼도 막혀야 한다.
  const t2 = tpl.addTemplate({
    name: 'DNS 점검',
    items: [{ name: 'DNS', type: 'dns', record: '{host}', server: '{host}', intervalSec: 300 }],
  });
  injectRawTarget({
    id: 'g-metadata', kind: 'infra', path: 'TPL', name: 'meta-host', host: '169.254.169.254',
    enabled: true, order: 2, tests: [],
  });
  const r2 = await tpl.applyTemplate(t2.id, { scope: { targetIds: ['g-metadata'] } });
  assert.equal(r2.create, 0);
  assert.equal(r2.errorCount, 1);
  assert.match(r2.errors[0].reason, /차단/);
});

/* ── T16 ── */

test('T16 미지 유형 템플릿 저장 → 오류(400 유발)', () => {
  assert.throws(() => tpl.addTemplate({ name: '디스크', items: [{ name: '디스크', type: 'disk' }] }),
    /알 수 없는 점검 유형: disk/);
  // 필수값 누락·이름 누락도 저장 단계에서 거절한다
  assert.throws(() => tpl.addTemplate({ name: 'URL 없음', items: [{ name: 'h', type: 'http' }] }), /URL/);
  assert.throws(() => tpl.addTemplate({ name: '이름 없음', items: [{ type: 'tcp', port: 80 }] }), /점검 이름/);
  assert.throws(() => tpl.addTemplate({ name: '', items: [] }), /템플릿 이름/);
  assert.throws(() => tpl.addTemplate({ name: '구분 오류', kind: 'network', items: [] }), /알 수 없는 구분/);
  assert.throws(() => tpl.addTemplate({
    name: 'ping 2개',
    items: [{ name: 'p1', type: 'ping' }, { name: 'p2', type: 'ping' }],
  }), /ping 은 템플릿당 최대 1개/);
});

/* ── T17 ── */

test('T17 템플릿 파일 손상 → .corrupt.<ts> 보존 + 빌트인 시드 복구', async () => {
  fs.writeFileSync(TPL_FILE, '{"templates":[{"id":"tpl-x"');   // 잘린 JSON
  tpl._resetTemplateCache();
  const list = tpl.listTemplates();
  for (const id of tpl.BUILTIN_IDS) assert.ok(list.some((t) => t.id === id), `${id} 복구 실패`);
  assert.equal(list.length, tpl.BUILTIN_IDS.length);
  const bak = fs.readdirSync(DIR).filter((f) => f.startsWith('svcmon-templates.json.corrupt.'));
  assert.equal(bak.length >= 1, true, '손상본이 보존되지 않았다');
  // 보존본은 원문 그대로여야 수동 복구가 가능하다
  assert.equal(fs.readFileSync(path.join(DIR, bak[0]), 'utf8'), '{"templates":[{"id":"tpl-x"');
});

/* ── P5(후속 검증) 파싱은 되지만 모양이 다른 파일도 손상으로 다룬다 ──
 * T17 은 '잘린 JSON' 만 덮었다. 이 분기는 곧바로 시드 + persist 를 하므로, 보존이 없으면
 * **목록 화면을 한 번 여는 것만으로** 사용자 템플릿이 백업 없이 사라진다.
 */

test('templates 배열이 아닌 파일도 .corrupt 로 보존한 뒤 빌트인을 시드한다', () => {
  const bodies = [
    JSON.stringify({ version: 1, template: [{ id: 'tpl-mine', name: '사내표준', items: [] }] }), // 키 오타
    JSON.stringify([{ id: 'tpl-mine', name: '사내표준', items: [] }]),                            // 루트가 배열
    JSON.stringify({ templates: null }),
    JSON.stringify({ templates: { a: 1 } }),                                                     // 객체
    'null',                                                                                      // 본문 null
  ];
  for (const body of bodies) {
    for (const f of corruptBaks()) fs.rmSync(path.join(DIR, f));   // 같은 ms 백업 충돌 회피
    fs.writeFileSync(TPL_FILE, body);
    tpl._resetTemplateCache();
    const list = tpl.listTemplates();
    assert.equal(list.length, tpl.BUILTIN_IDS.length, `시드 실패: ${body.slice(0, 30)}`);
    const baks = corruptBaks();
    assert.equal(baks.length, 1, `손상본이 보존되지 않았다: ${body.slice(0, 30)}`);
    // 원문 그대로여야 수동 복구가 가능하다(정규화·재작성 금지)
    assert.equal(fs.readFileSync(path.join(DIR, baks[0]), 'utf8'), body);
  }
  for (const f of corruptBaks()) fs.rmSync(path.join(DIR, f));
});

/* ── T18 ── */

test('T18 템플릿 삭제 후 적용된 점검이 남는다 + 태그 유지', async () => {
  const t = tpl.addTemplate({ name: '삭제 예정', items: [{ name: '포트 9443', type: 'tcp', port: 9443, intervalSec: 300 }] });
  const g = mkTarget('t18-host');
  assert.equal((await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } })).create, 1);
  const key = t.items[0].key;
  assert.deepEqual(tpl.templateUsage(t.id), { targets: 1, tests: 1 });

  const d = tpl.deleteTemplate(t.id);
  assert.deepEqual(d, { removed: true, orphanTests: 1, orphanTargets: 1 });
  assert.equal(tpl.getTemplate(t.id), null);

  const left = store.getTarget(g.id).tests;
  assert.equal(left.length, 1);
  assert.equal(left[0].tpl, t.id);       // 태그를 지우면 같은 이름 템플릿 재생성 시 중복이 된다
  assert.equal(left[0].tplKey, key);
  assert.deepEqual(tpl.deleteTemplate(t.id), { removed: false, orphanTests: 1, orphanTargets: 1 });
});

/* ── T19 ── */

test('T19 dryRun 이 storeRevision() 을 바꾸지 않는다', async () => {
  const t = tpl.addTemplate({ name: '드라이런', items: [{ name: '포트 9090', type: 'tcp', port: 9090, intervalSec: 300 }] });
  const g = mkTarget('t19-host');
  const rev0 = store.storeRevision();
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, dryRun: true });
  assert.equal(r.create, 1);
  assert.equal(r.committed, false);
  assert.equal(r.dryRun, true);
  assert.equal(store.storeRevision(), rev0);
  assert.equal(store.getTarget(g.id).tests.length, 0);

  // 실제 적용 후 dryRun 은 skip 으로 잡히고 여전히 저장소를 건드리지 않는다
  await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  const rev1 = store.storeRevision();
  const r2 = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, dryRun: true, overwrite: true });
  assert.equal(r2.skip, 1);
  assert.equal(r2.update, 0);
  assert.equal(store.storeRevision(), rev1);
});

/* ── T20 ── */

test('T20 빌트인 재시드가 사용자 수정을 덮어쓰지 않는다', () => {
  const before = tpl.getTemplate('tpl-linux-basic');
  const items = before.items.map((x) => (x.type === 'ping' ? { ...x, intervalSec: 600 } : x));
  const u = tpl.updateTemplate('tpl-linux-basic', { name: 'Linux 사내표준', items }, { user: 'admin' });
  assert.equal(u.rev, before.rev + 1);
  assert.equal(u.builtin, true);         // 빌트인 플래그는 유지

  tpl._resetTemplateCache();             // 재기동 시뮬레이션
  const after = tpl.getTemplate('tpl-linux-basic');
  assert.equal(after.name, 'Linux 사내표준');
  assert.equal(after.items.find((x) => x.type === 'ping').intervalSec, 600);
  assert.equal(after.items.length, before.items.length);
  assert.deepEqual(after.items.map((x) => x.key), before.items.map((x) => x.key));
  assert.equal(after.updatedBy, 'admin');
});

/* ── 치환/복제/범위 ── */

test('치환은 {host} {name} {path} {kind} 4개만이고 {path} 는 / 로 바뀐다', async () => {
  const t = tpl.addTemplate({
    name: '치환 확인',
    items: [{
      name: '{name} 상태({kind})',
      type: 'http',
      url: 'https://{host}/app?p={path}',
      keyword: '{name}',
      intervalSec: 300,
    }],
  });
  const g = store.addTarget({ kind: 'service', path: 'A\\B\\C', name: 'svc01', host: '192.168.70.9' });
  assert.equal((await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } })).create, 1);
  const x = store.getTarget(g.id).tests[0];
  assert.equal(x.name, 'svc01 상태(service)');
  assert.equal(x.url, 'https://192.168.70.9/app?p=A/B/C');
  assert.equal(x.keyword, 'svc01');
});

test('duplicateTemplate 은 새 id + 전 항목 새 key(원본 적용분을 덮어쓰지 않게)', async () => {
  const src = tpl.getTemplate('tpl-web-tls');
  const dup = tpl.duplicateTemplate(src.id, { user: 'admin' });
  assert.notEqual(dup.id, src.id);
  assert.equal(dup.builtin, false);
  assert.equal(dup.rev, 1);
  assert.match(dup.name, /\(복사\)$/);
  assert.equal(dup.items.length, src.items.length);
  for (const k of dup.items.map((x) => x.key)) assert.equal(src.items.some((x) => x.key === k), false);
  assert.equal(tpl.duplicateTemplate('tpl-nope'), null);
  assert.equal(tpl.updateTemplate('tpl-nope', { name: 'x' }), null);
  assert.equal(await tpl.applyTemplate('tpl-nope', { scope: { targetIds: [] } }), null);
});

test('범위: 폴더 하위 포함/제외, 빈 targetIds 는 전체가 아니라 0건', async () => {
  const t = tpl.addTemplate({ name: '범위 확인', items: [{ name: '포트 7000', type: 'tcp', port: 7000, intervalSec: 300 }] });
  store.addTarget({ kind: 'infra', path: 'SCOPE\\SUB', name: 'sc-sub', host: '192.168.71.1' });
  store.addTarget({ kind: 'infra', path: 'SCOPE', name: 'sc-root', host: '192.168.71.2' });

  const none = await tpl.applyTemplate(t.id, { scope: { targetIds: [] }, dryRun: true });
  assert.equal(none.targets, 0);
  assert.equal(none.create, 0);

  const noSub = await tpl.applyTemplate(t.id, { scope: { kind: 'infra', path: 'SCOPE', includeSub: false }, dryRun: true });
  assert.equal(noSub.targets, 1);
  const withSub = await tpl.applyTemplate(t.id, { scope: { kind: 'infra', path: 'SCOPE' }, dryRun: true });
  assert.equal(withSub.targets, 2);
});

test('구분 불일치는 경고만이고 적용을 막지 않는다', async () => {
  const t = tpl.addTemplate({
    name: '서비스 전용',
    kind: 'service',
    items: [{ name: '포트 7100', type: 'tcp', port: 7100, intervalSec: 300 }],
  });
  const g = mkTarget('t-kindmix');            // kind=infra
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  assert.equal(r.create, 1);
  assert.equal(r.errorCount, 0);
  assert.equal(r.kindMismatch, 1);
  assert.equal(r.warnings.length, 1);
});

test('태그 없는 수동 점검은 이름·유형이 같아도 흡수하지 않는다', async () => {
  const t = tpl.addTemplate({ name: '흡수 금지', items: [{ name: '포트 7200', type: 'tcp', port: 7200, intervalSec: 300 }] });
  const g = mkTarget('t-manual');
  const manual = store.addTest(g.id, { name: '포트 7200', type: 'tcp', port: 7200, intervalSec: 300 });
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  assert.equal(r.create, 1);
  const tests = store.getTarget(g.id).tests;
  assert.equal(tests.length, 2);
  assert.equal(tests.find((x) => x.id === manual.id).tpl, undefined);
});

test('템플릿에서 삭제된 항목은 대상에 고아로 남는다(자동 삭제하지 않는다)', async () => {
  const t = tpl.addTemplate({
    name: '항목 삭제',
    items: [
      { name: '포트 7300', type: 'tcp', port: 7300, intervalSec: 300 },
      { name: '포트 7301', type: 'tcp', port: 7301, intervalSec: 300 },
    ],
  });
  const g = mkTarget('t-orphan');
  await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  tpl.updateTemplate(t.id, { items: [t.items[0]] }, { user: 'admin' });
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true });
  assert.equal(r.update, 0);
  assert.equal(r.skip, 1);
  const tests = store.getTarget(g.id).tests;
  assert.equal(tests.length, 2);
  assert.ok(tests.some((x) => x.tplKey === t.items[1].key));   // 고아 유지
});

/* ── 후속 검증(P1/P2/P4/P5/P6/P13/P16/P18) ─────────────────────────────────────
 * 아래는 '구현자가 만든 방어 분기'와 '문서화된 동작' 이 실제로 그렇게 동작하는지 확인한다.
 * 전부 실측으로 재현된 결함이며, 회귀하면 오류 0건인 조용한 파손이 된다.
 * ─────────────────────────────────────────────────────────────────────────── */

test('scope 는 해석 실패를 조용히 넓히지 않는다(오타 하나로 전체 적용 금지)', async () => {
  const t = tpl.addTemplate({ name: '범위 엄격', items: [{ name: '포트 7400', type: 'tcp', port: 7400, intervalSec: 300 }] });
  const g = mkTarget('scope-strict');                                    // kind=infra
  store.addTarget({ kind: 'service', path: 'SCOPE2', name: 'sc-svc', host: '192.168.76.1' });
  const all = (await tpl.applyTemplate(t.id, { scope: {}, dryRun: true })).targets;

  await assert.rejects(() => tpl.applyTemplate(t.id, { scope: { kind: 'network' }, dryRun: true }), /알 수 없는 구분/);
  await assert.rejects(() => tpl.applyTemplate(t.id, { scope: { targetIds: g.id }, dryRun: true }), /배열이어야/);
  await assert.rejects(() => tpl.applyTemplate(t.id, { scope: { targetIds: null }, dryRun: true }), /배열이어야/);
  await assert.rejects(() => tpl.applyTemplate(t.id, { scope: { targetIds: { 0: g.id } }, dryRun: true }), /배열이어야/);
  await assert.rejects(() => tpl.applyTemplate(t.id, { scope: null, dryRun: true }), /객체여야/);
  await assert.rejects(() => tpl.applyTemplate(t.id, { scope: [], dryRun: true }), /객체여야/);
  await assert.rejects(() => tpl.applyTemplate(t.id, { scope: { path: 123 }, dryRun: true }), /문자열이어야/);

  // 대소문자는 store.pickEnum 과 같이 정규화한다(무시하고 넓히지 않는다)
  const upper = await tpl.applyTemplate(t.id, { scope: { kind: 'INFRA' }, dryRun: true });
  const lower = await tpl.applyTemplate(t.id, { scope: { kind: 'infra' }, dryRun: true });
  assert.equal(upper.targets, lower.targets);
  assert.ok(lower.targets < all, `kind 필터가 좁히지 못했다(${lower.targets}/${all})`);
  // 조건 없는 전체 적용은 경고로 알린다(요청 본문 {} 하나로 성립하는 경로)
  assert.match((await tpl.applyTemplate(t.id, { scope: {}, dryRun: true })).warnings.join(' '), /전체 대상/);
});

test("overwrite/dryRun/includeSub 은 문자열 'false' 에 반전되지 않는다", async () => {
  const t = tpl.addTemplate({ name: 'bool 정규화', items: [{ name: '포트 7500', type: 'tcp', port: 7500, intervalSec: 300 }] });
  const g = mkTarget('bool-host');
  await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  const t0 = store.getTarget(g.id).tests[0];
  store.updateTest(g.id, t0.id, { ...t0, intervalSec: 900 });

  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: 'false' });
  assert.equal(r.update, 0);
  assert.equal(store.getTarget(g.id).tests[0].intervalSec, 900, "overwrite:'false' 가 true 로 뒤집혔다");

  const g2 = mkTarget('bool-host2');
  const r2 = await tpl.applyTemplate(t.id, { scope: { targetIds: [g2.id] }, dryRun: 'false' });
  assert.equal(r2.create, 1);
  assert.equal(r2.committed, true, "dryRun:'false' 가 미리보기로 처리됐다(보고만 하고 저장 0건)");
  assert.equal(store.getTarget(g2.id).tests.length, 1);

  store.addTarget({ kind: 'infra', path: 'BOOL\\SUB', name: 'b-sub', host: '192.168.72.1' });
  store.addTarget({ kind: 'infra', path: 'BOOL', name: 'b-root', host: '192.168.72.2' });
  assert.equal((await tpl.applyTemplate(t.id, { scope: { kind: 'infra', path: 'BOOL', includeSub: 'false' }, dryRun: true })).targets, 1);
  assert.equal((await tpl.applyTemplate(t.id, { scope: { kind: 'infra', path: 'BOOL', includeSub: 'true' }, dryRun: true })).targets, 2);
});

test('치환 결과가 필드 상한을 넘으면 절단이 아니라 행 오류다', async () => {
  const t = tpl.addTemplate({ name: '이름 길이', items: [{ name: '{name}', type: 'tcp', port: 7600, intervalSec: 300 }] });
  const pre = 'X'.repeat(80);                       // 80자 공통 접두사 + 서로 다른 꼬리
  const a = store.addTarget({ kind: 'infra', path: 'LEN', name: `${pre}-AAA`, host: '192.168.73.1' });
  const b = store.addTarget({ kind: 'infra', path: 'LEN', name: `${pre}-BBB`, host: '192.168.73.2' });
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [a.id, b.id] } });
  assert.equal(r.create, 0, '절단된 같은 이름 점검이 2개 생성됐다');
  assert.equal(r.errorCount, 2);
  assert.match(r.errors[0].reason, /80자/);
  assert.equal(r.committed, false);
  assert.equal(store.getTarget(a.id).tests.length, 0);

  // URL 도 같다 — 저장 시 499자, 치환 후 500자 초과
  const long = `https://{host}/${'p'.repeat(470)}?flag=critical`;
  assert.equal(long.length, 499);
  const t2 = tpl.addTemplate({ name: 'URL 길이', items: [{ name: 'u', type: 'http', url: long, intervalSec: 300 }] });
  const g = mkTarget('len-url');
  const r2 = await tpl.applyTemplate(t2.id, { scope: { targetIds: [g.id] } });
  assert.equal(r2.create, 0);
  assert.match(r2.errors[0].reason, /500자/);
  assert.equal(store.getTarget(g.id).tests.length, 0);

  // 템플릿 이름·설명도 절단하지 않는다
  assert.throws(() => tpl.addTemplate({ name: 'N'.repeat(61), items: [] }), /60자/);
  assert.throws(() => tpl.addTemplate({ name: 'ok-desc', desc: 'D'.repeat(301), items: [] }), /300자/);
});

test('대상 이름의 CRLF 가 send(원시 소켓)·헤더로 주입되지 않는다', async () => {
  const t = tpl.addTemplate({
    name: 'SMTP 배너',
    items: [{ name: 'SMTP {name}', type: 'smtp', port: 25, send: 'EHLO {name}', intervalSec: 300 }],
  });
  // store.cleanTarget 의 대상 이름은 길이만 검사한다(문자 화이트리스트 없음) — 실측으로 통과한다.
  const g = store.addTarget({
    kind: 'infra', path: 'CRLF', name: 'srv01\r\nMAIL FROM:<attacker@evil>', host: '192.168.74.1',
  });
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } });
  assert.equal(r.create, 0);
  assert.equal(r.errorCount, 1);
  assert.match(r.errors[0].reason, /제어문자/);
  assert.equal(store.getTarget(g.id).tests.length, 0);

  // 리터럴 CRLF 는 저장 단계에서 거부(방어 1)
  assert.throws(() => tpl.addTemplate({
    name: '리터럴 CRLF',
    items: [{ name: 'x', type: 'smtp', port: 25, send: 'EHLO a\r\nMAIL FROM:<x>', intervalSec: 300 }],
  }), /제어문자/);

  // body(SOAP XML)는 줄바꿈을 허용한다 — HTTP 본문은 Content-Length 프레이밍이라 명령 경계가 없다
  const ok = tpl.addTemplate({
    name: 'SOAP 본문',
    items: [{ name: 'soap', type: 'soap', url: 'https://{host}/svc', body: '<a>\n  <b/>\n</a>', intervalSec: 300 }],
  });
  assert.match(ok.items[0].body, /\n/);
});

test('식별자 정규화: key 없음·40자 초과 id/key·중복 key 가 재기동을 끼워도 중복 생성되지 않는다', async () => {
  // ① key 필드가 없는 항목 — 랜덤 발급을 저장하지 않으면 재기동마다 점검이 하나씩 늘어난다
  injectRawTemplate({ id: 'tpl-nokey', name: '키없음', items: [rawItem({ name: 'PING', type: 'ping' })] });
  const g1 = mkTarget('id-nokey');
  const keys = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await tpl.applyTemplate('tpl-nokey', { scope: { targetIds: [g1.id] } });
    assert.equal(r.errorCount, 0);
    keys.push(tpl.getTemplate('tpl-nokey').items[0].key);
    assert.equal(store.getTarget(g1.id).tests.length, 1, `${i + 1}회 적용에서 중복 생성`);
    tpl._resetTemplateCache();                                  // 재기동 시뮬레이션
  }
  assert.equal(new Set(keys).size, 1, '발급한 key 가 프로세스마다 달라졌다');
  assert.match(keys[0], /^k-[0-9a-f]{8}$/);
  const persisted = JSON.parse(fs.readFileSync(TPL_FILE, 'utf8')).templates.find((x) => x.id === 'tpl-nokey');
  assert.equal(persisted.items[0].key, keys[0], '발급한 key 가 파일에 저장되지 않았다');

  // ② 40자 초과 id — store 는 tpl 태그를 40자로 잘라 저장한다(같은 값으로 맞춰야 매칭된다)
  const longId = `tpl-${'a'.repeat(45)}`;
  injectRawTemplate({ id: longId, name: '긴id', items: [rawItem({ key: 'k-11111111', name: '포트', type: 'tcp', port: 7810 })] });
  const eff = tpl.listTemplates().find((x) => x.name === '긴id').id;
  assert.equal(eff.length, 40);
  assert.equal(eff, longId.slice(0, 40));
  const g2 = mkTarget('id-longid');
  for (let i = 0; i < 3; i += 1) {
    await tpl.applyTemplate(eff, { scope: { targetIds: [g2.id] } });
    assert.equal(store.getTarget(g2.id).tests.length, 1, `${i + 1}회 적용에서 중복 생성`);
    tpl._resetTemplateCache();
  }
  assert.deepEqual(tpl.templateUsage(eff), { targets: 1, tests: 1 });   // 삭제 경고가 0 을 보고하면 안 된다

  // ③ 40자 초과 key
  injectRawTemplate({ id: 'tpl-longkey', name: '긴key', items: [rawItem({ key: `k-${'b'.repeat(58)}`, name: '포트', type: 'tcp', port: 7811 })] });
  const g3 = mkTarget('id-longkey');
  for (let i = 0; i < 3; i += 1) {
    await tpl.applyTemplate('tpl-longkey', { scope: { targetIds: [g3.id] } });
    assert.equal(store.getTarget(g3.id).tests.length, 1, `${i + 1}회 적용에서 중복 생성`);
    tpl._resetTemplateCache();
  }

  // ④ 같은 key 를 가진 항목 2개 — overwrite 적용이 A→B 로 덮어쓰며 매 적용 플립플롭이 된다
  injectRawTemplate({
    id: 'tpl-dupkey',
    name: '중복key',
    items: [
      rawItem({ key: 'k-cccccccc', name: 'A', type: 'tcp', port: 7812 }),
      rawItem({ key: 'k-cccccccc', name: 'B', type: 'tcp', port: 7813 }),
    ],
  });
  const g4 = mkTarget('id-dupkey');
  for (let i = 0; i < 3; i += 1) {
    const r = await tpl.applyTemplate('tpl-dupkey', { scope: { targetIds: [g4.id] }, overwrite: true });
    assert.equal(r.errorCount, 0);
    if (i > 0) assert.equal(r.update, 0, '값이 그대로인데 update 로 잡혔다(플립플롭)');
    assert.deepEqual(store.getTarget(g4.id).tests.map((x) => x.port).sort(), [7812, 7813]);
    tpl._resetTemplateCache();
  }

  // ⑤ KEY_RE 밖이지만 store 가 태그로 담을 수 있는 key 는 UI 왕복에서도 보존한다
  injectRawTemplate({ id: 'tpl-handkey', name: '손키', items: [rawItem({ key: 'linux-ping', name: 'PING', type: 'ping' })] });
  const g5 = mkTarget('id-handkey');
  assert.equal((await tpl.applyTemplate('tpl-handkey', { scope: { targetIds: [g5.id] } })).create, 1);
  tpl.updateTemplate('tpl-handkey', { items: tpl.getTemplate('tpl-handkey').items }, { user: 'ui' });   // UI 왕복
  const again = await tpl.applyTemplate('tpl-handkey', { scope: { targetIds: [g5.id] } });
  assert.equal(again.create, 0, 'UI 왕복이 key 를 재발급해 같은 점검이 하나 더 생겼다');
  assert.equal(again.skip, 1);
  assert.equal(tpl.getTemplate('tpl-handkey').items[0].key, 'linux-ping');
});

test('overwrite=true 가 지울 수 없는 필드는 경고로 알린다(플립플롭 없이 skip)', async () => {
  const t = tpl.addTemplate({
    name: '필드 제거',
    items: [{ name: 'H', type: 'http', url: 'https://{host}/', keyword: 'OK-SECRET', expectStatus: 200, intervalSec: 300 }],
  });
  const g = mkTarget('drop-host');
  assert.equal((await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] } })).create, 1);

  const item = { ...tpl.getTemplate(t.id).items[0] };
  delete item.keyword;
  delete item.expectStatus;
  assert.equal(tpl.updateTemplate(t.id, { items: [item] }, { user: 'admin' }).rev, 2);

  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true });
  // store.updateTest 는 미지정 필드를 기존값으로 승계한다(빈 문자열·null 을 넘겨도 승계 — 실측).
  // 값이 남는 것 자체는 store 의 계약이므로, **모른 채 지나가지 않게** 경고로 알린다.
  assert.equal(r.update, 0);
  assert.equal(r.skip, 1);
  assert.match(r.warnings.join(' '), /제거된 필드/);
  assert.match(r.warnings.join(' '), /포함 문자열|기대 상태코드/);
  assert.equal(store.getTarget(g.id).tests[0].keyword, 'OK-SECRET');
  // 반복 적용이 update 로 뒤집히지 않는다
  assert.equal((await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true })).update, 0);
  // 값이 실제로 바뀐 경우는 여전히 update 다
  tpl.updateTemplate(t.id, { items: [{ ...item, intervalSec: 600 }] });
  const r2 = await tpl.applyTemplate(t.id, { scope: { targetIds: [g.id] }, overwrite: true });
  assert.equal(r2.update, 1);
  assert.equal(store.getTarget(g.id).tests[0].intervalSec, 600);
});

test('이름·유형이 같은데 태그가 다른 기존 점검은 경고한다(템플릿 재생성 = 중복 감시)', async () => {
  const items = [{ name: '포트 7800', type: 'tcp', port: 7800, intervalSec: 300 }];
  const t1 = tpl.addTemplate({ name: '재생성 대상', items });
  const g = mkTarget('recreate-host');
  assert.equal((await tpl.applyTemplate(t1.id, { scope: { targetIds: [g.id] } })).create, 1);
  tpl.deleteTemplate(t1.id);                        // 적용된 점검은 남는다(태그 포함)
  const t2 = tpl.addTemplate({ name: '재생성 대상', items });
  assert.notEqual(t2.id, t1.id, '사용자 템플릿은 재생성 때 새 tpl id 를 받는다');
  const r = await tpl.applyTemplate(t2.id, { scope: { targetIds: [g.id] }, dryRun: true });
  assert.equal(r.create, 1);                        // 태그를 남겨도 중복 생성을 막지 못한다
  assert.match(r.warnings.join(' '), /다른 템플릿 태그/);
});

test('손편집으로 상한을 넘긴 템플릿은 적용·복제에서 거부된다(정제로 세탁하지 않는다)', async () => {
  const many = Array.from({ length: tpl.MAX_ITEMS + 10 }, (_, i) => rawItem({
    key: `k-${String(i).padStart(8, '0')}`, name: `p${i}`, type: i < 6 ? 'ping' : 'tcp', port: 20000 + i,
  }));
  injectRawTemplate({ id: 'tpl-over', name: '상한초과', items: many });
  const g = mkTarget('over-host');
  const r = await tpl.applyTemplate('tpl-over', { scope: { targetIds: [g.id] } });
  assert.equal(r.create, 0);
  assert.equal(r.errorCount, 2);
  assert.match(r.errors.map((e) => e.reason).join(' '), /항목이 상한을 넘습니다/);
  assert.match(r.errors.map((e) => e.reason).join(' '), /ping 항목이 상한을 넘습니다/);
  assert.equal(store.getTarget(g.id).tests.length, 0);
  // 검토 자체를 하지 않는다(행 오류가 아니라 단건 거부)
  assert.equal(r.tests, 0);
  assert.throws(() => tpl.duplicateTemplate('tpl-over'), new RegExp(`최대 ${tpl.MAX_ITEMS}개`));
});

test('1회 적용 상한 초과 요청은 계획을 전량 만들지 않고 중단한다', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ name: `b${i}`, type: 'tcp', port: 21000 + i, intervalSec: 300 }));
  const t = tpl.addTemplate({ name: '대량 적용', items });
  const ids = [];
  for (let i = 0; i < 600; i += 1) {                      // 600 × 20 = 12,000행 > maxBulkTests(10,000)
    ids.push(store.addTarget({
      kind: 'infra', path: 'BULK', name: `bulk${i}`, host: `10.90.${Math.floor(i / 250)}.${i % 250}`,
    }).id);
  }
  const r = await tpl.applyTemplate(t.id, { scope: { targetIds: ids }, dryRun: true });
  assert.equal(r.aborted, true);
  assert.equal(r.committed, false);
  assert.equal(r.create, 0);
  assert.match(r.errors.at(-1).reason, /1회 적용은 최대/);
  // 거부될 요청이 O(대상×항목) 을 끝까지 돌지 않는다(2만 대상×50항목에서 동기 1.5초·heap 597MB 실측)
  assert.ok(r.tests <= store.LIMITS.maxBulkTests + items.length,
    `상한 초과인데 ${r.tests}행을 모두 검토했다`);
});

test('저장 실패를 성공으로 감추지 않는다(예외 + 메모리 롤백)', () => {
  const before = tpl.listTemplates();                 // 캐시를 채워 둔다(이후 로드가 일어나지 않게)
  assert.ok(before.some((x) => x.id === 'tpl-mail'));
  const body = fs.readFileSync(TPL_FILE, 'utf8');
  fs.rmSync(TPL_FILE);
  fs.mkdirSync(TPL_FILE);                             // 비어있지 않은 디렉터리 → rename 이 EISDIR
  fs.writeFileSync(path.join(TPL_FILE, 'x'), '1');
  try {
    assert.throws(() => tpl.addTemplate({ name: '저장실패', items: [{ name: 'p', type: 'tcp', port: 7700, intervalSec: 300 }] }), /저장에 실패/);
    assert.equal(tpl.listTemplates().length, before.length, '실패한 추가가 메모리에 남았다(재기동하면 사라진다)');
    assert.throws(() => tpl.updateTemplate('tpl-mail', { name: '변경됨' }), /저장에 실패/);
    assert.equal(tpl.getTemplate('tpl-mail').name, before.find((x) => x.id === 'tpl-mail').name);
    assert.throws(() => tpl.deleteTemplate('tpl-mail'), /저장에 실패/);
    assert.ok(tpl.getTemplate('tpl-mail'), '삭제가 실패했는데 메모리에서 사라졌다(재기동하면 부활)');
    assert.throws(() => tpl.duplicateTemplate('tpl-mail'), /저장에 실패/);
    assert.equal(tpl.listTemplates().length, before.length);
  } finally {
    fs.rmSync(TPL_FILE, { recursive: true, force: true });
    fs.writeFileSync(TPL_FILE, body);                 // 메모리 = 롤백 후 상태 = 이 파일 내용
  }
});

test('materializeForTarget(genspec 연동) 도 같은 3단 방어를 통과한다', () => {
  const t = tpl.addTemplate({
    name: '생성용',
    items: [{ name: '{name} HTTP', type: 'http', url: 'https://{host}/h', intervalSec: 300 }],
  });
  const r = tpl.materializeForTarget(t.id, { kind: 'infra', path: 'GEN', name: 'gen01', host: '192.168.75.1' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.tests.length, 1);
  assert.equal(r.tests[0].name, 'gen01 HTTP');
  assert.equal(r.tests[0].url, 'https://192.168.75.1/h');
  assert.equal(r.tests[0].tpl, t.id);                 // 태그가 없으면 나중 재적용이 중복 생성한다
  assert.equal(r.tests[0].tplKey, t.items[0].key);
  assert.ok(tpl.materializeForTarget(t.id, { name: 'x', host: '127.0.0.1' }).errors.length);   // SSRF
  assert.ok(tpl.materializeForTarget(t.id, { name: 'x', host: '' }).errors.length);            // 빈 host
  assert.equal(tpl.materializeForTarget('tpl-nope', { host: '10.0.0.1' }).errors.length, 1);
});

/* ── T21 (템플릿 수를 상한까지 채우므로 마지막에 둔다) ── */

test('T21 항목 50개·템플릿 100개 상한 초과 → 오류(절단 아님)', () => {
  const many = Array.from({ length: tpl.MAX_ITEMS + 1 }, (_, i) => ({
    name: `p${i}`, type: 'tcp', port: 10000 + i, intervalSec: 300,
  }));
  assert.throws(() => tpl.addTemplate({ name: '항목 과다', items: many }), new RegExp(`최대 ${tpl.MAX_ITEMS}개`));
  const okTpl = tpl.addTemplate({ name: '항목 50', items: many.slice(0, tpl.MAX_ITEMS) });
  assert.equal(okTpl.items.length, tpl.MAX_ITEMS);
  assert.throws(() => tpl.updateTemplate(okTpl.id, { items: many }), new RegExp(`최대 ${tpl.MAX_ITEMS}개`));
  assert.equal(tpl.getTemplate(okTpl.id).items.length, tpl.MAX_ITEMS);   // 실패가 원본을 훼손하지 않는다

  let n = tpl.listTemplates().length;
  while (n < tpl.MAX_TEMPLATES) {
    tpl.addTemplate({ name: `filler ${n}`, items: [{ name: 'x', type: 'tcp', port: 80, intervalSec: 300 }] });
    n += 1;
  }
  assert.equal(tpl.listTemplates().length, tpl.MAX_TEMPLATES);
  assert.throws(() => tpl.addTemplate({ name: '초과' }), new RegExp(`최대 ${tpl.MAX_TEMPLATES}개`));
  assert.throws(() => tpl.duplicateTemplate(okTpl.id), new RegExp(`최대 ${tpl.MAX_TEMPLATES}개`));
});
