/**
 * routes/api/bmUsage.js — 특수기능 '베어메탈 사용률' 화면 API(v2.550).
 *
 * 사용자 요청(2026-09-17): "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고 싶어"
 * (서버 분석 › 구분 › **Baremetal(미가상화 물리)**).
 *
 * ── 권한: `tools` + **vCenter scope** ───────────────────────────────────────
 * 베어메탈은 `vcenterId`(법인) 축이 **있다** — 그래서 스토리지·Horizon 처럼 403 으로 거절하지 않고
 * 범위 계정에는 그 법인 것만 준다(CLAUDE.md '조회 라우트 scope 는 예외 없이').
 * ⚠ **법인 귀속이 없는 베어메탈은 범위 계정에 노출하지 않는다**('귀속 없는 데이터 미노출' 불변조건).
 *
 * ⚠ **자격증명을 응답에 싣지 않는다** — `targets.publicTarget()` 을 통과한 것만 내보낸다
 *   (`server/CLAUDE.md`: "비밀 값은 어떤 API 응답에도 싣지 않는다").
 * ⚠ **폴링 금지** — '지금 수집' 은 SSH·Redfish 왕복이다. 화면은 마운트 1회 + 버튼(v2.508 규약).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { loadBmUsageSettings, saveBmUsageSettings, bmUsageEnabled, DEFAULTS, enterpriseActive, dropUnspecifiedNumbers } from '../../bmusage/settings.js';
import { unassignedCauses, CAUSE as UNASSIGNED_CAUSE } from '../../bmusage/attribution.js';
import { TIER_LABEL } from '../../bmusage/license.js';
import { publicTarget, maskTargetAddress, maskBmIdentity, NO_PATH_REASON } from '../../bmusage/targets.js';
import { maskActivityEvents, maskPollerStatus, scrubHosts, addressMatcher, resolveMaskedToken } from '../../auth/addressMask.js';
import { currentTargets, pollBmUsageOnce, bmUsageStatus, authStopsFor } from '../../bmusage/poller.js';
import { latestUsage, usageHistory, usageDaily, dbStatus, METRICS } from '../../bmusage/db.js';
import { bmUsageEvents, bmUsageLogInfo } from '../../bmusage/activityLog.js';
import { scopeFilePaths } from '../../auth/scopeStatus.js';   // v2.598 AUTHZ-2598-04: log.file 절대 경로는 admin 만
import { config } from '../../config.js';
import { strOf } from '../../util/coercionTrap.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');

// v2.604(감사 CEN2604-03 2중 방어): 엣지 보관분 값이 객체면 String() 이 던져 이 라우트가 500 이었다 — 글자·수·불리언만.
const t = (v) => strOf(v, 4096).trim();

/** 범위 계정용 절단(순수) — 허용 vCenter 것만, 귀속 없는 것은 숨긴다. */
export function applyScope(list = [], allowed = null, field = 'vcenterId') {
  if (!allowed) return list;
  const ok = new Set(allowed);
  return list.filter((x) => t(x[field]) && ok.has(t(x[field])));
}

/**
 * 엣지 설정 사본에서 **법인 축**을 뺀다(v2.574 SEC-03).
 * ⚠ `corps` 는 '수집을 켠 법인 목록' 이라 범위 제한 계정에 주면 조직 구성이 그대로 드러난다.
 *   나머지 필드(주기·경로 on/off)는 그 엣지의 동작 설명이라 남긴다 — 화면이 '왜 값이 없나' 를
 *   말하려면 필요하다(`enterpriseActive` 등). 통째로 null 로 만들면 그 진단이 사라진다.
 * ⚠ 뺀 사실을 **숨기지 않는다** — `corpsHidden: true` 로 밝힌다(조용한 축약 금지).
 */
export function scopeEdgeSettings(settings, allowed) {
  if (!settings || typeof settings !== 'object') return null;
  if (!allowed) return settings;
  const { corps, ...rest } = settings;
  // v2.583: corps 는 배열이 아니라 `{ [vcenterId]: true }` 맵이다 — 예전 `Array.isArray` 판정은 늘 null 을 줬다.
  const n = Array.isArray(corps) ? corps.length : (corps && typeof corps === 'object' ? Object.keys(corps).length : null);
  return { ...rest, corps: null, corpsHidden: true, corpsCount: n };
}

/**
 * 주 조회의 설정·상태를 범위·역할에 맞게 깎는다(v2.583 — 감사 확정. SEC-03 이 /edges 만 고친 형제 누락).
 *  · 범위 계정: `corps`(수집을 켠 법인 목록 — 그 자체가 조직 구성)를 **자기 범위 것만** 남기고 그 사실을 밝힌다.
 *  · 관리자가 아니면: 대체 경로 동의자 계정명(`enterpriseAckBy`)을 뺀다(설정·상태 양쪽).
 */
export function scopeMainSettings(settings, allowed, isAdmin) {
  if (!settings || typeof settings !== 'object') return settings;
  let out = settings;
  if (allowed && settings.corps && typeof settings.corps === 'object') {
    out = { ...out, corps: Object.fromEntries(Object.entries(settings.corps).filter(([id]) => allowed.has(id))), corpsScoped: true };
  }
  if (!isAdmin && 'enterpriseAckBy' in out) { const { enterpriseAckBy: _a, ...rest } = out; void _a; out = { ...rest, enterpriseAckByHidden: true }; }
  return out;
}
const stripAckBy = (st, isAdmin) => {
  if (isAdmin || !st || typeof st !== 'object' || !('enterpriseAckBy' in st)) return st;
  const { enterpriseAckBy: _a, ...rest } = st; void _a; return rest;
};

/**
 * 비-admin 가림에 쓸 주소 목록(v2.601 AUTHZ-2601-01) — 대상의 iDRAC·OS 주소 + iDRAC 등록부 주소.
 * 제외(skipped) 행·귀속 없음 표본에는 주소 칸이 없어 **등록부 주소와 대조**해야 이름=FQDN 인 행을 잡는다.
 * 등록부를 못 읽어도 IP 판정은 그대로 동작한다(넓게 여는 쪽으로 실패하지 않는다 — IPv4 는 항상 가린다).
 */
export async function bmAddressHosts(tg) {
  const hosts = [];
  for (const x of (tg?.targets || [])) {
    if (x?.idrac?.host) hosts.push(x.idrac.host);
    if (x?.osHost?.host) hosts.push(x.osHost.host);
    if (x?.idracHost) hosts.push(x.idracHost);
    if (x?.osHostName) hosts.push(x.osHostName);
  }
  try {
    const { loadRegistry } = await import('../../idrac/registry.js');
    for (const r of loadRegistry()) if (r?.host) hosts.push(r.host);
  } catch { /* 등록부를 못 읽으면 IP 판정만 — 아래 addressMatcher 가 IPv4 는 늘 잡는다 */ }
  return [...new Set(hosts.filter((h) => typeof h === 'string' && h))];
}

/** 비-admin 응답의 베어메탈 목록 전부를 같은 판정기로 가린다(대상과 최신값 행의 key 토큰이 같게). */
export function maskBmList(list, match) {
  return Array.isArray(list) ? list.map((x) => maskBmIdentity(x, match)) : list;
}

/** 귀속 없음 표본의 key·name 이 주소인 행을 가린다(v2.601 — 전체 범위 비-admin 에게만 나가는 경로). */
export function maskUnassignedInfo(info, match) {
  if (!info || typeof info !== 'object' || !Array.isArray(info.samples)) return info;
  return { ...info, samples: maskBmList(info.samples, match) };
}

export function registerBmUsage(api) {

/** 주 조회 — 대상·최신값·설정·상태. 장비에 접속하지 않는다. */
api.get('/tools/bm-usage', toolsPerm, async (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const isAdmin = req.user?.role === 'admin';
  try {
    const [tg, latest, db] = await Promise.all([
      currentTargets(),
      latestUsage().catch(() => []),
      dbStatus().catch(() => ({ available: false })),
    ]);
    // v2.600 AUTHZ-2600-08: 비-admin 에는 iDRAC·OS 관리 주소를 가린다(가린 사실은 addressHidden).
    // v2.601 AUTHZ-2601-01: 주소 칸만이 아니라 **식별자·이름이 주소인 행**(IP 로 등록한 iDRAC)도 가린다 —
    //   serverId·fleetId·key·name 이 곧 IP 라 host 를 비워도 그대로 샜다. 범위 절단은 원문으로 먼저 한다.
    const hosts = isAdmin ? [] : await bmAddressHosts(tg);
    const match = addressMatcher(hosts);
    const targets0 = applyScope(tg.targets.map(publicTarget), allowed);
    const targets = isAdmin ? targets0 : targets0.map((x) => maskTargetAddress(x, hosts, match));
    const skipped0 = applyScope(tg.skipped, allowed);
    const skipped = isAdmin ? skipped0 : maskBmList(skipped0, match);
    /*
     * ⚠ **사유별 개수도 scope 를 타야 한다**(v2.550 자체 재검토에서 잡은 결함): 예전에는
     *   `tg.counts.byReason` 을 그대로 내보내 범위 제한 계정이 **다른 법인 서버 대수**를 알 수 있었다
     *   (server/CLAUDE.md '귀속 없는 데이터·범위 밖 요약은 범위 계정에 노출하지 않는다').
     *   전체 범위 계정은 그대로, 범위 계정은 **보이는 목록에서 다시 센다**.
     */
    const skippedCounts = allowed
      ? skipped.reduce((acc, x) => { acc[x.reason] = (acc[x.reason] || 0) + 1; return acc; }, {})
      : (tg.counts.byReason || {});
    const counts = allowed
      ? { ...tg.counts, targets: targets.length, skipped: skipped.length, byReason: skippedCounts,
          idrac: targets.filter((x) => (x.paths || []).includes('idrac')).length,
          os: targets.filter((x) => (x.paths || []).includes('os')).length,
          both: targets.filter((x) => (x.paths || []).length > 1).length }
      : tg.counts;
    const keys = new Set(targets0.map((x) => x.key));
    // 최신값은 **대상 목록 안의 것만** 준다(법인을 끄거나 등록이 사라진 서버의 옛 값이 새어 나가지 않게).
    const rows0 = latest.filter((r) => keys.has(t(r.key)));
    const rows = isAdmin ? rows0 : maskBmList(rows0, match);
    res.json({
      ok: true, at: Date.now(),
      enabled: bmUsageEnabled(),
      settings: scopeMainSettings(loadBmUsageSettings(), allowed, isAdmin), defaults: DEFAULTS,
      targets, rows,
      // '왜 대상이 아닌지' 는 개수와 사유로만 준다(범위 밖 서버 이름을 흘리지 않기 위해).
      skippedCounts,
      skipped,
      counts,
      /* 키 충돌 — 범위 계정에는 보이는 것만(v2.550.3). 조용히 두면 한 서버 값이 다른 서버로 보인다. */
      keyConflicts: (isAdmin ? (x) => x : (l) => maskBmList(l, match))(applyScope(tg.keyConflicts || [], allowed)),
      metrics: METRICS, reasons: NO_PATH_REASON,
      vcenters: applyScope(tg.vcenters.map((v) => ({ ...v, vcenterId: v.id })), allowed),
      isEdge: tg.isEdge,
      // ⚠ DB 파일 경로는 admin 에게만(operator 는 tools 를 기본 보유 — '거부 기본값' 규칙).
      db: isAdmin ? db : (({ path: _p, ...rest }) => ({ ...rest, redacted: ['path'] }))(db),
      status: isAdmin ? bmUsageStatus() : maskPollerStatus(stripAckBy(bmUsageStatus(), isAdmin), hosts),
      enterpriseActive: enterpriseActive(),
      licenseLabels: TIER_LABEL,
      /*
       * ⚠⚠ **'법인 귀속 없음' 의 원인을 말한다**(v2.554 — 사용자 지시 "네 — 원인까지 조사").
       *   이 현장은 이 사유로 **500대**가 제외돼 표가 통째로 비어 있었다. 사유만 말하고 원인을
       *   말하지 않으면 사용자가 무엇을 고쳐야 하는지 알 수 없다.
       * ⚠ **범위 제한 계정에는 주지 않는다** — 귀속 없는 서버의 이름·서비스태그를 노출하는 것은
       *   '귀속 없는 데이터 미노출' 불변조건 위반이다(server/CLAUDE.md).
       */
      unassignedInfo: allowed ? null : (isAdmin ? await unassignedInfoFor(tg) : maskUnassignedInfo(await unassignedInfoFor(tg), match)),
      unassignedCauses: UNASSIGNED_CAUSE,
      /*
       * ⚠ 인증 실패로 정지된 대상은 **파일 기준으로 다시 센다** — 폴러의 인메모리 맵은 재시작하면
       *   비어서, 그것만 보고 '정지 0건' 이라 말하면 조용한 정지가 된다(v2.528 규약).
       *   범위 계정에는 보이는 대상만.
       */
      authStops: (isAdmin ? (x) => x : (l) => maskBmList(l, match))(applyScope(authStopsFor(tg.targets), allowed)),
      log: scopeFilePaths(bmUsageLogInfo(), req.user),
      ...(isAdmin ? {} : { addressHidden: true }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/** 한 서버의 추이 — 원시 + 일 롤업. 상한으로 잘렸으면 밝힌다(조용한 상한 금지). */
api.get('/tools/bm-usage/history', toolsPerm, async (req, res) => {
  const key = t(req.query.key);
  if (!key) return res.status(400).json({ ok: false, reason: 'key 가 필요합니다.' });
  const allowed = scopedVcenterIds(req.user, store.get());
  try {
    const tg = await currentTargets();
    const isAdmin = req.user?.role === 'admin';
    // v2.601 AUTHZ-2601-01: 비-admin 은 주소인 key 를 토큰으로 받는다 — 토큰으로도 같은 대상을 찾는다.
    const realKey = tg.targets.some((x) => x.key === key) ? key
      : (isAdmin ? null : resolveMaskedToken(key, tg.targets.map((x) => x.key)));
    const target = realKey ? (tg.targets.find((x) => x.key === realKey) || null) : null;
    // 범위 계정은 자기 법인 서버만 — 없는 것과 구분하지 않고 404(존재 은닉 규약).
    // ⚠⚠ v2.574 SEC-02 — `allowed` 는 **Set 또는 null** 이다(`auth/scope.js:16-26`).
    //   예전 코드는 `allowed.includes(...)` 라 **범위 제한 계정에서 항상 TypeError** 였고,
    //   이 라우트가 async 라 express 4 가 그것을 잡지 못해 **응답 없이 매달렸다**(BUG-03 과 겹친다).
    //   전체 범위 계정은 `allowed === null` 이라 `&&` 에서 단락돼 아무도 못 느꼈다.
    //   저장소 전수: `allowed.has(` 110곳 vs `allowed.includes(` **이 한 곳뿐**이었다.
    if (!target || (allowed && (!target.vcenterId || !allowed.has(target.vcenterId)))) {
      return res.status(404).json({ ok: false, reason: '대상 서버를 찾지 못했습니다.' });
    }
    /*
     * ⚠⚠ **적재 키와 조회 키가 같아야 한다**(v2.550 자체 재검토에서 잡은 결함):
     *   `poller.js` 는 `insertUsage(rows, config.agent?.name || '')` 로 적재한다 — 엣지에서는
     *   `AGENT_NAME`, 중앙에서는 `''` 다. 조회를 `''` 로 굳혀 두면 **엣지에서는 추이가 영원히 빈다**
     *   (수집은 되는데 상세가 비어 '저장이 안 된다' 로 보인다). 같은 식을 쓴다.
     */
    const agent = config.agent?.name || '';
    const [raw, daily] = await Promise.all([
      usageHistory(target.key, { agent, hours: Number(req.query.hours) || 24 }),
      usageDaily({ key: target.key, agent, days: Number(req.query.days) || 90 }),
    ]);
    if (isAdmin) {
      return res.json({ ok: true, key, target: publicTarget(target), raw: raw.rows, rawTruncated: raw.truncated, daily, metrics: METRICS });
    }
    const hosts = await bmAddressHosts(tg);
    const match = addressMatcher(hosts);
    res.json({ ok: true, key, target: maskTargetAddress(publicTarget(target), hosts), addressHidden: true,
      raw: maskBmList(raw.rows, match), rawTruncated: raw.truncated,
      daily: Array.isArray(daily) ? maskBmList(daily, match) : daily, metrics: METRICS });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/** 지금 수집 — 폴러와 **재진입 가드를 공유**한다(연타가 세션을 곱하지 않게). */
api.post('/tools/bm-usage/collect', writeRole, toolsPerm, async (req, res) => {
  // v2.583(감사 확정): 범위 계정이 **전 법인** 수동 수집(인증 정지도 무시)을 걸고 전 법인 counts 를 받았다 —
  //   형제 /edges/pull 처럼 전체 범위 계정만 허용한다(수집 대상을 범위로 나누는 경로가 폴러에 없다).
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: '지금 수집은 전 법인 서버에 접속합니다 — 전체 범위(vCenter 제한 없는) 계정만 실행할 수 있습니다.' });
  }
  const r = await pollBmUsageOnce({ trigger: 'manual' });
  logAudit({
    user: req.user?.username, action: 'bm-usage.collect', ip: req.ip || '',
    detail: JSON.stringify({ ok: !!r.ok, servers: r.servers ?? null }).slice(0, 300),
  });
  res.json(r);
});

/**
 * 작업 로그 — 실패 사유를 툴팁이 아니라 본문으로 볼 수 있게(v2.516 규약).
 *
 * ⚠⚠ v2.574 SEC-04 — **이 라우트에 scope 가 없었다.** 링버퍼 500건에는
 *   `name`(서버 이름)·`host`(iDRAC 주소 또는 OS 호스트)·`error`(최대 300자)가 **전 법인 혼재**로
 *   들어 있다(`util/activityLog.js:58-68`). 같은 모듈의 주 조회(`/tools/bm-usage`)는
 *   `applyScope()` 로 6개 필드를 전부 거르는데 그 노력이 이 한 라우트로 무효가 됐다.
 *   형제 모듈은 제대로 하고 있었다 — `horizonSessions.js:104` 는 `denyScoped(req,res)` 를 먼저 부른다.
 * ⚠ 이벤트에는 vcenterId 가 없으므로 **대상 목록(scope 적용)의 key 집합**으로 거른다.
 *   키를 못 붙인 이벤트(장비 단위가 아닌 주기 요약 등)는 범위 계정에 주지 않는다 — 안전한 쪽으로.
 * ⚠ **폴러 상태(`poller`)도 그대로 내보내지 않는다** — `last` 안에 사유별 대수가 있다
 *   (v2.550.3 이 겪은 `status.last.counts` 우회로와 같은 유형).
 */
api.get('/tools/bm-usage/activity', toolsPerm, async (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const events0 = bmUsageEvents(Number(req.query.limit) || 100);
  // v2.600 AUTHZ-2600-08: 작업 로그 이벤트의 host(iDRAC·OS 주소)도 비-admin 에는 가린다.
  // v2.601 AUTHZ-2601-01: deviceId·name 이 주소인 이벤트(IP 로 등록한 iDRAC)와 스킴 붙은 host 의 오류 문구도.
  //   ⚠ 범위 절단은 **원문 deviceId** 로 먼저 하고 가림은 그 뒤에 한다(가린 뒤에 대조하면 전부 빠진다).
  const isAdmin = req.user?.role === 'admin';
  let tg = null;
  try { tg = await currentTargets(); } catch { tg = null; }
  const hosts = isAdmin ? [] : await bmAddressHosts(tg);
  const maskEv = (list) => (isAdmin ? list : maskActivityEvents(list, hosts));
  if (!allowed) {
    const poller = isAdmin ? bmUsageStatus() : maskPollerStatus(stripAckBy(bmUsageStatus(), false), hosts);
    return res.json({ ok: true, poller, events: maskEv(events0), log: scopeFilePaths(bmUsageLogInfo(), req.user), ...(isAdmin ? {} : { addressHidden: true }) });
  }
  // 대상을 못 읽으면 아래에서 전부 걸러진다 — 넓게 여는 쪽으로 실패하지 않는다.
  const keys = new Set(applyScope(tg?.targets || [], allowed).map((x) => t(x.key)));
  const events = events0;
  const shown = maskEv((events || []).filter((e) => keys.has(t(e?.deviceId)) || keys.has(t(e?.key))));
  res.json({
    ok: true,
    poller: { running: bmUsageStatus()?.running ?? null, intervalMs: bmUsageStatus()?.intervalMs ?? null },
    events: shown,
    ...(isAdmin ? {} : { addressHidden: true }),
    // 조용히 빼지 않는다 — 몇 건이 범위 밖이라 빠졌는지 화면이 말할 수 있게.
    omittedOutOfScope: Math.max(0, (events || []).length - shown.length),
    scoped: true,
    log: scopeFilePaths(bmUsageLogInfo(), req.user),
  });
});

/**
 * 귀속 없음 원인 — 등록부·수동 귀속 파일을 읽어 판정한다(장비 왕복 0).
 * ⚠ 읽기 실패는 조용히 삼키지 않는다 — 원인을 못 판정했다는 사실을 화면이 알 수 있게 `error` 로.
 */
async function unassignedInfoFor(tg) {
  const unassigned = (tg.skipped || []).filter((x) => x.reason === 'unassigned');
  if (!unassigned.length) return { total: 0, byCause: {}, samples: [], truncated: 0, assignKeys: 0 };
  try {
    const [{ loadRegistry }, { loadFleetAssign }] = await Promise.all([
      import('../../idrac/registry.js'), import('../../insights/fleetAssign.js'),
    ]);
    return unassignedCauses({
      unassigned,
      registry: (() => { try { return loadRegistry(); } catch { return []; } })(),
      assign: (() => { try { return loadFleetAssign(); } catch { return {}; } })(),
      vcenterIds: (tg.vcenters || []).map((v) => v.id),
    });
  } catch (e) {
    return { total: unassigned.length, byCause: {}, samples: [], truncated: 0, assignKeys: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * 엣지 보관분 — **네트워크에 나가지 않는다**(v2.554). 중앙이 이미 당겨 둔 값만 보여준다.
 * 사용자 지시 "엣지에서 종합하고 중앙으로 전달은 중앙에서 조회할때만" 이라 상시 push 가 없으므로,
 * 여기서 폴링하면 그 설계가 무의미해진다 — 화면은 마운트 1회 + 버튼(v2.508 규약).
 */
api.get('/tools/bm-usage/edges', toolsPerm, async (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  try {
    const { listEdgeBmUsage, MIN_EDGE_VERSION, STALE_MS } = await import('../../central/bmUsageEdgePull.js');
    const { loadCollectors } = await import('../../collector/registry.js');
    const cols = (() => { try { return loadCollectors(); } catch { return []; } })();
    const stored = listEdgeBmUsage();
    const byName = new Map(stored.map((x) => [t(x.agent).toLowerCase(), x]));
    /*
     * ⚠ **등록부를 기준으로 줄을 만든다** — 보관분만 나열하면 '한 번도 당기지 않은 엣지' 가
     *   목록에서 사라져 화면이 '전부 봤다' 는 거짓을 말한다(v2.548 `classifyEdges` 와 같은 판단).
     */
    const isAdmin = req.user?.role === 'admin';
    const edgeUrls = cols.map((c) => t(c.url)).filter(Boolean);
    // v2.601 AUTHZ-2601-01: 엣지 보관분의 대상·최신값·정지 목록도 식별자가 주소인 행을 가린다.
    const regHosts = isAdmin ? [] : await bmAddressHosts(null);
    const rows0 = cols.filter((c) => t(c.name)).map((c) => {
      const rec = byName.get(t(c.name).toLowerCase()) || null;
      const snap = rec?.snap || null;
      // v2.600 AUTHZ-2600-08: 엣지 보관분의 대상도 비-admin 에는 관리 주소를 가린다.
      const targets0 = snap ? applyScope(snap.targets || [], allowed) : [];
      const snapHosts = isAdmin ? [] : [...regHosts, ...targets0.flatMap((x) => [x?.idracHost, x?.osHostName])].filter((h) => typeof h === 'string' && h);
      const em = addressMatcher(snapHosts);
      const targets = isAdmin ? targets0 : targets0.map((x) => maskTargetAddress(x, snapHosts, em));
      const keys = new Set(targets0.map((x) => t(x.key)));
      return {
        agent: c.name, enabled: c.enabled !== false, hasUrl: !!t(c.url),
        at: rec?.at || null, snapAt: rec?.snapAt || null,
        // 실패 사유 문구에는 엣지 URL 이 실릴 수 있다 — 비-admin 에는 가린다(범위 계정은 아래에서 통째로 비운다).
        lastAttempt: rec?.lastAttempt
          ? (isAdmin ? rec.lastAttempt : { ...rec.lastAttempt, reason: scrubHosts(rec.lastAttempt.reason, edgeUrls) })
          : null,
        // ⚠ 엣지가 말한 이름을 **나란히** 둔다(다르면 그 자체가 진단 — v2.548 F5·v2.549 규약).
        reportedAgent: snap?.node?.agent || '', version: snap?.node?.version || '',
        enabledOnEdge: snap ? !!snap.enabled : null,
        /*
         * ⚠⚠ v2.574 SEC-03 — **같은 객체 리터럴 안에서 일부 필드만 거르면 안 된다.**
         *   `counts`·`skippedCounts` 는 `!allowed` 로 올바로 막고 있었는데 바로 옆의
         *   `settings`·`authStops` 는 무필터라 범위 제한 계정에 다른 법인 정보가 나갔다:
         *     · `settings.corps` = **수집을 켠 법인 목록**(그 자체가 조직 구성이다)
         *     · `authStops[].key` = 정지 대상 서버 키(`<agent>|os|<key>`)
         *   v2.550.3 이 `status.last.counts.byReason` 에서 이미 겪은 것과 **같은 유형**이다
         *   ("scope 를 고칠 때는 그 데이터가 응답에 실리는 경로를 **전부** 찾을 것").
         */
        settings: scopeEdgeSettings(snap?.settings, allowed),
        targets, rows: snap ? (isAdmin ? (l) => l : (l) => maskBmList(l, em))((snap.rows || []).filter((r) => keys.has(t(r.key)))) : [],
        counts: snap && !allowed ? (snap.counts || {}) : null,
        skippedCounts: snap && !allowed ? (snap.skippedCounts || {}) : null,
        truncated: snap?.truncated || 0,
        // 정지 목록은 **보이는 대상의 것만** — 키가 곧 범위 밖 서버의 식별자다.
        authStops: (isAdmin ? (l) => l : (l) => maskBmList(l, em))((snap?.authStops || []).filter((a) => !allowed || keys.has(t(a?.key)))),
      };
    });
    /*
     * v2.600 AUTHZ-2600-07: 엣지는 vCenter 귀속이 없다 — 범위 제한 계정에는 **자기 범위 대상이 보이는
     *   엣지 행만** 주고, 그 행의 인출 시도 기록(lastAttempt — 엣지 전체의 운영 정보)은 비운다.
     *   예전에는 대상이 0개인 엣지까지 전 사이트 이름·버전·시도 결과가 그대로 나갔다. 뺀 개수는 밝힌다.
     */
    const rows = allowed ? rows0.filter((r) => r.targets.length > 0).map((r) => ({ ...r, lastAttempt: null })) : rows0;
    res.json({
      ok: true, at: Date.now(), rows, minEdgeVersion: MIN_EDGE_VERSION, staleMs: STALE_MS,
      ...(allowed ? { scoped: true, edgesOmitted: rows0.length - rows.length } : {}),
      ...(isAdmin ? {} : { addressHidden: true }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/**
 * 엣지에서 지금 당긴다(사람이 누를 때만). 상태를 바꾸지는 않지만 **외부로 나가는 동작**이라
 * writeRole + 감사. ⚠ 연타 방지는 엣지당 한 번에 하나(중앙 인메모리 플래그).
 */
const _pulling = new Set();
api.post('/tools/bm-usage/edges/pull', writeRole, toolsPerm, async (req, res) => {
  // ⚠ 엣지 목록·보관분에는 다른 법인 서버가 섞여 있다 — 당기는 동작은 **전체 범위 계정만**.
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, requiredOwner: true, reason: '엣지 인출은 전체 범위 계정만 할 수 있습니다(엣지는 법인 축으로 나눌 수 없습니다).' });
  }
  const agents = Array.isArray(req.body?.agents) ? req.body.agents.map(t).filter(Boolean).slice(0, 40) : [];
  if (!agents.length) return res.status(400).json({ ok: false, reason: '가져올 엣지 이름이 필요합니다.' });
  try {
    const { pullBmUsage } = await import('../../central/bmUsageEdgePull.js');
    const results = [];
    for (const a of agents) {
      if (_pulling.has(a.toLowerCase())) { results.push({ agent: a, ok: false, kind: 'busy', reason: '이 엣지에서 이미 가져오는 중입니다.' }); continue; }
      _pulling.add(a.toLowerCase());
      try { results.push({ agent: a, ...(await pullBmUsage(a, { limit: Number(req.body?.limit) || 0 })) }); }
      finally { _pulling.delete(a.toLowerCase()); }
    }
    logAudit({
      user: req.user?.username, action: 'bm-usage.edge-pull', ip: req.ip || '',
      detail: JSON.stringify({ agents: agents.length, ok: results.filter((r) => r.ok).length }).slice(0, 300),
    });
    // ⚠ 응답에 `rec.snap` 을 담지 않는다(수 백 KB) — 화면은 `/edges` 로 다시 읽는다.
    res.json({ ok: true, results: results.map(({ agent, ok, kind, reason, ms }) => ({ agent, ok, kind, reason, ms })) });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/** 설정 — 법인 on/off·주기·보존. 수집 범위를 바꾸는 동작이라 admin 전용 + 감사. */
api.put('/tools/bm-usage/settings', adminOnly, (req, res) => {
  /*
   * ⚠⚠ **Enterprise 대체 수집 동의는 '누가·언제' 를 기록한다**(v2.554 — 사용자 지시 "사용할
   *   것이냐고 물어보고 사용하겠다고 하면"). 장비에 부하를 더하는 결정이라 근거를 남긴다.
   * ⚠ 동의를 서버가 대신 켜지 않는다 — 본문에 `enterpriseAck:true` 가 와야 한다
   *   (`normalizeSettings` 가 `enabled && ack` 로 못 박는다).
   */
  const body = { ...(req.body || {}) };
  const prev = loadBmUsageSettings();
  if (body.enterpriseAck === true && !prev.enterpriseAck) {
    body.enterpriseAckAt = Date.now();
    body.enterpriseAckBy = String(req.user?.username || '').slice(0, 64);
  }
  const next = saveBmUsageSettings(body);
  logAudit({
    user: req.user?.username, action: 'bm-usage.settings', ip: req.ip || '',
    detail: JSON.stringify({
      enabled: next.enabled, corps: Object.keys(next.corps).length,
      intervalMs: next.intervalMs, rawRetentionDays: next.rawRetentionDays, dailyRetentionDays: next.dailyRetentionDays,
      // v2.551 — 수집 범위·알림을 바꾸는 동작이라 감사에 남긴다.
      idracFullTelemetry: next.idracFullTelemetry, alertEnabled: next.alertEnabled,
      // v2.554 — 장비 부하를 더하는 결정이라 감사에 남긴다(동의 여부·모드).
      enterpriseEnabled: next.enterpriseEnabled, enterpriseAck: next.enterpriseAck, enterpriseMode: next.enterpriseMode,
      alertPct: next.alertPct, alertSustainMin: next.alertSustainMin, alertRepeatHours: next.alertRepeatHours,
    }).slice(0, 300),
  });
  // v2.583 #36: 비어 있어 **저장하지 않은** 숫자 칸을 밝힌다(조용히 버리면 '저장했는데 왜 그대로지' 가 된다).
  const { dropped } = dropUnspecifiedNumbers(req.body || {});
  res.json({ ok: true, settings: next, ...(dropped.length ? { ignoredBlank: dropped } : {}) });
});

}
