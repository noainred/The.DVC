// SAN 플로우 모니터(v2.934 SAN·CVP 설계 C-② — 도구 키 san-flow · ‘운영 작업’). Brocade Flow Vision 플로우를 포탈이 만들고 · 지우고 · 카운터를 읽는다.
//   ⚠ 스위치 설정을 바꾸는 도구다 — 모든 라우트는 tools 권한 + admin + 조회 · 쓰기 전체 범위(반증 L-1 — isFullReadWriteScope), 만들기 · 지우기는 OTP 재인증(reauth)까지.
//   감사 로그는 auditMiddleware 가 남기고 '무엇을 · 어디에' 를 res.locals.auditDetail 로 싣는다(미리보기는 AUDIT_SKIP — 저장 아님). 명령은 sanswitch/flowCmd.js 만 만든다.
//   응답에 스위치 비밀번호 · 관리 주소를 싣지 않는다 — 작업 사유 · 기록 오류의 주소도 가린다(반증 L-4 — cvp.maskErrText · 등록 스위치 주소 포함).
import { requirePerm, requireRole } from '../../auth/auth.js';
import { fullReadWriteScopeOnlyWith } from '../admin/shared.js';
import { reauth } from './reauth.js';
import { maskErrText } from './cvp.js';
import { store } from '../../store.js';
import { listDevices as listSanDevices, getDeviceWithSecret } from '../../sanswitch/registry.js';
import { localSnapshots as sanLocalSnaps } from '../../sanswitch/store.js';
import { edgeSanSwitchSnapshots } from '../../central/sanSwitchEdge.js';
import { edgeVersionOf } from '../../central/idracScanPush.js';
import { buildFabrics, attributeHost, fabricVisionOf } from '../../sanswitch/attribution.js';
import { normWwn } from '../../sanswitch/zoning.js';
import { flowNameFor, flowLimitOf, buildFlowCommands, FLOW_NAME_RE, PORT_RE, WWN_RE, MONITOR_PER_PORT } from '../../sanswitch/flowCmd.js';
import { startFlowJob, getFlowJob, recentFlowJobs, listFlows, flowChecks, startFlowShowTimer, lastShowCycle, forgetFlow, SHOW_EVERY_MS, EDGE_DEADLINE_MS } from '../../sanswitch/flowJobs.js';
import { isMockMode } from '../../mock/demo/flags.js';
import { ensureSanSwitchDemo } from '../../sanswitch/poller.js';
import { demoSpath } from '../../mock/demo/storpath.js';
import { numOrNull } from '../../util/numOrNull.js';
import { cmpVersion } from '../../util/cmpVersion.js';

const gate = [requirePerm('tools'), requireRole('admin'), fullReadWriteScopeOnlyWith('SAN 플로우 모니터(스위치 설정 변경)는 조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 관리자만 쓸 수 있습니다.')];
/** 엣지가 flowNow 를 아는 첫 버전(반증 M-7 — 구버전 엣지는 작업을 모른 채 버린다). */
export const MIN_FLOW_EDGE_VERSION = '2.934.0';
/** 엣지 위임 전 확인 — 버전을 알고 낮으면 거부, 모르면(중앙 재시작 직후 등) 보낸다(시한이 지나면 '결과 모름'). */
export function flowEdgeIssue(agent, version = edgeVersionOf(agent)) {
  const v = String(version || '').trim();
  if (v && cmpVersion(v, MIN_FLOW_EDGE_VERSION) < 0) return `엣지 "${agent}" 의 버전(${v})은 플로우 작업을 모릅니다 — ${MIN_FLOW_EDGE_VERSION} 이상으로 올린 뒤 하세요`;
  return null;
}

/** 등록부 장치(비밀 없음) + 최신 스냅샷(모델 · 라이선스). */
async function devicesWithSnap() {
  if (isMockMode()) { try { await ensureSanSwitchDemo(); } catch { /* 데모 시드 실패는 빈 목록 */ } }
  const reg = listSanDevices().filter((d) => d.enabled !== false);
  const snapOf = new Map();
  for (const s of [...sanLocalSnaps(), ...edgeSanSwitchSnapshots()]) {
    if (!s?.deviceId) continue;
    const cur = snapOf.get(s.deviceId);
    if (!cur || (s.collectedAt || 0) > (cur.collectedAt || 0)) snapOf.set(s.deviceId, s);
  }
  return reg.map((d) => ({ d, s: snapOf.get(d.id) || null }));
}

/** 바이트 카운터 두 번 → 초당(델타). 하나라도 못 읽었거나(null — 0 이 아니다) 리셋이면 null(반증 M-4). */
export function rateOf(cur, prev, curAt, prevAt, k) {
  const a = numOrNull(cur?.[k]); const b = numOrNull(prev?.[k]); const t1 = numOrNull(curAt); const t0 = numOrNull(prevAt);
  if (a == null || b == null || t1 == null || t0 == null) return null;
  const dt = (t1 - t0) / 1000;
  if (!(dt > 0) || a < b) return null;
  return Math.round((a - b) / dt);
}
/** ESXi 경로 실측 — 읽기 · 쓰기가 **둘 다** 있을 때만 합(한쪽만 있으면 부분 합 — 비교하지 않는다, 반증 M-5). */
export function esxiBpsOf(t) {
  const r = numOrNull(t?.rKBps); const w = numOrNull(t?.wKBps);
  return r == null || w == null ? null : Math.round((r + w) * 1024);
}

const flowOut = (f) => ({ name: f.name, ingrport: f.ingrport, srcdev: f.srcdev, dstdev: f.dstdev, targetName: f.targetName });
/** 아직 장비에 있을 수 있는 기록(지움 · 실패 말고) — 중복 · 이름 · 상한 계산에 쓴다. */
const LIVE_STATES = new Set(['pending', 'active', 'unknown', 'conflict', 'gone']);

/**
 * 만들기 판정(미리보기 · 만들기 공용 — 판정 코어는 하나). 화면이 보낸 포트 · WWN 을 믿지 않고 귀속 엔진이 찾은
 *   '이 스위치에 로그인한 HBA · zone 안 타깃' 과 맞는 것만 받는다. 포트(ingrport)는 서버가 정한다. 상한(스위치 · 포트당 모니터)을 넘으면 거부.
 *   권한 점검(flow --show)을 통과한 스위치만(반증 L-2 — 화면 문구가 말한 규칙을 서버도 지킨다).
 * @returns {Promise<{status:number, reason:string} | {dev, h, row, flows, limit, known, onPort, ingr}>}
 */
/** 스위치의 플로우 개수(추정) — 점검 때 장비가 센 개수 + 그 뒤에 포탈이 만든 것, 포탈 기록 수보다 작지 않게(반증 L-3). 점검 전이면 포탈 기록 수. */
export function flowCountOf(live, check) {
  const madeAfter = live.filter((f) => Number(f.createdAt || 0) > Number(check?.at || 0)).length;
  return Math.max(live.length, (numOrNull(check?.total) ?? 0) + (check ? madeAfter : 0));
}

async function planCreate(b) {
  const dev = getDeviceWithSecret(String(b.deviceId || ''));
  if (!dev) return { status: 404, reason: '스위치를 찾을 수 없습니다.' };
  const check = flowChecks()[dev.id];
  if (!check?.ok) return { status: 409, reason: '먼저 계정 권한 점검(flow --show — 읽기만)을 통과해야 만들 수 있습니다.' };
  const snap = store.get();
  const h = (snap.hosts || []).find((x) => x.id === String(b.hostId || ''));
  if (!h) return { status: 404, reason: '호스트를 찾을 수 없습니다.' };
  const rows = await devicesWithSnap();
  const self = rows.find((x) => x.d.id === dev.id);
  if (!self?.s) return { status: 409, reason: '이 스위치의 수집 스냅샷이 없어 포트 · zone 을 확인할 수 없습니다.' };
  if (fabricVisionOf(self.s).state === 'no') return { status: 409, reason: '이 스위치에 Fabric Vision 라이선스가 없습니다(스냅샷 라이선스 목록 기준).' };
  const fabrics = buildFabrics(rows.filter((x) => x.s).map((x) => ({ ...x.s, name: x.d.name || x.s.name, datacenterId: x.d.datacenterId || '' })));
  const row = attributeHost(h, fabrics, {}).hbas.find((x) => x.hba === String(b.hba || '') && x.status === 'logged-in' && x.switch?.deviceId === dev.id && x.port);
  if (!row) return { status: 409, reason: '그 HBA 가 이 스위치에 로그인해 있지 않습니다(수집 스냅샷 기준).' };
  const allowed = new Map();
  for (const t of row.targets) for (const w of t.wwns) allowed.set(w, t.name);
  const want = [...new Set((Array.isArray(b.targets) ? b.targets : []).map((w) => String(w || '').toLowerCase()))].slice(0, 8);
  if (!want.length || want.some((w) => !WWN_RE.test(w) || !allowed.has(w))) return { status: 400, reason: '타깃은 그 HBA 의 zone 안에 있는 WWN 만 고를 수 있습니다(1~8개).' };
  const ingr = row.port.slotPort && PORT_RE.test(String(row.port.slotPort)) ? String(row.port.slotPort) : String(row.port.index);
  if (!PORT_RE.test(ingr)) return { status: 409, reason: '스위치 포트 번호를 읽지 못했습니다.' };
  const existing = listFlows().filter((f) => f.deviceId === dev.id && LIVE_STATES.has(f.state));
  // 같은 정의(이 스위치 · 이 초기자 → 이 타깃)의 기록이 장비에 있을 수 있으면 거부한다(활성 · 만드는 중 · 결과 모름 · 충돌 — 반증 M-3).
  const dup = existing.filter((f) => f.srcdev === row.wwn && want.includes(f.dstdev));
  if (dup.length) return { status: 409, reason: `같은 초기자 → 타깃의 포탈 플로우가 이미 있습니다: ${dup.map((f) => `${f.name}(${f.state})`).join(', ')}` };
  const names = new Set([...existing.map((f) => f.name), ...(Array.isArray(check.orphans) ? check.orphans : [])]);
  const flows = []; let n = 1;
  for (const w of want) {
    let name = flowNameFor(h.id, h.name, row.hba, n);
    while (names.has(name) && n < 99) { n += 1; name = flowNameFor(h.id, h.name, row.hba, n); }
    if (names.has(name)) return { status: 409, reason: `이 호스트 · ${row.hba} 로 만들 수 있는 플로우 이름(99개)을 다 썼습니다 — 지운 뒤 다시 시도하세요.` };
    names.add(name); n += 1;
    flows.push({ name, ingrport: ingr, srcdev: row.wwn, dstdev: w, hostId: h.id, hostName: h.name, hba: row.hba, targetName: allowed.get(w) || '' });
  }
  const limit = flowLimitOf(self.s.model);
  // 반증 L-3: 점검 때 장비가 센 개수 + 그 뒤에 포탈이 만든 것 — 둘 중 큰 쪽만 보면 사람이 만든 것이 많을 때 적게 셌다.
  const known = flowCountOf(existing, check);
  if (known + flows.length > limit) return { status: 409, reason: `플로우 상한(${limit})을 넘습니다 — 지금 ${known}개(권한 점검 때 장비가 센 개수 + 그 뒤에 만든 것)` };
  const onPort = existing.filter((f) => String(f.ingrport) === ingr).length;
  if (onPort + flows.length > MONITOR_PER_PORT) return { status: 409, reason: `포트 ${ingr} 의 모니터 플로우 상한(${MONITOR_PER_PORT})을 넘습니다 — 포탈 플로우 ${onPort}개` };
  return { dev, h, row, flows, limit, known, onPort, ingr };
}

/** 엣지 위임 스위치의 인증 정지 — 엣지가 스냅샷 extra.authStopped 로 올린다(그 엣지의 정지 기록 · 반증 H-2). */
export function edgeAuthStopOf(deviceId) {
  try { return edgeSanSwitchSnapshots().find((s) => s?.deviceId === deviceId)?.extra?.authStopped || null; } catch { return null; }
}

/** 비밀이 아닌 관리 주소도 응답에서 가린다(반증 L-4) — 등록 스위치 주소 + URL · IPv4 · IPv6. */
function maskerOf() {
  const hosts = listSanDevices().map((d) => d.host).filter(Boolean);
  return (v) => (v == null ? v : maskErrText(String(v), hosts));
}
function maskJob(j, mask) {
  if (!j) return j;
  return { ...j, trace: (j.trace || []).map((t) => ({ ...t, msg: mask(t.msg) })),
    result: j.result ? { ...j.result, ...(j.result.reason ? { reason: mask(j.result.reason) } : {}), outputs: (j.result.outputs || []).map((o) => ({ ...o, out: mask(o.out) })) } : null };
}

export function registerSanFlow(api) {
  startFlowShowTimer((id) => getDeviceWithSecret(id), { canDelegate: (agent) => flowEdgeIssue(agent), stoppedOf: edgeAuthStopOf });

  api.get('/tools/san-flow', ...gate, async (_req, res) => {
    const rows = await devicesWithSnap();
    const checks = flowChecks();
    const flows = listFlows();
    const mask = maskerOf();
    const snap = store.get();
    const hostById = new Map((snap.hosts || []).map((h) => [h.id, h]));
    // 목 모드에는 vCenter 실시간 통계가 없다 — 호스트 SAN 묶음과 같이 데모 조닝으로 만든 경로 실측(demoSpath)을 쓴다(가상값).
    const demoFabrics = isMockMode() && flows.length ? buildFabrics(rows.filter((x) => x.s).map((x) => ({ ...x.s, name: x.d.name || x.s.name, datacenterId: x.d.datacenterId || '' }))) : null;
    const spathOf = (h) => (!h ? null : demoFabrics ? demoSpath(h, demoFabrics) : (h.spath || null));
    const known = new Set(listSanDevices().map((d) => d.id));
    const devices = rows.map(({ d, s }) => {
      const mine = flows.filter((f) => f.deviceId === d.id);
      const ck = checks[d.id] || null;
      const live = mine.filter((f) => LIVE_STATES.has(f.state));
      return { id: d.id, name: d.name || d.id, type: d.type, datacenterId: d.datacenterId || '', agent: d.agent || '', collectMethod: d.collectMethod || 'ssh',
        model: s?.model || '', fv: s ? fabricVisionOf(s) : { state: 'unknown', reason: '스냅샷 없음' }, limit: flowLimitOf(s?.model),
        check: ck ? { ...ck, text: mask(ck.text) } : null, portalFlows: mine.length, collectedAt: s?.collectedAt || null,
        flowCount: flowCountOf(live, ck),   // 상한 판정(planCreate)과 같은 개수 — 점검 때 장비가 센 것 + 그 뒤 만든 것
        ...(d.agent ? { edgeIssue: flowEdgeIssue(d.agent) } : {}) };
    });
    const out = flows.map((f) => {
      const h = f.hostId ? hostById.get(f.hostId) : null;
      // ESXi 경로 실측(C-①)과 같은 타깃의 지금 속도 — 교차검증 참고(시점이 달라 비율만 본다).
      const sp = spathOf(h);
      const t = sp?.targets?.find((x) => x.wwn === f.dstdev && (!f.hba || x.adapter === f.hba)) || null;
      return { ...f, lastError: mask(f.lastError), deviceKnown: known.has(f.deviceId),
        rxBps: rateOf(f.counters, f.prevCounters, f.lastAt, f.prevAt, 'rxBytes'), txBps: rateOf(f.counters, f.prevCounters, f.lastAt, f.prevAt, 'txBytes'),
        esxiBps: esxiBpsOf(t), esxiAt: t ? (sp.at ?? null) : null };
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, devices, flows: out, jobs: recentFlowJobs(10).map((j) => maskJob(j, mask)), showEveryMs: SHOW_EVERY_MS,
      edgeDeadlineMs: EDGE_DEADLINE_MS, showCycle: lastShowCycle() });
  });

  /** 만들기 폼 ① — 이 스위치에 HBA 가 로그인한 호스트(스냅샷 포트의 연결 WWN 기준 · 최대 300). */
  api.get('/tools/san-flow/hosts', ...gate, async (req, res) => {
    const id = String(req.query.deviceId || '');
    const rows = await devicesWithSnap();
    const self = rows.find((x) => x.d.id === id);
    if (!self) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    if (!self.s) return res.json({ ok: true, hosts: [], reason: '이 스위치의 수집 스냅샷이 아직 없습니다.' });
    const [fab] = buildFabrics([{ ...self.s, name: self.d.name || self.s.name, datacenterId: self.d.datacenterId || '' }]);
    const snap = store.get();
    const hosts = [];
    for (const h of snap.hosts || []) {
      const on = (Array.isArray(h.hbas) ? h.hbas : []).filter((a) => fab?.portByWwn.has(normWwn(a?.wwn)));
      if (on.length) hosts.push({ id: h.id, name: h.name, vcenterId: h.vcenterId, hbas: on.map((a) => String(a.name || '')).slice(0, 8) });
      if (hosts.length >= 300) break;
    }
    hosts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.set('Cache-Control', 'no-store').json({ ok: true, hosts });
  });

  /** 만들기 폼 ② — 호스트의 HBA 가 로그인한 스위치 · 포트와 zone 안 타깃(귀속 엔진 판정 그대로). */
  api.get('/tools/san-flow/candidates', ...gate, async (req, res) => {
    const snap = store.get();
    const h = (snap.hosts || []).find((x) => x.id === String(req.query.hostId || ''));
    if (!h) return res.status(404).json({ ok: false, reason: '호스트를 찾을 수 없습니다.' });
    const rows = await devicesWithSnap();
    const fabrics = buildFabrics(rows.filter((x) => x.s).map((x) => ({ ...x.s, name: x.d.name || x.s.name, datacenterId: x.d.datacenterId || '' })));
    const r = attributeHost(h, fabrics, {});
    const fvOf = new Map(rows.map(({ d, s }) => [d.id, s ? fabricVisionOf(s) : { state: 'unknown' }]));
    const hbas = r.hbas.filter((x) => x.status === 'logged-in' && x.port && x.wwn).map((x) => ({
      hba: x.hba, wwn: x.wwn, deviceId: x.switch.deviceId, switchName: x.switch.name, port: { index: x.port.index, slotPort: x.port.slotPort ?? null },
      fv: fvOf.get(x.switch.deviceId) || { state: 'unknown' },
      targets: x.targets.map((t) => ({ name: t.name, kind: t.kind, wwns: t.wwns.filter((w) => WWN_RE.test(w)).slice(0, 8) })).filter((t) => t.wwns.length).slice(0, 16),
    }));
    res.set('Cache-Control', 'no-store').json({ ok: true, host: { id: h.id, name: h.name }, hbas });
  });

  const start = (req, dev, action, flows = []) => startFlowJob({ device: dev, action, flows, user: req.user?.username || '', canDelegate: (agent) => flowEdgeIssue(agent) });

  /** 계정 권한 점검 — `flow --show`(읽기만). 라이선스 · rbash 막힘 · 개수 · 기록 없는 dvc_ 플로우. OTP 없이(설정을 바꾸지 않는다). */
  api.post('/tools/san-flow/check', ...gate, async (req, res) => {
    const dev = getDeviceWithSecret(String(req.body?.deviceId || ''));
    if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    const r = start(req, dev, 'check');
    if (r.issue) return res.status(409).json({ ok: false, reason: r.issue });
    res.locals.auditDetail = `SAN 플로우 계정 점검 · ${dev.name || dev.id}`;
    res.json({ ok: true, id: r.id, target: r.target });
  });

  /** 미리보기 — 만들기와 같은 판정(planCreate) · 같은 명령 조립(buildFlowCommands). 스위치를 건드리지 않는다(OTP 없이 · 감사 줄 없음). */
  api.post('/tools/san-flow/preview', ...gate, async (req, res) => {
    const p = await planCreate(req.body || {});
    if (p.status) return res.status(p.status).json({ ok: false, reason: p.reason });
    const built = buildFlowCommands('create', p.flows);
    if (built.issue) return res.status(400).json({ ok: false, reason: built.issue });
    res.set('Cache-Control', 'no-store').json({ ok: true, flows: p.flows.map(flowOut), cmds: built.cmds, limit: p.limit, known: p.known, onPort: p.onPort, perPort: MONITOR_PER_PORT, ingrport: p.ingr });
  });

  /** 만들기 — 호스트 HBA 하나 · 그 zone 안 타깃 1~8개 → 타깃마다 모니터 플로우 하나. OTP 재인증. */
  api.post('/tools/san-flow/create', ...gate, reauth, async (req, res) => {
    const p = await planCreate(req.body || {});
    if (p.status) return res.status(p.status).json({ ok: false, reason: p.reason });
    const r = start(req, p.dev, 'create', p.flows);
    if (r.issue) return res.status(409).json({ ok: false, reason: r.issue });
    res.locals.auditDetail = `SAN 플로우 만들기 · ${p.dev.name || p.dev.id} · ${p.flows.map((f) => f.name).join(', ')} · ${p.h.name} ${p.row.hba}`;
    res.json({ ok: true, id: r.id, target: r.target, flows: p.flows.map(flowOut) });
  });

  /**
   * 지우기 — 포탈이 만든(dvc_) 플로우만: 포탈 기록에 있는 것, 또는 권한 점검이 장비에서 찾았는데 기록이 없는 dvc_ 플로우(반증 M-2 — 재시작 · 시한으로
   *   기록을 놓친 것). OTP 재인증.
   */
  api.post('/tools/san-flow/delete', ...gate, reauth, async (req, res) => {
    const dev = getDeviceWithSecret(String(req.body?.deviceId || ''));
    const name = String(req.body?.name || '');
    if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    if (!FLOW_NAME_RE.test(name)) return res.status(400).json({ ok: false, reason: '포탈이 만든(dvc_) 플로우만 지울 수 있습니다.' });
    const f = listFlows().find((x) => x.deviceId === dev.id && x.name === name);
    const orphan = !f && (flowChecks()[dev.id]?.orphans || []).includes(name);
    if (!f && !orphan) return res.status(404).json({ ok: false, reason: '포탈 플로우 기록에도, 마지막 권한 점검 결과에도 없는 플로우입니다.' });
    const r = start(req, dev, 'delete', [{ name }]);
    if (r.issue) return res.status(409).json({ ok: false, reason: r.issue });
    res.locals.auditDetail = `SAN 플로우 지우기 · ${dev.name || dev.id} · ${name}${orphan ? '(포탈 기록 없음)' : ''}`;
    res.json({ ok: true, id: r.id, target: r.target });
  });

  /** 기록 정리 — 등록부에서 지운 스위치의 플로우 기록만(장비에 명령을 보내지 않는다 — 반증 L-11). OTP 재인증. */
  api.post('/tools/san-flow/forget', ...gate, reauth, async (req, res) => {
    const deviceId = String(req.body?.deviceId || ''); const name = String(req.body?.name || '');
    if (getDeviceWithSecret(deviceId)) return res.status(409).json({ ok: false, reason: '스위치가 등록부에 있습니다 — 지우기로 장비에서 지우세요.' });
    if (!FLOW_NAME_RE.test(name) || !forgetFlow(deviceId, name, req.user?.username || '')) return res.status(404).json({ ok: false, reason: '정리할 기록이 없습니다.' });
    res.locals.auditDetail = `SAN 플로우 기록 정리(등록부에 없는 스위치) · ${deviceId} · ${name}`;
    res.json({ ok: true });
  });

  /** 카운터 지금 읽기 — 그 스위치의 활성 · 결과 모름 포탈 플로우(주기와 같은 작업). */
  api.post('/tools/san-flow/show', ...gate, async (req, res) => {
    const dev = getDeviceWithSecret(String(req.body?.deviceId || ''));
    if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    const flows = listFlows().filter((f) => f.deviceId === dev.id && (f.state === 'active' || f.state === 'unknown' || f.state === 'gone')).slice(0, 16);
    if (!flows.length) return res.status(409).json({ ok: false, reason: '이 스위치에 읽을 포탈 플로우가 없습니다.' });
    const r = start(req, dev, 'show', flows);
    if (r.issue) return res.status(409).json({ ok: false, reason: r.issue });
    res.locals.auditDetail = `SAN 플로우 카운터 읽기 · ${dev.name || dev.id}`;
    res.json({ ok: true, id: r.id, target: r.target });
  });

  api.get('/tools/san-flow/job/:id', ...gate, (req, res) => {
    const j = getFlowJob(req.params.id);
    if (!j) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다(끝나고 1시간 뒤 정리).' });
    res.set('Cache-Control', 'no-store').json({ ok: true, job: maskJob(j, maskerOf()) });
  });
}
