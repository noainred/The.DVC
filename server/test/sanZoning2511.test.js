/**
 * v2.511 — SAN 스위치 조닝(cfgshow) 파서·분석 회귀.
 *
 * 픽스처는 **사용자가 제공한 실장비 출력 2벌의 형식**을 그대로 옮긴 것이다(2026-09-15).
 *
 * ⚠ 값은 **익명화했다**(v2.513 — 저장소가 공개라 운영 SAN 토폴로지를 담지 않는다). 호스트명은
 *   `HOSTA0n`, WWN 뒷자리는 합성값이다. 파서는 *형식*만 검증하므로 판정력은 동일하다.
 *   **실제 값으로 되돌리지 말 것.** 대신 아래 두 성질은 **반드시 보존**해야 한다:
 *     ① WWN 앞 OUI 접두 — `zoning.js WWN_HINTS` 가 벤더·방향을 이 접두로 추정한다
 *        (`10:00:00:10:9b` Emulex · `50:06:01:6` Unity · `50:00:09:7` VMAX ·
 *         `51:4f:0c` XtremIO · `58:cc:f0` PowerStore · `c0:01:44` VPLEX).
 *        접두를 바꾸면 역할 추정 테스트가 의미를 잃는다.
 *     ② Unity SPA0(`…:60:00:00:00:a0`)/SPB0(`…:68:00:00:00:a0`)의 **뒤 4바이트 동일** —
 *        `labelMap()` 이 고치는 라벨 충돌의 유일한 재현 사례다(실화면에서 발견된 결함).
 *
 * 그 출력에서 확인된 형식 변주를 전부 고정한다 — 추측으로 만든 형식이 아니라 실제로 본 것만:
 *   · `cfg: cfg1  ZONE_A;`  이름과 첫 멤버가 같은 줄
 *   · `zone:` 멤버가 한 줄에 `alias1; alias2`(세미콜론)
 *   · `zone:` 멤버가 한 줄에 `WWN; WWN`
 *   · `zone:` 멤버가 줄당 하나(세미콜론 없음)
 *   · `alias:` 1개 ↔ WWN 1개
 *   · Defined / Effective 두 섹션
 *
 * 그리고 이 현장의 핵심 구조를 고정한다: **VPLEX 는 호스트에겐 타깃, 어레이에겐 이니시에이터**라
 * 단순 2열 이분 그래프로 그리면 틀린다 → `middle`(가운데 열)로 나와야 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCfgShow, resolveZones, normWwn, memberKind, splitMembers,
  twoColor, classifyEndpoints, buildZoneGraph, buildZoneMatrix, zoneFindings, zoneSummary, wwnHint, naaClass,
} from '../src/sanswitch/zoning.js';
import { parseNsRoles } from '../src/sanswitch/collectors/fosParse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = fs.readFileSync(path.join(HERE, 'fixtures/cfgshow-sample.txt'), 'utf8');

const HOST10 = '10:00:00:10:9b:00:00:01';
const HOST14 = '10:00:00:10:9b:00:00:02';
const HOST15 = '10:00:00:10:9b:00:00:03';
const UNITY_SPA = '50:06:01:60:00:00:00:a0';
const VMAX = '50:00:09:70:00:00:00:b0';
const VPLEX_FE_A0 = 'c0:01:44:00:00:00:01:00';
const VPLEX_BE_B2 = 'c0:01:44:00:00:00:05:00';
const POWERSTORE = '58:cc:f0:00:00:00:00:c0';
const XTREMIO = '51:4f:0c:00:00:00:00:d0';

test('WWN·멤버 표기 정규화', () => {
  assert.equal(normWwn('50:06:01:60:00:00:00:A0'), UNITY_SPA);
  assert.equal(normWwn('5006016 0000000a0'), UNITY_SPA, '구분자 없는 표기도 받는다');
  assert.equal(normWwn('HOSTA01_HBA1_P01'), null);
  assert.equal(memberKind(UNITY_SPA), 'wwn');
  assert.equal(memberKind('1,15'), 'domainPort');
  assert.equal(memberKind('HOSTA01_HBA1_P01'), 'alias');
  // 실장비에서 본 두 구분자를 모두 쪼갠다(한쪽만 보면 그 현장에서만 맞는다).
  assert.deepEqual(splitMembers('HOSTA02_HBA1_P02; Unity_SPB0_p9'), ['HOSTA02_HBA1_P02', 'Unity_SPB0_p9']);
  assert.deepEqual(splitMembers('ZONE_A;\n ZONE_B;'), ['ZONE_A', 'ZONE_B'], '끝 세미콜론 제거');
});

test('parseCfgShow — 두 섹션 · cfg 이름+첫멤버 같은 줄 · 별칭', () => {
  const p = parseCfgShow(SAMPLE);
  assert.deepEqual(p.sections, ['defined', 'effective']);
  // cfg 줄의 첫 멤버가 이름과 같은 줄에 있어도 놓치지 않는다(실장비 형식).
  assert.ok(p.defined.cfgs.cfg1.includes('HOSTA01_H1_SW3_S09_SW1_D16_VPLEX_FE_E1_A0'), 'cfg 첫 멤버(같은 줄)');
  assert.ok(p.defined.cfgs.cfg1.includes('XtremIO_X1_X1-SC1-FC1_SW1_S32_SW1_D24_VPLEX_BE_E1_A0'), 'cfg 마지막 멤버');
  // 한 줄에 '; ' 로 둘(별칭)
  assert.deepEqual(p.defined.zones.HOSTA02_H1_SW3_S13_SW1_D9_Unity_SPB0, ['HOSTA02_HBA1_P02', 'Unity_SPB0_p9']);
  // 한 줄에 '; ' 로 둘(WWN)
  assert.deepEqual(p.defined.zones.HOSTA02_H1_SW3_S13_SW5_D48_Unity_2ND_SPA0, [HOST14, UNITY_SPA]);
  // 줄당 하나(세미콜론 없음) — 첫 번째 첨부 형식
  assert.deepEqual(p.defined.zones.PowerStore_NodeA_S1_P2_SW1_S3_SW1_D31_VPLEX_BE_E2_B2, [POWERSTORE, VPLEX_BE_B2]);
  assert.deepEqual(p.defined.aliases.Unity_SPA0_p8, [UNITY_SPA]);
  assert.equal(p.effective.cfg, 'cfg1');
  assert.equal(Object.keys(p.effective.zones).length, 9);
  assert.deepEqual(p.effective.zones.HOSTA01_H1_SW3_S09_SW1_D8_Unity_SPA0, [HOST10, UNITY_SPA]);
  assert.equal(p.truncated, false);
});

test("페이저 '--More--(byte N)' 는 잘렸다고 표시한다(숨기지 않는다)", () => {
  const p = parseCfgShow('Defined configuration:\n cfg: c1  Z1\n--More--(byte 1978)\n');
  assert.equal(p.truncated, true);
});

test('resolveZones — 활성 섹션 우선 · 별칭 해석 · 미해석 보존', () => {
  const p = parseCfgShow(SAMPLE);
  const r = resolveZones(p);
  assert.equal(r.source, 'effective', '활성 섹션이 있으면 그것을 쓴다(이미 WWN 으로 풀려 있다)');
  assert.equal(r.cfgName, 'cfg1');
  assert.equal(r.zones.length, 9);

  // 활성 섹션이 없으면 정의 섹션을 별칭으로 푼다.
  const defOnly = parseCfgShow(SAMPLE.split('Effective configuration:')[0]);
  const rd = resolveZones(defOnly);
  assert.equal(rd.source, 'defined');
  const z = rd.zones.find((x) => x.name === 'HOSTA02_H1_SW3_S13_SW1_D9_Unity_SPB0');
  assert.deepEqual(z.wwns, [HOST14, '50:06:01:68:00:00:00:a0'], '별칭 → WWN');
  assert.equal(z.members[0].alias, 'HOSTA02_HBA1_P02', '별칭 이름을 라벨용으로 보존');
  // 정의를 못 찾은 별칭은 버리지 않고 미해석으로 남긴다.
  const orphan = rd.zones.find((x) => x.name === 'ORPHAN_ZONE_NOT_IN_CFG');
  assert.equal(orphan, undefined, '활성 cfg 에 없는 zone 은 기본 목록에서 빠진다');
  const single = rd.zones.find((x) => x.name === 'SINGLE_MEMBER_ZONE');
  assert.equal(single, undefined);
});

/**
 * VPLEX 는 FE 포트와 BE 포트가 **서로 다른 WWN** 이다(실장비 출력에서 확인:
 * FE `c0:01:44:00:00:00:01:00` vs BE `c0:01:44:00:00:00:05:00`). 그래서 한 노드가 양쪽에
 * 걸치지 않고, 2-색칠이 **FE=타깃(호스트를 향함) · BE=이니시에이터(어레이를 향함)** 로
 * 올바르게 나눈다 — 이것이 SAN 의 실제 의미다.
 * ⚠ 이 테스트는 초판에서 'VPLEX 는 가운데' 로 기대했다가 **기대가 틀렸음을 코드가 잡아낸** 것이다.
 *   같은 장비가 양쪽 열에 나타나는 것은 오류가 아니라 사실이며, 화면이 그렇게 설명해야 한다.
 */
test('2-색칠 — VPLEX FE 는 타깃, BE 는 이니시에이터로 갈린다(서로 다른 WWN)', () => {
  const r = resolveZones(parseCfgShow(SAMPLE));
  const colors = twoColor(r.zones);
  assert.ok(colors.has(HOST10) && colors.has(VPLEX_BE_B2));
  assert.equal(colors.get(VPLEX_BE_B2).conflict, false, '같은 WWN 이 양쪽에 걸치지 않으므로 홀수 사이클 없음');
  const roles = classifyEndpoints(r.zones, {});
  assert.equal(roles.get(VPLEX_FE_A0).side, 'target', 'FE 는 호스트를 향한 타깃');
  assert.equal(roles.get(VPLEX_BE_B2).side, 'initiator', 'BE 는 어레이를 향한 이니시에이터');
  assert.equal(roles.get(POWERSTORE).side, 'target');
  assert.equal(roles.get(XTREMIO).side, 'target');
  // 시작 노드에 따라 색이 뒤집혀도 결과가 같아야 한다(색 전체의 다수결로 방향을 정하므로).
  const flipped = classifyEndpoints([...r.zones].reverse(), {});
  assert.equal(flipped.get(VPLEX_BE_B2).side, 'initiator');
  assert.equal(flipped.get(HOST10).side, 'initiator');
});

test("같은 WWN 이 정말 양쪽에 걸리면 'middle'(가운데 계층)로 분류한다", () => {
  // NPIV·가상화 계층에서 실제로 생기는 형태: 한 WWN 이 이니시에이터와도, 타깃과도 zone 된다.
  const zones = [
    { name: 'H_TO_V', members: [], wwns: [HOST10, VPLEX_FE_A0], unresolved: [] },
    { name: 'V_TO_ARRAY', members: [], wwns: [VPLEX_FE_A0, UNITY_SPA], unresolved: [] },
    { name: 'H_TO_ARRAY', members: [], wwns: [HOST10, UNITY_SPA], unresolved: [] },  // 홀수 사이클
  ];
  const roles = classifyEndpoints(zones, { nsRoles: {} });
  assert.equal(roles.get(VPLEX_FE_A0).side, 'middle');
  assert.match(roles.get(VPLEX_FE_A0).basis, /가상화 계층/);
  assert.ok(buildZoneGraph(zones, {}).columns.middle.includes(VPLEX_FE_A0));
});

test('역할 판정 — 네임서버가 있으면 확정, 없으면 추정이라고 밝힌다', () => {
  const r = resolveZones(parseCfgShow(SAMPLE));
  const guessed = classifyEndpoints(r.zones, {});
  assert.equal(guessed.get(HOST10).side, 'initiator');
  assert.equal(guessed.get(HOST10).confidence, 'inferred');
  assert.match(guessed.get(HOST10).basis, /추정/);
  assert.equal(guessed.get(UNITY_SPA).side, 'target');

  const confirmed = classifyEndpoints(r.zones, { nsRoles: { [HOST10]: 'initiator', [UNITY_SPA]: 'target' } });
  assert.equal(confirmed.get(HOST10).confidence, 'confirmed');
  assert.match(confirmed.get(HOST10).basis, /네임서버/);
});

test('WWN 단서는 보조 신호이고 VPLEX 는 한쪽으로 정하지 않는다', () => {
  assert.equal(wwnHint(HOST14).side, 'initiator');
  assert.equal(wwnHint(UNITY_SPA).side, 'target');
  assert.equal(wwnHint(VPLEX_FE_A0).side, '', 'VPLEX 는 side 를 비워 둔다(양쪽 다 가능)');
  assert.equal(wwnHint(VPLEX_FE_A0).vendor, 'Dell EMC VPLEX');
  assert.equal(naaClass(HOST14), 'ieee48');
  assert.equal(naaClass(UNITY_SPA), 'registered');
  assert.equal(wwnHint('ab:cd:ef:00:00:00:00:00'), null, '모르면 null — 지어내지 않는다');
});

test('buildZoneGraph — 3열 배치 · 차수 · 별칭 라벨', () => {
  const r = resolveZones(parseCfgShow(SAMPLE));
  const g = buildZoneGraph(r.zones, {});
  assert.equal(g.zonesTotal, 9);
  assert.equal(g.links.length, 9, '2-멤버 zone 9개 → 링크 9개');
  assert.ok(g.columns.left.includes(HOST10), '호스트는 왼쪽');
  assert.ok(g.columns.right.includes(UNITY_SPA), '어레이는 오른쪽');
  // VPLEX 는 FE(타깃)·BE(이니시에이터)가 다른 WWN 이라 **양쪽 열에 모두** 나타난다 — 사실 그대로다.
  assert.ok(g.columns.right.includes(VPLEX_FE_A0), 'VPLEX FE 는 오른쪽(호스트의 타깃)');
  assert.ok(g.columns.left.includes(VPLEX_BE_B2), 'VPLEX BE 는 왼쪽(어레이의 이니시에이터)');
  const host14 = g.nodes.find((n) => n.wwn === HOST14);
  assert.equal(host14.degree, 3, 'HOSTA02 는 zone 3개(Unity SPB0 · VMAX · Unity_2ND SPA0)');
  // 포트 정보가 있으면 붙인다(없으면 null — 지어내지 않는다).
  const withPort = buildZoneGraph(r.zones, { portByWwn: { [HOST10]: { slotPort: '3/9', state: 'online' } } });
  const n = withPort.nodes.find((x) => x.wwn === HOST10);
  assert.equal(n.port, '3/9'); assert.equal(n.online, true);
  assert.equal(withPort.nodes.find((x) => x.wwn === VMAX).port, null);
});

test('buildZoneMatrix — 행=이니시에이터 · 열=타깃 · 모든 링크가 셀로 남는다', () => {
  const r = resolveZones(parseCfgShow(SAMPLE));
  const g = buildZoneGraph(r.zones, {});
  const m = buildZoneMatrix(g);
  assert.ok(m.rows.some((x) => x.wwn === HOST10));
  assert.ok(m.cols.some((x) => x.wwn === UNITY_SPA));
  assert.ok(m.rows.some((x) => x.wwn === VPLEX_BE_B2), 'VPLEX BE(이니시에이터)는 행');
  assert.ok(m.cols.some((x) => x.wwn === VPLEX_FE_A0), 'VPLEX FE(타깃)는 열');
  const cell = m.cells.find((c) => m.rows[c.r].wwn === HOST10 && m.cols[c.c].wwn === UNITY_SPA);
  assert.ok(cell && cell.n >= 1);
  assert.ok(cell.zones[0].includes('Unity_SPA0'));
  assert.ok(m.cells.some((c) => m.rows[c.r].wwn === VPLEX_BE_B2 && m.cols[c.c].wwn === POWERSTORE), 'VPLEX BE ↔ PowerStore');
  // 링크가 조용히 사라지지 않는다 — 9개 zone 이 모두 어떤 셀엔가 들어간다.
  const zonesInCells = new Set(m.cells.flatMap((c) => c.zones));
  assert.equal(zonesInCells.size, 9, `셀에 담긴 zone ${zonesInCells.size}개 ≠ 9`);
});

test('middle 노드는 매트릭스 행·열 양쪽에 들어간다(절반이 사라지지 않게)', () => {
  const zones = [
    { name: 'H_TO_V', members: [], wwns: [HOST10, VPLEX_FE_A0], unresolved: [] },
    { name: 'V_TO_ARRAY', members: [], wwns: [VPLEX_FE_A0, UNITY_SPA], unresolved: [] },
    { name: 'H_TO_ARRAY', members: [], wwns: [HOST10, UNITY_SPA], unresolved: [] },
  ];
  const m = buildZoneMatrix(buildZoneGraph(zones, {}));
  assert.ok(m.rows.some((x) => x.wwn === VPLEX_FE_A0) && m.cols.some((x) => x.wwn === VPLEX_FE_A0));
  assert.equal(new Set(m.cells.flatMap((c) => c.zones)).size, 3);
});

test('zoneFindings — 단일 멤버 · 다중 이니시에이터 · 미해석 · 미로그인', () => {
  const defOnly = parseCfgShow(SAMPLE.split('Effective configuration:')[0]);
  // 활성 cfg 밖 zone 까지 보려면 cfgs 를 비워 전체 zone 을 대상으로 만든다.
  const all = resolveZones({ ...defOnly, defined: { ...defOnly.defined, cfgs: {} } });
  const g = buildZoneGraph(all.zones, {});
  const f = zoneFindings(all.zones, g, {});
  assert.ok(f.some((x) => x.kind === 'single-member' && x.zone === 'SINGLE_MEMBER_ZONE'));

  const multi = [{ name: 'BAD', members: [], wwns: [HOST10, HOST14, UNITY_SPA], unresolved: [] }];
  const gm = buildZoneGraph(multi, { nsRoles: { [HOST10]: 'initiator', [HOST14]: 'initiator', [UNITY_SPA]: 'target' } });
  assert.ok(zoneFindings(multi, gm, {}).some((x) => x.kind === 'multi-initiator'));

  const unres = [{ name: 'U', members: [{ raw: '1,15', kind: 'domainPort', wwn: null, alias: '' }, { raw: UNITY_SPA, kind: 'wwn', wwn: UNITY_SPA, alias: '' }], wwns: [UNITY_SPA], unresolved: ['1,15'] }];
  assert.ok(zoneFindings(unres, buildZoneGraph(unres, {}), {}).some((x) => x.kind === 'unresolved'));

  // 로그인 정보가 있을 때만 로그인 판정을 한다(없으면 아무 말도 하지 않는다 — 없는 사실 금지).
  const r = resolveZones(parseCfgShow(SAMPLE));
  const gg = buildZoneGraph(r.zones, {});
  assert.equal(zoneFindings(r.zones, gg, {}).some((x) => x.kind.includes('offline')), false);
  const withLogin = zoneFindings(r.zones, gg, { loggedInWwns: new Set([HOST10]) });
  assert.ok(withLogin.some((x) => x.kind === 'member-offline' || x.kind === 'all-offline'));
});

test('zoneSummary — 화면이 쓰는 숫자', () => {
  const p = parseCfgShow(SAMPLE);
  const r = resolveZones(p);
  const g = buildZoneGraph(r.zones, {});
  const s = zoneSummary(p, r, g);
  assert.equal(s.cfgName, 'cfg1');
  assert.equal(s.source, 'effective');
  assert.equal(s.zones, 9);
  assert.equal(s.effectiveZones, 9);
  assert.equal(s.definedZones, 11, '정의 zone 11개(활성 밖 2개 포함)');
  assert.equal(s.aliases, 7);
  assert.equal(s.endpoints, 13);
  assert.equal(s.initiators, 5, '호스트 3 + VPLEX BE 2');
  assert.equal(s.targets, 8, 'VPLEX FE 3 + Unity 2 + VMAX 1 + PowerStore 1 + XtremIO 1');
  assert.equal(s.middle, 0, '이 출력에는 같은 WWN 이 양쪽에 걸친 경우가 없다');
  assert.equal(s.unknown, 0);
  assert.equal(s.links, 9);
  assert.equal(s.truncated, false);
});

test('빈 입력·쓰레기 입력에도 던지지 않는다', () => {
  for (const bad of ['', null, undefined, 'no zoning configuration in effect', ' ']) {
    const p = parseCfgShow(bad);
    const r = resolveZones(p);
    const g = buildZoneGraph(r.zones, {});
    assert.equal(r.zones.length, 0);
    assert.equal(g.nodes.length, 0);
    assert.deepEqual(zoneFindings(r.zones, g, {}), []);
  }
});

/* ────────────────── 네임서버 FC4 역할(v2.511) ──────────────────
 * 역할을 '추정' 이 아니라 '확정' 으로 만드는 유일한 근거. 이 경로가 없으면 화면의
 * '확정(●)' 배지는 **영원히 안 붙는다**(초판이 실제로 그 상태였다 — 라우트가 nsRoles 를
 * 만들지 않아 classifyEndpoints 의 confirmed 분기가 도달 불가였다). 아래가 그 회귀 방지다.
 *
 * ⚠ 정직: 실장비 nsshow 출력은 이 환경에서 확인하지 못했다(사용자 제공 캡처는 cfgshow 뿐).
 *   그래서 파서는 `Device type:`/`FC4s:` 가 **있으면** 읽고 없으면 빈 객체를 준다 —
 *   아래 '없으면 추정으로 떨어진다' 테스트가 그 폴백을 고정한다.
 */
test('parseNsRoles — Device type / FC4s 표기에서 역할을 읽는다', () => {
  const NS = [
    ' N    011000;      3;10:00:00:10:9b:00:00:01;20:00:00:10:9b:00:00:01; na',
    '    FC4s: FCP',
    '    PortSymb: [35] "Emulex PPN-10:00:00:10:9b:00:00:01"',
    '    Device type: Physical Initiator',
    '    Port Index: 16',
    ' N    011900;      3;50:06:01:60:00:00:00:a0;50:06:01:60:c6:e4:0b:f8; na',
    '    FC4s: FCP',
    '    Device type: Physical Target',
    ' N    012000;      3;c0:01:44:00:00:00:01:00;c0:01:44:00:00:00:01:00; na',
    '    Device type: Physical Initiator+Target',
  ].join('\n');
  const r = parseNsRoles(NS);
  assert.equal(r['10:00:00:10:9b:00:00:01'], 'initiator');
  assert.equal(r['50:06:01:60:00:00:00:a0'], 'target');
  assert.equal(r['c0:01:44:00:00:00:01:00'], 'both', '겸용은 한쪽으로 몰지 않는다');
});

test('parseNsRoles — 역할 표기가 없으면 빈 객체(지어내지 않는다)', () => {
  const NS = [
    ' N    011000;      3;10:00:00:10:9b:00:00:01;20:00:00:10:9b:00:00:01; na',
    '    FC4s: FCP',
    '    PortSymb: [35] "Emulex"',
  ].join('\n');
  assert.deepEqual(parseNsRoles(NS), {});
  for (const bad of ['', null, undefined, '    Device type: Physical Initiator']) {
    assert.deepEqual(parseNsRoles(bad), {}, '헤더 없이 딸린 줄은 아무에게도 귀속시키지 않는다');
  }
});

test('nsRoles 가 있으면 역할이 confirmed — 구조 추론을 이긴다', () => {
  const p = parseCfgShow(SAMPLE);
  const r = resolveZones(p);
  // 일부러 **구조 추론과 반대로** 준다: 호스트를 타깃이라고 네임서버가 말하면 그 말을 따른다.
  const g = buildZoneGraph(r.zones, { nsRoles: { [HOST10]: 'target', [UNITY_SPA]: 'initiator' } });
  const byW = new Map(g.nodes.map((n) => [n.wwn, n]));
  assert.equal(byW.get(HOST10).side, 'target');
  assert.equal(byW.get(HOST10).confidence, 'confirmed');
  assert.match(byW.get(HOST10).basis, /네임서버/);
  assert.equal(byW.get(UNITY_SPA).side, 'initiator');
  assert.equal(byW.get(UNITY_SPA).confidence, 'confirmed');
  // 네임서버가 말하지 않은 노드는 그대로 추정이다(섞이지 않는다).
  assert.equal(byW.get(HOST14).confidence, 'inferred');
});

test("nsRoles 'both' 는 가운데 열 — 단, 추론 middle 과 근거가 다르다(confirmed)", () => {
  const p = parseCfgShow(SAMPLE);
  const r = resolveZones(p);
  const g = buildZoneGraph(r.zones, { nsRoles: { [UNITY_SPA]: 'both' } });
  const n = g.nodes.find((x) => x.wwn === UNITY_SPA);
  assert.equal(n.side, 'middle');
  assert.equal(n.confidence, 'confirmed');
  assert.ok(g.columns.middle.includes(UNITY_SPA), '가운데 열에 실제로 들어간다(columns 는 WWN 문자열 배열)');
});
