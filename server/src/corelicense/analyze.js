/**
 * corelicense/analyze.js — 특수 기능 '코어 라이선스 산정'(도구 키 `core-license`, v2.703 — A13) 판정(순수).
 * 입력은 스냅샷(vcenters·hosts·datastores). vCenter 왕복 0.
 *
 * 산정 규칙(Broadcom 코어 단위 구독 — 정직 기록: 공식 문서는 이 환경에서 확인하지 못했고 공개 공지 기준이다)
 *  · 호스트 필요 코어 = 소켓 수 × max(소켓당 최소 16, 소켓당 코어). 소켓당 코어는 '코어 ÷ 소켓' 올림.
 *  · 소켓 수나 코어 수를 못 읽은 호스트는 **산정하지 않고 따로 센다**(1 소켓·16 코어로 지어내지 않는다).
 *  · 끊긴 호스트도 라이선스 대상이다(하드웨어는 그대로다) — 사용률 계산과 다르다. 다만 몇 대인지 밝힌다.
 *  · vSAN 은 vSAN 데이터스토어의 **용량 합(TiB)** 만 낸다. 포함 용량(코어당 TiB)은 에디션·계약마다 달라
 *    가정값(`vsanTibPerCore`)을 화면이 밝히고, 사람이 고른다.
 *  · vCenter 가 보고한 코어 단위 라이선스(costUnit 'core')의 사용량과 나란히 둔다 — 둘이 다르면 그 사실만 말한다.
 */
import { numOrNull } from '../util/numOrNull.js';   // v2.727(감사 C-02)
import { unreadVcenterReasons } from '../metrics/unreadVcenters.js';   // v2.744(감사 VC-03): '지금 값으로 쓰지 않는 vCenter' 판정 한 벌

/**
 * v2.744(감사 VC-03): 리포트(코어 라이선스·비용 배분·이전 준비도)가 **읽지 못한 vCenter** — 인벤토리(호스트·VM)가 하나도 없는데 상태가
 *   '못 읽음' 인 vCenter. 예전 리포트는 snap.initial(첫 병합 전 골격) 하나만 봐서, 첫 병합 뒤에도 수집 중인 vCenter(pending — 고RTT·새로
 *   등록)나 불통인데 직전 값이 없는 vCenter(store.js 최소 unreachable 항목)를 0 으로 섞은 부분 합을 전체 합계로 보였다(재현: 3곳 중 2곳을
 *   못 읽었는데 '필요 코어(산정) 64' 를 표지 없이). 판정은 metrics/unreadVcenters.js unreadVcenterReasons 를 그대로 쓰고(사본 금지),
 *   그 판정이 일부러 빼는 'pending'(첫 수집 중 — 샘플러 합계를 영원히 막지 않으려고 뺐다)과 'disabled'(관리자가 끈 vCenter)를 상태로 더한다.
 *   ⚠ 호스트·VM 이 남아 있는 vCenter(직전 값 이월·점검중 캐시·낡은 위임 보고)는 여기 넣지 않는다 — 값이 있고, 합계에서 빠지지 않는다.
 * @param vcenterIds 범위(null 이면 스냅샷 전부) — 범위 밖 vCenter 는 싣지 않는다.
 * @returns {{vcenterId:string, name:string, why:'pending'|'unreachable'|'maintenance'|'stale'|'disabled'}[]}
 */
export function notReadVcentersOf(snap, vcenterIds = null) {
  const allow = vcenterIds ? new Set([...vcenterIds].map(String)) : null;
  const reasons = unreadVcenterReasons(snap);
  const has = new Set();
  for (const x of snap?.hosts || []) if (x && x.vcenterId != null) has.add(String(x.vcenterId));
  for (const x of snap?.vms || []) if (x && x.vcenterId != null) has.add(String(x.vcenterId));
  const out = [];
  for (const vc of snap?.vcenters || []) {
    if (!vc || vc.id == null) continue;
    const id = String(vc.id);
    if ((allow && !allow.has(id)) || has.has(id)) continue;
    const why = reasons.get(id) ?? (vc.status === 'pending' ? 'pending' : vc.status === 'disabled' ? 'disabled' : null);
    if (why) out.push({ vcenterId: id, name: vc.name || id, why });
  }
  return out;
}

/** 읽지 못한 vCenter 중 합계를 하한으로 만드는 것(비활성은 관리자가 끈 것이라 따로 센다) — 하나라도 있으면 합계는 부분 합이다. */
export const notReadPartialOf = (list) => (Array.isArray(list) ? list : []).some((x) => x?.why !== 'disabled');

/**
 * v2.742(감사 VC-06): vCenter 의 라이선스·확장 목록을 읽었는가 — 판정 한 벌(라이선스 현황·만료 확인·솔루션 버전·코어 라이선스가 쓴다).
 * 배열이면 읽은 것(빈 배열 = 보고 0개)이라 null. 아니면 `{ why, error }` — why 'failed'(조회가 실패했다 — soapClient 가
 * `<field>Error` 를 싣는다) / 'not-read'(첫 수집 전·REST 폴백·구버전 엣지처럼 그 필드가 아예 없거나 배열이 아니다).
 * error 는 원문(200자) — 주소가 들어갈 수 있어 **관리자에게만** 내보낼 것(호출부 책임).
 * @param {object} vc 스냅샷 vcenter 객체
 * @param {'licenses'|'solutions'} field
 */
export function vcListUnread(vc, field) {
  if (Array.isArray(vc?.[field])) return null;
  const err = vc?.[`${field}Error`];
  const error = typeof err === 'string' ? err.slice(0, 200) : '';
  if (error) return { why: 'failed', error };
  // 목록이 없는 이유는 vCenter 상태가 말한다(store.js 골격·병합이 붙이는 status). 그 밖은 '이 수집 경로가 싣지 않음'.
  const st = typeof vc?.status === 'string' ? vc.status : '';
  return { why: Object.hasOwn(LIST_UNREAD_TEXT, st) ? st : 'not-read', error: '' };
}

/** vcListUnread 의 why → 사람이 읽는 문장(서버 응답 collectionErrors 등 — 문구에 백틱·별표를 쓰지 않는다). */
export const LIST_UNREAD_TEXT = Object.freeze({
  failed: '조회 실패 — 없음이 아니라 확인 불가',
  unreachable: 'vCenter 연결 실패로 읽지 못함 — 없음이 아니라 확인 불가',
  pending: '첫 수집 전이라 아직 읽지 않음 — 없음이 아니라 확인 불가',
  maintenance: '점검중 vCenter 라 수집하지 않음 — 없음이 아니라 확인 불가',
  disabled: '비활성 vCenter 라 수집하지 않음',
  'not-read': '이 수집 경로가 목록을 싣지 않음(REST 폴백·구버전 엣지) — 없음이 아니라 확인 불가',
});

/** 읽은 목록의 객체 원소만(엣지가 보낸 모양이 틀려도 글자 단위 항목·null 원소로 던지지 않게). 못 읽었으면 빈 배열. */
export const vcListItems = (vc, field) => (Array.isArray(vc?.[field]) ? vc[field].filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);

export const MIN_CORES_PER_SOCKET = 16;
export const VSAN_TIB_PER_CORE = Object.freeze({ none: 0, vvf: 0.25, vcf: 1 });

/** @returns {{sockets:number, cores:number, perSocket:number, licensed:number, padded:number}|null} */
export function hostCoreLicense(h) {
  const sockets = Number(h?.cpuSockets);
  const cores = Number(h?.cpuCores);
  if (!Number.isFinite(sockets) || sockets <= 0 || !Number.isFinite(cores) || cores <= 0) return null;
  const perSocket = Math.ceil(cores / sockets);
  const licensed = sockets * Math.max(MIN_CORES_PER_SOCKET, perSocket);
  return { sockets, cores, perSocket, licensed, padded: licensed - cores };
}

const GIB_PER_TIB = 1024;

/**
 * v2.721(감사 B1-03): vSAN 추가분이 확정값인지. 산정 못 한 호스트가 있으면 licensed 가 하한이라 포함 용량도 하한 →
 * 추가분은 상한('upper'), 용량 미상 vSAN 데이터스토어가 있으면 vSAN 합계가 하한 → 추가분은 하한('lower'),
 * 둘 다면 방향을 알 수 없다('unknown' — 값을 null 로 둔다). 추가분 0 이고 vSAN 미상이 없으면 확정 0 이다.
 * reportedDiff 가 부분 합이면 비교하지 않는 것과 같은 규칙이다.
 */
export function addonBoundOf(unknownHosts, vsanUnknown, addon) {
  const u = unknownHosts > 0; const v = vsanUnknown > 0;
  if (u && v) return 'unknown';
  if (v) return 'lower';
  if (u) return addon > 0 ? 'upper' : 'exact';
  return 'exact';
}

export function analyzeCoreLicense(snap, { vcenterIds = null, vsanPlan = 'none' } = {}) {
  const allow = vcenterIds ? new Set(vcenterIds) : null;
  const vcs = (snap?.vcenters || []).filter((v) => !allow || allow.has(v.id));
  const rate = VSAN_TIB_PER_CORE[vsanPlan] ?? 0;
  // v2.744(감사 VC-03): 읽지 못한 vCenter — 그 행은 '호스트 0 · 필요 코어 0' 이 아니라 '미수집' 이고 합계는 하한이다.
  const notReadVcenters = notReadVcentersOf(snap, vcs.map((v) => v.id));
  const notReadBy = new Map(notReadVcenters.map((x) => [x.vcenterId, x.why]));
  const rows = new Map(vcs.map((v) => [v.id, {
    vcenterId: v.id, vcenterName: v.name || v.id, hosts: 0, counted: 0, unknown: 0, disconnected: 0,
    sockets: 0, cores: 0, licensed: 0, padded: 0, paddedHosts: 0,
    vsanTib: 0, vsanDs: 0, vsanUnknown: 0, reportedCoreUsed: null, reportedCoreTotal: null, coreLicenses: 0,
    // v2.742(감사 VC-06): 라이선스 목록을 못 읽은 vCenter — '코어 라이선스 0개(보고 없음)' 와 구분한다. null 이면 읽었다.
    licensesUnread: vcListUnread(v, 'licenses')?.why ?? null,
    // v2.727(감사 C-02): used/total 을 못 읽은(null) 코어 라이선스 개수 — 하나라도 있으면 보고 합은 null(부분 합 금지).
    reportedUsedUnknown: 0, reportedTotalUnknown: 0,
  }]));
  const hostRows = [];
  for (const h of snap?.hosts || []) {
    const r = rows.get(h.vcenterId);
    if (!r) continue;
    r.hosts += 1;
    if (h.connectionState === 'DISCONNECTED' || h.connectionState === 'NOT_RESPONDING') r.disconnected += 1;
    const c = hostCoreLicense(h);
    if (!c) { r.unknown += 1; hostRows.push({ vcenterId: h.vcenterId, name: h.name, cluster: h.cluster, unknown: true, cores: Number(h.cpuCores) || null, sockets: Number(h.cpuSockets) || null }); continue; }
    r.counted += 1; r.sockets += c.sockets; r.cores += c.cores; r.licensed += c.licensed; r.padded += c.padded;
    if (c.padded > 0) r.paddedHosts += 1;
    hostRows.push({ vcenterId: h.vcenterId, name: h.name, cluster: h.cluster, unknown: false, ...c });
  }
  for (const d of snap?.datastores || []) {
    const r = rows.get(d.vcenterId);
    if (!r || !/vsan/i.test(d.type || '')) continue;
    r.vsanDs += 1;
    const cap = Number(d.capacityGB);
    if (Number.isFinite(cap) && cap > 0) r.vsanTib += cap / GIB_PER_TIB; else r.vsanUnknown += 1;
  }
  for (const v of vcs) {
    const r = rows.get(v.id);
    const core = vcListItems(v, 'licenses').filter((l) => String(l?.costUnit || '').toLowerCase() === 'core');
    if (core.length) {
      r.coreLicenses = core.length;
      // v2.727(감사 C-02): soapClient 가 <used>/<total> 없는 라이선스를 null 로 싣는다(예전엔 0). null 을 0 으로 더하면
      //   '보고 0 코어' 라는 없는 값으로 reportedDiff = −licensed 가 된다 — 하나라도 모르면 합을 내지 않고 개수를 밝힌다.
      //   보고된 0·음수는 예전처럼 0 으로 센다(값이 있는 것이다).
      let used = 0; let total = 0;
      for (const l of core) {
        const u = numOrNull(l.used); const t = numOrNull(l.total);
        if (u == null) r.reportedUsedUnknown += 1; else if (u > 0) used += u;
        if (t == null) r.reportedTotalUnknown += 1; else if (t > 0) total += t;
      }
      r.reportedCoreUsed = r.reportedUsedUnknown > 0 ? null : used;
      r.reportedCoreTotal = r.reportedTotalUnknown > 0 ? null : total;
    }
  }
  const NUM_KEYS = ['hosts', 'counted', 'unknown', 'disconnected', 'sockets', 'cores', 'licensed', 'padded', 'paddedHosts', 'vsanTib', 'vsanDs', 'vsanUnknown'];
  const list = [...rows.values()].map((r) => {
    const nr = notReadBy.get(String(r.vcenterId)) ?? null;
    if (nr) {
      // v2.744(VC-03): 읽지 못한 vCenter 의 수치는 0 이 아니라 null(모름)이다 — 보고 비교·vSAN 추가분도 내지 않는다.
      const o = { ...r, notRead: nr, vsanIncludedTib: null, vsanAddonTib: null, vsanAddonBound: null, reportedDiff: null, reportedCoreUsed: null, reportedCoreTotal: null };
      for (const k of NUM_KEYS) o[k] = null;
      return o;
    }
    const vsanTib = Math.round(r.vsanTib * 100) / 100;
    const included = r.licensed * rate;
    const addon = rate ? Math.max(0, Math.round((vsanTib - included) * 100) / 100) : null;
    const bound = rate ? addonBoundOf(r.unknown, r.vsanUnknown, addon) : null;
    return {
      ...r, notRead: null, vsanTib,
      vsanIncludedTib: rate ? Math.round(included * 100) / 100 : null,
      vsanAddonTib: bound === 'unknown' ? null : addon,
      vsanAddonBound: bound,
      // vCenter 보고와의 차이 — 산정 못 한 호스트가 있으면 비교하지 않는다(부분 합끼리 비교하면 거짓 차이).
      reportedDiff: r.reportedCoreUsed != null && r.unknown === 0 ? r.reportedCoreUsed - r.licensed : null,
    };
  }).sort((a, b) => (b.licensed ?? -1) - (a.licensed ?? -1) || String(a.vcenterName).localeCompare(String(b.vcenterName)));
  const sum = (k) => list.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totals = {
    vcenters: list.length, hosts: sum('hosts'), counted: sum('counted'), unknown: sum('unknown'), disconnected: sum('disconnected'),
    sockets: sum('sockets'), cores: sum('cores'), licensed: sum('licensed'), padded: sum('padded'), paddedHosts: sum('paddedHosts'),
    vsanTib: Math.round(sum('vsanTib') * 100) / 100, vsanUnknown: sum('vsanUnknown'),
    vsanIncludedTib: rate ? Math.round(sum('licensed') * rate * 100) / 100 : null,
    reportedUsedUnknown: sum('reportedUsedUnknown'), reportedTotalUnknown: sum('reportedTotalUnknown'),   // v2.727(감사 C-02)
    // v2.742(VC-06): 라이선스 목록을 못 읽은 vCenter 수(0 이면 전부 읽었다). v2.744(VC-03): 인벤토리 자체를 못 읽은 vCenter 는
    //   notRead 로 따로 말하므로 여기서 빼고 센다(같은 vCenter 를 두 문장이 두 번 말하지 않게).
    licensesUnread: list.filter((r) => r.licensesUnread && !r.notRead).length,
    // v2.744(감사 VC-03): 읽지 못한 vCenter 수(비활성 제외) · 비활성 vCenter 수 · 합계가 하한인가.
    notRead: notReadVcenters.filter((x) => x.why !== 'disabled').length,
    notReadDisabled: notReadVcenters.filter((x) => x.why === 'disabled').length,
    partial: notReadPartialOf(notReadVcenters),
  };
  // 포함 용량은 계약 전체에서 합쳐진다(법인별 초과를 더하면 다른 법인의 남는 몫을 무시해 과대가 된다) — 합계는 전체 기준.
  totals.vsanAddonTib = rate ? Math.max(0, Math.round((totals.vsanTib - totals.licensed * rate) * 100) / 100) : null;
  totals.vsanAddonBound = rate ? addonBoundOf(totals.unknown, totals.vsanUnknown, totals.vsanAddonTib) : null;
  // v2.744(감사 VC-03): 읽지 못한 vCenter 가 있으면 그 vCenter 의 코어(포함 용량)와 vSAN 용량을 둘 다 모른다 — 추가분이 어느 쪽으로
  //   틀릴지 알 수 없다('unknown'). 사유 문장은 화면 coverageNote 가 notRead 로 말한다.
  if (rate && totals.partial) totals.vsanAddonBound = 'unknown';
  if (totals.vsanAddonBound === 'unknown') totals.vsanAddonTib = null;
  hostRows.sort((a, b) => (b.padded ?? -1) - (a.padded ?? -1) || String(a.name).localeCompare(String(b.name)));
  return { rule: { minCoresPerSocket: MIN_CORES_PER_SOCKET, vsanPlan, vsanTibPerCore: rate }, totals, notReadVcenters, vcenters: list, hosts: hostRows.slice(0, 3000), hostsOmitted: Math.max(0, hostRows.length - 3000) };
}
