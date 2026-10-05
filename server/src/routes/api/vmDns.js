/**
 * routes/api/vmDns.js — 특수 기능 'VM DNS 설정 확인'(도구 키 `vm-dns`, v2.696) API.
 *
 * 판정은 `vmdns/analyze.js`(순수) 하나가 하고, 여기는 입력만 모은다(스냅샷·정책·IP 대장 분류기·점검 결과·이력 DB).
 * vCenter·게스트 왕복은 0 이다(도달성 점검 POST 만 네트워크로 나간다 — DNS 서버 53 포트).
 *
 * 권한
 *  · 조회: `requirePerm('tools')` + toolGate 매핑(`'vm-dns'`) + **vCenter 범위**(허용 vCenter 의 VM 만 센다 — 범위 밖 소유 VM·호스트
 *    이름은 가린다). IP 대장의 스캔 정보(`ledger`)는 전체 범위 계정에만 싣는다(스캔 행은 vCenter 귀속이 아니다 — v2.638 규약).
 *  · 정책 저장·도달성 점검: adminOnly + 전체 범위(정책은 전 법인 공통 파일이고, 점검은 전 법인 DNS 서버로 나간다). 감사 로그.
 *  · CSV: `requirePerm('data.csv')`(v2.643) + tools + 범위. 감사 로그.
 * 화면은 폴링하지 않는다(마운트 1회 + 새로고침).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { memoJson, scopeKey } from './shared.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { pageArgs } from '../../util/pageArgs.js';
import { numOrNull } from '../../util/numOrNull.js';
import { capStr } from '../../util/capStr.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { isMockVcenter } from '../../mock/generator.js';
import { getClassifier } from '../../ipam/settings.js';
import { getScanResults, scanRev } from '../../ipam/scanStore.js';
import { getOverride, overridesRev } from '../../ipam/overrides.js';
import { analyzeVmDns, serverDetail, vmDetail, csvRows, probeTargets, canonAddr, buildDnsIndex } from '../../vmdns/analyze.js';
import { loadVmDnsPolicy, saveVmDnsPolicy } from '../../vmdns/policy.js';
import { runVmDnsProbe, probeResultOf, vmDnsProbeState, probeRev } from '../../vmdns/probe.js';
import { listChanges, vmHistory, vmDnsChangeRev } from '../../vmdns/db.js';
import { vmDnsHistoryStatus } from '../../vmdns/poller.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const adminOnly = requireRole('admin');
const fleetOnly = fullScopeOnlyWith('VM DNS 정책 저장·도달성 점검은 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다 — 정책은 전 법인 공통이고, 점검은 전 법인 DNS 서버로 나갑니다.');

const DAY = 86_400_000;
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

/** IP 대장 분류기(공인/사설) — 못 읽으면 null(analyze.js 가 RFC1918 기본으로 폴백한다). */
function classifier() {
  try { const c = getClassifier(); return typeof c === 'function' ? c : null; } catch { return null; }
}

/** IP 대장 정보(전체 범위에만) — 스캔에서 응답했는가 · 53 포트가 열려 있었는가 · 관리 상태의 장비 종류. */
function ledgerOf(ip) {
  let scan = null;
  try { scan = getScanResults()?.[ip] || null; } catch { scan = null; }
  let ov = null;
  try { ov = getOverride(ip); } catch { ov = null; }
  if (!scan && !ov) return null;
  const ports = Array.isArray(scan?.openPorts) ? scan.openPorts : [];
  return {
    scanned: !!scan,
    scanHostname: scan && typeof scan.hostname === 'string' && scan.hostname ? scan.hostname.slice(0, 253) : null,
    scanLastSeen: numOrNull(scan?.lastSeen),
    port53: scan ? ports.includes(53) : null,
    manual: !!ov,
    deviceType: ov && typeof ov.deviceType === 'string' && ov.deviceType ? ov.deviceType : null,
  };
}

/** 판정 입력 묶음(라우트 셋이 같은 입력을 쓴다). */
function inputsOf(req, snap) {
  const allowed = scopedVcenterIds(req.user, snap);
  return {
    snap, allowed, policy: loadVmDnsPolicy(), classify: classifier(),
    ledgerOf: allowed ? null : ledgerOf,
    probeOf: probeResultOf,
  };
}

/*
 * 색인 기억 — VM 5,600대 색인 1회 약 55ms(MOCK_SCALE=3 실측). 스냅샷(약 30초마다 교체)·정책·범위·필터·IP 대장 리비전·분류기가
 * 같으면 화면 API 셋(개요·서버 상세·VM 상세)과 CSV 가 같은 색인을 쓴다. 스냅샷 객체를 WeakMap 키로 두어 교체되면 통째로 버려진다.
 */
const _indexBySnap = new WeakMap();
const _clsId = new WeakMap();
let _clsSeq = 0;
const clsIdOf = (fn) => { if (!fn) return 0; let n = _clsId.get(fn); if (!n) { n = ++_clsSeq; _clsId.set(fn, n); } return n; };
function withIndex(req, snap, vcenterId = '') {
  const inp = inputsOf(req, snap);
  const key = `${inp.policy.rev}|${clsIdOf(inp.classify)}|${scopeKey(req.user, snap)}|${vcenterId}|${inp.ledgerOf ? `${scanRev()}.${overridesRev()}` : '-'}`;
  let m = _indexBySnap.get(snap);
  if (!m) { m = new Map(); _indexBySnap.set(snap, m); }
  let index = m.get(key);
  if (!index) {
    index = buildDnsIndex({ ...inp, vcenterId });
    if (m.size >= 16) m.delete(m.keys().next().value);
    m.set(key, index);
  }
  return { ...inp, vcenterId, index };
}

/** 최근 변경(범위 안) — 화면 '최근 DNS 설정 변경' 7일 · 10건. DB 를 못 열면 available:false. */
async function recentChanges(allowed, vcenterId, vcName) {
  const r = await listChanges({ since: Date.now() - 7 * DAY, limit: 10, vcenterIds: allowed, vcenterId }).catch((e) => ({ available: false, reason: String(e?.message || e).slice(0, 200), changes: [] }));
  return { available: !!r.available, ...(r.available ? {} : { reason: r.reason || '' }),
    recent: (r.changes || []).map((c) => ({ ...c, vcenterName: vcName.get(c.vcenterId) || c.vcenterId })) };
}

export function registerVmDns(api) {
  api.get('/tools/vm-dns', toolsPerm, async (req, res) => {
    const snap = store.get();
    const vcenterId = qStr(req.query.vcenterId, 128);
    const pol = loadVmDnsPolicy();
    const allowed = scopedVcenterIds(req.user, snap);
    // 키: 스냅샷 세대(memoJson) + URL(vcenterId) + 정책 리비전 + 점검 리비전 + 변경 리비전 + IP 대장 리비전(전체 범위만) + 범위.
    const extraKey = `${pol.rev}|${probeRev()}|${vmDnsChangeRev()}|${allowed ? '' : `${scanRev()}.${overridesRev()}`}|${scopeKey(req.user, snap)}`;
    await memoJson(req, res, 'vm-dns', async (s) => {
      const inp = withIndex(req, s, vcenterId);
      const vcName = new Map((s?.vcenters || []).map((v) => [String(v.id), String(v.name || v.id)]));
      const changes = await recentChanges(inp.allowed, vcenterId, vcName);
      const body = analyzeVmDns({ ...inp, changes, probeState: vmDnsProbeState() });
      const hist = vmDnsHistoryStatus();
      body.history = { lastRunAt: hist.lastRunAt, intervalMs: hist.intervalMs, retentionDays: hist.retentionDays, idleReason: hist.idleReason || '' };
      if (pol.invalid?.length) body.policy.invalid = pol.invalid.length;
      return body;
    }, { ttlMs: 12_000, extraKey });
  });

  api.get('/tools/vm-dns/server', toolsPerm, (req, res) => {
    const ip = canonAddr(qStr(req.query.ip, 64));
    if (!ip) return res.status(400).json({ ok: false, reason: 'ip 가 올바른 주소가 아닙니다.' });
    const { limit, offset } = pageArgs(req.query, { def: 500, max: 2000 });
    const snap = store.get();
    const out = serverDetail(withIndex(req, snap, qStr(req.query.vcenterId, 128)), { ip, limit, offset });
    if (!out) return res.status(404).json({ ok: false, reason: '그 주소를 DNS 서버로 쓰는 VM 이 (보이는 범위 안에) 없습니다.' });
    res.json(out);
  });

  api.get('/tools/vm-dns/vm', toolsPerm, async (req, res) => {
    const id = qStr(req.query.id, 256);
    if (!id) return res.status(400).json({ ok: false, reason: 'id 가 필요합니다.' });
    const snap = store.get();
    const vm = vmDetail(withIndex(req, snap, ''), id);
    if (!vm) return res.status(404).json({ ok: false, reason: '그 VM 이 없습니다.' });
    const h = await vmHistory(id, { limit: 100 }).catch((e) => ({ available: false, reason: String(e?.message || e).slice(0, 200), history: [] }));
    res.json({ vm, history: h.history || [], historyAvailable: !!h.available, ...(h.available ? {} : { historyReason: h.reason || '' }) });
  });

  api.get('/tools/vm-dns/changes', toolsPerm, async (req, res) => {
    const days = Math.max(1, Math.min(90, Math.floor(numOrNull(req.query.days) ?? 7)));
    const { limit, offset } = pageArgs(req.query, { def: 200, max: 2000 });
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const since = Date.now() - days * DAY;
    const r = await listChanges({ since, limit, offset, vcenterIds: allowed, vcenterId: qStr(req.query.vcenterId, 128) })
      .catch((e) => ({ available: false, reason: String(e?.message || e).slice(0, 200), changes: [] }));
    const vcName = new Map((snap?.vcenters || []).map((v) => [String(v.id), String(v.name || v.id)]));
    res.json({ available: !!r.available, ...(r.available ? {} : { reason: r.reason || '' }), since, days,
      changes: (r.changes || []).map((c) => ({ ...c, vcenterName: vcName.get(c.vcenterId) || c.vcenterId })), capped: !!r.capped });
  });

  api.get('/tools/vm-dns/policy', toolsPerm, (req, res) => {
    const p = loadVmDnsPolicy();
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const known = new Set((snap?.vcenters || []).map((v) => String(v.id)));
    // 범위 계정에는 그 법인 항목만(다른 법인의 승인 DNS 주소 목록을 주지 않는다). 저장은 어차피 전체 범위 전용이다.
    const corps = {};
    for (const [id, list] of Object.entries(p.corps)) if (!allowed || allowed.has(id)) corps[id] = list;
    res.json({ corps, publicUnapproved: p.publicUnapproved, rev: p.rev, invalid: allowed ? [] : p.invalid,
      orphan: allowed ? [] : Object.keys(p.corps).filter((id) => !known.has(id)), updatedAt: p.updatedAt, scoped: !!allowed });
  });

  api.put('/tools/vm-dns/policy', adminOnly, toolsPerm, fleetOnly, (req, res) => {
    const user = req.user?.username || '';
    const r = saveVmDnsPolicy(req.body || {}, user);
    if (!r.ok) {
      if (r.code === 'stale') return res.status(409).json({ ok: false, code: 'stale', reason: r.reason, rev: r.rev });
      return res.status(400).json({ ok: false, code: r.code || 'invalid', reason: r.reason || '형식이 맞지 않는 항목이 있습니다', invalid: r.invalid || [] });
    }
    const known = new Set((store.get()?.vcenters || []).map((v) => String(v.id)));
    const p = r.policy;
    const entries = Object.values(p.corps).reduce((a, l) => a + l.length, 0);
    logAudit({ user: user || 'unknown', action: 'VM DNS 정책 저장', target: 'vm-dns-policy',
      detail: `법인 ${Object.keys(p.corps).length}곳 · 항목 ${entries}개 · 공인 DNS ${p.publicUnapproved ? '비승인' : '판정 안 함'}${r.changed ? '' : ' · 변경 없음'}`, ip: req.ip || '' });
    res.json({ ok: true, corps: p.corps, publicUnapproved: p.publicUnapproved, rev: p.rev, invalid: [],
      orphan: Object.keys(p.corps).filter((id) => !known.has(id)), updatedAt: p.updatedAt });
  });

  api.post('/tools/vm-dns/probe', adminOnly, toolsPerm, fleetOnly, async (req, res) => {
    if (vmDnsProbeState().running) return res.status(409).json({ ok: false, code: 'busy', reason: '도달성 점검이 이미 진행 중입니다 — 끝난 뒤 다시 누르세요.' });
    const targets = probeTargets(store.get(), { isMockVc: isMockVcenter });
    const r = await runVmDnsProbe(targets);
    if (r.busy) return res.status(409).json({ ok: false, code: 'busy', reason: '도달성 점검이 이미 진행 중입니다 — 끝난 뒤 다시 누르세요.' });
    if (!r.ok) return res.status(500).json({ ok: false, reason: r.reason || '점검 실패' });
    const s = r.summary;
    logAudit({ user: req.user?.username || 'unknown', action: 'VM DNS 도달성 점검', target: 'vm-dns',
      detail: `대상 ${s.targets} · 응답 ${s.answered} · 실패 ${s.failed} · 건너뜀 ${s.skipped} · 엣지 위임 ${s.edgeOnly}`, ip: req.ip || '' });
    res.json({ ok: true, summary: s, ranAt: r.ranAt });
  });

  api.get('/tools/vm-dns.csv', csvPerm, toolsPerm, (req, res) => {
    const snap = store.get();
    const vcenterId = qStr(req.query.vcenterId, 128);
    const rows = csvRows(withIndex(req, snap, vcenterId));
    const lines = [csvLine(['vCenter', 'VM', '전원', 'OS DNS', 'NIC DNS', '도메인', 'DHCP', '판정'])];
    for (const r of rows) lines.push(csvLine(r));
    logAudit({ user: req.user?.username || 'unknown', action: 'VM DNS CSV 내보내기', target: vcenterId || '(전체)', detail: `${rows.length}행`, ip: req.ip || '' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vm-dns-${fileStamp()}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(CSV_BOM + lines.join('\r\n') + '\r\n');
  });
}
