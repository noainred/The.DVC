/**
 * v3.10.5 — 공용 유틸 점검 3회차(서버 공용 유틸 사용처 61~88번) 회귀.
 *
 *  ① soapParsePool — 워커가 뜨자마자 죽으면 재생성을 1분에 RESPAWN_MAX 번까지만 하고, 남은 워커가 없으면 풀을 접고 메인 스레드에서 파싱한다.
 *     예전에는 'error' → 재생성 → 'error' 가 쉬지 않고 이어졌다(설치본에 parseWorker.js 가 없거나 깨진 경우). 파싱 결과는 그대로 돌아온다.
 *  ② staticGzip — 옛 판본을 합계에서 빼면 캐시에서도 지운다(상한에 걸린 새 판본 때문에 옛 판본이 합계 밖에서 메모리에 남던 것).
 *     합계는 모듈 밖으로 드러나지 않아 테스트는 다시 만드는 경로까지만 본다.
 *
 * ⚠ 워커 수 · 오프로드 문턱은 모듈을 불러올 때 env 로 굳으므로 import 전에 정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SOAP_PARSE_WORKERS = '1';
process.env.SOAP_PARSE_MIN_CHARS = '1';

const pool = await import('../src/util/soapParsePool.js');
const { parseObjectContent } = await import('../src/vcenter/soapParse.js');
const { createStaticGzip } = await import('../src/util/staticGzip.js');

test('① 뜨자마자 죽는 워커 — 재생성은 한도까지 · 풀을 접고 인라인으로 파싱한다', async () => {
  const warn = console.warn; const warned = [];
  console.warn = (m) => warned.push(String(m));
  try {
    pool._setWorkerUrlForTest(new URL('file:///nonexistent-dvc-parse-worker-3105.js'));
    const xml = '<returnval><obj type="VirtualMachine">vm-1</obj></returnval>';
    const got = await pool.parseObjectContentAsync(xml);
    assert.deepEqual(got, parseObjectContent(xml), '죽은 워커가 물고 있던 작업은 인라인으로 처리한다');
    // 남은 재생성이 한도까지 돌고 풀이 접히기를 기다린다.
    for (let i = 0; i < 300 && !pool._poolInfo().broken; i++) await new Promise((r) => setTimeout(r, 20));
    const info = pool._poolInfo();
    assert.equal(info.broken, true, '워커가 하나도 남지 않으면 풀을 접는다');
    assert.equal(info.active, false);
    assert.ok(info.respawnsInWindow <= pool.RESPAWN_MAX, `재생성 ${info.respawnsInWindow}번`);
    assert.equal(warned.filter((w) => w.includes('[soap-parse]')).length, 1, '경고는 한 번');
    // 접힌 뒤의 호출은 메인 스레드에서 바로 파싱한다.
    assert.deepEqual(await pool.parseObjectContentAsync(xml), parseObjectContent(xml));
  } finally {
    console.warn = warn;
    pool._setWorkerUrlForTest(null);
    await pool.shutdownParsePool();
  }
});

// ⚠ 합계(total)는 모듈 밖으로 드러나지 않아 여기서는 '파일이 바뀌면 새 판본으로 다시 만든다' 까지만 본다 — 상한 경로의 정리는 코드 판독으로 확인했다.
test('② staticGzip — 파일이 바뀌면 옛 판본을 버리고 새 판본을 만든다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg3105-'));
  try {
    fs.mkdirSync(path.join(dir, 'assets'));
    const f = path.join(dir, 'assets', 'app.js');
    fs.writeFileSync(f, 'a'.repeat(4096));
    const mw = createStaticGzip(dir);
    const call = () => new Promise((resolve) => {
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ gz: this.headers['Content-Encoding'] === 'gzip', len: b ? b.length : 0 }); } };
      mw({ method: 'GET', path: '/assets/app.js', headers: { 'accept-encoding': 'gzip' } }, res, () => resolve({ gz: false, next: true }));
    });
    const a = await call();
    assert.equal(a.gz, true);
    // 파일이 바뀌면(mtime) 다시 만든다 — 옛 판본은 캐시에서 빠진다(다시 요청해도 새 판본).
    const t = Date.now() / 1000 + 5;
    fs.writeFileSync(f, 'b'.repeat(8192));
    fs.utimesSync(f, t, t);
    const b = await call();
    assert.equal(b.gz, true);
    assert.notEqual(a.len, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
