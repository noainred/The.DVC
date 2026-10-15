/**
 * v2.741 리드 통합분(서버) — 그룹 수정이 남긴 배선을 고정한다.
 *
 * ① CVP 전력 탭의 '못 읽음' 분류(DEV-03 후속)는 합산(devicePower)과 같은 PSU 목록(powerSupplies)으로 가른다 —
 *    슬롯 전원 항목만 있는 장비가 'PSU 없음' 이 아니라 '전력 필드 없음' 으로 잘못 세지던 것.
 * ② 엣지 CVP 수신의 PSU 범위는 parse.PSU_W_MAX 한 벌(숫자 리터럴 사본 금지).
 * ③ SAN 연결 테스트(DEV-02 후속)는 세션 예산을 테스트 시한보다 짧게 넘긴다 — 기본 예산(100초)이 시한(60초)보다 길면
 *    예산 가드가 발동하기 전에 시한이 먼저 던져 모은 출력이 통째로 버려진다.
 * ④ 아키텍처 점검의 BIG_JSON_SMALL 사유는 사실이어야 한다 — bmstor-collect 는 대상 id 만 싣지 않는다.
 * ⑤ API 문서 생성기가 새 게이트 이름(csvPermIfDownload·tokenFirst)의 뜻을 안다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { powerSupplies, devicePower, PSU_W_MAX } from '../src/cvp/parse.js';
import { stripComments } from './_stripComments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('① CVP 전력 탭 — 분류 PSU 목록 = 합산 PSU 목록', () => {
  const src = stripComments(read('server/src/routes/api/cvp.js'));
  assert.match(src, /const psus = parts \? powerSupplies\(parts\)\.length : 0;/);
  assert.doesNotMatch(src, /p\.kind === 'psu' && p\.state !== 'absent'\)\.length/, '분류용 PSU 필터 사본이 남아 있다');
  // 슬롯 전원만 있는 장비: 합산은 null(PSU 없음) — 분류도 PSU 0 개여야 noPsu 로 간다.
  const parts = [{ kind: 'psu', name: 'ecb › Linecard3', role: 'slot-power', state: 'ok', power: { inW: 120 } }];
  assert.equal(devicePower(parts), null);
  assert.equal(powerSupplies(parts).length, 0);
});

test('② 엣지 CVP 수신 PSU 범위 — PSU_W_MAX 한 벌', () => {
  const src = stripComments(read('server/src/central/cvpEdge.js'));
  assert.match(src, /v < PSU_W_MAX \? v : null/);
  assert.doesNotMatch(src, /v < 100_000 \? v : null/);
  assert.equal(PSU_W_MAX, 100_000);
});

test('③ SAN 연결 테스트 — 세션 예산 < 테스트 시한', () => {
  const src = stripComments(read('server/src/sanswitch/poller.js'));
  const m = src.match(/export async function testDeviceConnection[\s\S]*?\n}\n/);
  assert.ok(m, 'testDeviceConnection 본문을 찾지 못했다');
  assert.match(m[0], /const budgetMs = Math\.max\(5_000, timeoutMs - 10_000\);/);
  assert.match(m[0], /fosSsh\.collect\(device, \{[^}]*budgetMs[^}]*\}\)/, 'fosSsh.collect 에 budgetMs 를 넘겨야 한다');
  for (const t of [60_000, 30_000, 8_000]) assert.ok(Math.max(5_000, t - 10_000) < t, `시한 ${t}ms 에서 예산이 시한보다 짧아야 한다`);
});

test('④ BIG_JSON_SMALL 사유 — 라우트 파서 한도와 실제 본문', () => {
  const src = read('server/src/portalcheck/archScan.js');
  assert.doesNotMatch(src, /'collector:\/bmstor-collect': '수집 요청 — 대상 id'/);
  assert.match(src, /'collector:\/bmstor-collect': '[^']*SSH 자격증명[^']*1MB/);
  assert.match(src, /'collector:\/idrac-scan': '[^']*1MB/);
  const col = read('server/src/routes/collector.js');
  assert.match(col, /post\('\/bmstor-collect', tokenFirst\('bmstor-collect'\), express\.json\(\{ limit: '1mb' \}\)/);
  assert.match(col, /post\('\/idrac-scan', tokenFirst\('idrac-scan'\), express\.json\(\{ limit: '1mb' \}\)/);
});

test('⑤ API 문서 생성기 — 새 게이트 이름의 뜻', () => {
  const src = read('scripts/api-doc.mjs');
  assert.match(src, /\n {2}csvPermIfDownload: "/);
  assert.match(src, /\n {2}tokenFirst: "/);
});
