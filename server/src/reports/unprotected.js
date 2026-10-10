/**
 * 미보호 VM 리포트(백업 공백 탐지) — 별도 백업 솔루션 연동 없이, vCenter 이벤트에 남는
 * 백업 소프트웨어의 흔적으로 판정한다: Veeam/Commvault/NetBackup 등은 백업 시 서비스 계정으로
 * VM 스냅샷을 생성·삭제하므로, 조회 기간 내 '백업 계정의 스냅샷 이벤트'가 관측된 VM을
 * 보호(protected)로 본다. 휴리스틱임을 리포트에 명시한다(이벤트 보관 기간·계정 패턴 의존).
 */

import { numOrNull } from '../util/numOrNull.js'; // v2.727(C-01)

export const DEFAULT_BACKUP_PATTERNS = ['veeam', 'backup', 'commvault', 'netbackup', 'nbu', 'avamar', 'rubrik', 'cohesity', 'networker', 'vranger', 'nakivo'];

/**
 * v2.606(감사 SEC2606-02): 사용자가 주는 패턴 목록 상한. 예전에는 개수·길이 상한이 없어 operator 요청 1건
 * (패턴 약 5,300개)이 2만 행 × 패턴 수 동기 비교로 이벤트 루프를 약 4.4초 막았다(memo 키가 URL 이라 캐시로 안 막힌다).
 * 넘친 개수·너무 긴 항목은 **버리고 개수를 밝힌다**(긴 항목을 잘라 쓰면 더 넓게 맞는 다른 패턴이 된다).
 */
export const MAX_PATTERNS = 32;
export const MAX_PATTERN_LEN = 64;

/** 쉼표 문자열 또는 배열 → { patterns(소문자·중복 제거·상한 적용), omitted, tooLong }. */
export function normalizePatterns(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out = [];
  const seen = new Set();
  let omitted = 0, tooLong = 0;
  for (const x of list) {
    const p = String(x ?? '').trim().toLowerCase();
    if (!p) continue;
    if (p.length > MAX_PATTERN_LEN) { tooLong++; continue; }
    if (seen.has(p)) continue;
    if (out.length >= MAX_PATTERNS) { omitted++; continue; }
    seen.add(p); out.push(p);
  }
  return { patterns: out, omitted, tooLong };
}

/** 소문자화가 끝난 패턴 목록으로 판정(내부 — 행마다 패턴을 다시 소문자화하지 않는다, v2.606 SEC2606-02). */
function matchesLower(row, lowerPatterns) {
  if (!/Snapshot/i.test(row.type || '')) return false;
  const hay = `${row.user || ''} ${row.message || ''}`.toLowerCase();
  for (const p of lowerPatterns) if (p && hay.includes(p)) return true;
  return false;
}

/** 이벤트 1건이 '백업 소프트웨어의 스냅샷 작업'인지 — user 또는 message에 패턴 매칭. */
export function isBackupEvent(row, patterns = DEFAULT_BACKUP_PATTERNS) {
  return matchesLower(row, patterns.map((p) => String(p ?? '').toLowerCase()));
}

/**
 * vms: 스냅샷 VM 배열. rows: 조회 기간의 스냅샷 이벤트(logs db). 반환: 보호/미보호 분류.
 * opts: { patterns, lookbackDays }
 */
export function computeUnprotected(vms, rows, opts = {}) {
  // v2.606(SEC2606-02): 상한을 여기서도 적용한다(라우트 밖 호출부 방어). 버린 개수는 config 에 밝힌다.
  //   사용자 패턴이 하나도 남지 않으면(비었거나 전부 너무 김) 예전처럼 기본 패턴을 쓴다.
  const given = normalizePatterns(opts.patterns || []);
  const norm = given.patterns.length ? given : normalizePatterns(DEFAULT_BACKUP_PATTERNS);
  const patterns = norm.patterns;
  const patternsOmitted = given.omitted + given.tooLong;
  const lookbackDays = Number(opts.lookbackDays) || 7;

  // (vCenter, VM 이름) → 마지막 백업 이벤트 시각.
  // ⚠ v2.583 감사 #21: 예전에는 **이름만** 키로 써서, 28개 법인 중 한 곳의 `web-01` 이 백업되면 다른 법인의
  //   같은 이름 VM 까지 '보호됨' 으로 셌다 — 백업 공백을 찾는 리포트가 공백을 **숨겼다**(가장 나쁜 방향의 오류).
  //   이벤트 행에 vcenterId 가 있으면 반드시 그것까지 맞춘다. vcenterId 가 없는 옛 행만 이름으로 폴백하고
  //   그 개수를 밝힌다(nameOnlyEvents).
  const key = (vc, name) => `${vc}\u0000${name}`;
  const protectedByVcName = new Map();
  const protectedByNameOnly = new Map();
  let backupEvents = 0, nameOnlyEvents = 0;
  const keep = (m, k, r) => { const prev = m.get(k); if (!prev || r.ts > prev.ts) m.set(k, { ts: r.ts, user: r.user || '' }); };
  for (const r of rows || []) {
    if (!matchesLower(r, patterns)) continue;
    backupEvents++;
    const name = r.entity || '';
    if (!name) continue;
    if (r.vcenterId) keep(protectedByVcName, key(r.vcenterId, name), r);
    else { nameOnlyEvents++; keep(protectedByNameOnly, name, r); }
  }

  // v2.622(감사 DATA-05 — 재현: 이벤트를 수집하지 않은 vCenter 의 VM 이 전부 '미보호' 로 세였다): 이벤트는 포탈마다 로컬
  //   보관이라 엣지 위임 vCenter·로그 수집 꺼짐·최소 심각도 warning 이상이면 스냅샷(info) 이벤트가 이 DB 에 없다. 그 VM 을
  //   미보호로 세면 거짓 '백업 공백' 이다. 호출자가 준 근거로만 '판정 불가' 로 분리한다(근거가 없으면 예전처럼 판정한다 —
  //   스냅샷 이벤트 0건을 곧 '미수집' 으로 보면 진짜 백업 공백을 숨긴다).
  //   · opts.logSettings — { enabled, minSeverity }: 수집이 꺼졌거나 info 를 저장하지 않으면 전 VM 판정 불가.
  //   · opts.coveredVcenterIds — 조회 창 안 **이벤트(종류 무관)가 1건이라도 저장된** vCenter 집합. 없는 vCenter 의 VM 은 판정 불가.
  const ls = opts.logSettings || null;
  const logBlocked = ls && ls.enabled === false ? 'log-collection-off'
    : ls && ls.minSeverity && ls.minSeverity !== 'info' ? 'severity-filter' : null;
  const covered = opts.coveredVcenterIds == null ? null
    : new Set([...(opts.coveredVcenterIds instanceof Set ? opts.coveredVcenterIds : opts.coveredVcenterIds)].map(String));
  //   · opts.notCollectedVcenterIds(v2.732) — 이 포탈이 지금 직접 수집하지 않는 vCenter. 창 안에 옛 이벤트가 있어도 판정 불가('not-collected').
  //     v2.733(C1-01): Map(id → 사유)도 받는다(logs/coverage.js eventNotCollectedMap) — 사유는 summary.notCollectedVcenters 에 싣는다.
  const ncWhy = opts.notCollectedVcenterIds instanceof Map
    ? new Map([...opts.notCollectedVcenterIds].map(([k, v]) => [String(k), v == null ? null : String(v)])) : null;
  const notCollected = opts.notCollectedVcenterIds == null ? null
    : ncWhy ? new Set(ncWhy.keys()) : new Set([...opts.notCollectedVcenterIds].map(String));
  const undeterminedList = [];
  const undeterminedByReason = {};
  const unprotectedList = [];
  const protectedList = [];
  for (const v of vms) {
    if (v.template || v.powerState !== 'POWERED_ON') continue; // 가동 중 VM만 보호 대상 판단
    const hit = protectedByVcName.get(key(v.vcenterId, v.name)) || protectedByNameOnly.get(v.name);
    const item = {
      id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host || '', cluster: v.cluster || '',
      guestOS: v.guestOS || '', storageGB: numOrNull(v.storageGB),   // v2.727(C-01): 못 읽은 용량은 null(0 GB 아님)
    };
    if (hit) { protectedList.push({ ...item, lastBackupTs: hit.ts, backupUser: hit.user }); continue; }
    // v2.732(B4-01 후속): 중앙이 지금 직접 수집하지 않는 vCenter(비활성·점검중·엣지 위임)는 남은 옛 이벤트로 판정하지 않는다 — 'not-collected'.
    const why = logBlocked || (notCollected && notCollected.has(String(v.vcenterId)) ? 'not-collected'
      : (covered && !covered.has(String(v.vcenterId)) ? 'no-events' : null));
    if (why) {
      undeterminedByReason[why] = (undeterminedByReason[why] || 0) + 1;
      undeterminedList.push({ ...item, reason: why });
    } else unprotectedList.push(item);
  }
  const byStorageDesc = (a, b) => (b.storageGB ?? -1) - (a.storageGB ?? -1);   // v2.727(C-01): 값 있는 것 먼저
  undeterminedList.sort(byStorageDesc);
  const noEventVcenters = covered
    ? [...new Set(undeterminedList.filter((x) => x.reason === 'no-events').map((x) => String(x.vcenterId)))] : [];
  // v2.733(C1-01): 지금 수집하지 않아 판정하지 않은 vCenter 별 개수·사유(사유를 모르면 null — Set 으로 받은 경우).
  const ncCount = new Map();
  for (const x of undeterminedList) if (x.reason === 'not-collected') ncCount.set(String(x.vcenterId), (ncCount.get(String(x.vcenterId)) || 0) + 1);
  const notCollectedVcenters = [...ncCount].map(([vcenterId, vms]) => ({ vcenterId, why: ncWhy ? (ncWhy.get(vcenterId) ?? null) : null, vms }))
    .sort((a, b) => b.vms - a.vms || (a.vcenterId < b.vcenterId ? -1 : 1));
  unprotectedList.sort(byStorageDesc);
  protectedList.sort((a, b) => b.lastBackupTs - a.lastBackupTs);

  return {
    config: { patterns, lookbackDays, patternsOmitted, maxPatterns: MAX_PATTERNS, maxPatternLen: MAX_PATTERN_LEN },
    summary: {
      scannedVms: unprotectedList.length + protectedList.length,
      protectedCount: protectedList.length,
      unprotectedCount: unprotectedList.length,
      backupEvents,
      nameOnlyEvents,
      // 이벤트 조회 상한에 걸렸으면 오래된 백업 흔적이 빠져 '미보호' 가 과대 보고될 수 있다 — 조용히 두지 않는다.
      eventsTruncated: Number(opts.rowLimit) > 0 && (rows || []).length >= Number(opts.rowLimit),
      // v2.622(DATA-05): 분모는 판정한 VM(보호+미보호)이다. 판정 불가만 있으면 0% 가 아니라 null.
      protectedPct: (unprotectedList.length + protectedList.length) > 0
        ? Math.round((protectedList.length / (unprotectedList.length + protectedList.length)) * 100)
        : (undeterminedList.length > 0 ? null : 0),
      undeterminedCount: undeterminedList.length,        // v2.622(DATA-05): 이벤트 미수집으로 판정하지 않은 가동 VM 수
      undeterminedByReason,                              // { 'log-collection-off' | 'severity-filter' | 'no-events': N }
      noEventVcenters,                                   // 조회 창 안 이벤트가 0건이라 판정하지 않은 vCenter id
      notCollectedVcenters,                              // v2.733: 지금 수집하지 않아 판정하지 않은 vCenter {vcenterId, why, vms}
      coverageKnown: covered != null || ls != null,      // 호출자가 커버리지 근거를 줬는가(false 면 예전 판정 그대로)
    },
    unprotected: unprotectedList.slice(0, 1000),
    protected: protectedList.slice(0, 1000),
    undetermined: undeterminedList.slice(0, 1000),
    note: '휴리스틱 판정: 조회 기간 내 백업 계정 패턴의 VM 스냅샷 이벤트가 관측된 VM을 보호로 간주합니다. 스냅샷을 쓰지 않는 백업(에이전트 방식 등)은 미보호로 보일 수 있습니다.',
  };
}
