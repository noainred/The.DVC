/**
 * bmOnboardLost2954.test.js — 7b 엣지 적용 상태 파일 손상 뒤 '잃음(lost)' 표지가 **실제 인출 흐름**에서 유지된다(v2.954 반증 — 재현).
 *  예전 수정(D-3 ②)은 apply 를 직접 불러 시험했는데, 실제 인출 워커는 쿼리를 만들려고 상태를 **먼저** 읽는다 — 그때 손상본이 옆으로 치워지고
 *  apply 의 두 번째 읽기가 '파일 없음 = 신규 설치' 가 되어 lost 를 잃고 새 서명을 중앙에 보고했다(중앙 제거 대기가 풀림 → 두 노드가 같은 서버).
 *  ① 손상 → 인출 두 번: 둘째 인출의 쿼리 applied 는 빈 값(서명 보고 안 함) ② lost 보류에는 시한(LOST_HOLD_MS)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bmlost2954-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FILE = path.join(DIR, 'bm-onboard-applied.json');
const SIG = 'a'.repeat(32);

test('① 손상 → 실제 인출 두 번 — 둘째 인출도 적용 서명을 보고하지 않는다', async () => {
  const P = await import('../src/agent/bmOnboardPull.js');
  fs.writeFileSync(FILE, '{"sig":"' + 'b'.repeat(32) + '", "created": {"srv1":');   // 잘린 JSON
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, status: 200, headers: new Map(), json: async () => ({ ok: true, distribute: true, rows: [], sig: SIG }), text: async () => JSON.stringify({ ok: true, distribute: true, rows: [], sig: SIG }), body: null }; };
  const r1 = await P.pullBmOnboardNow({ fetchImpl });
  const r2 = await P.pullBmOnboardNow({ fetchImpl });
  assert.equal(urls.length, 2, JSON.stringify([r1, r2]));
  for (const u of urls) assert.equal(new URL(u, 'http://x').searchParams.get('applied'), '', `적용 서명을 보고하면 중앙이 제거 대기를 푼다 — ${u}`);
  const st = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(st.lost, true); assert.ok(Number(st.lostSince) > 0, 'lostSince 가 남는다(시한 기준)');
});

test('② lost 보류에는 시한 — LOST_HOLD_MS 를 넘기면 풀린다', async () => {
  const EA = await import('../src/bmusage/onboard/edgeApply.js');
  assert.equal(EA.LOST_HOLD_MS, 7 * 86_400_000);
  fs.writeFileSync(FILE, JSON.stringify({ sig: SIG, lost: true, lostSince: Date.now() - EA.LOST_HOLD_MS - 60_000, at: Date.now(), created: {} }));
  const s = EA.readAppliedState();
  assert.equal(s.state.lost, false); assert.equal(s.state.sig, SIG);
  fs.writeFileSync(FILE, JSON.stringify({ sig: SIG, lost: true, lostSince: Date.now() - 60_000, at: Date.now(), created: {} }));
  assert.equal(EA.readAppliedState().state.lost, true);
});
