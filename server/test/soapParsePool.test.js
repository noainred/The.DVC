import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObjectContent } from '../src/vcenter/soapParse.js';
import { parseObjectContentAsync, shutdownParsePool, _poolInfo } from '../src/util/soapParsePool.js';

// 하나의 <returnval> 블록 생성기(파싱 결과 검증용).
function vmBlock(i) {
  return `<returnval>`
    + `<obj type="VirtualMachine">vm-${i}</obj>`
    + `<propSet><name>name</name><val xsi:type="xsd:string">web-${i} &amp; db</val></propSet>`
    + `<propSet><name>runtime.powerState</name><val>poweredOn</val></propSet>`
    + `</returnval>`;
}

test('parseObjectContentAsync: 소형 입력은 인라인 파싱과 동일 결과', async () => {
  const xml = vmBlock(1);
  assert.ok(xml.length < 262_144, '소형 페이로드(인라인 경로)');
  const got = await parseObjectContentAsync(xml);
  assert.deepEqual(got, parseObjectContent(xml));
  assert.equal(got[0].props.name, 'web-1 & db'); // 엔티티 복원 확인
});

test('parseObjectContentAsync: 대형 입력을 워커로 오프로딩해도 인라인과 동일 결과', async () => {
  // 워커 오프로딩 임계값(256KB)을 넘기도록 다수 VM 블록을 이어붙인다.
  let xml = '';
  let n = 0;
  while (xml.length < 300_000) { xml += vmBlock(n); n++; }
  assert.ok(xml.length >= 262_144, '대형 페이로드(워커 경로)');

  const expected = parseObjectContent(xml);
  const got = await parseObjectContentAsync(xml);

  assert.equal(got.length, expected.length, '객체 수 일치');
  assert.deepEqual(got, expected, '워커 파싱 결과가 인라인과 완전히 동일');
  // 표본 검증: 마지막 VM의 필드.
  assert.equal(got[n - 1].type, 'VirtualMachine');
  assert.equal(got[n - 1].ref, `vm-${n - 1}`);
  assert.equal(got[n - 1].props['runtime.powerState'], 'poweredOn');
  assert.equal(got[n - 1].props.name, `web-${n - 1} & db`);

  await shutdownParsePool();
});

test('parseObjectContentAsync: 빈 입력 안전 처리', async () => {
  assert.deepEqual(await parseObjectContentAsync(''), []);
  assert.deepEqual(await parseObjectContentAsync(null), []);
  const info = _poolInfo();
  assert.ok(info.workerCount >= 0);
  await shutdownParsePool();
});
