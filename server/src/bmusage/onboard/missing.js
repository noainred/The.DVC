/**
 * bmusage/onboard/missing.js — 누락 점검(7b단계 · 설계 PROFILES §18 '누락 점검'). 순수.
 *
 * 칸: both(둘 다) · os(OS 만) · idrac(iDRAC 만) · none(없음 — 경로 없음 사유) · unassigned(미귀속) · unknown(모름 — 아직 수집 기록이 없거나 엣지 보관분이 없다).
 *  · 읽힘 칸(both · os · idrac · none)은 **보드 커버리지와 같은 값** — 이 노드는 `perfForRows → buildPerfEntry → useJudge.coverageOf` 의 결과(entry.coverage),
 *    엣지 서버는 그 엣지가 같은 함수로 만든 봉투 perf 의 coverage 를 그대로 쓴다(여기서 다시 판정하지 않는다).
 *  · 수집 기록이 없는 서버는 none 이 아니라 **unknown**(못 읽음 ≠ 없음 — 7a 반증 교훈). 사유 있는 제외(no-os-cred · no-idrac · corp-off …)는 none + 사유.
 *  · 제안(suggest): OS 만 · iDRAC 만 서버의 등록 CSV 한 줄을 미리 채운다(이름 · 법인 · 알고 있는 주소 · 서비스 태그). **자동 등록 없음** — 사람이 고쳐 올린다.
 *    OS 주소는 서버 이름이 FQDN 꼴일 때만 제안(DNS 를 조회하지 않는다 — 이름 일치 ‘제안’ 일 뿐).
 */
const t = (v) => String(v ?? '').trim();
export const BUCKETS = Object.freeze(['both', 'os', 'idrac', 'none', 'unassigned', 'unknown', 'untracked']);
const looksFqdn = (s) => /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))+$/i.test(s) && !/^\d+(\.\d+){3}$/.test(s);

/**
 * @param {object} p
 * @param {object[]} p.targets    이 노드 대상(resolveTargets.targets — publicTarget 이전이어도 osHost 는 읽지 않는다)
 * @param {object[]} p.skipped    resolveTargets.skipped
 * @param {Map<string,object>} p.entryByKey  이 노드 perf 항목(key → {coverage})
 * @param {(agent:string, key:string)=>object|null} [p.edgeEntry]  엣지 봉투 perf 항목
 * @param {(vc:string)=>string} [p.vcName]
 */
export function missingCheck({ targets = [], skipped = [], entryByKey = new Map(), edgeEntry = null, vcName = (v) => v, osRegistry = null } = {}) {
  const rows = [];
  // 반증 F4: OS 계정 등록부에만 있고 이 노드 함대(iDRAC · vCenter)에 없는 서버 — 성능 수집 대상이 아니다(bmstor 디스크 용량만). 대상 집합은 바꾸지 않고 '보이게' 만 한다.
  if (Array.isArray(osRegistry)) {
    const usedIds = new Set(targets.map((x) => t(x.osHost?.id)).filter(Boolean));
    const names = new Set([...targets, ...skipped].map((x) => t(x.name).toLowerCase()).filter(Boolean));
    for (const e of osRegistry) {
      if (!e || usedIds.has(t(e.id)) || names.has(t(e.name).toLowerCase())) continue;
      rows.push({ key: `os:${t(e.id)}`, name: t(e.name), serviceTag: '', vcenterId: t(e.vcenterId), via: 'local', paths: [], bucket: 'untracked', reason: 'registry-only', idracHost: '', osHost: t(e.host), missing: [] });
    }
  }
  for (const x of targets) {
    const e = entryByKey.get(t(x.key));
    const cov = e && BUCKETS.includes(e.coverage) ? e.coverage : null;
    rows.push({ key: t(x.key), name: t(x.name), serviceTag: t(x.serviceTag), vcenterId: t(x.vcenterId), via: 'local', paths: Array.isArray(x.paths) ? x.paths : [],
      bucket: cov || 'unknown', reason: cov ? '' : 'no-record', idracHost: x.idrac?.host || '', missing: x.missing || [] });
  }
  for (const s of skipped) {
    const base = { key: t(s.key), name: t(s.name), serviceTag: t(s.serviceTag), vcenterId: t(s.vcenterId), paths: [], idracHost: '', missing: [] };
    if (s.reason === 'unassigned') { rows.push({ ...base, via: 'local', bucket: 'unassigned', reason: 'unassigned' }); continue; }
    if (s.reason === 'edge-delegated') {
      // 재확인 R1: 엣지 이름이 다른 수집 서버의 id · 이름과 겹치면(agentClash) 그 이름으로 찾은 엣지 보관분이 다른 엣지 것일 수 있다 — 찾지 않고 '모름'.
      if (s.agentClash) { rows.push({ ...base, via: 'edge', agent: t(s.agent), bucket: 'unknown', reason: 'edge-name-clash' }); continue; }
      // 반증 의심 1: 원격 위임 행은 엣지 쪽 키(edgeKey — 서비스태그 없는 서버의 엣지 등록 id)로 찾는다. 없으면 중앙 키(서비스태그면 두 노드가 같다).
      const e = typeof edgeEntry === 'function' ? edgeEntry(t(s.agent), t(s.edgeKey) || t(s.key)) : null;
      const cov = e && BUCKETS.includes(e.coverage) ? e.coverage : null;
      rows.push({ ...base, via: 'edge', agent: t(s.agent), bucket: cov || 'unknown', reason: cov ? '' : 'edge-no-record' });
      continue;
    }
    // v2.961: 원격 수집 서버가 맡았는데 그 수집 서버를 모르는 서버 — 어느 엣지인지 모르므로 '없음' 이 아니라 '모름'(못 읽음 ≠ 없음).
    if (s.reason === 'remote-collector-unknown') { rows.push({ ...base, via: 'edge', agent: '', bucket: 'unknown', reason: 'remote-collector-unknown' }); continue; }
    rows.push({ ...base, via: 'local', bucket: 'none', reason: t(s.reason) || 'unknown' });
  }
  for (const r of rows) {
    if (r.bucket !== 'os' && r.bucket !== 'idrac') continue;
    r.suggest = {
      name: r.name, corp: r.vcenterId ? vcName(r.vcenterId) : '미귀속', service_tag: r.serviceTag,
      ...(r.bucket === 'idrac' && looksFqdn(r.name) ? { os_host: r.name } : {}),
      ...(r.idracHost ? { idrac_host: r.idracHost.replace(/^https?:\/\//, '') } : {}),
      collect_via: r.via === 'edge' ? 'edge' : 'auto',
    };
  }
  // v2.945.1: 화면 필터(법인) 라벨 — 이름은 vcName 하나로(화면이 id 를 다시 풀지 않게).
  for (const r of rows) r.corp = r.vcenterId ? t(vcName(r.vcenterId)) || r.vcenterId : '';
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length]));
  return { rows, counts };
}
