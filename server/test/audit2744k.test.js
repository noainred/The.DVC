// v2.744(감사 후속 FA-④): 직접 수집 대상이 아닌 vCenter 의 사유 문장 표는 한 벌이다.
//   dsBrowse.js(주문형 로그인 문 v2.742)와 authStopGate.js(성능 조회 문 v2.744)가 같은 표를 각자 들고 있었다 —
//   audit2744f ② 가 '내용이 같은지' 를 대조했지만, 한쪽만 고치면 그 테스트를 고치는 것으로 끝나 두 화면 문구가 갈라진다.
//   이제 dsBrowse 는 authStopGate 의 표를 그대로 다시 내보낸다(같은 객체). 판정도 authStopGate.vcSkipOf 하나를 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');

test('① dsBrowse 의 ON_DEMAND_SKIP_TEXT 는 authStopGate 의 DIRECT_SKIP_TEXT 와 같은 객체다(사본 아님)', async () => {
  const { DIRECT_SKIP_TEXT } = await import('../src/vcenter/authStopGate.js');
  const { ON_DEMAND_SKIP_TEXT } = await import('../src/vcenter/dsBrowse.js');
  assert.equal(ON_DEMAND_SKIP_TEXT, DIRECT_SKIP_TEXT);
  assert.ok(Object.isFrozen(ON_DEMAND_SKIP_TEXT));
});

test('② onDemandVcBlock 의 직접 수집 대상 판정은 vcSkipOf 와 같은 결과다(비활성·점검중·엣지 위임)', async () => {
  const { vcSkipOf } = await import('../src/vcenter/authStopGate.js');
  const { onDemandVcBlock } = await import('../src/vcenter/dsBrowse.js');
  const cases = [
    { id: 'vc-d', host: 'h', enabled: false },
    { id: 'vc-m', host: 'h', maintenance: true },
    { id: 'vc-s', host: 'h', collectMode: 'site', remoteAgent: 'Edge-A' },
  ];
  for (const vc of cases) {
    const want = vcSkipOf(vc);
    assert.ok(want, `${vc.id} 는 직접 수집 대상이 아니어야 한다`);
    assert.deepEqual(onDemandVcBlock(vc), want);
    assert.deepEqual(onDemandVcBlock(vc, { allowAuthStopped: true }), want);
  }
});

test('③ dsBrowse 소스에 사유 문장 표 사본이 없고 재수출은 import + export 형태다(export … from 금지)', () => {
  const s = stripComments(src('vcenter/dsBrowse.js'));
  assert.ok(!s.includes('수집이 멈춰 있어 이 포탈이 로그인하지 않습니다'), '사유 문장을 다시 적지 않는다');
  assert.ok(!/export\s*\{[^}]*\}\s*from\s/.test(s), 'export … from 은 모듈 스코프에 이름을 만들지 않는다(v2.575)');
  assert.match(s, /export\s*\{\s*DIRECT_SKIP_TEXT\s+as\s+ON_DEMAND_SKIP_TEXT\s*\}/);
});
