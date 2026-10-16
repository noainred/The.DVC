/**
 * v2.742 리드 통합분 회귀 — 수정 그룹이 '내 파일 밖' 으로 넘긴 형제 결함.
 *  · GI2 리드: storage/areasCollector.js 의 자격증명 거부 판정이 문구의 '401' 부분 일치였다 —
 *    호스트명(isi-401:8080)이나 본문에 401 이 든 전송 오류가 OneFS 영역 수집을 '인증 실패' 로 끊었다.
 *    판정은 restCommon.isCredReject 하나다(표지 authFailed·status 401, 표지 없는 옛 오류는 '인증 실패(401)' 접두만).
 *  · GI2 리드: pdu/collectRequests.js 의 장비 시한이 폴러·수집기와 다른 식의 사본이었다 — 수집기 값을 쓴다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742lead-'));
process.env.CONFIG_DIR = tmp;
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const DEV = { id: 'isi-lead', host: '10.0.0.1', username: 'u', password: 'p' };

test('GI2 리드 — 호스트명에 401 이 든 전송 오류는 인증 실패가 아니다(영역 수집을 끊지 않는다)', async () => {
  const { collectAreasOnce } = await import('../src/storage/areasCollector.js');
  let calls = 0;
  const get = async () => {
    calls++;
    // 장비가 살아 있다는 HTTP 상태 실패(404) — 전송 실패 회로 차단기에도 걸리지 않는다. 문구에 '401' 이 들어 있다.
    throw new Error('HTTP 404 isi-401.corp:8080 /platform/1/x');
  };
  const r = await collectAreasOnce(DEV, { get });
  assert.equal(r.authDead, false, '401 부분 일치로 인증 실패를 만들지 않는다');
  assert.notEqual(r.stopped, 'auth');
  assert.ok(calls > 1, `한 번에 끊지 않고 다음 엔드포인트를 시도한다(시도 ${calls}회)`);
});

test('GI2 리드 — 진짜 자격증명 거부(표지)는 첫 요청에서 끊는다(계정 잠금 예방)', async () => {
  const { collectAreasOnce } = await import('../src/storage/areasCollector.js');
  const { credRejectError } = await import('../src/storage/collectors/restCommon.js');
  let calls = 0;
  const get = async () => { calls++; throw credRejectError(); };
  const r = await collectAreasOnce(DEV, { get });
  assert.equal(r.authDead, true);
  assert.equal(r.stopped, 'auth');
  assert.equal(calls, 1, '거부 뒤에는 더 시도하지 않는다');
});

test('GI2 리드 — PDU 재수집 큐의 장비 시한은 수집기 값 하나를 쓴다(식 사본 금지)', () => {
  const src = fs.readFileSync(new URL('../src/pdu/collectRequests.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ PDU_DEVICE_TIMEOUT_MS \} from '\.\/collectors\/apcSsh\.js'/);
  assert.doesNotMatch(src, /process\.env\.PDU_DEVICE_TIMEOUT_MS/, 'env 를 다시 읽는 사본이 없다');
});

test('GH 리드 — 엣지가 보낸 totalCapped·totalCap 을 중앙 결과가 버리지 않는다(연합 조회 \'N건 이상\')', async () => {
  const { enqueueLogQuery, setLogQueryResult, getLogQueryResult } = await import('../src/central/logQueries.js');
  const a = enqueueLogQuery('vc-lead-a', { q: 'x' }, 'admin');
  assert.equal(setLogQueryResult(a, { vcenterId: 'vc-lead-a', total: 100000, totalCapped: true, totalCap: 100000, rows: [] }), true);
  const ra = getLogQueryResult(a);
  assert.equal(ra.state, 'done');
  assert.equal(ra.totalCapped, true);
  assert.equal(ra.totalCap, 100000);
  // 구버전 엣지(필드 없음)는 정확한 수로 본다 — 값을 지어내지 않는다.
  const b = enqueueLogQuery('vc-lead-b', {}, 'admin');
  setLogQueryResult(b, { vcenterId: 'vc-lead-b', total: 7, rows: [] });
  const rb = getLogQueryResult(b);
  assert.equal(rb.totalCapped, false);
  assert.equal(rb.totalCap, null);
  // 표지는 진리값 true 만 — 문자열 'true' 로 위조해도 상한 표지가 되지 않는다(아는 모양만 받는다).
  const c = enqueueLogQuery('vc-lead-c', {}, 'admin');
  setLogQueryResult(c, { vcenterId: 'vc-lead-c', total: 5, totalCapped: 'true', totalCap: -3, rows: [] });
  const rc = getLogQueryResult(c);
  assert.equal(rc.totalCapped, false);
  assert.equal(rc.totalCap, null);
});
