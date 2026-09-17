/**
 * unityPrompt2544.test.js — '같은 버전인데 어디는 되고 어디는 안 된다' 의 원인(v2.544).
 *
 * ── 사용자 신고 ────────────────────────────────────────────────────────────────
 * "동일한 버전의 unity 스토리지 인데 어디는 돼고, 어디는 안되고 그래" + 화면 캡처.
 *
 * 화면이 이미 답을 갖고 있었다 — 두 장비의 **유일한 차이**는 CLI 원문 헤더다:
 *   OC2-unity-03 : `✓ [poolDetail] … 4.3초`                        → 첫 줄 `1:  ID = pool_1` → 정상
 *   OC2-unity-02 : `✓ [poolDetail] … 4.0초 · 자동응답 certAccept×2`  → 첫 줄 `ID = pool_2`   → 실패
 *
 * ── 원인 ──────────────────────────────────────────────────────────────────────
 * 인증서 프롬프트가 뜬 장비는 프롬프트 줄 **뒤에 이어서** 데이터가 온다:
 *   `Please input your selection (The default selection is [1]): 1:    ID = pool_2`
 * 여기엔 `1` 이 둘 있다 — 프롬프트의 기본 선택과 **uemcli 레코드 번호 `1:`**.
 * `stripUemcliBanner` 의 `\d*:?` 가 뒤의 `1:` 까지 지웠다. v2.526 에는 맞는 규칙이었지만
 * (그때 파서는 `:` 를 키 경계로 읽었다) **v2.542 가 레코드 경계를 `^N:` 으로 바꾸면서**
 * 새 파서가 반드시 필요로 하는 표시를 지우는 규칙이 됐다.
 * 결과: 명령은 성공(`✓ 성공 3 · 실패 0`)인데 섹션은 `풀 출력을 읽지 못했습니다`.
 *
 * ⚠ 풀이 2개 이상이면 **더 나쁘다** — 프롬프트 줄에 붙는 것은 첫 레코드뿐이라 `2:` 이후만
 *   살아남아 **오류 없이 용량이 과소 보고**된다. 그 경우도 이 파일이 고정한다.
 *
 * ⚠ 왜 v2.542 의 테스트 21건이 전부 통과하며 놓쳤나: 픽스처가 **전부 '프롬프트 없는 출력'**
 *   이었다. 그래서 여기 `uemcli-prompt-inline-2544.txt` 를 추가했다 — **지우지 말 것.**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripUemcliBanner } from '../src/proxy/sshExec.js';
import { parseUemcli, parsePools } from '../src/storage/collectors/uemcliParse.js';
import { SPECS, buildSnapshot } from '../src/storage/collectors/unitySsh.js';
import { versionFromSvcDiag, versionFromUemcli, mergeVersionInfo, shortVersion } from '../src/storage/collectors/unityVersion.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(here, 'fixtures', n), 'utf8');
const DEV = { id: 'u1', name: 'OC2-unity-02', host: '10.0.0.1', type: 'unity' };

// ── ① 레코드 경계가 살아남는다 ────────────────────────────────────────────────

test('★★ 프롬프트가 같은 줄에 붙어도 레코드 번호를 지우지 않는다', () => {
  const cleaned = stripUemcliBanner(fixture('uemcli-prompt-inline-2544.txt'));
  const first = cleaned.split('\n').map((l) => l.trim()).find((l) => l.includes('ID'));
  assert.match(first, /^1:\s+ID\s+= pool_2$/, `첫 데이터 줄: ${JSON.stringify(first)}`);
});

test('★★ 그 출력이 실제로 파싱된다 — v2.543 까지는 레코드 0건이었다', () => {
  const recs = parseUemcli(stripUemcliBanner(fixture('uemcli-prompt-inline-2544.txt')));
  assert.equal(recs.length, 1, `레코드 ${recs.length}건`);
  assert.equal(recs[0].ID, 'pool_2');
  const pools = parsePools(stripUemcliBanner(fixture('uemcli-prompt-inline-2544.txt')));
  assert.equal(pools.length, 1);
  assert.equal(pools[0].totalBytes, 117461986836480, '실장비 수치 그대로여야 한다');
});

test('★★ 스냅샷이 정상으로 나온다 — 성공인데 오류라고 말하지 않는다', () => {
  const out = { poolDetail: stripUemcliBanner(fixture('uemcli-prompt-inline-2544.txt')) };
  const snap = buildSnapshot(DEV, out, { errors: {}, usedCmds: {} });
  assert.equal(snap.sections.pools, 'ok', `pools=${snap.sections.pools}`);
  assert.ok(snap.ok, '수집 성공이어야 한다');
  assert.equal(snap.capacity.totalBytes, 117461986836480);
});

test('★★ 풀이 2개면 첫 풀을 잃지 않는다 — 조용히 과소 보고되던 경로', () => {
  const two = [
    'Please input your selection (The default selection is [1]): 1:    ID = pool_1',
    '      Total space = 100000000000 (100G)',
    '2:    ID = pool_2',
    '      Total space = 200000000000 (200G)',
  ].join('\n');
  const recs = parseUemcli(stripUemcliBanner(two));
  assert.equal(recs.length, 2, `레코드 ${recs.length}건 — 첫 풀이 사라지면 용량이 과소 보고된다`);
  assert.deepEqual(recs.map((r) => r.ID), ['pool_1', 'pool_2']);
});

// ── ② 레코드 번호가 아예 없어도 값을 잃지 않는다(방어) ────────────────────────

test('레코드 번호가 없으면 키 반복으로 경계를 잡는다 — 여러 레코드를 합치지 않는다', () => {
  const noMark = [
    'Storage system address: 127.0.0.1',
    'HTTPS connection',
    'ID   = pool_1',
    '  Total space = 100 (0.1T)',
    'ID   = pool_2',
    '  Total space = 200 (0.2T)',
  ].join('\n');
  const recs = parseUemcli(noMark);
  assert.equal(recs.length, 2, '합치면 뒤 값이 앞 값을 덮어써 오류 없이 틀린 값이 된다');
  assert.deepEqual(recs.map((r) => r.ID), ['pool_1', 'pool_2']);
});

test('배너만 있으면 여전히 빈 배열이다 — 없는 장비를 만들지 않는다', () => {
  assert.deepEqual(parseUemcli('Storage system address: 127.0.0.1\nHTTPS connection'), []);
});

// ── ③ 버전 수집 ──────────────────────────────────────────────────────────────

test('★ svc_diag 실제 출력에서 모델·버전·시리얼을 읽는다', () => {
  const v = versionFromSvcDiag(fixture('svc-diag-basic-2544.txt'));
  assert.equal(v.version, '5.4.0.0.5.094');
  assert.equal(v.versionRaw, 'c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL');
  assert.equal(v.model, 'Unity 480F');
  assert.equal(v.serial, 'SYNTH0000000000');
  assert.equal(v.source, 'svc_diag');
});

test('★ 빌드 문자열에서 점 버전만 뽑되, 못 찾으면 원문을 그대로 쓴다', () => {
  assert.equal(shortVersion('c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL'), '5.4.0.0.5.094');
  assert.equal(shortVersion('5.3.0.0.5.120'), '5.3.0.0.5.120');
  // 점 구간이 3개 미만인 조각을 버전이라 말하지 않는다
  assert.equal(shortVersion('Unity 480F'), 'Unity 480F');
  assert.equal(shortVersion(''), '');
  assert.equal(shortVersion(null), '');
});

test('★ uemcli 쪽은 후보 키 체인으로 읽고 어느 키를 썼는지 남긴다(실장비 미확인이라)', () => {
  const recs = [{ Model: 'Unity 480F', 'System version': '5.4.0.0.5.094', 'Product serial number': 'SYN1' }];
  const v = versionFromUemcli(recs);
  assert.equal(v.version, '5.4.0.0.5.094');
  assert.equal(v.usedKey, 'System version');
  assert.equal(v.model, 'Unity 480F');
  assert.equal(v.source, 'uemcli');
  // 아무 키도 없으면 지어내지 않는다
  const none = versionFromUemcli([{ 'Total space': '100' }]);
  assert.equal(none.version, '');
  assert.equal(none.source, null);
});

test('두 출처를 합치되 덮어쓰지 않는다 — 앞 출처가 채운 것은 그대로', () => {
  const m = mergeVersionInfo(
    { version: '', versionRaw: '', model: 'Unity 480F', serial: '', source: 'uemcli', usedKey: 'Model' },
    versionFromSvcDiag(fixture('svc-diag-basic-2544.txt')),
  );
  assert.equal(m.model, 'Unity 480F');
  assert.equal(m.version, '5.4.0.0.5.094');
  assert.deepEqual(m.sources, ['uemcli', 'svc_diag']);
});

test('★ 스냅샷에 버전·모델·시리얼이 실린다 — 표의 버전 열 원천은 snap.version 이다', () => {
  const snap = buildSnapshot(DEV, { version: fixture('svc-diag-basic-2544.txt') }, { errors: {}, usedCmds: {} });
  assert.equal(snap.version, '5.4.0.0.5.094');
  assert.equal(snap.serial, 'SYNTH0000000000');
  assert.equal(snap.extra.model, 'Unity 480F');
  assert.equal(snap.extra.versionRaw, 'c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL', '원문을 버리지 않는다');
  assert.equal(snap.extra.versionSource, 'svc_diag');
});

test('★ 버전을 못 읽어도 용량·상태는 그대로다 — 버전은 required 가 아니다', () => {
  const vspec = SPECS.find((s) => s.key === 'version');
  assert.ok(vspec, 'version 항목이 있어야 한다');
  assert.ok(!vspec.required, '버전 실패가 장비 전체 실패가 되면 안 된다');
  const snap = buildSnapshot(DEV, { poolDetail: stripUemcliBanner(fixture('uemcli-prompt-inline-2544.txt')) },
    { errors: { version: '명령이 없습니다' }, usedCmds: {} });
  assert.ok(snap.ok, '버전이 없어도 수집은 성공이다');
  assert.equal(snap.version, '', '읽지 못하면 빈 문자열 — 지어내지 않는다');
  assert.match(snap.extra.missingCmds.version, /명령이 없습니다/, '왜 없는지 사유를 전한다');
});

test('픽스처에 실제 운영 식별자를 넣지 않는다(공개 저장소 — v2.513 규약)', () => {
  for (const f of ['uemcli-prompt-inline-2544.txt', 'svc-diag-basic-2544.txt']) {
    const t = fixture(f);
    assert.ok(/SYNTH/.test(t), `${f}: 합성 식별자 접두가 없다`);
    assert.ok(!/DE40320|10\.94\.41\./.test(t), `${f}: 실장비 식별자가 들어갔다`);
  }
});
