/**
 * 대량 자동등록 재설계(줄별 {엣지·호스트네임·IP}) 회귀 방지.
 *  - 대상 agent(엣지) 필드가 CSV·JSON 을 왕복하고 저장된다(testSchema 단일 소스).
 *  - agent 형식 검증(감시 배정 키라 오타 차단).
 *  - /import 가 templateId 를 서버에서 실체화한다(줄별 임의 호스트명 + 템플릿).
 *  - PUT /assign/:agent 가 by-agent 모드 + '다른 엣지 소유 제외'(이중 감시 방지) 규칙을 쓴다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-agent-'));
process.env.SVCMON_WORKERS = '0';

const store = await import('../src/svcmon/store.js');
const schema = await import('../src/svcmon/testSchema.js');
const { targetsToCsv, parseTargetsCsv } = await import('../src/svcmon/csvio.js');
const { parseTargetsAny } = await import('../src/svcmon/formats.js');

test('스키마: agent 열이 TARGET_FIELDS·CSV_COLUMNS 에 있고 선택 필드다', () => {
  const f = schema.TARGET_FIELDS.find((x) => x.key === 'agent');
  assert.ok(f, 'TARGET_FIELDS 에 agent 필드');
  assert.equal(f.optional, true, 'agent 는 선택 필드(기존 CSV 호환)');
  assert.ok(schema.CSV_COLUMNS.includes('agent'), 'CSV_COLUMNS 에 agent 열');
});

test('저장: 대상에 agent 가 저장·조회된다', () => {
  const t = store.addTarget({ kind: 'infra', path: 'A', name: 'h-agent', host: '10.1.0.1', agent: 'SBP-EDGE' });
  assert.equal(t.agent, 'SBP-EDGE');
  const got = store.listTargets().find((x) => x.id === t.id);
  assert.equal(got.agent, 'SBP-EDGE');
});

test('저장: agent 를 비우면 값이 없다(경로 배정 따름)', () => {
  const t = store.addTarget({ kind: 'infra', path: 'A', name: 'h-noagent', host: '10.1.0.2' });
  assert.ok(!t.agent, 'agent 비면 falsy(undefined 또는 빈 문자열)');
});

test('검증: 잘못된 agent 이름 형식은 거부(공백/특수문자)', () => {
  assert.throws(() => store.addTarget({ kind: 'infra', path: 'A', name: 'h-bad', host: '10.1.0.3', agent: 'bad name!' }),
    /엣지 이름 형식/);
});

test('CSV 왕복: agent 가 내보내기→가져오기에서 보존된다', () => {
  const t = store.addTarget({ kind: 'infra', path: 'B', name: 'h-csv', host: '10.1.0.4', agent: 'OC2-EDGE' });
  const csv = targetsToCsv([t]);
  assert.match(csv, /OC2-EDGE/, '내보낸 CSV 에 agent 값');
  const parsed = parseTargetsCsv(csv);
  const row = parsed.targets.find((x) => x.name === 'h-csv');
  assert.ok(row, '가져오기에서 대상 존재');
  assert.equal(row.agent, 'OC2-EDGE', '가져오기에서 agent 보존');
});

test('JSON 왕복: {targets:[{...,agent}]} 가 parseTargetsAny 로 agent 를 보존한다(BulkTab 등록 경로)', async () => {
  const content = JSON.stringify({ targets: [{ kind: 'infra', path: 'C', name: 'h-json', host: '10.1.0.5', enabled: false, agent: 'KR-EDGE' }] });
  const parsed = await parseTargetsAny(content, 'json', { maxRows: 2000 });
  const row = parsed.targets.find((x) => x.name === 'h-json');
  assert.ok(row, 'JSON 파싱에서 대상 존재');
  assert.equal(row.agent, 'KR-EDGE', 'JSON→CSV→파싱에서 agent 보존');
});

test('정적: /import 가 templateId 를 materializeForTarget 로 서버 실체화한다', () => {
  // v2.291: routes/svcmon.js 분할로 /targets/import 는 routes/svcmon/transfer.js 로 이동.
  const src = fs.readFileSync(new URL('../src/routes/svcmon/transfer.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf("post('/targets/import'"), src.indexOf("post('/targets/import'") + 3500);
  assert.match(body, /req\.body\?\.templateId/);
  assert.match(body, /materializeForTarget\(tplId, t\)/);
  assert.match(body, /t\.tests = \[\.\.\.\(t\.tests \|\| \[\]\), \.\.\.r\.tests\]/);
});

test('정적: PUT /assign/:agent 가 byAgent 모드 + 다른 엣지 소유 제외 규칙을 쓴다', () => {
  // v2.291: routes/svcmon.js 분할로 /assign/:agent 는 routes/svcmon/edge.js 로 이동.
  const src = fs.readFileSync(new URL('../src/routes/svcmon/edge.js', import.meta.url), 'utf8');
  const i = src.indexOf("put('/assign/:agent'");
  const body = src.slice(i, i + 1200);
  assert.match(body, /const byAgent = req\.body\?\.byAgent === true/);
  assert.match(body, /if \(byAgent\) return owner === agentName/);
  assert.match(body, /if \(owner && owner !== agentName\) return false/, '경로 스코프에서 타 엣지 소유 제외');
});
