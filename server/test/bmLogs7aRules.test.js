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
