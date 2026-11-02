/**
 * test/bareosInstallPkgPin2851.test.js — v2.851 완전 설치 2단계 '번들의 시스템 패키지 판 충돌'(2026-11-02 사용자 화면 — 번들 el9_8 ↔ 서버 el9_4 · openssl-devel 고정).
 *  ① 원인 판정 base-pkg-pinned — 실제 출력 모양 · dnf-conflict 보다 앞 · 이름을 출력에서 읽는다(지어내지 않음) · 고정 패키지 · 올리려 한 설치 목록 이름(openssl) · 명령에 그 이름만
 *  ② 출력이 잘려 'already installed' 줄이 없으면 까닭을 단정하지 않는다 · 번들 저장소가 아니거나 같은 이름이 아니면 규칙에 맞지 않는다(dnf-conflict 로)
 *  ③ nevraName — 이름에 숫자 · 하이픈 · epoch · 틀린 모양 · 쓸 수 없는 글자
 *  ④ 사전 점검 osrel — 번들 판 태그 > 서버 판이면 warn(+ -devel 고정 추정) · 같거나 낮으면 ok · 비교 못 하면 unknown · 번들 없으면 항목 없음 · @@devel 파싱 · 막지 않는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CA = await import('../src/bareos/install/causes.js');
const PC = await import('../src/bareos/install/precheck.js');

// 사용자 화면(2026-11-02 12:43)의 2단계 출력 — 줄 모양 그대로
const LOG = [
  'Package policycoreutils-python-utils-3.6-2.1.el9.noarch is already installed.',
  'Package tar-2:1.34-6.el9_4.1.x86_64 is already installed.',
  'Package openssl-1:3.0.7-28.el9_4.x86_64 is already installed.',
  'Error: ',
  ' Problem: cannot install both openssl-libs-1:3.5.8-2.el9_8.x86_64 from portal-bareos-local and openssl-libs-1:3.0.7-28.el9_4.x86_64 from @System',
  '  - package openssl-1:3.5.8-2.el9_8.x86_64 from portal-bareos-local requires libcrypto.so.3(OPENSSL_3.4.0)(64bit), but none of the providers can be installed',
  '  - package openssl-1:3.5.8-2.el9_8.x86_64 from portal-bareos-local requires libcrypto.so.3(OPENSSL_3.3.0)(64bit), but none of the providers can be installed',
  '  - package openssl-1:3.5.8-2.el9_8.x86_64 from portal-bareos-local requires openssl-libs(x86-64) = 1:3.5.8-2.el9_8, but none of the providers can be installed',
  '  - package openssl-devel-1:3.0.7-28.el9_4.x86_64 from @System requires openssl-libs(x86-64) = 1:3.0.7-28.el9_4, but none of the providers can be installed',
  '  - cannot install the best candidate for the job',
];

test('① base-pkg-pinned — 실제 출력 · dnf-conflict 보다 앞 · 이름은 출력에서 · 고정 패키지 · 올리려 한 설치 목록 이름 · 명령', () => {
  const c = CA.classifyFailure({ step: 2, cmd: 'dnf install', code: 1, output: LOG.join('\n') });
  assert.equal(c.key, 'base-pkg-pinned');
  assert.equal(c.unclassified, false);
  assert.match(c.evidence, /^Problem: cannot install both openssl-libs-1:3\.5\.8-2\.el9_8\.x86_64 from portal-bareos-local and openssl-libs-1:3\.0\.7-28\.el9_4\.x86_64 from @System$/, '근거 = 실제로 맞은 줄');
  assert.match(c.why, /openssl-libs-1:3\.5\.8-2\.el9_8\.x86_64 를 넣으려면 서버의 openssl-libs-1:3\.0\.7-28\.el9_4\.x86_64 를 바꿔야 하는데 올릴 수 없었습니다/);
  assert.equal(c.title, '번들 패키지 판이 서버 설치본과 충돌');
  assert.ok(!/되돌렸습니다/.test(c.why), '되돌림 여부는 카드가 따로 보인다(고정 문구로 단정하지 않는다)');
  assert.match(c.why, /openssl-devel-1:3\.0\.7-28\.el9_4\.x86_64\(요구: openssl-libs\(x86-64\) = 1:3\.0\.7-28\.el9_4\)/, '고정하는 패키지와 그 요구를 출력에서 읽는다');
  assert.match(c.why, /설치 목록의 ‘openssl’ 이\(가\) 이미 설치돼 있었고/, "올리려 한 까닭 — 'already installed' 이름 중 번들 판이 요구에 나온 것");
  assert.match(c.why, /번들에 없는 패키지로 보입니다/, '번들 포함 여부는 확인하지 않으므로 단정하지 않는다');
  assert.ok(!/openssl-libs’ 이 이미/.test(c.why), '충돌 패키지 자신(openssl-libs)은 까닭이 아니다');
  const retry = c.fixes.find((f) => f.kind === 'retry'); const srv = c.fixes.find((f) => f.kind === 'server');
  assert.equal(retry.label, 'v2.851 러너는 이미 설치된 ‘openssl’ 을(를) 올리지 않습니다', '단추 문구(‘2단계부터 그대로 다시’)와 겹치지 않게');
  assert.match(srv.label, /openssl-devel/);
  assert.deepEqual(srv.commands.filter((x) => /^(rpm -q|dnf remove|dnf repoquery)/.test(x)).map((x) => x.split('   #')[0].trim()),
    ['rpm -q openssl-devel', 'dnf repoquery --installed --whatrequires openssl-devel', 'dnf remove openssl-devel'], '명령에는 출력에서 읽은 이름만(글자 규칙 통과)');
  assert.ok(srv.commands.some((x) => /^dnf update/.test(x)), 'OS 업데이트 길도 적는다');
  assert.ok(!c.fixes.some((f) => f.kind === 'portal'), '포탈이 자동으로 바꿀 값이 없다');
});

test("② 잘린 출력(already installed 없음)은 까닭을 단정하지 않는다 · 번들 저장소 · 같은 이름이 아니면 dnf-conflict", () => {
  const cut = CA.classifyFailure({ step: 2, output: LOG.slice(3).join('\n') });
  assert.equal(cut.key, 'base-pkg-pinned');
  assert.match(cut.why, /올리려 한 까닭은 출력에 없습니다/);
  assert.ok(!/‘openssl’ 이\(가\) 이미/.test(cut.why));
  assert.match(cut.fixes.find((f) => f.kind === 'retry').label, /설치 목록 중 이미 설치된 패키지를 올리지 않습니다/);
  // 고정 줄이 없으면 '없다' 고 적고 whatrequires 로 찾게 한다
  const noPin = CA.classifyFailure({ step: 2, output: [LOG[4], LOG[9]].join('\n') });
  assert.equal(noPin.key, 'base-pkg-pinned');
  assert.match(noPin.why, /고정하는 패키지 줄은 출력에 없습니다/);
  assert.ok(noPin.fixes.find((f) => f.kind === 'server').commands.some((x) => x === "rpm -q --whatrequires 'openssl-libs(x86-64)'"));
  // 다른 저장소 · 다른 이름 두 패키지면 이 규칙이 아니다
  const other = CA.classifyFailure({ step: 2, output: ' Problem: cannot install both foo-1.0-1.el9.x86_64 from appstream and foo-0.9-1.el9.x86_64 from @System\n  - cannot install the best candidate for the job' });
  assert.equal(other.key, 'dnf-conflict');
  const diff = CA.classifyFailure({ step: 2, output: ' Problem: cannot install both a-1.0-1.el9.x86_64 from portal-bareos-local and b-1.0-1.el9.x86_64 from @System\n  - cannot install the best candidate for the job' });
  assert.equal(diff.key, 'dnf-conflict');
  // 예전 규칙은 그대로
  assert.equal(CA.classifyFailure({ step: 2, output: 'Error:\n Problem: conflicting requests\n  - nothing provides libfoo' }).key, 'dnf-conflict');
});

test('①-b 반증 — Problem 이 둘이면 충돌 이름을 요구하는 @System 줄만 고정 · 선행 \'-\' 이름은 명령에 넣지 않음 · 까닭 여럿 · rpmdb', () => {
  const two = [...LOG.slice(0, 9), ' Problem 2: package php-pecl-zip-1.19.2-7.el9_4.x86_64 from @System requires php(api) = 20200930-64, but none of the providers can be installed',
    '  - package php-pecl-zip-1.19.2-7.el9_4.x86_64 from @System requires php(api) = 20200930-64, but none of the providers can be installed',
    '  - package -rf-1.0-1.el9.x86_64 from @System requires openssl-libs(x86-64) = 1:3.0.7-28.el9_4, but none of the providers can be installed'].join('\n');
  const c = CA.classifyFailure({ step: 2, output: two });
  const srv = c.fixes.find((f) => f.kind === 'server');
  assert.match(srv.label, /^고정하는 패키지 — openssl-devel$/, '다른 Problem 의 php-pecl-zip 은 고정 패키지가 아니다');
  assert.ok(!srv.commands.join('\n').includes('php-pecl-zip'), '무관한 패키지를 dnf remove 명령에 넣지 않는다');
  assert.ok(!srv.commands.join('\n').includes('-rf'), "선행 '-' 이름은 옵션이 되므로 버린다");
  assert.equal(CA.nevraName('-rf-1.0-1.el9.x86_64'), ''); assert.equal(CA.nevraName('.x-1.0-1.el9.x86_64'), '');
  // 까닭이 둘(openssl · tar 둘 다 번들 판을 요구에 냄)
  const both2 = [LOG[1], LOG[2], LOG[4], '  - package tar-2:1.34-13.el9_8.x86_64 from portal-bareos-local requires openssl-libs(x86-64) >= 1:3.5.8, but none of the providers can be installed', LOG[7], LOG[8], LOG[9]].join('\n');
  assert.match(CA.classifyFailure({ step: 2, output: both2 }).why, /설치 목록의 ‘tar’ · ‘openssl’ 이\(가\) 이미 설치돼/);
  // 러너가 rpm -qa 목록을 못 읽으면 rpmdb(설치 안 함)
  const r = CA.classifyFailure({ step: 2, cause: 'rpmdb', output: '설치된 패키지 목록(rpm -qa)을 읽지 못했습니다' });
  assert.equal(r.key, 'rpmdb'); assert.ok(r.fixes.some((f) => f.kind === 'server'));
});

test('③ nevraName — 숫자 · 하이픈 · epoch · 틀린 모양', () => {
  assert.equal(CA.nevraName('openssl-libs-1:3.5.8-2.el9_8.x86_64'), 'openssl-libs');
  assert.equal(CA.nevraName('python3-libs-3.9.25-7.el9_8.6.x86_64'), 'python3-libs');
  assert.equal(CA.nevraName('bareos-filedaemon-python3-plugin-25.1.2~pre73.3e32b07ea-1.el9.x86_64'), 'bareos-filedaemon-python3-plugin');
  assert.equal(CA.nevraName('policycoreutils-python-utils-3.6-2.1.el9.noarch'), 'policycoreutils-python-utils');
  for (const bad of ['openssl', 'openssl-libs', '', 'a;b-1-1.el9.x86_64', 'x-1.0']) assert.equal(CA.nevraName(bad), '', bad);
});

const PRE = (o = {}) => [
  '@@id', '0', '@@os', 'ID=rocky', `VERSION_ID=${o.ver ?? '9.4'}`, 'PRETTY=Rocky Linux', 'ARCH=x86_64', '@@tools', 'systemd-run=1', 'dnf=1', 'rpm=1', 'ss=1',
  '@@selinux', 'Enforcing', '@@pkgs', '@@etc', 'none', '@@svc', '@@ports', '@@python', '3.9.18', '@@pyvmomi', 'none', '@@bpp',
  '@@disk', 'PATH=/var/lib', 'AVAIL_KB=431800000', 'SIZE_KB=1800000000', 'MOUNT=/', 'EXISTS=0', '@@varlib', '431800000', '@@clock', '@@addr', '10.20.0.14', 'edge.corp',
  '@@runner', '@@running', 'none', '@@catalog', 'none', '@@devel', ...(o.devel || []), '@@volumes', '@@end',
].join('\n');
const bundle = (packages) => ({ bareosVersion: '25.1.2', postgresqlVersion: '13.23', pyvmomi: { versions: ['8.0.3.0.1'] }, vddk: [], packages });
const PKGS = [
  { name: 'openssl-libs', version: '3.5.8', release: '2.el9_8', arch: 'x86_64' }, { name: 'glibc', version: '2.34', release: '283.el9_8', arch: 'x86_64' },
  { name: 'libsemanage', version: '3.6', release: '5.el9_6', arch: 'x86_64' }, { name: 'bareos-director', version: '25.1.2', release: '1.el9', arch: 'x86_64' },
  { name: 'krb5-libs', version: '1.21.1', release: '10.el9_8.1', arch: 'x86_64' },
  { name: 'tar', version: '1.34', release: '6.el9_4.1', arch: 'x86_64' },   // 서버와 같은 판(9.4) — 새 판이 아니다
];
const item = (j, k) => j.items.find((i) => i.key === k);

test('④ 사전 점검 osrel — 새 판 태그면 warn(+devel 고정 추정) · 같거나 낮으면 ok · 비교 못 하면 unknown · 번들 없으면 없음 · 막지 않는다', () => {
  const f = PC.parsePrecheck(PRE({ devel: ['openssl-devel', 'zlib-devel', 'kernel-headers', 'krb5-devel', 'bad name!'] }));
  assert.deepEqual(f.develPkgs, ['openssl-devel', 'zlib-devel', 'kernel-headers', 'krb5-devel'], '@@devel — 이름 규칙을 지난 것만');
  assert.equal(PC.bundleMinor(bundle(PKGS)), 8); assert.equal(PC.bundleMinor(bundle([])), null); assert.equal(PC.bundleMinor(bundle([{ name: 'x', release: '1.el9' }])), 0);
  assert.equal(PC.serverMinor('9.4'), 4); assert.equal(PC.serverMinor('9'), null); assert.equal(PC.serverMinor(''), null);
  assert.deepEqual(PC.newerBasePkgs(bundle(PKGS), 4), ['openssl-libs', 'glibc', 'libsemanage', 'krb5-libs'], '같은 판(el9_4) · 판 태그 없음(el9)은 새 판이 아니다');
  assert.deepEqual(PC.newerBasePkgs(bundle(PKGS), 8), []);
  assert.deepEqual(PC.develPins(f.develPkgs, ['openssl-libs', 'glibc', 'krb5-libs']), ['openssl-devel', 'krb5-devel'], '바탕 이름 · 이름-libs 로 잇는다(zlib · kernel 은 번들에 없음)');
  assert.deepEqual(PC.develPins(['cyrus-sasl-devel', 'brotli-devel'], ['cyrus-sasl-lib', 'libbrotli']), ['cyrus-sasl-devel', 'brotli-devel'], '반증: 이름-lib · lib이름 매핑');
  assert.deepEqual(PC.develPins(['openssl-devel'], ['openssl-devel', 'openssl-libs'], ['openssl-devel', 'openssl-libs']), [], '반증: -devel 이 번들에 있으면 함께 올라가므로 고정이 아니다');
  const many = PC.parsePrecheck(PRE({ devel: Array.from({ length: 201 }, (_, i) => `p${String(i).padStart(3, '0')}-devel`) }));
  assert.equal(many.develPkgs.length, 200); assert.equal(many.develTruncated, true); assert.equal(f.develTruncated, false);
  const warn = PC.judgePrecheck(f, { mode: 'install', bundle: bundle(PKGS) });
  const w = item(warn, 'osrel');
  assert.equal(w.status, 'warn');
  assert.match(w.detail, /서버 9\.4 · 번들 패키지 9\.8 — 번들에 든 패키지 중 4개의 판 태그가 서버 판보다 새롭습니다\(openssl-libs · glibc · krb5-libs 외 1개\) · 설치될 수가 아닙니다/);
  assert.match(w.detail, /설치된 openssl-devel · krb5-devel 이\(가\) 그 패키지의 지금 판을 고정할 수 있습니다\(추정 — 이름으로 짐작\)/);
  assert.match(item(PC.judgePrecheck(many, { mode: 'install', bundle: bundle(PKGS) }), 'osrel').detail, /200개를 넘어 일부만 봤습니다/);
  assert.match(w.action, /위 고정 패키지 때문에 2단계가 실패할 수 있습니다/); assert.match(w.action, /설치는 막지 않습니다/);
  assert.equal(warn.blocked, false, '경고일 뿐 막지 않는다');
  const noDevel = item(PC.judgePrecheck(PC.parsePrecheck(PRE()), { mode: 'install', bundle: bundle(PKGS) }), 'osrel');
  assert.equal(noDevel.status, 'warn'); assert.ok(!/고정할 수 있습니다/.test(noDevel.detail)); assert.ok(!/위 고정 패키지/.test(noDevel.action));
  assert.equal(item(PC.judgePrecheck(PC.parsePrecheck(PRE({ ver: '9.8' })), { mode: 'install', bundle: bundle(PKGS) }), 'osrel').status, 'ok');
  assert.equal(item(PC.judgePrecheck(PC.parsePrecheck(PRE({ ver: '9.9' })), { mode: 'install', bundle: bundle(PKGS) }), 'osrel').status, 'ok', '서버가 더 새로우면 문제없다');
  const unk = item(PC.judgePrecheck(PC.parsePrecheck(PRE({ ver: '9' })), { mode: 'install', bundle: bundle(PKGS) }), 'osrel');
  assert.equal(unk.status, 'unknown'); assert.match(unk.detail, /서버 9 · 번들 9\.8 — 비교하지 못했습니다/);
  assert.equal(item(PC.judgePrecheck(f, { mode: 'install', bundle: bundle([]) }), 'osrel').status, 'unknown', '패키지 목록이 없는 번들(옛 데모)도 unknown');
  assert.equal(item(PC.judgePrecheck(f, { mode: 'install', bundle: null }), 'osrel'), undefined, '번들이 없으면 항목 자체가 없다(번들 항목이 bad)');
  assert.match(PC.precheckScript(), /echo @@devel; rpm -qa --qf '%\{NAME\}\\n' 2>\/dev\/null \| grep -E -- '-\(devel\|headers\)\$' \| sort \| head -n 201/, '읽기만 하는 고정 문자열(201 = 잘림 표시)');
});
