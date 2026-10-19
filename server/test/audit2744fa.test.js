/**
 * v2.744 최종 검토 FA — FC HBA 노트·각주가 **최종 대표값과 알림 판정**(row.hba_pct · srcOf.hba · hba_over)과 같은 말을 하는가.
 *
 *  RV-1  OS 경로 노트(fcRateNotes(perFc))가 iDRAC 경로보다 먼저 만들어져, OS 포트가 전부 사용률 없음(명목 초과)일 때
 *        '나머지 포트에 사용률이 없어 대표값은 비웠습니다 · 알림은 초과로 보지 않습니다' 라고 적었다 — 같은 주기에 iDRAC FC 행이
 *        대표값을 채우거나(hba_pct 30, src idrac) hba_over 를 세웠는데도. 각주 근거(hbaBasis)도 OS 포트가 있으면 OS 를 세어
 *        '나머지 포트 기준 · 알림은 초과로 보지 않습니다' 라고 말했다.
 *  RV-2  (웹 사본은 audit2744fa.test.js(웹)) — 같은 서버에 데이터율을 크게 넘은 포트가 있으면 명목 초과 문구가 바로 위 줄과 모순됐다.
 *        서버 각주(hbaBasis → hbaBasisFootnote)는 화면에 실제로 보이므로 여기서도 대조한다.
 *
 * 값·알림 계산은 바꾸지 않는다(그것은 맞다) — 이 테스트는 문구가 그 값과 어긋나지 않는지만 본다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildUsage } = await import('../src/bmusage/usage.js');
const fcRate = await import('../src/bmusage/parse/fcRate.js');
const { fcRateNotes, fcRepresentative } = fcRate;
const { recordHbaBasis, hbaBasisFor, _resetHbaBasisForTest } = await import('../src/bmusage/hbaBasis.js');
const { evaluateRows } = await import('../src/bmusage/alertRules.js');
const web = await import('../../web/src/views/tools/bmUsageText.js');

const T0 = 1_700_000_000_000;
const NOW = T0 + 300_000;
const TG = { key: 'FA1', name: 'srv-fa', vcenterId: 'vc1' };
const hbaRow = (host, speedRaw, bitsPerSec, txBytes) => ({ host, state: 'Online', speedRaw, bitsPerSec, txBytes, rxBytes: 0 });
const osAt = (at, hbas) => ({ ok: true, osKind: 'linux', at, mem: { usedPct: 10 }, mounts: [], read: [], missing: [], absent: [], counters: { hbas } });

/** 포트 종류(방향당 B/s 를 tx 에 싣는다) — 16G 데이터율 1,600MB/s · 10G 는 표에 없어 명목 1,250MB/s. */
const KIND = {
  nom104: { speedRaw: '10 Gbit', bits: 10e9, bps: 1.3e9 },      // 명목 기준 104% → 사용률 비움(nominalOver)
  nom50: { speedRaw: '10 Gbit', bits: 10e9, bps: 0.625e9 },     // 명목 기준 50%
  dr30: { speedRaw: '16 Gbit', bits: 16e9, bps: 0.48e9 },       // 데이터율 30%
  dr105: { speedRaw: '16 Gbit', bits: 16e9, bps: 1.68e9 },      // 데이터율 105% → 100 표시(clamped)
  dr156: { speedRaw: '16 Gbit', bits: 16e9, bps: 2.5e9 },       // 데이터율 156% → 사용률 비움 + 서버 대표값 비움 + 알림 초과
  nospeed: { speedRaw: 'unknown', bits: null, bps: 1e8 },       // 속도 미상 — 사용률 없음
};

/** 5분 간격 두 주기 — os·idrac 은 KIND 이름 목록. */
function cycle(osKinds = [], idracKinds = []) {
  const osPorts = osKinds.map((k, i) => ({ host: `host${i + 1}`, ...KIND[k] }));
  const idPorts = idracKinds.map((k, i) => ({ host: `FC.Slot.${i + 1}-1`, ...KIND[k] }));
  const prev = {
    at: T0,
    counters: osPorts.length ? { hbas: osPorts.map((p) => hbaRow(p.host, p.speedRaw, p.bits, 0)) } : null,
    idrac: idPorts.length ? { nics: [], fcs: idPorts.map((p) => ({ host: p.host, bitsPerSec: p.bits, rxBytes: 0, txBytes: 0, at: T0 })) } : null,
  };
  const os = osPorts.length ? osAt(NOW, osPorts.map((p) => hbaRow(p.host, p.speedRaw, p.bits, p.bps * 300))) : null;
  const idrac = idPorts.length ? { ok: true, at: NOW, nics: [], fcs: idPorts.map((p) => ({ host: p.host, bitsPerSec: p.bits, rxBytes: 0, txBytes: p.bps * 300, at: NOW })) } : null;
  return buildUsage({ target: TG, os, idrac, prev, now: NOW, intervalMs: 300_000 });
}

const CFG = { enabled: true, pct: 90, sustainMin: 15, repeatHours: 6, intervalMs: 300_000 };
/** 알림 판정에서 HBA 가 초과로 보이는가(6주기 지속). */
function hbaAlertOver(row) {
  let st = {}; let over = false;
  for (let i = 0; i < 6; i++) {
    const r = evaluateRows([{ ...row, ts: NOW + i * 300_000 }], st, CFG, NOW + i * 300_000);
    st = r.next;
    if (r.fires.some((f) => f.kind === 'over' && f.metric === 'hba_pct')) over = true;
  }
  return over;
}

const SAYS_REP_BLANK = /대표값(은|도|을)[^.]*비웠/;
const SAYS_NOT_OVER = '초과로 보지 않습니다';
const SAYS_OVER = '초과로 봅니다';
const footnoteOf = (b) => { _resetHbaBasisForTest(); recordHbaBasis('K', b, { at: NOW, ok: true }); return { basis: hbaBasisFor('K'), foot: web.hbaBasisFootnote([{ hbaBasis: hbaBasisFor('K') }]) }; };

// ───────────────────────────── RV-1 서버 노트 ─────────────────────────────

test('RV-1 ① OS 포트가 명목 초과뿐이고 iDRAC 이 대표값을 채우면 OS 노트는 \'대표값을 비웠다\' 가 아니라 iDRAC 으로 정했다고 말한다', () => {
  const b = cycle(['nom104'], ['dr30']);
  assert.equal(b.row.hba_pct, 30); assert.equal(b.srcOf.hba, 'idrac'); assert.equal(b.row.hba_over, undefined);
  const osNote = b.notes.find((x) => x.startsWith('FC 표준 데이터율 표에 없는 속도라 명목 속도'));
  assert.ok(osNote, JSON.stringify(b.notes));
  assert.ok(!SAYS_REP_BLANK.test(osNote), osNote);
  assert.ok(!osNote.includes('판정 보류'), osNote);
  assert.ok(osNote.includes('iDRAC'), osNote);
  assert.ok(osNote.includes(SAYS_NOT_OVER), '이 포트는 알림에서 초과로 보지 않는다 — 그대로 참이다');
});

test('RV-1 ② iDRAC 이 데이터율을 크게 넘어 hba_over 를 세우면 OS 노트도 \'알림은 초과로 보지 않습니다\' 라고 말하지 않는다', () => {
  const b = cycle(['nom104'], ['dr156']);
  assert.equal(b.row.hba_pct, null); assert.equal(b.row.hba_over, true);
  assert.ok(hbaAlertOver(b.row), '알림은 초과로 판정된다(값은 바꾸지 않았다)');
  assert.ok(!b.notes.some((x) => x.includes(SAYS_NOT_OVER)), JSON.stringify(b.notes));
  const osNote = b.notes.find((x) => x.startsWith('FC 표준 데이터율 표에 없는 속도라 명목 속도'));
  assert.ok(osNote && osNote.includes('iDRAC') && osNote.includes(SAYS_OVER), osNote);
  // iDRAC 노트는 예전 그대로 '대표값도 비웠습니다 · 알림은 초과로 봅니다'
  assert.ok(b.notes.some((x) => x.startsWith('iDRAC ') && x.includes('대표값도 비웠습니다')), JSON.stringify(b.notes));
});

test('RV-1 ③ iDRAC 이 없으면(또는 iDRAC 도 값이 없으면) 예전 \'판정 보류\' 문구 그대로 — 노트 순서도 그대로', () => {
  for (const id of [[], ['nospeed']]) {
    const b = cycle(['nom104'], id);
    assert.equal(b.row.hba_pct, null); assert.equal(b.row.hba_over, undefined);
    const osNote = b.notes.find((x) => x.startsWith('FC 표준 데이터율 표에 없는 속도라 명목 속도'));
    assert.ok(osNote.includes('판정 보류') && osNote.includes(SAYS_NOT_OVER), osNote);
  }
  // 순서: OS FC 노트는 iDRAC 경로 노트보다 앞이다(iDRAC 결과를 본 뒤 만들지만 예전 자리에 끼워 넣는다)
  const b = cycle(['nom104', 'nom50'], ['dr105']);
  const i = b.notes.findIndex((x) => x.startsWith('FC 표준 데이터율 표에 없는 속도라 명목 속도'));
  const i0 = b.notes.findIndex((x) => x.startsWith('FC 표준 데이터율 표에 없는 속도의 HBA'));
  const j = b.notes.findIndex((x) => x.startsWith('iDRAC '));
  assert.ok(i0 >= 0 && i > i0 && j > i, JSON.stringify(b.notes));
  assert.deepEqual(fcRateNotes(b.detail.fc), fcRateNotes(b.detail.fc, '', {}), '옵션 없이 부르면 예전과 같다(예전 호출부 호환)');
});

test('RV-1 ④ OS 값이 대표이면(나머지 OS 포트) 예전 문구 그대로 · 같은 OS 행에 데이터율 크게 초과가 있으면 \'다른 포트 때문에 비웠다\'', () => {
  const a = cycle(['nom104', 'dr30'], ['dr156']);
  assert.equal(a.row.hba_pct, 30); assert.equal(a.srcOf.hba, 'os');
  assert.ok(a.notes.some((x) => x.includes('나머지 포트 기준')), JSON.stringify(a.notes));
  const c = cycle(['nom104', 'dr156'], ['dr30']);
  assert.equal(c.row.hba_pct, null); assert.equal(c.row.hba_over, true);
  assert.ok(c.notes.some((x) => x.includes('다른 포트 때문에 비웠습니다')), JSON.stringify(c.notes));
  assert.ok(!c.notes.some((x) => x.includes(SAYS_NOT_OVER)), JSON.stringify(c.notes));
});

test('RV-1 ⑤ fcNominalRestKind — 서버 노트의 분기를 한 함수가 정한다(웹 사본이 같은 입력으로 대조한다)', () => {
  assert.equal(typeof fcRate.fcNominalRestKind, 'function');
  const rows = (ks) => cycle(ks, []).detail.fc;
  assert.equal(fcRate.fcNominalRestKind(rows(['nom104', 'dr30'])), 'rest');
  assert.equal(fcRate.fcNominalRestKind(rows(['nom104', 'dr156'])), 'other-blank');
  assert.equal(fcRate.fcNominalRestKind(rows(['nom104'])), 'hold');
  assert.equal(fcRate.fcNominalRestKind(rows(['nom104']), { fallback: { pct: 30, overBlank: false } }), 'fallback-value');
  assert.equal(fcRate.fcNominalRestKind(rows(['nom104']), { fallback: { pct: null, overBlank: true } }), 'fallback-over');
  assert.equal(fcRate.fcNominalRestKind(rows(['nom104']), { fallback: { pct: null, overBlank: false } }), 'hold');
  assert.equal(fcRate.fcNominalRestKind(rows(['nom104']), { usedForRep: false }), 'not-used');
  // fallback 은 자기 행이 대표값을 정했으면 보지 않는다
  assert.equal(fcRate.fcNominalRestKind(rows(['nom104', 'dr30']), { fallback: { pct: 99, overBlank: false } }), 'rest');
});

// ───────────────────────────── RV-1 각주 근거(hbaBasis) ─────────────────────────────

test('RV-1 ⑥ 각주 근거는 실제 대표값을 정한 경로의 포트를 센다 — iDRAC 이 정했으면 iDRAC(OS 포트가 있어도)', () => {
  const r1 = footnoteOf(cycle(['nom104'], ['dr30']));
  assert.equal(r1.basis.src, 'idrac', JSON.stringify(r1.basis));
  assert.equal(r1.basis.dataRate, 1); assert.equal(r1.basis.nominalOver, 0);
  assert.equal(r1.basis.rep, 'value');
  assert.equal(r1.basis.osFallback?.nominalOver, 1, 'OS 쪽 명목 초과 포트는 버리지 않고 따로 남긴다');
  assert.ok(!r1.foot.includes('나머지 포트 기준'), r1.foot);
  assert.ok(r1.foot.includes('iDRAC'), r1.foot);
  assert.ok(r1.foot.includes('보고된 링크 속도를 확인하세요'), r1.foot);

  const r4 = footnoteOf(cycle(['nom104'], ['dr156']));
  assert.equal(r4.basis.src, 'idrac'); assert.equal(r4.basis.blanked, 1); assert.equal(r4.basis.overBlank, true); assert.equal(r4.basis.rep, 'over');
  assert.ok(!r4.foot.includes(SAYS_NOT_OVER), r4.foot);
  assert.ok(r4.foot.includes('임계 알림은 초과로 봅니다'), r4.foot);
});

test('RV-1 ⑦ 같은 OS 행에 명목 초과 + 데이터율 크게 초과(RV-2 의 각주 경로) — 각주가 \'나머지 포트 기준 · 알림 초과 아님\' 이라 말하지 않는다', () => {
  const f = footnoteOf(cycle(['nom104', 'dr156'], []));
  assert.equal(f.basis.src, 'os'); assert.equal(f.basis.rep, 'over');
  assert.ok(!f.foot.includes('나머지 포트 기준'), f.foot);
  assert.ok(!f.foot.includes(SAYS_NOT_OVER), f.foot);
  assert.ok(f.foot.includes('다른 포트'), f.foot);
  // 명목 초과뿐이고 다른 값이 없으면 '판정 보류'
  const h = footnoteOf(cycle(['nom104'], []));
  assert.equal(h.basis.rep, 'none');
  assert.ok(h.foot.includes('판정 보류') && !h.foot.includes('나머지 포트 기준'), h.foot);
  // 나머지 포트 값이 대표면 예전 문구 그대로
  const v = footnoteOf(cycle(['nom104', 'dr30'], []));
  assert.equal(v.basis.rep, 'value');
  assert.ok(v.foot.includes('나머지 포트 기준이고 알림은 초과로 보지 않습니다'), v.foot);
});

test('RV-1 ⑧ Windows OS 값(분모 근거 없음)이 대표인데 iDRAC FC 포트만 셀 수 있으면 iDRAC 포트를 근거라 말하지 않는다', () => {
  _resetHbaBasisForTest();
  const built = {
    row: { hba_pct: 40 }, srcOf: { hba: 'os' },
    detail: { hbaRepSrc: 'os', fc: [{ host: 'win', pct: 40 }], idracFc: [{ host: 'F', pct: 70, pctBasis: 'fc-data-rate' }] },
  };
  recordHbaBasis('W', built, { at: NOW, ok: true });
  assert.equal(hbaBasisFor('W'), null);
});

// ───────────────────────────── 전수 대조 — 문구가 값·알림과 모순되지 않는다 ─────────────────────────────

test('RV-1 ⑨ 전수 조합(OS 0~2 · iDRAC 0~2 포트) — 노트·각주가 hba_pct·hba_over·srcOf.hba 와 어긋나지 않는다', () => {
  const kinds = Object.keys(KIND);
  const lists = [[]];
  for (const a of kinds) { lists.push([a]); for (const b2 of kinds) lists.push([a, b2]); }
  let checked = 0;
  for (const osK of lists) {
    for (const idK of lists) {
      if (!osK.length && !idK.length) continue;
      const b = cycle(osK, idK);
      const tag = `os=${osK.join('+')} idrac=${idK.join('+')} row=${JSON.stringify({ p: b.row.hba_pct, o: b.row.hba_over, s: b.srcOf.hba })}`;
      const fcNotes = b.notes.filter((x) => /HBA/.test(x));
      if (b.row.hba_over === true) assert.ok(!fcNotes.some((x) => x.includes(SAYS_NOT_OVER)), `${tag}\n${fcNotes.join('\n')}`);
      if (b.row.hba_pct != null) {
        assert.ok(!fcNotes.some((x) => SAYS_REP_BLANK.test(x)), `${tag}\n${fcNotes.join('\n')}`);
        assert.ok(!fcNotes.some((x) => x.includes('판정 보류')), `${tag}\n${fcNotes.join('\n')}`);
      }
      if (b.row.hba_pct == null && b.row.hba_over !== true) assert.ok(!fcNotes.some((x) => x.includes(SAYS_OVER)), `${tag}\n${fcNotes.join('\n')}`);
      // 각주(화면에 보이는 경로)
      const { basis, foot } = footnoteOf(b);
      if (!basis) continue;
      if (b.srcOf.hba) assert.equal(basis.src, b.srcOf.hba, tag);
      if (b.row.hba_over === true) assert.ok(!foot.includes(SAYS_NOT_OVER), `${tag}\n${foot}`);
      if (b.row.hba_pct != null) assert.ok(!/사용률(은|도) [^·]*비웠/.test(foot) && !foot.includes('판정 보류'), `${tag}\n${foot}`);
      if (b.row.hba_pct == null && b.row.hba_over !== true) assert.ok(!foot.includes(SAYS_OVER) && !foot.includes('알림 초과는'), `${tag}\n${foot}`);
      // 근거의 rep 는 최종 값 그대로
      assert.equal(basis.rep, b.row.hba_pct != null ? 'value' : b.row.hba_over ? 'over' : 'none', tag);
      checked += 1;
    }
  }
  assert.ok(checked > 1500, String(checked));
  // fcRepresentative 는 그대로(값 계산을 바꾸지 않았다)
  assert.equal(fcRepresentative(cycle(['nom104', 'dr156']).detail.fc).overBlank, true);
});
