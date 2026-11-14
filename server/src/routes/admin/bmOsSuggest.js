/**
 * routes/admin/bmOsSuggest.js — IP 관리 › IP 스캔 › '물리서버 OS 주소 제안'(v2.993 · 설계 docs/design/bm-folders §13 ②).
 * 게이트는 형제 IP 스캔 라우트와 같다(centralIpam.js: 관리자 + 전체 범위 — 스캔 결과는 vCenter 귀속이 없는 전 법인 데이터).
 * 등록은 **주소만**(계정 · 비밀번호 · 키 없음 · `addrOnly` 표지 · 비활성) — 계정을 넣기 전에는 어떤 수집도 접속하지 않는다(bmusage/targets.js indexOsHosts · bmstor 폴러 enabled).
 * 판정 코어는 bmfolders/osSuggest.js 하나(GET 과 등록이 같은 함수 — 등록은 지금 다시 계산한 제안에서 suggest · pick 이고 고른 IP 가 SSH 열린 후보일 때만).
 */
import { store } from '../../store.js';
import { getScanResults } from '../../ipam/scanStore.js';
import { setFwdNamesProvider } from '../../ipam/scanNames.js';
import { corpsOfFactory } from '../../ipam/scanDatacenterSource.js'; // v2.996: 판정을 도메인으로 옮겼다(라우트 간 import 순환 방지)
import { buildOsSuggest, applyPlan, fwdNamesFor, agentKey } from '../../bmfolders/osSuggest.js';
import { indexOsHosts, pickOsEntry } from '../../bmusage/targets.js';
import { listBmServersRaw, registryLoadError, applyBmServerBatch } from '../../bmstor/registry.js';
import { bindOfWrite } from '../../bmusage/onboard/bindRule.js';
import { logAudit } from '../../audit.js';
import { adminOnly, fullScopeOnlyWith } from './shared.js';

// 형제 IP 스캔 라우트(centralIpam.js)와 같은 게이트 · 같은 문구 — 스캔 결과는 vCenter 귀속이 없는 전 법인 데이터다.
const fleetOnly = fullScopeOnlyWith('이 기능은 전 법인(엣지·스캔 전체)에 걸친 데이터·동작이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');
/** 시험용 — 이 라우트들의 게이트(순서대로). */
export const BM_OS_GATES = Object.freeze([adminOnly, fleetOnly]);

export const SUGGEST_ROWS_MAX = 5000;

/** 물리서버 폴더와 같은 입력(서비스 인벤토리 입력 수집 하나)에서 베어메탈 구성원. 무거운 라우트 모듈은 쓸 때 읽는다(기동 비용). */
async function bmMembers(snap) {
  const [{ sharedGather }, { membersOf }] = await Promise.all([import('../api/svcInventory.js'), import('../api/bmFolders.js')]);
  const g = await sharedGather(snap);
  return membersOf(g).members;
}

/** 지금 제안 계산. 등록부를 못 읽었으면 { unreadable } — 빈 등록부로 보고 '등록 안 됨' 을 만들지 않는다. */
export async function currentOsSuggest(D = {}) {
  const snap = (D.snap || (() => store.get()))();
  const members = await (D.members || bmMembers)(snap);
  const raw = (D.listBmServersRaw || listBmServersRaw)();
  if ((D.registryLoadError || registryLoadError)()) return { unreadable: true };
  return buildOsSuggest({
    members, scanRows: Object.values((D.getScanResults || getScanResults)() || {}),
    osIndex: indexOsHosts(raw, { includeAddrOnly: true }), pickOsEntry, corpsOf: D.corpsOf !== undefined ? D.corpsOf : corpsOfFactory(snap),
  });
}

/**
 * 정방향 DNS 이름(스캔 배정 · 중앙 스캔) — 그 에이전트가 수집하는 법인의 물리서버 이름. 실패하면 [](이름 찾기만 빠진다 — 스캔은 그대로).
 * @param {string} agent 엣지 이름 · 중앙 직접 스캔은 '' 또는 LOCAL
 */
export async function fwdNamesForAgent(agent, D = {}) {
  try {
    const snap = (D.snap || (() => store.get()))();
    const members = await (D.members || bmMembers)(snap);
    const corpsOf = D.corpsOf !== undefined ? D.corpsOf : corpsOfFactory(snap);
    return fwdNamesFor(members, agentKey(agent), corpsOf ? corpsOf(agent) : null);
  } catch { return []; }
}

// 중앙 · 엣지 자기 스캔(ipam/scanPoller — LOCAL)이 정방향 DNS 이름을 받는 공급자. 이 모듈이 읽힐 때(관리 라우트 mount) 등록한다.
setFwdNamesProvider(fwdNamesForAgent);

export function registerBmOsSuggest(adminRouter, { D = {} } = {}) {   // D: 시험 주입(입력 · 등록부 쓰기)
  adminRouter.get('/ipam/scan/bm-os-suggest', adminOnly, fleetOnly, async (_req, res) => {
    try {
      const r = await currentOsSuggest(D);
      if (r.unreadable) return res.status(503).json({ ok: false, code: 'registryUnreadable', reason: 'OS 계정 등록부(bm-storage.json)를 읽지 못해 등록 여부를 판정할 수 없습니다.' });
      res.json({ ok: true, total: r.total, counts: r.counts, rows: r.rows.slice(0, SUGGEST_ROWS_MAX), ...(r.rows.length > SUGGEST_ROWS_MAX ? { omitted: r.rows.length - SUGGEST_ROWS_MAX } : {}) });
    } catch (e) { res.status(500).json({ ok: false, reason: `제안을 만들지 못했습니다: ${String(e?.message || e).slice(0, 160)}` }); }
  });

  // 고른 제안을 OS 주소로 등록 — body { items:[{ key, ip }] } (최대 200)
  adminRouter.post('/ipam/scan/bm-os-suggest/apply', adminOnly, fleetOnly, async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ ok: false, reason: '등록할 제안을 고르십시오.' });
    if (items.length > 200) return res.status(400).json({ ok: false, reason: '한 번에 200건까지 등록할 수 있습니다.' });
    const r = await currentOsSuggest(D);
    if (r.unreadable) return res.status(503).json({ ok: false, code: 'registryUnreadable', reason: 'OS 계정 등록부(bm-storage.json)를 읽지 못해 등록하지 않았습니다.' });
    const plan = applyPlan(new Map(r.rows.map((x) => [x.key, x])), items);
    if (!plan.ok.length) return res.status(409).json({ ok: false, reason: '등록할 수 있는 제안이 없습니다 — 화면을 새로 고친 뒤 다시 고르십시오(이미 등록됐거나 · 후보가 바뀌었거나 · SSH 포트가 닫혔습니다).', refused: plan.refused });
    const inputs = plan.ok.map(({ row, ip }) => ({
      // mounts '/' — 등록부가 마운트 하나 이상을 요구한다(스토리지 측정용). 비활성이라 측정하지 않고, 계정을 넣고 켜면 루트(/)부터 잰다.
      name: row.name, host: ip, vcenterId: row.corp, agent: row.agent || '', enabled: false, addrOnly: true, mounts: ['/'],
      note: `IP 스캔 이름 일치로 등록한 OS 주소(${(row.cands.find((c) => c.ip === ip)?.vias || []).join('+')}) — 계정을 넣기 전에는 접속하지 않습니다.`,
    }));
    // 방어선: 주소만 넣는 쓰기는 비밀을 묶지 않는다(7b choke point 와 같은 함수로 확인 — 묶는다면 이 경로가 아니다).
    if (inputs.some((x) => bindOfWrite(null, x).binds)) return res.status(500).json({ ok: false, reason: '주소만 등록하는 쓰기가 인증 참조를 묶으려 했습니다 — 등록하지 않았습니다.' });
    const out = (D.applyBmServerBatch || applyBmServerBatch)(inputs);
    if (!out.ok) return res.status(out.code === 'registry-unreadable' ? 503 : 400).json({ ok: false, reason: out.reason, ...(out.code ? { code: out.code } : {}) });
    logAudit({ user: req.user?.username, action: '물리서버 OS 주소 등록(IP 스캔 이름 일치 · 주소만)', target: `${plan.ok.length}대`, detail: plan.ok.slice(0, 20).map(({ row, ip }) => `${row.name}=${ip}`).join(', ').slice(0, 400), ip: req.ip || '' });
    res.json({ ok: true, added: plan.ok.length, refused: plan.refused });
  });
}
