/**
 * test/bmUsageEnterprise2554.test.js — v2.554 Enterprise 라이선스 대체 수집 회귀 고정.
 *
 * 사용자 신고(2026-09-17): "idarc 텔레메트리는 data center 라이선스가 필요한데, 내가 가진건
 * enterprise 라이선스라서, 엔터프라이즈 라이선스 대상 서버도 수집하는 기능 추가로 만들어줘".
 * 선택: **iDRAC api/ssh 를 쓰되 부하를 고지하고 동의를 받는다** · **엣지에서 종합, 중앙은 조회할
 * 때만 가져온다** · **전력·온도는 수집하지 않는다** · **법인 귀속 없음 원인까지 조사**.
 *
 * ⚠ 기준 시각을 `Date.now()` 로 쓰지 않는다(v2.517 규약) — 이 파일의 시각 단언은 고정 상수다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

// ⚠ static import 전에 CONFIG_DIR 을 잡는다 — 저장소의 server/config 를 오염시키지 않기 위해.
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bmusage2554-'));

const { classifyLicense, telemetryExpected, enterpriseEligible, licenseFromInventory, TIER_ORDER } =
  await import('../src/bmusage/license.js');
const { parseSystemPerf } = await import('../src/bmusage/parse/racadm.js');
const ent = await import('../src/bmusage/collectors/idracEnterprise.js');
const { normalizeSettings, enterpriseActive } = await import('../src/bmusage/settings.js');
const { unassignedCauses } = await import('../src/bmusage/attribution.js');
const { resolveTargets } = await import('../src/bmusage/targets.js');
const { buildUsage } = await import('../src/bmusage/usage.js');

/* ── 라이선스 판정 ───────────────────────────────────────────────────────── */

test('라이선스 등급은 이름 계열에서 찾고, 높은 등급이 이긴다', () => {
  assert.equal(classifyLicense([{ name: 'iDRAC9 Enterprise License', type: 'Production' }]).tier, 'enterprise');
  // Express + Datacenter 가 같이 설치돼 있으면 기능은 높은 쪽을 따른다.
  const both = classifyLicense([{ name: 'iDRAC9 Express' }, { name: 'iDRAC9 Datacenter License' }]);
  assert.equal(both.tier, 'datacenter');
  assert.deepEqual(TIER_ORDER, ['datacenter', 'enterprise', 'express', 'basic']);
});

test('⚠ Dell 의 LicenseType(Production/Evaluation)을 등급으로 읽지 않는다', () => {
  // `type` 만 있고 이름에 등급 단어가 없으면 **미상**이어야 한다(등급을 지어내지 않는다).
  const r = classifyLicense([{ name: '', type: 'Production', entitlement: '' }]);
  assert.equal(r.tier, 'unknown');
});

test('만료된 항목은 등급 후보에서 빼고 개수를 밝힌다 — 그래도 "없다" 고 단정하지 않는다', () => {
  const r = classifyLicense([{ name: 'iDRAC9 Datacenter', expiry: '2020-01-01T00:00:00+00:00' }], { now: 1_700_000_000_000 });
  assert.equal(r.tier, 'unknown');
  assert.equal(r.expired, 1);
});

test('등급 미상을 "텔레메트리 없음" 으로 접지 않는다', () => {
  assert.equal(telemetryExpected('datacenter'), 'yes');
  assert.equal(telemetryExpected('enterprise'), 'no');
  assert.equal(telemetryExpected(''), 'unknown');
});

test('⚠⚠ 텔레메트리가 정상이면 대체 경로를 쓰지 않는다(장비 부하를 두 배로 만들지 않는다)', () => {
  assert.equal(enterpriseEligible({ tier: 'enterprise', telemetryOk: true }).eligible, false);
  assert.equal(enterpriseEligible({ tier: 'enterprise', telemetryKind: 'no-telemetry' }).eligible, true);
});

test('⚠⚠ 401/403 이면 대체 경로도 시도하지 않는다(같은 계정 — iDRAC 계정이 잠긴다)', () => {
  const r = enterpriseEligible({ tier: 'enterprise', telemetryKind: 'auth' });
  assert.equal(r.eligible, false);
  assert.equal(r.why, 'auth');
});

test('인벤토리가 없으면 등급은 unknown 이고 source 가 비어 있다', () => {
  const r = licenseFromInventory(null);
  assert.equal(r.tier, 'unknown');
  assert.equal(r.source, '');
});

/* ── racadm 파서 ─────────────────────────────────────────────────────────── */

test('한 줄형 출력에서 첫 열(현재값)을 읽는다', () => {
  const r = parseSystemPerf('Metric      Last   Average   Peak\nCPUUsage    12 %   15 %      88 %\nMemoryUsage 41 %   44 %      70 %');
  assert.equal(r.parsed, true);
  assert.equal(r.cpuPct, 12);
  assert.equal(r.memPct, 41);
  assert.equal(r.usedStat.cpuPct, 'last');
});

test('블록형에서 Last 가 Average·Peak 보다 우선한다', () => {
  const r = parseSystemPerf('Metric Name = CPUUsage\nPeak = 99\nAverage = 30\nLast = 9');
  assert.equal(r.cpuPct, 9);
  assert.equal(r.usedStat.cpuPct, 'last');
});

test('⚠ 0~100 밖의 수는 퍼센트가 아니다 — 필드를 만들지 않는다', () => {
  const r = parseSystemPerf('CPUUsage  1200');
  assert.equal(r.parsed, false);
  assert.equal(r.cpuPct, undefined);
});

test('⚠ 시각·버전 토큰을 사용률로 읽지 않는다', () => {
  const r = parseSystemPerf('CPUUsage Peak Time 2026-09-17 08:00:00');
  assert.equal(r.parsed, false);
});

test('읽지 못하면 parsed:false — "오류가 없다" 를 "읽었다" 로 쓰지 않는다', () => {
  assert.equal(parseSystemPerf('ERROR: unknown subcommand').parsed, false);
  assert.equal(parseSystemPerf('').parsed, false);
});

/* ── 예산 산수(v2.528 규약) ──────────────────────────────────────────────── */

test('⚠⚠ 세션 예산은 폴러의 장비 시한보다 작아야 한다', () => {
  const src = fs.readFileSync(new URL('../src/bmusage/poller.js', import.meta.url), 'utf8');
  // ⚠ 숫자 구분자(`60_000`)를 놓치지 말 것 — `\d+` 만 쓰면 **60** 으로 읽혀 통과해야 할 단언이
  //   거짓이 된다(v2.554 에 실제로 겪었다. v2.535 '정규식 오판' 과 같은 계열).
  const m = /BMUSAGE_DEVICE_TIMEOUT_MS\) \|\| ([\d_]+)/.exec(src);
  assert.ok(m, '장비 시한 기본값을 찾지 못했습니다');
  const deviceMs = Number(m[1].replace(/_/g, ''));
  assert.ok(ent.SESSION_BUDGET_MS < deviceMs,
    `세션 예산(${ent.SESSION_BUDGET_MS}) 이 장비 시한(${deviceMs}) 보다 작아야 합니다 — 같거나 크면 withDeadline 이 먼저 던져 모은 결과가 통째로 버려집니다(v2.528 회귀)`);
});

test('⚠ SSH 최소 슬라이스는 핸드셰이크 시한보다 커야 한다(핸드셰이크만 하고 잘리면 결과가 0이다)', () => {
  assert.ok(ent.MIN_SSH_SLICE_MS > ent.SSH_READY_MS);
});

test('⚠ racadm 후보 수 × 명령 시한은 예산 안에 들어가야 한다', () => {
  assert.ok(ent.PERF_CMDS.length * ent.CMD_TIMEOUT_MS <= ent.SESSION_BUDGET_MS,
    '후보를 늘리려면 예산을 함께 볼 것(v2.544 규약)');
});

test('iDRAC host 의 스킴·포트를 SSH 주소로 쓰지 않는다', () => {
  assert.equal(ent.sshHostOf('https://10.0.0.1'), '10.0.0.1');
  assert.equal(ent.sshHostOf('https://10.0.0.1:443/'), '10.0.0.1');
  assert.equal(ent.sshHostOf('[fe80::1]'), 'fe80::1');
});

/* ── 수집기 동작(목 주입) ────────────────────────────────────────────────── */

test('API 로 읽으면 SSH 를 열지 않는다(부하를 더하지 않는다)', async () => {
  let sshCalled = false;
  const r = await ent.collectEnterpriseUsage({ host: 'https://1.1.1.1', username: 'u', password: 'p' }, {
    _fetchUsageSensors: async () => ({ ok: true, cpuPct: 12, memPct: 40, usedPaths: { cpuPct: '/a' }, seenSensors: [] }),
    _withSsh: async () => { sshCalled = true; return {}; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'api');
  assert.equal(sshCalled, false);
});

test('⚠⚠ 센서 인증 거부(401/403)면 SSH 로 폴백하지 않는다', async () => {
  let sshCalled = false;
  const r = await ent.collectEnterpriseUsage({ host: 'https://1.1.1.1', username: 'u', password: 'p' }, {
    _fetchUsageSensors: async () => ({ ok: false, kind: 'auth', error: '401' }),
    _withSsh: async () => { sshCalled = true; return {}; },
  });
  assert.equal(r.kind, 'auth');
  assert.equal(sshCalled, false, '자격증명 거부에 재시도하면 iDRAC 계정이 잠긴다');
});

test('센서가 없으면 SSH 로 넘어가고, 원문을 실어 온다', async () => {
  const r = await ent.collectEnterpriseUsage({ host: 'https://1.1.1.1', username: 'u', password: 'p' }, {
    _fetchUsageSensors: async () => ({ ok: false, kind: 'absent', error: '없음', absent: ['sensors'], seenSensors: [] }),
    _withSsh: async (creds, fn) => fn({ exec: async () => ({ stdout: 'CPUUsage 7 %\nMemoryUsage 61 %', stderr: '', code: 0 }) }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.cpuPct, 7);
  assert.ok(r.raw.includes('CPUUsage'), '원문을 실어야 파서가 빗나가도 사용자가 알려줄 수 있다(v2.542 규약)');
});

test('⚠ 읽지 못하면 unparsed 이고 값을 지어내지 않는다', async () => {
  const r = await ent.collectEnterpriseUsage({ host: 'https://1.1.1.1', username: 'u', password: 'p' }, {
    _fetchUsageSensors: async () => ({ ok: false, kind: 'absent', absent: ['sensors'], seenSensors: [] }),
    _withSsh: async (creds, fn) => fn({ exec: async () => ({ stdout: 'command not found', stderr: '', code: 1 }) }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unparsed');
  assert.equal(r.cpuPct, undefined);
});

test('⚠⚠ 전력·온도를 수집하지 않는다(사용자 지시) — 그 호출이 소스에 없어야 한다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/bmusage/collectors/idracEnterprise.js', import.meta.url), 'utf8'));   // 주석 제거(규칙 설명이 통과 근거가 되면 안 된다)
  assert.ok(!/fetchPower|fetchSensors/.test(src), '전력·온도 수집기를 부르면 안 된다');
});

/* ── 동의(ack) 게이트 ────────────────────────────────────────────────────── */

test('⚠⚠ 동의 없이는 Enterprise 대체 수집이 켜지지 않는다', () => {
  assert.equal(normalizeSettings({ enterpriseEnabled: true }).enterpriseEnabled, false);
  assert.equal(normalizeSettings({ enterpriseEnabled: true, enterpriseAck: true }).enterpriseEnabled, true);
});

test('iDRAC 경로를 끄면 대체 수집도 돌지 않는다', () => {
  assert.equal(enterpriseActive({ enterpriseEnabled: true, enterpriseAck: true, idracTelemetry: true }), true);
  assert.equal(enterpriseActive({ enterpriseEnabled: true, enterpriseAck: true, idracTelemetry: false }), false);
});

test('enterpriseMode 는 알려진 값만 받는다', () => {
  assert.equal(normalizeSettings({ enterpriseMode: 'zz' }).enterpriseMode, 'auto');
  assert.equal(normalizeSettings({ enterpriseMode: 'ssh' }).enterpriseMode, 'ssh');
});

/* ── 대상 해석 · 합성 ────────────────────────────────────────────────────── */

test('라이선스는 캐시된 인벤토리에서 읽고, 없으면 unknown 이다', () => {
  const { targets } = resolveTargets({
    bareMetal: [{ serverId: 'i1', serviceTag: 'TAG1', name: 's1', vcenterId: 'vc1' }],
    registry: [{ id: 'i1', serviceTag: 'TAG1', host: 'https://10.0.0.1', username: 'u', password: 'p' }],
    settings: { corps: { vc1: true }, idracTelemetry: true, osSsh: false, enterpriseEnabled: true, enterpriseAck: true },
    inventoryOf: () => ({ licenses: [{ name: 'iDRAC9 Enterprise License' }], collectedAt: 123 }),
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].license.tier, 'enterprise');
  assert.equal(targets[0].entAllowed, true);
});

test('동의가 없으면 entAllowed 가 false 다', () => {
  const { targets } = resolveTargets({
    bareMetal: [{ serverId: 'i1', serviceTag: 'TAG1', name: 's1', vcenterId: 'vc1' }],
    registry: [{ id: 'i1', serviceTag: 'TAG1', host: 'https://10.0.0.1', username: 'u', password: 'p' }],
    settings: { corps: { vc1: true }, idracTelemetry: true, enterpriseEnabled: true, enterpriseAck: false },
    inventoryOf: () => null,
  });
  assert.equal(targets[0].entAllowed, false);
});

test('⚠ 대체 경로 값은 빈 칸만 채우고 출처를 밝힌다(OS 값을 덮지 않는다)', () => {
  const r = buildUsage({
    target: { key: 'K', name: 's' },
    os: { ok: true, osKind: 'windows', cpuPct: 33, mem: { usedPct: 50 } },
    ent: { ok: true, via: 'ssh', cpuPct: 7, memPct: 61, ioPct: 5 },
  });
  assert.equal(r.row.cpu_pct, 33, 'OS 값이 이긴다');
  assert.equal(r.srcOf.cpu, 'os');
  assert.equal(r.row.io_pct, 5, 'OS 가 주지 않는 지표는 대체 경로가 채운다');
  assert.equal(r.srcOf.io, 'idrac-ent');
});

test('대체 경로 실패는 상세에 사유로 남는다(조용히 사라지지 않는다)', () => {
  const r = buildUsage({
    target: { key: 'K', name: 's', license: { tier: 'enterprise' } },
    idrac: { ok: false, kind: 'no-telemetry', error: '404' },
    ent: { ok: false, kind: 'unparsed', error: '형식 미인식', raw: '???', tried: ['api', 'ssh'] },
  });
  assert.equal(r.detail.entKind, 'unparsed');
  assert.equal(r.detail.entRaw, '???');
  assert.equal(r.detail.license.tier, 'enterprise');
});

/* ── 법인 귀속 없음 원인 ─────────────────────────────────────────────────── */

test('귀속 없음 원인을 나눈다 — 등록부 비어 있음 / 유령 귀속 / 등록 없음', () => {
  const r = unassignedCauses({
    unassigned: [
      { key: 'ABC', name: 's1', serviceTag: 'ABC', serverId: 'i1' },
      { key: 'i2', name: 's2', serviceTag: '', serverId: 'i2' },
      { key: 'DEF', name: 's3', serviceTag: 'DEF', serverId: 'i3' },
    ],
    registry: [{ id: 'i1', serviceTag: 'ABC' }, { id: 'i3', serviceTag: 'DEF' }],
    assign: { def: 'vc-gone' },
    vcenterIds: ['vc1'],
  });
  assert.equal(r.total, 3);
  assert.equal(r.byCause['registry-no-vc'], 1);
  assert.equal(r.byCause['no-registry-match'], 1);
  assert.equal(r.byCause['assign-ghost'], 1);
  // ⚠ 유령 귀속은 그 id 를 보여준다 — 어느 법인이 사라졌는지가 곧 진단이다.
  assert.equal(r.samples.find((x) => x.cause === 'assign-ghost').ghostVcenterId, 'vc-gone');
});

test('상한으로 자른 개수를 밝힌다(조용한 상한 금지)', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, name: `s${i}`, serviceTag: '', serverId: `i${i}` }));
  const r = unassignedCauses({ unassigned: many, sampleMax: 5 });
  assert.equal(r.samples.length, 5);
  assert.equal(r.truncated, 25);
});

/* ══════════════ v2.554 — v2.552 무음 미보고 결함(사용자 실화면으로 확정) ═════ */

test('⚠⚠ 엣지 워커는 0건·꺼짐이어도 중앙에 보고한다(조기 return 으로 되돌리지 말 것)', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/agent/linkCheckWorker.js', import.meta.url), 'utf8'));   // 주석 제거(v2.535 규약)
  // '잴 링크가 0개' 분기와 '중앙이 껐다' 분기 **둘 다** push 를 부른다.
  const zero = /if \(!links\.length\) \{[\s\S]{0,400}?pushReport\(/.test(src);
  const off = /if \(cfg\?\.enabled !== true\) \{[\s\S]{0,400}?pushReport\(/.test(src);
  assert.ok(zero, '잴 링크가 0개일 때도 상태를 올려야 한다(v2.517 sendStatusOnly 규약)');
  assert.ok(off, '중앙이 껐을 때도 상태를 올려야 한다');
});

test('빈 보고도 저장되고, 엣지가 밝힌 사유를 그대로 들고 있는다', async () => {
  const mod = await import('../src/central/linkCheckEdge.js');
  mod._resetEdgeLinkReportsForTest();
  const r = await mod.putEdgeLinkReport('GM1', { version: '2.554.0', results: [], note: '이 엣지가 잴 링크가 없습니다' });
  assert.equal(r.ok, true);
  assert.equal(r.stored, 0);
  const rep = mod.edgeLinkReport('GM1');
  assert.ok(rep, '빈 보고도 보고다 — 없으면 중앙이 "첫 보고 대기" 라고만 말한다');
  assert.equal(rep.note, '이 엣지가 잴 링크가 없습니다');
  assert.equal(rep.links, 0);
});

test('중앙이 껐다는 보고는 그 사실을 남긴다', async () => {
  const mod = await import('../src/central/linkCheckEdge.js');
  mod._resetEdgeLinkReportsForTest();
  await mod.putEdgeLinkReport('GM2', { results: [], note: '중앙에서 통신 점검이 꺼져 있습니다.', disabled: true });
  assert.equal(mod.edgeLinkReport('GM2').disabledOnCentral, true);
});

test('⚠ 엣지 워커 상태가 엣지 로그 표에 등재돼 있다(없으면 진단할 길이 없다)', async () => {
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  const row = STATUS_SPEC.find((x) => x.fn === 'linkCheckWorkerStatus');
  assert.ok(row, 'v2.552 가 이 워커를 만들면서 표에 넣지 않아 진단이 불가능했다');
  assert.equal(row.mod, '../agent/linkCheckWorker.js');
});
