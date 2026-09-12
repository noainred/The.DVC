/**
 * perfBatch.js — 여러 VM 의 기간 사용률을 **한 QueryPerf 요청**으로 받아 요약하는 순수 로직(v2.492).
 *
 * 왜 필요한가: Platform › 'VM 및 폴더' 트리 행에 CPU·메모리 **기간 실사용률**(기본 30일)을 보이려면
 * 화면에 펼쳐진 VM 수십~수백 대의 값이 필요하다. 기존 경로는 전부 **VM 1대당 로그인 1회 +
 * QueryPerf 1회**(soapClient.fetchEntityMetric/fetchVmRightsizeSeries)라, 307 VM 에 그대로 쓰면
 * 고RTT(일부 vCenter 800ms 초과) 환경에서 로그인만 수백 회가 된다. 그래서 호스트 전력 조회
 * (soapClient.queryHostPower — 운영에서 검증된 다중 엔티티 패턴)처럼 querySpec 을 여러 개 이어
 * 붙이고, 응답의 `<returnval>` 을 **엔티티별로** 갈라 읽는다.
 *
 * ⚠ 기존 `parsePerfMultiXml` 은 **첫 `<returnval>` 하나만** 읽는다(단일 엔티티 전용). 그래서 그
 * 함수를 그대로 쓰면 다중 VM 요청에서 첫 VM 값만 돌아온다 — 이 파일의 파서가 따로 있는 이유다.
 * 기존 함수는 자원 축소 리포트가 쓰는 검증된 경로이므로 건드리지 않는다.
 *
 * ⚠ `<value>` 태그 함정(v2.445 회귀와 동일): 계열 컨테이너도 `<value xsi:type="PerfMetricIntSeries">`,
 * 그 안의 표본도 `<value>123</value>` 로 같은 태그명이다. 계열 경계는 반드시 **`<id>` 블록**으로
 * 잡는다(표본에는 `<id>` 가 없다). 회귀 테스트: server/test/perfBatch2492.test.js.
 *
 * 정직성 규약: 표본이 없으면 null 을 돌려주고 0 으로 채우지 않는다(0% 는 '유휴' 라는 뜻이 되어
 * 축소 판단을 왜곡한다). vCenter 는 결측을 -1 로 주므로 -1 은 표본에서 제외한다.
 */

/** 화면이 고를 수 있는 기간(일) — 자원 축소 리포트(/tools/rightsize)와 같은 프리셋. */
export const USAGE_DAYS = [7, 30, 90, 180, 365];

/** 요청 기간 정규화. 목록 밖이면 기본 30일(사용자 요청 기본값). */
export function normDays(v) {
  const n = Number(v);
  return USAGE_DAYS.includes(n) ? n : 30;
}

/**
 * 기간 → vCenter 롤업 구간.
 *
 * 트리 행에 필요한 것은 **기간 평균/최대** 한 쌍이라 곡선 해상도가 필요 없다. 그래서 표본 수를
 * 최소화하는 롤업을 고른다(응답 XML 크기와 정규식 파싱 CPU 가 표본 수에 정비례한다):
 *   · 7일·30일  → 'month'(2시간) : 84표본 / 360표본
 *   · 90일 이상 → 'year'(1일)    : 90 / 180 / 365표본
 * 30일을 'week'(30분)로 받으면 1,440표본/VM 이라 60 VM 만 해도 표본 8만 개다 — 같은 평균을 얻으려고
 * 4~17배 비싼 응답을 받는 셈이다. 자원 축소 리포트는 p95·차트가 필요해 더 촘촘한 롤업을 쓴다
 * (거기는 VM 1대 모달이라 비용이 문제되지 않는다).
 */
export function intervalForDays(days) {
  return normDays(days) <= 30 ? 'month' : 'year';
}

/** 한 엔티티 블록에서 계열을 뽑는다 — 계열 경계는 `<id>` 블록(위 주석의 `<value>` 함정 회피). */
function seriesOfBlock(block, ids) {
  const out = new Map(ids.map((id) => [id, []]));
  const times = [...block.matchAll(/<timestamp>([^<]+)<\/timestamp>/g)].map((m) => m[1]);
  const marks = [...block.matchAll(/<id>([\s\S]*?)<\/id>/g)];
  const picked = new Map(); // cid -> 채택한 instance('' = 집계)
  for (let i = 0; i < marks.length; i++) {
    const cid = /<counterId>(\d+)<\/counterId>/.exec(marks[i][1])?.[1];
    if (!cid || !out.has(cid)) continue;
    const instance = /<instance>([^<]*)<\/instance>/.exec(marks[i][1])?.[1] || '';
    // 같은 counterId 가 인스턴스별로 여러 번 올 수 있다 — 집계(빈 instance)를 우선한다.
    if (picked.has(cid) && !(picked.get(cid) !== '' && instance === '')) continue;
    const from = marks[i].index + marks[i][0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : block.length;
    const vals = [...block.slice(from, to).matchAll(/<value>(-?\d+)<\/value>/g)].map((m) => Number(m[1]));
    if (!vals.length) continue;
    const n = Math.min(times.length, vals.length);
    const pts = [];
    for (let k = 0; k < n; k++) pts.push({ t: times[k], v: vals[k] });
    out.set(cid, pts);
    picked.set(cid, instance);
  }
  return out;
}

/**
 * 다중 엔티티 QueryPerf 응답 파싱 → Map&lt;moref, Map&lt;counterId, [{t,v}]&gt;&gt;.
 * entityType 이 주어지면 그 타입의 `<entity>` 만 읽는다(기본 VirtualMachine).
 */
export function parseEntityPerfBatchXml(xml, counterIds = [], entityType = 'VirtualMachine') {
  const ids = [...new Set((counterIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const re = /<returnval[^>]*>([\s\S]*?)<\/returnval>/g;
  let m;
  while ((m = re.exec(xml || ''))) {
    const blk = m[1];
    const ent = new RegExp(`<entity type="${entityType}">([^<]+)</entity>`).exec(blk)?.[1];
    if (!ent) continue;
    out.set(ent, seriesOfBlock(blk, ids));
  }
  return out;
}

/**
 * 표본 → 요약. div 로 나눠 단위를 맞춘다(사용률 카운터는 % × 100 이므로 div=100).
 * 결측(-1)은 제외하고, 남은 표본이 없으면 null(추정 금지).
 */
export function summarizePoints(points, div = 1) {
  const vals = (points || []).map((p) => Number(p?.v)).filter((v) => Number.isFinite(v) && v >= 0);
  if (!vals.length) return null;
  const scale = (x) => Math.round((x / (div || 1)) * 10) / 10;
  const sum = vals.reduce((a, b) => a + b, 0);
  return { avg: scale(sum / vals.length), max: scale(Math.max(...vals)), samples: vals.length };
}

/**
 * 표본이 실제로 덮는 기간(일) — 요청 기간과 다를 수 있다. VM 이 최근에 만들어졌거나 vCenter 보관
 * 기간이 짧으면 '30일 요청 · 4일치 표본' 이 되는데, 그걸 30일 평균처럼 보이면 거짓이 된다.
 * 화면은 이 값으로 '요청 기간보다 짧음' 을 알린다(자원 축소 리포트 windowInfo 와 같은 원칙).
 */
export function coverageDaysOf(points) {
  const ts = (points || [])
    .filter((p) => Number(p?.v) >= 0)
    .map((p) => Date.parse(p.t))
    .filter((n) => Number.isFinite(n));
  if (ts.length < 2) return ts.length ? 0 : null;
  return Math.round(((Math.max(...ts) - Math.min(...ts)) / 86_400_000) * 10) / 10;
}

/**
 * 한 VM 의 CPU·메모리 계열 → 화면이 쓰는 요약 한 줄.
 * 반환 null = 표본 없음('—' 로 표시). cpu/mem 중 한쪽만 있으면 그쪽만 채운다.
 */
export function summarizeVmUsage(byCounter, { cpuId, memId }) {
  const cpu = cpuId ? summarizePoints(byCounter?.get(String(cpuId)), 100) : null;
  const mem = memId ? summarizePoints(byCounter?.get(String(memId)), 100) : null;
  if (!cpu && !mem) return null;
  const cov = coverageDaysOf(byCounter?.get(String(cpuId)) || byCounter?.get(String(memId)));
  return {
    cpuPct: cpu ? cpu.avg : null,
    cpuMax: cpu ? cpu.max : null,
    memPct: mem ? mem.avg : null,
    memMax: mem ? mem.max : null,
    samples: Math.max(cpu?.samples || 0, mem?.samples || 0),
    coverageDays: cov,
  };
}
