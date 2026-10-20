/**
 * test/isiduTopReview2745.test.js — 종합 메일 법인별 Top M 적대적 검토 확정분(v2.745 G3 후속).
 *
 *   ① TOPNM-02 — du -h 반올림으로 폴더 합이 법인 사용량(합계 줄)보다 크면 '상위 M개 비중' 이 100% 를 넘어 메일에 찍혔다(재현: 104.9%).
 *      분모를 max(법인 사용량, 그 법인에서 읽은 폴더 크기 합)으로 두고, 분모를 올렸으면 그 사실을 법인 각주와 '숫자를 읽는 법' 이 말한다.
 *      법인 사용량 칸(c.bytes)은 그대로다(법인별 사용량 표와 같은 값).
 *   ② TOPNM-03 — 꺼짐·조사 중·재시작 중단·요청 대기 대상은 상태 key 가 먼저 정해져 마지막 성공 조사가 몇 달 전이어도 '직전 성공 값' 표지가
 *      없었다. 표시 상태(statusOfRow — 웹과 같은 판정)는 그대로 두고, 값의 신선도(보고 늦음 경계)·직전 시도 실패를 따로 보고 표지를 단다.
 *   ③ TOPNM-04 — 폴더 목록을 읽지 못한 대상(개요 오류·결과 없음)이 있는 법인에서 '이 법인은 사용자 폴더가 N개라' 고 단정했다.
 *      그런 법인은 folderTotal 이 null 이고 문구는 '읽은 폴더가 N개라' 다.
 * 순수 함수만 부른다 — 기준 시각은 고정값을 주입한다(테스트 시한 폭탄 규약). 픽스처 이름은 합성이다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isiduTopReview2745-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const NOW = Date.UTC(2026, 9, 18, 23, 0);   // 2026-10-19(월) 08:00 KST
const HOUR = 3_600_000;
const DAY = 86_400_000;
const G = 1024 ** 3;
const T = 1024 ** 4;

function row(id, corp, bytes, extra = {}) {
  return {
    id, corp, label: id, path: `/ifs/${id}`, deviceName: `ISI-${id}`, enabled: true, intervalHours: 24, timeoutMin: 120,
    okScan: { id: 1, ts: NOW - HOUR, total: { bytes }, errLines: 0 }, lastTry: { ok: true, ts: NOW - HOUR }, ...extra,
  };
}
function ov(id, top, { count, mode = 'h', ts = NOW - HOUR } = {}) {
  return {
    id, state: 'ok', base7: null, totalDelta7: null,
    scan: { id: 1, ts, count: count ?? top.length, sizeMode: mode, path: `/ifs/${id}` },
    top: top.map(([name, bytes], i) => ({ rank: i + 1, name, bytes, res: mode === 'k' ? 1024 : G, share: null, d7: null, new7: false })),
  };
}
const corpSection = (html) => {
  const i = html.indexOf('법인별 사용자 Top');
  assert.ok(i >= 0, '법인별 절이 있다');
  const start = html.lastIndexOf('<tr><td class="dvc-sec"', i);
  const end = html.indexOf('<tr><td class="dvc-sec"', i);
  return html.slice(start, end < 0 ? undefined : end);
};
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');

/* ═══════════════ ① TOPNM-02 ═══════════════ */
test('① TOPNM-02 — du -h 반올림으로 폴더 합 > 법인 사용량이어도 비중이 100% 를 넘지 않고, 분모를 올린 사실을 말한다', async () => {
  const R = await import('../src/isidu/digestRules.js');
  const H = await import('../src/isidu/mailHtml.js');
  // 실제 합계 1074G → du -h '1.0T'(2^40) · 폴더 537G·537G(정확히 표시). 행에는 폴더 합(sumBytes)이 실린다(rows.js targetRows 와 같은 모양).
  const rows = [row('a1', 'CORP-A', 1.0 * T, { okScan: { id: 1, ts: NOW - HOUR, total: { bytes: 1.0 * T }, sumBytes: 1074 * G, errLines: 0 } })];
  const ovById = new Map([['a1', ov('a1', [['u1', 537 * G], ['u2', 537 * G]])]]);
  const m = R.buildDigestModel(rows, ovById, { now: NOW, topN: 10, corpTopM: 5 });
  const c = m.corpTop[0];
  assert.equal(c.bytes, 1.0 * T, '법인 사용량 칸은 그대로(법인별 사용량 표와 같은 값)');
  assert.equal(m.corps[0].bytes, 1.0 * T);
  assert.ok(c.topShare <= 1, `상위 M개 비중이 100% 를 넘지 않는다(${c.topShare})`);
  assert.equal(c.topShare, 1, '상위 2개가 그 법인 폴더 전부다');
  const sum = c.rows.reduce((s, r) => s + r.share, 0);
  assert.ok(sum <= 1 + 1e-12, `줄마다 법인 안 비중의 합이 100% 를 넘지 않는다(${sum})`);
  assert.equal(c.shareDenomRaised, true, '분모를 폴더 크기 합으로 올렸다는 표지');
  assert.equal(c.shareDenom, 1074 * G);
  const mail = H.renderDigestMail(m, { digest: R.digestOf({ topN: 10, corpTopM: 5 }), now: NOW });
  const sec = corpSection(mail.html);
  const pctsOf = (str) => [...str.matchAll(/(\d+(?:\.\d+)?)%/g)].map((x) => Number(x[1]));
  assert.ok(pctsOf(plain(sec)).length >= 3);
  assert.ok(pctsOf(plain(sec)).every((p) => p <= 100), `100% 를 넘는 비중이 법인별 절에 찍히지 않는다(${pctsOf(plain(sec))})`);
  assert.match(sec, /상위 2개가 <b[^>]*>100\.0%<\/b>/);
  assert.match(plain(sec), /반올림/, '분모를 올린 이유를 법인 각주가 말한다');
  assert.match(plain(mail.html), /분모는 그 법인의 사용량[^.]*폴더 크기 합을 분모로 썼습니다/, '숫자를 읽는 법도 분모가 바뀔 수 있음을 말한다');
  assert.ok(!/폴더 크기 합을 분모로 썼습니다/.test(plain(H.renderDigestMail(R.buildDigestModel([row('z1', 'CORP-Z', 160 * G)], new Map([['z1', ov('z1', [['x', 100 * G]])]]), { now: NOW, corpTopM: 1 }), { digest: R.digestOf({ corpTopM: 1 }), now: NOW }).html)), '분모를 올린 법인이 없으면 그 문장을 붙이지 않는다');
  assert.ok(pctsOf(mail.text).every((p) => p <= 100), `텍스트판에도 100% 초과 비중이 없다(${pctsOf(mail.text)})`);
  assert.match(mail.text, /반올림/);

  // 분모는 '읽은 상위 M개 합' 이 아니라 그 법인의 폴더 크기 합이다 — 순위 밖 폴더가 있으면 상위 M개는 100% 가 아니다.
  const rows1 = [row('a3', 'CORP-A', 1.0 * T, { okScan: { id: 1, ts: NOW - HOUR, total: { bytes: 1.0 * T }, sumBytes: 1100 * G, errLines: 0 } })];
  const m1 = R.buildDigestModel(rows1, new Map([['a3', ov('a3', [['u1', 537 * G], ['u2', 537 * G], ['u3', 26 * G]])]]), { now: NOW, topN: 10, corpTopM: 2 });
  assert.equal(m1.corpTop[0].shareDenom, 1100 * G);
  assert.ok(Math.abs(m1.corpTop[0].topShare - 1074 / 1100) < 1e-12, `순위 밖 폴더(26G)를 분모에 넣는다(${m1.corpTop[0].topShare})`);

  // 행에 폴더 합(sumBytes)이 없어도(옛 행·합성 입력) 읽은 상위 폴더 합이 바닥이라 100% 를 넘지 않는다.
  const rows2 = [row('a2', 'CORP-A', 1.0 * T)];
  const m2 = R.buildDigestModel(rows2, new Map([['a2', ov('a2', [['u1', 537 * G], ['u2', 537 * G]])]]), { now: NOW, topN: 10, corpTopM: 5 });
  assert.ok(m2.corpTop[0].topShare <= 1);
  assert.ok(m2.corpTop[0].rows.every((r) => r.share <= 1));

  // 정상(폴더 합 ≤ 합계 줄)이면 분모는 예전처럼 법인 사용량이고 표지·각주가 없다.
  const rows3 = [row('n1', 'CORP-N', 160 * G, { okScan: { id: 1, ts: NOW - HOUR, total: { bytes: 160 * G }, sumBytes: 150 * G, errLines: 0 } })];
  const m3 = R.buildDigestModel(rows3, new Map([['n1', ov('n1', [['x', 100 * G], ['y', 50 * G]])]]), { now: NOW, topN: 10, corpTopM: 1 });
  const c3 = m3.corpTop[0];
  assert.equal(c3.shareDenomRaised, false);
  assert.ok(Math.abs(c3.topShare - 100 / 160) < 1e-12, '분모는 법인 사용량');
  const mail3 = H.renderDigestMail(m3, { digest: R.digestOf({ topN: 10, corpTopM: 1 }), now: NOW });
  assert.ok(!/반올림/.test(plain(corpSection(mail3.html))), '분모를 올리지 않았으면 각주가 없다');
});

/* ═══════════════ ② TOPNM-03 ═══════════════ */
test('② TOPNM-03 — 꺼짐·조사 중·중단·요청 대기라도 값이 오래됐거나 직전 시도가 실패면 직전 성공 값 표지(표시 상태는 그대로)', async () => {
  const R = await import('../src/isidu/digestRules.js');
  const H = await import('../src/isidu/mailHtml.js');
  const old = NOW - 180 * DAY;
  const oldScan = { id: 1, ts: old, total: { bytes: 10 * T }, errLines: 0 };
  const cases = [
    ['off', { enabled: false }],
    ['off', { deviceDisabled: true }],
    ['running', { running: true }],
    ['interrupted', { interrupted: true }],
    ['requested', { request: { state: 'queued' } }],
  ];
  for (const [key, extra] of cases) {
    const rows = [row('b1', 'CORP-B', 10 * T, { okScan: oldScan, lastTry: { ok: true, ts: old }, ...extra }), row('b2', 'CORP-B', 1 * T)];
    const ovById = new Map([['b1', ov('b1', [['old-user', 9 * T]], { ts: old })], ['b2', ov('b2', [['u', 500 * G]])]]);
    assert.equal(R.statusOfRow(rows[0], NOW).key, key, '표시 상태는 바뀌지 않는다(웹 targetStatus 와 같은 판정)');
    const m = R.buildDigestModel(rows, ovById, { now: NOW, topN: 10, corpTopM: 5 });
    const g = m.top.find((r) => r.name === 'old-user');
    assert.equal(g.lastValue, true, `${key}: 전 법인 Top 의 180일 전 값에 표지`);
    assert.equal(g.lastValueWhy, 'old');
    assert.equal(m.top.find((r) => r.name === 'u').lastValue, false, '신선한 정상 대상은 표지 없음');
    const c = m.corpTop[0];
    assert.equal(c.rows.find((r) => r.name === 'old-user').lastValue, true, `${key}: 법인별 Top 에도 표지`);
    assert.equal(c.lastValueTargets.length, 1);
    assert.equal(c.lastValueTargets[0].targetId, 'b1');
    assert.equal(c.lastValueTargets[0].why, 'old');
    assert.equal(c.lastValueTargets[0].okTs, old);
    const item = m.corps[0].items.find((x) => x.t.id === 'b1');
    assert.equal(item.lastValue, true, '수집 대상별 칸도 같은 판정');
    const mail = H.renderDigestMail(m, { digest: R.digestOf({ topN: 10, corpTopM: 5 }), now: NOW });
    const note = plain(corpSection(mail.html));
    assert.match(note, new RegExp(`직전 성공 값: ISI-b1 /ifs/b1 — ${R.statusOfRow(rows[0], NOW).text.replace(/[·()]/g, '.')}`), `${key}: 각주가 상태별 사유를 말한다`);
    assert.match(note, /값이 오래됨/);
    assert.match(mail.text, /old-user — .*\[직전 성공 값\]/);
  }

  // 몇 주째 실패하던 대상이 정기 발송 시각에 다시 조사 중 — 직전 시도 실패를 먼저 말한다.
  const rowsF = [row('f1', 'CORP-F', 2 * T, { running: true, okScan: { id: 1, ts: NOW - 21 * DAY, total: { bytes: 2 * T }, errLines: 0 }, lastTry: { ok: false, ts: NOW - 2 * HOUR, kind: 'timeout' } })];
  const mF = R.buildDigestModel(rowsF, new Map([['f1', ov('f1', [['w', 1 * T]], { ts: NOW - 21 * DAY })]]), { now: NOW, topN: 10, corpTopM: 5 });
  assert.equal(R.statusOfRow(rowsF[0], NOW).key, 'running');
  assert.equal(mF.top[0].lastValue, true);
  assert.equal(mF.top[0].lastValueWhy, 'failed-before');
  const noteF = plain(corpSection(H.renderDigestMail(mF, { digest: R.digestOf({ topN: 10, corpTopM: 5 }), now: NOW }).html));
  assert.match(noteF, /조사 중 · 직전 조사 실패/);

  // 직전 시도 실패만 있고 값은 아직 신선한 '꺼짐' 대상도 표지(마지막 시도가 실패면 그 값은 직전 성공 값이다).
  const rowsG = [row('g1', 'CORP-G', 1 * T, { enabled: false, okScan: { id: 1, ts: NOW - 5 * HOUR, total: { bytes: 1 * T }, errLines: 0 }, lastTry: { ok: false, ts: NOW - 2 * HOUR, kind: 'auth' } })];
  const mG = R.buildDigestModel(rowsG, new Map([['g1', ov('g1', [['v', 100 * G]])]]), { now: NOW, topN: 10, corpTopM: 0 });
  assert.equal(mG.top[0].lastValueWhy, 'failed-before');

  // 대조 — 꺼짐·조사 중이어도 값이 신선하고 직전 시도가 성공이면 표지 없음 · 정상·보고 늦음·실패는 예전 그대로.
  for (const extra of [{ enabled: false }, { running: true }, { request: { state: 'taken' } }]) {
    const rs = [row('h1', 'CORP-H', 1 * T, extra)];
    const mh = R.buildDigestModel(rs, new Map([['h1', ov('h1', [['z', 100 * G]])]]), { now: NOW, topN: 10, corpTopM: 5 });
    assert.equal(mh.top[0].lastValue, false, `${JSON.stringify(extra)}: 신선한 값은 표지 없음`);
    assert.equal(mh.corpTop[0].lastValueTargets.length, 0);
  }
  const stale = [row('s1', 'CORP-S', 1 * T, { okScan: { id: 1, ts: NOW - 5 * DAY, total: { bytes: 1 * T }, errLines: 0 }, lastTry: { ok: true, ts: NOW - 5 * DAY } })];
  const ms = R.buildDigestModel(stale, new Map([['s1', ov('s1', [['z', 100 * G]], { ts: NOW - 5 * DAY })]]), { now: NOW, topN: 10, corpTopM: 0 });
  assert.equal(R.statusOfRow(stale[0], NOW).key, 'stale');
  assert.equal(ms.top[0].lastValue, true); assert.equal(ms.top[0].lastValueWhy, 'stale');
  // 경계 — 보고 늦음 판정과 같은 경계(statusOfRow 와 같은 함수)
  const t0 = row('e1', 'CORP-E', 1 * T, { enabled: false });
  const lim = R.valueStaleMsOf(t0);
  assert.equal(lim, 24 * HOUR * 2 + 120 * 60_000 + HOUR, '보고 늦음 경계와 같은 값');
  const at = (age) => R.buildDigestModel([{ ...t0, okScan: { ...t0.okScan, ts: NOW - age } }], new Map([['e1', ov('e1', [['z', G]])]]), { now: NOW, corpTopM: 0 }).top[0].lastValue;
  assert.equal(at(lim), false, '경계와 같으면 아직 신선');
  assert.equal(at(lim + 1), true, '경계를 넘으면 오래된 값');
});

/* ═══════════════ ③ TOPNM-04 ═══════════════ */
test("③ TOPNM-04 — 폴더 목록을 못 읽은 대상이 있는 법인은 '이 법인은 사용자 폴더가 N개' 라 단정하지 않는다", async () => {
  const R = await import('../src/isidu/digestRules.js');
  const H = await import('../src/isidu/mailHtml.js');
  const D = { digest: R.digestOf({ topN: 10, corpTopM: 5 }), now: NOW };
  for (const state of ['error', 'db-unavailable']) {
    const rows = [row('c1', 'CORP-C', 1 * T), row('c2', 'CORP-C', 5 * T)];
    const ovById = new Map([['c1', ov('c1', [['u1', 300 * G], ['u2', 200 * G]], { mode: 'k' })], ['c2', { id: 'c2', state, error: 'x' }]]);
    const m = R.buildDigestModel(rows, ovById, { now: NOW, topN: 10, corpTopM: 5 });
    const c = m.corpTop[0];
    assert.equal(c.ovFailed, 1);
    assert.equal(c.fewer, true);
    assert.equal(c.folderTotal, null, `${state}: 읽지 못한 대상이 있으면 법인 전체 폴더 수는 모른다`);
    const html = plain(corpSection(H.renderDigestMail(m, D).html));
    assert.ok(!/이 법인은 사용자 폴더가/.test(html), `${state}: 법인 전체 사실처럼 말하지 않는다`);
    assert.match(html, /읽은 폴더가 2개라 2개만 실었습니다/);
    assert.match(html, /폴더 목록을 읽지 못한 대상 1개는 순위에서 빠졌습니다/);
    const text = H.renderDigestMail(m, D).text;
    assert.ok(!/이 법인은 사용자 폴더가/.test(text));
  }
  // 결과가 아직 없는 대상(폴더 목록 없음)이 있는 법인도 같다.
  const rowsN = [row('c1', 'CORP-C', 1 * T), row('c3', 'CORP-C', 0, { okScan: null, lastTry: null })];
  const mN = R.buildDigestModel(rowsN, new Map([['c1', ov('c1', [['u1', 300 * G], ['u2', 200 * G]], { mode: 'k' })], ['c3', { id: 'c3', state: 'no-data' }]]), { now: NOW, corpTopM: 5 });
  assert.equal(mN.corpTop[0].folderTotal, null);
  assert.match(plain(corpSection(H.renderDigestMail(mN, D).html)), /읽은 폴더가 2개라 2개만 실었습니다/);
  // 대조 — 모든 대상의 폴더 목록을 읽었으면 법인 전체 폴더 수로 말한다(예전 그대로).
  const rowsOk = [row('c1', 'CORP-C', 1 * T)];
  const mOk = R.buildDigestModel(rowsOk, new Map([['c1', ov('c1', [['u1', 300 * G], ['u2', 200 * G]], { mode: 'k' })]]), { now: NOW, corpTopM: 5 });
  assert.equal(mOk.corpTop[0].folderTotal, 2);
  assert.match(plain(corpSection(H.renderDigestMail(mOk, D).html)), /이 법인은 사용자 폴더가 2개라 2개만 실었습니다/);
});
