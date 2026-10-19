/**
 * v2.744 회귀 검토 RG — GH-R1 · GH-R2 (v2.744 수정분 3b7816a 의 회귀 검토가 찾은 것).
 *
 *  GH-R1  svcmon NTP 점검(DEV-03 수정)이 stratum 0 응답을 전부 'KoD — 서버가 요청을 거부했습니다' 로 말했다.
 *         그런데 실제 ntpd 는 첫 동기 전(STRATUM_UNSPEC 16 → 패킷 0 · refid 'INIT')·시계 step 뒤('STEP')에, chronyd 는
 *         미동기일 때(stratum 16 → 0 · refid 0) **정상 응답으로** stratum 0 을 싣는다 — 그래서 DEV-03 이 만든
 *         '서버가 동기되지 않았습니다' 문구는 실서버 응답에서 사실상 나오지 않았고, 운영자는 '요청 거부' 를 보고
 *         restrict·방화벽을 점검하게 된다(실제 원인은 상위 동기 상실 — 조치가 정반대).
 *         근거: ntpd ntp_proto.c kiss_code_check — KoD 는 mode 4 · LI 3 · stratum 0 이면서 refid 가 RATE·DENY·RSTR(그리고 'X'
 *         실험 코드)일 때만이다. 그 밖의 stratum 0(INIT·STEP 등)은 KoD 가 아니다.
 *  GH-R2  INJPKG-02 의 '공백 + 값 + 외로운 \r' O(n²) 꼴(`…:\s*(.+)$`)을 svcDiag.js 에서만 고쳤다 — 같은 꼴이 PDU·Unity uemcli·
 *         SAN FOS 파서에 남아 실제 파서 함수가 3만 자 공백 줄 하나에 0.8~2.3초 멈췄다(장비 출력은 외부 입력 — v2.603 규약).
 *         고친 줄 판정 함수가 옛 정규식과 결과가 같은지(고정 시드 무작위 입력), 파서 전체 결과가 감사 기준 판본과 같은지(sha256),
 *         공격 줄에서 옛 정규식 대비 비율로 빠른지(v2.611 — 절대 시간 금지) 고정한다.
 *
 * 큰 배열을 assert.equal 의 actual 로 넘기지 않는다(isDeepStrictEqual + assert.ok — v2.731 규약).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import url from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744rg-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_WORKER = '0';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

// ⚠ 동적 import 는 첫 test() 등록 앞에 둔다 · 모듈 이름공간으로 받는다(새 export 가 없는 판본에서 파일 전체가 링크 오류로 죽지 않게).
const ck = await import('../src/svcmon/checker.js');
const pdu = await import('../src/pdu/parse.js');
const ue = await import('../src/storage/collectors/uemcliParse.js');
const fos = await import('../src/sanswitch/collectors/fosParse.js');

/** 고정 시드 PRNG(LCG) — 결정적 무작위 입력. */
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 1) / 0x7fffffff; };
}
const timeIt = (fn, reps = 1) => { const t0 = performance.now(); for (let i = 0; i < reps; i++) fn(); return performance.now() - t0; };
const ch = (n) => String.fromCharCode(n);
const LS = ch(0x2028);
const PS = ch(0x2029);
const NBSP = ch(0xa0);

// ───────────────────────────── GH-R1 NTP stratum 0 ─────────────────────────────

const NTP_EPOCH = 2208988800;
/** 응답 48바이트 — originate 는 요청의 송신 타임스탬프를 되돌린다(ntpd fast_xmit·chrony transmit_packet 둘 다). */
function ntpReply(req, { li = 0, stratum = 2, refid = '', refidBytes = null, tx = 'now' } = {}) {
  const r = Buffer.alloc(48);
  r[0] = ((li & 3) << 6) | (4 << 3) | 4;
  r[1] = stratum;
  if (refidBytes) Buffer.from(refidBytes).copy(r, 12);
  else if (refid) r.write(refid, 12, 'latin1');
  req.copy(r, 24, 40, 48);
  if (tx === 'now') {
    const now = Date.now() / 1000 + NTP_EPOCH;
    r.writeUInt32BE(Math.floor(now) >>> 0, 40);
    r.writeUInt32BE(Math.floor((now % 1) * 2 ** 32) >>> 0, 44);
  } else if (tx === 'echo') req.copy(r, 40, 40, 48);   // ntpd 의 RATE KoD 는 org·rec·xmt 를 요청의 xmt 로 채운다
  return r;
}
// 실서버가 실제로 싣는 모양(근거는 머리말) — 합성값 stratum 16 이 아니다.
const NTP_FORMS = {
  ntpdInit: { li: 3, stratum: 0, refid: 'INIT' },            // ntpd 첫 동기 전 — sys_stratum 16 → 패킷 0, refid 'INIT'
  ntpdStep: { li: 3, stratum: 0, refid: 'STEP' },            // ntpd 시계 step 뒤 재동기 전
  chronyUnsync: { li: 3, stratum: 0, refidBytes: [0, 0, 0, 0] },   // chronyd 미동기 — NTP_REFID_UNSYNC 0 · stratum 16 → 0
  rate: { li: 3, stratum: 0, refid: 'RATE', tx: 'echo' },   // ntpd 빈도 제한 KoD
  deny: { li: 3, stratum: 0, refid: 'DENY', tx: 'echo' },
  rstr: { li: 3, stratum: 0, refid: 'RSTR', tx: 'echo' },
  auth: { li: 3, stratum: 0, refid: 'AUTH', tx: 'echo' },   // 원인을 단정할 수 없는 다른 코드
  zeroNoLi: { li: 0, stratum: 0, refidBytes: [0, 0, 0, 0] }, // stratum 0 인데 LI 도 경보가 아니고 코드도 없다
};
let ntpForm = 'ntpdInit';
const ntpSrv = dgram.createSocket('udp4');
ntpSrv.on('message', (q, rinfo) => ntpSrv.send(ntpReply(q, NTP_FORMS[ntpForm]), rinfo.port, rinfo.address));
await new Promise((ok) => ntpSrv.bind(0, '127.0.0.1', ok));
const NTP_PORT = ntpSrv.address().port;
// runCheck 의 NTP 는 표준 포트(123)만 쓴다 — 127.0.0.1:123 으로 가는 요청만 가짜 서버로 돌린다.
const origSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function patchedSend(buf, ...args) {
  if (args[0] === 123 && args[1] === '127.0.0.1') args[0] = NTP_PORT;
  return origSend.call(this, buf, ...args);
};
after(() => { dgram.Socket.prototype.send = origSend; try { ntpSrv.close(); } catch { /* noop */ } });
async function ntpCheck(form) { ntpForm = form; return ck.runCheck({ type: 'ntp', server: '127.0.0.1' }, '127.0.0.1'); }

test('GH-R1 ① judgeNtpReply — stratum 0 은 refid 로 가른다(RATE·DENY·RSTR = 거부 · INIT·STEP·코드 없음+LI 3 = 미동기 · 그 밖 = 중립)', () => {
  const req = Buffer.alloc(48); req.writeUInt32BE(0x11223344, 40); req.writeUInt32BE(0x55667788, 44);
  const sent = req.subarray(40, 48);
  const j = (form) => ck.judgeNtpReply(ntpReply(req, NTP_FORMS[form]), sent);
  assert.deepEqual(j('ntpdInit'), { kind: 'unsync', stratum: 0, li: 3, code: 'INIT' });
  assert.deepEqual(j('ntpdStep'), { kind: 'unsync', stratum: 0, li: 3, code: 'STEP' });
  assert.deepEqual(j('chronyUnsync'), { kind: 'unsync', stratum: 0, li: 3, code: '' });
  assert.deepEqual(j('rate'), { kind: 'kod', code: 'RATE', refused: true });
  assert.deepEqual(j('deny'), { kind: 'kod', code: 'DENY', refused: true });
  assert.deepEqual(j('rstr'), { kind: 'kod', code: 'RSTR', refused: true });
  assert.deepEqual(j('auth'), { kind: 'kod', code: 'AUTH', refused: false });
  assert.deepEqual(j('zeroNoLi'), { kind: 'kod', code: '코드 없음', refused: false });
  // INIT·STEP 은 LI 와 무관하게 '아직 동기 전' 이다(코드 자체가 그 상태의 이름이다)
  assert.equal(ck.judgeNtpReply(ntpReply(req, { li: 0, stratum: 0, refid: 'INIT' }), sent).kind, 'unsync');
  // stratum 16 이상(합성값)은 예전 그대로 — code 키가 없다
  assert.deepEqual(ck.judgeNtpReply(ntpReply(req, { li: 3, stratum: 16 }), sent), { kind: 'unsync', stratum: 16, li: 3 });
});

test('GH-R1 ② 실서버 모양의 미동기 응답은 "요청 거부" 가 아니라 "동기되지 않았습니다" — 거부는 RATE·DENY·RSTR 만', async () => {
  for (const form of ['ntpdInit', 'ntpdStep', 'chronyUnsync']) {
    const r = await ntpCheck(form);
    assert.equal(r.status, 'bad', `${form}: ${JSON.stringify(r)}`);
    assert.match(r.reply, /서버가 동기되지 않았습니다\(stratum 0 · /, form);
    assert.doesNotMatch(r.reply, /거부|KoD/, `${form}: ${r.reply}`);
  }
  assert.match((await ntpCheck('ntpdInit')).reply, /INIT/);
  assert.match((await ntpCheck('ntpdStep')).reply, /STEP/);
  for (const [form, code, why] of [['rate', 'RATE', /요청 빈도 제한/], ['deny', 'DENY', /접근 거부/], ['rstr', 'RSTR', /접근 거부/]]) {
    const r = await ntpCheck(form);
    assert.equal(r.status, 'bad', `${form}: ${JSON.stringify(r)}`);
    assert.match(r.reply, new RegExp(`^KoD\\(${code}\\) — 서버가 요청을 거부했습니다`), r.reply);
    assert.match(r.reply, why, r.reply);
  }
  // 원인을 단정할 수 없는 코드는 '거부' 라 말하지 않는다
  for (const form of ['auth', 'zeroNoLi']) {
    const r = await ntpCheck(form);
    assert.equal(r.status, 'bad', `${form}: ${JSON.stringify(r)}`);
    assert.match(r.reply, /^KoD\(.+\) — 서버가 시각을 주지 않았습니다/, r.reply);
    assert.doesNotMatch(r.reply, /거부/, r.reply);
  }
});

// ───────────────────────────── GH-R2 '공백 + 값 + 외로운 \r' ─────────────────────────────

// 감사 기준 커밋(3b7816a)의 정규식 — 결과 동일성 대조와 시간 비율의 기준(짧은 입력에만 쓴다).
const OLD = {
  pduCode: /^\s*E(\d{3})\s*:\s*(.*)$/,
  pduReading: /^(-?\d+(?:\.\d+)?)\s*(.*)$/,
  ueRecStart: /^(\d+):\s*(.*)$/,
  bottleneck: /^\s*(\d{1,3})\s+(.*\S)\s*$/,
  fabric: /^\s*(?:(>)\s*)?(\d{1,3})\s*:\s*([0-9a-fA-F]{4,6})\s+([0-9a-fA-F:]{20,23})\s+(\S+)(?:\s+(\S+))?\s*(.*)$/,
  temp: /^\s*(\d{1,3})\s+(-?\d{1,3}(?:\.\d+)?)\s*(?:(-?\d{1,3}(?:\.\d+)?)\s*)?([A-Za-z]+)?\s*$/,
};
// fosParse 의 '접두 + \s*(.+)$' 꼴 — [옛 전체 정규식, 접두 예시]
const FOS_TAILS = [
  [/^Chassis\s+Family:\s*(.+)$/i, 'Chassis Family:'],
  [/^Power\s+Source:\s*(.+)$/i, 'Power Source:'],
  [/^PS\s+Voltage\s+input:\s*(.+)$/i, 'PS Voltage input:'],
  [/^Power\s+Usage:\s*(.+)$/i, 'Power  Usage:'],
  [/^(switchName|switchType|switchState|switchMode|switchRole|switchDomain|switchId|switchWwn|zoning|Fabric Name|switchBeacon):\s*(.+)$/i, 'switchName:'],
  [/^Temperature:\s*(.+)$/i, 'Temperature:'],
  [/^Voltage:\s*(.+)$/i, 'Voltage:'],
  [/^Current:\s*(.+)$/i, 'Current:'],
  [/^RX\s*Power:\s*(.+)$/i, 'RX Power:'],
  [/^TX\s*Power:\s*(.+)$/i, 'TXPower:'],
  [/^Vendor\s*Name:\s*(.+)$/i, 'Vendor Name:'],
  [/^Vendor\s*PN:\s*(.+)$/i, 'Vendor PN:'],
  [/^Serial\s*No:\s*(.+)$/i, 'Serial No:'],
  [/^Wavelength:\s*(.+)$/i, 'Wavelength:'],
  [/^(?:Device type|FC4s)\s*:\s*(.+)$/i, 'Device type :'],
  [/^\s*sensor\s+(\d+)\s*:\s*\(([^)]*)\)\s*(.*)$/i, '  sensor 12 : (Fan)'],
];

// 공백(정규식 \s 와 String.trim 이 같은 집합인지까지 대조한다)·줄 끝 문자·값 글자
const WS = [' ', ' ', ' ', '\t', '\r', LS, PS, NBSP, ch(0x3000), ch(0xfeff), ch(0x1680), ch(0x2000), ch(0x202f), '\v', '\f'];
const NOT_WS = [ch(0x180e), ch(0x200b)];           // 공백처럼 보이지만 \s 가 아닌 글자
const VAL = ['a', 'Z', 'Ok', '0', '7', '12', '.', '-', ':', '"', '(', ')', '=', '>', 'x y', '"sw-1"', '31 C', 'ff', '10:00', ...NOT_WS];
function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
/** 접두 뒤에 공백·값·줄 끝 문자를 섞은 꼬리 — 줄 길이는 짧게(옛 정규식이 빠르게 끝나도록). */
function tail(rnd, max = 10) {
  let s = '';
  const n = Math.floor(rnd() * max);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    s += r < 0.45 ? pick(rnd, WS) : pick(rnd, VAL);
  }
  return s;
}
/** 접두를 그대로 두거나 공백·글자를 흩뜨린다(접두가 맞지 않는 줄도 대조 대상이다). */
function smudge(rnd, s) {
  const r = rnd();
  if (r < 0.6) return s;
  if (r < 0.75) return pick(rnd, WS) + s;
  if (r < 0.85) return s.replace(/ /g, () => pick(rnd, WS));
  const i = Math.floor(rnd() * (s.length + 1));
  return s.slice(0, i) + pick(rnd, [...WS, ...VAL]) + s.slice(i);
}
const groups = (m) => (m ? Array.from(m).slice(1) : null);

test('GH-R2 ① 줄 판정 함수가 감사 기준 정규식과 결과가 같다(고정 시드 무작위 입력)', () => {
  for (const f of ['codeLine', 'readingLine']) assert.equal(typeof pdu[f], 'function', `pdu.${f}`);
  assert.equal(typeof ue.recStart, 'function', 'uemcli.recStart');
  for (const f of ['tailMatch', 'bottleneckRow', 'fabricRow', 'tempRow']) assert.equal(typeof fos[f], 'function', `fos.${f}`);
  const rnd = prng(274402);
  const ROUNDS = 4000;
  const cmp = (name, oldRe, fn, mk) => {
    for (let i = 0; i < ROUNDS; i++) {
      const line = mk();
      const want = groups(oldRe.exec(line));
      const got = groups(fn(line));
      if (!isDeepStrictEqual(want, got)) assert.fail(`${name}: ${JSON.stringify(line)} → 옛 ${JSON.stringify(want)} · 새 ${JSON.stringify(got)}`);
    }
  };
  cmp('pdu.codeLine', OLD.pduCode, pdu.codeLine, () => smudge(rnd, pick(rnd, ['E000:', 'E102 :', ' E000:', 'E12:', 'E0000:'])) + tail(rnd));
  cmp('pdu.readingLine', OLD.pduReading, pdu.readingLine, () => smudge(rnd, pick(rnd, ['22.9', '-1.5', '34', '1.98', '1.', '-', '007'])) + tail(rnd));
  cmp('uemcli.recStart', OLD.ueRecStart, ue.recStart, () => smudge(rnd, pick(rnd, ['1:', '12:', '2', ':', '1 :'])) + tail(rnd));
  for (const [re, ex] of FOS_TAILS) {
    // 접두 정규식 = 옛 정규식에서 꼬리 '\s*(.+)$'·'\s*(.*)$' 를 뗀 것 — 소스와 같은 방식으로 만든다.
    const src = re.source.replace(/\\s\*\(\.[*+]\)\$$/, '');
    const plus = /\(\.\+\)\$$/.test(re.source);
    const head = new RegExp(src, re.flags);
    cmp(`fos.tailMatch ${src}`, re, (l) => fos.tailMatch(l, head, plus), () => smudge(rnd, ex) + tail(rnd));
  }
  cmp('fos.bottleneckRow', OLD.bottleneck, fos.bottleneckRow, () => smudge(rnd, pick(rnd, ['  12', '1', '1234', ' 7 x'])) + tail(rnd));
  const FAB = ['  1: fffc01 10:00:00:05:33:00:00:01 10.0.0.1', '>2: fffc02 10:00:00:05:33:00:00:02 10.0.0.2 0.0.0.0', '3 : abcd 10:00:00:05:33:00:00:03'];
  cmp('fos.fabricRow', OLD.fabric, fos.fabricRow, () => smudge(rnd, pick(rnd, FAB)) + tail(rnd, 14));
  const TEMPS = ['  1   31', '2 -1.5', '3 44 111', '4 22.5 72.5', '5 2233', '6 1.'];
  cmp('fos.tempRow', OLD.temp, fos.tempRow, () => smudge(rnd, pick(rnd, TEMPS)) + tail(rnd) + (rnd() < 0.3 ? pick(rnd, ['Ok', ' Warn', '  ', 'C!']) : ''));
});

// 파서 전체 결과 — 감사 기준 판본(수정 전 코드)으로 계산한 sha256. 줄 판정을 바꾸며 다른 동작이 함께 바뀌지 않았음을 고정한다.
const PARSER_CORPUS = {
  'pdu.parseCode': ['E000: Success', 'E102: Parameter Error', 'apc>tempReading 1:C', '22.9 C', ''],
  'pdu.parseReading': ['E000: Success', 'E102: Parameter Error', 'apc>humReading', '22.9 C', '-1.5 C', '34 %RH', '1.98 kW', '2.32', 'x'],
  'ue.parseUemcli': ['1:    ID = pool_1', '      Name = p1', '      Total space = 117544396521472 (106.9T)', '2:    ID = pool_2',
    'Storage system address: 127.0.0.1', '      Description =', 'Please input your selection (The default selection is [1]): 1:    ID = x', '3:'],
  'fos.parseChassisShow': ['Chassis Family: G620', 'FAN  Unit: 1', 'POWER SUPPLY  Unit: 2', 'Power Source: AC', 'PS Voltage input: 218.00 V',
    'Power Usage: -240W', 'Factory Serial Num: ABC123', 'Factory Part Num: 23-1', 'CHASSIS/WWN  Unit: 1', 'Serial Num: SN1', 'Time Awake: 12 days', 'SW BLADE Slot: 1'],
  'fos.parseSwitchShow': ['switchName: sw1', 'switchType: 162.0', 'switchState: Online', 'zoning: ON (cfg1)', 'Fabric Name: fab-a',
    'Index Port Address  Media Speed   State     Proto', '==================================', '  0   0   010000   id    N16   Online      FC  F-Port  10:00:00:00:00:00:00:01',
    '  1   1   010100   id    N16   No_Light    FC'],
  'fos.parseSfpShow': ['Port 1:', 'Slot 2/Port 3:', 'Temperature: 31 Centigrade', 'Voltage: 3300.0 mVolts', 'Current: 7.0 mAmps',
    'RX Power: -3.1 dBm (490.0 uW)', 'TX Power: 316.2 uW (-5.0 dBm)', 'Vendor Name: BROCADE', 'Vendor PN: 57-1000', 'Serial No: HAA1', 'Wavelength: 850 nm', 'RX Power: -inf dBm (0.0 uW)'],
  'fos.parseNsRoles': ['N    011000;      3;10:00:00:00:00:00:00:01;20:00:00:00:00:00:00:01; na', 'Device type: Physical Initiator',
    'FC4s: FCP-Target', 'NL 011100; 3;x', 'Device type: Physical Initiator+Target'],
  'fos.parseSensorShow': ['sensor  1: (Temperature) is Ok, value is 31 C', 'sensor 2: (Fan) is Ok,speed is 7050 RPM', 'sensor 3: (Power Supply) is Absent', 'sensor x: (Fan)'],
  'fos.parseBottleneckMon': ['  12   3.5  F-Port', 'Port  Type  State', '=====', 'No bottleneck detected', '  7  latency  high'],
  'fos.parseFabricShow': ['  1: fffc01 10:00:00:05:33:00:00:01 10.0.0.1  0.0.0.0  >"sw1"', '>2: fffc02 10:00:00:05:33:00:00:02 10.0.0.2 0.0.0.0 "sw 2"',
    '3: fffc03 10:00:00:05:33:00:00:03 10.0.0.3'],
  'fos.parseTempShow': ['Sensor ID   Temp(C)  Temp(F)  Status', '======', '  1   31   87   Ok', '  2  -1.5  29  Warn', '3 44', '4 22 72 C'],
};
const PARSERS = {
  'pdu.parseCode': (t) => pdu.parseCode(t), 'pdu.parseReading': (t) => pdu.parseReading(t), 'ue.parseUemcli': (t) => ue.parseUemcli(t),
  'fos.parseChassisShow': (t) => fos.parseChassisShow(t), 'fos.parseSwitchShow': (t) => fos.parseSwitchShow(t), 'fos.parseSfpShow': (t) => fos.parseSfpShow(t),
  'fos.parseNsRoles': (t) => fos.parseNsRoles(t), 'fos.parseSensorShow': (t) => fos.parseSensorShow(t), 'fos.parseBottleneckMon': (t) => fos.parseBottleneckMon(t),
  'fos.parseFabricShow': (t) => fos.parseFabricShow(t), 'fos.parseTempShow': (t) => fos.parseTempShow(t),
};
/** 파서별 결정적 입력 — 견본 줄을 흩뜨리고 공백·외로운 \r·U+2028 꼬리를 붙인 여러 줄 텍스트 + uemcli 실제 픽스처. */
function parserInputs(name, rnd) {
  const out = [];
  const lines = PARSER_CORPUS[name];
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(rnd() * 7);
    const parts = [];
    for (let k = 0; k < n; k++) {
      let l = smudge(rnd, pick(rnd, lines));
      if (rnd() < 0.5) l += tail(rnd, 8);
      parts.push(l);
    }
    out.push(parts.join(rnd() < 0.3 ? '\r\n' : '\n'));
  }
  if (name === 'ue.parseUemcli') {
    for (const f of fs.readdirSync(path.join(HERE, 'fixtures')).filter((x) => /^uemcli-.*\.txt$/.test(x)).sort()) {
      out.push(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
    }
  }
  return out;
}
// 감사 기준 판본(HEAD 76a581a — 이 파일들은 3b7816a 이후 바뀌지 않았다)으로 계산했다. 파서 동작을 의도적으로 바꾸면 다시 계산할 것.
const PARSER_SHA256 = {
  'pdu.parseCode': '197d8fb073b98ad6cc86ed4b4bc6219a1219951aa3b41a5a2644a40269ecfc47',
  'pdu.parseReading': '3e06a5f98748efa90fa08b3d5174926406d73d4047a7e65a93fdc57abeeca8c0',
  'ue.parseUemcli': 'eabcb8e4812aa200a153521e044bbced66d0893549933ba96ad8b53ddede51ae',
  'fos.parseChassisShow': '2115f2a10067aed9895288ae429b1fb8ac92fd1e6d73e34b94abf242bab80b86',
  'fos.parseSwitchShow': '3635e2087a9ae952aeae21633f7e06d9eb5a9c2c5baf9b3c9ca4738c10126cf7',
  'fos.parseSfpShow': 'afdf7828a28b3bcdf2d0d36167851258ca8e4a94a6f137bd4be038d67233e4a2',
  'fos.parseNsRoles': '5b90887057f975ebdfa89b7dd27dc2ade3730ff7e5b822a2d34944c217372590',
  'fos.parseSensorShow': '9b4b48b356009819a39f0dcb1806f94b9063eb30f4d11fbe38037d1c17af7c45',
  'fos.parseBottleneckMon': 'e746d41ad2630b5633e4b1aec67ddfa0bd0a065d57d2f93e4e773a18e08f5f85',
  'fos.parseFabricShow': 'bb55db91327c02f89e72c4820885d1eb899820a836e004e51d8390689fa81218',
  'fos.parseTempShow': '0251aeeaed0ca40e072dee15307719a95aae424aa7660bbe03911e568b350a6e',
};

test('GH-R2 ② 파서 전체 결과가 감사 기준 판본과 같다(결정적 입력 · sha256)', () => {
  const rnd = prng(744007);
  const got = {};
  for (const name of Object.keys(PARSERS)) {
    const h = crypto.createHash('sha256');
    for (const t of parserInputs(name, rnd)) h.update(JSON.stringify(PARSERS[name](t)) ?? 'undefined').update('\u0000');
    got[name] = h.digest('hex');
  }
  assert.ok(isDeepStrictEqual(got, PARSER_SHA256), `파서 결과가 바뀌었다: ${JSON.stringify(got, null, 1)}`);
});

test('GH-R2 ③ 긴 공백 + 외로운 \\r 줄에서 선형 — 실제 파서 함수 · 옛 정규식 대비 비율', () => {
  const S = ' '.repeat(12000);
  const T = 'a\rb';
  // [이름, 옛 정규식, 옛 정규식이 받던 줄, 새 파서 호출]
  const CASES = [
    ['pdu.parseCode', OLD.pduCode, 'E000:' + S + T, () => pdu.parseCode('E000:' + S + T)],
    ['pdu.parseReading', OLD.pduReading, '22.9' + S + T, () => pdu.parseReading('E000: Success\n22.9' + S + T)],
    ['ue.parseUemcli', OLD.ueRecStart, '1:' + S + T, () => ue.parseUemcli('1:' + S + T + '\n2: ID = x')],
    ['fos.parseChassisShow', FOS_TAILS[0][0], 'Chassis Family:' + S + T, () => fos.parseChassisShow('Chassis Family:' + S + T)],
    ['fos.parseChassisShow PSU', FOS_TAILS[3][0], 'Power Usage:' + S + T, () => fos.parseChassisShow('POWER SUPPLY Unit: 1\nPower Usage:' + S + T)],
    ['fos.parseSwitchShow', FOS_TAILS[4][0], 'switchName:' + S + T, () => fos.parseSwitchShow('switchName:' + S + T)],
    ['fos.parseSfpShow', FOS_TAILS[13][0], 'Wavelength:' + S + T, () => fos.parseSfpShow('Port 1:\nWavelength:' + S + T)],
    ['fos.parseNsRoles', FOS_TAILS[14][0], 'Device type:' + S + T,
      () => fos.parseNsRoles('N 011000; 3;10:00:00:00:00:00:00:01;20:00:00:00:00:00:00:01; na\nDevice type:' + S + T)],
    ['fos.parseSensorShow', FOS_TAILS[15][0], 'sensor 1: (Temperature)' + S + T, () => fos.parseSensorShow('sensor 1: (Temperature)' + S + T)],
    ['fos.parseBottleneckMon', OLD.bottleneck, '12 ' + S + T, () => fos.parseBottleneckMon('12 ' + S + T)],
    ['fos.parseFabricShow', OLD.fabric, ' 1: fffc01 10:00:00:05:33:00:00:01 10.0.0.1 x' + S + 'a\rb\rc',
      () => fos.parseFabricShow(' 1: fffc01 10:00:00:05:33:00:00:01 10.0.0.1 x' + S + 'a\rb\rc')],
    ['fos.parseTempShow', OLD.temp, ' 1 22' + S + '!', () => fos.parseTempShow(' 1 22' + S + '!')],
  ];
  for (const [name, oldRe, line, run] of CASES) {
    const tOld = timeIt(() => oldRe.exec(line));
    const tNew = timeIt(run, 3) / 3;
    assert.ok(tOld > 40 && tOld > tNew * 5, `${name}: 옛 ${tOld.toFixed(1)}ms · 새 ${tNew.toFixed(2)}ms`);
  }
});

test('GH-R2 ④ 장비 출력 파서 4개 파일에 "공백 + (.*)/(.+) + $" 꼬리 정규식이 남아 있지 않다(소스 — 주석 제거 후)', () => {
  // 같은 꼴을 다시 쓰면 ③ 의 시간 비교가 그 파서만 놓칠 수 있다 — 꼬리 정규식 자체를 막는다. 새 판정은 tailMatch 류 선형 함수로.
  const TAIL = /\\s[*+]\((?:\.\*|\.\+|\.\*\\S)\)(?:\\s\*)?\$/;
  for (const rel of ['pdu/parse.js', 'storage/collectors/uemcliParse.js', 'sanswitch/collectors/fosParse.js', 'storage/collectors/svcDiag.js']) {
    const lines = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8')).split('\n');
    const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => TAIL.test(l));
    assert.equal(hits.length, 0, `${rel}: ${hits.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`).join(' | ')}`);
  }
});
