/**
 * v2.517 — 엣지 push 의 **포트 전송 범위** 회귀.
 *
 * 사용자 요청(2026-09-15, 스크린샷): 엣지 수집 스위치 상세에 "정상 포트 125개는 여기 표에 없습니다"
 * 만 보였다 — "전체 포트 보는 것으로 기능 개선".
 *
 * v2.516 까지 기본이 '문제 포트만' 이었던 근거는 "매 주기 수 MB 를 고RTT 회선으로 밀게 된다" 였는데
 * 그 수치는 **압축 전**이고 이 경로는 그 뒤 gzip 이 붙었다. 실제 포트 객체 형태로 실측하면
 * 128포트 × 8대 = 원본 408KB · **gzip 12KB**(약 34배 압축)라 5분 주기로 하루 3.5MB 다.
 * 그래서 기본을 전체로 바꿨고, 되돌리는 길 두 개를 남겼다 — 이 테스트가 그 둘을 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';

const { slimSnapshot, fullSnapshot, scopeSnapshot, chunkDevices, portsScopeSetting } = await import('../src/sanswitch/push.js');

const port = (i, bad = false) => ({
  index: i, state: bad ? 'faulty' : 'online', speed: '32G', portType: 'F-Port',
  attached: [`50:06:01:60:47:e0:5a:${(i % 256).toString(16).padStart(2, '0')}`],
  attachedName: 'ARRAY_SYNTH_0001::SAF-1d', licensed: true,
  errCrc: 0, errLinkFail: 0, errLossSync: 0, rxPowerDbm: -2.4, txPowerDbm: -1.1, sfpTempC: 38,
});
const snapOf = (n, badIdx = [1]) => ({
  deviceId: 'sw-1', name: 'SW-1', agent: 'HG', collectedAt: 1,
  ports: { total: n, licensed: n, online: n, list: Array.from({ length: n }, (_, i) => port(i, badIdx.includes(i))) },
});

test('기본은 전체 포트 — 뺀 것이 없으므로 portsOmitted 는 0', () => {
  const r = scopeSnapshot(snapOf(16));
  assert.equal(r.ports.list.length, 16);
  assert.equal(r.ports.portsOmitted, 0);
  assert.equal(r.ports.portsScope, 'full');
  assert.equal(r.ports.portsScopeReason, undefined, '정상 경로는 사유를 붙이지 않는다');
});

test("되돌림 ① scope='problem' 은 예전 동작 그대로", () => {
  const r = scopeSnapshot(snapOf(16, [1, 5]), { scope: 'problem' });
  assert.deepEqual(r.ports.list.map((p) => p.index), [1, 5]);
  assert.equal(r.ports.portsOmitted, 14);
  assert.equal(r.ports.portsScope, 'problem');
});

test('되돌림 ② 크기 가드 — 상한을 넘으면 그 장비만 축약하고 **사유를 남긴다**', () => {
  const r = scopeSnapshot(snapOf(128), { maxBytes: 10_000 });
  assert.equal(r.ports.portsScope, 'problem');
  assert.ok(r.ports.portsOmitted > 0);
  assert.match(r.ports.portsScopeReason, /상한.*넘어/, '조용히 줄이면 화면이 전체를 받았다고 거짓말한다');
});

test('환경변수 판정 — 오타는 기본(full)으로 본다(조용히 축약되지 않게)', () => {
  const orig = process.env.SANSW_PUSH_PORTS;
  try {
    delete process.env.SANSW_PUSH_PORTS; assert.equal(portsScopeSetting(), 'full');
    process.env.SANSW_PUSH_PORTS = 'problem'; assert.equal(portsScopeSetting(), 'problem');
    process.env.SANSW_PUSH_PORTS = 'PROBLEM'; assert.equal(portsScopeSetting(), 'problem', '대소문자 무관');
    process.env.SANSW_PUSH_PORTS = 'porblem'; assert.equal(portsScopeSetting(), 'full', '오타 → 기본');
    process.env.SANSW_PUSH_PORTS = 'full'; assert.equal(portsScopeSetting(), 'full');
  } finally { if (orig === undefined) delete process.env.SANSW_PUSH_PORTS; else process.env.SANSW_PUSH_PORTS = orig; }
});

test('slimSnapshot/fullSnapshot 은 범위를 스스로 밝힌다(화면이 추측하지 않게)', () => {
  assert.equal(slimSnapshot(snapOf(8)).ports.portsScope, 'problem');
  assert.equal(fullSnapshot(snapOf(8)).ports.portsScope, 'full');
  assert.equal(fullSnapshot(snapOf(8)).ports.portsOmitted, 0);
});

test('전체 포트 전송량 실측 — gzip 이 회선 부담의 전제를 바꾼다', () => {
  // 이 테스트는 '수 MB' 라는 예전 근거가 압축 전 기준이었음을 수치로 고정한다.
  const devices = Array.from({ length: 8 }, () => fullSnapshot(snapOf(128)));
  const json = Buffer.from(JSON.stringify(devices));
  const gz = zlib.gzipSync(json);
  // 실측(이 픽스처): 원본 255KB · gzip 약 4KB. 필드가 더 많은 실장비 스냅샷으로 재면 원본 408KB ·
  // gzip 12KB 였다(v2.517 착수 시 측정). 둘 다 **압축비 30배 이상**이라는 같은 결론을 준다.
  assert.ok(json.length > 200 * 1024, `원본은 크다(${Math.round(json.length / 1024)}KB)`);
  assert.ok(gz.length < 64 * 1024, `gzip 은 작다(${Math.round(gz.length / 1024)}KB)`);
  assert.ok(json.length / gz.length > 20,
    `압축비 ${(json.length / gz.length).toFixed(0)}배 — 이 비율이 20배 아래로 깨지면 '전체 기본' 전환의 근거가 사라지므로 재검토할 것`);
});

test('청크는 한 장비가 상한을 넘어도 **단독 청크로 보낸다**(조용한 누락 금지)', () => {
  const big = fullSnapshot(snapOf(768));
  const one = Buffer.byteLength(JSON.stringify(big));
  const chunks = chunkDevices([big, big], 1000);   // 상한을 아주 작게
  assert.equal(chunks.length, 2, '각각 단독 청크');
  assert.equal(chunks.flat().length, 2, '장비가 사라지면 그 법인 데이터가 조용히 소실된다');
  assert.ok(one > 1000);
});

test('중앙 수신 라우트가 BIG_JSON 에 등록돼 있다(413 = 조용한 전량 소실)', () => {
  // 전체 포트로 바뀌면 포트 수가 많은 디렉터 1대가 단독 청크로 기본 1MB 를 넘을 수 있다.
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(idx, /app\.use\('\/api\/central\/sanswitch-data', BIG_JSON\)/);
  assert.match(idx, /app\.use\('\/api\/central\/sanswitch-perf', BIG_JSON\)/);
});
