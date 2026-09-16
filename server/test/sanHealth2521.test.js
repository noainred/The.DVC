/**
 * test/sanHealth2521.test.js — SAN 점검 v2.521 회귀 고정.
 *
 * 이번 변경은 **사용자가 실제로 신고한 거짓 경보**를 고친 것이라 경계를 못 박아 둔다:
 *  · 링크 없는 포트의 낮은 Rx 를 '이상' 으로 판정하던 것(현장 스크린샷: 포트 10~15·45·46 이
 *    전부 `비어있음` 인데 -27 dBm 으로 '이상').
 *  · PDF 표에서 마지막 열만 `w` 를 빼 그 열이 1/91 로 찌그러지던 것.
 *  · 에러 카운터를 한 문장으로 뭉개 원인이 서로 다른 것을 구분하지 못하던 것.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDevice, checkPorts, isLinked, errorCauses, causeSentence, ERROR_CAUSE, ERROR_KEYS,
  RX_WARN_DBM, RX_BAD_DBM,
} from '../src/curuser/../sanswitch/healthCheck.js';
import { portZoneDetail } from '../src/sanswitch/zoning.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const OK_SECTIONS = { ports: 'ok', sfp: 'ok', counters: 'ok', chassis: 'ok', health: 'ok', sensors: 'ok', bottleneck: 'ok', raslog: 'ok', fabric: 'ok', zoning: 'ok' };
const port = (o) => ({ index: 0, state: 'online', stateRaw: 'Online', speed: '16G', attached: [], attachedName: '', ...o });
const snapOf = (o = {}) => ({
  ok: true, deviceId: 'd1', name: 'SW1', collectedAt: Date.now(), switchState: 'Online',
  sections: { ...OK_SECTIONS, ...(o.sections || {}) },
  ports: { list: [], portsOmitted: 0, online: 0, licensed: 0, free: 0, ...(o.ports || {}) },
  health: { status: 'HEALTHY', psus: { total: 2, ok: 2 }, fans: { total: 2, ok: 2 }, ...(o.health || {}) },
  extra: { ...(o.extra || {}) },
  ...Object.fromEntries(Object.entries(o).filter(([k]) => !['sections', 'ports', 'health', 'extra'].includes(k))),
});

/* ── ④ 링크 없는 포트의 광량은 판정하지 않는다 ─────────────────────────────── */

test('광량: 링크 없는 포트의 낮은 Rx 를 이상으로 판정하지 않는다(사용자 신고 거짓 경보)', () => {
  const list = [
    port({ index: 7, state: 'online', rxPowerDbm: -1.4 }),
    // 현장 값 그대로 — 전부 `비어있음`(offline) 인데 Rx 가 바닥이다.
    port({ index: 10, state: 'offline', stateRaw: 'No_Light', rxPowerDbm: -27 }),
    port({ index: 11, state: 'offline', stateRaw: 'No_Light', rxPowerDbm: -23.1 }),
    port({ index: 45, state: 'offline', stateRaw: 'No_Light', rxPowerDbm: -23.3 }),
  ];
  const r = checkDevice(snapOf({ ports: { list } }));
  const opt = r.items.find((i) => i.key === 'optical');
  assert.equal(opt.status, 'ok', '링크가 없으면 상대가 빛을 보내지 않아 Rx 가 낮은 것이 정상이다');
  assert.match(opt.detail, /링크 없는 포트 3개는 제외/, '뺀 개수를 밝히지 않으면 조용한 제외가 된다');
  assert.match(opt.detail, /판정 1포트/);
});

test('광량: 링크 있는 포트가 나쁘면 그대로 이상이다(오탐 수정이 탐지를 죽이지 않는다)', () => {
  const list = [
    port({ index: 3, state: 'online', rxPowerDbm: -15, attachedName: 'ESX-01' }),
    port({ index: 10, state: 'offline', rxPowerDbm: -27 }),
  ];
  const opt = checkDevice(snapOf({ ports: { list } })).items.find((i) => i.key === 'optical');
  assert.equal(opt.status, 'bad');
  assert.ok(opt.evidence.some((e) => /포트 3/.test(e)));
  assert.ok(!opt.evidence.some((e) => /포트 10/.test(e)), '링크 없는 포트를 근거로 싣지 않는다');
});

test('광량: 링크 있는 포트가 하나도 없으면 ok 가 아니라 unknown 이다', () => {
  const list = [port({ index: 10, state: 'offline', rxPowerDbm: -27 })];
  const opt = checkDevice(snapOf({ ports: { list } })).items.find((i) => i.key === 'optical');
  assert.equal(opt.status, 'unknown', '판정할 대상이 없는 것을 정상이라 말하면 거짓이다');
});

test('isLinked 는 online 만 참이다', () => {
  assert.equal(isLinked({ state: 'online' }), true);
  for (const s of ['offline', 'disabled', 'noLicense', 'faulty', 'unknown']) assert.equal(isLinked({ state: s }), false);
});

/* ── ⑤ 에러 카운터 종류별 원인 ─────────────────────────────────────────────── */

test('에러 원인: 카운터 종류마다 다른 원인을 준다(한 문장으로 뭉개지 않는다)', () => {
  for (const k of ERROR_KEYS) {
    assert.ok(ERROR_CAUSE[k].cause.length > 5, `${k} 원인 문구 없음`);
    assert.ok(ERROR_CAUSE[k].label, `${k} 라벨 없음`);
  }
  assert.match(ERROR_CAUSE.errCrc.cause, /케이블|광모듈/);
  assert.match(ERROR_CAUSE.errEncIn.cause, /물리/);
  assert.match(ERROR_CAUSE.errLossSync.cause, /Cable|Optic/);
  assert.match(ERROR_CAUSE.discC3.cause, /혼잡|버퍼|Congestion/);
});

test('에러 원인: 실제로 발생한 종류만 나열한다', () => {
  const rows = [{ index: 1, dlt: { errCrc: 5, discC3: 100 } }, { index: 2, dlt: { errCrc: 2 } }];
  const c = errorCauses(rows, { basis: 'dlt' });
  assert.deepEqual(c.map((x) => x.key), ['discC3', 'errCrc'], '건수 많은 순');
  assert.deepEqual(c.find((x) => x.key === 'errCrc').ports, [1, 2]);
  assert.equal(c.length, 2, '0 건인 종류를 나열하면 없는 원인을 말하는 것이다');
  assert.match(causeSentence(c), /disc c3 100건 →/);
  assert.equal(causeSentence([]), '');
});

/* ── ⑦ 전 포트 점검 ───────────────────────────────────────────────────────── */

test('전 포트 점검: 포트마다 판정과 근거를 준다', () => {
  const list = [
    port({ index: 1, state: 'online', rxPowerDbm: -2, errCrc: 0 }),
    port({ index: 2, state: 'online', rxPowerDbm: -15, errCrc: 3, attachedName: 'ESX-02' }),
    port({ index: 3, state: 'offline', rxPowerDbm: -27, errCrc: 0 }),
    port({ index: 4, state: 'faulty', stateRaw: 'Mod_Inv', rxPowerDbm: -30, errCrc: 0 }),
  ];
  const pc = checkPorts(snapOf({ ports: { list } }));
  const by = new Map(pc.rows.map((r) => [r.index, r]));
  assert.equal(by.get(1).verdict, 'ok');
  assert.equal(by.get(2).verdict, 'bad');
  assert.ok(by.get(2).reasons.some((x) => /광량/.test(x)));
  assert.equal(by.get(3).optical, 'skipped', "링크 없음은 '확인 불가' 가 아니라 '판정 대상 아님' 이다");
  assert.equal(by.get(3).verdict, 'ok');
  assert.equal(by.get(4).verdict, 'bad');
  assert.equal(pc.counts.total, 4);
  assert.equal(pc.counts.idle, 2, 'offline + faulty 는 링크 없음');
  assert.equal(pc.complete, true);
});

test('전 포트 점검: 그 포트의 카운터를 못 읽었으면 ok 가 아니라 unknown 이다', () => {
  // `porterrshow` 자체는 성공했지만 그 포트 행이 없을 수 있다 — '에러 0' 이라 말하면 거짓이다.
  const pc = checkPorts(snapOf({ ports: { list: [port({ index: 1, state: 'offline' })] } }));
  assert.equal(pc.rows[0].errors, 'unknown');
  assert.equal(pc.rows[0].verdict, 'unknown');
});

test('전 포트 점검: 엣지가 일부 포트만 올렸으면 complete:false 로 밝힌다', () => {
  const pc = checkPorts(snapOf({ ports: { list: [port({ index: 1 })], portsOmitted: 120 } }));
  assert.equal(pc.complete, false);
  assert.equal(pc.portsOmitted, 120);
});

test('전 포트 점검: 기준선이 없으면 누적만 말하고 신규는 null 이다', () => {
  const list = [port({ index: 1, errCrc: 50 })];
  const noBase = checkPorts(snapOf({ ports: { list } }));
  assert.equal(noBase.rows[0].errNew, null, '기준선 없이 신규를 숫자로 말하면 거짓이다');
  assert.equal(noBase.rows[0].errors, 'warn');
  const withBase = checkPorts(snapOf({ ports: { list } }), { baseline: { at: 1, ports: { 1: { errCrc: 50 } } } });
  assert.equal(withBase.rows[0].errNew, 0);
  assert.equal(withBase.rows[0].errors, 'ok');
});

test('전 포트 점검: 카운터 리셋(음수 델타)은 0 이 아니라 판정 보류다', () => {
  const list = [port({ index: 1, errCrc: 5 })];
  const pc = checkPorts(snapOf({ ports: { list } }), { baseline: { at: 1, ports: { 1: { errCrc: 100 } } } });
  assert.equal(pc.rows[0].errDelta.errCrc, undefined, 'rates.js 규약 — 음수 델타는 null(값 없음)');
  assert.equal(pc.rows[0].errNew, null);
});

/* ── ③ 불량 포트의 연결 장비 · 조닝 상대 ────────────────────────────────────── */

test('조닝 상세: 포트의 WWN 이 속한 zone 과 상대편을 준다', () => {
  const zones = [
    { name: 'z_esx01_unity', wwns: ['10:00:00:00:c9:aa:bb:01', '50:06:01:60:aa:bb:cc:01'], unresolved: [], members: [] },
    { name: 'z_esx01_ps', wwns: ['10:00:00:00:c9:aa:bb:01', '58:ce:00:11:22:33:44:55'], unresolved: [], members: [] },
  ];
  const ports = [{ index: 3, slotPort: null, state: 'online', attachedName: 'ESX-01', attached: ['10:00:00:00:C9:AA:BB:01'] }];
  const [d] = portZoneDetail(zones, ports, { names: { '10:00:00:00:c9:aa:bb:01': 'ESX-01' } });
  assert.equal(d.index, 3);
  assert.equal(d.wwns.length, 1);
  assert.equal(d.wwns[0].label, 'ESX-01');
  assert.equal(d.zoneCount, 2);
  assert.equal(d.partnerCount, 2, '같은 zone 의 상대 2개');
  assert.deepEqual(d.zones.map((z) => z.name), ['z_esx01_unity', 'z_esx01_ps']);
  assert.equal(d.zones[0].partners[0].wwn, '50:06:01:60:aa:bb:cc:01');
});

test('조닝 상세: WWN 을 모르는 포트를 "조닝 안 됨" 이라 말하지 않는다', () => {
  const [d] = portZoneDetail([], [{ index: 10, state: 'offline', attached: [] }], {});
  assert.deepEqual(d.wwns, []);
  assert.equal(d.zoneCount, 0);
});

test('조닝 상세: 상대 상한을 넘으면 개수를 밝힌다(조용한 상한 금지)', () => {
  const many = Array.from({ length: 40 }, (_, i) => `50:06:01:60:00:00:00:${String(i).padStart(2, '0')}`);
  const zones = [{ name: 'big', wwns: ['10:00:00:00:c9:00:00:01', ...many], unresolved: [], members: [] }];
  const [d] = portZoneDetail(zones, [{ index: 1, attached: ['10:00:00:00:c9:00:00:01'] }], { maxPartners: 5 });
  assert.equal(d.zones[0].partners.length, 5);
  assert.equal(d.zones[0].partnersOmitted, 35);
});

/* ── ① PDF 열 폭 ──────────────────────────────────────────────────────────── */

test('PDF: 모든 표 열에 `w` 가 명시돼 있다(하나라도 빠지면 그 열이 찌그러진다)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', '..', 'web', 'src', 'views', 'tools', 'sanHealthText.js'), 'utf8');
  // `columns: [...]` 블록마다 `{ label: ... }` 항목에 w 가 있는지 본다.
  // ⚠ `],\n` 로 끊으면 `], rows });` 로 끝나는 정의를 놓쳐 뒤 블록까지 삼킨다(초판이 그랬다).
  const blocks = [...src.matchAll(/columns:\s*\[([\s\S]*?\})\s*\]/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 3, `표 정의를 찾지 못했다(${blocks.length}) — 파싱이 깨졌는지 확인`);
  for (const b of blocks) {
    const cols = [...b.matchAll(/\{\s*label:[^}]*\}/g)].map((m) => m[0]);
    for (const c of cols) {
      assert.match(c, /\bw:\s*\d/, `열 폭 미지정: ${c}\n→ reportExport.tableWidths 머리말 참조(v2.521 실제 사고)`);
    }
  }
});

test('PDF: tableWidths 는 미지정 열을 붕괴시키지 않는다', async () => {
  const { tableWidths } = await import('../../web/src/views/tools/reportExport.js');
  const w = tableWidths([{ w: 38 }, { w: 20 }, { w: 32 }, {}], 186);
  // 옛 동작은 마지막 열이 1/91 ≈ 2mm 였다.
  assert.ok(w[3] > 20, `미지정 열이 ${w[3].toFixed(1)}mm — 평균(30)을 받아야 한다`);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 186) < 0.001, '합은 가용 폭과 같아야 한다');
  const eq = tableWidths([{}, {}, {}], 90);
  assert.deepEqual(eq.map((x) => Math.round(x)), [30, 30, 30], '전부 미지정이면 균등');
});
