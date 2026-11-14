/**
 * views/tools/bmTrendText.js — 리눅스 베어메탈 통합 성능 **3b 화면(서버 상세 ‘추이’ 탭 · 확대 팝업 · 장치 토글 · CVP 포트 절)의
 * 문구 · 표시 규약**(순수 · vitest `bmTrendText.test.js`). 설계 `docs/design/linux-bm-perf/PROFILES.md` §6 · §8~§12.
 *
 * ⚠⚠ **창 · 해상도 · 결측 · 기준선은 서버가 정한다**(`server/src/bmusage/trendWindow.js` — 응답 from·to·res·resReason·stepMs·gaps·baseline).
 *   이 모듈은 서버 응답을 **그리기 좋게 바꾸기만** 한다 — 결측 구간을 다시 계산하지 않고(점 사이에 서버 gaps 가 걸치면 끊는다) ·
 *   해상도를 고르지 않고 · 기준과 비교해 칸을 판정하지 않는다. 대조 ⑤ 판정(verdict)과 포트 상태(state)도 서버 code 를 문장으로만.
 * ⚠ 구간 이동(◀ 이전 · 슬라이더 · 날짜로 이동)의 창 계산은 **공용 코어** `components/vmperf/vmPerfText.js`(windowSpan · backForSpan ·
 *   dateJumpEnd · dateInputOf) — 두 벌 두지 않는다. 구간 요약(평균 · 최대 · 기준 이상 비율)도 그 모듈의 seriesStats 하나를 쓴다.
 * ⚠ ‘못 읽은 값’ 은 0 이 아니다(numOrNull) — 선을 끊고, 요약 분모에서 빼고, 값이 없으면 단위 없이 ‘—’.
 * ⚠ 없는 기능은 그리지 않는다: B 샘플러의 1초 표본 펼침 · LLDP/MAC 매핑 · 소켓/conntrack 이력 · 가득 예상(서버 API 없음).
 * ⚠ 문구에 백틱 금지(BoldText 는 **강조** 만) — 값 인용은 ‘ ’. 주기 · 보존 · 상한 숫자는 API 값만 쓴다.
 */
import { numOrNull } from '../../numOrNull.js';
import { seriesStats, yMaxOf, fmtClock, fmtHm } from '../../components/vmperf/vmPerfText.js';
import { bpsText, pctText } from './bmUsageText.js';
import { bpsText as bitsText } from './cvpText.js';
import { toCsv } from '../../util/csv.js';
import { dayStamp } from '../../dayStamp.js';

const n = numOrNull;
const t = (v) => String(v ?? '').trim();
const HOUR = 3_600_000;
const DAY = 86_400_000;

/* ─────────────────────────── 기간 · 표시 ─────────────────────────── */
/** 추이 탭 · 팝업의 기간(설계 아트보드 ②-추이 · 확대 팝업). 해상도는 서버가 고른다(auto). */
export const TREND_RANGES = Object.freeze([
  { k: '6h', label: '6시간', ms: 6 * HOUR },
  { k: '24h', label: '24시간', ms: DAY },
  { k: '7d', label: '7일', ms: 7 * DAY },
  { k: '30d', label: '30일', ms: 30 * DAY },
]);
export const trendRangeOf = (k) => TREND_RANGES.find((r) => r.k === k) || TREND_RANGES[1];
export const SHOW_MODES = Object.freeze([
  { k: 'both', label: '평균+피크' },
  { k: 'avg', label: '평균' },
  { k: 'peak', label: '피크' },
]);
export const showAvg = (mode) => mode !== 'peak';
export const showPeak = (mode) => mode !== 'avg';

/* ─────────────────────────── 지표 표(웹 쪽 이름 · 단위) ─────────────────────────── */
/**
 * 서버 지표 — 이름 · 단위 · 피크 열 유무. **피크 열 목록은 서버 `perfCols.PEAK_COLS` 와 같아야 한다**(테스트가 대조 — 두 벌이면 대조한다).
 * 단위: '%' · 'B/s'(바이트) · 'ms' · '/s' · 'pages/s' · '건'(주기 증가분) · ''(개수 · 배수).
 */
export const SERVER_METRIC_INFO = Object.freeze({
  cpu_pct: { label: 'CPU 사용률', unit: '%', peak: true },
  mem_pct: { label: '메모리 사용률', unit: '%', peak: false },
  disk_busy_pct: { label: '디스크 busy', unit: '%', peak: true },
  net_pct: { label: '네트워크 사용률', unit: '%', peak: true },
  net_bps: { label: '네트워크 처리량', unit: 'B/s', peak: true },
  cpu_iowait_pct: { label: 'iowait', unit: '%', peak: true },
  cpu_steal_pct: { label: 'steal', unit: '%', peak: false },
  cpu_sys_pct: { label: 'system(+irq·softirq)', unit: '%', peak: false },
  cpu_core_max_pct: { label: '코어 최고', unit: '%', peak: false },
  load1: { label: 'load 1분', unit: '', peak: false },
  runq_per_core: { label: '런큐/코어(load1 ÷ 코어)', unit: '', peak: false },
  ctxt_ps: { label: '문맥 전환', unit: '/s', peak: false },
  swap_in_ps: { label: '스왑 인', unit: 'pages/s', peak: false },
  swap_out_ps: { label: '스왑 아웃', unit: 'pages/s', peak: false },
  pgmajfault_ps: { label: '메이저 폴트', unit: '/s', peak: false },
  disk_iops: { label: 'IOPS(최대 장치)', unit: '/s', peak: true },
  disk_await_ms: { label: 'await(최대 장치)', unit: 'ms', peak: true },
  disk_aqu: { label: '디스크 대기열(aqu-sz)', unit: '', peak: true },
  disk_inflight: { label: 'in-flight(순간값)', unit: '', peak: false },
  procs_blocked: { label: 'D 상태 프로세스(순간값)', unit: '', peak: false },
  net_drop_delta: { label: 'NIC 드롭 증가', unit: '건', peak: false },
  net_err_delta: { label: 'NIC 오류 증가', unit: '건', peak: false },
  tcp_retrans_pct: { label: 'TCP 재전송률', unit: '%', peak: false },
});
/** 장치 지표(kind=disk·nic·mount) — 피크 열은 서버 `DEVICE_PEAK_COLS` 와 같아야 한다(테스트 대조). */
export const DEVICE_METRIC_INFO = Object.freeze({
  disk: Object.freeze({
    busy_pct: { label: 'busy', unit: '%', peak: true },
    await_ms: { label: 'await', unit: 'ms', peak: true },
    iops: { label: 'IOPS', unit: '/s', peak: true },
    aqu: { label: '평균 대기열', unit: '', peak: true },
    inflight: { label: 'in-flight(순간값)', unit: '', peak: false },
  }),
  nic: Object.freeze({
    util_pct: { label: '사용률', unit: '%', peak: true },
    rx_bps: { label: '수신', unit: 'B/s', peak: true },
    tx_bps: { label: '송신', unit: 'B/s', peak: true },
    drop_delta: { label: '드롭 증가', unit: '건', peak: false },
    err_delta: { label: '오류 증가', unit: '건', peak: false },
  }),
  mount: Object.freeze({
    used_pct: { label: '공간 사용률', unit: '%', peak: false },
    inode_pct: { label: 'inode 사용률', unit: '%', peak: false },
  }),
});
export function metricInfo(kind = 'server', metric = '') {
  const m = kind === 'server' ? SERVER_METRIC_INFO[metric] : DEVICE_METRIC_INFO[kind]?.[metric];
  return m || { label: t(metric) || '—', unit: '', peak: false };
}

/* ─────────────────────────── 패널 행 · 추천 지표 12행 ─────────────────────────── */
/**
 * ① 평균 · ② 피크 두 패널의 행(같은 시간축). 큐 · 버퍼는 이력 열이 있는 것만 — 소켓 메모리 · conntrack · softnet · qdisc · accept 큐는
 * 이력에 없어 행을 두지 않는다(SOCKET_NOTE). 디스크 · 네트워크 행은 장치 토글(§12)로 장치별 계열로 바뀐다(devKind · devMetric).
 */
export const PANEL_ROWS = Object.freeze([
  { id: 'cpu', metric: 'cpu_pct', color: 'var(--accent)', sub: '0~100' },
  { id: 'mem', metric: 'mem_pct', color: 'var(--purple)', sub: '0~100' },
  { id: 'disk', metric: 'disk_busy_pct', color: 'var(--amber)', sub: '가장 바쁜 장치 · 0~100', devKind: 'disk', devMetric: 'busy_pct' },
  { id: 'net', metric: 'net_pct', color: 'var(--accent-2)', sub: '가장 높은 회선 · 0~100', devKind: 'nic', devMetric: 'util_pct' },
  { id: 'runq', metric: 'runq_per_core', color: 'var(--green)', sub: '큐 · 1.0 = 코어 수만큼 대기', queue: true },
  { id: 'aqu', metric: 'disk_aqu', color: 'var(--amber)', sub: '큐 · 가장 바쁜 장치', queue: true },
  { id: 'inflight', metric: 'disk_inflight', color: 'var(--amber)', sub: '큐 · 수집 순간값', queue: true },
  { id: 'drop', metric: 'net_drop_delta', color: 'var(--accent-2)', sub: '버퍼 · 주기 증가분(최대 NIC)', queue: true },
  { id: 'err', metric: 'net_err_delta', color: 'var(--red)', sub: '오류 · 주기 증가분(최대 NIC)', queue: true },
]);
export const SOCKET_NOTE = '소켓 메모리 · conntrack · softnet 백로그 · qdisc · accept 큐는 이력에 쌓지 않는 값이라 행을 두지 않았습니다(최신값은 진단 스냅샷 몫). NIC 링 버퍼 점유율은 직접 읽을 수 없습니다(드롭으로 간접).';

/** 출처 태그(설계 PROFILES §8 — 확인 등급 ● 원문 · ◐ 검색 발췌·미러 · ○ 블로그 합의). URL 은 설계 문서와 같은 값. */
export const SOURCE_TAGS = Object.freeze({
  SRE: { name: 'Google SRE Book ch.6', title: 'Monitoring Distributed Systems', url: 'https://sre.google/sre-book/monitoring-distributed-systems/', grade: '●', gradeText: '원문 확인' },
  NF: { name: 'Netflix TechBlog', title: 'Linux Performance Analysis in 60,000 Milliseconds', url: 'https://netflixtechblog.com/linux-performance-analysis-in-60-000-milliseconds-accc10403c55', grade: '◐', gradeText: '원문 403 — 미러·요약' },
  USE: { name: 'Brendan Gregg', title: 'USE Method: Linux Performance Checklist', url: 'https://brendangregg.com/USEmethod/use-linux.html', grade: '◐', gradeText: '연결 실패 — 검색 발췌' },
  DELL: { name: 'Dell iDRAC9', title: 'Telemetry Streaming Performance Report', url: 'https://dl.dell.com/manuals/common/dell-emc-idrac9-telemetry-streaming-performance-report.pdf', grade: '◐', gradeText: 'PDF 403 — 검색 발췌' },
  ND: { name: 'Netdata', title: 'system CPU · ctxt · softnet 차트', url: '', grade: '◐', gradeText: '검색 발췌' },
  CM: { name: '커뮤니티 블로그 합의', title: 'linuxblog.io · sematext · netdata academy 등', url: '', grade: '○', gradeText: '블로그 합의 — Reddit 스레드는 직접 인용 못 함' },
});
export const SOURCE_ORDER = Object.freeze(['SRE', 'NF', 'USE', 'DELL', 'ND', 'CM']);

/**
 * 추천 지표 12행(설계 §8 ‘추가 차트 행 12’) — 각 행은 출처 태그 · 지표(첫 지표 = 평균 회색 + 피크 색, 나머지 = 보조 선) · 출처 범위 각주.
 * 임계값은 출처마다 달라 **설정값(응답 baseline)** 만 선으로 그린다 — 각주의 범위는 출처가 말한 값을 옮긴 것이지 판정 기준이 아니다.
 * 이력 열이 없는 것(vmstat r · irq/softirq 분리 · fifo · active/passive)은 지어내지 않고 각주가 말한다.
 */
export const RECO_TILES = Object.freeze([
  { id: 'load', title: '로드 1분 ÷ 코어', tags: ['NF', 'CM'], metrics: ['runq_per_core'], note: '출처 범위: 1.0배 주의 · 2.0배 심각(블로그마다 다름). 로드는 D 상태를 포함한다(USE 가 로드를 포화 지표에서 뺀 이유).' },
  { id: 'runq', title: 'load 1분 · D 상태', tags: ['USE', 'NF'], metrics: ['load1', 'procs_blocked'], note: 'vmstat r(procs_running)은 이력 열이 없어 load 1분과 D 상태 수로 본다. USE: r 이 CPU 수보다 크면 CPU 포화.' },
  { id: 'iowait', title: 'iowait · steal', tags: ['NF', 'ND'], metrics: ['cpu_iowait_pct', 'cpu_steal_pct'], note: '출처 범위: iowait 10~30% 가 지속되면 디스크 쪽(블로그 합의). iowait 는 사실상 유휴라 판정에 쓰지 않는다.' },
  { id: 'ctxt', title: '컨텍스트 스위치 /s', tags: ['ND'], metrics: ['ctxt_ps'], note: '절대 기준이 없다 — 평소 대비 급증이 락 경합 · 스레드 폭주 후보.' },
  { id: 'sys', title: 'system(+irq · softirq)', tags: ['ND'], metrics: ['cpu_sys_pct'], note: 'irq · softirq 는 system 에 합쳐 저장한다(따로 나누지 않음) — 네트워크 부하 신호는 드롭 행과 같이 본다.' },
  { id: 'imbal', title: '코어 최고 vs 전체', tags: ['NF'], metrics: ['cpu_core_max_pct', 'cpu_pct'], note: 'mpstat -P ALL — 단일 스레드 병목은 평균에 묻힌다. 두 선의 간격이 코어 불균형이다.' },
  { id: 'swap', title: '스왑 si/so · 주요 폴트', tags: ['USE', 'NF'], metrics: ['swap_out_ps', 'swap_in_ps', 'pgmajfault_ps'], note: 'USE: 메모리 포화는 사용률이 아니라 스왑 · 폴트로 본다.' },
  { id: 'aqu', title: '디스크 대기열 · await', tags: ['NF', 'CM'], metrics: ['disk_aqu', 'disk_await_ms'], note: '출처 범위: await 20~25ms 이상 주의(블로그 합의) — 장치 종류(NVMe · HDD)마다 다르다.' },
  { id: 'util', title: '디스크 %util(busy)', tags: ['NF', 'CM'], metrics: ['disk_busy_pct'], note: '출처 범위: 80% 이상이면 포화 신호(블로그 합의) — NVMe 는 병렬이라 %util 이 과대해진다.' },
  { id: 'ifutil', title: 'NIC 사용률 · 처리량', tags: ['NF', 'USE'], metrics: ['net_pct', 'net_bps'], note: 'sar -n DEV — 링크 속도 대비. 사용률은 물리 회선 · bond 만(가상 인터페이스 제외).' },
  { id: 'nicerr', title: 'NIC 오류 · 드롭', tags: ['USE'], metrics: ['net_err_delta', 'net_drop_delta'], note: 'sar -n EDEV — fifo 는 따로 저장하지 않는다. 오류(E)가 포화(S)의 원천일 수 있다.' },
  { id: 'retrans', title: 'TCP 재전송률', tags: ['NF'], metrics: ['tcp_retrans_pct'], note: 'sar -n TCP,ETCP — active/passive 연결 수는 이력 열이 없다. 재전송은 회선 · 수신 측 포화 신호.' },
]);
/** 보조 선 색(추천 행의 둘째 · 셋째 지표) — 평균 회색 · 피크 빨강과 겹치지 않는 토큰. */
export const SECOND_COLORS = Object.freeze(['var(--accent-2)', 'var(--amber)', 'var(--purple)']);

/** 한 번에 부를 서버 지표(주 패널) · 추천 행이 더하는 지표. */
export function panelMetrics() { return [...new Set(PANEL_ROWS.map((r) => r.metric))]; }
export function recoMetrics() { return [...new Set(RECO_TILES.flatMap((x) => x.metrics))]; }

/* ─────────────────────────── 해상도 · 출처 · 안내 ─────────────────────────── */
export const RES_TEXT = Object.freeze({ '5m': '5분', '1h': '1시간', '1d': '1일' });
export const RES_REASON_TEXT = Object.freeze({
  retention: '그 해상도의 보존 기간 밖이라 한 단계 거친 해상도로 읽었습니다',
  'beyond-retention': '보존 기간 밖 구간입니다 — 값이 없을 수 있습니다',
  'device-no-daily': '장치별 이력은 1일 롤업이 없어 1시간으로 읽었습니다',
  'mount-daily-only': '마운트는 1일 롤업만 있습니다',
});
/** 해상도 표시 — 서버가 고른 값(auto) + 사유. */
export function resText(resp) {
  const r = RES_TEXT[t(resp?.res)];
  if (!r) return '해상도 —';
  const why = RES_REASON_TEXT[t(resp?.resReason)];
  return `해상도 ${r}(자동)${why ? ` — ${why}` : ''}`;
}
/** 해상도 전환 안내 — 롤업이면 평균 · 최대 · 피크의 뜻이 바뀐다. */
export function resHint(res) {
  if (res === '1h' || res === '1d') {
    const u = res === '1h' ? '그 1시간' : '그 하루';
    return `${u}의 롤업입니다 — 평균 = 5분 값의 평균 · 최대 = 5분 값 중 최대 · 피크 = 그 안 1초 창의 최대(피크 열이 있는 지표만).`;
  }
  if (res === '5m') return '5분 주기 원시값입니다 — 평균 = 그 5분 값 · 피크 = 같은 5분 안 1초 창의 최대(피크 열이 있는 지표만).';
  return '';
}

/** 피크 출처(서버 `peak_src` · `peak_window_s`) — 피크 값 옆에 **항상** 적는다(설계 §6 · README §6-13). */
export const PEAK_SRC_TEXT = Object.freeze({
  window10: '1초 창(A 안 — 같은 SSH 세션에서 1초 간격 표본)',
  sampler: '서버 샘플러(B 안)',
  psi: 'PSI 10초 평균(C 보조 — 피크 값이 아님)',
  none: '피크 없음',
});
export function peakSrcText(srcs = [], windowS = null) {
  const list = [...new Set((Array.isArray(srcs) ? srcs : [srcs]).map(t).filter(Boolean))];
  const w = n(windowS);
  const one = (s) => {
    if (s === 'window10') {
      if (w === 0) return '1초 창 꺼짐(주기 예산으로 0초) — 피크 없음 · PSI 보조만';
      if (w != null) return `${w}초 창(A 안 — 같은 SSH 세션 1초 간격${w < 10 ? ' · 주기 예산으로 줄임' : ''})`;
      return PEAK_SRC_TEXT.window10;
    }
    return PEAK_SRC_TEXT[s] || `출처 ‘${s}’`;
  };
  if (!list.length) return '기록 없음(이 구간 행에 피크 출처가 없습니다 — 피크 수집 전 행)';
  return list.map(one).join(' · ');
}
/** 피크 점을 눌렀을 때 — 그 5분 피크가 무엇으로 모였는지. 1초 표본은 저장하지 않는다(펼칠 것이 없다 — 지어내지 않는다). */
export function peakPointText(src, windowS = null) {
  const s = t(src);
  const w = n(windowS);
  if (s === 'sampler') return '서버 샘플러(B 안)의 5분 최대입니다 — 1초 표본 300개 펼침은 샘플러 배포(7단계) 뒤에 생깁니다. 지금은 펼칠 표본이 없습니다.';
  if (s === 'psi') return 'PSI 10초 평균은 보조 지표입니다 — 피크 값이 아닙니다.';
  if (s === 'none') return '이 주기에는 피크 표본이 없습니다.';
  return `${w != null && w > 0 ? `${w}초` : '1초'} 창 표본${w != null && w > 0 ? ` ${w}개` : ''}의 최대입니다(A 안) — 1초 표본은 저장하지 않아 펼칠 수 없습니다.`;
}

/** 결측 구간 사유(서버 gaps.reason). */
export const GAP_REASON_TEXT = Object.freeze({ 'no-data': '값 없음', migrating: '저장 구조를 옮기는 중' });
export const gapReasonText = (r) => GAP_REASON_TEXT[t(r)] || '값 없음';

/** 응답이 말하는 사실(엣지 대행 · 상한 · 빠진 기간 · 옮기는 중)을 그대로. */
export function trendNotes(resp = {}) {
  const out = [];
  if (!resp || typeof resp !== 'object') return out;
  if (resp.via === 'edge') out.push(`엣지 **${t(resp.agent)}** 가 대행해 읽은 값입니다${n(resp.ms) != null ? `(${Math.round(n(resp.ms))}ms)` : ''} — 중앙은 이 이력을 저장하지 않습니다.`);
  if (n(resp.truncated)) out.push(`점 상한을 넘어 오래된 점 **${n(resp.truncated)}개**를 잘랐습니다 — 기간을 줄이면 다 보입니다.`);
  if (resp.truncatedRows) out.push('조회 행 상한에 닿았습니다 — 오래된 쪽이 빠졌을 수 있습니다.');
  if (n(resp.sanitizeTruncated)) out.push(`엣지 응답이 상한을 넘어 **${n(resp.sanitizeTruncated)}개** 항목을 버렸습니다.`);
  if (Array.isArray(resp.missingPeriods) && resp.missingPeriods.length) {
    const ps = resp.missingPeriods.slice(0, 4).map((m) => `‘${t(m.period)}’`).join(' · ');
    out.push(`기간 파일이 없거나 열지 못한 기간이 있습니다: ${ps}${resp.missingPeriods.length > 4 ? ` 외 ${resp.missingPeriods.length - 4}개` : ''} — 그 구간은 결측입니다.`);
  }
  if (n(resp.filesCapped)) out.push(`조회당 파일 상한으로 오래된 기간 **${n(resp.filesCapped)}개**를 읽지 않았습니다.`);
  if (t(resp.error)) out.push('기간 파일을 읽다 오류가 있었습니다 — 일부 구간이 빠졌을 수 있습니다(결측으로 둡니다).');   // 원문(경로 · 파일 조각)은 싣지 않는다
  if (t(resp.migration)) out.push(`저장 구조를 옮기는 중입니다(단계 ‘${t(resp.migration)}’) — 1시간 롤업이 아직 없는 구간은 원시로 메우지 않고 결측으로 둡니다.`);
  return out;
}

/** 조회 실패 문구 — 404 는 ‘없거나 범위 밖’(존재 은닉 — 구분하지 않는다) · 엣지 실패는 그 사유. */
export function trendErrorText(err, resp = null) {
  if (resp && resp.ok === false) return `${resp.via === 'edge' ? `엣지 ${t(resp.agent)} 에서 ` : ''}추이를 읽지 못했습니다: ${t(resp.reason) || '사유 미상'}`;
  const s = t(err?.message || err);
  if (err?.status === 404 || /404|찾지 못했/.test(s)) return '이 서버의 추이를 찾지 못했습니다 — 대상에서 빠졌거나 볼 수 있는 범위 밖입니다.';
  return `추이를 읽지 못했습니다: ${s || '사유 미상'}`;
}

/* ─────────────────────────── 값 글자 ─────────────────────────── */
/** 값 글자 — 결측은 단위 없이 ‘—’. */
export function valText(v, unit = '') {
  const x = n(v);
  if (x == null) return '—';
  if (unit === '%') return pctText(x);
  if (unit === 'B/s') return bpsText(x);
  if (unit === 'bit/s') return bitsText(x);
  if (unit === 'ms') return `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10}ms`;
  if (unit === '건') return `${Math.round(x).toLocaleString('ko-KR')}건`;
  if (unit === '/s' || unit === 'pages/s') return `${x >= 10_000 ? `${(x / 1000).toFixed(1)}k` : Math.round(x * 10) / 10}/s`;
  return String(Math.round(x * 100) / 100);
}
/** 축 눈금 글자(짧게). */
export function axisText(v, unit = '') {
  const x = n(v);
  if (x == null) return '';
  if (unit === '%') return `${Math.round(x)}`;
  if (unit === 'B/s') return bpsText(x).replace(/\.\d+/, '').replace('/s', '');
  if (x >= 10_000) return `${Math.round(x / 1000)}k`;
  return String(Math.round(x * 10) / 10);
}
/** y 축 최대 — % 는 0~100 고정 · 그 밖은 보이는 값의 1.15배를 ‘보기 좋은’ 수로(공용 yMaxOf). */
export function yMaxFor(unit, seriesList = []) {
  if (unit === '%') return 100;
  const pts = [];
  for (const list of seriesList) for (const v of list || []) pts.push({ v });
  return yMaxOf('KBps', [pts]);
}

/* ─────────────────────────── 그리기(뷰박스 좌표) ─────────────────────────── */
/** 점 사이 (a, b) 를 서버 결측 구간이 덮으면 참 — 결측을 다시 계산하지 않고 서버 gaps 만 본다. */
export function gapBetween(a, b, gaps = []) {
  for (const g of gaps || []) {
    const f = n(g?.from); const e = n(g?.to);
    if (f == null || e == null) continue;
    if (f < b && e > a) return true;
  }
  return false;
}
/**
 * 계열 → SVG 경로(뷰박스 0..w × 0..h). pick = 'avg' | 'max' | 'peak'. 값이 null 이거나 사이에 결측 구간이 있으면 **끊는다**(M 으로 다시 시작) ·
 * 홀로 남은 점은 dots(선이 없으면 점으로 — 값이 있는데 안 보이면 거짓이다). 창(from~to) 밖의 점은 그리지 않는다.
 */
export function seriesPath(points = [], { pick = 'avg', from, to, yMax = 100, w = 1000, h = 100, gaps = [] } = {}) {
  const f = n(from); const e = n(to);
  if (f == null || e == null || !(e > f)) return { d: '', dots: [], drawn: 0 };
  const ym = n(yMax) && n(yMax) > 0 ? n(yMax) : 100;
  const segs = []; let cur = null; let prevT = null;
  for (const p of points || []) {
    const pt = n(p?.t); const v = n(p?.[pick]);
    if (pt == null || pt < f || pt > e) continue;
    if (v == null || (prevT != null && gapBetween(prevT, pt, gaps))) { if (cur) segs.push(cur); cur = null; }
    if (v != null) {
      const x = ((pt - f) / (e - f)) * w;
      const y = h - (Math.max(0, Math.min(v, ym)) / ym) * h;
      if (!cur) cur = [];
      cur.push([x, y]);
    }
    prevT = pt;
  }
  if (cur) segs.push(cur);
  let d = ''; const dots = []; let drawn = 0;
  for (const s of segs) {
    drawn += s.length;
    if (s.length === 1) { dots.push({ x: s[0][0], y: s[0][1] }); continue; }
    d += s.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ' ';
  }
  return { d: d.trim(), dots, drawn };
}
/** 결측 구간 띠(뷰박스 x) — 서버 gaps 를 창에 잘라서. */
export function gapBands(gaps = [], { from, to, w = 1000 } = {}) {
  const f = n(from); const e = n(to);
  if (f == null || e == null || !(e > f)) return [];
  return (gaps || []).map((g) => ({ a: Math.max(f, n(g?.from) ?? f), b: Math.min(e, n(g?.to) ?? e), reason: t(g?.reason) }))
    .filter((g) => g.b > g.a).map((g) => ({ x: ((g.a - f) / (e - f)) * w, width: ((g.b - g.a) / (e - f)) * w, reason: g.reason }));
}
/**
 * 피크 없는 주기 띠 — 평균은 있는데 피크가 없는 연속 점(피크 열이 있는 지표만 · 설계 §6 ‘피크 샘플이 없는 주기는 — 띠’).
 * @returns {Array<{from:number,to:number}>}(시각)
 */
export function noPeakRuns(points = [], { stepMs = 300_000 } = {}) {
  const out = []; let run = null;
  for (const p of points || []) {
    const pt = n(p?.t);
    if (pt == null) continue;
    const miss = n(p?.avg) != null && n(p?.peak) == null;
    if (miss) { if (!run) run = { from: pt, to: pt + (n(stepMs) || 0) }; else run.to = pt + (n(stepMs) || 0); }
    else if (run) { out.push(run); run = null; }
  }
  if (run) out.push(run);
  return out;
}
/** 시각 → 뷰박스 x(창 기준 · 밖이면 null). */
export function xOf(ms, { from, to, w = 1000 } = {}) {
  const v = n(ms); const f = n(from); const e = n(to);
  if (v == null || f == null || e == null || !(e > f) || v < f || v > e) return null;
  return ((v - f) / (e - f)) * w;
}
/** 화면 비율(0~1) → 시각. */
export function timeAtRatio(r, { from, to } = {}) {
  const f = n(from); const e = n(to); const x = n(r);
  if (f == null || e == null || x == null) return null;
  return Math.round(f + Math.max(0, Math.min(1, x)) * (e - f));
}
/** 시각에 가장 가까운 점(커서 툴팁). 없으면 null. */
export function nearestPoint(points = [], ms) {
  const v = n(ms);
  if (v == null) return null;
  let best = null; let dist = Infinity;
  for (const p of points || []) { const pt = n(p?.t); if (pt == null) continue; const dd = Math.abs(pt - v); if (dd < dist) { dist = dd; best = p; } }
  return best;
}

/* ─────────────────────────── 구간 요약(공용 seriesStats) ─────────────────────────── */
const inSel = (p, sel) => !sel || (n(p?.t) != null && n(p.t) >= sel.from && n(p.t) <= sel.to);
/**
 * 선택 구간(없으면 받은 창 전체)의 평균 · 최대 · 피크(+시각) · 결측 · 기준 이상 비율. 계산은 공용 seriesStats(결측은 분모에서 뺀다).
 * 기준 이상 비율은 응답 baseline.warn(설정값)을 seriesStats 의 overloadPct 로 넘겨 센다 — 이 모듈은 비교하지 않는다.
 */
export function windowSummary(points = [], { sel = null, baseline = null, peak = false } = {}) {
  const pts = (points || []).filter((p) => inSel(p, sel));
  const iso = (p) => (n(p?.t) == null ? null : new Date(n(p.t)).toISOString());
  const sAvg = seriesStats(pts.map((p) => ({ t: iso(p), v: p?.avg })), { overloadPct: baseline ? n(baseline.warn) : null, sampleSec: 1 });
  const sMax = seriesStats(pts.map((p) => ({ t: iso(p), v: p?.max })));
  const sPeak = peak ? seriesStats(pts.map((p) => ({ t: iso(p), v: p?.peak }))) : null;
  const peakPt = sPeak && sPeak.max != null ? pts.find((p) => n(p?.peak) === sPeak.max) : null;
  return {
    avg: sAvg.avg, max: sMax.max, maxAt: sMax.maxAt ? Date.parse(sMax.maxAt) : null,
    peak: sPeak ? sPeak.max : null, peakAt: peakPt ? (n(peakPt.peakAt) ?? n(peakPt.t)) : null,
    measured: sAvg.measured, missing: sAvg.missing,
    overRatio: sAvg.overSec != null && sAvg.measured > 0 ? Math.round((sAvg.overSec / sAvg.measured) * 1000) / 10 : null,
  };
}
/** 피크 ÷ 평균(배) — 둘 다 있고 평균이 0 보다 클 때만. */
export function peakRatioText(sum = {}) {
  const p = n(sum.peak); const a = n(sum.avg);
  if (p == null || a == null || a <= 0) return '—';
  return `${Math.round((p / a) * 10) / 10}×`;
}
/** 기준선 글자(설정값) — 없으면 ''(숫자를 박지 않는다). */
export function baselineText(bl, unit = '') {
  if (!bl) return '';
  const parts = [];
  if (n(bl.warn) != null) parts.push(`주의 ${valText(bl.warn, unit)}`);
  if (n(bl.bad) != null) parts.push(`초과 ${valText(bl.bad, unit)}`);
  return parts.length ? `기준(설정값) ${parts.join(' · ')}` : '';
}
/** 시각 글자 — 하루 안이면 HH:mm, 아니면 MM-DD HH:mm. */
export function whenText(ms, spanMs = DAY) {
  const v = n(ms);
  if (v == null) return '—';
  return (n(spanMs) ?? DAY) <= DAY * 1.5 ? fmtHm(v) : fmtClock(v);
}

/* ─────────────────────────── 장치 토글(§12) ─────────────────────────── */
/** 장치 색 — 서버가 준 고정 순서(`color` = 처음 본 순서)로만 정한다(필터로 색이 바뀌지 않는다). 6색 × 실선/점선. */
export const DEVICE_PALETTE = Object.freeze(['var(--accent-2)', 'var(--amber)', 'var(--purple)', 'var(--green)', 'var(--accent)', 'var(--mint)']);
export function deviceStyle(colorIdx) {
  const i = Math.max(0, Math.floor(n(colorIdx) ?? 0));
  return { stroke: DEVICE_PALETTE[i % DEVICE_PALETTE.length], dash: Math.floor(i / DEVICE_PALETTE.length) % 2 ? '6 4' : '' };
}
export const TOGGLE_MAX = 8;
export const DISK_MODES = Object.freeze([
  { k: 'all', label: '전체(가장 바쁜 장치)' },
  { k: 'disk', label: '디스크별' },
  { k: 'part', label: '파티션별' },
]);
export const NET_MODES = Object.freeze([
  { k: 'all', label: '전체(가장 높은 회선)' },
  { k: 'nic', label: '인터페이스별' },
]);
export const LAYOUTS = Object.freeze([
  { k: 'overlay', label: '겹쳐서(한 행 · 범례)' },
  { k: 'rows', label: '행 나눠서(장치마다 행)' },
]);
export const DEFAULT_TOGGLE = Object.freeze({ disk: 'all', net: 'all', layout: 'overlay' });
/** 토글 모드의 장치 목록(서버 순서 = 처음 본 순서). 파티션은 서버 옵트인(store.partitionIo)일 때만 들어온다. */
export function toggleDevices(devices = {}, mode = 'all') {
  const by = (a, b) => (n(a.ord) ?? 0) - (n(b.ord) ?? 0);
  if (mode === 'disk') return (devices.disk || []).filter((d) => d.info !== 'part').slice().sort(by);
  if (mode === 'part') return (devices.disk || []).filter((d) => d.info === 'part').slice().sort(by);
  if (mode === 'nic') return (devices.nic || []).slice().sort(by);
  return [];
}
/**
 * 그릴 장치(상한 8) · 남은 수 · 실제 배치. 8개를 넘으면 앞 8개(서버 순서 — 물리 → md → dm → 파티션)만 그리고 겹침은 행 나눔으로 바꾼다.
 * ⚠ 설계의 ‘기타(최대)’ 계열은 그리지 않는다 — 장치마다 조회가 하나씩 필요해 남은 장치 수만큼 요청이 늘어난다(정직 표기: restNote).
 */
export function planDevices(list = [], layout = 'overlay', sel = null) {
  const picked = sel && sel.length ? list.filter((d) => sel.includes(d.dev)) : list;
  const shown = picked.slice(0, TOGGLE_MAX);
  const rest = picked.length - shown.length;
  return { shown, rest, layout: list.length > TOGGLE_MAX ? 'rows' : layout, autoRows: list.length > TOGGLE_MAX && layout === 'overlay' };
}
export function restNote(rest) {
  return n(rest) > 0 ? `장치 ${n(rest)}개는 그리지 않았습니다(한 행 상한 ${TOGGLE_MAX}) — 범례에서 골라 바꿔 볼 수 있습니다.` : '';
}
/** 범례 클릭 — 그 장치만(이미 그것만이면 모두로) · Shift = 더하기/빼기. sel: null = 모두. */
export function legendNext(sel, dev, { shift = false, all = [] } = {}) {
  const allDevs = (all || []).map((d) => (typeof d === 'string' ? d : d.dev));
  const cur = sel && sel.length ? [...sel] : [...allDevs];
  if (!shift) return cur.length === 1 && cur[0] === dev ? null : [dev];
  const next = cur.includes(dev) ? cur.filter((x) => x !== dev) : [...cur, dev];
  if (!next.length || next.length === allDevs.length) return null;
  return next;
}
/** 한 패널의 행 목록(토글 상태대로) — 행마다 계열 spec 들(kind · metric · dev · 색). */
export function panelPlan(toggle = DEFAULT_TOGGLE, devices = {}, legend = {}) {
  const out = [];
  for (const r of PANEL_ROWS) {
    const mode = r.id === 'disk' ? toggle.disk : r.id === 'net' ? toggle.net : 'all';
    if (!r.devKind || mode === 'all') { out.push({ id: r.id, row: r, series: [{ kind: 'server', metric: r.metric, color: r.color }] }); continue; }
    const list = toggleDevices(devices, mode);
    const lg = legend[r.id] || null;
    const p = planDevices(list, toggle.layout, lg);
    const series = p.shown.map((d) => ({ kind: r.devKind, metric: r.devMetric, dev: d.dev, ...deviceStyle(d.color), color: deviceStyle(d.color).stroke, info: d.info || null }));
    if (!list.length) { out.push({ id: r.id, row: r, mode, series: [], empty: true, all: list }); continue; }
    if (p.layout === 'rows') series.forEach((s, i) => out.push({ id: `${r.id}:${s.dev}`, row: r, mode, series: [s], dev: s.dev, all: list, rest: p.rest, autoRows: p.autoRows, firstOfGroup: i === 0 }));
    else out.push({ id: r.id, row: r, mode, series, all: list, rest: p.rest, legend: true });
  }
  return out;
}
export const DEVICE_EMPTY_TEXT = Object.freeze({
  disk: '장치별 이력이 없습니다 — 이 서버의 장치 행이 아직 쌓이지 않았습니다(첫 수집 전 · OS 경로 없음).',
  part: '파티션 I/O 이력이 없습니다 — 파티션 I/O 는 설정(저장 구조의 파티션 I/O)을 켠 서버만 쌓습니다. 파티션 I/O 는 병합 · 캐시 때문에 디스크 합과 다를 수 있습니다.',
  nic: '인터페이스별 이력이 없습니다 — 물리 회선 · bond 만 쌓습니다(가상 인터페이스 · 링크 없는 포트 제외).',
});

/** 계열 키(조회 · 캐시 · CSV 열). */
export function seriesKey(s = {}) { return `${s.kind || 'server'}|${s.metric}|${s.dev || ''}`; }
/** 계열 이름(범례 · CSV). */
export function seriesLabel(s = {}) {
  const m = metricInfo(s.kind || 'server', s.metric);
  return s.dev ? `${m.label} — ${s.dev}` : m.label;
}

/* ─────────────────────────── 구간 이동 · 보존 ─────────────────────────── */
/** ◀ 이전으로 갈 수 있는 칸 수 — 보존(일)을 알 때만(이 노드 설정). 모르면 null(슬라이더 없이 ◀ · ▶ · 날짜만 — 서버가 보존 밖이면 말한다). */
export function trendMaxBack(spanMs, keepDays) {
  const k = n(keepDays); const s = n(spanMs);
  if (k == null || k <= 0 || s == null || s <= 0) return null;
  return Math.max(0, Math.floor((k * DAY) / s) - 1);
}

/* ─────────────────────────── CSV ─────────────────────────── */
/**
 * CSV — 시각(ISO) + 계열마다 평균 · 피크 열(토글 상태대로 그린 계열만). 결측은 빈 칸. 셀은 공용 toCsv(수식 가드).
 * @param {Array<{label:string, unit:string, points:Array, peak:boolean}>} list
 */
export function trendCsv(list = []) {
  const cols = [];
  for (const s of list) {
    cols.push({ head: `${s.label} 평균(${s.unit || '-'})`, pick: 'avg', s });
    if (s.peak) cols.push({ head: `${s.label} 피크(${s.unit || '-'})`, pick: 'peak', s });
  }
  const byT = new Map();
  for (const c of cols) for (const p of c.s.points || []) { const pt = n(p?.t); if (pt == null) continue; if (!byT.has(pt)) byT.set(pt, {}); byT.get(pt)[c.head] = n(p[c.pick]); }
  const rows = [['time', ...cols.map((c) => c.head)]];
  for (const pt of [...byT.keys()].sort((a, b) => a - b)) rows.push([new Date(pt).toISOString(), ...cols.map((c) => { const v = byT.get(pt)[c.head]; return v == null ? '' : v; })]);
  return `${toCsv(rows)}\r\n`;
}
export function trendCsvName(name, rangeK, endMs) {
  const safe = String(name || 'server').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const d = n(endMs) == null ? 'latest' : (dayStamp(n(endMs)) || 'latest');   // 포탈(브라우저) 날짜 — UTC 날짜로 하루 밀리지 않게(dayStamp 스윕)
  return `bm-trend_${safe}_${rangeK}_${d}.csv`;
}

/* ─────────────────────────── CVP 스위치 포트(§10) ─────────────────────────── */
/** 포트 상태(서버 portCompare.PORT_STATES) → 글자 · 톤 · 설명. 모르는 상태는 그 code 를 그대로 밝힌다(지어내지 않는다). */
export const PORT_STATE_INFO = Object.freeze({
  mapped: { label: '확정', tone: 'ok', body: '수동 매핑으로 확정된 포트 — 카운터가 신선해 대조합니다.' },
  candidate: { label: '후보 — 확인 필요', tone: 'warn', body: '포트 설명에 호스트명 · 서비스 태그 · NIC 이름이 있습니다 — 사람이 확정해야 대조합니다.' },
  'no-mapping': { label: '매핑 없음', tone: 'idle', body: '수동 매핑이 없고 포트 설명에서도 찾지 못했습니다 — 수동 매핑을 넣거나 스위치 포트 설명에 호스트명을 넣으세요.' },
  'no-cvp': { label: 'CVP 미등록 법인', tone: 'idle', body: '이 서버 법인에 등록된 CVP 가 없습니다 — 포트 열은 전부 ‘—’ 입니다.' },
  'no-counters': { label: '포트 카운터 없음', tone: 'warn', body: 'CVP 가 이 포트의 카운터를 빈 응답으로 줬습니다(실장비 빈 응답 기록 v2.641) — 사용률 · 오류는 ‘—’ 입니다.' },
  stale: { label: '오래됨', tone: 'warn', body: 'CVP 수집이 늦어 포트 값이 신선도 한계를 넘었습니다 — 대조하지 않습니다.' },
  // 3a 반증 D15: CVP 도구 접근이 없는 계정 — 서버가 포트 설명 · 처리량 · 매핑 · 후보를 내주지 않는다(상태만).
  'no-permission': { label: '권한 없음', tone: 'idle', body: 'CVP 도구 접근 권한이 없는 계정이라 포트 설명 · 처리량 · 매핑을 보여 주지 않습니다 — 상태만 보입니다.' },
});
export const PORT_STATE_ORDER = Object.freeze(['mapped', 'candidate', 'no-mapping', 'no-cvp', 'no-counters', 'stale', 'no-permission']);
export function portStateView(state) {
  return PORT_STATE_INFO[t(state)] || { label: `상태 ‘${t(state) || '—'}’`, tone: 'idle', body: '이 화면이 아직 모르는 상태 값입니다 — 서버가 준 그대로 적었습니다.' };
}
/** 대조 ⑤ 판정(서버 portCompare.COMPARE_VERDICTS) → 문장. ‘후보’ 로만 말한다(단정하지 않는다). */
export const COMPARE_INFO = Object.freeze({
  ok: { label: '일치', tone: 'ok', body: '서버와 포트가 같은 창에서 기준 안으로 맞습니다.' },
  mismatch: { label: '어긋남', tone: 'warn', body: '기준 이상 어긋납니다 — 중간 손실 또는 계측 창 불일치 **후보**.' },
  'port-errors': { label: '포트 오류 · 드롭', tone: 'warn', body: '포트에 오류 · 드롭이 있습니다 — 케이블 · 광모듈(GBIC 화면) **후보**.' },
  'server-drops': { label: '서버 드롭만', tone: 'warn', body: '서버 쪽에만 드롭 · 오류가 있습니다 — 커널 · 큐(교차 ④) **후보**.' },
  idle: { label: '거의 0', tone: 'idle', body: '두 쪽 다 거의 흐르지 않아 비율 비교가 뜻이 없습니다.' },
  'window-mismatch': { label: '창 불일치', tone: 'idle', body: '서버와 CVP 의 계측 창을 맞출 수 없어 **비교하지 않았습니다**.' },
  'no-data': { label: '값 없음', tone: 'idle', body: '한쪽 값이 없어 비교하지 않았습니다.' },
});
export function compareView(c) {
  if (!c || typeof c !== 'object') return null;
  const info = COMPARE_INFO[t(c.verdict)] || { label: `판정 ‘${t(c.verdict)}’`, tone: 'idle', body: '이 화면이 모르는 판정 값입니다.' };
  const reason = c.verdict === 'window-mismatch' && t(c.reason) ? ` (${t(c.reason)})` : c.verdict === 'no-data' && t(c.reason) ? ` (${t(c.reason) === 'window-unknown' ? '계측 창을 모름' : t(c.reason) === 'counters-missing' ? '카운터 없음' : t(c.reason)})` : '';
  return { ...info, body: `${info.body}${reason}` };
}
/** 대조 한 방향 — 서버 B/s ↔ 포트(÷8 해서 B/s · 서버가 이미 맞춰 줌) · 차이 %. */
export function pairText(p) {
  if (!p) return '—';
  return `서버 ${bpsText(p.server)} · 포트 ${bpsText(p.port)} · 차이 ${p.idle ? '—(거의 0)' : valText(p.diffPct, '%')}`;
}
/** 매핑 출처 4(설계 §10 우선순위) — LLDP · MAC 은 만들지 않았다(서버 notBuilt). 개수는 응답에서 센다(지어내지 않는다). */
export function mapSourceRows(resp = {}) {
  const nics = Array.isArray(resp?.nics) ? resp.nics : [];
  const nb = new Set(Array.isArray(resp?.notBuilt) ? resp.notBuilt : []);
  const manual = nics.filter((x) => x && x.mapping).length;
  const cand = Array.isArray(resp?.candidates) ? resp.candidates.length : 0;
  return [
    { no: 1, title: '수동 매핑', what: '서버 NIC ↔ 스위치 · 포트(설정 파일 — 관리자)', state: `수집 중 · 확정 ${manual}개`, trust: '확정', tone: 'ok' },
    { no: 2, title: '포트 설명 매칭', what: 'CVP 인터페이스 설명에 호스트명 · 서비스 태그 · NIC 이름', state: `수집 중 · 후보 ${cand}개`, trust: '후보 — 사람이 확정', tone: 'warn' },
    { no: 3, title: 'LLDP 이웃', what: '스위치가 본 이웃 시스템명 · 포트', state: nb.has('lldp') ? '만들지 않음 — CVP 조회 경로 미확인' : '—', trust: '—', tone: 'idle' },
    { no: 4, title: 'MAC 테이블', what: '서버 NIC MAC ↔ 포트', state: nb.has('mac') ? '만들지 않음 — 경로 미확인 · bond · VLAN 에서 흔들림' : '—', trust: '—', tone: 'idle' },
  ];
}
/** 상태별 개수(칩 범례). */
export function portStateCounts(resp = {}) {
  const c = {};
  for (const x of Array.isArray(resp?.nics) ? resp.nics : []) { const s = t(x?.state) || '—'; c[s] = (c[s] || 0) + 1; }
  return c;
}
/** 포트 절 안내 — 범위 · 숨김 · NIC 오류. */
export function portNotes(resp = {}) {
  const out = [];
  if (!resp || typeof resp !== 'object') return out;
  if (resp.cvpAccess === false) out.push(`CVP 도구 접근 권한이 없어 포트 값 · 매핑 · 후보를 보여 주지 않습니다${t(resp.reason) ? `(${t(resp.reason)})` : ''} — 서버 NIC 쪽 값만 봅니다.`);
  if (resp.cvpRegistered === false) out.push('이 서버 법인에 CVP 가 등록되어 있지 않습니다 — 포트 열은 전부 ‘—’ 입니다(0 이 아닙니다).');
  if (n(resp.hiddenOutOfScope)) out.push(`다른 법인 CVP 를 가리키는 매핑 **${n(resp.hiddenOutOfScope)}개**는 볼 수 있는 범위 밖이라 숨겼습니다.`);
  if (t(resp.nicError)) out.push(`서버 NIC 값을 읽지 못했습니다: ${t(resp.nicError)}`);
  out.push('범위 계정은 자기 법인 CVP 포트만 봅니다 · CVP 이력은 CVP 표 그대로 쓰고 서버 쪽에 복제하지 않습니다 · 포트 사용률은 CVP 의 0~100 밖 버림 규칙을 따릅니다.');
  return out;
}
