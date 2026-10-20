/**
 * test/isiduDigestTop2745.test.js — 아이실론 종합 메일 **전 법인 Top N(1~50) · 법인별 Top M(0~20)** + 대상별 순위 모으기 결함(v2.745).
 *
 * 사용자 결정: 열 이름 '사용자(폴더)' · 같은 이름 폴더는 대상마다 따로 센다 · 범위 전 법인 1~50 / 법인별 0~20(0 = 법인별 절 빼기).
 *   ① 범위 한 벌(DIGEST_RANGES) — 범위 밖·정수 아님은 400(자르지 않는다) · 빈 값은 그대로 · 옛 설정 파일(corpTopM 없음) = 0
 *   ② ⚠ 결함 재현 — 대상마다 상위 10(OVERVIEW_POOL)개만 모으면, 한 대상이 상위 20 중 11개 이상을 가질 때 Top 20 이 틀린다
 *      (동률 경계 포함). 종합 메일용 개요는 대상마다 max(N, M, 10)개를 모은다 · 화면용 개요는 예전 10 그대로 · 기억 키에 pool.
 *   ③ 법인별 Top M 모델(순수) — 법인 안 크기 순 · 같은 이름 다른 대상 따로 · M 보다 적으면 실제 개수 · 직전 성공 값 · M=0 이면 빈 배열
 *   ④ 본문 HTML — 법인별 절 · 이스케이프 · M=0 이면 절 없음 · 좁은 화면 규칙(기존 ⑤ 와 같은 방법 + 표당 4칸 이하)
 *   ⑤ 대상별 결과 메일 schedule 인자 — 없으면 예전 본문 그대로 · 있으면 '정기 발송 · 매주 …' 한 줄
 *   ⑥ 미리보기·지금 보내기(가짜 SMTP)·실제 api 라우터 — 같은 모델 · 400 field · 옛 설정 파일 = 절 없음
 * 픽스처 이름은 합성이다(공개 저장소 — v2.513).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isiduTop2745-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
delete process.env.CENTRAL_TOKEN;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const writeJson = (n, v) => fs.writeFileSync(path.join(TMP, n), JSON.stringify(v, null, 2));
const readJson = (n) => JSON.parse(fs.readFileSync(path.join(TMP, n), 'utf8'));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const G = 1024 ** 3;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MON_0800_KST = Date.UTC(2026, 9, 18, 23, 0);   // 2026-10-19(월) 08:00 KST — 순수 함수에 주입하는 고정 시각
// 제품이 실제 시각으로 자르는 데이터(DB 스캔)는 실제 시각에서 정시 경계로 떨어뜨린다(v2.517·v2.744 규약).
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

/* ── 가짜 SMTP(받은 원문 → 받는 사람·제목·본문) ───────────────────────── */
function decodeMail(raw) {
  const m = /^Subject: (.*)$/mi.exec(raw);
  const subject = m ? m[1].replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_x, b) => Buffer.from(b, 'base64').toString('utf8')) : '';
  const out = []; let mode = 'hdr'; let buf = '';
  for (const line of raw.split('\n')) {
    if (/^Content-Transfer-Encoding:\s*base64/i.test(line)) { mode = 'wait'; continue; }
    if (mode === 'wait' && line.trim() === '') { mode = 'b64'; buf = ''; continue; }
    if (mode === 'b64') {
      if (line.trim() === '' || line.startsWith('--')) { out.push(Buffer.from(buf, 'base64').toString('utf8')); mode = 'hdr'; continue; }
      buf += line.trim();
    }
  }
  if (mode === 'b64' && buf) out.push(Buffer.from(buf, 'base64').toString('utf8'));
  return { subject, data: out.join('\n') };
}
async function fakeSmtp() {
  const st = { mails: [] };
  const srv = net.createServer((sock) => {
    let buf = ''; let inData = false; let cur = { rcpt: [], data: '' };
    sock.write('220 fake ESMTP\r\n');
    const handle = (line) => {
      if (inData) {
        if (line === '.') { inData = false; st.mails.push({ rcpt: cur.rcpt, ...decodeMail(cur.data) }); cur = { rcpt: [], data: '' }; sock.write('250 2.0.0 queued\r\n'); }
        else cur.data += `${line}\n`;
        return;
      }
      const u = line.toUpperCase();
      if (u.startsWith('EHLO')) sock.write('250-fake\r\n250 OK\r\n');
      else if (u.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
      else if (u.startsWith('RCPT TO')) { cur.rcpt.push(line.replace(/^RCPT TO:\s*<?/i, '').replace(/>.*$/, '')); sock.write('250 ok\r\n'); }
      else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    };
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); handle(l); } });
    sock.on('error', () => {});
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { st, port };
}

async function call(method, url, body, user = { username: 'root', role: 'admin', superAdmin: true, scope: {} }) {
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

/* ═══════════════ ① 범위 ═══════════════ */
test('① 범위 — DIGEST_RANGES 한 벌 · 범위 밖·정수 아님은 400(자르지 않는다) · 빈 값은 그대로 · 옛 파일(corpTopM 없음) = 0', async () => {
  const R = await import('../src/isidu/digestRules.js');
  assert.deepEqual(R.DIGEST_RANGES, { topN: { min: 1, max: 50, def: 10 }, corpTopM: { min: 0, max: 20, def: 0 } });
  assert.ok(Object.isFrozen(R.DIGEST_RANGES) && Object.isFrozen(R.DIGEST_RANGES.topN) && Object.isFrozen(R.DIGEST_RANGES.corpTopM), '웹이 대조하는 값 — 바뀌지 않게 얼린다');
  const base = { enabled: true, days: [1] };
  for (const v of [1, 5, 10, 20, 30, 50, '7', ' 12 ']) {
    const r = R.normalizeDigest({ ...base, topN: v }, null, 1);
    assert.equal(r.error, undefined, `topN ${JSON.stringify(v)} 은 받는다`);
    assert.equal(r.digest.topN, Number(v));
  }
  for (const v of [0, 51, -1, 2.5, '2.5', 'abc', '1e3', true, false, [], [10], {}]) {
    const r = R.normalizeDigest({ ...base, topN: v }, null, 1);
    assert.equal(r.field, 'digest.topN', `topN ${JSON.stringify(v)} 은 거부(자르지 않는다)`);
    assert.match(r.error, /1~50/);
  }
  for (const v of [0, 3, 20, '5']) {
    const r = R.normalizeDigest({ ...base, corpTopM: v }, null, 1);
    assert.equal(r.error, undefined, `corpTopM ${JSON.stringify(v)} 은 받는다`);
    assert.equal(r.digest.corpTopM, Number(v));
  }
  for (const v of [-1, 21, 1.5, 'x', false, [3]]) {
    const r = R.normalizeDigest({ ...base, corpTopM: v }, null, 1);
    assert.equal(r.field, 'digest.corpTopM', `corpTopM ${JSON.stringify(v)} 은 거부`);
    assert.match(r.error, /0~20/);
  }
  // 빈 값·빠진 칸 = 그대로(이전 값)
  const prev = R.normalizeDigest({ ...base, topN: 30, corpTopM: 5 }, null, 1).digest;
  for (const inp of [{ topN: '', corpTopM: '' }, { topN: null, corpTopM: null }, { topN: '  ' }, {}]) {
    const r = R.normalizeDigest(inp, prev, 2).digest;
    assert.equal(r.topN, 30, JSON.stringify(inp)); assert.equal(r.corpTopM, 5, JSON.stringify(inp));
  }
  // 옛 파일(필드 없음) — 업그레이드만으로 메일이 바뀌지 않게 법인별 절은 0
  assert.equal(R.digestOf(undefined).corpTopM, 0);
  assert.equal(R.digestOf({ topN: 20 }).corpTopM, 0);
  assert.equal(R.digestOf({ topN: 20 }).topN, 20, '옛 값(5·10·20)은 그대로 유효');
  assert.equal(R.digestOf({ topN: 7 }).topN, 7, '이제 1~50 은 전부 유효');
  assert.equal(R.digestOf({ topN: 99 }).topN, 10, '읽을 때 범위 밖은 기본값');
  assert.equal(R.digestOf({ corpTopM: 25 }).corpTopM, 0);
  assert.equal(R.DIGEST_DEFAULTS.corpTopM, 0);
  // 종합 메일용 개요가 대상마다 모을 개수 = max(N, M, 10)
  assert.equal(R.digestPoolOf({ topN: 20, corpTopM: 3 }, 10), 20);
  assert.equal(R.digestPoolOf({ topN: 5, corpTopM: 0 }, 10), 10);
  assert.equal(R.digestPoolOf({ topN: 5, corpTopM: 15 }, 10), 15);
  assert.equal(R.digestPoolOf({ topN: 50, corpTopM: 20 }, 10), 50);
  assert.equal(R.digestPoolOf(undefined, 10), 10);
});

/* ═══════════════ 실제 DB 픽스처 ═══════════════ */
const ROOT = '/ifs/data/users';
const scanRec = (targetId, ts, entries, extra = {}) => {
  const sum = entries.reduce((a, e) => a + e[1], 0);
  return {
    agent: '', node: '', targetId, ts, ok: true, path: `${ROOT}/${targetId}`, host: '10.0.0.5', sizeMode: 'h', durationMs: 42_000, trig: 'schedule',
    total: { bytes: sum, res: Math.round(0.1 * G) }, sumBytes: sum, sumRes: 0, count: entries.length, skipped: 0, errLines: 0,
    entries: entries.map(([name, bytes]) => ({ name, bytes, res: Math.round(0.1 * G) })), ...extra,
  };
};
// tg-big(한국): 100G..82G 19개 + 81G 동률 둘(f20·g20) + 80G..76G — 상위 20 중 19개를 이 대상이 갖는다.
// tg-small(미국): 81G 'a-tie'(전 법인 20위 — 동률 경계에서 이름 순) + 50G..37G.
const BIG = [];
for (let i = 1; i <= 19; i++) BIG.push([`f${String(i).padStart(2, '0')}`, (101 - i) * G]);
BIG.push(['f20', 81 * G], ['g20', 81 * G]);
for (let i = 21; i <= 25; i++) BIG.push([`f${i}`, (101 - i) * G]);
const SMALL = [['a-tie', 81 * G]];
for (let i = 0; i < 14; i++) SMALL.push([`s${String(i).padStart(2, '0')}`, (50 - i) * G]);
const coll = new Intl.Collator();
const bruteTop = (n) => [...BIG.map(([name, bytes]) => ({ name, bytes, t: 'tg-big' })), ...SMALL.map(([name, bytes]) => ({ name, bytes, t: 'tg-small' }))]
  .sort((a, b) => (b.bytes - a.bytes) || coll.compare(a.name, b.name) || a.t.localeCompare(b.t)).slice(0, n);

let smtp = null;
async function setup() {
  if (smtp) return smtp;
  smtp = await fakeSmtp();
  writeJson('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: '', password: '', from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['admin@corp.local'], kinds: {}, rateLimitPerHour: 0 });
  writeJson('datacenters.json', { datacenters: [{ id: 'dc-kr', name: '한국' }, { id: 'dc-us', name: '미국' }], assign: {} });
  // ⚠ 옛 설정 파일 모양 — mail.digest 에 corpTopM 이 없다(업그레이드 직후).
  writeJson('isidu-settings.json', {
    timeoutDefaultMin: 120, retentionDays: 400,
    mail: { commonTo: [], digest: { enabled: false, days: [1], time: '08:00', includeAdmin: true, to: [], topN: 20 } },
    targets: [
      { id: 'tg-big', label: '연구 홈', host: '10.0.0.5', username: 'admin', path: `${ROOT}/tg-big`, topN: 10, datacenterId: 'dc-kr' },
      { id: 'tg-small', label: '미국 홈', host: '10.0.0.6', username: 'admin', path: `${ROOT}/tg-small`, topN: 10, datacenterId: 'dc-us' },
    ],
  });
  const db = await import('../src/isidu/db.js');
  for (const rec of [scanRec('tg-big', T0, BIG), scanRec('tg-small', T0, SMALL)]) { const r = await db.insertScan(rec); assert.equal(r.ok, true, r.error); }
  const { invalidate } = await import('../src/mail/settings.js'); invalidate();
  const mail = await import('../src/mail/service.js'); mail._resetMail?.();
  return smtp;
}
/** 텍스트판에서 '<제목>:' 다음 순위 줄의 폴더 이름(빈 줄에서 끝). */
function rankedNames(text, header) {
  const lines = text.split('\n');
  const i = lines.indexOf(header);
  assert.ok(i >= 0, `텍스트판에 '${header}' 가 있다`);
  const out = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^\s*\d+\. (\S+) — /.exec(l);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/* ═══════════════ ② 결함 재현 ═══════════════ */
test('② 결함 재현 — 한 대상이 상위 20 중 11개 이상이면 대상별 상위 10 으로는 Top 20 이 틀린다(동률 경계 포함)', async () => {
  await setup();
  const Rp = await import('../src/isidu/report.js');
  const P = await import('../src/isidu/parse.js');
  Rp._resetForTest();
  // 개요 — 선택 인자 pool 이면 그만큼 모은다(동률은 컷 크기와 같은 행을 전부 읽고 같은 순서로 자른다)
  const [o20] = await Rp.buildOverview(['tg-big'], { pool: 20 });
  assert.equal(o20.state, 'ok');
  const want20 = P.sortBySize(BIG.map(([name, bytes]) => ({ name, bytes }))).slice(0, 20).map((x) => x.name);
  assert.deepEqual(o20.top.map((x) => x.name), want20, '대상 안 상위 20(보고서 정렬과 같은 순서)');
  // 화면용 개요는 예전 10 그대로 · 기억 키에 pool 이 들어가 서로 섞이지 않는다
  const [o10] = await Rp.buildOverview(['tg-big']);
  assert.equal(o10.top.length, Rp.OVERVIEW_POOL);
  assert.equal(Rp.OVERVIEW_POOL, 10);
  assert.equal((await Rp.buildOverview(['tg-big'], { pool: 20 }))[0].top.length, 20, '기억한 10개짜리를 20개 요청에 주지 않는다');
  assert.equal((await Rp.buildOverview(['tg-big']))[0].top.length, 10, '기억한 20개짜리를 화면용에 주지 않는다');
  assert.equal((await Rp.buildOverview(['tg-big'], { pool: 'x' }))[0].top.length, 10, '못 읽은 pool 은 기본값');

  // 종합 메일(미리보기) — 전 법인 Top 20 이 실제 상위 20 과 같아야 한다
  const D = await import('../src/isidu/digest.js');
  D._resetForTest?.();
  const pv = await D.previewDigest({ topN: 20, corpTopM: 0 }, Date.now());
  assert.equal(pv.ok, true, JSON.stringify(pv));
  const got = rankedNames(pv.text, '전 법인 사용자 Top 20:');
  const want = bruteTop(20).map((x) => x.name);
  assert.equal(BIG.filter(([n]) => want.includes(n)).length >= 11, true, '픽스처 전제: 한 대상이 상위 20 중 11개 이상');
  assert.equal(want[19], 'a-tie', '픽스처 전제: 20위는 동률(81G) 경계에서 이름 순으로 갈린 다른 대상의 폴더');
  assert.deepEqual(got, want, '종합 메일 Top 20 = 실제 상위 20(같은 순서)');
  // Top 50 도 — 두 대상 폴더 41개가 전부 순서대로
  const pv50 = await D.previewDigest({ topN: 50, corpTopM: 0 }, Date.now());
  assert.deepEqual(rankedNames(pv50.text, '전 법인 사용자 Top 50:'), bruteTop(50).map((x) => x.name));
});

test('② 화면용 개요 라우트는 예전 10 그대로(종합 메일 순위 개수와 무관)', async () => {
  await setup();
  const Rp = await import('../src/isidu/report.js');
  Rp._resetForTest();
  const r = await call('GET', '/tools/isilon-dirusage/overview');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pool, 10);
  for (const t of r.body.targets) assert.ok((t.top || []).length <= 10, `${t.id} 의 상위 폴더는 10개 이하`);
});

/* ═══════════════ ③ 법인별 Top M 모델(순수) ═══════════════ */
const pureFixture = () => {
  const now = MON_0800_KST;
  const row = (id, corp, bytes, extra = {}) => ({ id, corp, path: `/ifs/${id}`, deviceName: `ISI-${id}`, intervalHours: 24, timeoutMin: 120, okScan: { id: 1, ts: now - HOUR, total: { bytes }, sumBytes: bytes, errLines: 0 }, ...extra });
  const ovOf = (id, top, count) => ({ id, state: 'ok', base7: { ts: now - 8 * DAY }, totalDelta7: { bytes: G, withinRes: false }, scan: { path: `/ifs/${id}`, sizeMode: 'h', ts: now - HOUR, count }, top: top.map(([name, b], i) => ({ rank: i + 1, name, bytes: b * G, res: 0.1 * G, share: null, d7: { bytes: 0.5 * G, withinRes: false }, new7: false })) });
  const rows = [
    row('a', '한국', 100 * G), row('b', '한국', 60 * G),
    row('c', '미국', 30 * G),
    row('d', '일본', 30 * G, { okScan: { id: 1, ts: now - 3 * DAY, total: { bytes: 30 * G }, sumBytes: 30 * G, errLines: 0 }, lastTry: { id: 2, ts: now - HOUR, ok: false, kind: 'timeout', error: 'x' } }),
    row('e', '독일', 0, { okScan: null }),
  ];
  const ov = new Map([
    ['a', ovOf('a', [['shared', 40], ['<img src=x>', 30], ['a3', 10]], 3)],
    ['b', ovOf('b', [['shared', 35], ['b1', 20]], 2)],
    ['c', ovOf('c', [['c1', 25]], 1)],
    ['d', ovOf('d', [['d1', 9], ['d2', 8], ['d3', 7], ['d4', 6]], 4)],
    ['e', { id: 'e', state: 'no-data' }],
  ]);
  return { now, rows, ov };
};

test('③ 법인별 Top M(순수) — 법인 순서 = 사용량 순 · 같은 이름 다른 대상 따로 · M 보다 적으면 실제 개수 · 직전 성공 값 · M=0 이면 빈 배열', async () => {
  const R = await import('../src/isidu/digestRules.js');
  const { now, rows, ov } = pureFixture();
  const m = R.buildDigestModel(rows, ov, { now, topN: 30, corpTopM: 3 });
  assert.equal(m.topN, 30, '전 법인 순위는 1~50 전부 받는다');
  assert.equal(m.corpTopM, 3);
  assert.deepEqual(m.corpTop.map((c) => c.label), m.corps.map((c) => c.label), '법인 순서는 법인별 사용량 표와 같다(사용량 많은 순)');
  const kr = m.corpTop.find((c) => c.label === '한국');
  assert.deepEqual(kr.rows.map((r) => `${r.name}@${r.targetId}`), ['shared@a', 'shared@b', '<img src=x>@a'], '같은 이름 폴더도 대상이 다르면 따로 센다');
  assert.deepEqual(kr.rows.map((r) => r.rank), [1, 2, 3]);
  assert.equal(kr.bytes, 160 * G);
  assert.equal(kr.topBytes, 105 * G);
  assert.ok(Math.abs(kr.topShare - 105 / 160) < 1e-12, '상위 M개 합의 비중 — 분모는 법인 사용량');
  assert.ok(Math.abs(kr.rows[0].share - 40 / 160) < 1e-12, '줄마다 법인 안 비중');
  assert.deepEqual(kr.rows[0].d7, { bytes: 0.5 * G, within: false });
  assert.equal(kr.fewer, false);
  const us = m.corpTop.find((c) => c.label === '미국');
  assert.equal(us.shown, 1); assert.equal(us.fewer, true, 'M 보다 적다'); assert.equal(us.folderTotal, 1, '실제 폴더 수');
  const jp = m.corpTop.find((c) => c.label === '일본');
  assert.equal(jp.rows.length, 3);
  assert.ok(jp.rows.every((r) => r.lastValue === true), '실패 대상의 폴더는 직전 성공 값');
  assert.equal(jp.lastValueTargets.length, 1); assert.equal(jp.lastValueTargets[0].statusKey, 'failed'); assert.equal(jp.lastValueTargets[0].okTs, now - 3 * DAY);
  const de = m.corpTop.find((c) => c.label === '독일');
  assert.deepEqual(de.rows, []); assert.equal(de.noData, true); assert.equal(de.bytes, null);
  // M=0 → 법인별 절을 싣지 않는다 · 범위 밖 값은 0 으로(모델은 지어내지 않는다)
  assert.deepEqual(R.buildDigestModel(rows, ov, { now, corpTopM: 0 }).corpTop, []);
  assert.deepEqual(R.buildDigestModel(rows, ov, { now }).corpTop, [], '기본은 0');
  assert.deepEqual(R.buildDigestModel(rows, ov, { now, corpTopM: 99 }).corpTop, []);
  assert.equal(R.buildDigestModel(rows, ov, { now, topN: 99 }).topN, 10);
  // 전 법인 Top N — 같은 이름도 대상마다 따로
  assert.deepEqual(m.top.slice(0, 3).map((r) => `${r.name}@${r.targetId}`), ['shared@a', 'shared@b', '<img src=x>@a']);
});

/* ═══════════════ ④ 본문 HTML ═══════════════ */
/** '<h>제목' 부터 다음 구획(class="dvc-sec") 전까지. */
function sectionHtml(html, title) {
  const i = html.indexOf(title);
  assert.ok(i >= 0, `본문에 '${title}' 가 있다`);
  const start = html.lastIndexOf('<tr><td class="dvc-sec"', i);
  const end = html.indexOf('<tr><td class="dvc-sec"', i);
  return html.slice(start, end < 0 ? undefined : end);
}
test('④ 본문 — 전 법인 사용자 Top N · 법인별 사용자 Top M 절 · 이스케이프 · M=0 이면 절 없음 · 좁은 화면 규칙', async () => {
  const R = await import('../src/isidu/digestRules.js');
  const H = await import('../src/isidu/mailHtml.js');
  const { now, rows, ov } = pureFixture();
  const m = R.buildDigestModel(rows, ov, { now, topN: 5, corpTopM: 3 });
  const mail = H.renderDigestMail(m, { digest: { days: [1, 3, 5], time: '08:00', topN: 5, corpTopM: 3 }, slot: MON_0800_KST, recipients: 2, now });
  assert.ok(!mail.html.includes('<img src=x>'), '폴더 이름이 태그로 들어가지 않는다');
  assert.ok(mail.html.includes('&lt;img src=x&gt;'));
  const g = sectionHtml(mail.html, '전 법인 사용자 Top 5');
  assert.match(g, /사용자\(폴더\)/, "열 이름은 '사용자(폴더)'");
  const c = sectionHtml(mail.html, '법인별 사용자 Top 3');
  assert.equal([...c.matchAll(/사용자\(폴더\)/g)].length, m.corpTop.filter((x) => x.rows.length).length, '법인마다 표 머리');
  assert.match(c, /법인 안/, '줄마다 법인 안 비중');
  assert.match(c, /상위 3개가/, '상위 M개 합의 비중');
  assert.match(c, /사용자 폴더가 1개라 1개만 실었습니다/, 'M 보다 적은 법인은 실제 개수와 그 사실');
  assert.match(c, /직전 성공 값/);
  assert.match(c, /성공한 수집이 없어/, '결과 없는 법인');
  assert.ok(c.indexOf('한국') < c.indexOf('미국'), '법인 순서는 사용량 많은 순');
  // 좁은 화면 — 법인별 절의 표는 4칸 이하, 고정 폭(세 자리 px) 없음
  for (const t of c.split('<table').slice(1)) assert.ok([...t.split('</table>')[0].matchAll(/<th /g)].length <= 4, '표당 4칸 이하(360px)');
  assert.ok(!/(?:^|[^-])width:\d{3,}px/.test(c) && !/min-width:\d{3,}px/.test(c) && !/width="\d{3,}"/.test(c), '세 자리 고정 폭 없음');
  // 기존 ⑤ 와 같은 방법 — font-size:0 래퍼 안 카드는 글자 크기·줄 높이를 되돌린다 · 좁은 화면 여백 축소
  const inner = [...mail.html.matchAll(/display:inline-block;vertical-align:top[^"]*"><div style="([^"]*)"/g)].map((x) => x[1]);
  assert.ok(inner.length >= 4);
  for (const st of inner) { assert.match(st, /font-size:\d+px/); assert.match(st, /line-height:1\.\d+/); }
  assert.match(mail.html, /@media only screen and \(max-width:520px\)/);
  // 고정폭 글꼴(경로·폴더 이름)은 공백 없는 긴 문자열이라 줄바꿈을 허용해야 한다 — '먼저 볼 것' 의 경로 칸이 360px 에서 95px 넘쳤다(Chromium 측정).
  for (const st of [...mail.html.matchAll(/style="([^"]*font-family:Consolas[^"]*)"/g)].map((x) => x[1])) assert.match(st, /word-break:break-all/, st);
  // 텍스트판
  assert.match(mail.text, /^전 법인 사용자 Top 5:$/m);
  assert.match(mail.text, /^법인별 사용자 Top 3:$/m);
  assert.match(mail.text, /^\[한국\] 법인 사용량 /m);
  // 바닥글 — 순위 개수
  assert.match(mail.html, /전 법인 순위 5개 · 법인별 순위 법인마다 3개/);
  // M=0 → 절 없음
  const m0 = R.buildDigestModel(rows, ov, { now, topN: 5, corpTopM: 0 });
  const mail0 = H.renderDigestMail(m0, { digest: { days: [1], time: '08:00' }, slot: MON_0800_KST, now });
  assert.ok(!mail0.html.includes('법인별 사용자 Top')); assert.ok(!mail0.text.includes('법인별 사용자 Top'));
  assert.match(mail0.html, /법인별 순위 싣지 않음/);
});

/* ═══════════════ ⑤ 대상별 결과 메일 schedule ═══════════════ */
test('⑤ 결과 메일 — schedule 없으면 예전 본문 · {days,time} 이면 정기 발송 한 줄', async () => {
  const H = await import('../src/isidu/mailHtml.js');
  const report = { state: 'ok', scan: { ts: T0, path: '/ifs/a', host: 'h', sizeMode: 'h', durationMs: 1000 }, kpi: { denomBytes: 10 * G, users: 1, topN: 1, topBytes: 5 * G, topShare: 0.5 }, top: [{ rank: 1, name: 'x', bytes: 5 * G, share: 0.5 }], growth: [] };
  const base = { label: 'L', corp: '한국', report, now: MON_0800_KST };
  const plain = H.renderResultMail(base);
  assert.deepEqual(H.renderResultMail({ ...base, schedule: null }), plain);
  assert.deepEqual(H.renderResultMail({ ...base, schedule: undefined }), plain);
  assert.ok(!plain.html.includes('정기 발송')); assert.match(plain.html, /조사가 끝날 때마다 보냅니다/);
  const sch = H.renderResultMail({ ...base, schedule: { days: [4, 1], time: '08:00' } });
  assert.match(sch.html, /정기 발송 · 매주 월·목 08:00/);
  assert.match(sch.text, /^정기 발송 · 매주 월·목 08:00$/m);
  assert.ok(!sch.html.includes('조사가 끝날 때마다 보냅니다'), '정기 발송 메일이 조사마다 보낸다고 말하지 않는다');
  assert.match(H.renderResultMail({ ...base, schedule: { days: [1, 2, 3, 4, 5], time: '07:30' } }).html, /정기 발송 · 평일 07:30/);
  assert.ok(!H.renderResultMail({ ...base, schedule: { days: [1], time: '<b>' } }).html.includes('<b>'), '시각도 이스케이프');
});

/* ═══════════════ ⑥ 미리보기·지금 보내기·라우터 ═══════════════ */
test('⑥ 옛 설정 파일(corpTopM 없음)은 법인별 절 없음 · 400 field · 저장 뒤 미리보기·지금 보내기(가짜 SMTP)가 같은 모델', async () => {
  const s = await setup();
  const g = await call('GET', '/tools/isilon-dirusage/digest');
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.digest.corpTopM, 0, '옛 파일 = 0');
  assert.equal(g.body.digest.topN, 20);
  const pv0 = await call('POST', '/tools/isilon-dirusage/digest/preview', {});
  assert.equal(pv0.status, 200, JSON.stringify(pv0.body));
  assert.ok(!pv0.body.html.includes('법인별 사용자 Top'), '업그레이드만으로 메일이 바뀌지 않는다');
  for (const [body, field] of [[{ topN: 51 }, 'digest.topN'], [{ topN: 0 }, 'digest.topN'], [{ topN: 2.5 }, 'digest.topN'], [{ corpTopM: 21 }, 'digest.corpTopM'], [{ corpTopM: -1 }, 'digest.corpTopM']]) {
    const r = await call('PUT', '/tools/isilon-dirusage/digest', { digest: body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.field, field);
    const p = await call('POST', '/tools/isilon-dirusage/digest/preview', { digest: body });
    assert.equal(p.status, 400, `미리보기도 같은 판정 ${JSON.stringify(body)}`);
  }
  assert.equal(readJson('isidu-settings.json').mail.digest.corpTopM, undefined, '거부된 저장은 파일을 바꾸지 않는다');
  const ok = await call('PUT', '/tools/isilon-dirusage/digest', { digest: { corpTopM: 3, topN: 30 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.digest.corpTopM, 3); assert.equal(ok.body.digest.topN, 30);
  assert.equal(readJson('isidu-settings.json').mail.digest.corpTopM, 3);
  const pv = await call('POST', '/tools/isilon-dirusage/digest/preview', {});
  assert.match(pv.body.html, /법인별 사용자 Top 3/);
  assert.match(pv.body.html, /전 법인 사용자 Top 30/);
  assert.match(pv.body.text, /^\[한국\] 법인 사용량 /m, '텍스트판에 법인 머리 줄');
  // 지금 보내기 — 실제 메일도 같은 모델
  const before = s.st.mails.length;
  const sn = await call('POST', '/tools/isilon-dirusage/digest/send-now', {});
  assert.equal(sn.status, 200, JSON.stringify(sn.body)); assert.equal(sn.body.state, 'sent');
  assert.equal(s.st.mails.length, before + 1);
  const got = s.st.mails.at(-1);
  assert.match(got.data, /법인별 사용자 Top 3/);
  assert.match(got.data, /전 법인 사용자 Top 30/);
  assert.deepEqual(rankedNames(got.data.split('\n').map((l) => l.replace(/\r$/, '')).join('\n'), '전 법인 사용자 Top 30:'), bruteTop(30).map((x) => x.name), '실제 메일의 Top 30 도 실제 상위 30');
  // 법인별 Top 3 — 한국은 tg-big 상위 3, 미국은 tg-small 상위 3
  const txt = got.data.replace(/\r/g, '');
  assert.match(txt, /\[한국\][^\n]*\n\s*1\. f01 —[^\n]*\n\s*2\. f02 —[^\n]*\n\s*3\. f03 —/);
  assert.match(txt, /\[미국\][^\n]*\n\s*1\. a-tie —[^\n]*\n\s*2\. s00 —[^\n]*\n\s*3\. s01 —/);
});
