/**
 * 7a단계 로그 분석 — 규칙 카탈로그 자기 시험 · 분류(포탈 엔진 재사용) · 서명 안정성 · 보안 집중 · 가림 스윕 · ReDoS 비율.
 *   기준 시각: 정시 −30분(실제 시각에서 정시 경계로 떨어뜨려 고정 — docs/rules/common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const R = await import('../src/bmusage/logs/rules.js');
const C = await import('../src/bmusage/logs/classify.js');
const { redactSystemLogLine, MASK } = await import('../src/edgelog/redact.js');
const { allJudgmentIds } = await import('../src/bmusage/playbooks.js');
const { HEALTH_CELLS } = await import('../src/bmusage/health.js');
const { CROSS_CODES } = await import('../src/bmusage/playbooks.js');
const { MSG_RE } = await import('../src/logs/loginFailPattern.js');

test('카탈로그 — 모든 규칙의 표본이 정규식에 맞고, 엔진(태그 색인 · 처음 맞는 하나)에 넣으면 그 규칙이 잡는다', () => {
  const ids = new Set();
  for (const r of R.LOG_RULES) {
    assert.ok(!ids.has(r.id), `${r.id} 중복`); ids.add(r.id);
    assert.ok(R.LOG_CLASSES.includes(r.cls), `${r.id} 분류`);
    assert.ok(['critical', 'high', 'medium', 'low', 'info'].includes(r.severity), `${r.id} 심각도(엔진 SEVERITY_RANK)`);
    assert.ok(r.sample && r.re.test(r.sample), `${r.id}: 표본이 정규식에 맞지 않는다`);
    const src = r.tag || 'journal';
    assert.equal(C.matchRule(src, r.sample)?.id, r.id, `${r.id}: 엔진이 다른 규칙으로 분류(${C.matchRule(src, r.sample)?.id})`);
    assert.ok(r.evidence?.length && r.evidence.every((e) => Object.hasOwn(R.LOG_EVIDENCE, e)), `${r.id} 근거 번호`);
    assert.ok(['●', '◐', '○'].includes(r.grade), `${r.id} 등급`);
    if (r.corr?.playbook) assert.ok(allJudgmentIds().includes(r.corr.playbook), `${r.id} 플레이북 판정 id ${r.corr.playbook}`);
    if (r.corr?.health) assert.ok(HEALTH_CELLS.includes(r.corr.health), `${r.id} 소모품 칸`);
    if (r.corr?.cross) assert.ok(CROSS_CODES.includes(r.corr.cross), `${r.id} 교차 code`);
    if (r.cls === 'sec' && r.kind) assert.ok(R.SEC_KINDS.includes(r.kind));
  }
  // 정직: 실장비 표본 없이 만든 규칙은 전부 ○(README §6 · 설계 §17)
  assert.deepEqual([...new Set(R.ALL_LOG_RULES.map((r) => r.grade))], ['○']);
  // 포탈 로그인 실패 판정을 **같은 정규식 객체**로 쓴다(복제 금지)
  assert.equal(R.logRuleById('SEC-LOGIN-FAIL').re, MSG_RE);
  assert.equal(new Set(R.LOG_RULE_IDS).size, R.LOG_RULE_IDS.length);
  // 화면 카탈로그는 정규식을 글자로
  const cat = R.logRuleCatalog();
  assert.equal(cat.length, R.ALL_LOG_RULES.length);
  assert.ok(cat.every((x) => typeof x.pattern === 'string' && x.clsLabel));
});

test('분류 · 서명 — 가변부(숫자 · IP · 계정 · 경로 · PID)만 다른 줄은 같은 서명 · 분류 못 한 줄은 세기만(패턴 없음)', async () => {
  const items = [
    { src: 'kernel', unit: 'kernel', ts: NOW - 60_000, msg: 'nvme nvme1: I/O 1024 QID 7 timeout, completion polled' },
    { src: 'kernel', unit: 'kernel', ts: NOW - 50_000, msg: 'nvme nvme3: I/O 77 QID 12 timeout, completion polled' },
    { src: 'secure', unit: 'sshd', ts: NOW - 40_000, msg: 'Failed password for root from 203.0.113.45 port 51822 ssh2' },
    { src: 'secure', unit: 'sshd', ts: NOW - 30_000, msg: 'Failed password for admin from 198.51.100.7 port 40022 ssh2' },
    { src: 'journal', unit: 'app', ts: NOW - 20_000, msg: 'something unknown happened at /opt/app/x.py line 12' },
    { src: 'journal', unit: 'systemd', ts: NOW - 10_000, msg: "postgresql.service: Failed with result 'exit-code'." },
  ];
  const r = await C.classifyItems(items, { now: NOW });
  const pats = [...r.patterns.values()];
  const nv = pats.filter((p) => p.ruleId === 'PERF-NVME-TIMEOUT');
  assert.equal(nv.length, 1); assert.equal(nv[0].count, 2, '장치 번호 · I/O 번호가 달라도 한 서명');
  const ssh = pats.filter((p) => p.ruleId === 'SEC-SSH-FAIL');
  assert.equal(ssh.length, 1); assert.equal(ssh[0].count, 2, '계정 · IP 가 달라도 한 서명(계정 · IP 는 보안 상위 표로)');
  assert.ok(!/root|admin|203\.0|198\.51/.test(ssh[0].tmpl), `서명 템플릿에 계정 · IP 없음: ${ssh[0].tmpl}`);
  assert.equal(r.counts.none, 1); assert.equal(pats.filter((p) => !p.ruleId).length, 0, '분류 못 한 줄은 패턴을 만들지 않는다');
  assert.ok([...r.hours.values()].some((h) => h.sig === '#none:journal' && h.count === 1), '분류 안 됨은 출처 · 시간별 개수만');
  // 서명 안정성 — 같은 입력은 언제나 같은 서명(순수 · 해시)
  const r2 = await C.classifyItems(items, { now: NOW });
  assert.deepEqual([...r2.patterns.keys()].sort(), [...r.patterns.keys()].sort());
  assert.equal(C.signatureOf('kernel', 'X', 'a <n>'), C.signatureOf('kernel', 'X', 'a <n>'));
  assert.match(C.signatureOf('kernel', 'X', 'a'), /^[0-9a-f]{16}$/);
  // 보안 상위 — IP · 계정
  const sec = [...r.sec.values()];
  assert.ok(sec.find((x) => x.kind === 'fail_ip' && x.item === '203.0.113.45'));
  assert.ok(sec.find((x) => x.kind === 'fail_user' && x.item === 'admin'));
});

test('보안 집중 — 같은 IP 가 창 안 임계 이상이면 집중 규칙(high)으로 옮긴다(두 번 세지 않음) · 주기 경계는 carry 로 잇는다', async () => {
  const mk = (n, t0, ip = '203.0.113.45') => Array.from({ length: n }, (_, i) => ({ src: 'secure', unit: 'sshd', ts: t0 + i * 5_000, msg: `Failed password for root from ${ip} port ${50000 + i} ssh2` }));
  const burst = { count: 20, windowMin: 5 };
  const a = await C.classifyItems([...mk(25, NOW - 600_000), ...mk(3, NOW - 600_000, '198.51.100.7')], { now: NOW, burst });
  const ids = [...a.patterns.values()].map((p) => [p.ruleId, p.count]);
  assert.deepEqual(ids.find(([id]) => id === 'SEC-SSH-FAIL-BURST'), ['SEC-SSH-FAIL-BURST', 25]);
  assert.deepEqual(ids.find(([id]) => id === 'SEC-SSH-FAIL'), ['SEC-SSH-FAIL', 3], '다른 IP 3줄은 집중이 아니다');
  assert.equal(a.counts.sec, 28, '줄은 한 번씩만 센다');
  assert.equal(a.counts.secHigh, 25);
  assert.equal(a.bursts.length, 1); assert.equal(a.bursts[0].ip, '203.0.113.45');
  // 주기 경계: 앞 주기 12줄 + 이번 주기 12줄(창 5분 안) → 이번 주기 12줄이 집중
  const t0 = NOW - 240_000;
  const c1 = await C.classifyItems(mk(12, t0), { now: t0 + 60_000, burst });
  assert.equal([...c1.patterns.values()].some((p) => p.ruleId === 'SEC-SSH-FAIL-BURST'), false);
  const c2 = await C.classifyItems(mk(12, t0 + 60_000), { now: NOW, burst, carry: c1.carry });
  assert.equal([...c2.patterns.values()].find((p) => p.ruleId === 'SEC-SSH-FAIL-BURST')?.count, 12);
  const c3 = await C.classifyItems(mk(12, t0 + 60_000), { now: NOW, burst, carry: null });
  assert.equal([...c3.patterns.values()].some((p) => p.ruleId === 'SEC-SSH-FAIL-BURST'), false, 'carry 가 없으면 경계 집중을 못 본다(대조)');
  // carry 상한 — IP 64개 · IP 당 임계 개수
  const many = await C.classifyItems(Array.from({ length: 100 }, (_, i) => ({ src: 'secure', ts: NOW - 1000, msg: `Failed password for root from 10.0.${Math.floor(i / 250)}.${i % 250} port 1 ssh2` })), { now: NOW, burst });
  assert.ok(Object.keys(many.carry.fails).length <= C.CARRY_IPS_MAX);
  // 판정 코어 burstTimes(순수)
  assert.deepEqual(C.burstTimes([1, 2, 3], [3], { count: 3, windowMin: 1 }), [3]);
  assert.deepEqual(C.burstTimes([0, 120_000], [120_000], { count: 2, windowMin: 1 }), []);
});

test('표본 가림 스윕 — 비밀 꼴 0(password= · pass= · Authorization · Bearer · 키 블록 · base64 키 줄 · URL 비밀번호 · 개인정보 · sudo 인자)', async () => {
  const secrets = ['Sup3rS3cret', 'hunter2pw', 'YIIBhwYGKwYBBQUCoIIBezCCAXeg', 'eyJhbGciOiJIUzI1NiJ9.abc', 'kim.ops@example.com', '900101-1234567', '010-1234-5678', '4111 1111 1111 1111', 'pr1vK3yB0dy'];
  const lines = [
    'kim.ops : TTY=pts/0 ; PWD=/home/kim.ops ; USER=root ; COMMAND=/usr/bin/mysql -uroot -pSup3rS3cret --host db',
    'app: connect password=hunter2pw ok', 'app: pass=hunter2pw', "app: PASSWORD: 'hunter2pw x'", 'curl: Authorization: Negotiate YIIBhwYGKwYBBQUCoIIBezCCAXeg',
    'proxy: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc', '-----BEGIN OPENSSH PRIVATE KEY-----', 'pr1vK3yB0dyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    'fetch https://svc:hunter2pw@repo.example.com/x', 'user kim.ops@example.com logged', 'rrn 900101-1234567 seen', 'tel 010-1234-5678', 'card 4111 1111 1111 1111',
  ];
  for (const l of lines) {
    const out = redactSystemLogLine(l);
    for (const s of secrets) assert.ok(!out.includes(s), `가림 실패: ${l} → ${out}`);
    assert.ok(out.includes(MASK), `표식 없음: ${out}`);
  }
  // 분류 경로 표본도 가린다(원문이 패턴 표본으로 새지 않는다)
  const r = await C.classifyItems([{ src: 'secure', unit: 'sudo', ts: NOW, msg: lines[0] }], { now: NOW });
  const smp = [...r.patterns.values()][0].samples[0].text;
  assert.ok(!smp.includes('Sup3rS3cret') && smp.includes('COMMAND=/usr/bin/mysql'), smp);
  // sudo 의 PWD=(작업 폴더)는 비밀이 아니다 — 가리지 않는다(소문자 pwd= 는 가린다)
  assert.ok(redactSystemLogLine('kim.ops : TTY=pts/0 ; PWD=/home/kim.ops ; USER=root ; COMMAND=/usr/bin/id').includes('PWD=/home/kim.ops'));
  assert.ok(!redactSystemLogLine('db: login pwd=hunter2pw').includes('hunter2pw'));
  // 식별자는 가리지 않는다(진단 정보 — 주소 · 경로 · 장치명)
  assert.equal(redactSystemLogLine('nvme nvme1: I/O 1024 QID 7 timeout, completion polled'), 'nvme nvme1: I/O 1024 QID 7 timeout, completion polled');
});

test('ReDoS — 규칙 · 보안 추출 · 템플릿 · 가림이 긴 적대 입력에서 선형(비율)', async () => {
  const time = (fn, reps = 30) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < reps; i++) fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const adversarial = [
    'a'.repeat(400), ' '.repeat(400), 'Failed password for '.repeat(25), '/a'.repeat(250), 'x=' .repeat(250), '"'.repeat(400),
    `EDAC ${'M'.repeat(300)}`, `type=USER_AUTH msg=audit(1.1:1): ${'res='.repeat(100)}`, `${'0'.repeat(200)}@${'a.'.repeat(100)}`, `; COMMAND=${'/x '.repeat(130)}`, 'account'.repeat(60),
  ];
  for (const s of adversarial) {
    const short = s.slice(0, 40);
    const tShort = time(() => { for (const src of ['journal', 'kernel', 'secure', 'audit', 'gpdb', 'airflow']) C.matchRule(src, short); C.secFacts({ id: 'SEC-SUDO' }, short); C.templateFor({ cls: 'sec' }, short); redactSystemLogLine(short); }) + 0.05;
    const tLong = time(() => { for (const src of ['journal', 'kernel', 'secure', 'audit', 'gpdb', 'airflow']) C.matchRule(src, s); C.secFacts({ id: 'SEC-SUDO' }, s); C.templateFor({ cls: 'sec' }, s); redactSystemLogLine(s); });
    // 길이 10배 → 선형이면 ≈10배. 이차면 100배 근처. 기준 40배(측정 잡음 여유 — 이차는 넘는다).
    assert.ok(tLong / tShort < 40, `비율 ${(tLong / tShort).toFixed(1)} — ${s.slice(0, 30)}`);
  }
  // 5,000줄 분류는 양보하며 끝난다(이벤트 루프 정지 없음 — 시간 기준 양보)
  const many = Array.from({ length: 5_000 }, (_, i) => ({ src: i % 2 ? 'kernel' : 'secure', ts: NOW - i * 1000, msg: i % 2 ? `nvme nvme1: I/O ${i} QID 7 timeout` : `Failed password for u${i} from 10.0.${i % 200}.${i % 250} port ${i} ssh2` }));
  // 양보는 벽시계 타이머가 아니라 같은 큐(setImmediate)의 프로브로 잰다(perf-db BUG-E — 타이머 프로브는 플래키). sliceMs 0 이면 묶음마다 양보한다.
  let probes = 0; let stop = false;
  const probe = () => { if (stop) return; probes += 1; setImmediate(probe); };
  setImmediate(probe);
  const r = await C.classifyItems(many, { now: NOW, sliceMs: 0.000001 });
  stop = true;
  assert.equal(r.counts.lines, 5_000);
  assert.ok(probes > 0, '분류 중에 다른 작업이 돈다(양보)');
});

test('반증 F8 — OpenSSH 실제 메시지 꼴 고정 표본: 계정 · IP 추출 · 사전 인증 종료 · 최대 시도 초과는 실패로 다시 세지 않는다 · 계정마다 서명이 갈라지지 않는다', async () => {
  const FIX = [
    // [메시지, 기대 규칙, 기대 계정, 기대 IP]
    ['Invalid user admin from 198.51.100.7 port 40022', 'SEC-SSH-INVALID', 'admin', '198.51.100.7'],
    ['Failed password for invalid user admin from 198.51.100.7 port 40022 ssh2', 'SEC-SSH-FAIL', 'admin', '198.51.100.7'],
    ['Failed password for root from 203.0.113.45 port 51822 ssh2', 'SEC-SSH-FAIL', 'root', '203.0.113.45'],
    ['Failed publickey for root from 2001:db8::7 port 51822 ssh2: RSA SHA256:x', 'SEC-SSH-FAIL', 'root', '2001:db8::7'],
    ['Connection closed by invalid user admin 198.51.100.7 port 40022 [preauth]', 'SEC-SSH-PREAUTH', 'admin', '198.51.100.7'],
    ['Disconnected from invalid user admin 198.51.100.10 port 40000 [preauth]', 'SEC-SSH-PREAUTH', 'admin', '198.51.100.10'],
    ['Connection closed by authenticating user root 203.0.113.45 port 51822 [preauth]', 'SEC-SSH-PREAUTH', 'root', '203.0.113.45'],
    ['Disconnected from authenticating user root 203.0.113.45 port 51822 [preauth]', 'SEC-SSH-PREAUTH', 'root', '203.0.113.45'],
    ['Received disconnect from 203.0.113.45 port 51822:11: Bye Bye [preauth]', 'SEC-SSH-PREAUTH', '', '203.0.113.45'],
    ['Connection reset by 203.0.113.45 port 51822 [preauth]', 'SEC-SSH-PREAUTH', '', '203.0.113.45'],
    ['error: maximum authentication attempts exceeded for root from 203.0.113.45 port 51822 ssh2 [preauth]', 'SEC-SSH-MAXAUTH', 'root', '203.0.113.45'],
    ['error: maximum authentication attempts exceeded for invalid user admin from 198.51.100.7 port 40022 ssh2 [preauth]', 'SEC-SSH-MAXAUTH', 'admin', '198.51.100.7'],
    ['Disconnecting authenticating user root 203.0.113.45 port 51822: Too many authentication failures [preauth]', 'SEC-SSH-MAXAUTH', 'root', '203.0.113.45'],
    ['PAM 2 more authentication failures; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.45  user=root', 'SEC-SSH-MAXAUTH', 'root', '203.0.113.45'],
    ['pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.45  user=root', 'SEC-PAM-DUP', 'root', '203.0.113.45'],
    ['Accepted publickey for gpadmin from 10.20.1.5 port 52210 ssh2: ED25519 SHA256:x', 'SEC-SSH-OK', 'gpadmin', '10.20.1.5'],
  ];
  for (const [m, id, user, ip] of FIX) {
    const r = C.matchRule('secure', m);
    assert.equal(r?.id, id, m);
    const f = C.secFacts(r, m);
    assert.equal(f.user, user, `계정 ${m}`); assert.equal(f.ip, ip, `IP ${m}`);
    const tm = C.templateFor(r, m, f);
    if (user) assert.ok(!tm.includes(user), `서명에 계정 ${user}: ${tm}`);
    assert.ok(!tm.includes(ip.split(':')[0] === '2001' ? '2001:db8' : ip), `서명에 주소: ${tm}`);
  }
  // ‘from’ 다음이 주소가 아니면 버린다(예전: ‘invalid’ 가 IP)
  assert.equal(C.ipOf('invalid'), ''); assert.equal(C.ipOf('user'), ''); assert.equal(C.ipOf('cafe'), '', '16진 글자만인 낱말은 IPv6 가 아니다');
  assert.equal(C.ipOf('::ffff:10.0.0.1'), '::ffff:10.0.0.1'); assert.equal(C.ipOf('scanner.example.net'), 'scanner.example.net');
  // 시도당 실패 수 — 공격원 8곳 × (Invalid user + Failed + Connection closed + Disconnected) → 실패 16(Invalid · Failed) · 사전 인증 종료는 세지 않음 · 서명은 계정 수와 무관
  const items = [];
  for (let i = 0; i < 8; i += 1) {
    const ip = `198.51.100.${10 + i}`; const u = `user${i}`; const t = NOW - 600_000 + i * 1000;
    items.push({ src: 'secure', ts: t, msg: `Invalid user ${u} from ${ip} port ${40000 + i}` }, { src: 'secure', ts: t, msg: `Failed password for invalid user ${u} from ${ip} port ${40000 + i} ssh2` },
      { src: 'secure', ts: t, msg: `Connection closed by invalid user ${u} ${ip} port ${40000 + i} [preauth]` }, { src: 'secure', ts: t, msg: `Disconnected from invalid user ${u} ${ip} port ${40000 + i} [preauth]` });
  }
  const r = await C.classifyItems(items, { now: NOW });
  const fails = [...r.sec.values()].filter((x) => x.kind === 'fail_ip');
  assert.equal(fails.reduce((a, x) => a + x.count, 0), 16);
  assert.ok(!fails.some((x) => x.item === 'invalid' || x.item === '(IP 없음)'), '주소를 잘못 뽑지 않는다');
  assert.equal(new Set([...r.patterns.values()].map((p) => p.sig)).size, 4, '규칙 · 문구마다 서명 1개(계정 8개여도)');
  // 서로 다른 공격원 20곳이 1줄씩 → 가짜 ‘집중’ 없음(예전: IP=‘invalid’ 20 → 집중 high)
  const spread = Array.from({ length: 20 }, (_, i) => ({ src: 'secure', ts: NOW - 60_000 + i, msg: `Disconnected from invalid user u${i} 198.51.${i}.9 port 1 [preauth]` }));
  const sp = await C.classifyItems(spread, { now: NOW });
  assert.equal(sp.bursts.length, 0); assert.equal(sp.counts.secHigh, 0);
});

test('반증 F7 · F11 — 가림 판정 하나: 같은 줄의 표본 · 서명 · 보안 상위가 가림에서 어긋나지 않는다 · GPDB 로그인 실패 = 보안 · 보관된 서명도 읽을 때 같은 가림', async () => {
  const lines = [
    { src: 'secure', ts: NOW - 1000, msg: 'login failure for user kim.ops@corp.example from 198.51.100.9 Bearer abcDEFghiJKLmnoPQR' },
    { src: 'gpdb', ts: NOW - 900, msg: 'FATAL: password authentication failed for user "etl_loader"' },
    { src: 'gpdb', ts: NOW - 800, msg: 'FATAL: no pg_hba.conf entry for host "10.1.2.3", user "bi_ro", database "dw", SSL off' },
    { src: 'journal', ts: NOW - 700, msg: "x.service: Failed with result 'exit-code'. token=ZZsecretZZ" },
    // 꼴 치환(secTemplate)이 모르는 자리에 계정이 다시 나와도 같은 줄에서 뽑은 값으로 치환한다(scrubFacts)
    { src: 'secure', ts: NOW - 600, msg: 'login failure for user ftpadmin from 198.51.100.9 (ftpadmin)' },
  ];
  const r = await C.classifyItems(lines, { now: NOW });
  const pats = [...r.patterns.values()];
  for (const p of pats) {
    for (const leak of ['kim.ops@corp.example', 'abcDEFghiJKLmnoPQR', 'etl_loader', 'bi_ro', '10.1.2.3', 'ZZsecretZZ', 'ftpadmin']) assert.ok(!p.tmpl.includes(leak), `서명에 ${leak}: ${p.tmpl}`);
    for (const s0 of p.samples) for (const leak of ['abcDEFghiJKLmnoPQR', 'ZZsecretZZ', 'kim.ops@corp.example']) assert.ok(!s0.text.includes(leak), `표본에 ${leak}: ${s0.text}`);
  }
  const gp = pats.filter((p) => p.ruleId === 'APP-GP-AUTH-FAIL');
  assert.equal(gp.length, 2); assert.ok(gp.every((p) => p.cls === 'sec'));
  const users = [...r.sec.values()].filter((x) => x.kind === 'fail_user').map((x) => x.item);
  assert.ok(users.includes('etl_loader') && users.includes('bi_ro'), '보안 상위(관리자 원문 · 비관리자 토큰)로 간다');
  // 읽기 경로 방어 — 예전 판이 쓴 서명(계정 원문)도 같은 가림을 다시 댄다(멱등)
  assert.equal(C.maskStoredTmpl('sec', 'Disconnected from invalid user kimops <ip> port <n> [preauth]'), 'Disconnected from invalid user <user> <ip> port <n> [preauth]');
  assert.equal(C.maskStoredTmpl('sec', C.maskStoredTmpl('sec', 'Failed password for <user> from <ip> port <n> ssh2')), 'Failed password for <user> from <ip> port <n> ssh2');
  assert.ok(!C.maskStoredTmpl('issue', 'auth Bearer abcDEFghiJKLmnoPQR').includes('abcDEF'));
});

test('반증 F1 · F6 — 보안 출처 하나(audit 의 같은 사건은 kind 없음) · 시각 모름은 분류하지 않고 센다 · 알림 입력은 최근 줄만', async () => {
  const au = { src: 'audit', ts: NOW - 1000, msg: "type=USER_AUTH msg=audit(1.1:1): pid=1 uid=0 auid=1 ses=1 msg='op=PAM:authentication acct=\"root\" exe=\"/usr/sbin/sshd\" hostname=203.0.113.45 addr=203.0.113.45 terminal=ssh res=failed'" };
  const a1 = await C.classifyItems([au], { now: NOW, authSrc: 'secure' });
  assert.equal([...a1.sec.values()].length, 0, 'secure 를 읽은 주기의 audit 인증 실패는 같은 사건 — 세지 않는다'); assert.equal(a1.counts.kindDup, 1);
  assert.equal([...a1.patterns.values()][0].ruleId, 'SEC-AUDIT-AUTH-FAIL', '패턴은 남는다');
  const a2 = await C.classifyItems([au], { now: NOW, authSrc: 'audit' });
  assert.ok([...a2.sec.values()].some((x) => x.kind === 'fail_ip' && x.item === '203.0.113.45'), 'audit 가 보안 출처면 센다');
  // 시각 모름(ts null) — 분류 · 시간 칸 · 알림에서 빠지고 #undated 로만
  const u = await C.classifyItems([{ src: 'kernel', ts: null, msg: 'mce: [Hardware Error]: Machine check events logged' }], { now: NOW });
  assert.equal(u.patterns.size, 0); assert.equal(u.counts.undated, 1); assert.equal(u.counts.faultLines, 0);
  assert.ok([...u.hours.values()].some((h) => h.sig === '#undated:kernel' && h.cls === 'undated'));
  // 알림 입력 — 첫 읽기의 지난 줄(2시간 전)은 기록만 · 최근 줄만 센다
  const f = await C.classifyItems([{ src: 'kernel', ts: NOW - 2 * HOUR, msg: 'mce: [Hardware Error]: Machine check events logged' }, { src: 'kernel', ts: NOW - 60_000, msg: 'mce: [Hardware Error]: Machine check events logged' }], { now: NOW });
  assert.equal(f.counts.fault, 2); assert.equal(f.counts.faultLines, 1);
});

test('보안 합계(반증 F1) — 그 종류를 담는 출처를 읽었을 때만 0 · journald 주 읽기(warning)만 읽었으면 SSH 성공 · 실패는 모름(null + 이유)', async () => {
  const V = await import('../src/bmusage/logs/view.js');
  const onlyJournal = V.secTotalsOf({}, { journal: { read: 5 } }, { journal: { status: 'ok' }, jsec: { status: 'perm', scope: 'own' }, secure: { status: 'perm', scope: 'file' }, audit: { status: 'perm', scope: 'dir' } });
  for (const k of V.SEC_TOTAL_KEYS) assert.equal(onlyJournal.totals[k], null, `${k} 는 모름`);
  assert.deepEqual(onlyJournal.why.ok.carriers, ['secure', 'jsec']); assert.equal(onlyJournal.why.ok.scopes.jsec, 'own');
  const jsecRead = V.secTotalsOf({ sudofail: 2 }, { jsec: { read: 3 } }, null);
  assert.equal(jsecRead.totals.ok, 0); assert.equal(jsecRead.totals.sudofail, 2); assert.equal(jsecRead.totals.avc, null, 'AVC 는 auditd 만 담는다');
  const auditOnly = V.secTotalsOf({ fail_ip: 4 }, { audit: { read: 1 } }, null);
  assert.equal(auditOnly.totals.fail_ip, 4); assert.equal(auditOnly.totals.ok, null); assert.equal(auditOnly.totals.avc, 0);
  const partial = V.secTotalsOf({ fail_ip: 2 }, { journal: { read: 1 } }, null);
  assert.equal(partial.totals.fail_ip, null); assert.equal(partial.why.fail_ip.partial, 2, '다른 출처에서 센 수는 부분 합으로만');
});

test('분류별 담는 출처(추가 수정) — 카탈로그에서 기계적으로 · 모든 규칙에 출처 · classCover(없음 · 일부 · 전부 · 서버에 없는 출처 · secure↔journald 보안)', () => {
  for (const r of R.ALL_LOG_RULES) {
    const s = R.ruleSources(r);
    assert.ok(s.length > 0, `${r.id} 출처(태그 또는 srcs)`);
    for (const x of s) assert.ok(R.LOG_SOURCES.includes(x), `${r.id} 출처 ${x}`);
  }
  for (const c of R.LOG_CLASSES) {
    const union = new Set(R.ALL_LOG_RULES.filter((r) => r.cls === c).flatMap(R.ruleSources));
    assert.deepEqual([...R.CLASS_CARRIERS[c]].sort(), [...union].sort(), `${c} 담는 출처 = 규칙 출처 합집합`);
  }
  assert.ok(R.CLASS_CARRIERS.fault.includes('kernel') && R.CLASS_CARRIERS.issue.includes('journal') && R.CLASS_CARRIERS.perf.includes('kernel'));
  assert.deepEqual(R.classCover('issue', new Set(), { journal: 'perm', kernel: 'perm', gpdb: 'absent', airflow: 'absent' }), { cover: 'none', missing: ['journal', 'kernel'] });
  assert.deepEqual(R.classCover('issue', new Set(['kernel']), { journal: 'perm', gpdb: 'absent', airflow: 'nofile' }), { cover: 'partial', missing: ['journal'] });
  assert.deepEqual(R.classCover('perf', new Set(['kernel']), { gpdb: 'absent' }), { cover: 'all', missing: [] }, '서버에 없는 출처(GPDB 미설치)는 못 읽음이 아니다');
  assert.deepEqual(R.classCover('sec', new Set(['secure', 'journal']), { jsec: 'perm', audit: { status: 'absent' }, gpdb: 'absent' }), { cover: 'all', missing: [] }, 'secure 를 읽었으면 journald 보안은 빠진 것이 아니다');
  assert.deepEqual(R.classCover('sec', new Set(['journal']), { jsec: 'perm', secure: 'perm', audit: 'perm', gpdb: 'absent' }), { cover: 'partial', missing: ['jsec', 'secure', 'audit'] });
  assert.deepEqual(R.classCover('perf', [], { kernel: 'absent', gpdb: 'absent' }), { cover: 'none', missing: [] }, '담는 출처가 서버에 하나도 없으면 none(이유: 없음)');
});
