/**
 * 베어메탈 사용률 점검 반복 6회차 그룹 Y(기준판 04fad6d16) — 재현한 입력으로 고정한다.
 *   A3 서머타임(시간대 전환) 뒤 12시간 합 규칙 — 매주 창의 합 규칙 기준점이 앞으로 36일뿐이라(창 수명 92일) 36일 뒤의 전환이 바꾸는 겹침을 보지 못했다.
 *      바르샤바 매일 10:00 6h + 서울 매일 23:00 7h(같은 서버 · now 2027-01-20) — 겨울 합 12h · 3-28 전환 뒤 13h 인데 예전 false(빠른 · 정확 둘 다).
 *      고침: 후보 수명 안의 전환 둘레(앞 2일 ~ 뒤 9일)를 기준점에 더한다(store.js dstAnchors — 빠른 길 · 정확 경로 · 메모 같은 함수 · schedule.js tzTransitions).
 *      대조: 빠른 = 정확 = 메모 = 비동기 = **독립 격자**(수명 전체 후보 발생마다 겹치는 24시간 창 시작을 30분 격자로 전부 센다 — 기준점 · windowOver 를 쓰지 않는다).
 *   PowerCap 신선도 — 엣지 사본 인벤토리(remote)는 3일 전 상한도 set 이었다(로컬만 2시간 · 봉투는 set 만 stale). 신선도 판정 하나(hwFacts capStateAt · invFreshAt).
 *      알림 경로(powerAlertItems → judgeOf → powerCondition)를 실제 powerSources 로 돌려 본다 — OME 가 재는 서버 + 엣지 사본 인벤토리면 예전에는 낡은 상한으로 걸림(true)을 판정했다.
 * 기준 시각: 서머타임 재현은 고정 UTC(2027 — 전환 날짜가 정해진 해) · 라우터는 deps.now 로 같은 시각을 준다(창 파일 판정도 그 시각). 그 밖은 실제 시각을 정시로 떨어뜨린 T0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop6y-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
const all7 = [0, 1, 2, 3, 4, 5, 6];
const S = await import('../src/bmusage/maint/schedule.js');
const ST = await import('../src/bmusage/maint/store.js');
const J = await import('../src/bmusage/maint/judge.js');
const LIMIT = ST.OWNER_OVER_MIN * MIN;
const NOW_A3 = Date.UTC(2027, 0, 20, 3);   // 재현 시각(round-6 A3)

const win = (id, tz, schedule, { now, confirmedAt = now, keys = ['K1'], target = null } = {}) => ST.normalizeWindow({ id, name: 'n', reason: 'r', tz, vcenterId: 'vcA',
  target: target || { kind: 'server', keys }, schedule, scopes: { hold: true }, at: confirmedAt, confirmedAt });
const daily = (time, durMin) => ({ kind: 'weekly', days: all7, time, durMin });

/**
 * 독립 격자 — 후보 수명 전체(now − 1일 ~ 만료 · 400일)의 발생마다 그 발생과 겹치는 24시간 창의 시작을 30분 격자로 전부 센다. 기준점 · 빠른 길 · windowOver 를 쓰지 않는다
 *   (발생 세기만 judge.effectiveOccurrences 를 쓴다 — 일정 코어는 bmMaint8aSchedule 시험이 따로 고정한다).
 *   격자가 정확한 이유: 이 시험의 시간대(바르샤바 · 뉴욕 · 시드니 · 서울)는 오프셋 · 전환 폭이 정시 단위이고 시각은 :00/:30 · 길이는 30분 배수라 발생 끝점이 전부 30분 격자 위다 —
 *   덮임은 창 시작에 대해 조각 선형이고 꺾이는 점이 격자 위라 최대가 격자 점에서 나온다. 덮임 값도 30분 배수라 ‘12시간 초과’ = 12.5시간 이상(닫힌 끝점을 세도 답이 같다).
 * @returns {{cov:number, at:number|null}} 가장 큰 덮임(ms)과 그 창 시작
 */
function bruteCover(cand, all, now, { candUntil = Infinity } = {}) {
  const best = { cov: 0, at: null };
  if (!cand || cand.target?.kind !== 'server' || cand.deleted) return best;
  const vc = cand.vcenterId;
  const covers = (w, key) => w.vcenterId === vc && (w.target.kind === 'corp' || (w.target.kind === 'server' && w.target.keys.includes(key)));
  const live = all.filter((w) => w && w.id !== cand.id && !w.deleted && w.schedule);
  const exp = J.expiresAt(cand);
  const to = Math.min(now + 401 * DAY, exp == null ? Infinity : exp + DAY);
  const mine = J.effectiveOccurrences(cand, now - DAY, to).filter((o) => o.start < candUntil);
  const occCache = new Map();   // 창마다 수명 전체 발생을 한 번(값은 세는 구간과 무관하다)
  const occAll = (w) => { let v = occCache.get(w); if (!v) { v = J.effectiveOccurrences(w, now - 3 * DAY, to + 2 * DAY); occCache.set(w, v); } return v; };
  for (const key of cand.target.keys) {
    const ps = live.filter((w) => covers(w, key));
    if (!ps.length) continue;
    const grp = [cand, ...ps].map(occAll);
    for (const o of mine) {
      const lo = o.start - DAY; const hi = o.end + DAY;
      const iv = grp.flatMap((list) => list.filter((x) => x.end > lo && x.start < hi)).map((x) => [Math.max(lo, x.start), Math.min(hi, x.end)]).sort((a, b) => a[0] - b[0]);
      const m = [];
      for (const x of iv) { const l = m[m.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else m.push([...x]); }
      for (let s0 = lo; s0 <= o.end; s0 += 30 * MIN) {
        let cov = 0;
        for (const [a, b] of m) cov += Math.max(0, Math.min(s0 + DAY, b) - Math.max(s0, a));
        if (cov > best.cov) { best.cov = cov; best.at = s0; }
      }
    }
  }
  return best;
}
const brute = (cand, all, now, o) => bruteCover(cand, all, now, o).cov > LIMIT;
async function allModes(cand, group, now, memo = ST.coverMemo(now)) {
  return {
    fast: ST.coverNeedsOwner(cand, group, now),
    exact: ST.coverNeedsOwner(cand, group, now, { exact: true }),
    memo: ST.coverNeedsOwner(cand, group, now, { memo }),
    async: await ST.coverNeedsOwnerAsync(cand, group, now, { memo, yieldFn: async () => {} }),
  };
}

test('A3 tzTransitions — 2027 전환 시각(바르샤바 · 뉴욕 · 시드니 · 로드하우 30분) · 서울 없음 · 모르는 시간대 빈 목록', () => {
  const y0 = Date.UTC(2027, 0, 1); const y1 = Date.UTC(2028, 0, 1);
  const iso = (tz) => S.tzTransitions(tz, y0, y1).map((x) => new Date(x).toISOString());
  assert.deepEqual(iso('Europe/Warsaw'), ['2027-03-28T01:00:00.000Z', '2027-10-31T01:00:00.000Z']);
  assert.deepEqual(iso('America/New_York'), ['2027-03-14T07:00:00.000Z', '2027-11-07T06:00:00.000Z']);
  assert.deepEqual(iso('Australia/Sydney'), ['2027-04-03T16:00:00.000Z', '2027-10-02T16:00:00.000Z']);
  assert.deepEqual(iso('Australia/Lord_Howe'), ['2027-04-03T15:00:00.000Z', '2027-10-02T15:30:00.000Z']);
  assert.deepEqual(iso('Asia/Seoul'), []);
  assert.deepEqual(S.tzTransitions('Bad/Zone', y0, y1), []);
  // 구간 끝 · 연도 경계 · 거꾸로 된 구간
  const w = Date.UTC(2027, 2, 28, 1);
  assert.deepEqual(S.tzTransitions('Europe/Warsaw', w, w + 1), [w], '시작 포함');
  assert.deepEqual(S.tzTransitions('Europe/Warsaw', w - DAY, w), [], '끝 제외');
  assert.deepEqual(S.tzTransitions('Europe/Warsaw', w, w - 1), []);
  assert.equal(S.tzTransitions('Europe/Warsaw', Date.UTC(2026, 6, 1), Date.UTC(2028, 6, 1)).length, 4, '해를 넘는 구간');
  // 전환 직전 · 직후 오프셋이 실제로 다르다(분 단위 정확)
  for (const tz of ['Europe/Warsaw', 'America/New_York', 'Australia/Sydney']) {
    for (const x of S.tzTransitions(tz, y0, y1)) assert.notEqual(S.utcToLocal(tz, x - MIN).offsetMin, S.utcToLocal(tz, x).offsetMin, `${tz} ${new Date(x).toISOString()}`);
  }
});

test('A3 재현 — 바르샤바 매일 10:00 6h + 서울 매일 23:00 7h(now 2027-01-20): 전환 뒤 13h 를 합 규칙이 본다(예전 false · 네 경로 · 두 방향)', async () => {
  const now = NOW_A3;
  const W = win('mw-warsaw0001', 'Europe/Warsaw', daily('10:00', 360), { now });
  const K = win('mw-seoul00001', 'Asia/Seoul', daily('23:00', 420), { now });
  // 독립 격자로 본 사실 — 겨울(전환 전) 최대 12.0h · 3-28 전환 뒤 13.0h · 만료 2027-04-22
  assert.equal(J.expiresAt(W), Date.UTC(2027, 3, 22, 3), '만료 92일');
  assert.equal(bruteCover(W, [K], now, { candUntil: Date.UTC(2027, 2, 27) }).cov, 12 * HOUR, '전환 전 최대 12h(넘지 않음)');
  const b = bruteCover(W, [K], now);
  assert.equal(b.cov, 13 * HOUR, '전환 뒤 13h');
  assert.ok(b.at >= Date.UTC(2027, 2, 28, 1) - DAY, `최대 덮임 창은 전환 둘레 뒤(${new Date(b.at).toISOString()})`);
  for (const [cand, peer] of [[W, K], [K, W]]) {
    const r = await allModes({ ...cand, confirmedAt: now }, [peer], now);
    assert.deepEqual(r, { fast: true, exact: true, memo: true, async: true }, `재현 r6 A3 — 예전 false(${cand.tz} 후보)`);
  }
  // 같은 판정을 전환 뒤(3-30)에 부르면 예전에도 true 였다(그대로)
  const later = Date.UTC(2027, 2, 30, 3);
  assert.equal(ST.coverNeedsOwner(win('mw-warsaw0001', 'Europe/Warsaw', daily('10:00', 360), { now: later }), [win('mw-seoul00001', 'Asia/Seoul', daily('23:00', 420), { now: later })], later), true);
  // 대조 ① 동료(서울)가 전환 전에 만료되면 false(02-21 만료 — 전환 뒤 겹침이 없다) · 독립 격자도 false
  const Kold = win('mw-seoul00002', 'Asia/Seoul', daily('23:00', 420), { now, confirmedAt: now - 60 * DAY });
  assert.deepEqual(await allModes(W, [Kold], now), { fast: false, exact: false, memo: false, async: false });
  assert.equal(brute(W, [Kold], now), false);
  // 대조 ② 같은 두 창을 둘 다 서울 시간대로(전환 없음 — 합 12h 그대로) → false
  const W2 = win('mw-seoul00003', 'Asia/Seoul', daily('18:00', 360), { now });
  assert.deepEqual(await allModes(W2, [K], now), { fast: false, exact: false, memo: false, async: false });
  assert.equal(brute(W2, [K], now), false);
});

test('A3 수명 끝 직전 전환 — 후보 만료 뒤 2일 안의 전환도 본다(마지막 발생이 전환 뒤 동료와 섞인다)', async () => {
  const now = NOW_A3;
  // 서울 후보의 만료 = 2027-03-27 22:00Z(전환 3-28 01:00Z 의 3시간 전) — 마지막 발생 3-27 14~21Z 와 전환 뒤 바르샤바 3-28 08~14Z 가 한 24시간에 13h
  const exp = Date.UTC(2027, 2, 27, 22);
  const K = win('mw-seoul00010', 'Asia/Seoul', daily('23:00', 420), { now, confirmedAt: exp - 92 * DAY });
  const W = win('mw-warsaw0010', 'Europe/Warsaw', daily('10:00', 360), { now });
  assert.equal(J.expiresAt(K), exp);
  assert.equal(bruteCover(K, [W], now).cov, 13 * HOUR, '독립 격자 13h');
  assert.deepEqual(await allModes(K, [W], now), { fast: true, exact: true, memo: true, async: true }, '전환이 후보 만료 뒤(3시간)여도 본다');
});

test('A3 무작위 대조 — 빠른 = 정확 = 메모 = 비동기 = 독립 격자(바르샤바 · 뉴욕 · 시드니 · 서울 · 전환이 36~92일 뒤인 now 포함)', async () => {
  let seed = 20261115;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const TZS = ['Europe/Warsaw', 'America/New_York', 'Australia/Sydney', 'Asia/Seoul'];
  // 전환이 36일 밖 · 수명 안인 시각(01-20 · 02-05 · 08-10) · 36일 안(03-10 · 09-01) · 실제 시각(T0)
  const NOWS = [NOW_A3, Date.UTC(2027, 1, 5, 15), Date.UTC(2027, 7, 10, 9), Date.UTC(2027, 2, 10, 12), Date.UTC(2027, 8, 1, 0), T0];
  const KEYSETS = [['P1'], ['P2'], ['P1', 'P2']];
  const hm = (ms, tz) => S.fmtLocal(tz, ms).slice(11, 16);
  const general = (i, now) => {
    const tz = pick(TZS); const kind = pick(['weekly', 'weekly', 'weekly', 'monthly', 'once']);
    const time = `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${pick(['00', '30'])}`;
    let schedule;
    if (kind === 'once') { const st = now + Math.floor((rnd() * 90 - 2) * 24) * HOUR; const len = (1 + Math.floor(rnd() * 24)) * HOUR; schedule = { kind, start: S.fmtLocal(tz, st).replace(' ', 'T'), end: S.fmtLocal(tz, st + len).replace(' ', 'T') }; }
    else if (kind === 'weekly') schedule = { kind, days: all7.filter(() => rnd() < 0.6).concat([Math.floor(rnd() * 7)]), time, durMin: 30 * (1 + Math.floor(rnd() * 24)) };
    else schedule = { kind, nth: 1 + Math.floor(rnd() * 5), weekday: Math.floor(rnd() * 7), time, durMin: 30 * (1 + Math.floor(rnd() * 24)) };
    const target = rnd() < 0.15 ? { kind: 'corp' } : { kind: 'server', keys: pick(KEYSETS) };
    return ST.normalizeWindow({ id: `mw-r6y${String(i).padStart(7, '0')}`, name: 'p', reason: 'p', tz, vcenterId: 'vcA', target, schedule, scopes: { hold: true },
      at: now - 100 * DAY, confirmedAt: now - Math.floor(rnd() * 95) * DAY });
  };
  // 경계 쌍 — 두 매일 창을 서로 다른 시간대에 이어 붙여(지금 UTC 기준 간격 −1h ~ +1h · 합 11.5~12.5h) 전환이 합을 넘기거나 되돌리게 한다
  const pair = (i, now) => {
    const tzA = pick(TZS); let tzB = pick(TZS); if (tzB === tzA) tzB = TZS[(TZS.indexOf(tzA) + 1) % TZS.length];
    const dA = 30 * (8 + Math.floor(rnd() * 9)); const dB = Math.max(30, 30 * pick([23, 24, 25]) - dA);
    const stA = now + (2 + Math.floor(rnd() * 20)) * HOUR;
    const stB = stA + dA * MIN + pick([-1, 0, 0, 1]) * HOUR;
    const mk = (j, tz, st, d, ageDays) => ST.normalizeWindow({ id: `mw-r6y${String(i).padStart(6, '0')}${j}`, name: 'q', reason: 'q', tz, vcenterId: 'vcA', target: { kind: 'server', keys: ['P1'] },
      schedule: { kind: 'weekly', days: rnd() < 0.7 ? all7 : all7.filter(() => rnd() < 0.6).concat([Math.floor(rnd() * 7)]), time: hm(st, tz), durMin: d }, scopes: { hold: true }, at: now - 100 * DAY, confirmedAt: now - ageDays * DAY });
    return [mk('a', tzA, stA, dA, pick([0, 0, 10, 40, 80])), mk('b', tzB, stB, dB, pick([0, 0, 30, 60, 85]))];
  };
  let n = 0; let trues = 0; let dstOnly = 0;
  for (let c = 0; c < 140; c += 1) {
    const now = NOWS[c % NOWS.length];
    const group = (c % 2 ? pair(c, now) : []).concat(Array.from({ length: (c % 2 ? 0 : 2) + Math.floor(rnd() * 3) }, (_, i) => general(c * 10 + i, now))).filter(Boolean);
    const memo = ST.coverMemo(now);
    for (const w of group.filter((x) => x.target.kind === 'server').slice(0, 3)) {
      const cand = rnd() < 0.5 ? { ...w, confirmedAt: now } : w;   // 재확인(지금) · 고치기(옛 확인 시각 — 수명 끝이 전환 둘레에 걸린다)
      const truth = brute(cand, group, now);
      const tag = `사례 ${c}(now ${new Date(now).toISOString()}): ${JSON.stringify(group.map((x) => [x.id, x.tz, x.target, x.schedule, x.confirmedAt - now]))} 후보 ${cand.id}`;
      const r = await allModes(cand, group, now, memo);
      assert.deepEqual(r, { fast: truth, exact: truth, memo: truth, async: truth }, tag);
      n += 1; if (truth) trues += 1;
      if (truth && !brute(cand, group, now, { candUntil: now + 36 * DAY })) dstOnly += 1;   // 36일 뒤에만 넘는 사례(예전 기준점 밖)
    }
  }
  // 실측(이 판): 362 후보 · 참 220 · 36일 뒤에만 넘는 사례 23(예전 기준점이면 거짓으로 답했을 사례)
  assert.ok(n >= 250 && trues >= 40 && n - trues >= 40, `참 · 거짓 둘 다 충분히(${trues}/${n})`);
  assert.ok(dstOnly >= 10, `36일 뒤(전환 뒤)에만 넘는 사례가 충분히 섞였다(${dstOnly})`);
});

test('A3 비용 — 목록 꼴(비소유자 canConfirm · 메모 · 200창 · 키 50 · 4개 시간대 · 거짓 경로): 전환 셋 기준점 추가분이 서울만(전환 없음) 대비 2.5배 이하', async () => {
  const { bmMaintList } = await import('../src/routes/api/bmMaint.js');
  const { createYielder } = await import('../src/util/timeSlice.js');
  const now = NOW_A3;
  const OFF = { 'Europe/Warsaw': 1, 'America/New_York': -5, 'Australia/Sydney': 11, 'Asia/Seoul': 9 };
  const listMs = async (tzs) => {
    const items = [];
    for (let i = 0; i < 200; i += 1) {
      const tz = tzs[i % tzs.length]; const key = `K${(i % 50) + 1}`;
      const lh = (1 + Math.floor(i / 50) + OFF[tz] + 24) % 24;   // 같은 키 4창이 지금 UTC 01~07 시에 겹친다(합 < 12h · 빠른 길 상한 24h 라 기준점을 다 센다)
      items.push({ id: `mw-c6y${String(i).padStart(6, '0')}`, name: `w${i}`, reason: 'r', tz, vcenterId: 'vcA', target: { kind: 'server', keys: [key], names: [key] },
        schedule: { kind: 'weekly', days: all7, time: `${String(lh).padStart(2, '0')}:00`, durMin: 180 }, scopes: { alerts: true, hold: true }, by: 'op', at: now - 10 * DAY, rev: 1, approvedBy: '', confirmedAt: now - 10 * DAY, edits: [] });
    }
    fs.writeFileSync(path.join(DIR, 'maintenance-windows.json'), JSON.stringify({ v: 1, seq: 400, items }));
    ST._resetMaintStoreForTest();
    const run = async () => {
      const t0 = performance.now();
      const r = await bmMaintList({ user: { username: 'opa', role: 'operator', scope: null }, query: {} }, { vcenters: [{ id: 'vcA' }] },
        { now: () => now, currentTargets: async () => ({ targets: [] }), listEdgeBmUsage: async () => [], ownerTier: async () => false, minEdgeVersion: async () => '0', yielder: () => createYielder(15) });
      assert.equal(r.windows.length, 200); assert.equal(r.windows.filter((w) => w.canConfirm).length, 200, '거짓 경로(합 < 12h — 전부 재확인 가능)');
      return performance.now() - t0;
    };
    await run();
    return Math.min(await run(), await run());
  };
  // 6회차 Y 재확인 Y2: 두 꼴을 번갈아 두 번씩 재고 각자 최소값을 비교한다 — 한 번씩 차례로 재면 그 사이 러너 부하가 바뀔 때 비율이 흔들렸다(부하 러너 4회 중 2회 실패 재현)
  const ms = { multi: [], seoul: [] };
  for (let k = 0; k < 2; k += 1) {
    ms.multi.push(await listMs(['Europe/Warsaw', 'America/New_York', 'Australia/Sydney', 'Asia/Seoul']));
    ms.seoul.push(await listMs(['Asia/Seoul']));
  }
  const multi = Math.min(...ms.multi); const seoul = Math.min(...ms.seoul);
  // 실측(이 컨테이너 · 기준판 → 고친 판): 4개 시간대 0.93~1.05s → 1.35~1.44s(전환 3개 · 전환 하나당 약 130ms) · 서울만 0.88~1.19s(그대로 — 전환 없음)
  assert.ok(multi <= 2.5 * seoul + 150, `4개 시간대 ${Math.round(multi)}ms · 서울만 ${Math.round(seoul)}ms`);
  ST._resetMaintStoreForTest();
  fs.rmSync(path.join(DIR, 'maintenance-windows.json'), { force: true });
});

/* ── 실제 라우터(정비 창 쓰기 · 목록 · 재확인) — deps.now 로 재현 시각을 준다 ── */
async function setup(t, now) {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-a2', name: 'bm-a2', host: '127.0.0.2', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a1', name: 'bm-a1', serviceTag: 'MTAGA1', vcenterId: 'vcA' },
    { serverId: 's-a2', name: 'bm-a2', serviceTag: 'MTAGA2', vcenterId: 'vcA' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }] });
  const express = (await import('express')).default;
  const { registerBmMaint } = await import('../src/routes/api/bmMaint.js');
  const USERS = { opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } }, own: { username: 'own', role: 'admin', scope: null } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  const r = express.Router();
  registerBmMaint(r, { now: () => now });
  app.use('/api', r);
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage/maintenance`;
  const call = async (u, method, p, body) => { const x = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: x.status, body: await x.json() }; };
  return { call };
}
const srvWin = (key, name, tz, schedule) => ({ name, reason: '정기 점검', tz, target: { kind: 'server', keys: [key] }, vcenterId: 'vcA', schedule, scopes: { alerts: true, hold: true, focus: true } });

test('A3 실제 라우터 — 운영자 쓰기 403 · 목록 canConfirm = 재확인 라우트(now 2027-01-20 · 예전 200 · true)', async (t) => {
  ST._resetMaintStoreForTest();
  for (const f of ['maintenance-windows.json', 'maintenance-windows-deployed.json']) fs.rmSync(path.join(DIR, f), { force: true });
  const now = NOW_A3;
  const { call } = await setup(t, now);
  // 쓰기 — 운영자가 서울 창을 걸고(혼자 — 200) 바르샤바 창을 더하면 전환 뒤 13h → 소유자 등급
  assert.equal((await call('opA', 'POST', '', srvWin('MTAGA1', '서울 야간', 'Asia/Seoul', daily('23:00', 420)))).status, 200);
  const w = await call('opA', 'POST', '', srvWin('MTAGA1', '바르샤바 오전', 'Europe/Warsaw', daily('10:00', 360)));
  assert.equal(w.status, 403, `재현 r6 A3 — 예전 200 · ${JSON.stringify(w.body)}`); assert.equal(w.body.code, 'owner-required');
  assert.equal((await call('own', 'POST', '', srvWin('MTAGA1', '바르샤바 오전', 'Europe/Warsaw', daily('10:00', 360)))).status, 200, '소유자는 그대로');
  // 목록 · 재확인 — 만료된 바르샤바 창(93일 전 확인) 옆에 살아 있는 서울 창
  const K = await ST.addWindow(srvWin('MTAGA2', '서울 야간', 'Asia/Seoul', daily('23:00', 420)), { by: 'opa', now });
  const W = await ST.addWindow(srvWin('MTAGA2', '바르샤바 오전', 'Europe/Warsaw', daily('10:00', 360)), { by: 'opa', now: now - 93 * DAY });
  const l = await call('opA', 'GET', '');
  assert.equal(l.status, 200);
  const row = l.body.windows.find((x) => x.id === W.id);
  assert.equal(row.status, 'expired');
  assert.equal(row.canConfirm, false, '재현 r6 A3 — 예전 true(누르면 200 — 전환 뒤 13h 억제)'); assert.equal(row.confirmOwner, 'combined');
  const cf = await call('opA', 'POST', `/${W.id}/confirm`, { rev: W.rev });
  assert.equal(cf.status, 403); assert.equal(cf.body.code, 'owner-required');
  assert.equal(l.body.windows.find((x) => x.id === K.id).canConfirm, true, '서울 창은 재확인 가능(바르샤바가 만료라 합에 없다)');
});

test('A3 재확인 Y1 — 전환 둘레 기준점은 지난 발생(now − 1일 이전)을 세지 않는다: 앞으로 11.5h 인 창이 지난 목요일 12.5h 때문에 403 이 되지 않는다', async (t) => {
  ST._resetMaintStoreForTest();
  for (const f of ['maintenance-windows.json', 'maintenance-windows-deployed.json']) fs.rmSync(path.join(DIR, f), { force: true });
  const now = Date.UTC(2027, 2, 27, 23);   // 바르샤바 전환(03-28 01:00Z) 2시간 전
  const { call } = await setup(t, now);
  // 소유자: 바르샤바 매일 01:30 5.5h(전환 전 00:30~06:00Z · 뒤 23:30~05:00Z)
  assert.equal((await call('own', 'POST', '', srvWin('MTAGA1', '바르샤바 새벽', 'Europe/Warsaw', daily('01:30', 330)))).status, 200);
  // 운영자: 뉴욕 목 13:30 8h(17:30~01:30Z) — 지난 목요일(03-25 · 전환 전)만 12.5h, 앞으로의 목요일은 11.5h
  const w = await call('opA', 'POST', '', srvWin('MTAGA1', '뉴욕 목요일', 'America/New_York', { kind: 'weekly', days: [4], time: '13:30', durMin: 480 }));
  assert.equal(w.status, 200, `재현 r6 Y1 — 수정 판 403(지난 발생을 기준점에) · ${JSON.stringify(w.body)}`);
});

/* ── PowerCap 신선도 하나(hwFacts capStateAt · invFreshAt) ── */
const HF = await import('../src/bmusage/hwFacts.js');
const PS = await import('../src/bmusage/powerSources.js');
const AG = await import('../src/bmusage/powerAgg.js');
const PA = await import('../src/bmusage/powerAlerts.js');
const PR = await import('../src/bmusage/perfRules.js');

test('PowerCap capStateAt — set · unset 모두 2시간 · 없는 시각은 stale · 못 읽음은 unread(순수)', () => {
  const now = T0;
  assert.equal(HF.INV_FRESH_MS, 2 * HOUR);
  assert.deepEqual(HF.capStateAt({ state: 'set', limitWatts: 500 }, now - HOUR, now), { state: 'set', limitWatts: 500, at: now - HOUR });
  assert.deepEqual(HF.capStateAt({ state: 'set', limitWatts: 500 }, now - 3 * DAY, now), { state: 'stale', limitWatts: null, at: now - 3 * DAY });
  assert.deepEqual(HF.capStateAt({ state: 'unset', limitWatts: null }, now - 3 * DAY, now), { state: 'stale', limitWatts: null, at: now - 3 * DAY });
  assert.deepEqual(HF.capStateAt({ state: 'unset', limitWatts: null }, now - MIN, now), { state: 'unset', limitWatts: null, at: now - MIN });
  assert.equal(HF.capStateAt({ state: 'set', limitWatts: 500 }, null, now).state, 'stale', '읽은 시각이 없으면 지금 사실이 아니다');
  assert.equal(HF.capStateAt({ state: 'set', limitWatts: 500 }, '', now).state, 'stale', "'' 은 0 이 아니다(numOrNull)");
  assert.equal(HF.capStateAt({ state: 'set', limitWatts: 0 }, now, now).state, 'unread', '봉투가 set 인데 값이 없으면 못 읽음(예전과 같음)');
  assert.equal(HF.capStateAt({ state: 'unread' }, now, now).state, 'unread');
  assert.equal(HF.capStateAt(null, now, now).state, 'unread');
  assert.equal(HF.capStateAt({ state: 'set', limitWatts: 500 }, now - 2 * HOUR, now).state, 'set', '경계 2시간 = 신선(예전 두 갈래와 같은 ≤)');
  assert.equal(HF.capStateAt({ state: 'set', limitWatts: 500 }, now - 2 * HOUR - 1, now).state, 'stale');
  // 하드웨어 U 는 같은 판정으로 인벤토리 전체를 버린다(상태 셋 — set · unset · unread)
  const inv = { powerCap: { limitWatts: 500 }, collectedAt: now - 3 * DAY };
  assert.equal(HF.shapeHwFacts({ inv, power: { watts: 300, ts: now - MIN } }, { now }).power.capState, 'unread', '하드웨어 U — 낡은 인벤토리 = 못 읽음(그대로)');
  assert.equal(HF.shapeHwFacts({ inv: { ...inv, collectedAt: now - MIN }, power: { watts: 300, ts: now - MIN } }, { now }).power.capState, 'set');
});

test('PowerCap 실제 powerSources — 엣지 사본 · 이 노드 · 봉투가 같은 사실에 같은 상태(3일 전 = stale · 신선 = set/unset) · 알림 경로 판정이 바뀐다', async () => {
  const now = T0;
  const IC = await import('../src/idrac/invCache.js');
  IC.setInventory('r6y-loc', { powerCap: { limitWatts: 500 }, collectedAt: now - 3 * DAY });
  IC.setInventory('r6y-fresh', { powerCap: { limitWatts: 500 }, collectedAt: now - 5 * MIN });
  const real = await PS.powerSources({ now });
  const edgeOld = { id: 'edge:1', serviceTag: 'T1', remote: true, inv: { powerCap: { limitWatts: 500 }, collectedAt: now - 3 * DAY } };
  const edgeNew = { id: 'edge:2', serviceTag: 'T2', remote: true, inv: { powerCap: { limitWatts: 500 }, collectedAt: now - 5 * MIN } };
  const edgeNoAt = { id: 'edge:4', serviceTag: 'T4', remote: true, inv: { powerCap: { limitWatts: 500 } } };
  // 원천은 원본을 넘긴다(신선도는 집계가 — 예전: 로컬 낡음만 null)
  assert.equal(real.inventoryOf({ id: 'r6y-loc' }).collectedAt, now - 3 * DAY);
  assert.equal(real.inventoryOf(edgeOld).powerCap.limitWatts, 500);
  const measured = [
    { serverId: 'ome:1', watts: 495, ts: now - MIN, vcenterId: 'vcA', serviceTag: 'T1', source: 'ome' },
    { serverId: 'ome:2', watts: 495, ts: now - MIN, vcenterId: 'vcA', serviceTag: 'T2', source: 'ome' },
    { serverId: 'r6y-loc', watts: 495, ts: now - MIN, vcenterId: 'vcA', serviceTag: 'T3', source: 'idrac' },
    { serverId: 'ome:4', watts: 495, ts: now - MIN, vcenterId: 'vcA', serviceTag: 'T4', source: 'ome' },
    { serverId: 'r6y-fresh', watts: 495, ts: now - MIN, vcenterId: 'vcA', serviceTag: 'T5', source: 'idrac' },
  ];
  const deps = { ...real, measured: async () => measured, analysisServers: async () => [edgeOld, edgeNew, { id: 'r6y-loc', serviceTag: 'T3' }, edgeNoAt, { id: 'r6y-fresh', serviceTag: 'T5' }],
    fanFaults: async () => [], powerDb: async () => ({ hourlyStats: () => [] }), sensorLatest: () => null, temps: { classify: () => 'other', maxAgeOf: () => 15 * MIN }, yielder: async () => {} };
  const targets = [
    { key: 'K1', name: 'bm-1', vcenterId: 'vcA', serviceTag: 'T1', idrac: null, paths: [] },
    { key: 'K2', name: 'bm-2', vcenterId: 'vcA', serviceTag: 'T2', idrac: null, paths: [] },
    { key: 'K3', name: 'bm-3', vcenterId: 'vcA', serviceTag: 'T3', idrac: { regId: 'r6y-loc' }, paths: ['idrac'] },
    { key: 'K4', name: 'bm-4', vcenterId: 'vcA', serviceTag: 'T4', idrac: null, paths: [] },
    { key: 'K5', name: 'bm-5', vcenterId: 'vcA', serviceTag: 'T5', idrac: { regId: 'r6y-fresh' }, paths: ['idrac'] },
  ];
  const edgeT = [
    { key: 'E1', name: 'e1', vcenterId: 'vcB', via: 'edge', edgeCap: { state: 'set', limitWatts: 500, at: now - 3 * DAY } },
    { key: 'E2', name: 'e2', vcenterId: 'vcB', via: 'edge', edgeCap: { state: 'unset', limitWatts: null, at: now - 3 * DAY } },
    { key: 'E3', name: 'e3', vcenterId: 'vcB', via: 'edge', edgeCap: { state: 'set', limitWatts: 500, at: now - 5 * MIN } },
    { key: 'E4', name: 'e4', vcenterId: 'vcB', via: 'edge', edgeCap: { state: 'old-version' } },
  ];
  const sv = Object.fromEntries((await AG.gatherPower({ targets: [...targets.map((x) => ({ ...x, node: '', via: 'local' })), ...edgeT], deps, now, withMonth: false })).map((x) => [x.key, x]));
  const st = (k) => [sv[k].capState, sv[k].capW];
  assert.deepEqual(st('K1'), ['stale', null], '재현 r6 — 엣지 사본 3일 전: 예전 set 500');
  assert.deepEqual(st('K3'), ['stale', null], '이 노드 3일 전: 예전 unread(같은 사실 · 같은 상태로)');
  assert.deepEqual(st('E1'), ['stale', null], '봉투 3일 전 set: stale(그대로)');
  assert.deepEqual(st('E2'), ['stale', null], '봉투 3일 전 unset: 예전 unset(신선도를 안 봤다)');
  assert.deepEqual(st('K4'), ['stale', null], '엣지 사본에 읽은 시각이 없으면 지금 사실이 아니다');
  assert.deepEqual(st('K2'), ['set', 500]); assert.deepEqual(st('K5'), ['set', 500]); assert.deepEqual(st('E3'), ['set', 500]);
  assert.equal(st('E4')[0], 'old-version');
  // 화면 — 걸림 목록(capHit)에 낡은 상한이 없다(예전: K1 이 걸림으로 올랐다)
  const ag = AG.aggregatePower(Object.values(sv), { racks: [], cfg: { capHitPct: 98, inletWarnC: 27 } });
  assert.deepEqual(ag.capHit.map((x) => x.key).sort(), ['K2', 'K5'], '신선한 상한만(E3 은 전력 표본이 없어 걸림 판정 없음)');
  // 알림 — 실제 powerAlertItems(judgeOf · powerCondition). OME 가 재는 서버는 중앙이 판정 노드다 — 예전에는 낡은 상한으로 걸림(true)
  const rules = PR.normalizeRules({ rules: { powerCap: { on: true, channels: ['email'] } } }, { strict: true }).value;
  const items = await PA.powerAlertItems({ targets, rules, now, deps: { sources: async () => deps, judgeCtx: async () => ({ self: 'central', isEdge: false, corpOwner: () => '' }) } });
  const cond = Object.fromEntries(items.map((x) => [x.key, x.release ? `release:${x.release.reason}` : PA.powerCondition('powerCap', x)]));
  assert.deepEqual(cond, { K1: null, K2: true, K3: null, K4: null, K5: true }, '재현 r6 — 예전 K1 true(3일 전 상한으로 알림)');
  // 엣지 사본 전력(remote)이면 판정 노드가 엣지 — 중앙은 넘김(그대로 · 화면 걸림 목록만 바뀐다)
  const items2 = await PA.powerAlertItems({ targets: [targets[0]], rules, now, deps: { sources: async () => ({ ...deps, measured: async () => [{ ...measured[0], source: 'remote', dbKey: 'rmt:bm-1' }] }), judgeCtx: async () => ({ self: 'central', isEdge: false, corpOwner: () => '' }) } });
  assert.equal(items2[0].release?.reason, 'source-edge');
});

test('PowerCap 소스 — 신선도 판정은 hwFacts 하나(powerSources 는 거르지 않고 · powerAgg 는 시각 차를 직접 계산하지 않는다)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = (f) => stripComments(fs.readFileSync(new URL(`../src/bmusage/${f}`, import.meta.url), 'utf8'));
  const ps = src('powerSources.js'); const ag = src('powerAgg.js'); const hf = src('hwFacts.js');
  assert.ok(!/collectedAt|INV_FRESH_MS/.test(ps), 'powerSources 에 신선도 판정 없음');
  assert.ok(!/INV_FRESH_MS/.test(ag) && !/now\s*-\s*capAt/.test(ag), 'powerAgg 에 두 번째 신선도 판정 없음');
  assert.equal((ag.match(/capStateAt\(/g) || []).length, 2, '두 갈래(봉투 · 인벤토리) 모두 capStateAt');
  assert.ok(/invFreshAt\(inv0\.collectedAt/.test(hf), '하드웨어 U 도 같은 invFreshAt');
});
