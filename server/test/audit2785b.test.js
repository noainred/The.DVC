/**
 * v2.785(GH) — 게스트 파티션 점검 후속:
 *   H-B1 VM 상세 '수집 시각' 은 값의 원천(part_latest)의 시각이어야 한다 — 부분 합 보류(partialHeld)·partialStale 로
 *        vm_latest 에 옛 ts 가 남아도 '수집 N시간 전'·'최근 수집이 실패했을 수 있습니다' 가 거짓으로 뜨지 않게.
 *   H-B4 'Windows CD-ROM·ISO(추정)' 은 C: 를 추정에서 뺀다 — 가득 찬 10GB 이하 C: 가 정확히 가득 찬 순간 경보에서 빠지던 역전.
 *   H-I2 partUsedAt 은 (vmId,path) 별 `ORDER BY ts DESC LIMIT 1` 탐색 — 옛 상관 서브쿼리와 결과가 같고 인덱스 탐색을 탄다.
 * DB 를 쓰는 테스트는 실제 시각(정시 경계로 떨어뜨린 NOW)을 쓴다(docs/rules/common.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2785b-'));
process.env.CONFIG_DIR = DIR;
process.env.GUESTDISK_DB_PATH = path.join(DIR, 'guest-disk.db');
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;   // 정시에서 30분 떨어뜨린 실제 시각
const H = 3_600_000;
const DAY = 86_400_000;

test('H-B1: 부분 합 보류(partialHeld) 뒤 VM 상세 collectedAt 은 이번 수집 시각(값과 같은 시각) — 거짓 수집 실패 안내 없음', async () => {
  const db = await import('../src/guestdisk/db.js');
  const { buildVmPartitions } = await import('../src/guestpart/report.js');
  const { vmPartNote } = await import('../../web/src/views/tools/guestPartText.js');
  const vc = 'vc-h1'; const vmId = 'vc-h1:vm-1';
  const t0 = NOW - 30 * H;   // 주기 12h × 2 < 30h ≤ 보류 시한 12h × 3
  assert.ok((await db.commitCollection(vc, 'VC-H1', [{ vmId, vmName: 'app01', allocGB: 150, usedGB: 60, partCount: 2,
    parts: [{ path: 'C:\\', capGB: 100, usedGB: 50 }, { path: 'D:\\', capGB: 50, usedGB: 10 }] }], { ts: t0 })).ok);
  const r2 = await db.commitCollection(vc, 'VC-H1', [{ vmId, vmName: 'app01', allocGB: 100, usedGB: 99, partCount: 1, partsUnknown: 1, unknownPaths: ['D:\\'],
    parts: [{ path: 'C:\\', capGB: 100, usedGB: 99 }] }], { ts: NOW });
  assert.ok(r2.ok);
  const rec = await db.vmPartLatest(vmId);
  assert.equal(rec.vm.ts, t0, '전제: vm_latest 는 직전 온전한 행(옛 ts)을 보류한다 — 회수 리포트용이라 그대로 둔다');
  const out = buildVmPartitions(rec, { threshold: 80, rules: {} }, { vcenterId: vc, vmName: 'app01' });
  assert.equal(out.collectedAt, NOW, '값(C: 99%)은 이번 수집 — 시각도 이번 수집');
  assert.equal(out.parts.find((p) => p.path === 'C:\\').pct, 99);
  assert.equal(out.partial, false, 'partial 은 vm_latest 합계의 표지 — 바꾸지 않는다(보류 합계는 온전한 값)');
  const note = vmPartNote({ dbAvailable: true, collect: { enabled: true, intervalHours: 12 }, collectedAt: out.collectedAt, partial: out.partial, offsetMin: 540 }, NOW + 60_000);
  assert.ok(!note?.stale, `거짓 '수집 실패 가능' 안내가 없어야 한다: ${JSON.stringify(note)}`);
});

test('H-B1: collectedAt 은 파티션 행 ts 의 최대 · 파티션이 없으면 vm.ts · 다른 vCenter 행은 여전히 null', async () => {
  const { buildVmPartitions } = await import('../src/guestpart/report.js');
  const rec = { vm: { vcenterId: 'vc-a', ts: NOW - 40 * H, partial: true },
    parts: [{ path: '/', capGB: 50, usedGB: 20, unknown: false, ts: NOW }, { path: '/x', capGB: null, usedGB: null, unknown: true, ts: NOW }] };
  const r = buildVmPartitions(rec, {}, { vcenterId: 'vc-a' });
  assert.equal(r.collectedAt, NOW);
  assert.equal(r.partial, true);
  assert.equal(buildVmPartitions({ vm: rec.vm, parts: [] }, {}, { vcenterId: 'vc-a' }).collectedAt, NOW - 40 * H);
  assert.equal(buildVmPartitions(rec, {}, { vcenterId: 'vc-b' }).collectedAt, null);
});

test('H-B4: 가득 찬 10GB 이하 C: 는 ISO 추정에서 빠진다(경보 대상) — D:·F: 의 ISO 추정·기본 켜짐은 그대로', async () => {
  const R = await import('../src/guestpart/rules.js');
  const rules = R.rulesOf({});
  assert.equal(rules.win.iso, true, '기본값은 그대로 켜짐');
  assert.equal(R.ignoreReason({ path: 'C:\\', capGB: 9.9, usedGB: 9.9 }, rules), null, '가득 찬 C: 는 무시하지 않는다');
  assert.equal(R.ignoreReason({ path: 'c:\\', capGB: 10, usedGB: 10 }, rules), null, '소문자 c: 도');
  assert.equal(R.ignoreReason({ path: 'D:\\', capGB: 10, usedGB: 10 }, rules), 'win-iso');
  assert.equal(R.ignoreReason({ path: 'F:\\', capGB: 4, usedGB: 4 }, rules), 'win-iso');
  const ev = R.evaluate([{ vmId: 'v1', vcenterId: 'vc', path: 'C:\\', capGB: 9.9, usedGB: 9.9 }], { threshold: 80 }, { mode: 'part' });
  const c = ev.parts?.find?.((p) => p.path === 'C:\\') ?? ev.rows?.find?.((p) => p.path === 'C:\\');
  assert.ok(c, `evaluate 결과에 C: 가 있어야 한다: ${JSON.stringify(ev).slice(0, 300)}`);
  assert.equal(c.over, true, '100% C: 는 경보 대상');
});

test('H-I2: partUsedAt 결과는 옛 상관 서브쿼리와 같고, 키별 조회는 idx_ps_vm_path_ts 탐색을 탄다', async () => {
  const db = await import('../src/guestdisk/db.js');
  const d = await db.getDb();
  const ins = d.prepare('INSERT INTO part_series (vcenter_id,vm_id,path,ts,cap_gb,used_gb) VALUES (?,?,?,?,?,?)');
  const ids = [];
  d.exec('BEGIN');
  for (let v = 0; v < 620; v++) {   // 500 개 청크 경계를 넘긴다
    const id = `vc-i2:vm-${v}`; ids.push(id);
    const paths = v % 7 === 0 ? ['C:\\'] : ['C:\\', 'D:\\', '/data', `/m${v % 5}`];
    for (const p of paths) {
      const first = v % 11 === 0 && p === 'D:\\' ? 3 : 20;   // 일부 키는 기준 시각 뒤에야 처음 관측 → 결과에 없어야 한다
      for (let k = first; k >= 0; k -= 1 + (v % 3)) ins.run('vc-i2', id, p, NOW - k * DAY, 100, 10 + v * 0.01 + k);
    }
  }
  ins.run('vc-i2', 'vc-i2:vm-1', 'C:\\', NOW - 7 * DAY, 100, 77);   // 같은 ts 중복 행 — 옛 구현은 rowid 큰 행이 마지막에 남았다
  ins.run('vc-i2', 'vc-i2:vm-1', 'C:\\', NOW - 7 * DAY, 100, 78);
  d.exec('COMMIT');
  const cut = NOW - 7 * DAY;
  const old = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = d.prepare(`SELECT p.vm_id, p.path, p.used_gb FROM part_series p
      WHERE p.vm_id IN (${chunk.map(() => '?').join(',')})
        AND p.ts = (SELECT MAX(q.ts) FROM part_series q WHERE q.vm_id = p.vm_id AND q.path = p.path AND q.ts <= ?)`).all(...chunk, cut);
    for (const r of rows) old.set(`${r.vm_id}\u0000${r.path}`, Number(r.used_gb));
  }
  const got = await db.partUsedAt([...ids, 'vc-i2:none', ids[0]], cut);
  assert.ok(old.size > 1500, `픽스처 크기 ${old.size}`);
  assert.equal(got.size, old.size);
  for (const [k, v] of old) assert.equal(got.get(k), v, k);
  assert.equal(got.get('vc-i2:vm-1\u0000C:\\'), 78, '같은 ts 중복은 옛 구현처럼 rowid 큰 행');
  assert.equal(got.has('vc-i2:vm-0\u0000D:\\'), false, '그 키의 기준 점이 없으면 결과에 없다(0 증가로 지어내지 않는다)');
  assert.deepEqual(await db.partUsedAt([], cut), new Map());
  // 실행 계획 — 키별 조회는 인덱스 탐색, 정렬용 임시 B-트리·테이블 스캔 없음
  const plans = db._partUsedAtPlans ? await db._partUsedAtPlans() : null;
  assert.ok(Array.isArray(plans) && plans.length >= 2, 'partUsedAt 의 SQL 실행 계획을 꺼낼 수 있어야 한다');
  for (const p of plans) {
    assert.match(p, /SEARCH .*USING (COVERING )?INDEX idx_ps_vm_path_ts/, p);
    assert.doesNotMatch(p, /TEMP B-TREE|SCAN part_series/, p);
  }
});
