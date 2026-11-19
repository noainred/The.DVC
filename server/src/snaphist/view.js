/**
 * snaphist/view.js — 특수 기능 ‘스냅샷 있는 VM’(`GET /api/tools/snapshots`) 응답을 만든다(순수 — store · 파일 · DB 를 부르지 않는다).
 *
 * v3.26.0(설계 docs/design/snapshots — 사용자 ‘기본값대로 구현해’):
 *   · 판정은 `vmhygiene/analyze.js hygieneFindings` 하나다(나이 · 개수 · 크기 · 예외 · 템플릿) — ‘VM 현황’ 의 ‘오래된 스냅샷’ 카드와 같은 함수.
 *     여기서 같은 판정을 다시 쓰지 않는다(판정 코어는 하나 — 루트 CLAUDE.md).
 *   · 못 읽은 값은 0 이 아니다: 크기 · 생성일 · 데이터스토어 사용률을 못 읽었으면 null 로 내리고 합에 넣지 않는다(따로 센다).
 *     ⚠ 수집기(soapParse.snapshotInfo)는 layoutEx 가 없을 때 크기를 0 으로 남긴다 — 스냅샷이 있는데 0 GB 이면 ‘못 읽음’ 으로 본다
 *     (스냅샷 델타가 0 바이트일 수는 없다. 0.04 GB 아래는 반올림으로 0 이 될 수 있어 ‘0.1 GB 미만’ 과 구분하지 못한다 — 추정이라 화면이 말한다).
 *   · 값이 낡은 vCenter(vc.stale — 카드와 같은 기준)의 VM 은 목록에 남기되 stale 표시를 붙이고, 요약 수에서는 뺀다(따로 센다).
 *   · 법인(묶음) = DataCenter(datacenter/store.js) — 배정이 없으면 vCenter 하나가 한 법인(이름 = vCenter 이름).
 *   · 데이터스토어 사용률: VM 디스크가 놓인 데이터스토어 중 **가장 찬 것**(같은 vCenter 의 이름으로 찾는다 — 이름은 vCenter 안에서만 유일).
 */
import { numOrNull } from '../util/numOrNull.js';
import { hygieneFindings } from '../vmhygiene/analyze.js';

export const AGE_EDGES_DAYS = Object.freeze([30, 90]);   // 나이 구간 경계 — inventory/vmInsight.js SNAP_AGE_EDGES_DAYS 와 같은 값(시험이 대조)
export const ADVISE_HOURS = 72;                          // VMware 권고(참고선) — tools/diskTrend.js DEFAULT_POLICY.snapshotMaxHours 와 같은 값(시험이 대조)
export const ADVISE_CHAIN = 3;                           // 권고 줄기 길이(2~3개) — 참고로만 보인다
export const DS_HIGH_PCT = 85;                           // vCenter 기본 알람 위험선(diskTrend DEFAULT_POLICY.critPct 와 같은 값)
export const TREE_MAX = 64;                              // soapParse.SNAP_TREE_MAX 와 같은 상한(엣지가 보낸 값도 중앙이 이만큼으로 자른다)
const DAY = 86_400_000;
const TEXT = { name: 80, desc: 200 };

const txt = (s, max) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null);

/** 스냅샷 크기 — 개수가 1 이상인데 0 이면 못 읽은 것으로 본다(위 머리말). */
export function snapGbOf(v) {
  const n = numOrNull(v?.snapshotCount);
  const gb = numOrNull(v?.snapshotSizeGB);
  if (gb == null) return null;
  if (n != null && n > 0 && gb <= 0) return null;
  return gb;
}

/** 스냅샷 줄기(전위 순서) — 아는 키만 · 상한. 배열이 아니면 null(모름). */
export function treeOf(v) {
  const t = Array.isArray(v?.snapshotTree) ? v.snapshotTree : null;
  if (!t) return null;
  const out = [];
  for (const n of t.slice(0, TREE_MAX)) {
    if (!n || typeof n !== 'object') continue;
    const ts = numOrNull(n.ts);
    out.push({
      d: Math.max(0, Math.min(32, numOrNull(n.d) ?? 0)),
      name: txt(n.name, TEXT.name), desc: txt(n.desc, TEXT.desc), ts: ts != null && ts > 0 ? ts : null,
      // state = 찍을 때 VM 전원 상태. 켜진 채 찍은 스냅샷은 메모리까지 담는다(되돌리면 켜진 상태로 돌아간다) — vSphere 의 뜻 그대로.
      mem: n.state === 'poweredOn', quiesced: n.quiesced === true, current: n.current === true,
    });
  }
  return out;
}

/** 줄기에서 생성 시각이 가장 이른 노드(못 읽은 시각은 건너뛴다). 없으면 null. */
export function oldestNode(tree) {
  let best = null;
  for (const n of tree || []) if (n.ts != null && (!best || n.ts < best.ts)) best = n;
  return best;
}

/** 줄기 깊이(가장 깊은 노드 + 1). 줄기를 모르면 null. */
export function chainDepth(tree) {
  if (!tree) return null;
  return tree.length ? tree.reduce((m, n) => Math.max(m, n.d + 1), 0) : 0;
}

/** VM 이 놓인 데이터스토어 중 가장 찬 것 — { name, pct } · 디스크 · 데이터스토어를 못 읽으면 null. */
export function dsWorstOf(v, dsIndex) {
  const names = new Set();
  // 디스크 목록은 VM 구성(dev.disks — soapParse.vmDevices · vmExport 와 같은 자리)에 있다
  const disks = Array.isArray(v?.dev?.disks) ? v.dev.disks : Array.isArray(v?.disks) ? v.disks : [];
  for (const d of disks) if (d && typeof d.datastore === 'string' && d.datastore) names.add(d.datastore);
  let best = null;
  for (const name of names) {
    const ds = dsIndex.get(`${v.vcenterId}\n${name}`);
    const pct = ds ? pctOf(ds) : null;
    if (pct == null) continue;
    if (!best || pct > best.pct) best = { name, pct };
  }
  return best;
}

function pctOf(ds) {
  const p = numOrNull(ds.usagePct);
  if (p != null) return Math.round(p * 10) / 10;
  const cap = numOrNull(ds.capacityGB); const free = numOrNull(ds.freeGB);
  if (cap == null || free == null || cap <= 0) return null;
  return Math.round(((cap - free) / cap) * 1000) / 10;
}

/** 나이 구간 — 판정하지 않은 VM 은 'skip', 생성일 못 읽음은 'unk'. 기준 미만은 'new'. */
export function bandOf(days, judged, ageDays) {
  if (!judged) return 'skip';
  if (days == null) return 'unk';
  if (ageDays != null && days < ageDays) return 'new';
  if (days < AGE_EDGES_DAYS[0]) return 'd7';
  if (days < AGE_EDGES_DAYS[1]) return 'd30';
  return 'd90';
}

/**
 * @param {object} snap  store.get() 결과(vcenters · vms · datastores)
 * @param {object} o
 * @param {Set<string>|null} o.allowed   사용자 조회 범위(scopedVcenterIds) — 먼저 건다
 * @param {Set<string>|null} o.pick      고른 법인(vcenterPickOf) — 범위 뒤에 건다(빈 Set = 0건)
 * @param {object|null} o.hygiene        loadVmHygieneSettings() 결과(null 이면 판정하지 않는다)
 * @param {number} o.now
 * @param {(vcId:string)=>string} [o.dcOf]          vCenter → DataCenter id('' = 배정 없음)
 * @param {Map<string,string>} [o.dcNames]          DataCenter id → 이름
 */
export function snapshotToolView(snap, { allowed = null, pick = null, hygiene = null, now = Date.now(), dcOf = () => '', dcNames = new Map() } = {}) {
  const inScope = (id) => (!allowed || allowed.has(id)) && (!pick || pick.has(id));
  const vcs = (snap?.vcenters || []).filter((vc) => vc && vc.id != null && inScope(String(vc.id)));
  const vcById = new Map(vcs.map((vc) => [String(vc.id), vc]));
  const dsIndex = new Map();
  for (const ds of snap?.datastores || []) if (ds && vcById.has(String(ds.vcenterId)) && ds.name) dsIndex.set(`${ds.vcenterId}\n${ds.name}`, ds);

  const corpOf = (vcId) => {
    let dc = '';
    try { dc = String(dcOf(vcId) || ''); } catch { dc = ''; }
    if (dc) return { corpId: `dc:${dc}`, corpName: dcNames.get(dc) || dc };
    const vc = vcById.get(vcId);
    return { corpId: `vc:${vcId}`, corpName: String(vc?.name || vcId) };
  };

  const ageDays = numOrNull(hygiene?.snapAgeDays);
  const items = [];
  let ghost = 0;
  for (const v of snap?.vms || []) {
    if (!v || !vcById.has(String(v.vcenterId))) continue;
    const og = numOrNull(v.orphanDeltaGB);
    const cnt = numOrNull(v.snapshotCount);
    if ((cnt == null || cnt === 0) && og != null && og > 0) ghost += 1;
    if (cnt == null || cnt <= 0) continue;
    const vcId = String(v.vcenterId);
    const vc = vcById.get(vcId);
    const tree = treeOf(v);
    const oldest = oldestNode(tree);
    // 지난 일수는 판정(hygieneFindings)과 같은 값만 — 줄기 시각으로 보충하면 band 와 sig.age 가 갈린다(반증 9)
    const oldestTs = numOrNull(v.snapshotOldestTs);
    const days = oldestTs != null && oldestTs > 0 ? Math.max(0, Math.floor((now - oldestTs) / DAY)) : null;
    const hours = oldestTs != null && oldestTs > 0 ? Math.max(0, Math.floor((now - oldestTs) / 3_600_000)) : null;
    const gb = snapGbOf(v);
    const f = hygiene ? hygieneFindings(v, hygiene, now) : { findings: [], excepted: null, held: null };
    const codes = new Set(f.findings.map((x) => x.code));
    const template = v.template === true;
    const judged = !!hygiene && !template && !f.excepted && !f.held;
    const ds = dsWorstOf(v, dsIndex);
    const cons = v.cfg && typeof v.cfg === 'object' && typeof v.cfg.consolidationNeeded === 'boolean' ? v.cfg.consolidationNeeded : null;
    const names = Array.isArray(v.snapshotNames) ? v.snapshotNames.filter((s) => typeof s === 'string').slice(0, TREE_MAX).map((s) => s.slice(0, TEXT.name)) : [];
    items.push({
      id: v.id, name: v.name, vcenterId: vcId, vcName: String(vc?.name || vcId), ...corpOf(vcId),
      cluster: v.cluster || null, host: v.host || null, powerState: v.powerState || null, template,
      stale: vc?.stale === true,
      snapshotCount: cnt, snapGB: gb,
      oldestTs, days, hours,
      oldestName: oldest?.name ?? (names[0] || null), oldestDesc: oldest?.desc ?? null,
      names, tree, depth: chainDepth(tree), treeCut: tree != null && cnt > tree.length,
      judged, skip: template ? 'template' : f.excepted ? 'exception' : f.held ? 'hold' : !hygiene ? 'no-settings' : null, exceptedBy: f.excepted || null,
      hold: f.held ? { until: f.held.until, reason: f.held.reason } : null,   // 건 계정(by)은 보류 목록 라우트가 관리자 판본에만 싣는다
      band: bandOf(days, judged, ageDays),
      sig: {
        age: codes.has('snap-age'), count: codes.has('snap-count'), size: codes.has('snap-size'),
        h72: judged && hours != null && hours >= ADVISE_HOURS,
        ds: ds != null && ds.pct >= DS_HIGH_PCT, cons: cons === true,
        backup: (numOrNull(v.veeamSnaps) ?? 0) > 0,
        mem: tree ? tree.some((n) => n.mem) : null,
        noDesc: tree ? tree.every((n) => !n.desc) : null,
      },
      ds, consolidationNeeded: cons,
      // 예전 응답의 키(VmInfoTools 의 옛 화면 · 외부 호출 호환) — 값의 뜻은 그대로다(크기를 모르면 0 이던 옛 키).
      snapshotSizeGB: numOrNull(v.snapshotSizeGB) ?? 0, guestOS: v.guestOS || null,
    });
  }

  const corps = new Map();
  for (const vc of vcs) {
    const c = corpOf(String(vc.id));
    if (!corps.has(c.corpId)) corps.set(c.corpId, { id: c.corpId, name: c.corpName, vcenters: [] });
    corps.get(c.corpId).vcenters.push({ id: String(vc.id), name: String(vc.name || vc.id), stale: vc.stale === true, status: vc.status || null });
  }
  const sum = (xs) => Math.round(xs.reduce((a, x) => a + (x.snapGB ?? 0), 0) * 10) / 10;
  return {
    count: items.length,
    totalSizeGB: sum(items),
    items,
    thresholds: {
      snapAgeDays: ageDays, snapCount: numOrNull(hygiene?.snapCount), snapSizeGB: numOrNull(hygiene?.snapSizeGB),
      exceptions: Array.isArray(hygiene?.exceptions) ? hygiene.exceptions.length : 0,
      notify: hygiene?.notify ? { enabled: hygiene.notify.enabled === true, hour: numOrNull(hygiene.notify.hour) } : null,
      hygieneUnreadable: hygiene?.unreadable === true,
      ageEdgesDays: [...AGE_EDGES_DAYS], adviseHours: ADVISE_HOURS, adviseChain: ADVISE_CHAIN, dsHighPct: DS_HIGH_PCT,
    },
    corps: [...corps.values()],
    ghost,
  };
}
