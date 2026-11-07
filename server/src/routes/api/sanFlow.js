// SAN 플로우 모니터(v2.933 SAN·CVP 설계 C-② — 도구 키 san-flow · ‘운영 작업’). Brocade Flow Vision 플로우를 포탈이 만들고 · 지우고 · 카운터를 읽는다.
//   ⚠ 스위치 설정을 바꾸는 도구다 — 모든 라우트는 tools 권한 + admin + 전체 범위(fullScopeOnly), 만들기 · 지우기는 OTP 재인증(reauth)까지.
//   감사 로그는 auditMiddleware 가 남기고 '무엇을 · 어디에' 를 res.locals.auditDetail 로 싣는다. 명령은 sanswitch/flowCmd.js 만 만든다(화면 글자를 잇지 않는다).
//   응답에 스위치 비밀번호 · 관리 주소를 싣지 않는다(등록부 공개 필드 · 이름만).
import { requirePerm, requireRole } from '../../auth/auth.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { reauth } from './reauth.js';
import { store } from '../../store.js';
import { listDevices as listSanDevices, getDeviceWithSecret } from '../../sanswitch/registry.js';
import { localSnapshots as sanLocalSnaps } from '../../sanswitch/store.js';
import { edgeSanSwitchSnapshots } from '../../central/sanSwitchEdge.js';
import { buildFabrics, attributeHost, fabricVisionOf } from '../../sanswitch/attribution.js';
import { normWwn } from '../../sanswitch/zoning.js';
import { flowNameFor, flowLimitOf, buildFlowCommands, FLOW_NAME_RE, PORT_RE, WWN_RE, MONITOR_PER_PORT } from '../../sanswitch/flowCmd.js';
import { startFlowJob, getFlowJob, recentFlowJobs, listFlows, flowChecks, startFlowShowTimer, SHOW_EVERY_MS } from '../../sanswitch/flowJobs.js';
import { isMockMode } from '../../mock/demo/flags.js';
import { ensureSanSwitchDemo } from '../../sanswitch/poller.js';
import { demoSpath } from '../../mock/demo/storpath.js';

const gate = [requirePerm('tools'), requireRole('admin'), fullScopeOnlyWith('SAN 플로우 모니터(스위치 설정 변경)는 전체 범위(vCenter 제한 없는) 관리자만 쓸 수 있습니다.')];

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

/** 바이트 카운터 두 번 → 초당(델타 · 리셋이면 null). */
function rateOf(cur, prev, curAt, prevAt, k) {
  const a = Number(cur?.[k]); const b = Number(prev?.[k]); const dt = (Number(curAt) - Number(prevAt)) / 1000;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(dt > 0) || a < b) return null;
  return Math.round((a - b) / dt);
}

const flowOut = (f) => ({ name: f.name, ingrport: f.ingrport, srcdev: f.srcdev, dstdev: f.dstdev, targetName: f.targetName });

/**
 * 만들기 판정(미리보기 · 만들기 공용 — 판정 코어는 하나). 화면이 보낸 포트 · WWN 을 믿지 않고 귀속 엔진이 찾은
 *   '이 스위치에 로그인한 HBA · zone 안 타깃' 과 맞는 것만 받는다. 포트(ingrport)는 서버가 정한다. 상한(스위치 · 포트당 모니터)을 넘으면 거부.
 * @returns {Promise<{status:number, reason:string} | {dev, h, row, flows, limit, known, onPort, ingr}>}
 */
async function planCreate(b) {
  const dev = getDeviceWithSecret(String(b.deviceId || ''));
  if (!dev) return { status: 404, reason: '스위치를 찾을 수 없습니다.' };
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
  const existing = listFlows().filter((f) => f.deviceId === dev.id && f.state !== 'deleted');
  // 같은 정의(이 스위치 · 이 초기자 → 이 타깃)의 활성 포탈 플로우가 이미 있으면 거부한다 — 이름만 바꿔 같은 플로우를 또 만들었다(화면 판독 v2.933).
  const dup = existing.filter((f) => f.state === 'active' && f.srcdev === row.wwn && want.includes(f.dstdev));
  if (dup.length) return { status: 409, reason: `같은 초기자 → 타깃의 활성 포탈 플로우가 이미 있습니다: ${dup.map((f) => f.name).join(', ')}` };
  const names = new Set(existing.map((f) => f.name));
  const flows = []; let n = 1;
  for (const w of want) {
    let name = flowNameFor(h.name, row.hba, n);
    while (names.has(name) && n < 99) { n += 1; name = flowNameFor(h.name, row.hba, n); }
    if (names.has(name)) return { status: 409, reason: '이 HBA 로 만들 수 있는 플로우 이름(99개)을 다 썼습니다 — 지운 뒤 다시 시도하세요.' };
    names.add(name); n += 1;
    flows.push({ name, ingrport: ingr, srcdev: row.wwn, dstdev: w, hostId: h.id, hostName: h.name, hba: row.hba, targetName: allowed.get(w) || '' });
  }
  const limit = flowLimitOf(self.s.model);
  const known = Math.max(existing.length, Number(flowChecks()[dev.id]?.total) || 0);
  if (known + flows.length > limit) return { status: 409, reason: `플로우 상한(${limit})을 넘습니다 — 지금 ${known}개` };
  const onPort = existing.filter((f) => String(f.ingrport) === ingr).length;
  if (onPort + flows.length > MONITOR_PER_PORT) return { status: 409, reason: `포트 ${ingr} 의 모니터 플로우 상한(${MONITOR_PER_PORT})을 넘습니다 — 포탈 플로우 ${onPort}개` };
  return { dev, h, row, flows, limit, known, onPort, ingr };
}

export function registerSanFlow(api) {
  startFlowShowTimer((id) => getDeviceWithSecret(id));

  api.get('/tools/san-flow', ...gate, async (_req, res) => {
    const rows = await devicesWithSnap();
    const checks = flowChecks();
    const flows = listFlows();
    const snap = store.get();
    const hostById = new Map((snap.hosts || []).map((h) => [h.id, h]));
    // 목 모드에는 vCenter 실시간 통계가 없다 — 호스트 SAN 묶음과 같이 데모 조닝으로 만든 경로 실측(demoSpath)을 쓴다(가상값).
    const demoFabrics = isMockMode() && flows.length ? buildFabrics(rows.filter((x) => x.s).map((x) => ({ ...x.s, name: x.d.name || x.s.name, datacenterId: x.d.datacenterId || '' }))) : null;
    const spathOf = (h) => (!h ? null : demoFabrics ? demoSpath(h, demoFabrics) : (h.spath || null));
    const devices = rows.map(({ d, s }) => {
      const mine = flows.filter((f) => f.deviceId === d.id && f.state !== 'deleted');
      return { id: d.id, name: d.name || d.id, type: d.type, datacenterId: d.datacenterId || '', agent: d.agent || '', collectMethod: d.collectMethod || 'ssh',
        model: s?.model || '', fv: s ? fabricVisionOf(s) : { state: 'unknown', reason: '스냅샷 없음' }, limit: flowLimitOf(s?.model),
        check: checks[d.id] || null, portalFlows: mine.length, collectedAt: s?.collectedAt || null };
    });
    const out = flows.map((f) => {
      const h = f.hostId ? hostById.get(f.hostId) : null;
      // ESXi 경로 실측(C-①)과 같은 타깃의 지금 속도 — 교차검증 참고(시점이 달라 비율만 본다).
      const sp = spathOf(h);
      const t = sp?.targets?.find((x) => x.wwn === f.dstdev && (!f.hba || x.adapter === f.hba)) || null;
      return { ...f, rxBps: rateOf(f.counters, f.prevCounters, f.lastAt, f.prevAt, 'rxBytes'), txBps: rateOf(f.counters, f.prevCounters, f.lastAt, f.prevAt, 'txBytes'),
        esxiBps: t && (Number.isFinite(t.rKBps) || Number.isFinite(t.wKBps)) ? Math.round(((t.rKBps || 0) + (t.wKBps || 0)) * 1024) : null, esxiAt: t ? (sp.at ?? null) : null };
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, devices, flows: out, jobs: recentFlowJobs(10), showEveryMs: SHOW_EVERY_MS });
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

  /** 계정 권한 점검 — `flow --show`(읽기만). 라이선스 · rbash 막힘 · 개수. OTP 없이(설정을 바꾸지 않는다). */
  api.post('/tools/san-flow/check', ...gate, async (req, res) => {
    const dev = getDeviceWithSecret(String(req.body?.deviceId || ''));
    if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    const r = startFlowJob({ device: dev, action: 'check', user: req.user?.username || '' });
    if (r.issue) return res.status(409).json({ ok: false, reason: r.issue });
    res.locals.auditDetail = `SAN 플로우 계정 점검 · ${dev.name || dev.id}`;
    res.json({ ok: true, id: r.id, target: r.target });
  });

  /** 미리보기 — 만들기와 같은 판정(planCreate) · 같은 명령 조립(buildFlowCommands). 스위치를 건드리지 않는다(OTP 없이). */
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
    const r = startFlowJob({ device: p.dev, action: 'create', flows: p.flows, user: req.user?.username || '' });
    if (r.issue) return res.status(409).json({ ok: false, reason: r.issue });
    res.locals.auditDetail = `SAN 플로우 만들기 · ${p.dev.name || p.dev.id} · ${p.flows.map((f) => f.name).join(', ')} · ${p.h.name} ${p.row.hba}`;
    res.json({ ok: true, id: r.id, target: r.target, flows: p.flows.map(flowOut) });
  });

  /** 지우기 — 포탈이 만든(dvc_) 플로우만. OTP 재인증. */
  api.post('/tools/san-flow/delete', ...gate, reauth, async (req, res) => {
    const dev = getDeviceWithSecret(String(req.body?.deviceId || ''));
    const name = String(req.body?.name || '');
    if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    if (!FLOW_NAME_RE.test(name)) return res.status(400).json({ ok: false, reason: '포탈이 만든(dvc_) 플로우만 지울 수 있습니다.' });
    const f = listFlows().find((x) => x.deviceId === dev.id && x.name === name);
    if (!f) return res.status(404).json({ ok: false, reason: '포탈 플로우 기록에 없는 플로우입니다.' });
    const r = startFlowJob({ device: dev, action: 'delete', flows: [{ name }], user: req.user?.username || '' });
    if (r.issue) return res.status(409).json({ ok: false, reason: r.issue });
    res.locals.auditDetail = `SAN 플로우 지우기 · ${dev.name || dev.id} · ${name}`;
    res.json({ ok: true, id: r.id, target: r.target });
  });

  /** 카운터 지금 읽기 — 그 스위치의 활성 포탈 플로우(15분 주기와 같은 작업). */
  api.post('/tools/san-flow/show', ...gate, async (req, res) => {
    const dev = getDeviceWithSecret(String(req.body?.deviceId || ''));
    if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    const flows = listFlows().filter((f) => f.deviceId === dev.id && f.state === 'active').slice(0, 16);
    if (!flows.length) return res.status(409).json({ ok: false, reason: '이 스위치에 활성 포탈 플로우가 없습니다.' });
    const r = startFlowJob({ device: dev, action: 'show', flows, user: req.user?.username || '' });
    if (r.issue) return res.status(409).json({ ok: false, reason: r.issue });
    res.locals.auditDetail = `SAN 플로우 카운터 읽기 · ${dev.name || dev.id}`;
    res.json({ ok: true, id: r.id, target: r.target });
  });

  api.get('/tools/san-flow/job/:id', ...gate, (req, res) => {
    const j = getFlowJob(req.params.id);
    if (!j) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다(만료 30분).' });
    res.set('Cache-Control', 'no-store').json({ ok: true, job: j });
  });
}
