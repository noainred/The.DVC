/**
 * hardening2577.test.js — v2.577 전수 보안·튜닝 감사 회귀 고정.
 *
 * 이 릴리스가 고친 것 셋을 계약으로 못 박는다. 셋 다 **실측으로 정한 값**이라 근거 없이
 * 되돌리면 그 측정이 무의미해진다.
 *
 * 1) CSP 기본 켜짐 — v2.576 까지 `index.js` 주석이 *"인라인 스타일/intro 페이지 호환 이슈로
 *    기본 비활성"* 이라 적고 CSP 를 통째로 꺼 두었는데 그것은 **측정하지 않은 가정**이었다.
 *    Chromium 실측(21화면 + intro 2쪽): 메인 포탈 **위반 0건**, 위반은 전부 `/intro` 에서만
 *    (외부 CDN 스타일시트 2종 + dc-runtime 의 문자열 `eval`). 세션 토큰이 `localStorage` 에
 *    있어 XSS 한 번이면 탈취되는데(v2.538 기록) CSP 가 없으면 완화 수단이 **하나도 없다**.
 * 2) `/top` memoJson — 15초 폴링 경로인데 형제 인벤토리 5종과 달리 캐시가 없어 매 요청
 *    **VM 배열 5회·호스트 3회 복사 정렬**을 했다. 운영 규모 실측(33 vCenter·6,004 VM)에서
 *    콜드/웜 배수가 **1.0x**(다른 라우트 2.8~5.5x)로 캐시 부재가 그대로 드러났다.
 * 3) gunzip 출력 상한 — `upgrade/archive.js` 는 v2.488 에 받았는데 `backup/service.js` 만
 *    빠져 있었다(형제 경로 누락). 실증: 100KB gzip → 100MB(증폭 1,029배).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
/** 주석을 지우되 **개행은 보존**한다 — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다(v2.535). */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ''.padEnd(0));

test('★ CSP — 기본 정책이 코드에 있고 앱 정책에는 unsafe-eval 이 없다', () => {
  const s = strip(read('index.js'));
  assert.match(s, /const DEFAULT_CSP = \[/, 'DEFAULT_CSP 가 사라졌다 — CSP 가 다시 옵트인으로 돌아갔다');
  const app = s.slice(s.indexOf('const DEFAULT_CSP'), s.indexOf('const INTRO_CSP'));
  assert.match(app, /"script-src 'self'"/, '앱 script-src 가 바뀌었다');
  assert.ok(!/unsafe-eval/.test(app), "앱 CSP 에 'unsafe-eval' 이 들어갔다 — XSS→localStorage 토큰 탈취 완화가 사라진다");
  assert.match(app, /"object-src 'none'"/);
  assert.match(app, /"frame-ancestors 'none'"/);
  // 인라인 **스타일**은 React 의 style={{}} 때문에 필수다 — 스크립트 실행을 허용하지 않는다.
  assert.match(app, /style-src 'self' 'unsafe-inline'/);
});

test('★ CSP — 완화는 /intro 에만 적용되고 env 로 끄거나 바꿀 수 있다', () => {
  const s = strip(read('index.js'));
  assert.match(s, /const INTRO_CSP = \[/, 'intro 전용 정책이 사라졌다');
  const intro = s.slice(s.indexOf('const INTRO_CSP'), s.indexOf('const CSP_HEADER'));
  assert.match(intro, /unsafe-eval/, 'intro 의 dc-runtime 은 문자열 eval 을 쓴다 — 빼면 데모 페이지가 깨진다');
  // 적용 분기: /intro 판정이 실제로 있어야 한다(정책만 선언하고 안 쓰면 뜻이 없다).
  assert.match(s, /req\.path === '\/intro' \|\| req\.path\.startsWith\('\/intro\/'\)/);
  assert.match(s, /process\.env\.CSP === 'off'/, 'CSP=off 탈출구가 사라졌다');
});

test('★ /top — memoJson + scopeKey (없으면 무제한 계정 결과가 범위 계정에 캐시로 샌다)', () => {
  const s = strip(read('routes/api/inventory.js'));
  const i = s.indexOf("api.get('/top'");
  assert.ok(i > 0, '/top 라우트가 사라졌다');
  const body = s.slice(i, s.indexOf("api.get('/alarms'", i));
  assert.match(body, /memoJson\(req, res, 'inv:top'/, '/top 이 다시 캐시 없는 경로가 됐다(15초 폴링 · 전량 정렬)');
  // v2.583: 키에 권한 조합(`|p…`)이 더 붙었다(inv.* 게이트) — 의도는 'scopeKey 가 키에 들어 있다' 이다.
  assert.match(body, /extraKey: `?\$?\{?scopeKey\(req\.user, store\.get\(\)\)/, 'scopeKey 가 빠지면 스코프가 다른 계정이 같은 캐시를 공유한다');
  assert.ok(!/res\.json\(\{/.test(body), 'memoJson 은 값을 return 해야 한다 — res.json 을 직접 부르면 캐시가 채워지지 않는다');
});

/**
 * 호출 전체를 **괄호 깊이로** 잘라낸다.
 * ⚠ `[^)]*` 를 쓰지 말 것 — `gunzipSync(fs.readFileSync(p), {...})` 처럼 인자에 괄호가 있으면
 *   첫 `)` 에서 멈춰 **상한이 있는 호출을 없다고 오판한다**(v2.535 가 `chmodSync` 검사에서 겪은
 *   것과 같은 실수를 v2.577 초판이 그대로 반복했고 이 테스트가 잡았다).
 */
function decompressCalls(src, fnRe) {
  const out = [];
  for (const m of src.matchAll(fnRe)) {
    let i = m.index + m[0].length - 1;   // 여는 괄호 위치
    let depth = 0;
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

test('★ 압축 해제에는 출력 상한이 있다 (zip bomb)', () => {
  const calls = decompressCalls(strip(read('backup/service.js')), /zlib\.gunzipSync\(/g);
  assert.ok(calls.length >= 2, `gunzipSync 호출을 찾지 못했다(${calls.length})`);
  for (const c of calls) assert.match(c, /maxOutputLength/, `상한 없는 해제: ${c}`);
  // 형제 파일도 유지되는지(v2.488 이 받은 것을 되돌리지 않게)
  for (const c of decompressCalls(strip(read('upgrade/archive.js')), /zlib\.(?:gunzipSync|inflateRawSync)\(/g)) {
    assert.match(c, /maxOutputLength/, `upgrade/archive.js 의 상한이 사라졌다: ${c}`);
  }
});

test('★ 압축 상한이 실제로 발동한다 (증폭 1000배 실증)', () => {
  const gz = zlib.gzipSync(Buffer.alloc(80 * 1024 * 1024, 0x41));
  assert.ok(gz.length < 1024 * 1024, `증폭비가 낮아 이 검사가 무의미하다(${gz.length}B)`);
  assert.throws(() => zlib.gunzipSync(gz, { maxOutputLength: 8 * 1024 * 1024 }), /ERR_BUFFER_TOO_LARGE|too large/i);
});

test('★ MOCK_SCALE — 기본값 1 은 기존 수치를 바꾸지 않는다', async () => {
  const s = strip(read('mock/generator.js'));
  assert.match(s, /const MOCK_SCALE = Math\.max\(1, Math\.min\(8,/, 'MOCK_SCALE 상한·하한이 사라졌다');
  assert.match(s, /MOCK_SCALE === 1 \? BASE_SITES/, '기본값에서 사본을 만들면 데모·CI 의 vCenter 수가 바뀐다');
  delete process.env.MOCK_SCALE;
  const m = await import(`${path.join(SRC, 'mock/generator.js')}?v=${Date.now()}`);
  assert.equal(m.mockVcenterIdentities().filter((v) => /^vc-/.test(v.id)).length >= 11, true);
  const snap = m.generateSnapshot();
  assert.equal(snap.vcenters.length, 11, `기본 MOCK_SCALE 에서 vCenter 수가 바뀌었다(${snap.vcenters.length})`);
  // 사본도 mock 으로 인식돼야 한다 — 아니면 엣지 push 봉인(v2.257)·빈 인벤토리 판정(v2.560)이 갈린다.
  assert.equal(m.isMockVcenter(snap.vcenters[0]), true);
});
