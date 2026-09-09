/**
 * v2.434 — 에이전트 ↔ 수집 서버(원격) 대조·연결:
 *  · diffTargets(순수): 매칭 규칙(URL 우선 → id) · 상태 판정 · 토큰 값 무노출 · 역방향 orphan
 *  · 대상 저장 시 수집 서버 자동 등록(토큰 자동 생성 포함)
 *  · 빠진 수집 서버 일괄 추가(토큰 생성·검증·실패 처리)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colsync2434-'));
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

test('collectorSync.targetUrl / urlKey: advertiseUrl 우선, 기본 포트 보정', async () => {
  const { targetUrl, urlKey } = await import('../src/agent/collectorSync.js');
  assert.equal(targetUrl({ host: '10.1.1.1', portalPort: 4000 }), 'http://10.1.1.1:4000');
  assert.equal(targetUrl({ host: '10.1.1.1' }), 'http://10.1.1.1:4000', '포탈 포트 기본 4000');
  assert.equal(targetUrl({ host: '10.1.1.1', portalPort: 4000, advertiseUrl: 'http://10.9.9.9:4068/' }), 'http://10.9.9.9:4068',
    '중계 엣지 경유(advertiseUrl)가 진실 — host:portalPort 는 중앙에서 닿는 주소가 아니다');
  assert.equal(targetUrl({}), '');
  assert.equal(urlKey('http://10.1.1.1:4000'), '10.1.1.1:4000');
  assert.equal(urlKey('https://a.example.com'), 'a.example.com:443');
  assert.equal(urlKey('10.1.1.1:4000'), '10.1.1.1:4000', '스킴 없어도 인식');
  assert.equal(urlKey('http://A.Example.com:80/x'), 'a.example.com:80');
  assert.equal(urlKey('nope::'), '');
});

test('collectorSync.diffTargets: linked / missing / no-token / url-mismatch / token-mismatch / disabled + orphan', async () => {
  const { diffTargets } = await import('../src/agent/collectorSync.js');
  const targets = [
    { id: 't1', host: '10.1.1.1', portalPort: 4000, agentName: 'AZ', collectorDatacenter: 'AZ', collectorToken: 'tok-az', lastResult: { ok: true, at: 1000 } },
    { id: 't2', host: '10.1.1.2', portalPort: 4000, agentName: 'GM1', collectorToken: 'tok-gm1' },      // 수집 서버 없음
    { id: 't3', host: '10.1.1.3', portalPort: 4000, agentName: 'GM2' },                                  // 토큰도 없음
    { id: 't4', host: '10.1.1.4', portalPort: 4000, agentName: 'HD', collectorToken: 'tok-hd' },         // 같은 id, 다른 URL
    { id: 't5', host: '10.1.1.5', portalPort: 4000, agentName: 'MI', collectorToken: 'mine' },           // 토큰 불일치
    { id: 't6', host: '10.1.1.6', portalPort: 4000, agentName: 'NB', collectorToken: 'x', enabled: false },
  ];
  const collectors = [
    { id: 'az', name: 'AZ', url: 'http://10.1.1.1:4000', token: 'tok-az', enabled: true },
    { id: 'hd', name: 'HD', url: 'http://10.9.9.9:4000', token: 'tok-hd', enabled: true },               // URL 이 다름
    { id: 'mi', name: 'MI', url: 'http://10.1.1.5:4000', token: 'central-side', enabled: true },
    { id: 'legacy', name: '수동등록', url: 'http://10.8.8.8:4000', token: 'z', enabled: true },           // 배포 대상 없음
  ];
  const { rows, orphans, summary } = diffTargets(targets, collectors);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.t1.status, 'linked'); assert.equal(by.t1.collectorId, 'az'); assert.equal(by.t1.installed, true);
  assert.equal(by.t2.status, 'missing'); assert.equal(by.t2.canAdd, true);
  assert.equal(by.t3.status, 'no-token'); assert.equal(by.t3.canAdd, true, '토큰이 없어도 추가 대상(생성해서 채운다)');
  assert.equal(by.t4.status, 'url-mismatch'); assert.equal(by.t4.canAdd, false);
  assert.equal(by.t5.status, 'token-mismatch'); assert.equal(by.t5.canAdd, false);
  assert.equal(by.t6.status, 'disabled'); assert.equal(by.t6.canAdd, false);
  assert.equal(by.t1.installed, true); assert.equal(by.t2.installed, false);
  assert.match(by.t2.why, /배포 기록 없음/);
  assert.deepEqual(orphans.map((o) => o.id), ['legacy']);
  assert.equal(summary.linked, 1); assert.equal(summary.missing, 1); assert.equal(summary.noToken, 1);
  assert.equal(summary.mismatch, 2); assert.equal(summary.disabled, 1); assert.equal(summary.addable, 2);
  // 토큰 값은 어떤 행에도 없다
  const j = JSON.stringify({ rows, orphans });
  for (const t of ['tok-az', 'tok-gm1', 'tok-hd', 'mine', 'central-side']) assert.equal(j.includes(t), false, `${t} 유출`);
});

test('collectorSync.diffTargets: URL 매칭이 id 매칭보다 우선 / redact 된 목록(hasCollectorToken)도 인식', async () => {
  const { diffTargets } = await import('../src/agent/collectorSync.js');
  // 이름은 'az' 인데 URL 은 다른 수집 서버가 이미 그 URL 을 쓰고 있다 → URL 로 먼저 붙는다
  const { rows } = diffTargets(
    [{ id: 't', host: '10.1.1.1', portalPort: 4000, agentName: 'AZ', collectorToken: 'k' }],
    [{ id: 'other', url: 'http://10.1.1.1:4000', token: 'k' }, { id: 'az', url: 'http://10.2.2.2:4000', token: 'k' }],
  );
  assert.equal(rows[0].collectorId, 'other'); assert.equal(rows[0].status, 'linked');
  // listTargets() 의 redact 결과(hasCollectorToken 없음 → collectorToken 도 없음)
  const red = diffTargets([{ id: 't', host: '10.3.3.3', portalPort: 4000, agentName: 'X', hasCollectorToken: true }], []);
  assert.equal(red.rows[0].hasToken, true); assert.equal(red.rows[0].status, 'missing');
});

test('collectorSync.tokenOk: forceCollectorToken 의 셸 화이트리스트와 같은 집합', async () => {
  const { tokenOk } = await import('../src/agent/collectorSync.js');
  assert.equal(tokenOk('abcd1234'), true);
  assert.equal(tokenOk('a._~+/=-B9'), true);
  assert.equal(tokenOk("a'b"), false); assert.equal(tokenOk('a;b'), false); assert.equal(tokenOk('a b'), false);
  assert.equal(tokenOk('abc'), false, '4자 미만 거부');
});

test('routes: 대상 저장이 수집 서버로 자동 등록(토큰 자동 생성) / 대조 / 일괄 추가', async () => {
  const express = (await import('express')).default;
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const reg = await import('../src/collector/registry.js');
  const app = express(); app.use(express.json({ limit: '2mb' }));
  const r = express.Router(); registerDeployLlm(r); app.use('/api/admin', r);
  const srv = app.listen(0); await new Promise((x) => srv.once('listening', x));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    // ① 토큰을 주고 저장 → 그 자리에서 수집 서버 등록
    let j = await (await post('/agent-deploy/targets', {
      host: '10.50.0.1', port: 22, username: 'root', agentName: 'AZ', collectorDatacenter: 'AZ',
      portalPort: 4000, collectorToken: 'given-token-1234',
    })).json();
    assert.equal(j.ok, true);
    assert.equal(j.collector?.registered, true, '저장만 해도 수집 서버 등록');
    assert.equal(j.collector.id, 'az'); assert.equal(j.collector.url, 'http://10.50.0.1:4000');
    assert.equal(j.tokenGenerated, false);
    assert.ok(reg.loadCollectors().some((c) => c.id === 'az'));

    // ② 토큰 없이 저장 + autoCollectorToken → 서버가 만들어 등록하고 '엣지 반영 필요'를 알린다
    j = await (await post('/agent-deploy/targets', {
      host: '10.50.0.2', port: 22, username: 'root', agentName: 'GM1', collectorDatacenter: 'GM1',
      portalPort: 4000, autoCollectorToken: true,
    })).json();
    assert.equal(j.collector?.registered, true);
    assert.equal(j.tokenGenerated, true); assert.equal(j.needsEdgeSync, true);
    // 신규 반환 필드(collector)에는 토큰이 없다. ⚠ 기존 `saveTarget` 의 redact 는 password/privateKey 만
    // 지우므로 r.target.collectorToken 은 예전부터 admin 응답에 남는다(v2.339~, 화면 폼이 되돌려 보내는 구조).
    // 여기서는 이번에 추가한 표면만 고정한다 — 기존 동작 변경은 별도 작업(SECRET_KEYS 확장 필요).
    assert.equal(JSON.stringify(j.collector).includes(reg.loadCollectors().find((c) => c.id === 'gm1').token), false, 'collector 응답에 토큰 값 없음');

    // ③ 자동 등록을 끈 대상 → 수집 서버 없음
    j = await (await post('/agent-deploy/targets', {
      host: '10.50.0.3', port: 22, username: 'root', agentName: 'GM2', collectorDatacenter: 'GM2',
      portalPort: 4000, registerCollector: false,
    })).json();
    assert.equal(j.collector, null);

    // ④ 대조 — ③ 만 '추가 가능'
    const sync = await (await fetch(`${base}/agent-deploy/collector-sync`)).json();
    assert.equal(sync.ok, true);
    const gm2 = sync.rows.find((x) => x.agentName === 'GM2');
    assert.equal(gm2.status, 'no-token'); assert.equal(gm2.canAdd, true);
    assert.equal(sync.rows.find((x) => x.agentName === 'AZ').status, 'linked');
    assert.equal(sync.summary.addable, 1);
    assert.equal(JSON.stringify(sync).includes('given-token-1234'), false, '대조 응답에 토큰 값 없음');

    // ⑤ 일괄 추가 — 토큰 생성 + 등록(엣지 반영·검증은 끔: 실제 엣지가 없으므로)
    const add = await (await post('/agent-deploy/collector-sync', { ids: [gm2.id], generateToken: true, syncToEdge: false, verify: false })).json();
    assert.equal(add.ok, true); assert.equal(add.added, 1);
    assert.equal(add.results[0].collectorId, 'gm2'); assert.equal(add.results[0].tokenGenerated, true);
    assert.ok(reg.loadCollectors().some((c) => c.id === 'gm2'));
    assert.equal(JSON.stringify(add).includes(reg.loadCollectors().find((c) => c.id === 'gm2').token), false, '추가 결과에 토큰 값 없음');

    // ⑥ 다시 대조하면 추가 가능 0
    const sync2 = await (await fetch(`${base}/agent-deploy/collector-sync`)).json();
    assert.equal(sync2.summary.addable, 0);
    assert.equal(sync2.rows.find((x) => x.agentName === 'GM2').status, 'linked');

    // ⑦ 잘못된 입력
    assert.equal((await post('/agent-deploy/collector-sync', { ids: [] })).status, 400);
    const nope = await (await post('/agent-deploy/collector-sync', { ids: ['no-such-id'] })).json();
    assert.equal(nope.added, 0); assert.match(nope.results[0].reason, /찾을 수 없습니다/);
  } finally { srv.close(); }
});

/* ── v2.436: URL 중복 감지 · 토큰 정렬(방향) · 진단 · 문구 정정 ─────────────────────────────── */

test('diffTargets: 두 대상이 같은 수집 서버를 가리키면 url-conflict (중계 뒤 IRS 실사용 형태)', async () => {
  const { diffTargets } = await import('../src/agent/collectorSync.js');
  // 실사용: WA(엣지, SSH 22)와 WA-IRS(중계 경유, SSH 4067)의 수집 URL 이 둘 다 host:4000 으로 계산돼 겹친다.
  const targets = [
    { id: 'wa', host: '192.168.40.221', port: 22, portalPort: 4000, agentName: 'WA', collectorToken: 'tok' },
    { id: 'wairs', host: '192.168.40.221', port: 4067, portalPort: 4000, agentName: 'WA-IRS', collectorToken: 'tok2' },
  ];
  const collectors = [{ id: 'wa', url: 'http://192.168.40.221:4000', token: 'tok' }];
  const { rows, summary } = diffTargets(targets, collectors);
  assert.equal(rows[0].status, 'linked', '먼저 온 대상이 수집 서버를 차지');
  assert.equal(rows[1].status, 'url-conflict');
  assert.equal(summary.conflict, 1);
  assert.match(rows[1].issue, /중복 매칭/);
  assert.match(rows[1].fix, /SSH 포트가 4067|광고 URL/, '중계 경유 대상에는 광고 URL 을 안내');
  assert.equal(rows[1].canAdd, false); assert.equal(rows[1].canFix, false, '사람이 주소를 정해야 하므로 자동 조치 대상 아님');
  // 광고 URL 을 지정하면 충돌이 사라진다
  const fixed = diffTargets([targets[0], { ...targets[1], advertiseUrl: 'http://192.168.40.221:4068' }], collectors);
  assert.equal(fixed.rows[1].status, 'missing', '별개 수집 서버가 없으므로 추가 대상');
  assert.equal(fixed.summary.conflict, 0);
});

test('diffTargets: 토큰 불일치·토큰 없음은 canFix(정렬 가능), 문구가 403 을 단정하지 않는다', async () => {
  const { diffTargets, ACTION } = await import('../src/agent/collectorSync.js');
  const targets = [
    { id: 'a', host: '10.1.1.1', portalPort: 4000, agentName: 'A', collectorToken: 'target-side' },
    { id: 'b', host: '10.1.1.2', portalPort: 4000, agentName: 'B' },                                  // 수집 서버는 있는데 대상 토큰 없음
  ];
  const collectors = [
    { id: 'a', url: 'http://10.1.1.1:4000', token: 'central-side' },
    { id: 'b', url: 'http://10.1.1.2:4000', token: 'central-b' },
  ];
  const { rows, summary } = diffTargets(targets, collectors);
  assert.equal(rows[0].status, 'token-mismatch');
  assert.equal(rows[0].canFix, true, 'v2.436: 선택해서 정렬할 수 있어야 한다(예전에는 canAdd=false 로 체크박스조차 없었다)');
  assert.equal(rows[0].action, 'align');
  assert.equal(rows[0].issue.includes('403'), false, '확인하지 않은 403 을 단정하지 않는다');
  assert.match(rows[0].issue, /재배포하면/, '진짜 위험(재배포 시 덮어씀)을 알린다');
  assert.match(rows[0].fix, /진단/);
  assert.equal(rows[1].status, 'no-token'); assert.equal(rows[1].canFix, true); assert.equal(rows[1].canAdd, false);
  assert.equal(summary.fixable, 2);
  assert.ok(ACTION.align && ACTION.add);
});

test('routes: 토큰 정렬 방향 — central-to-target / target-to-central 이 각각 한쪽만 바꾼다', async () => {
  const express = (await import('express')).default;
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const reg = await import('../src/collector/registry.js');
  const dreg = await import('../src/agent/deployRegistry.js');
  const app = express(); app.use(express.json({ limit: '2mb' }));
  const r = express.Router(); registerDeployLlm(r); app.use('/api/admin', r);
  const srv = app.listen(0); await new Promise((x) => srv.once('listening', x));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    // 대상 저장 → 자동 등록(둘 다 'orig') → 중앙 토큰만 바꿔 불일치를 만든다
    const sv = await (await post('/agent-deploy/targets', {
      host: '10.60.1.1', port: 22, username: 'root', agentName: 'DIRA', collectorDatacenter: 'DIRA',
      portalPort: 4000, collectorToken: 'orig-token-1111',
    })).json();
    const id = sv.target.id;
    reg.updateCollector('dira', { ...reg.loadCollectors().find((c) => c.id === 'dira'), token: 'central-token-2222' }, { managed: true });

    let sync = await (await fetch(`${base}/agent-deploy/collector-sync`)).json();
    let row = sync.rows.find((x) => x.agentName === 'DIRA');
    assert.equal(row.status, 'token-mismatch'); assert.equal(row.canFix, true);

    // ① 중앙 → 대상: 배포 대상만 바뀌고 수집 서버는 그대로
    let res = await (await post('/agent-deploy/collector-sync', { ids: [id], tokenDirection: 'central-to-target', verify: false })).json();
    assert.equal(res.added, 1);
    assert.equal(res.results[0].aligned, 'central-to-target');
    assert.equal(dreg.getTargetRaw(id).collectorToken, 'central-token-2222', '대상이 중앙 값을 받는다');
    assert.equal(reg.loadCollectors().find((c) => c.id === 'dira').token, 'central-token-2222', '수집 서버는 불변');
    assert.equal(JSON.stringify(res).includes('central-token-2222'), false, '응답에 토큰 값 없음');
    sync = await (await fetch(`${base}/agent-deploy/collector-sync`)).json();
    assert.equal(sync.rows.find((x) => x.agentName === 'DIRA').status, 'linked', '정렬 후 연결됨');

    // ② 대상 → 중앙: 대상 토큰을 바꾼 뒤 반대 방향
    dreg.saveTarget({ ...dreg.getTargetRaw(id), collectorToken: 'target-token-3333' });
    res = await (await post('/agent-deploy/collector-sync', { ids: [id], tokenDirection: 'target-to-central', verify: false })).json();
    assert.equal(res.results[0].aligned, 'target-to-central');
    assert.equal(reg.loadCollectors().find((c) => c.id === 'dira').token, 'target-token-3333', '수집 서버가 대상 값을 받는다');
    assert.equal(dreg.getTargetRaw(id).collectorToken, 'target-token-3333', '대상은 불변');
  } finally { srv.close(); }
});

test('routes: 진단(probe) — 두 토큰을 실제로 시도하고 권장 방향을 낸다, 토큰 값은 무반환', async () => {
  const express = (await import('express')).default;
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const reg = await import('../src/collector/registry.js');
  const app = express(); app.use(express.json({ limit: '2mb' }));
  const r = express.Router(); registerDeployLlm(r); app.use('/api/admin', r);
  const srv = app.listen(0); await new Promise((x) => srv.once('listening', x));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

  // 가짜 엣지 — '중앙 토큰' 만 받아들인다(가장 흔한 실사용 형태: 토큰 재발급 후 대상 기록만 낡음)
  const edgeApp = express();
  edgeApp.get('/api/collector/export', (req, res) => {
    if (req.get('X-Collector-Token') !== 'edge-live-token') return res.status(403).json({ error: 'forbidden' });
    res.json({ ok: true, hosts: [] });
  });
  const edge = edgeApp.listen(0); await new Promise((x) => edge.once('listening', x));
  const edgePort = edge.address().port;
  try {
    const sv = await (await post('/agent-deploy/targets', {
      host: '127.0.0.1', port: 22, username: 'root', agentName: 'PROBE', collectorDatacenter: 'PROBE',
      portalPort: edgePort, collectorToken: 'stale-target-token',
    })).json();
    const id = sv.target.id;
    reg.updateCollector('probe', { ...reg.loadCollectors().find((c) => c.id === 'probe'), token: 'edge-live-token' }, { managed: true });

    const p = await (await post('/agent-deploy/collector-sync/probe', { ids: [id] })).json();
    assert.equal(p.ok, true);
    const x = p.results[0];
    assert.equal(x.central.ok, true, '중앙 토큰은 통한다');
    assert.equal(x.target.ok, false, '대상 토큰은 403');
    assert.match(x.target.reason, /403/);
    assert.equal(x.recommend, 'central-to-target');
    assert.match(x.why, /배포 대상 기록만 낡았습니다/);
    const j = JSON.stringify(p);
    assert.equal(j.includes('edge-live-token'), false, '진단 응답에 토큰 값 없음');
    assert.equal(j.includes('stale-target-token'), false);
    assert.equal((await post('/agent-deploy/collector-sync/probe', { ids: [] })).status, 400);
  } finally { srv.close(); edge.close(); }
});
