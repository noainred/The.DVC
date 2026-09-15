/**
 * storageNetError.test.js — v2.513 회귀 고정.
 *
 * 사용자 신고(2026-09-15): 한 법인 PowerStore 만 전 섹션 `fetch failed` + 상단 `This operation was
 * aborted`, 다른 법인은 정상인데 `alerts: HTTP 400 — Unable to parse passed url.` 하나만 오류.
 *
 * 고정하는 것:
 *  1) 전송 계층 실패가 **무엇을 확인해야 하는지** 말하는 한 줄이 된다(원문 코드는 남긴다).
 *  2) HTTP 응답을 받은 오류(4xx/5xx·401)는 다시 감싸지 않는다 — 이미 사유가 있다.
 *  3) alerts 쿼리는 PostgREST 문법(`state=eq.ACTIVE`)이며 `filter=` 를 쓰지 않는다.
 *  4) state 필터 실패 시 폴백이 동작하고, 그 사실이 **조용히 묻히지 않는다**(alertsNote).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { errorCode, errorText, describeFetchError, isTransportError } from '../src/storage/collectors/netError.js';
import { isActiveAlert, normalizePowerstore } from '../src/storage/collectors/powerstore.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** undici 가 실제로 던지는 모양: TypeError('fetch failed') + cause 에 진짜 코드. */
function undiciError(code, msg = 'fetch failed') {
  const inner = new Error(`connect ${code} 10.76.159.29:443`);
  inner.code = code;
  const outer = new TypeError(msg);
  outer.cause = inner;
  return outer;
}

test('errorCode: cause 사슬을 따라가 syscall 코드를 찾는다', () => {
  assert.equal(errorCode(undiciError('ECONNREFUSED')), 'ECONNREFUSED');
  // 2단 중첩(undici 가 실제로 이렇게 준다)
  const deep = new TypeError('fetch failed');
  deep.cause = undiciError('ETIMEDOUT');
  assert.equal(errorCode(deep), 'ETIMEDOUT');
  assert.equal(errorCode(new Error('그냥 오류')), '');
});

test('errorText: 사슬 전체 메시지를 모은다', () => {
  const t = errorText(undiciError('ECONNREFUSED'));
  assert.match(t, /fetch failed/);
  assert.match(t, /ECONNREFUSED/);
});

test('describeFetchError: 코드별로 확인 항목을 말하고 대상·원문 코드를 남긴다', () => {
  const s = describeFetchError(undiciError('ECONNREFUSED'), { host: '10.76.159.29', port: 443 });
  assert.match(s, /10\.76\.159\.29:443/);      // 어느 장비인지
  assert.match(s, /거부/);                      // 사람이 읽는 사유
  assert.match(s, /\(ECONNREFUSED\)/);          // 근거(원문 코드)를 지우지 않는다
  assert.doesNotMatch(s, /fetch failed/);       // 쓸모없던 원문만 남지 않는다

  for (const code of ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPROTO', 'CERT_HAS_EXPIRED']) {
    const m = describeFetchError(undiciError(code), { host: 'h', port: 443 });
    assert.match(m, new RegExp(`\\(${code}\\)`), `${code} 원문 코드 누락`);
    assert.ok(m.length > 20, `${code} 안내 문구가 비었다`);
  }
});

test('describeFetchError: 타임아웃은 실제 제한 시간을 말한다(그냥 aborted 아님)', () => {
  const e = new Error('The operation was aborted');
  e.name = 'TimeoutError';
  const s = describeFetchError(e, { host: '10.76.159.29', port: 443, timeoutMs: 15_000 });
  assert.match(s, /15초/);
  assert.match(s, /방화벽|응답/);
  assert.doesNotMatch(s, /^This operation was aborted$/);
});

test('describeFetchError: 호출자 취소는 장비 탓이 아니라고 분명히 말한다', () => {
  const e = new Error('This operation was aborted');
  const s = describeFetchError(e, { host: 'h', port: 443, cancelled: true });
  assert.match(s, /취소/);
  assert.match(s, /장비 오류가 아/);
});

test('isTransportError: HTTP 응답을 받은 오류는 감싸지 않는다', () => {
  assert.equal(isTransportError(undiciError('ECONNREFUSED')), true);
  assert.equal(isTransportError(new Error('HTTP 400 — Unable to parse passed url.')), false);
  assert.equal(isTransportError(new Error('인증 실패(401) — 계정/비밀번호 확인')), false);
  assert.equal(isTransportError(new Error('공간 지표 없음')), false);
});

test('restCommon/isilon 의 모든 fetch 가 설명 래퍼를 지난다', () => {
  const rc = readFileSync(join(SRC, 'storage/collectors/restCommon.js'), 'utf8');
  // 래퍼 본체(1곳)를 빼면 직접 fetch 호출이 남아 있으면 안 된다.
  assert.equal((rc.match(/await fetch\(/g) || []).length, 1, 'restCommon 에 설명 래퍼를 안 거치는 fetch 가 있다');
  assert.ok((rc.match(/fetchOrExplain\(/g) || []).length >= 4, 'getter/rawGetter/poster 3곳이 래퍼를 써야 한다');
  const il = readFileSync(join(SRC, 'storage/collectors/isilon.js'), 'utf8');
  assert.match(il, /describeFetchError/, 'isilon 도 같은 규약을 따라야 한다');
});

test('PowerStore alerts 쿼리는 PostgREST 문법 — filter= 를 쓰지 않는다', () => {
  const ps = readFileSync(join(SRC, 'storage/collectors/powerstore.js'), 'utf8');
  assert.match(ps, /\/api\/rest\/alert\?select=id,severity&state=eq\.ACTIVE/);
  // `filter=state.eq.ACTIVE` 로 되돌리면 장비가 HTTP 400 'Unable to parse passed url.' 로 거부한다.
  // ⚠ 주석에는 그 옛 문법이 근거로 남아 있으므로, **실제 호출 줄**(get('/api/rest/...'))만 본다.
  const calls = ps.split('\n').filter((l) => /get\(['"`]\/api\/rest\//.test(l));
  assert.ok(calls.length > 5, '수집 호출 줄을 찾지 못했다 — 검사 자체가 무력화됐다');
  for (const l of calls) assert.doesNotMatch(l, /filter=/, `PostgREST 에 없는 filter= 파라미터: ${l.trim()}`);
});

test('isActiveAlert: state 가 있으면 그 값으로, 없으면 확인된 것만 제외', () => {
  assert.equal(isActiveAlert({ state: 'ACTIVE' }), true);
  assert.equal(isActiveAlert({ state: 'active' }), true);
  assert.equal(isActiveAlert({ state: 'CLEARED' }), false);
  // state 필드 자체가 없는 버전: 확인(acknowledged)된 것만 뺀다 — 없다고 임의로 제외하지 않는다.
  assert.equal(isActiveAlert({ is_acknowledged: false }), true);
  assert.equal(isActiveAlert({}), true);
  assert.equal(isActiveAlert({ is_acknowledged: true }), false);
});

test('alertsNote 는 extra 로만 — sections 에 섞으면 정상 수집이 빨간 오류로 보인다', () => {
  const dev = { id: 'd1', name: 'PS', type: 'powerstore', host: '10.93.1.1' };
  const note = 'state 필터 미지원(HTTP 400) — 전체를 받아 미해결만 집계';
  const snap = normalizePowerstore(dev, { alerts: [{ id: 'a', severity: 'Critical' }], alertsNote: note });
  assert.equal(snap.sections.alerts, 'ok');            // 배지는 초록 OK 그대로
  assert.equal(snap.extra.alertsNote, note);           // 사실은 따로 밝힌다
  assert.equal(snap.alerts.unresolved, 1);
  // 폴백을 안 탄 정상 경로에는 문구가 붙지 않는다.
  const clean = normalizePowerstore(dev, { alerts: [], alertsNote: '' });
  assert.equal(clean.sections.alerts, 'ok');
  assert.equal(clean.extra.alertsNote, undefined);
});
