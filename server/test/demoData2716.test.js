/**
 * demoData2716.test.js — 데모(mock) 데이터 보완 1회차(v2.716).
 *
 * ① ESXi 호스트 서비스태그 — 시리얼 조회 'ESXi 호스트' 가 0건이었다. Dell 호스트는 iDRAC 데모 시드와 같은 태그.
 * ② 버전/패치 준수 'Tools 업그레이드 필요' — idx%17(템플릿과 같은 집합)이라 언제나 0대였다.
 * ③ 라이트사이징 '과대할당' — CPU 평균 20% 미만 · vCPU≥2 인 VM 이 데모에 없었다('lean' 프로필).
 * ④ Monitoring(svcmon) 데모 대상 — 탭이 통째로 비어 있었다. 대상은 검증을 통과해야 하고, 결과는 접속 없이 합성.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2716-'));
process.env.DATA_SOURCE = 'mock';

const { generateSnapshot } = await import('../src/mock/generator.js');
const { mockServiceTag } = await import('../src/mock/seed.js');
const { computeCompliance } = await import('../src/reports/compliance.js');
const { demoSvcmonTargets, demoSvcmonResult, isSvcmonDemoTarget, SVCMON_DEMO_BATCH } = await import('../src/mock/demo/svcmon.js');
const { planBulkTargets } = await import('../src/svcmon/store.js');

const snap = generateSnapshot();

test('① 모든 ESXi 호스트에 서비스태그 · seed.js 와 같은 규칙(Dell 호스트 = 자기 iDRAC 태그)', () => {
  assert.ok(snap.hosts.length > 0);
  for (const h of snap.hosts) assert.equal(h.serviceTag, mockServiceTag(`${h.vcenterId}|${h.name}`), h.name);
  assert.equal(new Set(snap.hosts.map((h) => h.serviceTag)).size, snap.hosts.length, '태그 충돌 없음');
});

test('② 버전/패치 준수: Tools 업그레이드 필요가 0 이 아니다', () => {
  const r = computeCompliance(snap);
  assert.ok(r.summary.toolsNeedUpgrade > 0, JSON.stringify(r.summary));
});

test('③ 라이트사이징: 과대할당 후보(vCPU≥2 · CPU<20% · 유휴 아님)가 있다', () => {
  // 한 스냅샷의 순간값이 아니라 여러 틱 동안 줄곧 5~20% 인 VM(라이트사이징은 관측 평균을 본다).
  const max = new Map(); const min = new Map();
  for (let i = 0; i < 12; i++) for (const v of generateSnapshot().vms) {
    if (v.powerState !== 'POWERED_ON' || v.cpuCount < 2) continue;
    max.set(v.id, Math.max(max.get(v.id) ?? 0, v.cpuUsagePct)); min.set(v.id, Math.min(min.get(v.id) ?? 100, v.cpuUsagePct));
  }
  const lean = [...max].filter(([id, m]) => m < 20 && min.get(id) >= 5);
  assert.ok(lean.length > 20, `lean=${lean.length}`);
});

test('④ svcmon 데모 대상은 검증을 통과하고 결과는 합성(결정적 · 세 상태가 다 나온다)', () => {
  const list = demoSvcmonTargets(snap);
  assert.ok(list.length >= 20, `targets=${list.length}`);
  const plan = planBulkTargets(list, { batch: SVCMON_DEMO_BATCH });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.prepared.length, list.length);
  assert.ok(plan.prepared.every((p) => p.target.batch === SVCMON_DEMO_BATCH));
  assert.ok(plan.prepared.some((p) => p.target.kind === 'service') && plan.prepared.some((p) => p.target.kind === 'infra'));
  const now = 1_790_000_000_000;
  const st = new Set();
  for (const p of plan.prepared) for (const t of p.target.tests) {
    const r = demoSvcmonResult(t, p.target.host, now);
    assert.deepEqual(r, demoSvcmonResult(t, p.target.host, now));
    assert.match(r.status, /^(ok|warn|bad)$/);
    st.add(r.status);
  }
  assert.deepEqual([...st].sort(), ['bad', 'ok', 'warn']);
  assert.equal(isSvcmonDemoTarget({ batch: SVCMON_DEMO_BATCH }), true);
  assert.equal(isSvcmonDemoTarget({ batch: 'b-123' }), false, '사람이 등록한 대상은 실제로 점검한다');
});

test('④ live 모드에서는 데모 대상도 실제 점검 대상이다(합성은 mock 에서만)', async () => {
  const { setDataSource } = await import('../src/runtime-settings.js').catch(() => ({}));
  if (typeof setDataSource !== 'function') return; // 런타임 전환 API 가 없으면 소스로 확인
  setDataSource('live');
  try { assert.equal(isSvcmonDemoTarget({ batch: SVCMON_DEMO_BATCH }), false); } finally { setDataSource('mock'); }
});

test('④ 폴러는 데모 대상을 runBatch 에 넘기지 않는다(소스)', () => {
  const src = fs.readFileSync(new URL('../src/svcmon/poller.js', import.meta.url), 'utf8');
  assert.match(src, /const live = due\.filter\(\(\{ target \}\) => !isSvcmonDemoTarget\(target\)\)/);
  assert.match(src, /runBatch\(live\.map/);
});
