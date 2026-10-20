/**
 * v2.744 감사 GH 회귀 — DEV-03 · RECENT-04 · DEV-02 · INJPKG-02 · DB-02.
 *
 *  DEV-03     svcmon NTP 점검이 응답의 LI·mode·stratum 을 보지 않아, 상위 동기를 잃은 서버(LI=3·stratum 16)를 '정상 · 오프셋 0ms' 로,
 *             KoD(stratum 0 · 송신 타임스탬프 0)를 '오프셋 −4조 ms' 로, 요청을 그대로 되돌린 응답(mode 3)을 '정상' 으로 보고했다.
 *             가짜 NTP 서버(127.0.0.1 UDP)에 실제 runCheck·ntpQuery 를 붙여 고정한다.
 *  RECENT-04  v2.743 이 장형 BER 을 읽게 되며 AD 의 resultCode 8(strongerAuthRequired)·53(unwillingToPerform)이 처음 정확히 읽혔는데
 *             그것을 'bad' 로 두면 48·49 를 '살아 있음' 으로 보는 liveness 설계와 어긋난다 — 8·53 은 정책 거부 응답(ok), 51·52·그 밖은 bad.
 *  DEV-02     SAN 스위치 팬·PSU 그룹 파트가 fault 여도 라벨이 '팬 3/4 정상' 이었고, 알림 제목은 한글 종류명에서 \b 가 맞지 않아 '팬 팬 3/4 정상'.
 *  INJPKG-02  Unity svc_diag -s spinfo 파서의 제목 정규식(양끝 탐욕 _{2,} + 게으른 (.+?))이 긴 밑줄 줄에서 재앙적 역추적.
 *             같은 파일의 '공백 + 값' 정규식 셋도 값 앞 공백 뒤 외로운 \r 에서 (공백 × 줄 길이)였다 — 전부 선형 함수로 바꾸고
 *             옛 정규식과 결과가 같음을 무작위 입력·실제 픽스처로 대조한다. 시간 비교는 옛 정규식 대비 **비율**이다(v2.611 — 절대 시간 금지).
 *  DB-02      AI 자연어 검색 정렬이 비교마다 옵션 객체를 넘기는 localeCompare 를 불러 6,000개 정렬에 약 0.4초 — 공유 Intl.Collator.
 *
 * 무작위 입력은 고정 시드 PRNG 로 만든다(결정적). 큰 배열을 assert.equal 의 actual 로 넘기지 않는다(isDeepStrictEqual + assert.ok).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import url from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744h-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_WORKER = '0';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

// ⚠ 동적 import 는 전부 첫 test() 등록 앞에 둔다(audit2743l 머리말 — 이름 필터 실행에서 after 가 먼저 돌지 않게).
//   모듈 이름공간으로 받는다 — 새 export 가 없는 판본(감사 기준 커밋)에서 파일 전체가 링크 오류로 죽지 않고 항목별로 실패하게.
const ck = await import('../src/svcmon/checker.js');
const { extractSanSwitchParts } = await import('../src/partfault/extract/sanswitch.js');
const { alertOf } = await import('../src/partfault/notify.js');
const sd = await import('../src/storage/collectors/svcDiag.js');
const { nlSortCompare } = await import('../src/llm/nlSearch.js');

/** 고정 시드 PRNG(LCG) — 결정적 무작위 입력. */
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 1) / 0x7fffffff; };
}
const LS = String.fromCharCode(0x2028);   // 줄 구분자(U+2028) — 정규식 '.' 이 맞추지 않는 글자
const NBSP = String.fromCharCode(0xa0);
const timeIt = (fn, reps = 1) => { const t0 = performance.now(); for (let i = 0; i < reps; i++) fn(); return performance.now() - t0; };

// ───────────────────────────── DEV-03 NTP ─────────────────────────────

const NTP_EPOCH = 2208988800;
/** 응답 48바이트. originate 는 요청의 송신 타임스탬프(40~47)를 되돌린다(RFC 4330 §5) — echo:false 면 0. */
function ntpReply(req, { li = 0, mode = 4, stratum = 2, refid = '', tx = 'now', echo = true } = {}) {
  const r = Buffer.alloc(48);
  r[0] = ((li & 3) << 6) | (4 << 3) | (mode & 7);
  r[1] = stratum;
  if (refid) r.write(refid, 12, 'latin1');
  if (echo) req.copy(r, 24, 40, 48);
  if (tx === 'now') {
    const now = Date.now() / 1000 + NTP_EPOCH;
    r.writeUInt32BE(Math.floor(now) >>> 0, 40);
    r.writeUInt32BE(Math.floor((now % 1) * 2 ** 32) >>> 0, 44);
  }
  return r;
}
const NTP_MODES = {
  normal: (q) => [ntpReply(q)],
  unsync: (q) => [ntpReply(q, { li: 3, stratum: 16 })],       // ntpd 가 상위 동기를 잃었을 때 — 로컬 시계로 계속 응답한다
  stratum16: (q) => [ntpReply(q, { li: 0, stratum: 16 })],
  li3: (q) => [ntpReply(q, { li: 3, stratum: 2 })],
  kod: (q) => [ntpReply(q, { li: 3, stratum: 0, refid: 'RATE', tx: 'zero' })],
  mode3: (q) => [Buffer.from(q)],                              // 요청을 그대로 되돌리는 장비(에코)
  tx0: (q) => [ntpReply(q, { tx: 'zero' })],
  mismatchThenOk: (q) => [ntpReply(q, { echo: false }), ntpReply(q)],
  mismatchOnly: (q) => [ntpReply(q, { echo: false })],
};
let ntpMode = 'normal';
const ntpSrv = dgram.createSocket('udp4');
ntpSrv.on('message', (q, rinfo) => { for (const r of NTP_MODES[ntpMode](q)) ntpSrv.send(r, rinfo.port, rinfo.address); });
await new Promise((ok) => ntpSrv.bind(0, '127.0.0.1', ok));
const NTP_PORT = ntpSrv.address().port;
// runCheck 의 NTP 는 표준 포트(123)만 쓴다 — 127.0.0.1:123 으로 가는 요청만 가짜 서버로 돌린다.
const origSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function patchedSend(buf, ...args) {
  if (args[0] === 123 && args[1] === '127.0.0.1') args[0] = NTP_PORT;
  return origSend.call(this, buf, ...args);
};
after(() => { dgram.Socket.prototype.send = origSend; try { ntpSrv.close(); } catch { /* noop */ } });
async function ntpCheck(mode) { ntpMode = mode; return ck.runCheck({ type: 'ntp', server: '127.0.0.1' }, '127.0.0.1'); }

test('DEV-03 ① 정상 응답(mode 4 · stratum 2 · 원본 타임스탬프 일치)은 오프셋으로 판정한다', async () => {
  const r = await ntpCheck('normal');
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.match(r.reply, /^오프셋 -?\d+ms$/);
});

test('DEV-03 ② 미동기 서버(LI=3 · stratum 16)는 오프셋이 맞아도 bad — "서버가 동기되지 않았습니다"', async () => {
  for (const m of ['unsync', 'stratum16', 'li3']) {
    const r = await ntpCheck(m);
    assert.equal(r.status, 'bad', `${m}: ${JSON.stringify(r)}`);
    assert.match(r.reply, /서버가 동기되지 않았습니다\(stratum \d+ · LI \d\)/, m);
    assert.doesNotMatch(r.reply, /오프셋/, m);
  }
});

test('DEV-03 ③ KoD(stratum 0 · refid RATE · 타임스탬프 0)는 KoD 로 말한다 — 1900년 기준 오프셋을 쓰지 않는다', async () => {
  const r = await ntpCheck('kod');
  assert.equal(r.status, 'bad', JSON.stringify(r));
  assert.match(r.reply, /KoD\(RATE\)/);
  assert.doesNotMatch(r.reply, /오프셋/);
});

test('DEV-03 ④ 서버 응답이 아닌 것(mode 3 에코)·송신 타임스탬프 0 은 형식 오류다', async () => {
  const m3 = await ntpCheck('mode3');
  assert.equal(m3.status, 'bad', JSON.stringify(m3));
  assert.match(m3.reply, /NTP 응답 형식 오류\(mode 3/);
  const t0 = await ntpCheck('tx0');
  assert.equal(t0.status, 'bad', JSON.stringify(t0));
  assert.match(t0.reply, /송신 타임스탬프 0/);
});

test('DEV-03 ⑤ 원본 타임스탬프가 다른 패킷은 버리고 기다린다 — 맞는 응답이 오면 판정, 안 오면 그 사실을 사유로', async () => {
  assert.equal(typeof ck.ntpQuery, 'function', 'ntpQuery(server, timeoutMs, port) 가 있어야 한다');
  ntpMode = 'mismatchThenOk';
  const q = await ck.ntpQuery('127.0.0.1', 1500, NTP_PORT);
  assert.equal(q.kind, 'ok', JSON.stringify(q));
  assert.ok(Math.abs(q.offset) < 1000, JSON.stringify(q));
  ntpMode = 'mismatchOnly';
  await assert.rejects(ck.ntpQuery('127.0.0.1', 300, NTP_PORT), /원본 타임스탬프 불일치/);
});

test('DEV-03 ⑥ judgeNtpReply(순수) — 판정 순서 길이 → mode → KoD → 원본 대조 → 미동기 → 송신 0', () => {
  assert.equal(typeof ck.judgeNtpReply, 'function');
  const req = Buffer.alloc(48); req.writeUInt32BE(0x11223344, 40); req.writeUInt32BE(0x55667788, 44);
  const sent = req.subarray(40, 48);
  assert.equal(ck.judgeNtpReply(Buffer.alloc(20), sent).kind, 'format');
  assert.equal(ck.judgeNtpReply(Buffer.from(req), sent).kind, 'format');                         // mode 0
  // v2.744(회귀 검토 GH-R1): KoD 결과에 refused(거부 코드 RATE·DENY·RSTR 인가)가 붙었다 — 이 두 입력은 거부 코드가 아니다(audit2744rg ①).
  assert.deepEqual(ck.judgeNtpReply(ntpReply(req, { stratum: 0, refid: 'R\x01TE', tx: 'zero' }), sent), { kind: 'kod', code: 'RTE', refused: false });
  assert.deepEqual(ck.judgeNtpReply(ntpReply(req, { stratum: 0, tx: 'zero' }), sent), { kind: 'kod', code: '코드 없음', refused: false });
  assert.equal(ck.judgeNtpReply(ntpReply(req, { echo: false }), sent).kind, 'mismatch');
  assert.equal(ck.judgeNtpReply(ntpReply(req, { echo: false }), null).kind, 'ok');                 // 대조할 값이 없으면 대조하지 않는다
  assert.deepEqual(ck.judgeNtpReply(ntpReply(req, { li: 3, stratum: 16 }), sent), { kind: 'unsync', stratum: 16, li: 3 });
  assert.equal(ck.judgeNtpReply(ntpReply(req, { li: 1, stratum: 3 }), sent).kind, 'ok');          // LI 1(윤초 예고)은 정상
  const okr = ck.judgeNtpReply(ntpReply(req, { stratum: 15 }), sent);
  assert.equal(okr.kind, 'ok');
  assert.ok(Math.abs(okr.serverMs - Date.now()) < 5000);
});

// ───────────────────────────── RECENT-04 LDAP ─────────────────────────────

function ldapServer(chunks) {
  return new Promise((resolve) => {
    const s = net.createServer((c) => {
      c.on('error', () => {});
      c.once('data', () => { for (const ch of chunks) if (!c.destroyed) c.write(ch); });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
async function ldapCheck(rc) {
  // AD 식 장형(0x84 + 4바이트) BindResponse
  const pdu = Buffer.from([0x30, 0x84, 0, 0, 0, 0x10, 0x02, 0x01, 0x01, 0x61, 0x84, 0, 0, 0, 0x07, 0x0a, 0x01, rc, 0x04, 0x00, 0x04, 0x00]);
  const s = await ldapServer([pdu]);
  try { return await ck.runCheck({ type: 'ldap', port: s.address().port }, '127.0.0.1'); }
  finally { await new Promise((r) => s.close(() => r())); }
}

test('RECENT-04 ① ldapBindVerdict — 0 성공 · 48/49 자격증명 거부 · 8/53 정책 거부(살아 있음) · 51/52·그 밖은 실패', () => {
  assert.equal(typeof ck.ldapBindVerdict, 'function');
  const table = { 0: 'ok', 48: 'credentials', 49: 'credentials', 8: 'policy', 53: 'policy', 51: 'bad', 52: 'bad', 1: 'bad', 32: 'bad', 80: 'bad' };
  for (const [code, want] of Object.entries(table)) assert.equal(ck.ldapBindVerdict(Number(code)), want, `resultCode ${code}`);
});

test('RECENT-04 ② 서명 필수 DC 의 정책 거부(8)·익명 금지(53)는 "서버는 응답 중" 으로 ok, 51·52 는 bad', async () => {
  for (const rc of [8, 53]) {
    const r = await ldapCheck(rc);
    assert.equal(r.status, 'ok', `rc ${rc}: ${JSON.stringify(r)}`);
    assert.match(r.reply, new RegExp(`bind 거부\\(정책\\) — 서버는 응답 중 \\(resultCode ${rc}\\)`));
  }
  const inv = await ldapCheck(49);
  assert.equal(inv.status, 'ok', JSON.stringify(inv));
  assert.match(inv.reply, /bind 거부\(자격증명\) — 서버는 응답 중 \(resultCode 49\)/);
  for (const rc of [51, 52]) {
    const r = await ldapCheck(rc);
    assert.equal(r.status, 'bad', `rc ${rc}: ${JSON.stringify(r)}`);
    assert.match(r.reply, new RegExp(`bind 실패 \\(resultCode ${rc}\\)`));
  }
});

// ───────────────────────────── DEV-02 SAN 팬·PSU 라벨 ─────────────────────────────

const SW = { id: 'sw-synth2744', name: 'synth-sw-44', host: '192.0.2.44', agent: 'corp-a' };
const swSnap = (health) => ({ name: 'synth-sw-44', ok: true, ports: { total: 0, list: [], portsScope: 'full', portsOmitted: 0 }, health: { status: 'Online', ...health } });

test('DEV-02 ① ok < total(fault)이면 라벨에 "정상" 이 없다 — 개수만 · ok 일 때만 "정상"', () => {
  const r = extractSanSwitchParts(SW, swSnap({ fans: { ok: 3, total: 4 }, psus: { ok: 1, total: 2, absent: 1 } }));
  const fan = r.parts.find((p) => p.kind === 'fan');
  const psu = r.parts.find((p) => p.kind === 'psu');
  assert.equal(fan.state, 'fault');
  assert.equal(psu.state, 'fault');
  assert.doesNotMatch(fan.label, /정상/, fan.label);
  assert.doesNotMatch(psu.label, /정상/, psu.label);
  assert.equal(fan.label, '팬 3/4');
  assert.equal(psu.label, 'PSU 1/2 · 빈 슬롯 1');
  assert.equal(fan.rawState, '3/4');                                  // 원문 개수는 그대로
  const okr = extractSanSwitchParts(SW, swSnap({ fans: { ok: 4, total: 4 }, psus: { ok: 2, total: 2 } }));
  assert.equal(okr.parts.find((p) => p.kind === 'fan').label, '팬 4/4 정상');
  assert.equal(okr.parts.find((p) => p.kind === 'psu').label, 'PSU 2/2 정상');
});

test('DEV-02 ② 알림 제목·"파트:" 줄에 fault 의 "정상" 이 없고, 한글 종류명을 되풀이하지 않는다', () => {
  const r = extractSanSwitchParts(SW, swSnap({ fans: { ok: 3, total: 4 }, psus: { ok: 1, total: 2 } }));
  for (const p of r.parts) {
    const a = alertOf({ ...p, deviceName: SW.name });
    assert.equal(a.severity, 'critical');
    assert.doesNotMatch(a.title, /정상/, a.title);
    const partLine = a.detail.split('\n').find((l) => l.startsWith('파트:'));
    assert.doesNotMatch(partLine, /정상/, partLine);
    assert.doesNotMatch(a.title, /팬 팬|PSU PSU/, a.title);
  }
  const fan = r.parts.find((p) => p.kind === 'fan');
  assert.equal(alertOf({ ...fan, deviceName: SW.name }).title, '파트 장애 — synth-sw-44 · 팬 3/4');
  // 2.744 이전 엣지가 보낸 라벨('팬 3/4 정상' + fault)도 중앙 알림 제목에서는 판정 단어를 뗀다
  const legacy = alertOf({ ...fan, label: '팬 3/4 정상', deviceName: SW.name });
  assert.equal(legacy.title, '파트 장애 — synth-sw-44 · 팬 3/4');
  // 해소 알림(직전 장애 라벨)도 '정상' 을 말하지 않는다 · ok 상태의 라벨은 그대로
  assert.doesNotMatch(alertOf({ ...fan, label: '팬 3/4 정상', deviceName: SW.name }, { closed: true }).title, /정상/);
  assert.equal(alertOf({ ...fan, state: 'ok', label: '팬 4/4 정상', deviceName: SW.name }).title, '파트 장애 — synth-sw-44 · 팬 4/4 정상');
  // 종류명을 담지 않은 라벨에는 종류를 붙인다(예전 동작)
  assert.equal(alertOf({ scope: 'idrac', kind: 'psu', label: '2', state: 'fault', deviceName: 'srv' }).title, '파트 장애 — srv · PSU 2');
});

// ───────────────────────────── INJPKG-02 svc_diag 파서 ─────────────────────────────

// 감사 기준 커밋(9a2ef1c)의 정규식 — 결과 동일성 대조와 시간 비율의 기준(짧은 입력에만 쓴다)
const OLD_HEAD = /^_{2,}\s*(.+?)\s*_{2,}$/;
const OLD_KV = /^([^:]{2,60}?)\s*:\s*(.*)$/;
const OLD_STATUS = /^(\s*)([A-Za-z][\w.\-/]*)\s*:\s*(.*)$/;
const OLD_DEVICE = /^Device:\s*(.+)$/;

function randStr(rnd, alphabet, maxLen) {
  const n = Math.floor(rnd() * maxLen);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
}

test('INJPKG-02 ① 선형 판정 함수 넷이 옛 정규식과 결과가 같다(고정 시드 무작위 입력)', () => {
  for (const fn of ['titledBlockHead', 'fieldKv', 'fruStatusLine', 'deviceLine']) assert.equal(typeof sd[fn], 'function', fn);
  const rnd = prng(2744);
  const A_HEAD = ['_', '_', '_', ' ', 'A', '\r', LS, '\t', 'x', NBSP];
  const A_KV = ['a', 'a', 'a', 'a', 'a', 'b', ' ', ' ', '\t', ':', '\r', LS, NBSP, '_'];
  const A_ST = ['a', 'B', '1', '.', '-', '/', '_', ' ', ' ', '\t', ':', '\r', LS, '(', 'x'];
  let bad = 0; const samples = [];
  const note = (k, s, o, n) => { bad += 1; if (samples.length < 5) samples.push({ k, s, o, n }); };
  for (let i = 0; i < 40_000; i++) {
    const t = randStr(rnd, A_HEAD, 20).trim();
    const m = OLD_HEAD.exec(t);
    const o = m ? m[1].trim() : null;
    const n = sd.titledBlockHead(t);
    if (o !== n) note('head', t, o, n);
  }
  for (let i = 0; i < 40_000; i++) {
    const t = randStr(rnd, A_KV, 100).trim();
    const m = OLD_KV.exec(t);
    const o = m ? { key: m[1].trim(), value: m[2].trim() } : null;
    const n = sd.fieldKv(t);
    if (!isDeepStrictEqual(o, n)) note('kv', t, o, n);
  }
  for (let i = 0; i < 40_000; i++) {
    const raw = randStr(rnd, A_ST, 30);                 // 상태 줄은 원문(앞 공백 포함) 그대로 판정한다
    const m = OLD_STATUS.exec(raw);
    const o = m ? { pad: m[1], name: m[2], rest: m[3].trim() } : null;
    const r = sd.fruStatusLine(raw);
    const n = r ? { pad: r.pad, name: r.name, rest: r.rest.trim() } : null;
    if (!isDeepStrictEqual(o, n)) note('status', raw, o, n);
  }
  for (let i = 0; i < 40_000; i++) {
    const t = ('Device:' + randStr(rnd, [' ', '\t', 'a', 'B', '\r', LS, ':', NBSP], 16)).trim();
    const m = OLD_DEVICE.exec(t);
    const o = m ? m[1].trim() : null;
    const n = sd.deviceLine(t);
    if (o !== n) note('device', t, o, n);
  }
  assert.equal(bad, 0, JSON.stringify(samples));
});

test('INJPKG-02 ② 실제 출력 픽스처의 parseSpinfo 결과가 감사 기준 판본과 같다(sha256)', () => {
  const fx = fs.readFileSync(path.join(HERE, 'fixtures/spinfo-sample.txt'), 'utf8');
  const out = JSON.stringify(sd.parseSpinfo(fx));
  // 9a2ef1c 판본으로 같은 픽스처를 파싱한 JSON 의 sha256(리드 검증 때 git show 로 다시 낼 수 있다)
  assert.equal(crypto.createHash('sha256').update(out).digest('hex'), '90e18e0cc4bca5448d6ad5033247b90c1a4445bbd00905135b692869bf9dbb4b');
  const r = sd.parseSpinfo(fx);
  assert.ok(r.power.supplies.length >= 1, '전원 블록을 읽어야 한다');
});

// 기계 속도와 무관하게 — 옛 정규식이 40ms 를 넘을 때까지 입력을 두 배로 늘린 뒤(최대 4번) 같은 크기로 새 판정을 잰다.
//   v2.746 CI 에서 고정 크기(공백 9,000)의 옛 정규식이 빠른 러너에서 34.5ms 로 나와 하한 40ms 에 걸렸다(새 판정 0.09ms — 개선은 그대로였다).
//   크기를 늘려도 새 판정이 선형인지는 그대로 본다: 같은 크기에서 옛 판정보다 5배 이상 빨라야 한다.
function growUntilSlow(make, oldRun, n0, maxDoublings = 4) {
  let n = n0;
  for (let k = 0; ; k++) {
    const input = make(n);
    const t = timeIt(() => oldRun(input));
    if (t > 40 || k >= maxDoublings) return { input, t, n };
    n *= 2;
  }
}

test('INJPKG-02 ③ 긴 밑줄 줄·긴 공백 + 외로운 \\r 줄에서 선형 — 옛 정규식 대비 비율', () => {
  // 제목 줄: 밑줄 n + 비매칭 꼬리. 옛 정규식은 이 크기에서 수백 ms(측정 800자 약 0.2초) — 새 판정은 parseSpinfo 전체로 잰다.
  const { input: head, t: tOldHead } = growUntilSlow((n) => '_'.repeat(n) + ' x', (s) => OLD_HEAD.exec(s), 800);
  const tNewHead = timeIt(() => sd.parseSpinfo(`Summary of power supply info:\n${head}\n__ SPA PS0 Status __\nInput Power : 330 Watts`), 5) / 5;
  assert.ok(tOldHead > 40 && tOldHead > tNewHead * 5, `제목: 옛 ${tOldHead.toFixed(1)}ms · 새 ${tNewHead.toFixed(2)}ms`);
  // 키:값 줄 — 값 앞 긴 공백 뒤 외로운 \r (옛 정규식은 공백 × 줄 길이)
  const { input: kvLine, t: tOldKv } = growUntilSlow((n) => 'Input Power:' + ' '.repeat(n) + 'a\rb', (s) => OLD_KV.exec(s), 9000);
  const tNewKv = timeIt(() => sd.parseSpinfo(`Summary of power supply info:\n__ SPA PS0 Status __\n${kvLine}`), 5) / 5;
  assert.ok(tOldKv > 40 && tOldKv > tNewKv * 5, `키:값: 옛 ${tOldKv.toFixed(1)}ms · 새 ${tNewKv.toFixed(2)}ms`);
  // FRU 상태 줄 — 같은 꼴
  const { input: stLine, t: tOldSt } = growUntilSlow((n) => '  ps0:' + ' '.repeat(n) + 'OK\r330', (s) => OLD_STATUS.exec(s), 9000);
  const tNewSt = timeIt(() => sd.parseSpinfo(`Displaying all FRU statuses:\n${stLine}\n`), 5) / 5;
  assert.ok(tOldSt > 40 && tOldSt > tNewSt * 5, `상태: 옛 ${tOldSt.toFixed(1)}ms · 새 ${tNewSt.toFixed(2)}ms`);
  // 결과도 옛 판정과 같다(외로운 \r 줄은 맞지 않는다 — 버린다)
  assert.equal(sd.fieldKv(kvLine), null);
  assert.equal(sd.fruStatusLine(stLine), null);
});

// ───────────────────────────── DB-02 정렬 비교기 ─────────────────────────────

test('DB-02 ① nlSortCompare 의 문자열 정렬이 예전 비교기와 같고(6,000개), 옛 비교기 대비 빠르다', () => {
  const rnd = prng(744);
  const pre = ['vm', 'VM', 'app', 'db-', 'web', '서버', 'Ä', 'z'];
  const items = Array.from({ length: 6000 }, (_, i) => ({
    name: `${pre[Math.floor(rnd() * pre.length)]}${Math.floor(rnd() * 3000)}${rnd() < 0.3 ? `-${Math.floor(rnd() * 20)}` : ''}`,
    host: `esx-${Math.floor(rnd() * 200)}.corp`, idx: i,
  }));
  const oldCmp = (field, dir) => (a, b) => String(a[field]).localeCompare(String(b[field]), undefined, { numeric: true }) * dir;
  for (const [field, dir] of [['name', 1], ['name', -1], ['host', 1]]) {
    const want = [...items].sort(oldCmp(field, dir)).map((x) => x.idx);
    const got = [...items].sort(nlSortCompare(field, dir)).map((x) => x.idx);
    assert.ok(isDeepStrictEqual(want, got), `${field}/${dir} 정렬 순서가 예전과 다르다`);
  }
  const tOld = timeIt(() => [...items].sort(oldCmp('name', 1)));
  const tNew = timeIt(() => [...items].sort(nlSortCompare('name', 1)));
  assert.ok(tOld > 40 && tOld > tNew * 4, `옛 ${tOld.toFixed(1)}ms · 새 ${tNew.toFixed(1)}ms`);
});

test('DB-02 ② 정렬 비교기에 옵션 객체를 넘기는 localeCompare 가 남아 있지 않다(소스 — 주석 제거 후)', () => {
  for (const rel of ['llm/nlSearch.js', 'routes/admin/idracCore.js', 'idrac/scan.js', 'central/unsupportedServers.js']) {
    const src = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    assert.doesNotMatch(src, /localeCompare\([^;\n]*numeric/, `${rel}: 공유 Intl.Collator 를 쓸 것`);
    assert.match(src, /new Intl\.Collator\(undefined, \{ numeric: true \}\)/, `${rel}: 모듈 수준 collator`);
  }
});
