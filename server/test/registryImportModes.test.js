import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리된 CONFIG_DIR — 레지스트리가 이 디렉터리를 쓴다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-import-'));
process.env.CONFIG_DIR = tmp;

let registry;
before(async () => { registry = await import('../src/idrac/registry.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// 각 테스트는 깨끗한 레지스트리에서 시작. (importServers([],'replace')는 이제 안전장치로
// 빈 목록 전체교체를 거부하므로, 레지스트리 파일을 직접 지워 초기화한다.)
beforeEach(() => { for (const f of fs.readdirSync(tmp)) { try { fs.rmSync(path.join(tmp, f), { force: true }); } catch { /* */ } } });

const srv = (id, datacenterId, extra = {}) => ({
  id, name: id, host: id, username: 'root', password: 'x', datacenterId, ...extra,
});

test("replace-datacenter: 해당 법인의 stale 서버는 제거하고 다른 법인은 보존", () => {
  // 법인 A에 2대, 법인 B에 1대 등록.
  registry.importServers([srv('a1', 'corpA'), srv('a2', 'corpA'), srv('b1', 'corpB')], 'merge');
  assert.equal(registry.loadRegistry().length, 3);

  // 법인 A 재스캔: 이번엔 a1만 발견(a2는 폐기됨). replace-datacenter로 a2가 제거되어야 한다.
  const r = registry.importServers([srv('a1', 'corpA')], 'replace-datacenter');
  assert.ok(r.ok);
  const ids = registry.loadRegistry().map((s) => s.id).sort();
  assert.deepEqual(ids, ['a1', 'b1'], '법인 A의 stale(a2)만 제거, 법인 B(b1)는 보존');
});

test("replace-datacenter: incoming이 새 서버면 추가, 기존 발견 서버는 갱신", () => {
  registry.importServers([srv('a1', 'corpA'), srv('a2', 'corpA')], 'merge');
  // 재스캔: a1 갱신 + a3 신규. a2는 미발견 → 제거.
  const r = registry.importServers([srv('a1', 'corpA', { name: 'renamed' }), srv('a3', 'corpA')], 'replace-datacenter');
  assert.ok(r.ok);
  const list = registry.loadRegistry();
  const ids = list.map((s) => s.id).sort();
  assert.deepEqual(ids, ['a1', 'a3']);
  assert.equal(list.find((s) => s.id === 'a1').name, 'renamed');
});

test("replace-datacenter: 유효 incoming 0건이면 기존을 통째로 지우지 않음(블립 방지)", () => {
  registry.importServers([srv('a1', 'corpA')], 'merge');
  // datacenterId 없는(검증되더라도 dcs.size===0) 빈 incoming → 삭제 안 함.
  const r = registry.importServers([], 'replace-datacenter');
  assert.ok(r.ok);
  assert.equal(registry.loadRegistry().length, 1, '빈 incoming은 기존 보존');
});

test("replace-datacenter: 한 법인만 영향 — 다른 법인 서버는 id가 겹쳐도 무관", () => {
  registry.importServers([srv('x', 'corpA'), srv('y', 'corpB')], 'merge');
  // 법인 B 재스캔에서 y만 발견 → 법인 A의 x는 건드리지 않는다.
  registry.importServers([srv('y', 'corpB')], 'replace-datacenter');
  const ids = registry.loadRegistry().map((s) => s.id).sort();
  assert.deepEqual(ids, ['x', 'y']);
});
