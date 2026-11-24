/**
 * full155.test.js — 전체 점검 155회차(4축: 장비 · 스토리지 · 백업 도구 · IP 관리) 회귀.
 *
 *  F1  장비 · 외부가 준 **이름**을 일반 객체의 키로 쓰는 자리가 Object.prototype 의 상속 값을 '이미 있는 값' 으로 읽었다.
 *      ⓐ sanswitch/zoning.js parseCfgShow · resolveZones — zone · alias · cfg 이름이 ‘constructor’ · ‘toString’ · ‘valueOf’ 면
 *         `bucket[name].push is not a function` · `is not iterable` → buildSnapshot 이 던져 그 스위치의 수집 전체가 매 주기 실패.
 *      ⓑ sanswitch/zoningCollect.js zoningFromRest — 멤버 이름 ‘constructor’ · ‘hasOwnProperty’ → `av is not iterable` · 별칭 ‘__proto__’ 는 조용히 사라짐.
 *      ⓒ veeam/snapEvents.js rememberLearned — 계정 이름 ‘constructor’ → `prev.vms.includes` TypeError(그 vCenter 스냅샷 요약 실패) ·
 *         forgetLearned 가 배운 적 없는 ‘toString’ 을 지웠다고 셈.
 *  F2  idrac/registry.js normalize · testServer · nsx/registry.js normalize · testConnection · nsx/client.js norm — host 길이 상한이 없고
 *      끝 '/' 를 /\/+$/ 로 지워 '/' 가 길게 이어진 host 한 줄이 이벤트 루프를 막았다(4만 자 0.69초 · 8만 자 2.4초 — O(n²)) · 그 host 가 그대로 저장됐다.
 *
 * 시간 비율로 재지 않는다(6병렬 전량 실행에서 흔들린다) — 거절 사유 · 저장 여부 · 소스의 금지 꼴 부재로 고정한다(수정 전 판본에서 전부 실패).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('full155-');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const src = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

const { parseCfgShow, resolveZones } = await import('../src/sanswitch/zoning.js');
const { zoningFromText, zoningFromRest } = await import('../src/sanswitch/zoningCollect.js');
const { buildSnapshot } = await import('../src/sanswitch/collectors/fosSsh.js');

const W1 = '10:00:00:10:9b:00:00:01'; const W2 = '10:00:00:10:9b:00:00:02'; const T1 = '50:00:09:70:00:00:00:01';
/** Object.prototype 에 있는 이름들 — 장비 이름 규칙(영문자로 시작 · 영숫자 · 밑줄)에 맞는 것. */
const PROTO_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString', 'propertyIsEnumerable'];

/* ───────────────────────── F1 ⓐ cfgshow(SSH) ───────────────────────── */

test('F1ⓐ zone · alias · cfg 이름이 Object.prototype 의 이름이어도 조닝 파서가 던지지 않고 그 이름 그대로 읽는다', () => {
  for (const name of PROTO_NAMES) {
    const text = [
      'Defined configuration:',
      ` cfg:\tcfg1\t${name}; z2`,
      ` zone:\t${name}\t${W1}; ${T1}`,
      ' zone:\tz2\tali1',
      ` alias:\tali1\t${W2}`,
      '',
    ].join('\n');
    const p = parseCfgShow(text);
    assert.ok(Object.hasOwn(p.defined.zones, name), `${name} zone 이 자기 속성으로 있다`);
    assert.deepEqual(p.defined.zones[name], [W1, T1]);
    const z = zoningFromText(text, 'cfg1');
    assert.equal(z.available, true);
    assert.deepEqual(z.zones.map((x) => x.name), [name, 'z2'], `${name}: 활성 cfg 의 zone 둘`);
    assert.deepEqual(z.zones[0].members, [W1, T1]);
    assert.equal(z.counts.definedZones, 2);
  }
});

test('F1ⓐ 별칭 이름 · 이어지는 멤버 줄 · 같은 이름이 두 번 나오는 정의도 같은 목록에 쌓인다', () => {
  const text = [
    'Defined configuration:',
    ' cfg:\tcfg1\tz1',
    ' zone:\tz1\ttoString; valueOf',
    ` alias:\ttoString\t${W1}`,
    ' alias:\tvalueOf',
    `\t\t${W2}`,
    ` alias:\ttoString\t${T1}`,
    '',
  ].join('\n');
  const z = zoningFromText(text, 'cfg1');
  assert.deepEqual(Object.keys(z.aliases).sort(), ['toString', 'valueOf']);
  assert.deepEqual(z.aliases.toString, [W1, T1]);
  assert.deepEqual(z.aliases.valueOf, [W2]);
  assert.deepEqual([...z.zones[0].members].sort(), [W1, W2, T1].sort());
  assert.equal(z.zones[0].aliasOf[W2], 'valueOf');
});

test('F1ⓐ 정의에 없는 zone 이름(cfg 멤버) · 헤더의 활성 cfg 이름이 상속 이름이어도 없는 것으로 본다', () => {
  // cfg 멤버 valueOf 는 정의된 zone 이 아니다 — 예전에는 상속 함수를 멤버 목록으로 돌려 ‘is not iterable’
  const text = `Defined configuration:\n cfg:\tcfg1\tz2; valueOf\n zone:\tz2\t${W2}\n`;
  const a = zoningFromText(text, 'cfg1');
  assert.deepEqual(a.zones.map((x) => x.name), ['z2']);
  // 헤더가 말한 활성 cfg 가 정의에 없으면 첫 cfg 로 — 예전에는 cfgs['constructor'](함수)를 zone 목록으로 읽어 ‘filter is not a function’
  for (const name of PROTO_NAMES) {
    const b = zoningFromText(text, name);
    assert.deepEqual(b.zones.map((x) => x.name), ['z2'], name);
    const r = resolveZones(parseCfgShow(text), { activeCfg: name });
    assert.equal(r.cfgName, 'cfg1');
  }
});

test('F1ⓐ ‘__proto__’ 이름은 원형을 바꾸지 않고 자기 속성 목록이 된다(다른 이름 조회가 오염되지 않는다)', () => {
  const text = `Defined configuration:\n cfg:\tcfg1\tz2\n zone:\t__proto__\t${W1}\n zone:\tz2\t${W2}\n`;
  const p = parseCfgShow(text);
  assert.equal(Object.getPrototypeOf(p.defined.zones), Object.prototype);
  assert.ok(Object.hasOwn(p.defined.zones, '__proto__'));
  assert.deepEqual(Object.keys(p.defined.zones).sort(), ['__proto__', 'z2']);
  assert.equal(zoningFromText(text, 'cfg1').counts.definedZones, 2);
});

test('F1ⓐ 그런 이름의 zone 이 있는 스위치도 스냅샷(buildSnapshot)이 만들어진다 — 예전에는 조닝 한 줄이 수집 전체를 실패시켰다', () => {
  const cfgshow = `Defined configuration:\n cfg:\tprod\tconstructor\n zone:\tconstructor\t${W1}; ${T1}\nEffective configuration:\n cfg:\tprod\n zone:\tconstructor\n\t\t${W1}\n\t\t${T1}\n`;
  const snap = buildSnapshot({ id: 'sw1', name: 'sw1', host: '10.9.9.9' }, { cfgshow }, {}, {}, { noRates: true });
  assert.equal(snap.zoning.zoneCount, 1);
  assert.equal(snap.zoning.zones[0].name, 'constructor');
  assert.deepEqual(snap.zoning.zones[0].members, [W1, T1]);
});

/* ───────────────────────── F1 ⓑ REST ───────────────────────── */

test('F1ⓑ REST 조닝 — 멤버 이름이 상속 이름이면 미해석 멤버로 남고(던지지 않는다) 정의된 별칭이면 풀린다', () => {
  const eff = (members) => ({ 'effective-configuration': { 'cfg-name': 'c', 'enabled-zone': [{ 'zone-name': 'z', 'member-entry': { 'entry-name': members } }] } });
  for (const name of PROTO_NAMES) {
    const a = zoningFromRest(eff([name, W2]), { 'defined-configuration': { alias: [] } });
    assert.deepEqual(a.zones[0].members, [W2, name], `${name}: 별칭 정의가 없으면 미해석`);
    const b = zoningFromRest(eff([name]), { 'defined-configuration': { alias: [{ 'alias-name': name, 'member-entry': { 'alias-entry-name': [W1] } }] } });
    assert.deepEqual(b.zones[0].members, [W1], `${name}: 정의된 별칭은 WWN 으로`);
    assert.equal(b.zones[0].aliasOf[W1], name);
    assert.equal(b.counts.aliases, 1);
  }
});

test('F1ⓑ REST 조닝 — 별칭 ‘__proto__’ 는 사라지지 않는다(개수 · 해석)', () => {
  const z = zoningFromRest(
    { 'effective-configuration': { 'cfg-name': 'c', 'enabled-zone': [{ 'zone-name': 'z', 'member-entry': { 'entry-name': ['__proto__', 'length'] } }] } },
    { 'defined-configuration': { alias: [{ 'alias-name': '__proto__', 'member-entry': { 'alias-entry-name': [W1] } }] } });
  assert.equal(z.counts.aliases, 1);
  assert.equal(Object.getPrototypeOf(z.aliases), Object.prototype);
  assert.deepEqual(z.zones[0].members, [W1, 'length'], '‘length’ 는 원형이 배열로 바뀌었을 때만 풀리는 이름이다 — 미해석이어야 한다');
});

/* ───────────────────────── F1 ⓒ Veeam 계정 학습 ───────────────────────── */

test('F1ⓒ 계정 이름이 상속 이름이어도 학습이 던지지 않고, 배운 적 없는 이름은 지웠다고 세지 않는다', async () => {
  const SE = await import('../src/veeam/snapEvents.js');
  SE._resetForTest();
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  // 배운 적 없는 이름 — 예전에는 상속 함수를 '배운 기록' 으로 읽어 1 을 돌려주고 forgotten 에 적었다
  assert.equal(SE.forgetLearned(['toString', 'constructor'], now), 0);
  for (const name of PROTO_NAMES) {
    assert.equal(SE.rememberLearned([{ account: name, vm: 'vm-a' }], now), 1, `${name}: 새 계정 1건`);
    assert.equal(SE.rememberLearned([{ account: name, vm: 'vm-a' }], now + 60_000), 0, `${name}: 같은 VM · 1시간 안이면 쓰지 않는다`);
    assert.equal(SE.rememberLearned([{ account: name, vm: 'vm-b' }], now + 120_000), 1, `${name}: 새 VM`);
  }
  // ‘__proto__’ 계정 — 대입이면 원형만 바뀌어 매번 '새 계정' 으로 세고(조회마다 파일 쓰기) 저장에는 없다
  assert.equal(SE.rememberLearned([{ account: '__proto__', vm: 'vm-a' }], now), 1);
  assert.equal(SE.rememberLearned([{ account: '__proto__', vm: 'vm-a' }], now + 60_000), 0, '‘__proto__’: 이미 배운 계정이다');
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.CONFIG_DIR, 'veeam-vc-accounts.json'), 'utf8'));
  assert.ok(Object.hasOwn(saved.learned, '__proto__'), '‘__proto__’ 계정이 파일에 남는다');
  for (const name of PROTO_NAMES) assert.deepEqual(saved.learned[name].vms, ['vm-a', 'vm-b'], name);
  assert.equal(SE.forgetLearned(['toString'], now + 180_000), 1, '배운 뒤에는 지워진다');
  // 파일에 ‘__proto__’ 계정이 있어도 읽을 때 원형을 바꾸지 않고(자기 속성) 다음 저장에 그대로 남는다
  fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'veeam-vc-accounts.json'), `{"manual":[],"pulled":[],"forgotten":{},"learned":{"__proto__":{"t":${now},"vms":["vm-a","vm-b"]}}}`);
  SE._resetForTest();
  assert.equal(SE.rememberLearned([{ account: 'svc-x', vm: 'vm-c' }], now + 200_000), 1);
  const again = fs.readFileSync(path.join(process.env.CONFIG_DIR, 'veeam-vc-accounts.json'), 'utf8');
  assert.match(again, /"__proto__":\s*\{/, '읽은 ‘__proto__’ 계정이 저장에서 사라지지 않는다');
  assert.match(again, /"svc-x"/);
  SE._resetForTest();
});

/* ───────────────────────── F2 host 길이 상한 · 선형 ───────────────────────── */

const LONG = (n) => `10.0.0.5${'/'.repeat(n)}x`;

test('F2 iDRAC 등록 — host 는 2,048자까지 · 넘으면 정규식 전에 거절하고 저장하지 않는다 · 끝 슬래시는 예전처럼 지운다', async () => {
  const R = await import('../src/idrac/registry.js');
  assert.equal(R.HOST_MAX_LEN, 2048);
  const base = { id: 'a1', name: 'a1', username: 'root', password: 'p' };
  for (const n of [3_000, 80_000]) {
    const r = R.idracInputIssue({ ...base, host: LONG(n) });
    assert.match(String(r.issue), /host 가 너무 깁니다\(최대 2,048자\)/, `${n}자`);
    assert.equal(r.host, '');
  }
  const add = R.addServer({ ...base, host: LONG(80_000) });
  assert.equal(add.ok, false);
  assert.match(add.reason, /너무 깁니다/);
  assert.equal(R.loadRegistry().length, 0, '긴 host 는 등록부에 들어가지 않는다');
  // 예전 동작 보존 — 끝 '/' 여러 개 · 스킴 붙이기 · 가운데 '/' 는 그대로
  assert.equal(R.idracInputIssue({ ...base, host: '10.0.0.5///' }).host, 'https://10.0.0.5');
  assert.equal(R.idracInputIssue({ ...base, host: 'http://10.0.0.5:8443/redfish//' }).host, 'http://10.0.0.5:8443/redfish');
  assert.equal(R.idracInputIssue({ ...base, host: `10.0.0.5/${'a'.repeat(2030)}` }).issue, null, '상한 안(2,039자)은 받는다');
});

test('F2 iDRAC 연결 테스트 — 긴 host 는 접속 · SSRF 판정 전에 길이로 거절한다', async () => {
  const R = await import('../src/idrac/registry.js');
  // 루프백이라 수정 전 판본은 ‘host 거부’(SSRF)로 답한다 — 어느 판본도 네트워크를 타지 않는다
  const r = await R.testServer({ host: `127.0.0.1${'/'.repeat(3_000)}x`, username: 'root', password: 'p' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /host 가 너무 깁니다\(최대 2,048자\)/);
});

test('F2 NSX 등록 · 연결 테스트 — 같은 상한(저장하지 않는다)', async () => {
  const N = await import('../src/nsx/registry.js');
  assert.equal(N.HOST_MAX_LEN, 2048);
  const add = N.addManager({ id: 'n1', name: 'n1', host: `https://10.0.0.7${'/'.repeat(80_000)}x`, username: 'admin', password: 'p' });
  assert.equal(add.ok, false);
  assert.match(add.reason, /host 가 너무 깁니다\(최대 2,048자\)/);
  assert.equal(N.loadRegistry().length, 0);
  const t = await N.testConnection({ host: `https://127.0.0.1${'/'.repeat(3_000)}x`, username: 'admin', password: 'p' });
  assert.equal(t.ok, false);
  assert.match(t.reason, /host 가 너무 깁니다/);
  // 예전 동작 보존 — 정상 host 는 그대로 저장되고 클라이언트 기준 주소는 끝 '/' 없이
  const ok = N.addManager({ id: 'n2', name: 'n2', host: 'https://10.0.0.7//', username: 'admin', password: 'p' });
  assert.equal(ok.ok, true);
  const { NsxClient } = await import('../src/nsx/client.js');
  assert.equal(new NsxClient({ host: 'https://10.0.0.7///', username: 'u', password: 'p' }).baseUrl, 'https://10.0.0.7');
  assert.equal(new NsxClient({ host: 'https://10.0.0.7/a//b', username: 'u', password: 'p' }).baseUrl, 'https://10.0.0.7/a//b');
});

test('F2 소스 — 요청 값이 닿는 host 정규화 자리에 끝 슬래시 정규식(/\\/+$/)이 없다', () => {
  const BAD = '.replace(/\\/+$/';
  const idr = src('idrac/registry.js');
  assert.equal(idr.includes(BAD), false, 'idrac/registry.js normalize · testServer');
  assert.match(idr, /host\.length > HOST_MAX_LEN[\s\S]{0,400}trimTrailingSlashes\(host\)/, '길이 검사가 자르기보다 앞');
  assert.equal(src('nsx/client.js').includes(BAD), false, 'nsx/client.js norm(수집 주기마다 저장 host 로 불린다)');
  assert.match(src('nsx/registry.js'), /host\.length > HOST_MAX_LEN[\s\S]{0,200}https\?/, 'nsx normalize: 길이 검사가 형식 검사보다 앞');
});
