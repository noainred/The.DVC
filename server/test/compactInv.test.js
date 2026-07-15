import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactInv } from '../src/collector/agent.js';

// 엣지 export 콤팩트 인벤토리 회귀 방지 — 과거 nics 필드가 누락돼 중앙 'NIC 속도/모델 확인'
// 화면에서 엣지 원격 서버 전부가 '정보없음'(모델 0종)으로 나왔다.

test('compactInv: nics(어댑터·포트 speedMbps)를 export에 포함한다', () => {
  const out = compactInv({
    system: { model: 'PowerEdge R750', serviceTag: 'ABC1234', biosVersion: '1.0' },
    nics: [{
      name: 'NIC.Integrated.1', model: 'Intel(R) Ethernet 10G 4P X710',
      ports: [{ id: 'NIC.Integrated.1-1', link: 'Up', speedMbps: 10000, extra: 'drop-me' }],
    }],
    collectedAt: 123,
  });
  assert.equal(out.nics.length, 1);
  assert.equal(out.nics[0].model, 'Intel(R) Ethernet 10G 4P X710');
  assert.deepEqual(out.nics[0].ports, [{ id: 'NIC.Integrated.1-1', link: 'Up', speedMbps: 10000 }]);
});

test('compactInv: nics 없으면 빈 배열(구버전 인벤토리 호환)', () => {
  const out = compactInv({ system: { model: 'R650' }, collectedAt: 1 });
  assert.deepEqual(out.nics, []);
  assert.equal(compactInv(null), null);
});
