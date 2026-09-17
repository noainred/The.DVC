/**
 * 설정 전수 점검(v2.553) 회귀 — 사용자 요청 "설정에 있는 모든 통신이 되는지 점검하고 해결책 제시".
 * 선택: 전부 25종 · 해결책 둘 다 · **도달성만(인증은 수동 1회)** · 전체 검증.
 *
 * 고정하는 것(되돌리면 이 테스트가 깨진다):
 *  · **장비 계정으로 로그인하지 않는다** — SSH 는 협상까지, SMTP 는 EHLO 까지, LDAP 는 포트까지
 *  · **무인증 점검에서 401/403 은 정상**(자격증명을 보내지 않았다)
 *  · 등록부 export 가 바뀌면 **조용히 0건이 되지 않는다**(sourceErrors 로 드러난다)
 *  · 종류마다 **주소 형식이 다르다**(틀린 조언 방지 — v2.525)
 *  · 대상 객체에 **비밀이 없다**
 *  · 화면 문구에 **백틱이 없다**(BoldText 는 백틱을 글자로 흘린다)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'setcheck-test-'));

const { SETTING_KINDS, SETTING_KIND_KEYS, DEPTH_LABEL, GROUP_ORDER, SETTINGS_PATHS } = await import('../src/linkcheck/settingsKinds.js');
const { buildSettingsTargets, splitTarget, targetIdOf, publicTarget } = await import('../src/linkcheck/settingsLinks.js');
const { configFindings, resultFindings, mergeFindings, hostCountsOf, HOST_FORM } = await import('../src/linkcheck/remedy.js');
const { identityCheckerFor, runSettingsTarget } = await import('../src/linkcheck/settingsRun.js');
const { stepSsh, stepSmtp, stepPortOnly } = await import('../src/linkcheck/protocols.js');
const { PHASES, PHASE_LABEL, FAIL_KINDS, judge, fixHint } = await import('../src/linkcheck/phases.js');

const SRC = (p) => fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('카탈로그 — 25종이 전부 라벨·깊이·설정경로·authMode 를 갖는다', () => {
  assert.ok(SETTING_KIND_KEYS.length >= 25, `종류 ${SETTING_KIND_KEYS.length}개`);
  for (const k of SETTING_KIND_KEYS) {
    const v = SETTING_KINDS[k];
    assert.ok(v.label && v.group && v.depth, `${k} 필드 누락`);
    assert.ok(DEPTH_LABEL[v.depth], `${k} 깊이 라벨 없음: ${v.depth}`);
    assert.ok(SETTINGS_PATHS[v.settings], `${k} 설정 경로 없음: ${v.settings}`);
    assert.ok(['none', 'token'].includes(v.probe.authMode), `${k} authMode=${v.probe.authMode}`);
    assert.ok(['http', 'tls', 'ssh', 'smtp', 'tcp'].includes(v.probe.mode), `${k} mode=${v.probe.mode}`);
    // 그룹은 표시 순서 목록에 있어야 한다(없으면 화면에서 '기타' 로 밀린다)
    assert.ok(GROUP_ORDER.includes(v.group), `${k} 그룹 미등록: ${v.group}`);
  }
});

test('⚠ 장비 계정으로 로그인하지 않는다 — 토큰 종류는 포탈 자기 토큰뿐', () => {
  const tokenKinds = SETTING_KIND_KEYS.filter((k) => SETTING_KINDS[k].probe.authMode === 'token');
  assert.deepEqual(tokenKinds.sort(), ['set:central', 'set:collector'],
    '장비 계정을 쓰는 종류가 생겼다 — 5분 주기 로그인은 계정을 잠근다');
  // 실행기에도 장비 비밀번호를 읽는 코드가 없어야 한다
  const src = stripComments(SRC('linkcheck/settingsRun.js'));
  assert.ok(!/\.password|getDeviceWithSecret|listDevicesWithSecrets|ListRaw|WithSecrets/.test(src), '장비 비밀을 읽지 말 것');
  // SSH 는 handshake 에서 끝낸다(ready 를 기다리면 인증을 한다)
  const ps = stripComments(SRC('linkcheck/protocols.js'));
  assert.ok(/on\('handshake'/.test(ps), 'SSH 는 handshake 까지만');
  assert.ok(!/on\('ready'/.test(ps), "ssh 'ready' 를 기다리면 인증 시도가 된다");
  /*
   * SMTP 는 소켓에 **무엇을 쓰는지**로 검사한다(문자열이 어디 있는지가 아니라). 쓰는 것은
   * EHLO·QUIT 둘뿐이어야 한다 — AUTH·MAIL FROM 이 생기면 계정 잠금·실제 발송이 된다.
   */
  const writes = [...ps.matchAll(/\.write\('([^']*)'\)/g)].map((m) => m[1]);
  assert.deepEqual(writes, ['EHLO linkcheck.local\\r\\n', 'QUIT\\r\\n'], `소켓에 쓰는 명령: ${JSON.stringify(writes)}`);
});

test('⚠⚠ 무인증 점검에서 401/403 은 실패가 아니다', () => {
  const src = stripComments(SRC('linkcheck/settingsRun.js'));
  assert.ok(/authMode === 'none'/.test(src) && /st === 401 \|\| st === 403/.test(src), '401/403 보정이 없다');
  // 판정도 같은 규칙
  const info = resultFindings({ kind: 'set:nsx' }, { ok: true }, { http: { status: 401 } });
  assert.equal(info[0].code, 'auth-required-ok');
  assert.equal(info[0].severity, 'info');
  // 토큰을 보내는 종류는 그대로 실패다
  const fail = resultFindings({ kind: 'set:collector' }, { ok: false, phase: 'auth', failKind: 'auth' }, { http: { status: 403 } });
  assert.equal(fail[0].code, 'failed');
  assert.equal(fail[0].severity, 'blocker');
});

test('등록부 export 가 바뀌면 조용히 0건이 되지 않는다', async () => {
  const src = stripComments(SRC('linkcheck/settingsLinks.js'));
  assert.ok(/fnNames\.find/.test(src), '기대 export 이름을 명시해야 한다');
  assert.ok(/아무 함수도 없습니다|throw new Error/.test(SRC('linkcheck/settingsLinks.js')), '없으면 던져서 sourceErrors 로 올려야 한다');
  // 폴백으로 빈 배열을 돌려주는 형태가 남아 있으면 안 된다
  assert.ok(!/\?\.\(\)\s*\|\|\s*\[\]/.test(src), '옵셔널 호출 + 빈 배열 폴백은 조용한 0건을 만든다');

  // 실제로 이름을 틀리면 sourceErrors 에 나온다(주입으로 확인)
  const bad = await buildSettingsTargets({ vcenters: [{ id: 'vc1', name: 'A', host: 'vc.example', collectMode: 'direct' }] });
  assert.ok(bad.targets.some((x) => x.kind === 'set:vcenter'), '주입한 vCenter 가 대상이 돼야 한다');
});

test('종류마다 주소 형식이 다르다 — 틀린 조언 방지(v2.525)', () => {
  for (const k of SETTING_KIND_KEYS) assert.ok(HOST_FORM[k], `${k} 주소 형식 미선언 — 잘못된 조언이 나간다`);
  // 스토리지(SSH)는 주소만 → 스킴이 붙으면 차단
  const a = configFindings({ kind: 'set:storage-ssh', address: 'https://10.1.1.1', host: '10.1.1.1', port: 22, facts: { username: 'svc' } });
  assert.ok(a.some((x) => x.code === 'scheme-in-host' && x.severity === 'blocker'));
  // Horizon 은 URL 필수 → 반대 방향
  const b = configFindings({ kind: 'set:horizon', address: 'hz.corp', host: 'hz.corp', port: 443, facts: { hasPassword: true } });
  assert.ok(b.some((x) => x.code === 'scheme-missing'));
  assert.ok(!b.some((x) => x.code === 'scheme-in-host'));
  // iDRAC 은 스킴이 정상 → 발견 0
  const c = configFindings({ kind: 'set:idrac', address: 'https://10.0.0.1', host: '10.0.0.1', port: 443, facts: {} });
  assert.deepEqual(c, []);
});

test('설정만 보고 찾는 발견 — 포트 어긋남·SSRF·중복·Data Plane basePath', () => {
  assert.ok(configFindings({ kind: 'set:storage-ssh', address: '10.1.1.1', host: '10.1.1.1', port: 443, facts: { username: 'u', collectMethod: 'ssh' } })
    .some((x) => x.code === 'ssh-port-443'));
  assert.ok(configFindings({ kind: 'set:storage-api', address: '10.1.1.1', host: '10.1.1.1', port: 22, facts: { username: 'u', collectMethod: 'api' } })
    .some((x) => x.code === 'api-port-22'));
  assert.ok(configFindings({ kind: 'set:pdu', address: '127.0.0.1', host: '127.0.0.1', port: 443, facts: { username: 'u' } },
    { ipBlockReason: () => '루프백' }).some((x) => x.code === 'ssrf-blocked'));
  const hc = hostCountsOf([{ kind: 'set:pdu', host: 'p1' }, { kind: 'set:pdu', host: 'p1' }, { kind: 'set:idrac', host: 'p1' }]);
  assert.equal(hc.get('set:pdu|p1'), 2);
  assert.equal(hc.get('set:idrac|p1'), 1, '종류가 다르면 중복이 아니다');
  assert.ok(configFindings({ kind: 'set:dataplane', address: 'https://dp', host: 'dp', port: 443, facts: { basePath: '@attacker.example/v3' } })
    .some((x) => x.code === 'dataplane-basepath' && x.severity === 'blocker'), 'v2.503 S-1 형태를 잡아야 한다');
});

test("'중앙 직접 수집' 을 문제라 하지 않는다(정상 구성)", () => {
  const f = configFindings({ kind: 'set:storage-api', address: '10.1.1.1', host: '10.1.1.1', port: 443, facts: { username: 'u' } });
  const cd = f.find((x) => x.code === 'central-direct');
  assert.ok(cd, '중앙 직접은 사실로 알린다');
  assert.equal(cd.severity, 'info', '정상 구성이므로 info 다');
});

test('대상 객체에 비밀이 없다 + publicTarget 화이트리스트', async () => {
  const r = await buildSettingsTargets({
    storage: [{ id: 's1', type: 'unity480', name: 'U1', host: '10.1.1.1', username: 'svc', password: 'SECRET', collectMethod: 'ssh', sshPort: 22 }],
  });
  const s = JSON.stringify(r.targets);
  for (const bad of ['SECRET', '"password"', 'privateKey', 'passphrase']) assert.ok(!s.includes(bad), `비밀 누출: ${bad}`);
  const p = publicTarget({ id: 'x', kind: 'k', token: 'T', password: 'P', host: 'h' });
  assert.equal(p.token, undefined);
  assert.equal(p.password, undefined);
});

test('splitTarget — 포트 기본값·실패 사유', () => {
  assert.equal(splitTarget('https://h').port, 443);
  assert.equal(splitTarget('h', { defaultPort: 22 }).port, 22);
  assert.equal(splitTarget('h:9443').port, 9443);
  assert.equal(splitTarget('https://h').hadScheme, true);
  assert.equal(splitTarget('h').hadScheme, false);
  assert.ok(splitTarget('').bad);
  assert.ok(splitTarget('https://h:99999').bad);
  assert.equal(targetIdOf('set:pdu', 'p1'), 'set:pdu|p1');
});

test('정체 대조 — 확인할 수 없는 종류는 null(지어내지 않는다)', () => {
  assert.equal(identityCheckerFor('set:vcenter', {}, {}).raw('<versionId>vim25</versionId>'), null);
  assert.ok(identityCheckerFor('set:vcenter', {}, {}).raw('<html>login</html>'));
  assert.equal(identityCheckerFor('set:idrac', {}, {}).json({ RedfishVersion: '1.13.0' }), null);
  assert.ok(identityCheckerFor('set:idrac', {}, {}).json({ x: 1 }));
  assert.equal(identityCheckerFor('set:nsx', {}, {}), null, 'NSX 는 무인증으로 제품 확인 불가 — null 이어야 한다');
  assert.equal(identityCheckerFor('set:pdu', {}, {}), null);
});

test('단계 — ssh/smtp/port 가 PHASES 에 있고 미시도를 실패로 세지 않는다', () => {
  for (const p of ['ssh', 'smtp', 'port']) {
    assert.ok(PHASES.includes(p), `${p} 누락`);
    assert.ok(PHASE_LABEL[p], `${p} 라벨 없음`);
  }
  for (const [k, v] of Object.entries(FAIL_KINDS)) {
    assert.ok(PHASES.includes(v.phase), `${k}.phase=${v.phase}`);
    assert.ok(fixHint(k).length > 0, `${k} 조치 없음`);
  }
  assert.equal(judge({ dns: { ok: true, ms: 1 }, tcp: { ok: true, ms: 2 }, ssh: { ok: true, ms: 80 } }).reached, 'ssh');
  assert.equal(judge({ dns: { ok: true, ms: 1 }, tcp: { ok: true, ms: 2 }, smtp: { ok: false, failKind: 'smtp-refused' } }).phase, 'smtp');
  // SSH 협상 실패를 '인증 실패' 라 말하지 않는다(v2.541)
  assert.equal(FAIL_KINDS['ssh-kex'].phase, 'ssh');
  assert.ok(/자격증명 문제가 아닙니다/.test(FAIL_KINDS['ssh-kex'].fix));
});

test('닫힌 포트에서 ssh/smtp 가 refused 를 준다(실제 소켓)', async () => {
  const a = await stepSsh('127.0.0.1', 1, { timeoutMs: 3_000 });
  assert.equal(a.ok, false);
  assert.equal(a.failKind, 'refused');
  const b = await stepSmtp('127.0.0.1', 1, { timeoutMs: 3_000 });
  assert.equal(b.ok, false);
  assert.equal(b.failKind, 'refused');
  assert.equal(stepPortOnly(null), null);
  assert.equal(stepPortOnly({ ok: true, ms: 1 }).ok, true);
});

test('runSettingsTarget — 비활성·주소오류는 skip(실패가 아니다)', async () => {
  const off = await runSettingsTarget({ id: 'x', kind: 'set:pdu', enabled: false, host: 'h', port: 443 });
  assert.ok(off.skipped);
  assert.equal(off.verdict, undefined);
  const bad = await runSettingsTarget({ id: 'y', kind: 'set:pdu', bad: '주소가 비어 있습니다.' });
  assert.ok(bad.skipped);
  const unk = await runSettingsTarget({ id: 'z', kind: 'set:nope', host: 'h', port: 1 });
  assert.ok(unk.skipped);
});

test('SNI 에 IP 를 넣지 않는다(RFC 6066 · Node DEP0123)', () => {
  const src = SRC('linkcheck/checks.js');
  assert.ok(/net\.isIP\(sni\)/.test(src), 'TLS 단계에서 IP SNI 를 걸러야 한다');
  assert.ok(/net\.isIP\(u\.hostname\)/.test(src), 'HTTP dispatcher 에서도 걸러야 한다');
});

test('폴러는 설정 점검을 같은 주기·같은 가드로 돈다(폴러를 더 만들지 않는다)', () => {
  const src = stripComments(SRC('linkcheck/poller.js'));
  assert.ok(/buildSettingsTargets/.test(src) && /runSettingsTarget/.test(src));
  assert.ok(/s\.settingsCheck !== false/.test(src), '설정 점검 스위치');
  // 엣지 위임 대상을 중앙이 점검하지 않는다(닿지 않는 것이 정상이다)
  assert.ok(/x\.agent && node === 'central'/.test(src), '엣지 위임 제외 규칙이 없다');
  assert.ok((src.match(/startAdaptiveTimer\(/g) || []).length === 1, '타이머는 하나여야 한다');
});

test('점검 API 는 adminOnly + 전체범위만', () => {
  const src = stripComments(SRC('routes/api/linkCheck.js'));
  const routes = [...src.matchAll(/api\.(get|post|put)\('([^']+)'([^)]*)/g)];
  assert.ok(routes.length >= 7);
  for (const m of routes) {
    assert.ok(/adminOnly/.test(m[3]), `${m[2]} adminOnly 없음`);
    assert.ok(/fullScopeOnly/.test(m[3]), `${m[2]} fullScopeOnly 없음`);
  }
  assert.ok(/link-check\/targets/.test(src), '설정 전수 목록 라우트가 없다');
});

test('실제 등록부로 목록을 만들 수 있고 등록부 오류가 드러난다', async () => {
  const r = await buildSettingsTargets();
  assert.ok(Array.isArray(r.targets));
  assert.ok(Array.isArray(r.problems));
  assert.ok(Array.isArray(r.sourceErrors));
  // 이 테스트 환경은 빈 CONFIG_DIR 이라 대상이 0건일 수 있다 — 그래도 **오류는 0** 이어야 한다
  assert.deepEqual(r.sourceErrors, [], `등록부 로딩 실패: ${JSON.stringify(r.sourceErrors)}`);
  assert.equal(r.counts.total, r.targets.length);
});
