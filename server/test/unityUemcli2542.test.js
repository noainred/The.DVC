/**
 * test/unityUemcli2542.test.js — Unity(uemcli) 파싱·수집 회귀(v2.542 전면 재작성).
 *
 * ── 사용자 지시(2026-09-17) ────────────────────────────────────────────────────────
 * "지금까지 만든 모든 unity480 파싱 삭제하고 내가 지금 보낸 것에 대한 파싱만 해서 자료 채워줘.
 *  기존에 만들었던 unity480 파싱 자료와 혼합해서 사용하면 더 복잡해진다."
 *
 * 그래서 이 파일이 unity480 파싱의 **유일한** 회귀 기준이다(`unitySsh2525`·`unityUemcli2530`·
 * `unityCapacity2540` 은 삭제했다). 근거는 사용자가 제공한 실장비 출력 3건이고, 픽스처는
 * 식별자만 합성으로 바꾸고 **용량 수치와 괄호 표기는 원본 그대로**다(v2.513 공개 저장소 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseUemcli, parsePools, parseSystemSpace, checkSpaceIdentity, toBytes, toPct, toInt, toYesNo, healthOf,
} from '../src/storage/collectors/uemcliParse.js';
import { buildSnapshot, SPECS } from '../src/storage/collectors/unitySsh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8');
const DETAIL = () => fx('uemcli-pool-detail-2542.txt');
const SYSTEM = () => fx('uemcli-system-show-2542.txt');
const SHORT = () => fx('uemcli-pool-show-2542.txt');
const DEV = { id: 'u1', type: 'unity480', name: 'OC2-unity-02', host: '10.94.41.236' };

/* ── 단위 변환 — 0 을 지어내지 않는 것이 핵심이다 ───────────────────────────────── */

test('toBytes: `117544396521472 (106.9T)` 는 앞의 정수를 쓴다(괄호는 반올림)', () => {
  assert.equal(toBytes('117544396521472 (106.9T)'), 117544396521472);
  assert.equal(toBytes('2400305152 (2.2G)'), 2400305152);
  assert.equal(toBytes('0'), 0);
});

test('toBytes: 빈 값·비숫자는 null 이다 — 0 으로 만들지 않는다', () => {
  for (const v of ['', '   ', null, undefined, 'Idle', 'yes', '1.00:1']) assert.equal(toBytes(v), null, `${v}`);
});

test('toPct / toInt / toYesNo / healthOf', () => {
  assert.equal(toPct('70%'), 70);
  assert.equal(toPct('0%'), 0);
  assert.equal(toPct(''), null);
  assert.equal(toInt('38'), 38);
  assert.equal(toInt(''), null);
  assert.equal(toYesNo('yes'), true);
  assert.equal(toYesNo('no'), false);
  assert.equal(toYesNo(''), null, "모르는 것을 false 라 하지 않는다");
  assert.equal(healthOf('OK (5)'), 'OK');
  assert.equal(healthOf(''), '');
});

/* ── 파서 — 유일한 규칙은 ' = ' 다 ─────────────────────────────────────────────── */

test('★ 배너를 데이터로 읽지 않는다 — 배너는 `: `, 데이터는 ` = ` 다', () => {
  // v2.525 의 실제 결함: CSV 배너에 쉼표 하나가 있어 헤더로 잡혀 '필드 없는 레코드 1건' 이
  // 생기고, 화면에 없는 장비가 있는 것처럼 보였다. ' = ' 규칙은 그것을 구조적으로 막는다.
  assert.equal(parseUemcli('Storage system address: 127.0.0.1\nStorage system port: 443\nHTTPS connection').length, 0);
});

test('★ 값이 빈 키를 버리지 않는다 — `Description =` 는 정보다', () => {
  const r = parseUemcli(DETAIL())[0];
  assert.ok('Description' in r, 'Description 키가 있어야 한다');
  assert.equal(r.Description, '');
  assert.equal(r['Rebalancing progress'], '');
});

test('★ 따옴표·마침표가 든 값을 자르지 않는다', () => {
  const r = parseUemcli(DETAIL())[0];
  assert.equal(r['Health details'], '"The component is operating normally. No action is required."');
});

/* ── pool show -detail — 사용자 실측값을 그대로 고정한다 ─────────────────────────── */

test('★ pool show -detail: 사용자 실측값 전량', () => {
  const p = parsePools(DETAIL());
  assert.equal(p.length, 1, '풀은 1개다(없는 풀을 만들지 않는다 — v2.530 결함)');
  const d = p[0];
  assert.equal(d.name, 'pool_1');
  assert.equal(d.poolType, 'Dynamic');
  assert.equal(d.totalBytes, 117544396521472);       // 106.9T
  assert.equal(d.usedBytes, 29973250195456);         // 27.2T — Current allocation
  assert.equal(d.usedSource, 'device', '장비가 보고한 값임을 밝힌다');
  assert.equal(d.freeBytes, 87568746020864);         // 79.6T
  assert.equal(d.preallocatedBytes, 2400305152);     // 2.2G
  assert.equal(d.subscribedBytes, 55491782770688);   // 50.4T
  assert.equal(d.subscriptionPct, 47);
  assert.equal(d.alertThresholdPct, 70);
  assert.equal(d.flashPct, 100);
  assert.equal(d.raid, '5');
  assert.equal(d.stripeLength, 9);
  assert.equal(d.disks, 38);
  assert.equal(d.drives, '38 x 3.8T SAS Flash 4', '드라이브 표기는 문자열 그대로(38 을 바이트로 읽지 않는다)');
  assert.equal(d.health, 'OK');
  assert.equal(d.rebalancing, false);
  assert.equal(d.allFlash, true);
  assert.equal(d.dataReductionRatio, '1.00:1');
  assert.equal(d.pct, 25.5);
});

/* ── system show ────────────────────────────────────────────────────────────────── */

test('★ system show: 키 이름이 풀과 다르다(Used/Free space)', () => {
  const s = parseSystemSpace(SYSTEM());
  assert.equal(s.totalBytes, 117544396521472);
  assert.equal(s.usedBytes, 29973250195456, '풀의 Current allocation 과 같은 값이다');
  assert.equal(s.freeBytes, 87568746020864);
  assert.equal(s.preallocatedBytes, 2400305152);
  assert.equal(s.dataReductionRatio, '1.00:1');
  assert.equal(s.dataReductionPct, 0);
});

test('★ 항등식 — Total = Used + Free + Preallocated (실측 차이 0)', () => {
  const r = checkSpaceIdentity(parseSystemSpace(SYSTEM()));
  assert.equal(r.checked, true);
  assert.equal(r.ok, true);
  assert.equal(r.diff, 0);
});

test('항등식: 값이 모자라면 검사하지 않는다(어긋났다고 말하지 않는다)', () => {
  const r = checkSpaceIdentity({ totalBytes: 100, usedBytes: null, freeBytes: 50 });
  assert.equal(r.checked, false);
  assert.equal(r.ok, true);
});

test('용량 키가 하나도 없으면 null 이다 — 빈 껍데기를 돌려주지 않는다', () => {
  assert.equal(parseSystemSpace('Storage system port: 443\nHTTPS connection'), null);
  assert.equal(parseSystemSpace('1:  Something else = 3'), null);
});

/* ── 짧은 pool show — Current allocation 이 없다 ─────────────────────────────────── */

test('★ 짧은 pool show 는 사용량을 계산하고 그 사실을 밝힌다', () => {
  const d = parsePools(SHORT())[0];
  assert.equal(d.totalBytes, 117544396521472);
  assert.equal(d.freeBytes, 87568746020864);
  assert.equal(d.usedBytes, 29975650500608, '전체 − 잔여');
  assert.equal(d.usedSource, 'computed');
  // ⚠ 실측: 계산값은 `Current allocation`(29973250195456)보다 Preallocated(2400305152)만큼 크다.
  assert.equal(d.usedBytes - 29973250195456, 2400305152, '차이는 정확히 선할당분이다');
  assert.equal(d.alertThresholdPct, null, '짧은 출력에는 경고 임계가 없다 — 지어내지 않는다');
});

/* ── 스냅샷 조립 ────────────────────────────────────────────────────────────────── */

test('★ 정상 수집: 용량은 풀 합계이고 시스템 값은 대조용이다', () => {
  const snap = buildSnapshot(DEV, { poolDetail: DETAIL(), system: SYSTEM() });
  assert.equal(snap.ok, true);
  assert.equal(snap.sections.pools, 'ok');
  assert.equal(snap.sections.capacity, 'ok');
  assert.equal(snap.capacity.totalBytes, 117544396521472);
  assert.equal(snap.capacity.usedBytes, 29973250195456);
  assert.equal(snap.capacity.pct, 25.5);
  assert.equal(snap.extra.poolsFrom, 'pool show -detail');
  assert.equal(snap.extra.systemSpace.totalBytes, 117544396521472);
  assert.equal(snap.extra.spaceIdentityWarning, undefined, '실측은 항등식이 맞으므로 경고가 없다');
  assert.equal(snap.extra.capacityCrossCheck, undefined, '풀 합계 == 시스템 전체이므로 교차 경고가 없다');
  assert.equal(snap.extra.collectMethod, 'ssh');
});

test('★ 조회하지 않는 섹션을 "오류" 라 하지 않는다 — 0 도 만들지 않는다', () => {
  const snap = buildSnapshot(DEV, { poolDetail: DETAIL(), system: SYSTEM() });
  for (const k of ['nodes', 'accounts', 'alerts']) {
    assert.match(snap.sections[k], /미수집/, `${k}: '오류' 가 아니라 '미수집' 이어야 한다`);
  }
  assert.equal(snap.nodes.count, null, '0 은 "노드 0대" 라는 거짓이다');
  assert.equal(snap.alerts.unresolved, null);
  assert.deepEqual(snap.extra.notCollected, ['nodes', 'accounts', 'alerts']);
});

test('★ 전부 실패하면 용량이 null 이다 — 0 바이트 행을 만들지 않는다(v2.531 규약)', () => {
  const snap = buildSnapshot(DEV, {}, { errors: { poolDetail: '명령 출력이 끊겼습니다(26B 수신)' } });
  assert.equal(snap.ok, false);
  assert.equal(snap.capacity.totalBytes, null);
  assert.equal(snap.capacity.usedBytes, null);
  assert.match(snap.sections.pools, /끊겼습니다/, '사유를 그대로 전한다');
});

test('-detail 이 실패하면 짧은 show 로 폴백하고 계산값임을 밝힌다', () => {
  const snap = buildSnapshot(DEV, { poolShort: SHORT() }, { errors: { poolDetail: '시한 초과' } });
  assert.equal(snap.sections.pools, 'ok');
  assert.match(snap.extra.poolsFrom, /폴백/);
  assert.match(snap.extra.capacityBasisNote, /전체 − 잔여/);
});

test('풀은 못 읽고 시스템 용량만 읽으면 그것을 쓰고 밝힌다', () => {
  const snap = buildSnapshot(DEV, { system: SYSTEM() }, { errors: { poolDetail: '시한 초과' } });
  assert.equal(snap.sections.capacity, 'ok');
  assert.equal(snap.capacity.totalBytes, 117544396521472);
  assert.match(snap.extra.capacityBasisNote, /시스템 전체 용량/);
  assert.match(snap.sections.pools, /오류/, '풀을 못 읽은 사실은 그대로 남는다');
});

test('풀 합계와 시스템 전체가 다르면 교차 경고를 낸다', () => {
  const half = SYSTEM().replace('117544396521472 (106.9T)', '235088793042944 (213.8T)');
  const snap = buildSnapshot(DEV, { poolDetail: DETAIL(), system: half });
  assert.match(snap.extra.capacityCrossCheck, /풀 합계/);
  assert.equal(snap.capacity.totalBytes, 117544396521472, '화면 수치는 풀 합계 기준을 유지한다');
});

/* ── 구조 계약 — 되돌리면 v2.526 회귀가 재발한다 ───────────────────────────────── */

/*
 * ★ v2.544 정정 — **용량·상태 경로는 여전히 3개**다. 버전 항목이 하나 늘었다.
 *
 * v2.542 는 `SPECS.length === 3` 과 `svc_diag` 금지를 고정했다. 그 의도는 두 가지였다:
 *  ① v2.526 의 '명령 26개 → 예산 소진 → 뒤 항목이 시도조차 안 됨' 회귀를 막는다
 *  ② `svc_diag -s spinfo` 를 **이 경로에서 부르지 않는다**(사용자가 준 세 출력에 SP 하드웨어가
 *     없어 파싱할 것이 없었다)
 * v2.544 는 ①을 **더 강하게** 지킨다 — 버전 항목은 `required` 가 아니고 시한이 20초라
 * 예산 가드가 그대로 작동한다(`unitySshBudget2528.test.js` 가 그 산수를 본다).
 * ②는 뜻이 달라졌다: 이번에 부르는 것은 **인자 없는 `svc_diag`(basic state)** 이고,
 * 사용자가 그 출력을 직접 제공했다(모델 `Unity 480F` · 버전 · 시리얼). `-s spinfo` 는 그대로 안 부른다.
 */
test('★ 용량·상태 명령은 3개 그대로이고 CSV 후보가 없다', () => {
  const core = SPECS.filter((s) => s.key !== 'version');
  assert.equal(core.length, 3, `용량·상태 명령이 ${core.length}개다 — 늘리려면 예산 산수를 먼저 할 것`);
  assert.deepEqual(core.flatMap((s) => s.cmds), [
    'uemcli /stor/config/pool show -detail',
    'uemcli /stor/general/system show',
    'uemcli /stor/config/pool show',
  ]);
  const all = SPECS.flatMap((s) => s.cmds);
  assert.ok(!all.some((c) => /-output csv/.test(c)), '이 장비의 CSV 출력은 확인된 적이 없다');
  assert.ok(!all.some((c) => /svc_diag\s+-s/.test(c)), 'svc_diag -s spinfo 는 이 경로에서 부르지 않는다(v2.542)');
});

test('★ 인증서 프롬프트 응답에 파괴적 선택이 없다', () => {
  // `[3] Accept and store` 는 **고객 어레이에 상태를 쓴다** — 절대 고르지 않는다(v2.526 규약).
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'storage', 'collectors', 'unitySsh.js'), 'utf8');
  assert.ok(!/Accept and store/.test(src));
  for (const s of SPECS) assert.ok(s.rules.includes('certAccept'), `${s.key}: 인증서 프롬프트 응답이 필요하다`);
});

test('★ 원문은 주기 수집에서도 전부 싣는다 — 실패분만 싣던 방식으로 되돌리지 말 것', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'storage', 'collectors', 'unitySsh.js'), 'utf8');
  assert.match(src, /snap\.extra\.cliRaw = raw;/);
  assert.match(src, /cliRawMode = 'all'/);
  assert.ok(!/raw\.filter\(\(x\) => !x\.ok\)/.test(src), '실패분만 싣는 옛 방식이 남아 있다');
});
