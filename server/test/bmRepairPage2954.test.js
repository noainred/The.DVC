/**
 * bmRepairPage2954.test.js — 롤업 보정 대기 읽기가 앞 쪽의 막힌 대기 때문에 뒤의 정상 대기를 굶기지 않는다(v2.954 · 개선 검토 1번).
 *  예전: `_pend ORDER BY h LIMIT max` 한 쪽만 읽어, 앞 max 건이 모두 막힌 파일(손상된 연도 d1)로 가면 뒤의 1시간 대기는 끝없이 남았다.
 *  이제: (h, rowid) 키셋으로 다음 쪽을 잇는다 — 쪽이 가득 찼을 때만 · 파일당 PEND_PAGES_MAX 쪽까지.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2954rp-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;

test('막힌 d1 대기가 앞 쪽을 채워도 뒤 쪽의 1시간 대기를 처리한다 · 막힌 대기는 남는다 · 쪽 상한', async () => {
  const M = await import('../src/bmusage/monthStore.js');
  const h0 = M.hourOf(Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR);
  const h1 = h0 + HOUR;
  if (M.periodKeyOf('raw', h0) !== M.periodKeyOf('raw', h1)) return;   // 달 경계 시각이면 이 시험은 뜻이 없다
  // 연도 d1 파일 자리를 디렉터리로 만들어 열기 실패(손상 흉내) — 1일 대기는 모두 그 파일로 간다
  fs.mkdirSync(path.join(M.dbDir(), M.fileNameOf('d1', M.periodKeyOf('d1', h0))), { recursive: true });
  await M.withPeriodFile('raw', M.periodKeyOf('raw', h0), { create: true }, (db) => {
    const ins = db.prepare('INSERT INTO _pend (agent,key,h,daily,at) VALUES (?,?,?,?,?)');
    for (let i = 0; i < 5; i++) ins.run('', `K${i}`, h0, 1, Date.now());
    ins.run('', 'Z', h1, 0, Date.now());   // 뒤의 정상 대기(1시간만)
  });
  const pendKeys = () => M.withPeriodFile('raw', M.periodKeyOf('raw', h0), {}, (db) => db.prepare('SELECT key FROM _pend ORDER BY key').all().map((r) => r.key));
  const r = await M.repairPending({ max: 3, ignoreBackoff: true });
  const left = await pendKeys();
  assert.ok(!left.includes('Z'), `뒤 쪽의 1시간 대기가 처리돼야 한다 — 남은 대기 ${left} · ${JSON.stringify(r)}`);
  assert.deepEqual(left, ['K0', 'K1', 'K2', 'K3', 'K4'], '막힌 d1 로 가는 대기는 지우지 않는다(다음 보정이 다시 한다)');
  assert.ok(r.pages >= 1 && r.errors.length >= 1, JSON.stringify(r));
  assert.equal(r.pendMore, undefined, '쪽 상한에 닿지 않았다');
  assert.equal(M.PEND_PAGES_MAX, 10);
});
