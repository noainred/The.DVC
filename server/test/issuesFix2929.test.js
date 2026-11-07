/**
 * issuesFix2929.test.js — v2.929(사용자 '개선 포인트 1 → 3 → 2 → 4 진행해' · 검증 '표준').
 *  3 알람 엔진 평가 → 구독(onAlertState) → 다른 알람 자동 등록(applyAlertState) 이 **실제로 이어지는가**(v2.908 은 판정 함수만 직접 불렀다)
 *    · 판정 보류(그 vCenter 를 지금 못 읽음)로 목록에서 빠진 알람은 해소 댓글 · 검토로 이어지지 않는다
 *  2 인증서 만료(security/certMonitor.js 판정) → 이슈 자동 등록 · 해소
 *  4 위키 자동 체크(완료 → 체크 항목)는 이슈와 같은 법인 스페이스 + 공용 스페이스만(사용자 선택)
 * 기준 시각은 정시에서 떨어뜨린 고정값(Date.now() 를 기준으로 쓰지 않는다 — docs/rules/common.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'i2929-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';

const { store } = await import('../src/store.js');
const alerts = await import('../src/alerts.js');
const ai = await import('../src/issues/alertIssues.js');
const ist = await import('../src/issues/store.js');

const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));
async function evalWith(snap, cfg) {
  const orig = store.get;
  store.get = () => snap;
  try { await alerts._refreshStateForTest(cfg, false); } finally { store.get = orig; }
  await tick(); // 구독자는 setImmediate 로 돈다
}
const CFG = { cooldownMin: 60, rules: { vcenterDown: { enabled: true }, hostDisconnected: { enabled: true } } };
const base = (over = {}) => ({ vcenters: [{ id: 'vc-a', name: 'A', status: 'connected' }], alarms: [], hosts: [], datastores: [], vms: [], ...over });
const alertIssues = () => ist.findByOrigin((o) => o.kind === 'alert', { openOnly: false });

test('3 알람 엔진 → 구독 → 이슈: 발생 · 해소 · 판정 보류는 해소가 아니다', async () => {
  alerts._resetAlertStateForTest();
  ai.saveAlertAuto({ enabled: true, delayMin: 0, kinds: { vc: true, host: true } });
  await ai.startAlertIssues();
  // vCenter 수집 실패 + 호스트 끊김 발생
  await evalWith(base({ vcenters: [{ id: 'vc-a', name: 'A', status: 'connected' }, { id: 'vc-b', name: 'B', status: 'unreachable' }],
    hosts: [{ id: 'h1', name: 'esx1', vcenterId: 'vc-a', connectionState: 'DISCONNECTED' }] }), CFG);
  let made = alertIssues();
  assert.deepEqual(made.map((x) => x.origin.alertKey).sort(), ['host:h1', 'vc:vc-b'], '평가에서 난 알람이 구독을 거쳐 이슈가 된다');
  // 다음 평가: vc-b 는 다시 연결(해소) · vc-a 는 지금 못 읽음(점검 중) — 그 vCenter 의 호스트 알람은 목록에서 빠지지만 해소가 아니다
  await evalWith(base({ vcenters: [{ id: 'vc-a', name: 'A', status: 'maintenance' }, { id: 'vc-b', name: 'B', status: 'connected' }], hosts: [] }), CFG);
  made = alertIssues();
  const vc = made.find((x) => x.origin.alertKey === 'vc:vc-b');
  const host = made.find((x) => x.origin.alertKey === 'host:h1');
  assert.equal(vc.status, 'review', '해소 → 검토');
  assert.ok(vc.origin.resolvedAt);
  assert.equal(host.status, 'backlog', '판정 보류는 해소가 아니다 — 검토로 옮기지 않는다');
  assert.equal(host.origin.resolvedAt, null);
  const hostView = ist.getIssue(host.key);
  assert.equal(hostView.comments.length, 0, '해소 댓글도 없다');
  // 같은 알람이 이어지는 동안 두 번 만들지 않는다
  await evalWith(base({ vcenters: [{ id: 'vc-a', name: 'A', status: 'connected' }, { id: 'vc-b', name: 'B', status: 'connected' }],
    hosts: [{ id: 'h1', name: 'esx1', vcenterId: 'vc-a', connectionState: 'DISCONNECTED' }] }), CFG);
  assert.equal(alertIssues().filter((x) => x.origin.alertKey === 'host:h1').length, 1);
  ist.flushIssuesNow();
});

test('2 인증서 만료 → 이슈: 30일 이하 · 만료 · 갱신 해소 · 확인 실패는 보류 · 구독 연결', async () => {
  const cm = await import('../src/security/certMonitor.js');
  ai.saveAlertAuto({ enabled: true, delayMin: 0, kinds: { cert: true }, priority: { cert: 'p1' } });
  // 판정(순수) — 칸이 꺼져 있으면 아무것도 하지 않는다
  assert.equal(ai.planCertIssues([{ kind: 'vcenter', id: 'vc-a', status: 'critical' }], { ...ai.defaultAlertAuto(), kinds: { ...ai.defaultAlertAuto().kinds, cert: false } }).actions.length, 0);
  const now = 1_800_000_000_000 - 30 * 60_000;
  const it = (status, daysLeft, over = {}) => ({ kind: 'vcenter', id: 'vc-a', name: 'A', host: 'vca.example', port: 443, status, daysLeft, validTo: now + daysLeft * 86_400_000, cn: 'vca', ...over });
  const certIssues = () => ist.findByOrigin((o) => o.kind === 'alert' && o.alertKind === 'cert', { openOnly: false });
  // 확인 실패 · 31일 이상은 만들지 않는다
  ai.applyCertResults([it('error', null), it('expiring', 45), { kind: 'nsx', id: 'nsx-1', name: 'N', status: 'blocked' }], { now });
  assert.equal(certIssues().length, 0);
  // 30일 이하 → 만든다(법인 = vCenter id · NSX 는 귀속 vCenter)
  ai.applyCertResults([it('critical', 20), { kind: 'nsx', id: 'nsx-1', name: 'N', host: 'nsx.example', status: 'expired', daysLeft: -2, validTo: now - 2 * 86_400_000, vcenterId: 'vc-b' }], { now });
  let rows = certIssues();
  assert.equal(rows.length, 2);
  const vcI = ist.getIssue(rows.find((x) => x.origin.alertKey === 'cert:vcenter:vc-a').key);
  const nsxI = ist.getIssue(rows.find((x) => x.origin.alertKey === 'cert:nsx:nsx-1').key);
  assert.match(vcI.title, /^\[인증서 만료 임박\] vCenter A — 20일 남음/);
  assert.equal(vcI.vcenterId, 'vc-a'); assert.equal(vcI.priority, 'p1');
  assert.match(nsxI.title, /^\[인증서 만료\] NSX Manager N — 2일 지남/);
  assert.equal(nsxI.vcenterId, 'vc-b');
  // 같은 상태가 이어지면 아무것도 하지 않고, 만료로 바뀌면 한 번만 댓글
  ai.applyCertResults([it('critical', 19)], { now });
  assert.equal(ist.getIssue(vcI.key).comments.length, 0);
  ai.applyCertResults([it('expired', -1)], { now });
  ai.applyCertResults([it('expired', -2)], { now });
  const cm1 = ist.getIssue(vcI.key).comments;
  assert.equal(cm1.length, 1, '만료로 바뀐 때 한 번만');
  assert.match(cm1[0].body, /^인증서가 만료됐습니다 — vCenter A/);
  // 확인 실패는 해소가 아니다 → 갱신(남은 400일)이면 해소 + 검토
  ai.applyCertResults([it('error', null)], { now });
  assert.equal(ist.getIssue(vcI.key).status, 'backlog');
  ai.applyCertResults([it('ok', 400)], { now });
  const after = ist.getIssue(vcI.key);
  assert.equal(after.status, 'review');
  assert.match(after.comments.at(-1).body, /^해소: 인증서가 갱신됐습니다/);
  assert.equal(certIssues().length, 2, '두 번 만들지 않는다');
  // 구독 연결 — certMonitor 가 확인을 마치면(데모 모드 합성 인증서) 이슈 쪽으로 결과가 간다
  const seen = [];
  const off = cm.onCertResults((items) => seen.push(items.length));
  process.env.DATA_SOURCE = 'mock';
  await cm.refreshCerts();
  await tick();
  off();
  assert.ok(seen.length === 1 && seen[0] >= 0, `확인 결과가 구독자에게 한 번 간다(${JSON.stringify(seen)})`);
  ist.flushIssuesNow();
});

test('4 위키 자동 체크는 이슈의 법인 스페이스 + 공용만(사용자 선택) — 다른 법인 문서는 세기만', async () => {
  const wk = await import('../src/wiki/store.js');
  const body = (k) => ['- [ ] ' + k + ' 확인', '- [ ] 다른 항목'].join('\n');
  const mk = (spaceId, title, k) => wk.createPage({ spaceId, title, body: body(k) }, 'adm', { known: new Set(['vc-a', 'vc-b']) });
  const a = ist.createIssue({ title: '법인 A 작업', vcenterId: 'vc-a' }, 'adm', { known: new Set(['vc-a', 'vc-b']) });
  const g = ist.createIssue({ title: '공용 작업' }, 'adm');
  const pA = mk('vc-a', '법인 A 런북', a.key); const pB = mk('vc-b', '법인 B 런북', a.key); const pP = mk('pub', '공용 런북', a.key);
  const qA = mk('vc-a', '법인 A 문서(공용 이슈)', g.key); const qP = mk('pub', '공용 문서(공용 이슈)', g.key);
  const r1 = wk.checkIssueTasks(a.key, 'automation', { vcenterId: 'vc-a' });
  assert.deepEqual({ pages: r1.pages, out: r1.outOfScope }, { pages: 2, out: 1 });
  const checked = (p) => /^- \[x\]/.test(wk.getPage(p.id).body);
  assert.deepEqual([checked(pA), checked(pB), checked(pP)], [true, false, true], '법인 A · 공용만 — B 법인 문서는 그대로');
  const r2 = wk.checkIssueTasks(g.key, 'automation', { vcenterId: '' });
  assert.deepEqual({ pages: r2.pages, out: r2.outOfScope }, { pages: 1, out: 1 });
  assert.deepEqual([checked(qA), checked(qP)], [false, true], '공용 이슈는 공용 스페이스만');
  // 자동화 규칙이 이슈의 법인을 넘긴다(automation.js 소스 대조 — 넘기지 않으면 공용만 체크하게 된다)
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/issues/automation.js'), 'utf8');
  assert.match(src, /checkIssueTasks\(i\.key, AUTOMATION_USER, \{ vcenterId: i\.vcenterId \|\| '' \}\)/);
  ist.flushIssuesNow(); wk.flushWikiNow();
});
