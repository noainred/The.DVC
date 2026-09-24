/**
 * test/curUser2520.test.js — '현재 사용자'(v2.520) 회귀 고정.
 *
 * 이 기능의 위험은 **거짓으로 '사용자 0명' 이라고 말하는 것**이다(수집 실패·발행기 미설치·형식
 * 미인식을 0 으로 뭉개는 것). 아래 테스트는 그 경계를 전부 고정한다.
 *
 * ⚠ 기준 시각은 **고정**하고 경계에서 떨어뜨린다(CLAUDE.md v2.517 규칙 — `Date.now()` 를 그대로
 *   기준으로 쓴 테스트가 정시 경계에서 1.67% 확률로 깨진 사고가 있었다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const HOUR = 3_600_000;
/** 정시 -30분 — 항상 과거이고 어느 버킷 경계에서도 30분 떨어져 있다. */
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

/* ─── quser 파서 ───────────────────────────────────────────────────────────── */

const { parseQuser, stateKind, QUSER_CMD } = await import('../src/curuser/quser.js');

test('quser: 연결 끊긴 세션(SESSIONNAME 공백)도 상태를 바르게 읽는다', () => {
  const txt = [
    'USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME',
    '>admin                 console             1  Active      none   9/15/2026 1:00 PM',
    ' oper1                                    2  Disc        5:00   9/15/2026 9:00 AM',
    ' oper2                 rdp-tcp#3          3  Active      .      9/15/2026 10:00 AM',
  ].join('\r\n');
  const r = parseQuser(txt);
  assert.equal(r.parsed, true);
  assert.equal(r.total, 3);
  assert.equal(r.active, 2);
  assert.equal(r.disc, 1, '공백 SESSIONNAME 으로 열이 밀려 Disc 를 놓치면 활성 판정이 통째로 틀린다');
  assert.equal(r.users[0].current, true, '`>` 접두(현재 세션)를 읽어야 한다');
});

test('quser: 세션 0개는 오류가 아니라 0명이다', () => {
  const r = parseQuser('No User exists for *');
  assert.equal(r.parsed, true);
  assert.equal(r.noUsers, true);
  assert.equal(r.total, 0);
});

test('quser: 형식 미인식은 parsed:false 이고 0명이 아니다', () => {
  const r = parseQuser("'quser' is not recognized as an internal or external command");
  assert.equal(r.parsed, false, '읽지 못한 것을 0명이라 말하면 화면이 거짓을 말한다');
  assert.equal(r.noUsers, false);
});

test('quser: 한국어 상태(`활성`·`연결 끊김`)를 읽는다', () => {
  assert.equal(stateKind('활성'), 'active');
  assert.equal(stateKind('연결'), 'disc', '고정폭에서 잘린 `연결` 만으로도 disc 여야 한다');
  assert.equal(stateKind('연결 끊김'), 'disc');
  assert.equal(stateKind('뭔가이상한상태'), 'other', '모르는 상태를 활성에 넣으면 과대표시다');
});

test('quser: 게스트 명령은 UTF-8 강제 + stderr 합류', () => {
  assert.match(QUSER_CMD, /chcp 65001/);
  assert.match(QUSER_CMD, /2>&1/);
});

/* ─── 고유 사용자 집계(사용자 규칙) ─────────────────────────────────────────── */

const { aggregate, aggregateAll, userKey, seriesRow } = await import('../src/curuser/aggregate.js');

test('집계: 같은 계정이 한 법인의 여러 서버에 있으면 1명이다', () => {
  const recs = [
    { vmId: 'a', vcenterId: 'vc1', ok: true, users: [{ name: 'aaa', kind: 'active' }] },
    { vmId: 'b', vcenterId: 'vc1', ok: true, users: [{ name: 'AAA', kind: 'active' }] },
    { vmId: 'c', vcenterId: 'vc1', ok: true, users: [{ name: 'aaa', kind: 'disc' }] },
  ];
  const r = aggregate(recs);
  assert.equal(r.users, 1, '사용자 지시: "aaa 가 1개의 vcenter 의 여러 서버에 로그인해 있으면 1명"');
  assert.equal(r.sessions, 3, '세션 수는 그대로 3이다(둘을 혼동하면 안 된다)');
  assert.equal(r.names[0].vms.length, 3);
  assert.equal(userKey(' AAA '), 'aaa');
});

test('집계: 전체 합집합과 법인별 합을 **둘 다** 낸다', () => {
  const recs = [
    { vmId: 'a', vcenterId: 'vc1', ok: true, users: [{ name: 'aaa', kind: 'active' }, { name: 'bbb', kind: 'active' }] },
    { vmId: 'b', vcenterId: 'vc2', ok: true, users: [{ name: 'aaa', kind: 'active' }, { name: 'ccc', kind: 'active' }] },
  ];
  const r = aggregateAll(recs);
  assert.equal(r.total.usersUnion, 3, 'aaa 는 두 법인에 있어도 전체로는 1명');
  assert.equal(r.total.usersByVcSum, 4, '법인별 합은 4 — 이 차이 자체가 사용자가 알아야 할 정보다');
});

test('집계: 수집 실패 레코드의 사용자는 세지 않고 실패로 센다', () => {
  const r = aggregate([
    { vmId: 'a', vcenterId: 'vc1', ok: true, users: [{ name: 'aaa', kind: 'active' }] },
    { vmId: 'b', vcenterId: 'vc1', ok: false, users: [{ name: 'zzz', kind: 'active' }] },
  ]);
  assert.equal(r.users, 1);
  assert.equal(r.vmsFailed, 1);
});

test('집계: 시계열 행에 계정명을 싣지 않는다(개인정보 장기보존 금지)', () => {
  const row = seriesRow(aggregate([{ vmId: 'a', vcenterId: 'vc1', ok: true, users: [{ name: 'aaa', kind: 'active' }] }]));
  assert.deepEqual(Object.keys(row).filter((k) => /name/i.test(k)), []);
});

/* ─── 대상 해석 ────────────────────────────────────────────────────────────── */

const { resolveTargets, isUnder, normFolder, SKIP_REASON } = await import('../src/curuser/scope.js');
const { normalize, staleAfterMs, LIMITS } = await import('../src/curuser/settings.js');

const S = (over = {}) => normalize({
  enabled: true,
  vcenters: { vc1: { enabled: true, folders: ['/DC/vm/Prod'], includeSubfolders: true } },
  ...over,
});

test('대상: 폴더 경로 정규화(구분자·대소문자·공백)', () => {
  assert.equal(normFolder('\\DC\\vm\\Prod\\WEB '), '/dc/vm/prod/web');
  assert.ok(isUnder('/DC/vm/Prod/WEB', '/dc/vm/prod'));
  assert.ok(!isUnder('/DC/vm/Production', '/DC/vm/Prod'), '경계를 슬래시로 봐야 /a/bc 가 /a/b 에 걸리지 않는다');
});

test('대상: Windows·전원·Tools·템플릿 조건과 그 사유', () => {
  const vms = [
    { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'W1', folder: '/DC/vm/Prod/WEB', guestOS: 'Microsoft Windows Server 2019', powerState: 'POWERED_ON', toolsRunningStatus: 'guestToolsRunning' },
    { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'L1', folder: '/DC/vm/Prod', guestOS: 'Rocky Linux 9', powerState: 'POWERED_ON', toolsRunningStatus: 'guestToolsRunning' },
    { id: 'vc1:vm-3', vcenterId: 'vc1', name: 'W-off', folder: '/DC/vm/Prod', guestOS: 'Microsoft Windows 11', powerState: 'POWERED_OFF', toolsRunningStatus: 'guestToolsNotRunning' },
    { id: 'vc1:vm-4', vcenterId: 'vc1', name: 'W-notools', folder: '/DC/vm/Prod', guestOS: 'Microsoft Windows Server 2022', powerState: 'POWERED_ON', toolsRunningStatus: 'guestToolsNotRunning' },
    { id: 'vc2:vm-9', vcenterId: 'vc2', name: 'OutOfScope', folder: '/DC/vm/Prod', guestOS: 'Microsoft Windows Server 2022', powerState: 'POWERED_ON', toolsRunningStatus: 'guestToolsRunning' },
  ];
  const r = resolveTargets(vms, S());
  assert.deepEqual(r.targets.map((t) => t.name), ['W1']);
  const by = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
  assert.equal(by.L1, 'not-windows');
  assert.equal(by['W-off'], 'powered-off');
  assert.equal(by['W-notools'], 'no-tools', '`guestToolsNotRunning` 안의 Running 에 매치되면 Tools 없는 VM 이 매 주기 실패한다');
  assert.ok(!('OutOfScope' in by), '범위 밖 법인은 제외 목록에도 넣지 않는다(애초에 대상이 아니다)');
  for (const s of r.skipped) assert.ok(SKIP_REASON[s.reason], `사유 문구가 없다: ${s.reason}`);
});

test('대상: 폴더가 비어 있으면 전체로 확대하지 않는다', () => {
  const vms = [{ id: 'vc1:vm-1', vcenterId: 'vc1', folder: '/DC/vm/Prod', guestOS: 'Windows', powerState: 'POWERED_ON', toolsRunningStatus: 'guestToolsRunning' }];
  const r = resolveTargets(vms, S({ vcenters: { vc1: { enabled: true, folders: [] } } }));
  assert.equal(r.targets.length, 0, '5,850 VM 에 확대되면 사고다');
});

test('대상: 상한 초과분은 개수를 밝힌다(조용한 상한 금지)', () => {
  const vms = Array.from({ length: 5 }, (_, i) => ({ id: `vc1:vm-${i}`, vcenterId: 'vc1', folder: '/DC/vm/Prod', guestOS: 'Windows', powerState: 'POWERED_ON', toolsRunningStatus: 'guestToolsRunning' }));
  const r = resolveTargets(vms, S({ maxVms: 3 }));
  assert.equal(r.targets.length, 3);
  assert.equal(r.overLimit, 2);
  assert.equal(r.skipped.filter((s) => s.reason === 'over-limit').length, 2);
});

test('설정: 주기 두 개는 독립이고 신선도는 **발행 주기** 기준이다', () => {
  const s = normalize({ intervalMs: 10 * 60_000, guestPublishMs: 30 * 60_000, staleFactor: 3 });
  assert.equal(staleAfterMs(s), 90 * 60_000, '포탈 조회 주기를 바꾼다고 전 서버가 오래됨으로 뒤바뀌면 안 된다');
  assert.equal(normalize({}).intervalMs, LIMITS.intervalMs.def);
  assert.equal(normalize({}).intervalMs, 10 * 60_000, '사용자 지시: 10분마다');
  assert.equal(normalize({}).enabled, false, '기본은 꺼짐(opt-in)');
});

test('설정: 자격증명 필드를 두지 않는다(게스트 계정 없이 동작)', () => {
  const s = normalize({ password: 'x', username: 'y', vcenters: { vc1: { password: 'z', enabled: true, folders: ['/a'] } } });
  assert.equal(JSON.stringify(s).includes('password'), false);
  assert.equal(JSON.stringify(s).includes('username'), false);
});

/* ─── guestinfo 읽기(핵심 경로) ──────────────────────────────────────────── */

const { parseExtraConfig, readGuestInfo, PREFIX, KIND_LABEL } = await import('../src/curuser/guestinfoSource.js');

const quserText = [
  'USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME',
  '>svc                   console             1  Active      none   9/15/2026 1:00 PM',
  ' oper1                                    2  Disc        5:00   9/15/2026 9:00 AM',
].join('\r\n');
const b64 = Buffer.from(quserText, 'utf8').toString('base64');
const mapOf = (o) => new Map(Object.entries(o).map(([k, v]) => [PREFIX + k, v]));

test('guestinfo: extraConfig XML 에서 우리 접두만 읽는다', () => {
  const xml = '<OptionValue xsi:type="OptionValue"><key>nvram</key><value xsi:type="xsd:string">x.nvram</value></OptionValue>'
    + '<OptionValue xsi:type="OptionValue"><key>guestinfo.curuser.n</key><value xsi:type="xsd:string">1</value></OptionValue>';
  const m = parseExtraConfig(xml);
  assert.equal(m.size, 1, 'VM 하나의 extraConfig 는 수십 키다 — 전부 담으면 메모리·직렬화 낭비');
  assert.equal(m.get('guestinfo.curuser.n'), '1');
});

test('guestinfo: 정상 경로는 세션을 읽고 ok', () => {
  const r = readGuestInfo(mapOf({ v: '1', n: '1', d0: b64, at: String(Math.floor((NOW - 60_000) / 1000)), host: 'WIN-A' }), { now: NOW, staleAfterMs: 30 * 60_000 });
  assert.equal(r.kind, 'ok');
  assert.equal(r.ok, true);
  assert.equal(r.sessions, 2);
  assert.equal(r.active, 1);
  assert.equal(r.disc, 1);
  assert.deepEqual(r.users.map((u) => u.name), ['svc', 'oper1']);
  assert.equal(r.guestHost, 'WIN-A');
});

test('guestinfo: 키가 하나도 없으면 no-agent 이고 0명이 아니다', () => {
  const r = readGuestInfo(new Map(), { now: NOW });
  assert.equal(r.kind, 'no-agent');
  assert.equal(r.sessions, null, '0 으로 채우면 사용자 0명이라는 거짓이 된다');
  assert.equal(r.ok, false);
});

test('guestinfo: 오래된 발행은 stale, 미래 발행은 clock-skew', () => {
  const stale = readGuestInfo(mapOf({ v: '1', n: '1', d0: b64, at: String(Math.floor((NOW - 5 * HOUR) / 1000)) }), { now: NOW, staleAfterMs: 30 * 60_000 });
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.ok, false);
  assert.equal(stale.sessions, 2, '값은 읽었으니 화면이 "언제 값" 인지 말할 수 있어야 한다');
  const skew = readGuestInfo(mapOf({ v: '1', n: '1', d0: b64, at: String(Math.floor((NOW + HOUR) / 1000)) }), { now: NOW });
  assert.equal(skew.kind, 'clock-skew');
});

test('guestinfo: 게스트 오류가 형식 미인식보다 먼저다', () => {
  const r = readGuestInfo(mapOf({ v: '1', err: 'quser produced no output', n: '0' }), { now: NOW });
  assert.equal(r.kind, 'guest-error');
  assert.match(r.error, /quser/);
});

test('guestinfo: 빈 값 규약 `-` 를 되돌린다', () => {
  const r = readGuestInfo(mapOf({ v: '1', n: '1', d0: b64, err: '-', host: '-', at: String(Math.floor((NOW - 60_000) / 1000)) }), { now: NOW });
  assert.equal(r.kind, 'ok', "발행기가 쓰는 '-'(빈 값)을 오류로 읽으면 정상 서버가 전부 실패로 보인다");
  assert.equal(r.guestHost, '');
});

test('guestinfo: 청크가 비면 incomplete(다음 주기에 정상화)', () => {
  const r = readGuestInfo(mapOf({ v: '1', n: '2', d0: b64, at: String(Math.floor(NOW / 1000)) }), { now: NOW });
  assert.equal(r.kind, 'incomplete');
});

test('guestinfo: 형식을 못 읽으면 unparsed(0명이 아니다)', () => {
  const junk = Buffer.from('completely unrelated output', 'utf8').toString('base64');
  const r = readGuestInfo(mapOf({ v: '1', n: '1', d0: junk, at: String(Math.floor(NOW / 1000)) }), { now: NOW });
  assert.equal(r.kind, 'unparsed');
  assert.equal(r.sessions, null);
});

test('guestinfo: 상태마다 사람 문구가 있다', () => {
  for (const k of ['ok', 'stale', 'no-agent', 'guest-error', 'incomplete', 'unparsed', 'clock-skew']) {
    assert.ok(KIND_LABEL[k], `문구 없음: ${k}`);
  }
});

/* ─── 보고서(조회 시점 재판정) ────────────────────────────────────────────── */

const { refreshKinds, buildReport, kindCounts } = await import('../src/curuser/report.js');

test('보고서: 엣지가 push 를 멈춘 오래된 레코드는 조회 시점에 stale 로 내려간다', () => {
  const recs = [{ vmId: 'a', vcenterId: 'vc1', ts: NOW - 3 * 24 * HOUR, at: NOW - 3 * 24 * HOUR, kind: 'ok', ok: true, sessions: 2, users: [{ name: 'aaa', kind: 'active' }] }];
  const r = refreshKinds(recs, { now: NOW, staleAfterMs: 30 * 60_000 });
  assert.equal(r[0].kind, 'stale', "며칠 전 값이 '정상' 으로 남으면 화면이 거짓을 말한다");
  assert.equal(r[0].ok, false);
});

test('보고서: no-agent 의 원인을 신선도로 덮어쓰지 않는다', () => {
  const r = refreshKinds([{ vmId: 'a', vcenterId: 'vc1', ts: NOW, at: NOW - 5 * HOUR, kind: 'no-agent', ok: false }], { now: NOW, staleAfterMs: 30 * 60_000 });
  assert.equal(r[0].kind, 'no-agent');
});

test('보고서: stale 서버의 사용자는 집계에서 빠지고 그 사실이 수치로 남는다', () => {
  const recs = [
    { vmId: 'a', vcenterId: 'vc1', name: 'A', ts: NOW, at: NOW - 60_000, kind: 'ok', ok: true, sessions: 1, users: [{ name: 'aaa', kind: 'active' }] },
    { vmId: 'b', vcenterId: 'vc1', name: 'B', ts: NOW, at: NOW - 5 * HOUR, kind: 'ok', ok: true, sessions: 1, users: [{ name: 'zzz', kind: 'active' }] },
  ];
  const rep = buildReport(recs, { now: NOW, staleAfterMs: 30 * 60_000 });
  assert.equal(rep.total.users, 1);
  assert.equal(rep.total.vmsFailed, 1, '빠진 대수를 세지 않으면 조용한 제외가 된다');
  assert.equal(rep.kinds.stale, 1);
  assert.deepEqual(kindCounts(rep.records), { ok: 1, stale: 1 });
});

/* ─── 게스트 발행기 스크립트 ─────────────────────────────────────────────── */

const { guestAgentScript, installCommand, isAscii, AGENT_FILE, CHUNK, MAX_CHUNKS } = await import('../src/curuser/agentScript.js');

test('발행기: 스크립트는 ASCII 전용이다(인코딩으로 문법이 깨지지 않게)', () => {
  const s = guestAgentScript({ intervalMinutes: 10 });
  assert.equal(isAscii(s), true);
  assert.equal(AGENT_FILE, 'curuser-agent.ps1', '파일명은 ASCII(v2.519 A/B 실측)');
});

test('발행기: 쓰는 순서가 계약이다 — d* → n → 부가값 → at(마지막)', () => {
  const s = guestAgentScript({});
  const iD = s.indexOf('Set-GuestInfo ("d" + $i)');
  const iN = s.indexOf('Set-GuestInfo "n"');
  const iAt = s.indexOf('Set-GuestInfo "at"');
  assert.ok(iD > 0 && iN > iD, '청크보다 n 이 먼저면 이전 청크를 새 개수로 읽는다');
  assert.ok(iAt > iN, "at 을 먼저 쓰면 '새 시각 + 오래된 데이터' 가 되어 거짓으로 신선해진다");
});

test('발행기: 값에서 줄바꿈·제어문자를 제거하고 길이를 제한한다', () => {
  const s = guestAgentScript({});
  assert.match(s, /-replace "\[\\r\\n\\t\]\+"/, 'info-set 은 "key rest-of-line" 이라 줄바꿈이 값을 자른다');
  assert.match(s, /if \(\$v\.Length -eq 0\) \{ \$v = "-" \}/, '빈 값 규약(`-`)이 읽는 쪽과 맞아야 한다');
});

test('발행기: 포탈 주소·토큰·게스트 계정이 스크립트에 들어가지 않는다', () => {
  const s = guestAgentScript({});
  assert.equal(/https?:\/\//.test(s), false, '이 방식의 이점은 게스트에서 포탈로 나가는 경로가 없다는 것이다');
  assert.equal(/password|token/i.test(s), false);
  assert.match(s, /vmtoolsd/);
  assert.ok(CHUNK * MAX_CHUNKS >= 7000);
  assert.match(installCommand({ intervalMinutes: 10 }), /schtasks \/Create/);
});

/* ─── 엣지 push ───────────────────────────────────────────────────────────── */

const { slimRecord, chunkRecords } = await import('../src/agent/curUserPush.js');

test('push: 원문(raw)을 올리지 않는다(전송량 수십 배)', () => {
  const r = slimRecord({ vmId: 'a', vcenterId: 'vc1', raw: 'x'.repeat(8000), kind: 'ok', ok: true, sessions: 1, users: [{ name: 'aaa', kind: 'active' }] });
  assert.equal('raw' in r, false);
  assert.equal(r.users[0].name, 'aaa');
});

test('push: 청크는 개수와 직렬화 길이를 **둘 다** 본다', () => {
  const many = Array.from({ length: 700 }, (_, i) => ({ vmId: `vm-${i}`, vcenterId: 'vc1', users: [] }));
  const c = chunkRecords(many, 10_000_000, 300);
  assert.equal(c.length, 3, '개수 상한이 안 걸리면 세션 많은 RDS 호스트에서 한 요청이 커진다');
  const big = Array.from({ length: 10 }, (_, i) => ({ vmId: `vm-${i}`, vcenterId: 'vc1', users: Array.from({ length: 200 }, (_, k) => ({ name: `user${k}`, kind: 'active' })) }));
  assert.ok(chunkRecords(big, 20_000, 300).length > 1, '길이 상한이 안 걸리면 413 으로 조용히 소실된다');
});

/* ─── 배선(소스 계약) ────────────────────────────────────────────────────── */

test('배선: 중앙 push 엔드포인트가 BIG_JSON 에 등록돼 있다', () => {
  const idx = read('index.js');
  assert.match(idx, /app\.use\('\/api\/central\/curuser', BIG_JSON\)/,
    'express.json 기본 1MB 는 **해제 후 길이** 라 대상 많은 법인 1곳이 413 → 그 법인 데이터 전량 소실(재시도 대상 아님)');
});

test('배선: push 는 gzip 과 413 로그를 갖는다', () => {
  const p = read('agent/curUserPush.js');
  assert.match(p, /gzip/);
  assert.match(p, /413/);
});

test('배선: 중앙 수신은 agent 소유권을 검사하고 mock 을 막는다', () => {
  const c = read('routes/central.js');
  const seg = c.slice(c.indexOf("centralRouter.post('/curuser'"), c.indexOf("centralRouter.get('/curuser-config'"));
  assert.match(seg, /agentOwnsVcenter/);
  assert.match(seg, /isMockVcenter/);
  assert.match(seg, /_cuLastRec/, '엣지는 주기마다 전 대상을 다시 보낸다 — generatedAt 으로 중복 제거');
});

test('배선: 폴러는 재진입 가드 + 적응형 타이머 + site 위임 건너뜀', () => {
  const p = read('curuser/poller.js');
  assert.match(p, /if \(running\) return/);
  assert.match(p, /startAdaptiveTimer/);
  assert.match(p, /collectMode === 'site'/);
  assert.match(p, /\(\+\+tick % PRUNE_EVERY_RUNS\) === 0/, '`tick++ % N === 0` 은 첫 틱에서 즉시 참이다(v2.453)');
});

test('배선: DB 는 ts 단독 인덱스와 0600 권한을 갖는다', () => {
  const d = read('curuser/db.js');
  assert.match(d, /CREATE INDEX IF NOT EXISTS idx_vc_series_ts ON vc_series \(ts\)/);
  assert.match(d, /chmodSync\(p, 0o600\)/);
  // v2.599 DB2599-02: WAL·NORMAL·busy_timeout 은 util/sqliteOpen.js openSqlite 가 건다(busy_timeout 먼저 — audit2599e 가 고정).
  assert.match(d, /openSqlite\(new DatabaseSync\(p\)\)/);
  assert.match(d, /CURUSER_VM_SERIES/, 'VM 단위 시계열은 연 2,100만행 — 옵트인이어야 한다');
});

test('배선: 메인 인벤토리 수집에 config.extraConfig 를 넣지 않는다(5,850 VM 비용)', () => {
  const s = read('vcenter/soapClient.js');
  assert.equal(s.includes("'config.extraConfig'"), false,
    '전 VM 의 extraConfig 를 매 폴링마다 받으면 고RTT 법인에서 폴링이 무거워진다 — curuser/collect.js 가 대상만 따로 읽는다');
  assert.match(read('curuser/collect.js'), /retrieveManyObjectProps\('VirtualMachine'/);
});

/* ─── DB 왕복 ─────────────────────────────────────────────────────────────── */

test('DB: 적재 → 최신 조회 → 추이 조회', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'curuser-'));
  process.env.CURUSER_DB_PATH = path.join(dir, 'curuser.db');
  const db = await import(`../src/curuser/db.js?t=${Date.now()}`);
  const st = await db.curUserDbStatus();
  if (!st.available) { assert.ok(true, `node:sqlite 없음 — 건너뜀(${st.error})`); return; }
  const ts = NOW;
  const c = await db.commitCurUser({
    ts,
    records: [{ vmId: 'vc1:vm-1', vcenterId: 'vc1', name: 'A', folder: '/DC/vm/Prod', at: ts - 60_000, kind: 'ok', ok: true, active: 1, disc: 0, other: 0, sessions: 1, users: [{ name: 'aaa', kind: 'active' }] }],
    series: [{ vcenterId: 'vc1', users: 1, usersActive: 1, sessions: 1 }, { vcenterId: '', users: 1 }],
    replaceVcenters: ['vc1'],
  });
  assert.equal(c.ok, true);
  const latest = await db.latestRecords('vc1');
  assert.equal(latest.length, 1);
  assert.equal(latest[0].users[0].name, 'aaa');
  const s = await db.seriesRange('', ts - HOUR, ts + HOUR);
  assert.equal(s.available, true);
  assert.equal(s.rows.length, 1);
  assert.ok(s.span.first === ts);
  // prune 스로틀 — 첫 호출은 건너뛴다(기동 첫 틱에 보존 차액을 한 번에 지우지 않게)
  assert.equal((await db.pruneCurUser(180, { every: 6 })).skipped, true);
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CURUSER_DB_PATH;
});
