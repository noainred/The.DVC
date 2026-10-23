/**
 * v2.769 점검 4회차 수정 그룹 G2(insights·복원·알림·Veeam) 회귀 고정.
 *
 *  - D2-01  DB 이전 preflight 가 ; 공백 # 를 통과시켰고, 그 경로가 다음 이전 README 의 'sudo rm' 줄에 인용 없이 들어갔다(admin → root 명령).
 *  - D2-02  preflight('/tmp') 가 통과 → root 스크립트가 chown -R·chmod 700 /tmp.
 *  - D2-04  토폴로지가 끊긴 호스트·못 읽은 vCenter 의 powerWatts(마지막 값)를 '지금 W' 로 실었고 결측을 0 으로 만들었다.
 *  - D2-05  vc:<id> 알림 fired 가 recent 에 있는데 합성 수집 실패 이벤트를 또 넣어 한 장애가 두 번 셌다.
 *  - D2-06  z·minR2 미클램프·미양자화 → 캐시 키 무한 생성, `?minR2=` → 0(필터 해제).
 *  - D1-2   예약 복원이 users.json tokenVersion·central-agent-tokens.json 을 백업 시점으로 되돌렸다(폐기 세션·폐기 엣지 토큰 부활).
 *  - D1-3   stageRestore 가 이름 규칙 밖 .json 을 조용히 버렸다(failed·excluded 어디에도 없음).
 *  - D1-4   Veeam 작업 메시지 VM 이름 제거가 뒤에 '.'·'-' 가 오면 실패해 과잉 가림.
 *  - D1-5   중앙 5분+ 정지 뒤 기동하면 전 위임 vCenter 에 '엣지 보고 끊김' 일괄 경고.
 *  (D2-03 엣지 베어메탈 시리얼 행은 serialLookup.test.js 에 있다.)
 *
 * 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2769b-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;   // 정시 −30분 고정

const DL = await import('../src/insights/dbLocation.js');
const MS = await import('../src/insights/migrateScript.js');
const { buildTopology } = await import('../src/insights/topology.js');
const { buildIncidents } = await import('../src/insights/incidents.js');
const { anomalyCfgArgs } = await import('../src/insights/anomaly.js');
const { forecastCfgArgs } = await import('../src/insights/forecast.js');
const RI = await import('../src/routes/insights.js');
const SR = await import('../src/backup/stagedRestore.js');
const BK = await import('../src/backup/service.js');
const { publicTaskMessage } = await import('../src/routes/api/veeam.js');
const alerts = await import('../src/alerts.js');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

/* ── D2-01 ─────────────────────────────────────────────────────────── */
test('D2-01 ① preflight 는 install.sh 와 같은 화이트리스트 — ; 공백 # & | * 와 .. 를 거부한다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2769b-wl-'));
  try {
    for (const bad of ['a;sudo id;#', 'a b', 'a&b', 'a|b', 'a*', 'a(b)', '../x', 'x/../../etc']) {
      const r = DL.preflight(`${base}/${bad}`);
      assert.equal(r.ok, false, `거부돼야 한다: ${bad}`);
      assert.ok(r.reasons.some((x) => /영문·숫자/.test(x)), r.reasons.join(' / '));
      assert.equal(fs.existsSync(`${base}/${bad}`), false, '거부한 경로를 만들지 않는다');
    }
    // 개행 거부(dbLocation2451.test.js:96)와 정상 경로는 그대로
    assert.ok(DL.preflight('/data/db\nrm -rf /').reasons.some((r) => /제어문자/.test(r)));
    assert.equal(DL.preflight(`${base}/vmware-portal.db_1`).ok, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('D2-01 ② README 의 모든 경로(특히 원본 삭제 줄)는 인용된다 — 기존 설치의 기묘한 dbDir 도 명령이 되지 않는다', () => {
  const weird = path.join(DIR, 'old;sudo id;#');
  const loc = path.join(DIR, 'db-location.json');
  fs.writeFileSync(loc, JSON.stringify({ dbDir: weird }));
  try {
    const target = path.join(DIR, 'newdb');
    const r = MS.writeMigrationScript({ targetDir: target, now: NOW });
    const md = fs.readFileSync(r.readmePath, 'utf8');
    const rmLine = md.split('\n').find((l) => /sudo rm -f .*host-temp\.db\*/.test(l));
    assert.ok(rmLine, '원본 삭제 줄이 있다');
    assert.ok(rmLine.includes(`'${weird}'/host-temp.db*`), `srcDir 인용: ${rmLine}`);
    assert.equal(md.includes(`${weird}/host-temp`), false, '인용 없는 삽입이 남지 않는다');
    // bash 코드블록 안의 경로 줄은 전부 인용부호로 시작한다
    for (const l of md.split('\n').filter((x) => /^(cd|less|sudo bash|sudo rm -f) /.test(x.trim()))) {
      assert.match(l.trim(), /^(cd|less|sudo bash|sudo rm -f) '/, l);
    }
    // 스크립트 머리 주석에 개행이 들어가도 주석을 탈출하지 않는다 + 문법 확인
    const sh = fs.readFileSync(r.scriptPath, 'utf8');
    assert.ok(sh.includes(`SRC='${weird}'`));
    const bn = spawnSync('bash', ['-n', r.scriptPath], { encoding: 'utf8' });
    if (bn.error?.code !== 'ENOENT') assert.equal(bn.status, 0, bn.stderr);
  } finally { fs.rmSync(loc, { force: true }); }
});

/* ── D2-02 ─────────────────────────────────────────────────────────── */
test('D2-02 ① 시스템 디렉터리 자체·가상 파일시스템·공용(sticky/world-writable) 디렉터리는 대상이 아니다', () => {
  for (const sys of ['/', '/tmp', '/var/tmp', '/dev/shm', '/run', '/var', '/opt', '/srv']) {
    const r = DL.preflight(sys);
    assert.equal(r.ok, false, `${sys} 는 거부`);
  }
  assert.equal(DL.preflight('/dev/shm/portal-db').ok, false, '휘발 파일시스템 아래도 거부');
  assert.equal(DL.preflight('/proc/portal-db').ok, false);
  const ww = fs.mkdtempSync(path.join(os.tmpdir(), 'a2769b-ww-'));
  const sticky = fs.mkdtempSync(path.join(os.tmpdir(), 'a2769b-st-'));
  try {
    fs.chmodSync(ww, 0o777);
    fs.chmodSync(sticky, 0o1777);
    for (const d of [ww, sticky]) {
      const r = DL.preflight(d);
      assert.equal(r.ok, false, d);
      assert.ok(r.reasons.some((x) => /공용 디렉터리/.test(x)), r.reasons.join(' / '));
    }
    // 심볼릭 링크로 /tmp 를 가리켜도 실제 경로로 본다
    const link = path.join(DIR, 'tmplink');
    fs.symlinkSync('/tmp', link);
    assert.equal(DL.preflight(link).ok, false, '링크 → /tmp 거부');
  } finally { fs.rmSync(ww, { recursive: true, force: true }); fs.rmSync(sticky, { recursive: true, force: true }); }
});

test('D2-02 ② /tmp 아래 새 디렉터리·비어 있는 기존 디렉터리는 허용, 파일이 있는 기존 디렉터리는 서비스 계정 소유일 때만', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2769b-ok-'));
  try {
    const fresh = DL.preflight(path.join(base, 'new', 'db'));
    assert.equal(fresh.ok, true, fresh.reasons.join(' / '));
    assert.equal(fresh.created, true);
    assert.equal(DL.preflight(path.join(base, 'new', 'db')).ok, true, '두 번째 점검(스크립트 생성)도 통과 — 비어 있다');
    const full = path.join(base, 'full');
    fs.mkdirSync(full, { mode: 0o700 });
    fs.writeFileSync(path.join(full, 'someone.txt'), 'x');
    const r = DL.preflight(full);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid === 0) assert.equal(r.ok, false, 'root 로 도는 포탈은 소유자 판별력이 없다 — 비어 있는 디렉터리만');
    else if (uid != null) assert.equal(r.ok, true, '서비스 계정(이 프로세스) 소유는 허용');
    // 순수 판정: 다른 계정 소유 + 비어 있지 않음 → 거부
    if (uid != null) {
      const st = fs.statSync(full);
      assert.ok(DL.existingDirIssue(full, { ...st, mode: st.mode, uid: uid + 1 }), '다른 계정 소유는 거부');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('D2-02 ③ 생성 스크립트도 실행 시점에 공용 디렉터리면 chown 전에 중단한다', () => {
  const r = MS.writeMigrationScript({ targetDir: path.join(DIR, 'newdb2'), now: NOW + 1000 });
  const sh = fs.readFileSync(r.scriptPath, 'utf8');
  const guard = sh.indexOf('[ -k "$DST" ]');
  assert.ok(guard > 0, '가드 존재');
  assert.ok(guard < sh.indexOf('chown -R "$RUN_USER"'), 'chown 보다 먼저');
});

/* ── D2-04 ─────────────────────────────────────────────────────────── */
test('D2-04 토폴로지 전력 — 끊긴 호스트·못 읽은 vCenter 는 null(마지막 값 아님), 결측도 0 이 아니라 null', () => {
  const snap = {
    vcenters: [{ id: 'vc1', name: 'vc1', status: 'connected' }, { id: 'vc2', name: 'vc2', status: 'unreachable' }],
    hosts: [
      { id: 'h1', name: 'esx1', vcenterId: 'vc1', cluster: 'c1', connectionState: 'DISCONNECTED', powerState: 'POWERED_ON', powerWatts: 480 },
      { id: 'h2', name: 'esx2', vcenterId: 'vc1', cluster: 'c1', connectionState: 'CONNECTED', powerState: 'POWERED_ON', powerWatts: 300, cpuUsagePct: 10, memUsagePct: 20 },
      { id: 'h3', name: 'esx3', vcenterId: 'vc1', cluster: 'c1', connectionState: 'CONNECTED', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20 },
      { id: 'h4', name: 'esx4', vcenterId: 'vc2', cluster: 'c2', connectionState: 'CONNECTED', powerState: 'POWERED_ON', powerWatts: 250, cpuUsagePct: 10, memUsagePct: 20 },
    ],
    vms: [],
  };
  const t = buildTopology(snap);
  const hosts = new Map();
  for (const v of t.tree) for (const c of v.children) for (const h of c.children) hosts.set(h.id, h);
  assert.equal(hosts.get('h1').watts, null, '끊긴 호스트');
  assert.equal(hosts.get('h2').watts, 300);
  assert.equal(hosts.get('h3').watts, null, '결측은 0 이 아니다');
  assert.equal(hosts.get('h4').watts, null, '못 읽은 vCenter');
});

/* ── D2-05 ─────────────────────────────────────────────────────────── */
test('D2-05 같은 key(vc:<id>) 의 fired 가 recent 에 있으면 합성 수집 실패 이벤트를 넣지 않는다 — 없으면 넣는다(채널 미설정 가시성)', () => {
  const snap = { vcenters: [{ id: 'vc-x', name: 'X', status: 'unreachable', error: 'timeout', staleSince: NOW - HOUR }] };
  const at = new Date(NOW - 50 * 60_000).toISOString();
  const withFired = buildIncidents({ firing: [], recent: [{ at, key: 'vc:vc-x', vcenterId: 'vc-x', severity: 'critical', title: 'vCenter 수집 실패: X' }] }, snap, { now: NOW });
  assert.equal(withFired.timeline.filter((e) => e.key === 'vc:vc-x' && e.kind === 'fired').length, 1, '한 장애는 한 번');
  assert.equal(withFired.summary.recent24h, 1);
  const none = buildIncidents({ firing: [], recent: [] }, snap, { now: NOW });
  assert.equal(none.timeline.filter((e) => e.key === 'vc:vc-x').length, 1, '알림 기록이 없으면 합성으로 보인다');
  // 해소 기록만 있는 key 는 fired 가 아니다 — 합성 유지
  const resolvedOnly = buildIncidents({ firing: [], recent: [{ at, key: 'vc:vc-x', vcenterId: 'vc-x', severity: 'resolved', title: '해소' }] }, snap, { now: NOW });
  assert.equal(resolvedOnly.timeline.filter((e) => e.key === 'vc:vc-x' && e.kind === 'fired').length, 1);
});

/* ── D2-06 ─────────────────────────────────────────────────────────── */
test('D2-06 ① z 는 [2,10]·0.5 단위, 창·버킷은 정수 — 사소히 다른 인자가 같은 키가 된다', () => {
  const key = (o) => Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('&');
  assert.equal(key(RI.anomalyArgs({ z: '2.0001' })), key(RI.anomalyArgs({ z: '2.0002' })));
  assert.equal(RI.anomalyArgs({ z: '99' }).z, 10);
  assert.equal(RI.anomalyArgs({ z: '1' }).z, 2);
  assert.equal(RI.anomalyArgs({ z: 'x' }).z, 3.5);
  for (const v of [2.5, 3, 3.5, 4, 5]) assert.equal(RI.anomalyArgs({ z: String(v) }).z, v, '화면 선택지는 그대로');
  assert.equal(RI.anomalyArgs({ windowHours: '24.4', bucketMin: '10.6' }).windowHours, 24);
  assert.equal(RI.anomalyArgs({ windowHours: '24.4', bucketMin: '10.6' }).bucketMin, 11);
  assert.equal(RI.anomalyArgs({ windowHours: '' }).windowHours, 24, "빈 값은 0(→1시간)이 아니라 기본값");
  // 키와 계산이 같은 값(라우트 = 계산 모듈 함수, 멱등)
  const a = RI.anomalyArgs({ z: '3.3', windowHours: '9999', bucketMin: '0.2' });
  assert.deepEqual(anomalyCfgArgs(a), a);
});

test('D2-06 ② minR2 — 빈 값·숫자 아님은 기본(0.3), 숫자는 [0,1]·0.05 단위 · days 정수', () => {
  assert.equal(RI.forecastArgs({ minR2: '' }).minR2, 0.3, "Number('')=0 으로 필터를 풀지 않는다");
  assert.equal(RI.forecastArgs({ minR2: 'x' }).minR2, 0.3);
  assert.equal(RI.forecastArgs({}).minR2, 0.3);
  assert.equal(RI.forecastArgs({ minR2: '0.73' }).minR2, 0.75);
  assert.equal(RI.forecastArgs({ minR2: '5' }).minR2, 1);
  assert.equal(RI.forecastArgs({ minR2: '-1' }).minR2, 0);
  assert.equal(RI.forecastArgs({ minR2: '0' }).minR2, 0, '명시한 0 은 0');
  assert.equal(RI.forecastArgs({ days: '7.3' }).days, 7);
  assert.equal(RI.forecastArgs({ days: '7.3', bucketMin: '90' }).bucketMin, 120, '1시간 정배수');
  const f = RI.forecastArgs({ days: '30.6', bucketMin: '61', minR2: '0.333', vcenterId: 'vc1' });
  const { vcenterId, ...calc } = f;
  assert.equal(vcenterId, 'vc1');
  assert.deepEqual(forecastCfgArgs(calc), calc, '계산 모듈이 다시 정규화해도 같다');
});

/* ── D1-2 ──────────────────────────────────────────────────────────── */
function stageAndApply(configDir, files) {
  SR.stageRestore(files, { configDir, source: 't' });
  return SR.applyStagedRestore({ configDir });
}

test('D1-2 ① 예약 복원 적용: users.json 은 계정별 tokenVersion = max(현재, 백업)+1', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'a2769b-u-'));
  try {
    fs.mkdirSync(path.join(d, 'backups'));
    fs.writeFileSync(path.join(d, 'users.json'), JSON.stringify({ users: [{ username: 'alice', tokenVersion: 5 }, { username: 'bob', tokenVersion: 1 }] }));
    const backup = { users: [{ username: 'alice', tokenVersion: 3, role: 'admin' }, { username: 'bob', tokenVersion: 4 }, { username: 'carol' }] };
    const r = stageAndApply(d, { 'users.json': JSON.stringify(backup) });
    assert.equal(r.ok, true);
    assert.equal(r.tokenVersionBumped, 3);
    const got = JSON.parse(fs.readFileSync(path.join(d, 'users.json'), 'utf8')).users;
    const tv = Object.fromEntries(got.map((u) => [u.username, u.tokenVersion]));
    assert.deepEqual(tv, { alice: 6, bob: 5, carol: 1 }, '백업 시점 tv 로 되돌리면 그 뒤 폐기한 토큰이 통과한다');
    assert.equal(got.find((u) => u.username === 'alice').role, 'admin', '다른 필드는 백업 그대로');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('D1-2 ② central-agent-tokens.json 은 현재 파일 우선 병합 — 백업에만 있는 항목은 되살리되 경고, 재해 복구(현재 없음)는 전부', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'a2769b-t-'));
  try {
    fs.mkdirSync(path.join(d, 'backups'));
    const F = path.join(d, 'central-agent-tokens.json');
    fs.writeFileSync(F, JSON.stringify({ tokens: [{ agent: 'edge-a', hash: 'aa'.repeat(32), createdAt: 2 }] }));
    const backup = JSON.stringify({ tokens: [{ agent: 'EDGE-A', hash: 'old'.padEnd(64, '0'), createdAt: 1 }, { agent: 'edge-b', hash: 'bb'.repeat(32), createdAt: 1 }] });
    const r = stageAndApply(d, { 'central-agent-tokens.json': backup });
    const got = JSON.parse(fs.readFileSync(F, 'utf8')).tokens;
    assert.equal(got.find((t) => t.agent.toLowerCase() === 'edge-a').hash, 'aa'.repeat(32), '재발급한 현재 토큰이 이긴다(폐기한 옛 토큰 부활 금지)');
    assert.ok(got.some((t) => t.agent === 'edge-b'), '백업에만 있는 항목은 되살린다');
    assert.equal(got.length, 2);
    assert.equal(r.agentTokensRevived, 1);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0].reason, /엣지 토큰 1개/);
    // 재해 복구 — 현재 파일이 없으면 백업 전부(제외 목록에 넣으면 전 엣지 토큰 유실)
    fs.rmSync(F);
    const r2 = stageAndApply(d, { 'central-agent-tokens.json': backup });
    assert.equal(JSON.parse(fs.readFileSync(F, 'utf8')).tokens.length, 2);
    assert.equal(r2.agentTokensRevived, 2);
    assert.match(r2.warnings[0].reason, /없거나 읽지 못했습니다/);
    assert.equal(SR.stagedNameIssue('central-agent-tokens.json'), null, '제외 목록에 넣지 않는다');
    assert.equal(SR.stagedNameIssue('users.json'), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

/* ── D1-3 + D1-2 응답 ─────────────────────────────────────────────── */
test('D1-3 이름 규칙 밖 .json 은 failed 에 사유와 함께 실린다 · D1-2 복원 응답이 토큰 부활·전원 재로그인을 미리 경고한다', async () => {
  fs.writeFileSync(path.join(DIR, 'central-agent-tokens.json'), JSON.stringify({ tokens: [{ agent: 'edge-a', hash: 'aa'.repeat(32) }] }));
  const archive = { v: 1, central: { files: {
    'vcenters.json': '[]', 'my settings.json': '{"a":1}', '.hidden.json': '{}', 'idrac+old.json': '{}',
    'central-agent-tokens.json': JSON.stringify({ tokens: [{ agent: 'edge-a', hash: 'cc'.repeat(32) }, { agent: 'edge-z', hash: 'dd'.repeat(32) }] }),
    'users.json': JSON.stringify({ users: [{ username: 'alice', tokenVersion: 1 }] }),
  } }, edges: {} };
  const r = await BK.restoreCentral(archive, { retention: 5 });
  assert.deepEqual(r.staged.sort(), ['central-agent-tokens.json', 'users.json', 'vcenters.json']);
  const failedNames = r.failed.map((f) => f.file).sort();
  assert.deepEqual(failedNames, ['.hidden.json', 'idrac+old.json', 'my settings.json'], '조용히 버리지 않는다');
  assert.ok(r.failed.every((f) => /예약 복원 불가 이름/.test(f.reason)));
  const w = Object.fromEntries(r.warnings.map((x) => [x.file, x.reason]));
  assert.match(w['central-agent-tokens.json'], /엣지 토큰 1개\(edge-z\)/);
  assert.match(w['users.json'], /다시 로그인/);
  // stageRestore 단독으로도 거른 이름을 돌려준다
  const s = SR.stageRestore({ 'ok.json': '{}', 'bad name.json': '{}', '../x.json': '{}' }, { configDir: DIR });
  assert.deepEqual(s.dropped.map((x) => x.file).sort(), ['../x.json', 'bad name.json']);
  SR.cancelStagedRestore({ configDir: DIR });
});

/* ── D1-4 ──────────────────────────────────────────────────────────── */
test('D1-4 점 든 VM 이름 뒤 문장 마침표·하이픈 접미는 이름으로 빼고(과잉 가림 해소), v2.768 vmName=corp 분할 노출은 계속 막는다', () => {
  const n = 'db01.corp.local';
  for (const m of ['Processing db01.corp.local.', 'Removing db01.corp.local-flat.vmdk snapshot', 'VM db01.corp.local has been processed.', 'Processing db01.corp.local']) {
    assert.equal(publicTaskMessage(m, { vmName: n }), m, m);
  }
  const masked = '작업 메시지에 주소가 들어 있어 관리자 화면에서만 보입니다';
  // 이름이 더 긴 라벨의 앞부분이면(뒤 '.' + 영숫자) 빼지 않는다 — 다른 호스트 주소가 그대로 가려진다
  assert.equal(publicTaskMessage('Failed on db01.corp.local.backup.corp.local', { vmName: n }), masked);
  // 이름은 빼도 다른 FQDN 이 있으면 가린다
  assert.equal(publicTaskMessage('Processing db01.corp.local. Proxy vbr02.corp.local failed', { vmName: n }), masked);
  // v2.768 R3-C1-2 회귀 — vmName='corp' 가 'vbr01.corp.local' 을 쪼개 주소를 내보내면 안 된다(왼쪽 경계는 그대로)
  assert.equal(publicTaskMessage('Error at vbr01.corp.local', { vmName: 'corp' }), masked);
  assert.equal(publicTaskMessage('Error at vbr01.corp.local', { vmName: 'vbr01' }), masked, "오른쪽 '.' + 영숫자는 경계 위반");
  assert.equal(publicTaskMessage('Error at vbr01-proxy.corp.local', { vmName: 'vbr01' }), masked, "'-' 를 허용해도 남은 라벨이 FQDN 이면 가린다");
});

/* ── D1-5 ──────────────────────────────────────────────────────────── */
test('D1-5 vcstale 기준 = max(receivedAt, 프로세스 기동 시각) — 재기동 직후 일괄 경고하지 않고 보류, 기동 뒤 SITE_STALE_MS 가 지나면 알린다', () => {
  const STALE = 5 * 60_000;
  assert.equal(alerts.vcStaleAlertDue(NOW - 3 * HOUR, { now: NOW, startedAt: NOW - 60_000, staleMs: STALE }), false, '기동 1분 — 엣지가 보고할 기회가 없었다');
  assert.equal(alerts.vcStaleAlertDue(NOW - 3 * HOUR, { now: NOW, startedAt: NOW - 2 * HOUR, staleMs: STALE }), true);
  assert.equal(alerts.vcStaleAlertDue(NOW - 60_000, { now: NOW, startedAt: NOW - 2 * HOUR, staleMs: STALE }), false, '보고가 최근');
  assert.equal(alerts.vcStaleAlertDue(null, { now: NOW, startedAt: NOW - 2 * HOUR, staleMs: STALE }), true, '보고 시각 미상 + 오래 떠 있음');
  assert.equal(alerts.vcStaleAlertDue('', { now: NOW, startedAt: NOW - 60_000, staleMs: STALE }), false);

  const CFG = { cooldownMin: 60, rules: { vcenterDown: { enabled: true }, datastorePct: { enabled: true, threshold: 90 } } };
  const snap = {
    vcenters: [{ id: 'vc-pl', name: 'Poland', status: 'connected', collectSource: 'site', stale: true, receivedAt: Date.now() - 3 * HOUR }],
    hosts: [], alarms: [], datastores: [{ id: 'ds1', vcenterId: 'vc-pl', name: 'd', usagePct: 95, freeGB: 1 }],
  };
  try {
    alerts._setProcessStartForTest(Date.now());
    const boot = alerts.evaluate(snap, CFG);
    assert.deepEqual(boot.map((a) => a.key), [], '재기동 직후: 보고 끊김 경고 없음 · 낡은 DS 값도 새로 내지 않음');
    assert.ok(boot.held.has('vcstale:vc-pl'), '이미 발생 중이던 것은 해소로 기록하지 않는다(보류)');
    alerts._setProcessStartForTest(Date.now() - 2 * HOUR);
    assert.deepEqual(alerts.evaluate(snap, CFG).map((a) => a.key), ['vcstale:vc-pl']);
  } finally { alerts._setProcessStartForTest(Date.now()); }
});
