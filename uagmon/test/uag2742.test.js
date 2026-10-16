/**
 * v2.742(감사 INJPKG-05) — UAG XML 통계 파서의 선형화.
 *  예전 /<edgeServiceSessionStats>([\s\S]*?)<\/edgeServiceSessionStats>/g 는 닫는 태그가 없으면 여는 태그마다 본문 끝까지 훑어
 *  O(n²) 였다(2MB 상한 응답 하나로 이벤트 루프 수 초 정지 — UAG 응답은 외부 입력). indexOf 선형 추출로 바꿨다.
 *  ① 정상·비정상 입력에서 예전 정규식 구현과 결과가 같다(결정적 난수 대조) ② 닫는 태그 없는 긴 입력에서 훨씬 빠르다(비율).
 *
 * 실행: node --test uagmon/test/uag2742.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStats } from '../lib/uag.js';

// 예전 구현(xmlToDoc 의 블록 추출부) — 결과 대조용 사본. tagValue 는 lib 과 같다.
function tagValue(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1] : undefined;
}
function oldBlocks(xml) {
  const out = [];
  const re = /<edgeServiceSessionStats>([\s\S]*?)<\/edgeServiceSessionStats>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    out.push({
      identifier: tagValue(block, 'identifier'),
      edgeServiceStatus: tagValue(block, 'edgeServiceStatus') ?? tagValue(block, 'status'),
      totalSessionCount: tagValue(block, 'totalSessionCount') ?? tagValue(block, 'sessionCount'),
      highWaterMark: tagValue(block, 'highWaterMark'),
    });
  }
  return out;
}
// parseStats 가 서비스 원소에 하는 정규화(lib 과 같은 규칙) — 예전 블록 결과를 같은 모양으로 맞춘다.
const svcId = (b) => String(b.identifier || '').toUpperCase() || 'UNKNOWN';

test('INJPKG-05 ① 예전 정규식 구현과 서비스 목록이 같다(고정 사례 + 결정적 난수)', () => {
  const O = '<edgeServiceSessionStats>'; const C = '</edgeServiceSessionStats>';
  const fixed = [
    `<a>${O}<identifier>VIEW</identifier><totalSessionCount>3</totalSessionCount>${C}${O}<identifier>WEB</identifier>${C}</a>`,
    `<a>${O}<identifier>X</identifier>`, // 닫는 태그 없음
    `<a>${O}${O}<identifier>N</identifier>${C}${C}`, // 중첩된 여는 태그
    `<a>${C}${O}<identifier>Z</identifier>${C}`,
    `<a>${O}${C}`,
  ];
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const parts = [O, C, '<identifier>ID</identifier>', '<status>UP</status>', '<sessionCount>4</sessionCount>', 'x', '<', '>'];
  const rand = [];
  for (let i = 0; i < 2000; i++) {
    let s = '<r>'; const n = Math.floor(rnd() * 10);
    for (let j = 0; j < n; j++) s += parts[Math.floor(rnd() * parts.length)];
    rand.push(s);
  }
  for (const xml of [...fixed, ...rand]) {
    const got = parseStats(xml);
    const want = oldBlocks(xml);
    assert.equal(got.ok, true, xml);
    assert.deepEqual(got.services.map((s) => [s.id, s.status, s.sessions]), want.map((b) => [svcId(b), String(b.edgeServiceStatus || '').toUpperCase(), b.totalSessionCount == null ? null : Number(b.totalSessionCount)]), xml);
  }
});

test('INJPKG-05 ② 닫는 태그 없는 긴 입력에서 선형(예전 이차 구현보다 훨씬 빠르다 — 비율로 본다)', () => {
  const unit = '<edgeServiceSessionStats>';
  const s = '<x>' + unit.repeat(Math.floor(200 * 1024 / unit.length)); // 200KB(예전 구현 약 0.2초 — 2MB 상한이면 수 초)
  const t0 = process.hrtime.bigint(); oldBlocks(s); const tOld = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint(); const r = parseStats(s); const tNew = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(r.services.length, 0);
  assert.ok(tOld > 40 ? tNew * 10 < tOld : tNew < 50, `old ${tOld.toFixed(1)}ms · new ${tNew.toFixed(1)}ms`);
});
