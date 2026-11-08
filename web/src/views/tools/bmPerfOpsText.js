/**
 * views/tools/bmPerfOpsText.js — 리눅스 성능 5단계(v2.929 예정) 화면 문구 · 좌표(순수): 집중 모니터링 · 점검 소모품 · 변경 이벤트 · 베이스라인 띠 · 구간 비교 · 알림 규칙.
 *
 * ⚠ 판정은 서버(health.js · perfAlerts.js · focus/run.js · baseline.js · compare.js) — 여기는 **서버 code → 문장**과 그리기 좌표뿐이다(판정 복제 금지 ·
 *   테스트가 서버 열거와 1:1 을 대조한다). 기준 숫자는 응답의 값을 보여 주기만(화면에 박지 않는다). 문구에 백틱 · uppercase 금지(루트 규약).
 */
import { numOrNull } from '../../numOrNull.js';
import { unitText } from '../unitText.js';
import { toCsv } from '../../util/csv.js';
import { dayStamp } from '../../dayStamp.js';
import { fmtHm } from '../../components/vmperf/vmPerfText.js';
import { verdictView } from './bmPerfText.js';

const n = numOrNull;

/* ── 집중 모니터링 ─────────────────────────────────────────────────────── */
/** 분 표본 지표(서버 focus/run.js FOCUS_METRICS + iDRAC CPU · dmesg 누적) → 이름 · 단위. */
export const FOCUS_METRIC_TEXT = Object.freeze({
  cpu_pct: { label: 'CPU 사용률', unit: '%' }, cpu_iowait_pct: { label: 'iowait', unit: '%' }, runq_per_core: { label: '런큐 ÷ 코어', unit: '' },
  disk_busy_pct: { label: '디스크 busy', unit: '%' }, disk_await_ms: { label: '디스크 await', unit: 'ms' }, disk_aqu: { label: '대기열 깊이', unit: '' },
  psi_io_full10: { label: 'PSI io full(avg10)', unit: '%' }, mem_pct: { label: '메모리 사용', unit: '%' }, swap_out_ps: { label: '스왑아웃', unit: '/s' },
  net_pct: { label: '네트워크 사용률', unit: '%' }, net_drop_delta: { label: 'NIC 드롭', unit: '건' }, net_err_delta: { label: 'NIC 오류', unit: '건' },
  power_w: { label: '전력(iDRAC)', unit: 'W' }, inlet_c: { label: '흡기(iDRAC)', unit: '℃' },
});
/** 히트 표 행 순서(아트보드 Focus). */
export const FOCUS_ROWS = Object.freeze(['cpu_pct', 'cpu_iowait_pct', 'runq_per_core', 'disk_busy_pct', 'disk_await_ms', 'disk_aqu', 'psi_io_full10', 'mem_pct', 'swap_out_ps', 'net_pct', 'net_drop_delta', 'power_w', 'inlet_c']);
export const FOCUS_STATUS_TEXT = Object.freeze({
  queued: { label: '대기', tone: 'idle' }, running: { label: '진행 중', tone: 'warn' }, done: { label: '완료', tone: 'ok' }, stopped: { label: '중지됨', tone: 'idle' },
  auth: { label: '중단 — 인증 거부', tone: 'bad' }, interrupted: { label: '중단 — 포탈 재시작', tone: 'idle' }, failed: { label: '실패', tone: 'bad' },
});
export const FOCUS_MISS_TEXT = Object.freeze({
  timeout: 'SSH 시한 초과', auth: '인증 거부(즉시 중단)', 'auth-stopped': '인증 정지 중이라 시도하지 않음', 'ssh-error': 'SSH 오류', 'host-key': '호스트키 확인 거부',
  'not-linux': '리눅스 셸이 아님', 'no-path': '경로 없음', 'pool-busy': '동시성 풀이 가득 차 이번 분을 건너뜀', unreachable: '응답 없음', 'no-telemetry': '텔레메트리 없음', error: '오류',
});
/** 시작 · 중지 결과 code(서버 FOCUS_CODE_STATUS) → 문장 · 톤. */
export const FOCUS_CODE_TEXT = Object.freeze({
  ok: { text: '집중 모니터링을 시작했습니다.', tone: 'ok' },
  queued: { text: '이 법인의 동시 집중 상한에 닿아 대기열에 넣었습니다.', tone: 'warn' },
  'bad-reason': { text: '사유를 2자 이상 적어야 합니다(감사 기록에 남습니다).', tone: 'bad' },
  'bad-request': { text: '요청 형식이 올바르지 않습니다.', tone: 'bad' },
  'not-found': { text: '대상 서버를 찾지 못했습니다(없거나 범위 밖).', tone: 'bad' },
  forbidden: { text: '이 서버의 법인에 쓰기 권한이 없습니다(조회 전용).', tone: 'bad' },
  'no-path': { text: '이 서버에는 OS · iDRAC 수집 경로가 없습니다.', tone: 'bad' },
  busy: { text: '이 서버의 집중 모니터링이 이미 진행 중이거나 대기 중입니다.', tone: 'warn' },
  'daily-cap': { text: '하루 상한에 닿았습니다.', tone: 'warn' },
  'auth-stopped': { text: 'OS 계정이 인증 실패로 정지돼 있어 자동 집중을 시작하지 않았습니다.', tone: 'warn' },
  'store-unavailable': { text: '집중 모니터링 보관 DB 를 열 수 없어 시작하지 않았습니다.', tone: 'bad' },
  'settings-unreadable': { text: '집중 모니터링 설정을 읽지 못했습니다.', tone: 'bad' },
  edge: { text: '그 서버를 수집하는 엣지에 닿지 못했습니다.', tone: 'bad' },
  // 8a단계 ③: 정비 창 안 — 자동 집중만 쉰다(수동 집중은 사유와 함께 허용).
  maintenance: { text: '정비 창 안이라 자동 집중을 시작하지 않았습니다(수동 집중은 사유를 적고 실행할 수 있습니다).', tone: 'warn' },
});
/** 조치 제안 code(서버 summarizeFocus actions) → 문장. 단정하지 않는다(‘확인’). */
export const ACTION_TEXT = Object.freeze({
  'check-batch': '같은 시각의 백업 · 배치 작업(cron · pg_dump 등)이 업무 시간에 돌았는지 확인 — 백업 창으로 옮길 수 있는지',
  'tuning-dirty': 'vm.dirty_* · 체크포인트 설정을 용도 프로파일 권장값과 대조(튜닝 탭)',
  'check-runq': '런큐가 코어 수를 넘은 분의 상위 프로세스 확인(분별 프로세스 표)',
  'check-memory': '스왑아웃 · OOM 이 있었는지(점검 소모품 · 진단 스냅샷)',
  'check-network': '드롭 · 오류 증가가 서버 쪽인지 스위치 포트 쪽인지(추이 탭 D 절 · 교차 판정 ④)',
  'enable-auto-focus': '재발하면 자동 집중 모니터링 규칙 켜기(설정 › 알림 규칙)',
});
export const FOCUS_HONEST = '1분 간격 SSH 는 그 시간 동안 서버에 로그인을 분마다 한 번 더 만듭니다(sshd 로그인 10회/10분). ‘원인 후보’ 는 분마다 I/O · CPU 1위가 몇 번 겹쳤는지(상관)이고 인과는 담당자가 확인합니다. 결측 분은 비우고 0 으로 채우지 않습니다 — OS · iDRAC 는 따로 셉니다.';

export function focusStatusView(st) { return FOCUS_STATUS_TEXT[st] || { label: String(st || '—'), tone: 'idle' }; }
export function focusCodeView(code) { return FOCUS_CODE_TEXT[code] || { text: `알 수 없는 결과(${String(code || '—')})`, tone: 'bad' }; }
/** 값 + 단위. 없으면 ‘—’(단위를 붙이지 않는다). */
export function vText(v, unit = '') {
  const x = n(v);
  if (x == null) return '—';
  const r = Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
  return `${r.toLocaleString('ko-KR')}${unit || ''}`;
}
/** 그 분 OS 경로 결측인가(순수 — 반증 F14: ‘경로 없음(no-path)’ 은 결측이 아니다 · iDRAC 만 있는 서버의 분을 점선으로 그리지 않는다). */
export function osMissed(s) { return !!s && !s.osOk && !!s.missOs && s.missOs !== 'no-path'; }
/** 진행 띠 칸(순수) — 세션 길이만큼. 칸: { idx, state:'done'|'missing'|'pending'|'partial', tone, title }. */
export function progressCells(session = {}, samples = []) {
  const count = Math.max(1, n(session.count) ?? samples.length ?? 1);
  const by = new Map((samples || []).map((s) => [n(s.idx), s]));
  return Array.from({ length: count }, (_, i) => {
    const s = by.get(i);
    if (!s) return { idx: i, state: 'pending', tone: 'idle', title: `${i + 1}분 — 아직` };
    if (osMissed(s)) return { idx: i, state: 'missing', tone: 'idle', title: `${i + 1}분 — 결측(${FOCUS_MISS_TEXT[s.missOs] || s.missOs})${s.idracOk ? ' · iDRAC 만 있음' : ''}`, at: s.minuteTs };
    const v = s.verdict ? verdictView(s.verdict) : null;
    return { idx: i, state: s.missIdrac && s.missIdrac !== 'no-path' ? 'partial' : 'done', tone: v ? v.tone : 'idle', title: `${i + 1}분 — ${v ? v.label : '판정 없음'}${s.missIdrac && s.missIdrac !== 'no-path' ? ` · iDRAC 결측(${FOCUS_MISS_TEXT[s.missIdrac] || s.missIdrac})` : ''}`, at: s.minuteTs };
  });
}
/** 히트 표 행(순수) — 지표마다 분 칸(평균 / 피크). 값이 하나도 없는 지표는 뺀다(전부 ‘—’ 행을 그리지 않는다). */
export function heatRows(samples = [], { rows = FOCUS_ROWS } = {}) {
  const out = [];
  for (const m of rows) {
    const cells = samples.map((s) => {
      if (osMissed(s) && !['power_w', 'inlet_c'].includes(m)) return { miss: true };
      const v = s.vals?.[m];
      return v ? { avg: n(v.avg), peak: n(v.peak) } : { avg: null, peak: null };
    });
    if (!cells.some((c) => c.avg != null || c.peak != null)) continue;
    const all = cells.flatMap((c) => [c.avg, c.peak]).filter((x) => x != null);
    out.push({ metric: m, ...FOCUS_METRIC_TEXT[m], cells, max: all.length ? Math.max(...all) : null });
  }
  return out;
}
/** 히트 칸 농도(0~1) — 그 지표의 이 세션 최대 대비(색 강도만 — 판정이 아니다). */
export function heatAlpha(v, max) { const x = n(v); const m = n(max); return x == null || m == null || m <= 0 ? 0 : Math.max(0.06, Math.min(1, x / m)); }
/** 앞 1시간 대비 행(순수) — before(5분 평균 · 최대) vs 세션(분 평균의 평균 · 최대). */
export function beforeRows(summary = {}, samples = []) {
  const b = summary?.before || {};
  return FOCUS_ROWS.filter((m) => b[m] || samples.some((s) => s.vals?.[m])).map((m) => {
    const vs = samples.map((s) => n(s.vals?.[m]?.avg)).filter((x) => x != null);
    const pk = samples.map((s) => n(s.vals?.[m]?.peak) ?? n(s.vals?.[m]?.avg)).filter((x) => x != null);
    const avg = vs.length ? vs.reduce((a, x) => a + x, 0) / vs.length : null;
    const bAvg = n(b[m]?.avg);
    return { metric: m, ...FOCUS_METRIC_TEXT[m], beforeAvg: bAvg, beforeMax: n(b[m]?.max), beforeN: n(b[m]?.n), avg, max: pk.length ? Math.max(...pk) : null,
      ratio: avg != null && bAvg != null && bAvg > 0 ? Math.round((avg / bAvg) * 10) / 10 : null };
  });
}
/** 세션의 이벤트 띠(순수) — 시작 · 판정 바뀜 · 결측 · dmesg 오류 증가 · 끝 + 같은 시간대 변경 이벤트. 시각 순. */
export function focusEvents(session = {}, samples = [], changes = []) {
  const ev = [];
  if (session.start) ev.push({ at: session.start, kind: 'start', text: `${session.trigger === 'auto' ? '자동 규칙' : '수동'} 시작${session.reason ? ` — ${session.reason}` : ''}` });
  let prevV = null; let prevD = null;
  for (const s of samples || []) {
    if (osMissed(s)) ev.push({ at: s.minuteTs, kind: 'missing', text: `결측 — ${FOCUS_MISS_TEXT[s.missOs] || s.missOs}${s.idracOk ? ' · iDRAC 값만 기록' : ''}` });
    if (s.verdict && s.verdict !== prevV) { if (prevV) ev.push({ at: s.minuteTs, kind: 'verdict', text: `판정 ${verdictView(prevV).label} → ${verdictView(s.verdict).label}` }); prevV = s.verdict; }
    const d = n(s.vals?.dmesg_err?.avg);
    if (d != null && prevD != null && d > prevD) ev.push({ at: s.minuteTs, kind: 'dmesg', text: `커널 오류 메시지 +${d - prevD}건(개수만 — 원문은 진단 스냅샷)` });
    if (d != null) prevD = d;
  }
  for (const c of changes || []) ev.push({ at: c.ts, kind: 'change', text: `${changeKindText(c.kind)} ${c.item}${c.before != null || c.after != null ? ` ${c.before ?? '—'} → ${c.after ?? '—'}` : ''}` });
  if (session.end && session.status !== 'running') ev.push({ at: session.end, kind: 'end', text: `끝 — ${focusStatusView(session.status).label}` });
  return ev.filter((e) => n(e.at) != null).sort((a, b) => a.at - b.at);
}
/**
 * 결측 경로별 문구(순수) — 요약의 missOs · missIdrac 가 **null 이면 그 경로가 없는 서버**다(0 분 결측이 아니다).
 * 세션 카운터(DB 정수)가 있으면 그 값, 없으면 요약 값 · 둘 다 없으면 '—'.
 */
export function missPathParts(session = {}, summary = {}) {
  const one = (label, cnt, sv) => {
    if (sv === null) return { text: `${label} 경로 없음`, n: null };
    const v = n(cnt) ?? n(sv);
    return v == null ? { text: `${label} —`, n: null } : { text: `${label} ${v}분`, n: v };
  };
  const os = one('OS', session?.missOs, summary?.missOs); const idrac = one('iDRAC', session?.missIdrac, summary?.missIdrac);
  const ns = [os.n, idrac.n].filter((v) => v != null);
  return { os: os.text, idrac: idrac.text, total: ns.length ? ns.reduce((a, b) => a + b, 0) : null };
}
/** 결론 카드 문장(순수) — 판정 변화 · 원인 후보(상관) · 결측. */
export function conclusionParts(summary = {}, session = {}) {
  const s = summary || {};
  const from = s.verdictFrom ? verdictView(s.verdictFrom).label : '—'; const to = s.verdictTo ? verdictView(s.verdictTo).label : '—';
  const parts = [`**판정** ${from} → ${to}${s.worst ? ` (가장 나빴던 판정 ${verdictView(s.worst).label})` : ''}`];
  const c = (s.candidates || [])[0];
  parts.push(c ? `**원인 후보(상관)** ${c.name} — 스냅샷이 있는 ${c.of}분 중 I/O 1위 ${c.io}회 · CPU 1위 ${c.cpu}회. 인과는 담당자가 확인합니다.` : '**원인 후보** 없음 — 분별 프로세스 스냅샷이 없거나 1위가 겹치지 않았습니다.');
  const mp = missPathParts(session, s);
  parts.push(`**결측** ${mp.os} · ${mp.idrac}(0 으로 채우지 않았습니다)${session.status === 'running' ? ' · 진행 중이라 임시 결론입니다' : ''}`);
  return parts;
}
export function focusCsv(session = {}, samples = []) {
  const head = ['minute', 'verdict', 'os_ok', 'idrac_ok', 'miss_os', 'miss_idrac', ...FOCUS_ROWS.flatMap((m) => [`${m}_avg`, `${m}_peak`]), 'io_top1', 'cpu_top1'];
  const rows = [head];
  for (const s of samples) rows.push([new Date(s.minuteTs).toISOString(), s.verdict || '', s.osOk ? 1 : 0, s.idracOk == null ? '' : s.idracOk ? 1 : 0, s.missOs && s.missOs !== 'no-path' ? s.missOs : '', s.missIdrac && s.missIdrac !== 'no-path' ? s.missIdrac : '',
    ...FOCUS_ROWS.flatMap((m) => [n(s.vals?.[m]?.avg) ?? '', n(s.vals?.[m]?.peak) ?? '']), s.snap?.ioTop?.[0]?.name || '', s.snap?.cpuTop?.[0]?.name || '']);
  return `${toCsv(rows)}\r\n`;
}
export function focusCsvName(name, session = {}) {
  const safe = String(name || 'server').replace(/[^\w.-]+/g, '_').slice(0, 60);
  return `bm-focus_${safe}_${n(session.start) == null ? 'session' : (dayStamp(session.start) || 'session')}.csv`;
}
/** 진행 중 화면만 다시 읽는 간격(ms) — 근거: 1분 표본이라 30초면 한 분을 놓치지 않는다 · 세션당 최대 (길이 × 2 + 2)회로 묶인다(BmFocusTab 이 센다). */
export const FOCUS_POLL_MS = 30_000;
export function focusPollMax(session = {}) { return Math.max(4, Math.ceil(((n(session.count) || 10) * (n(session.intervalS) || 60) * 1000) / FOCUS_POLL_MS) + 4); }
/** 폴링 한 번(순수 — 반증 F8): 지금까지 횟수 polls 로 다음을 갈지 · 갈 때 목록도 다시 읽을지(4회에 1번). 상한(focusPollMax)을 넘기면 멈춘다. */
export function focusPollStep(polls = 0, session = {}) {
  const max = focusPollMax(session);
  const p = Math.max(0, Math.floor(Number(polls) || 0));
  if (p >= max) return { go: false, polls: p, reloadList: false, max };
  const next = p + 1;
  return { go: true, polls: next, reloadList: next % 4 === 0, max };
}

/* ── 점검 소모품 ───────────────────────────────────────────────────────── */
export const HEALTH_CELL_TEXT = Object.freeze({
  chrony: { label: '시각 동기(chrony)', reads: 'chronyc -c tracking(##CHRONY)', basis: 'GPDB 문서 ‘Synchronize system clocks’', grade: '●' },
  units: { label: '실패 유닛(systemd)', reads: 'systemctl --failed(##UNITS)', basis: '관행', grade: '○' },
  oom: { label: 'OOM kill', reads: '/proc/vmstat oom_kill(##VMSTAT)', basis: 'USE 방법 — OOM killer', grade: '◐' },
  dmesg: { label: '커널 오류 메시지', reads: 'dmesg --level=err,warn 개수(##DMESG — 원문 없음)', basis: '관행(Netflix 60초 점검: dmesg 먼저)', grade: '○' },
  uptime: { label: '가동 시간 · 재부팅 필요', reads: '/proc/uptime · needs-restarting -r(##CHANGES)', basis: 'Rocky 9.4 노트 — dnf 업그레이드 경로', grade: '●' },
  fdct: { label: '파일 디스크립터 · conntrack', reads: 'fs/file-nr · nf_conntrack_count/max(##CHANGES)', basis: 'GPDB nofile 요구', grade: '●' },
  cert: { label: '인증서 만료', reads: '기존 성능 점검(Monitoring) cert 점검 재사용', basis: '기존 모듈', grade: '○' },
  tuned: { label: 'TuneD · SELinux · firewalld', reads: 'TuneD 프로파일(##SYSCTL) · getenforce(##OSREL) · systemctl is-active(##CHANGES)', basis: '용도 프로파일 요구값과 대조는 튜닝 · 용도 탭', grade: '●' },
});
export const HEALTH_CODE_TEXT = Object.freeze({
  ok: { label: '정상', tone: 'ok' }, warn: { label: '주의', tone: 'warn' }, bad: { label: '이상', tone: 'bad' }, missing: { label: '확인 불가 — 못 읽음', tone: 'idle' },
  absent: { label: '없음', tone: 'idle' }, perm: { label: '권한 부족 또는 실패', tone: 'idle' }, na: { label: '해당 없음', tone: 'idle' }, info: { label: '참고', tone: 'info' },
});
const sign = (v) => (v > 0 ? `+${v}` : `${v}`);
/** 칸 값 문장(순수 — 서버가 준 값을 그대로 적는다 · 없으면 ‘—’). */
export function healthValueText(id, c = {}) {
  if (!c || ['missing'].includes(c.code)) return '—';
  if (id === 'chrony') {
    if (c.code === 'absent') return 'chrony 없음';
    if (c.synced === false) return '소스 없음(동기 안 됨)';
    return c.offsetMs == null ? '—' : `${sign(Math.round(c.offsetMs * 10) / 10)} ms`;
  }
  if (id === 'units') return c.failed == null ? '—' : String(c.failed);
  if (id === 'oom') return c.code === 'info' ? `부팅 이후 ${unitText(c.total, '회')}` : `증가 ${c.delta ?? '—'} · 부팅 이후 ${c.total ?? '—'}`;
  if (id === 'dmesg') return c.code === 'perm' ? '읽지 못함' : `24시간 오류 ${c.err24 ?? '—'} · 경고 ${c.warn24 ?? '—'}`;
  if (id === 'uptime') return `${c.upDays == null ? '—' : `${c.upDays}일`}${c.needsRestart === true ? ' · 재부팅 필요' : c.needsRestart === false ? '' : c.code === 'na' ? ' · 재부팅 필요 여부 확인 불가' : ''}`;
  if (id === 'fdct') return `FD ${c.fdPct == null ? '—' : `${c.fdPct}%`} · conntrack ${c.conntrackAbsent ? '없음' : c.conntrackPct == null ? '—' : `${c.conntrackPct}%`}`;
  if (id === 'cert') return c.code === 'na' ? '—' : c.days == null ? '—' : c.days <= 0 ? `만료(${Math.abs(c.days)}일 지남)` : `D-${c.days}`;
  if (id === 'tuned') return [c.tuned || 'TuneD —', `SELinux ${c.selinux || '—'}`, `firewalld ${c.firewalld || '—'}`].join(' · ');
  return '—';
}
/** 칸 기준 문장(응답 값 — 숫자를 박지 않는다). */
export function healthLimitText(id, c = {}) {
  if (id === 'chrony' && c.limitMs != null) return `기준 ±${c.limitMs}ms(설정)`;
  if (id === 'dmesg' && c.limit != null) return `기준 24시간 ${c.limit}건(설정)`;
  if (id === 'fdct' && (c.limitFd != null || c.limitCt != null)) return `기준 ${unitText(c.limitFd, '%')} · ${unitText(c.limitCt, '%')}(설정)`;
  if (id === 'cert' && c.limit != null) return `기준 ${c.limit}일 전(설정)`;
  if (id === 'cert' && c.code === 'na') return '이 서버 주소로 등록된 TLS 점검이 없습니다 — 확인 불가와 다른 ‘해당 없음’';
  return '';
}
/** 처음 그 code 가 된 뒤 며칠째(전이 기록). */
export function daysSinceText(since, now = Date.now()) {
  const s = n(since); if (s == null) return '—';
  const d = Math.floor((now - s) / 86_400_000);
  return d <= 0 ? '오늘' : `${d}일째`;
}
/** 함대 표 행(순수) — 보드 항목의 목록용 health(code · since) 중 주의 · 이상 칸이 있는 서버. 가장 오래된 since 가 ‘며칠째’. */
export function healthAttentionRows(items = [], now = Date.now()) {
  const out = [];
  for (const it of items) {
    const h = it?.entry?.health;
    if (!h?.cells) continue;
    const bad = Object.entries(h.cells).filter(([, c]) => c?.code === 'warn' || c?.code === 'bad');
    if (!bad.length) continue;
    const since = Math.min(...bad.map(([, c]) => n(c.since) ?? now));
    out.push({ key: it.key, name: it.name || it.key, vcenterId: it.vcenterId || '', agent: it.agent || '', cells: bad.map(([k, c]) => ({ id: k, code: c.code })), since, worst: bad.some(([, c]) => c.code === 'bad') ? 'bad' : 'warn' });
  }
  return out.sort((a, b) => (a.worst === b.worst ? a.since - b.since : a.worst === 'bad' ? -1 : 1));
}
export const HEALTH_HONEST = '카드 한 칸 = 값 + 읽는 곳 + 기준(설정) + 근거 등급. ‘확인 불가 · 없음 · 해당 없음’ 은 정상도 주의도 아니고 따로 셉니다. chronyc · needs-restarting · dnf 출력 형식은 이 현장 실장비에서 아직 확인하지 못했습니다(문서 기준).';

/* ── 변경 이벤트 ───────────────────────────────────────────────────────── */
export const CHANGE_KIND_TEXT = Object.freeze({
  reboot: '재부팅', kernel: '커널', 'needs-restart': '재부팅 필요', package: '패키지', sysctl: 'sysctl', 'sysctl-file': 'sysctl 파일', 'sysctl-all': 'sysctl 전체',
  cron: '크론', tuned: 'TuneD', selinux: 'SELinux', firewalld: 'firewalld', 'units-failed': '실패 유닛', firmware: '펌웨어', 'cvp-map': 'CVP 매핑', health: '소모품 칸',
});
export function changeKindText(k) { return CHANGE_KIND_TEXT[k] || String(k || '—'); }
export const CHANGES_HONEST = '변경은 이전 주기와 다를 때만 적습니다(전이). 설정 파일 · crontab 은 CRC(해시)만 비교하고 내용은 보관하지 않습니다 — 무엇이 바뀌었는지는 sysctl 키 · 패키지 수 · 파일 이름까지만 압니다. ‘영향’ 은 추정하지 않습니다 — 추이 위 점과 시각이 겹치는지만 보십시오.';
/** 추이 위 점(순수) — 창 안 이벤트를 x 비율로(같은 시각 여러 개는 한 점에 묶는다). */
export function changeMarks(events = [], win = {}) {
  const span = (n(win.to) ?? 0) - (n(win.from) ?? 0);
  if (!(span > 0)) return [];
  const by = new Map();
  for (const e of events || []) {
    const t = n(e.ts); if (t == null || t < win.from || t > win.to) continue;
    const k = Math.round(((t - win.from) / span) * 400);
    const cur = by.get(k) || { t, items: [] };
    cur.items.push(e); by.set(k, cur);
  }
  return [...by.values()].map((m) => ({ t: m.t, title: m.items.map((e) => `${fmtHm(e.ts)} ${changeKindText(e.kind)} ${e.item}`).join('\n'), n: m.items.length }));
}

/* ── 베이스라인 띠 ─────────────────────────────────────────────────────── */
export const BAND_REASON_TEXT = Object.freeze({ 'no-history': '이력 없음', 'few-weeks': '표본 주 수 부족', missing: '결측이 많음' });
/** 띠 다각형(순수) — reason 칸에서 끊는다. 반환: SVG polygon points 문자열 배열(뷰박스 w × h · yMax). */
export function bandPolys(series = [], { from, to, yMax = 100, w = 1000, h = 100 } = {}) {
  const span = to - from; if (!(span > 0)) return [];
  const x = (t) => ((t - from) / span) * w; const y = (v) => h - (Math.max(0, Math.min(v, yMax)) / yMax) * h;
  const runs = []; let cur = [];
  const pts = [...(series || [])].filter((p) => n(p.t) != null).sort((a, b) => a.t - b.t);
  for (const p of pts) {
    if (p.reason || n(p.lo) == null || n(p.hi) == null) { if (cur.length) runs.push(cur); cur = []; continue; }
    cur.push(p);
  }
  if (cur.length) runs.push(cur);
  return runs.map((r) => {
    const ext = r.length === 1 ? [r[0], { ...r[0], t: r[0].t + 3_600_000 }] : [...r, { ...r.at(-1), t: r.at(-1).t + 3_600_000 }];
    const top = ext.map((p) => `${Math.max(0, Math.min(w, x(p.t))).toFixed(1)},${y(p.hi).toFixed(1)}`);
    const bot = ext.slice().reverse().map((p) => `${Math.max(0, Math.min(w, x(p.t))).toFixed(1)},${y(p.lo).toFixed(1)}`);
    return [...top, ...bot].join(' ');
  });
}
/* 띠 밖 점은 서버가 판정해 응답(baseline.outsideOf → outside)에 싣는다 — 웹은 그리기만(반증 L3: 웹 outsidePoints 가 서버 deviationOf 를 복제했다). */
export function bandSummaryText(resp = {}) {
  const s = resp?.series || [];
  if (!s.length) return '베이스라인 없음';
  const ok = s.filter((x) => !x.reason).length;
  if (!ok) return `베이스라인 없음 — ${BAND_REASON_TEXT[s[0].reason] || s[0].reason}(지난 ${unitText(resp.weeks, '주')} 같은 요일 · 시각 표본이 ${unitText(resp.minWeeks, '주')} 미만이거나 결측이 ${unitText(resp.maxMissingPct, '%')} 넘음)`;
  return `띠 = 지난 ${resp.weeks}주 같은 요일 · 같은 시각(1시간 롤업) 평균 ±${resp.bandPct}% · ${ok}/${s.length}시간에 띠가 있습니다${ok < s.length ? '(나머지 시간은 표본 부족 — 그리지 않음)' : ''} · 휴일 · 월말 같은 달력 효과는 모릅니다`;
}

/* ── 구간 비교 ─────────────────────────────────────────────────────────── */
export const COMPARE_METRIC_TEXT = Object.freeze({
  cpu_pct: FOCUS_METRIC_TEXT.cpu_pct, cpu_iowait_pct: FOCUS_METRIC_TEXT.cpu_iowait_pct, runq_per_core: FOCUS_METRIC_TEXT.runq_per_core, disk_busy_pct: FOCUS_METRIC_TEXT.disk_busy_pct,
  disk_await_ms: FOCUS_METRIC_TEXT.disk_await_ms, disk_aqu: FOCUS_METRIC_TEXT.disk_aqu, mem_pct: FOCUS_METRIC_TEXT.mem_pct, swap_out_ps: FOCUS_METRIC_TEXT.swap_out_ps, net_pct: FOCUS_METRIC_TEXT.net_pct,
});
export const COMPARE_PRESETS = Object.freeze([{ k: 'yesterday', label: '어제 같은 시각' }, { k: 'lastweek', label: '지난주 같은 요일' }, { k: 'focus', label: '집중 세션' }, { k: 'custom', label: '직접' }]);
/** A/B 창(순수) — B 는 선택 구간(없으면 최근 1시간), A 는 프리셋. 집중 세션이면 A = 그 세션 · B = 같은 길이의 지금. */
export function comparePair({ preset = 'yesterday', sel = null, now = Date.now(), session = null, customA = null, len = 3_600_000 } = {}) {
  const bTo = sel ? sel.to : now; const bFrom = sel ? sel.from : now - len;
  const L = bTo - bFrom;
  if (preset === 'lastweek') return { a: { from: bFrom - 7 * 86_400_000, to: bTo - 7 * 86_400_000 }, b: { from: bFrom, to: bTo } };
  if (preset === 'focus' && session?.start) { const fl = Math.max(60_000, (n(session.end) ?? (session.start + (session.count || 10) * (session.intervalS || 60) * 1000)) - session.start); return { a: { from: session.start, to: session.start + fl }, b: { from: now - fl, to: now } }; }
  if (preset === 'custom' && n(customA) != null) return { a: { from: customA, to: customA + L }, b: { from: bFrom, to: bTo } };
  return { a: { from: bFrom - 86_400_000, to: bTo - 86_400_000 }, b: { from: bFrom, to: bTo } };
}
export function diffText(pct) { const x = n(pct); return x == null ? '—' : `${x > 0 ? '+' : ''}${Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('ko-KR') : x}%`; }
export function compareCsv(resp = {}) {
  const rows = [['metric', 'a_avg', 'a_peak', 'b_avg', 'b_peak', 'diff_avg_pct', 'diff_peak_pct', 'pairs', 'excluded']];
  for (const m of resp.metrics || []) rows.push([m.metric, m.a?.avg ?? '', m.a?.peak ?? '', m.b?.avg ?? '', m.b?.peak ?? '', m.diffAvgPct ?? '', m.diffPeakPct ?? '', m.pairs ?? '', m.excluded ?? '']);
  return `${toCsv(rows)}\r\n`;
}
export const COMPARE_HONEST = '비교는 같은 길이 · 같은 롤업으로만 합니다(길이가 다르면 짧은 쪽에 맞추고 위에 적습니다). 어느 한쪽이라도 결측인 칸은 양쪽에서 빼고 개수를 적습니다. 판정(USE)의 과거 값은 저장하지 않아 판정 행은 없습니다. 튜닝 값 차이는 변경 이벤트(전이 기록)에서 A 끝 ~ B 끝 사이에 바뀐 것만입니다.';

/* ── 알림 규칙 ─────────────────────────────────────────────────────────── */
export const RULE_TEXT = Object.freeze({
  use: { label: 'USE 판정 변화', conds: { 'sat-err': '정상/주의 → 포화 · 오류 · 병목', bottleneck: '병목(두 칸 이상)만', errors: '오류만' } },
  cross: { label: '교차 판정 성립', conds: { any: '①~④ 중 후보가 하나라도' } },
  focusEnd: { label: '집중 모니터링 결론', conds: { 'not-ok': '끝났을 때 정상으로 안 돌아옴', any: '어떤 결론이든' } },
  baseline: { label: '베이스라인 이탈', conds: { band: '감시 지표가 띠 밖' } },
  health: { label: '점검 소모품', conds: { any: '주의 또는 이상 칸', bad: '이상 칸만' } },
  profile: { label: '용도 프로파일 점검 실패', conds: { bad: '점검 결과 이상(CRITICAL)' } },
  // 6단계 — 서버가 아니라 수집 노드 한 칸(주기 소요 · 성공률 · DB 상한 · 인증 정지 — 기준은 아래 ‘수집 건강 기준’).
  collect: { label: '수집 건강(이 노드)', conds: { any: '기준 밖 칸이 하나라도', cycle: '주기 소요가 예산의 기준 % 이상', success: '성공률이 기준 % 미만', db: 'DB 가 상한의 기준 % 이상', auth: '인증 정지 서버가 있음', error: '주기가 실패함(분류 실패 · 예외 — 대상 · 결과를 모름)' } },
  // 7a단계 — 로그 분석(이번 주기에 새로 읽은 줄 — 못 읽은 서버는 판정 보류 · 포탈은 차단 · 잠금을 하지 않는다).
  logs: { label: '로그 — 장애/보안 high', conds: { 'fault-sec': '장애 분류 줄 또는 보안 high 이상(SSH 실패 집중 포함)', fault: '장애 분류 줄만', sec: '보안 high 이상만' } },
  // 8a단계 — 용량 소진 예측(수집 노드의 하루 계산 결과 · 데이터 부족 · 불안정 · 상한 없음은 판정 보류). N일은 아래 ‘용량 소진 예측’ 절.
  capacity: { label: '용량 소진 예측 ≤ N일', conds: { 'fs-inode': '파일시스템 · inode 가 N일 안 목표선 도달', any: '메모리(참고) 포함', fs: '파일시스템만', inode: 'inode 만' } },
});
export const CHANNEL_TEXT = Object.freeze({ email: '메일', webhook: '웹훅', slack: 'Slack', teams: 'Teams' });
export const SENT_RESULT_TEXT = Object.freeze({ queued: '보내는 중(대기열)', sent: '보냄', failed: '보내지 못함(채널 오류 — 재시도 규칙대로)', suppressed: '중복 억제', 'no-channel': '켜진 채널 없음', 'no-channel-config': '알림 설정 없음', 'daily-cap': '하루 상한', maintenance: '정비 창 안 — 기록만(창 뒤에도 초과면 그때 1회)', error: '실패', '': '—' });
export const ISSUE_RESULT_TEXT = Object.freeze({ 'pending-central': '중앙에서 판단', 'daily-cap': '하루 상한', created: '만듦', commented: '댓글', dup: '이미 처리', error: '실패', skipped: '안 만듦' });
export const RULES_HONEST = '판정 · 발송은 그 서버를 수집하는 노드(엣지)가 합니다 — 이 설정은 이 노드 것이고 중앙에서 엣지로 배포하지 않습니다(다음 판). 정비 창(설정 › 정비 창 · 알림 억제)의 ① 알림 억제를 켠 창 안에서는 기록만 하고 보내지 않으며, 창이 끝난 뒤에도 조건이 참이면 그때 한 번 보냅니다(제목 ‘정비 창 안부터 초과’). 백업 창(Bareos · Veeam 스케줄) 억제는 베어메탈 서버의 원천이 없어 동작하지 않습니다. 같은 상태가 이어지면 다시 보내지 않고, 재시작해도 다시 보내지 않습니다(상태 파일).';
export function sentResultText(r) { return SENT_RESULT_TEXT[r] ?? String(r || '—'); }
export function issueResultText(r) { return r == null ? '—' : (ISSUE_RESULT_TEXT[r] ?? String(r)); }
export function autoFocusText(r) {
  if (r == null) return '—';
  const m = { started: '시작', queued: '대기열', 'not-opted': '법인 옵트인 안 함', 'no-target': '이 노드 대상 아님', suppressed: '재발 억제', 'daily-cap': '하루 상한' };
  if (m[r]) return m[r];
  const s = String(r);
  return s.startsWith('skipped:') ? `안 함(${FOCUS_CODE_TEXT[s.slice(8)]?.text || s.slice(8)})` : s;
}
