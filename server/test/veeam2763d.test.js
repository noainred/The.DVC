/**
 * v2.763 수정본 재검토(R2) 후속.
 *  R2-1 시계가 맞는 엣지의 전송·재시도 지연(2분 미만)은 보정하지 않는다 — 결과(push)·스냅샷 요약 양쪽
 *  R2-4 CSV 비밀번호 칸이 수식 방지 접두(')로 시작하면 드라이런 경고(값은 그대로)
 *  R2-6 엣지의 중앙 배정 서버 '비밀번호 없음' 안내는 중앙 포탈로
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2763d-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

test('R2-1: 결과 쪽 — 2분 미만 차이는 0, 2분 이상·30일 이하만 보정', async () => {
  const { edgeClockOffset, CLOCK_FIX_MIN_MS } = await import('../src/central/veeamEdge.js');
  assert.equal(CLOCK_FIX_MIN_MS, 120_000);
  assert.equal(edgeClockOffset({ sentAt: NOW - 60_000 }, NOW), 0, '시계가 맞고 전송 1분 — 결과를 1분 새것처럼 만들지 않는다');
  assert.equal(edgeClockOffset({ sentAt: NOW + 90_000 }, NOW), 0);
  assert.equal(edgeClockOffset({ sentAt: NOW - 40 * 60_000 }, NOW), 40 * 60_000, '40분 늦은 엣지는 보정');
  assert.equal(edgeClockOffset({ sentAt: NOW - 31 * 86_400_000 }, NOW), 0, '30일 초과는 보정 안 함');
  assert.equal(edgeClockOffset({}, NOW), 0, '옛 엣지');
});

test('R2-1: 스냅샷 요약 쪽 — 같은 2분 기준', async () => {
  const S = await import('../src/veeam/snapEvents.js');
  const base = { vcenterId: 'eu:vca', status: 'ok', byVm: {}, collectedAt: NOW - 2 * HOUR };
  const { items } = S.sanitizeEdgeSnap([
    { ...base, at: NOW - 60_000 },
    { ...base, vcenterId: 'eu:vcb', at: NOW - 40 * 60_000 },
  ], () => true, NOW);
  assert.equal(items[0].collectedAt, NOW - 2 * HOUR, '1분 차이는 옮기지 않는다');
  assert.equal(items[0].edgeCollectedAt, undefined);
  assert.equal(items[1].collectedAt, NOW - 2 * HOUR + 40 * 60_000, '40분은 옮긴다');
});

test("R2-4: CSV 비밀번호가 ' 로 시작하면 드라이런 경고 — 값은 그대로", async () => {
  const B = await import('../src/veeam/bulk.js');
  const r = B.parseServersCsv("host,name,username,password,vcenters\nvbr01.corp,A,svc,'-Secret1,kr:vc01\nvbr02.corp,B,svc,Plain1,kr:vc01\n");
  assert.equal(r.rows[0].password, "'-Secret1");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /작은따옴표/);
  assert.equal(r.warnings[0].includes('Secret1'), false, '경고에 비밀번호 값을 싣지 않는다');
});

test('R2-6: 엣지의 중앙 배정 서버 비밀번호 없음 안내는 중앙 포탈로(소스)', () => {
  const src = fs.readFileSync(new URL('../src/veeam/poller.js', import.meta.url), 'utf8');
  assert.match(src, /full\.pulled === true \? '중앙 포탈의 '/);
});
