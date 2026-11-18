/**
 * views/hosts/hostInsightText.js — Hypervisor 탭 ‘분석’ 보기(v3.22.0 · 설계 docs/design/host-insight · 시안 HostInsight.dc.html — 사용자 확정 기본값)의 호스트 전용 순수 계산(vitest 고정).
 *
 * 값은 서버 GET /api/hosts/insight(vcenter/hostInsight.js — 법인마다 한 줄 · 클러스터마다 한 줄 · 법인마다 상위 N)이고, 화면은 고른 법인의 줄을 더하기만 한다(insight/insightCore.js).
 *  · 새 판정을 만들지 않는다 — 과부하 · 확인 대상 · 하드웨어 · 재부팅 · 한 대 빠진 뒤 여유(n1Ok) · HA · 수용 제어 · DRS 는 서버 값 그대로.
 *    기준값(과부하 % · 사용률 경계 · N+1 한도 · 칸 폭 · VM 수 구간 · 상위 N · 재부팅 기간)은 응답의 thresholds — 화면에 박지 않는다.
 *  · 못 읽은 값은 0 이 아니다 — 모르는 수는 null('—'), 사용률 못 읽음 · 용량 모름 · 여유에서 뺀 호스트 · 설정 미수집은 ‘모름 N’ 으로 따로.
 *    오래됨(stale) · 모름(unknown) 법인은 합에 넣지 않는다(pickRows).
 *  · 권한이 없는 묶음(access.cluster · hw · hygiene)의 칸은 0 이 아니라 **숨긴다**(서버는 그 키를 싣지 않는다).
 */
import { numOrNull } from '../../numOrNull.js';
import { hashSegments } from '../../hooks/hashTab.js';
import { addVal, sumKeys, avgOf, mergeTopN, shareOf, shareText, fmtN, gbText, round1 } from '../insight/insightCore.js';
import { tileColors, scaleLegend, RAMP, CRIT_BG, NONE_BG } from '../insight/treemap.js';
import { hostAvgMemGB as toolHostAvgMemGB, hostsEq } from '../vms/insight-tools/toolSumText.js';   // S2 환산 판정 한 벌(VM 분석 · 과할당과 같은 함수)

// ── 보기 줄 · 주소 ──
// 첫 보기 ‘분석’(insight — #/hosts 를 열면 이 화면) · 지금 호스트 표는 ‘목록’(list) · ‘법인별’(corp). 주소 #/hosts/<보기>.
//   호스트 상세 #/hosts/<id> 는 그대로 열린다 — 호스트 id 는 ‘vCenter id:moRef’ 꼴이라 보기 키와 겹치지 않고, 겹쳐도 보기 키가 먼저다(hostIdOfHash).
export const HOST_VIEWS = Object.freeze([['insight', '분석'], ['list', '목록'], ['corp', '법인별']]);
export const HOST_VIEW_KEYS = Object.freeze(HOST_VIEWS.map(([k]) => k));
export const HOST_HUB_BASE = Object.freeze(['hosts']);

/** 주소의 둘째 칸이 보기 키면 그 키 · 아니면 null. */
export function hostViewInHash(hash) {
  const s = hashSegments(hash);
  return s[0] === 'hosts' && HOST_VIEW_KEYS.includes(s[1]) ? s[1] : null;
}
/** #/hosts/<id> 의 호스트 id(상세 전체 페이지) — 보기 키 · 빈 칸이면 ''. */
export function hostIdOfHash(hash) {
  const s = hashSegments(hash);
  if (s[0] !== 'hosts' || !s[1] || HOST_VIEW_KEYS.includes(s[1])) return '';
  try { return decodeURIComponent(s[1]); } catch { return s[1]; }
}
/**
 * 주소에 보기가 없을 때(#/hosts) 여는 보기 — 기본 ‘분석’. 단 검색어(범위 바 검색 · ⌘K)나 VM 표에서 넘어온 ‘그 호스트만’(nameFocus)이 있으면
 * ‘목록’(분석 보기는 검색어 · 호스트 이름을 쓰지 않는다 — 넘겨받은 조건의 결과가 보이게. VM 탭 hubDefaultView 와 같은 규칙).
 */
export function hostViewOf(hashView, { q = '', nameFocus = '' } = {}) {
  if (HOST_VIEW_KEYS.includes(hashView)) return hashView;
  return String(q || '').trim() || String(nameFocus || '').trim() ? 'list' : 'insight';
}
export const hostViewHash = (k) => `#/hosts/${HOST_VIEW_KEYS.includes(k) ? k : 'insight'}`;

// ── 법인 줄 합 ──
/** 서버 hostInsight.js 법인 줄의 수 · 합 키(신원 · 비율 제외) — 이 키만 더한다. 비율(vcpuPerCore · ramPct)은 합한 뒤 다시(ratiosOf). */
export const HOST_STAT_KEYS = Object.freeze([
  'hosts', 'attention', 'overloaded', 'clusterCount', 'standalone', 'cores', 'capUnknown', 'sockets', 'socketsUnknown', 'threads', 'threadsUnknown',
  'memTotalMB', 'vms', 'templates', 'vcpu', 'vcpuUnknown', 'memVmMB', 'memUnknown', 'powerW', 'esxi', 'model', 'vendor',
  'cpuHist', 'memHist', 'usageUnknown', 'histOut', 'cpuAvg', 'memAvg', 'over90', 'vmsPerHost', 'headroom', 'clusters', 'hw', 'reboots30d', 'rebootsUnread',
]);

/**
 * 비율 — 한 법인이면 서버 값 그대로(/hosts/corp 와 같은 값), 여럿이면 서버 hostCorp.ratios 와 같은 규칙으로 합에서 다시:
 * 용량 모름 호스트가 하나라도 있으면 null(분모가 모자란 비율을 지어내지 않는다) · 분자를 못 읽었으면 null.
 */
export function ratiosOf(used, s) {
  const list = Array.isArray(used) ? used : [];
  if (list.length === 1) return { vcpuPerCore: numOrNull(list[0].vcpuPerCore), ramPct: numOrNull(list[0].ramPct) };
  const ok = numOrNull(s?.capUnknown) === 0 && numOrNull(s?.cores) != null;
  const cores = numOrNull(s?.cores); const vcpu = numOrNull(s?.vcpu);
  const mem = numOrNull(s?.memTotalMB); const vmMem = numOrNull(s?.memVmMB);
  return {
    vcpuPerCore: ok && vcpu != null && cores > 0 ? Math.round((vcpu / cores) * 10) / 10 : null,
    ramPct: ok && vmMem != null && mem != null && mem > 0 ? Math.round((vmMem / mem) * 100) : null,
  };
}

/** 고른 법인 줄의 합 — 평균은 Σsum ÷ Σn 으로 다시. 줄이 없으면 수 키가 전부 null. */
export function sumHostRows(rows) {
  const s = sumKeys(rows, HOST_STAT_KEYS);
  if (s.cpuAvg) s.cpuAvg = { ...s.cpuAvg, value: avgOf(s.cpuAvg) };
  if (s.memAvg) s.memAvg = { ...s.memAvg, value: avgOf(s.memAvg) };
  Object.assign(s, ratiosOf(rows, s));
  return s;
}

/** 지역 이름 — 비면 ‘리전 미지정’. */
export const regionName = (r) => { const v = String(r ?? '').trim(); return !v || v === 'Unknown' ? '리전 미지정' : v; };
/** 법인 표시 이름 — 이름이 없으면 id. */
export const corpName = (r) => String(r?.name || r?.id || '');
/** MB → GB(소수 1자리) — 모르면 null. */
export const mbToGb = (mb) => { const n = numOrNull(mb); return n == null ? null : Math.round((n / 1024) * 10) / 10; };
const unkText = (n, what = '모름', unit = '대') => ((numOrNull(n) ?? 0) > 0 ? ` · ${what} ${fmtN(n)}${unit}` : '');

/** S2 — 고른 범위 호스트 한 대의 평균 메모리(GB) · 판정은 toolSumText.hostAvgMemGB 하나(용량을 읽은 호스트만 · 오래됨 제외). 모르면 null. */
export function hostAvgMemGB(used) {
  const corps = (Array.isArray(used) ? used : []).map((r) => ({
    id: r.id, stale: r.stale === true, memTotalGB: mbToGb(r.memTotalMB), hosts: numOrNull(r.hosts?.total), capUnknown: numOrNull(r.capUnknown),
  }));
  const a = toolHostAvgMemGB(corps, []);
  return a && a.avgGB > 0 ? a.avgGB : null;
}
/** 메모리(GB)가 호스트 몇 대분인가 — toolSumText.hostsEq 그대로(메모리에만 쓴다 — 설계 §9 정정). 기준이 없으면 null. */
export const hostsEquivalent = (memGB, avgGB) => hostsEq(memGB, avgGB);

/** kW 글자 — W 합. 읽은 호스트가 없으면 '—'. */
export function kwText(w) {
  const n = numOrNull(w?.sum); const k = numOrNull(w?.n);
  if (n == null || k == null || k <= 0) return '—';
  return `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} kW`;
}

/** 요약 6장. s = sumHostRows 결과, corpN = 합에 넣은 법인 수. */
export function kpiView(s, corpN) {
  const h = s?.hosts || {};
  const total = numOrNull(h.total);
  const cl = s?.clusters || {};
  const pw = s?.powerW || {};
  const pwN = numOrNull(pw.n);
  const memGB = mbToGb(s?.memTotalMB);
  const vmMemGB = mbToGb(s?.memVmMB);
  const ratio = numOrNull(s?.vcpuPerCore);
  return [
    { key: 'total', label: '전체 호스트', value: fmtN(total), sub: `클러스터 ${fmtN(cl.total)} · 독립 ${fmtN(s?.standalone)} · 법인 ${fmtN(corpN)}곳`, tip: '지금 범위의 ESXi 호스트 수' },
    { key: 'conn', label: '연결', value: fmtN(h.connected), meter: shareOf(h.connected, total),
      sub: `${shareText(h.connected, total)} · 점검 ${fmtN(h.maint)} · 끊김 ${fmtN(h.down)}${unkText(h.unread, '사용률 못 읽음')}`, tip: 'vCenter 에 연결된 호스트 — 사용률 못 읽음은 연결됐는데 CPU · 메모리 사용률을 읽지 못한 호스트' },
    { key: 'att', label: '확인 대상', value: fmtN(s?.attention), tone: (numOrNull(s?.attention) ?? 0) > 0 ? 'warn' : '',
      sub: `과부하 ${fmtN(s?.overloaded)} · 끊김 ${fmtN(h.down)} · 점검 ${fmtN(h.maint)}`, tip: '점검 중 · 끊김 · 과부하 호스트(‘목록’ 의 확인 대상과 같은 판정)' },
    { key: 'cores', label: '물리 코어', value: fmtN(s?.cores), sub: `vCPU ${fmtN(s?.vcpu)} · 코어 하나에 ${ratio == null ? '—' : ratio}${unkText(s?.capUnknown, '용량 모름')}`,
      tip: '호스트의 물리 코어 합(용량을 읽은 호스트만) · VM 에 준 vCPU(템플릿 제외)와의 비율' },
    { key: 'mem', label: '메모리', value: gbText(memGB), sub: `VM 에 준 것 ${gbText(vmMemGB)} · ${numOrNull(s?.ramPct) == null ? '—' : `${s.ramPct}%`}${unkText(s?.memUnknown, '할당 모름')}`,
      tip: '호스트 메모리 합(용량을 읽은 호스트만) · VM 에 준 메모리(템플릿 제외)와의 비율' },
    { key: 'power', label: '전력', value: kwText(pw),
      sub: pwN > 0 ? `호스트 한 대 평균 ${fmtN(pw.sum / pwN)} W · 읽은 호스트 ${fmtN(pwN)}대` : '전력을 보고한 호스트가 없습니다', tip: '호스트가 보고한 지금 전력의 합(0 보다 큰 값만 — 센서가 없으면 빠집니다)' },
  ];
}

/**
 * 확인할 것 한 줄(S1) — 권한이 없는 칸은 숨긴다(access.hw · hygiene · cluster). 수는 서버 판정 그대로.
 * @param {object} s     sumHostRows 결과
 * @param {object} access  응답 access
 * @param {object} th    응답 thresholds
 */
export function checkItems(s, access = {}, th = {}) {
  const h = s?.hosts || {};
  const cl = s?.clusters || {};
  const over = numOrNull(th?.overloadPct);
  const boot = numOrNull(th?.bootDays);
  const hw = s?.hw && typeof s.hw === 'object' ? s.hw : null;
  const fault = numOrNull(hw?.fault); const warn = numOrNull(hw?.warn);
  const hwN = fault == null && warn == null ? null : (fault ?? 0) + (warn ?? 0);
  const down = numOrNull(h.down); const maint = numOrNull(h.maint);
  const dm = down == null && maint == null ? null : (down ?? 0) + (maint ?? 0);
  const out = [
    { key: 'overload', label: '과부하 호스트', value: s?.overloaded ?? null, tone: 'crit', sub: over != null ? `CPU ${over}% 초과` : 'CPU 사용률 높음', href: '#/hosts/list',
      tip: 'CPU 사용률이 과부하 기준을 넘은 호스트 — 같은 클러스터의 한가한 호스트로 VM 을 옮길 후보입니다(‘목록’ 의 확인 대상)' },
  ];
  if (access?.hw) {
    out.push({ key: 'hw', label: '하드웨어 장애 · 경고', value: hwN, tone: (fault ?? 0) > 0 ? 'crit' : 'warn',
      sub: `장애 ${fmtN(fault)} · 경고 ${fmtN(warn)}${unkText((numOrNull(hw?.unknown) ?? 0) + (numOrNull(hw?.error) ?? 0), '모름')}`, href: '#/hosts/list',
      tip: 'iDRAC 부품 상태 — 부품은 호스트 빠른 확인에서 봅니다' });
  }
  if (access?.hygiene) {
    out.push({ key: 'reboot', label: boot != null ? `예기치 않은 재부팅(${boot}일)` : '예기치 않은 재부팅', value: s?.reboots30d ?? null, tone: 'warn',
      sub: `${boot != null ? `최근 ${boot}일` : '최근'}${unkText(s?.rebootsUnread, '모름')}`, href: '#/hosts/list',
      tip: '계획하지 않은 재부팅이 있었던 호스트 — 원인(전원 · 패닉 · 펌웨어)을 확인할 대상입니다' });
  }
  if (access?.cluster) {
    out.push({ key: 'n1', label: '못 버티는 클러스터', value: cl.n1Fail ?? null, tone: 'crit', sub: `한 대 빠지면 · 증설 · VM 이전 대상${unkText(cl.n1Unknown, '모름', '개')}`,
      tip: '호스트 한 대가 죽으면 남은 호스트가 VM 을 다 받지 못합니다 — ‘법인별’ 보기의 판정 그대로' });
    out.push({ key: 'ha', label: 'HA 꺼진 클러스터', value: cl.haOff ?? null, tone: 'crit', sub: `VM 이 다시 켜지지 않음${unkText(cl.cfgUnknown, '설정 미수집', '개')}`,
      tip: '호스트가 죽어도 VM 이 다른 호스트에서 다시 켜지지 않습니다' });
  }
  out.push({ key: 'downMaint', label: '끊김 · 점검 중', value: dm, tone: 'warn', sub: `끊김 ${fmtN(down)} · 점검 ${fmtN(maint)}`, href: '#/hosts/list',
    tip: 'vCenter 와 끊겼거나 점검(유지보수) 모드인 호스트' });
  return out;
}

// ── 가상화 호스트 현황(클러스터 지도) ──
/**
 * 색 기준 — 파랑 3단(사용률 경계 중 경고 경계 아래) + 경고 경계 이상만 빨강(S6). 경계는 응답 thresholds(usageEdges · overloadPct · n1LimitPct).
 * ‘한 대 빠진 뒤 메모리’ 는 클러스터 구성 권한이 있을 때만(없으면 서버가 그 칸을 싣지 않는다) — 처음 색(확정 기본값).
 */
export function fillDefs(th = {}, access = {}) {
  const over = numOrNull(th?.overloadPct);
  const n1 = numOrNull(th?.n1LimitPct);
  const edges = (Array.isArray(th?.usageEdges) ? th.usageEdges : []).map(numOrNull).filter((x) => x != null);
  const stepsBelow = (crit) => edges.filter((e) => crit == null || e < crit);
  const defs = [];
  if (access?.cluster) defs.push({ key: 'n1mem', label: '한 대 빠진 뒤 메모리', short: '빠진 뒤', steps: stepsBelow(n1), crit: n1, val: (c) => numOrNull(c?.n1Mem) });
  defs.push(
    { key: 'max', label: '가장 바쁜 호스트 CPU', short: '최고', steps: stepsBelow(over), crit: over, val: (c) => numOrNull(c?.busiestCpu) },
    { key: 'cpu', label: '평균 CPU', short: 'CPU', steps: stepsBelow(over), crit: over, val: (c) => numOrNull(c?.cpuAvg) },
    { key: 'mem', label: '평균 메모리', short: '메모리', steps: stepsBelow(over), crit: over, val: (c) => numOrNull(c?.memAvg) },
  );
  return defs;
}
/** 크기 기준(칸 넓이). */
export const SIZE_DEFS = Object.freeze([
  { key: 'hosts', label: '호스트 수', val: (c) => numOrNull(c?.hosts), text: (v) => `${fmtN(v)}대` },
  { key: 'cores', label: '코어', val: (c) => numOrNull(c?.cores), text: (v) => `${fmtN(v)} 코어` },
  { key: 'mem', label: '메모리', val: (c) => numOrNull(c?.memTotalGB), text: (v) => gbText(v) },
]);

/** 파랑 3단 — 공용 5단 눈금의 가운데 3칸(시안 보드의 색과 같다). 단계 0 → RAMP[1]. */
export const HOST_RAMP_OFFSET = 1;
export function hostTileColors(st) {
  return tileColors({ step: st?.step == null ? null : st.step + HOST_RAMP_OFFSET, over: !!st?.over });
}
/** 눈금 범례 — [{ text, bg }] + 경고 + 값 모름. */
export function hostScale(fill) {
  const out = scaleLegend(fill?.steps || [], { crit: fill?.crit ?? null }).map((text, i) => ({ text, bg: RAMP[Math.min(RAMP.length - 1, i + HOST_RAMP_OFFSET)] }));
  if (fill?.crit != null) out.push({ text: `${fill.crit}% 이상(경고)`, bg: CRIT_BG });
  out.push({ text: '값 모름', bg: NONE_BG });
  return out;
}

/**
 * 한 대 빠진 뒤 사용률 글자. 서버 clustercfg/n1.js 는 남은 호스트의 용량이 0 이면(호스트 1대뿐 · 나머지가 점검 중 등) 비율 대신 999 를 낸다 —
 * 백분율이 아니라 ‘받아 줄 용량이 없음’ 이라 ‘999%’ 로 쓰지 않는다(법인별 보기 hostCorpText 와 같은 표기 ‘수용 불가’). 모르면 ‘—’.
 */
export const N1_NO_ROOM_PCT = 999;
export function n1PctText(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  return n >= N1_NO_ROOM_PCT ? '수용 불가' : `${Math.round(n)}%`;
}

/** 한 대가 빠지면 못 버티는 칸인가 — 서버 n1Ok 그대로(false 만 · 모름은 표를 붙이지 않는다). */
export const n1FailOf = (cell) => cell?.n1Ok === false;

/**
 * 지도 묶음 — 지역마다 클러스터 칸(독립 호스트는 법인마다 한 칸 — 서버가 준 줄). 칸 id = 클러스터 키 · 고르는 id(pick) = 그 법인.
 * 개수를 모르는 법인(unknown)은 서버가 클러스터 줄을 주지 않는다 — 칸이 없다(범위 안내가 ‘값 모름 N곳’ 으로 밝힌다).
 */
export function mapGroups(clusters, rows, size) {
  const rowById = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object').map((r) => [String(r.id), r]));
  const by = new Map();
  for (const c of Array.isArray(clusters) ? clusters : []) {
    if (!c || typeof c !== 'object') continue;
    const row = rowById.get(String(c.vcenterId));
    if (!row) continue;   // 범위(리전) 밖 법인의 칸은 그리지 않는다
    const key = regionName(row.region);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ id: String(c.key), pick: String(c.vcenterId), label: String(c.label || c.name || c.key), size: row.unknown === true ? null : size.val(c), cell: c, row });
  }
  return [...by.entries()].map(([key, items]) => ({ key, label: key, items }));
}

/** 지역별 분포 — 합에 넣은 법인(used)만. 호스트 많은 순. */
export function regionRows(used, totalHosts) {
  const by = new Map();
  for (const r of Array.isArray(used) ? used : []) {
    const key = regionName(r.region);
    const cur = by.get(key) || { key, n: null, cl: null, cores: null, memMB: null, att: null, corps: [] };
    cur.n = addVal(cur.n, r.hosts?.total); cur.cl = addVal(cur.cl, r.clusterCount); cur.cores = addVal(cur.cores, r.cores);
    cur.memMB = addVal(cur.memMB, r.memTotalMB); cur.att = addVal(cur.att, r.attention);
    cur.corps.push(r);
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => ((b.n ?? -1) - (a.n ?? -1)) || a.key.localeCompare(b.key)).map((g) => ({
    ...g, share: shareText(g.n, totalHosts), w: shareOf(g.n, totalHosts) ?? 0,
    sub: `클러스터 ${fmtN(g.cl)} · 코어 ${fmtN(g.cores)} · 메모리 ${gbText(mbToGb(g.memMB))} · 확인 대상 ${fmtN(g.att)}`,
    cities: g.corps.slice().sort((a, b) => (numOrNull(b.hosts?.total) ?? -1) - (numOrNull(a.hosts?.total) ?? -1)).map((c) => `${c.city || corpName(c)} ${fmtN(c.hosts?.total)}`).join(' · '),
  }));
}

// ── 상위 목록 — 서버 hostInsight.js CMP_CPU 와 같은 비교 순서 ──
export const CMP_CPU = (a, b) => ((numOrNull(b.cpu) ?? -1) - (numOrNull(a.cpu) ?? -1)) || ((numOrNull(b.mem) ?? -1) - (numOrNull(a.mem) ?? -1))
  || String(a?.name).localeCompare(String(b?.name)) || String(a?.id).localeCompare(String(b?.id));
const n1Worst = (x) => Math.max(numOrNull(x?.cpuAfterFailPct) ?? -1, numOrNull(x?.memAfterFailPct) ?? -1);
/** 못 버티는 클러스터 — 서버와 같은 순서(빠진 뒤 사용률 큰 쪽이 큰 순 · 이름). */
export const CMP_N1 = (a, b) => (n1Worst(b) - n1Worst(a)) || String(a?.name).localeCompare(String(b?.name)) || String(a?.key).localeCompare(String(b?.key));

/**
 * 고른(합에 넣은) 법인의 상위 목록을 합쳐 다시 — cpuTop 은 n 개(법인별 상위 N 의 합집합 안에 전체 상위 N 이 있다) · n1Fail 은 전부(서버가 법인의 전부를 준다).
 * n1Fail 항목에는 그 법인 id(vcenterId)를 붙인다(이름을 누르면 ‘법인별’ 의 그 법인으로).
 */
export function mergedTops(top, usedIds, n) {
  const set = new Set((usedIds || []).map(String));
  const mine = (Array.isArray(top) ? top : []).filter((t) => t && set.has(String(t.id)));
  const n1 = mine.flatMap((t) => (Array.isArray(t.n1Fail) ? t.n1Fail : []).filter((x) => x && typeof x === 'object').map((x) => ({ ...x, vcenterId: String(t.id) })));
  return {
    cpuTop: mergeTopN(mine.map((t) => t.cpuTop), CMP_CPU, n),
    n1Fail: n1.sort(CMP_N1),
    n1Known: mine.some((t) => Array.isArray(t.n1Fail)),
  };
}

// ── 분포 패널 ──
/** ESXi 버전 비교 — 숫자 칸끼리(새 버전이 앞). */
export function cmpVersionDesc(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] ?? -1) - (pa[i] ?? -1);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
}
/** 세대 = 버전의 첫 숫자(‘8.0.2’ → 8). 숫자가 없으면 null. 묶음일 뿐 판정이 아니다(지원 종료 판정은 ‘버전/패치 준수’ 도구). */
export const esxiMajorOf = (v) => { const m = /^\s*(\d+)/.exec(String(v ?? '')); return m ? Number(m[1]) : null; };
const GEN_BG = Object.freeze(['#3987e5', '#6da7ec', '#9085e9', '#8b9bb4']);

/** ESXi 버전 — 세대 조각(새 세대가 앞) + 버전별 막대(새 버전이 위) + 그 밖(서버가 접은 수) · 못 읽음은 따로. */
export function esxiView(esxi) {
  const v = esxi?.versions && typeof esxi.versions === 'object' ? esxi.versions : {};
  const list = Object.entries(v).map(([name, n]) => ({ name, n: numOrNull(n) ?? 0 })).filter((x) => x.n > 0).sort((a, b) => cmpVersionDesc(a.name, b.name));
  const gens = new Map();
  for (const x of list) { const g = esxiMajorOf(x.name); const k = g == null ? '?' : String(g); gens.set(k, (gens.get(k) || 0) + x.n); }
  const genKeys = [...gens.keys()].sort((a, b) => (a === '?') - (b === '?') || Number(b) - Number(a));
  const genIndex = new Map(genKeys.map((k, i) => [k, i]));
  const bgOf = (k) => GEN_BG[Math.min(GEN_BG.length - 1, genIndex.get(k) ?? GEN_BG.length - 1)];
  const genSegs = genKeys.map((k) => ({ key: `g${k}`, label: k === '?' ? '세대 모름' : `ESXi ${k}`, n: gens.get(k), bg: bgOf(k) }));
  const rows = list.map((x) => { const g = esxiMajorOf(x.name); return { key: `v:${x.name}`, name: `ESXi ${x.name}`, n: x.n, bg: bgOf(g == null ? '?' : String(g)) }; });
  const rest = numOrNull(esxi?.rest) ?? 0;
  if (rest > 0) rows.push({ key: 'rest', name: '그 밖', n: rest, bg: '#4b5873' });
  return { genSegs, rows, kinds: list.length, unread: numOrNull(esxi?.unread) };
}

/** 서버 모델 — 많은 순 shown 종 + ‘그 밖’(접은 종류 + 서버가 접은 rest) · 못 읽음 따로 · 제조사 한 줄. */
export function modelView(model, vendor, shown) {
  const n = Math.max(1, numOrNull(shown) ?? 8);
  const m = model?.models && typeof model.models === 'object' ? model.models : {};
  const list = Object.entries(m).map(([name, c]) => ({ name, n: numOrNull(c) ?? 0 })).filter((x) => x.n > 0).sort((a, b) => (b.n - a.n) || a.name.localeCompare(b.name));
  const head = list.slice(0, n).map((x) => ({ key: `m:${x.name}`, name: x.name, n: x.n }));
  const restKinds = list.slice(n);
  const rest = restKinds.reduce((a, x) => a + x.n, 0) + (numOrNull(model?.rest) ?? 0);
  if (rest > 0) head.push({ key: 'rest', name: `그 밖${restKinds.length ? ` ${fmtN(restKinds.length)}종` : ''}`, n: rest });
  const vs = vendor?.vendors && typeof vendor.vendors === 'object' ? vendor.vendors : {};
  const vlist = Object.entries(vs).map(([name, c]) => ({ name, n: numOrNull(c) ?? 0 })).filter((x) => x.n > 0).sort((a, b) => (b.n - a.n) || a.name.localeCompare(b.name));
  const vrest = numOrNull(vendor?.rest) ?? 0;
  const vendorText = vlist.length ? `제조사 — ${vlist.map((x) => `${x.name} ${fmtN(x.n)}`).join(' · ')}${vrest > 0 ? ` · 그 밖 ${fmtN(vrest)}` : ''}${unkText(vendor?.unread, '모름')}` : '';
  return { rows: head, kinds: list.length, unread: numOrNull(model?.unread), vendorText };
}

/** 호스트 한 대의 VM 수 구간 이름 — 서버 키 k 는 ‘앞 키 초과 k 이하’. edges [9,12,15] → ['9대 이하','10–12대','13–15대','16대 이상']. */
export function densityRows(bins, edges) {
  const e = (Array.isArray(edges) ? edges : []).map(numOrNull).filter((x) => x != null);
  const b = bins && typeof bins === 'object' ? bins : {};
  const out = e.map((k, i) => ({ key: String(k), name: i === 0 ? `${k}대 이하` : (e[i - 1] + 1 === k ? `${k}대` : `${e[i - 1] + 1}–${k}대`), n: numOrNull(b[String(k)]) }));
  const last = e[e.length - 1];
  if (last != null) out.push({ key: 'more', name: `${last + 1}대 이상`, n: numOrNull(b.more) });
  return out;
}

/** 클러스터 안전성 — 조각(버팀 · 못 버팀 · 모름) + 키-값 줄. 클러스터 구성 권한이 없으면 null(패널을 숨긴다). */
export function safetyView(cl, access = {}) {
  if (!access?.cluster) return null;
  const c = cl || {};
  const frac = (a, b) => `${fmtN(a)} / ${fmtN(b)}`;
  const haOnN = numOrNull(c.haOn);
  return {
    total: numOrNull(c.total),
    segs: [
      { key: 'ok', label: '버팀', n: numOrNull(c.n1Ok), bg: '#3987e5' },
      { key: 'fail', label: '못 버팀', n: numOrNull(c.n1Fail), bg: '#ef4444' },
      { key: 'unknown', label: '모름', n: numOrNull(c.n1Unknown), bg: NONE_BG },
    ],
    kv: [
      { key: 'ha', label: 'HA 꺼짐', value: frac(c.haOff, c.collected), warn: (numOrNull(c.haOff) ?? 0) > 0, tip: 'vSphere HA 가 꺼진 클러스터 ÷ 설정을 받은 클러스터' },
      { key: 'ac', label: '수용 제어 꺼짐(HA 켠 클러스터 중)', value: frac(c.admissionOff, haOnN), warn: (numOrNull(c.admissionOff) ?? 0) > 0, tip: 'HA 는 켜져 있지만 수용 제어(admission control)가 꺼진 클러스터' },
      { key: 'drs', label: 'DRS 수동', value: frac(c.drsManual, c.collected), tip: 'DRS 가 수동인 클러스터(부분 자동 · 꺼짐은 ‘법인별’ 보기에서)' },
      ...((numOrNull(c.cfgUnknown) ?? 0) > 0 ? [{ key: 'cfg', label: '설정 미수집(판정 밖)', value: fmtN(c.cfgUnknown), tip: '클러스터 설정을 받지 못했습니다 — HA · DRS 판정에 넣지 않았습니다' }] : []),
    ],
  };
}

/** 사용률 칸이 경고 칸인가 — 칸 하한 ≥ 과부하 %. */
export const histCritFrom = (th) => numOrNull(th?.overloadPct);

/** 묶음 키 · 이름(접힘 기억 키의 값 — 바꾸지 말 것). 지도 · 지역별 분포 · 지금 볼 호스트는 접지 않는다. */
export const HOST_FOLD_GROUPS = Object.freeze([['perf', '성능'], ['config', '구성 점검'], ['capacity', '용량'], ['dist', '분포']]);
export const HOST_FOLD_KEYS = Object.freeze(HOST_FOLD_GROUPS.map(([k]) => k));
/** localStorage 는 VM 화면과 다른 화면별 키(insightPrefs — 화면마다 따로 기억). */
export const HOST_MAP_PREF_KEY = 'hostInsight.map';
export const HOST_FOLD_PREF_KEY = 'hostInsight.fold';
/** 묶음마다 필요한 도구(하나라도 허용이면 묶음을 그린다 — 권한이 없으면 머리줄째 숨긴다). 용량 고갈 예측 라우트의 집행 키는 'forecast'(server auth/toolAccess.js). */
export const HOST_GROUP_TOOLS = Object.freeze({ perf: Object.freeze(['contention']), config: Object.freeze(['host-hygiene']), capacity: Object.freeze(['forecast', 'storage-paths']) });
export function groupShownOf(canTool) {
  const can = typeof canTool === 'function' ? canTool : () => false;
  return { perf: HOST_GROUP_TOOLS.perf.some(can), config: HOST_GROUP_TOOLS.config.some(can), capacity: HOST_GROUP_TOOLS.capacity.some(can), dist: true };
}

export { round1 };
