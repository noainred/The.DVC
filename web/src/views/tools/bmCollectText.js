/**
 * views/tools/bmCollectText.js — 리눅스 성능 6단계 **수집 건강 보드** 화면의 문구 · 좌표 · CSV(순수 · vitest `bmStage6Text.test.jsx`).
 *
 * ⚠⚠ 판정은 수집 노드(server `bmusage/collectHealth.js` — 사유 분류 · 기준 대조 cells)와 라우트(노드 상태 code)가 한다. 이 모듈은 code → 문장 · 숫자 → 글자만
 *   (기준값과 비교하지 않는다 — 소스 스윕). 결측은 0 이 아니다(값이 없으면 단위 없이 ‘—’).
 * ⚠ 문구에 백틱 금지 · 상한 · 주기 숫자는 응답 값만.
 */
import { numOrNull } from '../../numOrNull.js';
import { toCsv } from '../../util/csv.js';
import { dayStamp } from '../../dayStamp.js';
import { fmtHm } from '../../components/vmperf/vmPerfText.js';

const n = numOrNull;

/** 노드 상태(라우트 nodeStateOf) → 문구. */
export const NODE_STATE_TEXT = Object.freeze({
  ok: { label: '정상', tone: 'ok' },
  attention: { label: '기준 밖', tone: 'warn' },
  off: { label: '꺼짐', tone: 'idle' },
  'no-cycle': { label: '아직 주기 없음', tone: 'idle' },
  'old-version': { label: '엣지 버전 낮음', tone: 'warn' },
  'edge-stale': { label: '보관분 오래됨', tone: 'warn' },
  'no-snapshot': { label: '보관분 없음', tone: 'idle' },
  'cycle-failed': { label: '주기 실패', tone: 'bad' },
  hidden: { label: '노드 값 숨김(법인 행 기준)', tone: 'idle' },
});
/** 주기 오류 code(서버 collectHealth.NODE_ERRORS 와 1:1) → 문구. 실패면 대상 · 결과를 모른다(대상 0 · 정상이 아니다). */
export const NODE_ERROR_TEXT = Object.freeze({
  'classify-failed': '대상 분류(서버 인벤토리)에 실패해 이번 주기를 건너뛰었습니다 — 대상 수 · 성공률을 모릅니다',
  'cycle-error': '주기 중 예외로 멈췄습니다 — 이번 주기 결과를 모릅니다',
  'health-failed': '수집 건강 계산에 실패했습니다 — 이 노드 값을 모릅니다',
  'no-targets': '대상 서버가 없습니다(사실 0)',
});
export function nodeStateView(st, { minEdgeVersion = null } = {}) {
  const v = NODE_STATE_TEXT[st] || { label: String(st || '—'), tone: 'idle' };
  return st === 'old-version' && minEdgeVersion ? { ...v, label: `${v.label}(v${minEdgeVersion} 이상 필요)` } : v;
}
/** 기준 밖 칸(cells — 수집 노드가 대 본 결과) → 문구. */
export const FLAG_TEXT = Object.freeze({ cycle: '주기 소요 여유 적음', success: '성공률 낮음', db: 'DB 상한 가까움', auth: '인증 정지 서버 있음', error: '주기 실패(대상 · 결과 모름)' });
/** 실패 사유(server HEALTH_REASON_CODES) → 이름 · 조치(1:1). */
export const REASON_TEXT = Object.freeze({
  auth: { label: '인증 거부', action: '등록부의 자격증명을 고치세요 — 다음 주기에 자동 재개합니다(계정 잠금을 막으려고 자동 재시도하지 않습니다).' },
  'auth-stopped': { label: '인증 정지(시도 안 함)', action: '등록부 자격증명을 고치면 다음 주기에 자동 재개합니다 · ‘지금 수집’ 은 막지 않습니다.' },
  timeout: { label: '시한 초과', action: '서버 부하 또는 네트워크 — 집중 모니터링 후보입니다 · 장비 시한 설정을 확인하세요.' },
  'ssh-error': { label: 'SSH 연결 실패', action: '포트 · 방화벽 · sshd 상태를 확인하세요(통신 점검).' },
  'host-key': { label: '호스트 키 거부', action: '서버 호스트 키가 바뀌었는지 확인한 뒤 등록부에서 다시 승인하세요.' },
  'not-linux': { label: 'Linux 출력 아님', action: 'OS 종류 · 셸을 확인하세요(Windows 는 다른 경로).' },
  unreachable: { label: 'iDRAC 미도달', action: 'iDRAC 네트워크 · 서비스 상태를 확인하세요.' },
  'pool-busy': { label: '동시성 대기 초과', action: '동시성 설정 · 진행 중인 집중 모니터링 수를 보세요.' },
  'no-telemetry': { label: '리포트 없음', action: 'Datacenter 라이선스가 없는 iDRAC — 센서 · 전력만 읽습니다(정상).' },
  error: { label: '수집 오류', action: '작업 로그(실패 행)의 오류 문구를 보세요.' },
});
export const INFO_TEXT = Object.freeze({ 'no-telemetry': '리포트 없음(라이선스 — 정상)', first: '첫 주기(다음 주기부터 값 — 정상)', 'psi-absent': 'PSI 없음(커널 — 정상)' });
/** 사유의 상태 9종 분류(server reasonState) → 짧은 이름. */
export const REASON_STATE_TEXT = Object.freeze({ auth: '인증 정지', idracOnlyUnread: 'OS 못 읽음', osOnlyUnread: 'iDRAC 못 읽음', osOnly: 'iDRAC 리포트 없음' });
export const PATH_TEXT = Object.freeze({ os: 'OS(SSH)', idrac: 'iDRAC' });
/** 피크 창 결정 사유(서버 peakPlan.PEAK_PLAN_REASONS 와 1:1 — 테스트가 대조). 모르는 code 는 글자로 내보내지 않는다. */
export const PEAK_REASON_TEXT = Object.freeze({ off: '피크 창 꺼짐', fits: '예산 안', reduced: '예산에 맞춰 줄임', 'base-over-budget': '기본 수집만으로 예산 초과 — 창 없음', 'no-targets': '대상 없음' });
export const peakReasonText = (r) => (r && Object.hasOwn(PEAK_REASON_TEXT, r) ? PEAK_REASON_TEXT[r] : '');
export const reasonLabel = (x) => `${PATH_TEXT[x?.path] || x?.path || ''} ${REASON_TEXT[x?.code]?.label || x?.code || '—'}`.trim();

export function msText(v) {
  const x = n(v);
  if (x == null) return '—';
  if (x < 1000) return `${Math.round(x)}ms`;
  if (x < 60_000) return `${Math.round(x / 100) / 10}s`;
  return `${Math.round(x / 6000) / 10}분`;
}
/**
 * 저장 카드 한 줄(메인 · 가족별 파일 수 · 크기) — 폴더를 못 읽었으면 가족 값은 ‘—’(0개 0KB 가 아니다), 일부 파일을 못 읽었으면 ‘부분’ 을 붙인다(반증 F5).
 */
export function famLine(db = {}) {
  const fam = db?.families;
  const head = `메인 ${gbText(db?.mainBytes)}${db?.walBytes ? ` (+WAL ${gbText(db.walBytes)})` : ''}`;
  if (!fam || typeof fam !== 'object') return `${head} · 기간 파일 —(폴더를 읽지 못함)`;
  const cnt = (v) => { const x = n(v); return x == null ? '—' : `${x}개`; };
  const dev = n(fam.dev?.files) != null || n(fam.dev1h?.files) != null ? `${(n(fam.dev?.files) ?? 0) + (n(fam.dev1h?.files) ?? 0)}개` : '—';
  return `${head} · 원시 ${cnt(fam.raw?.files)} ${gbText(fam.raw?.bytes)} · 1시간 ${cnt(fam.h1?.files)} ${gbText(fam.h1?.bytes)} · 장치 ${dev} · 1일 ${cnt(fam.d1?.files)}${db?.partial ? ' (부분 — 일부 파일 크기를 못 읽음)' : ''}`;
}
/** 합에서 뺀 ‘모름’ 개수 → 꼬리 글자(없으면 빈 글자 — 결측을 0 으로 더하지 않았다는 표시). */
export function unknownText(cnt, what) { const x = n(cnt); return x ? ` · ${what} ${x}곳 모름(합에서 뺌)` : ''; }
export function pctText1(v) { const x = n(v); return x == null ? '—' : `${Math.round(x * 10) / 10}%`; }
export function gbText(v) {
  const x = n(v);
  if (x == null) return '—';
  const g = x / 1024 ** 3;
  if (g >= 1) return `${Math.round(g * 10) / 10}GB`;
  if (x >= 1024 ** 2) return `${Math.round(x / 1024 ** 2)}MB`;
  return `${Math.round(x / 1024)}KB`;   // 1MB 아래를 ‘0MB’ 로 적지 않는다(Chromium 판독 r1)
}
/** ‘주기 소요 / 예산’ — 값이 없으면 ‘—’. */
export function cycleText(ms, budgetMs) { return n(ms) == null ? '—' : `${msText(ms)} / ${msText(budgetMs)}`; }
export function concText(c) { return c && n(c.max) != null ? `${n(c.max)}/${n(c.cap) ?? '—'}` : '—'; }
export function sshText(s) { return s && n(s.n) ? `${msText(s.p50Ms)} / ${msText(s.p95Ms)}` : '—'; }
export function reasonsLine(list = []) { return (Array.isArray(list) ? list : []).slice(0, 4).map((x) => `${REASON_TEXT[x.code]?.label || x.code} ${n(x.n) ?? '—'}`).join(' · ') || '—'; }
export function daysSince(since, now = Date.now()) {
  const s = n(since);
  if (s == null) return '—';
  const d = Math.floor((now - s) / 86_400_000);
  return d < 1 ? '오늘' : `${d}일째`;
}

/** 주기 소요 추이(1시간 칸) → SVG 경로(소요 · 예산). 값 없는 칸에서 끊는다. */
export function trendPaths(points = [], { w = 1000, h = 140, pad = 6 } = {}) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => n(p?.t) != null);
  if (!pts.length) return { ms: '', budget: '', msDots: '', budgetDots: '', yMax: null, from: null, to: null, n: 0 };
  const from = pts[0].t; const to = pts.at(-1).t;
  const span = to > from ? to - from : 1;
  const yMax = Math.max(...pts.map((p) => Math.max(n(p.maxMs) ?? 0, n(p.budgetMs) ?? 0))) || 1;
  // 위아래 여백(pad) — 0 · 최대 값의 점이 그림 가장자리에서 반쯤 잘리지 않게(r3 판독: 칸 1개일 때 점이 거의 안 보였다).
  const yOf = (v) => Math.round((pad + (1 - v / yMax) * (h - 2 * pad)) * 10) / 10;
  const path = (pick) => {
    let d = ''; let dots = ''; let pen = false; let solo = null;
    for (const p of pts) {
      const v = n(p[pick]);
      if (v == null) { if (solo) dots += `M${solo} l0.01,0 `; pen = false; solo = null; continue; }
      const x = pts.length === 1 ? w / 2 : Math.round(((p.t - from) / span) * w * 10) / 10;   // 칸이 하나뿐이면 가운데(가장자리에 반쯤 잘린 점이 되지 않게)
      const y = yOf(v);
      d += `${pen ? 'L' : 'M'}${x},${y} `; solo = pen ? null : `${x},${y}`; pen = true;
    }
    if (solo) dots += `M${solo} l0.01,0 `;   // 홀로 남은 점(주기 기록 1개 · 결측 사이 1칸)은 굵은 점으로 따로 그린다
    return { d: d.trim(), dots: dots.trim() };
  };
  const ms = path('maxMs'); const budget = path('budgetMs');
  return { ms: ms.d, msDots: ms.dots, budget: budget.d, budgetDots: budget.dots, yMax, from, to, n: pts.length };
}
export function trendRangeText(t) { return t.from == null ? '' : `${dayStamp(t.from) || ''} ${fmtHm(t.from)} ~ ${dayStamp(t.to) || ''} ${fmtHm(t.to)}`; }
export const COLLECT_HONEST = '값은 그 노드(엣지 · 중앙 직접 수집)가 매 주기 쓴 것입니다 — 중앙은 다시 판정하지 않습니다. ‘며칠째’ 는 그 노드 프로세스가 시작한 뒤부터 셉니다(재시작하면 다시 셉니다). DB 크기는 파일 크기 실측이고, 샘플러(옵션 B)의 서버 부담은 계측하지 않습니다. 범위가 지정된 계정은 다른 법인 서버가 섞인 노드 값(주기 소요 · 동시성 · SSH · DB)을 보지 않습니다.';

/** CSV — 법인 행(보이는 그대로 · 결측은 빈 칸). */
export function collectCsv(resp = {}) {
  const out = [['법인', '노드', '대상', '성공', '실패', '성공률(%)', '주기 소요(ms)', '예산(ms)', '동시 최대', '동시 설정', 'SSH 중앙값(ms)', 'SSH p95(ms)', 'DB(bytes)', '상태', '실패 사유']];
  for (const r of resp.rows || []) {
    out.push([r.vcenterId || '', r.agent || '', n(r.servers) ?? '', n(r.ok) ?? '', n(r.fail) ?? '', n(r.successPct) ?? '', n(r.cycleMs) ?? '', n(r.budgetMs) ?? '', n(r.conc?.max) ?? '', n(r.conc?.cap) ?? '',
      n(r.ssh?.p50Ms) ?? '', n(r.ssh?.p95Ms) ?? '', n(r.dbBytes) ?? '', NODE_STATE_TEXT[r.nodeState]?.label || r.nodeState || '', reasonsLine(r.reasons)]);
  }
  return `${toCsv(out)}\r\n`;
}
export function collectCsvName(at) { return `bm-collect-health_${dayStamp(n(at) ?? Date.now()) || 'latest'}.csv`; }

/** 8a단계 — 법인 행 ‘정비 중’ 한 줄(건너뜀 · 창 안 실패 — 성공률 분모 밖). 둘 다 0 · 모름이면 ''. */
export function maintRowText(r = {}) {
  const a = n(r.maintSkipped); const b = n(r.maintFail);
  const p = [];
  if (a) p.push(`정비 중 건너뜀 ${a}`);
  if (b) p.push(`창 안 실패 ${b}`);
  return p.length ? `${p.join(' · ')}(성공률 분모 밖)` : '';
}
/** 8a단계 — 노드의 ‘창 끝 뒤 억제’ 점검 칸(0 이어야 정상 · 모르면 모름). */
export function maintLeakCell(node = null) {
  const m = node?.maint;
  if (!m) return { text: '—', tone: 'idle', title: '정비 창 점검 값이 없습니다(구버전 노드 · 아직 주기 없음).' };
  if (m.judge === 'unavailable' || m.localUnreadable) return { text: '판정 불가', tone: 'warn', title: '정비 창 파일을 읽지 못해 이 노드의 창으로는 억제하지 않았습니다.' };
  const k = n(m.leak);
  if (k == null) return { text: '—', tone: 'idle', title: '아직 점검한 주기가 없습니다.' };
  return k === 0 ? { text: `0 · 정상(${n(m.checked) ?? 0}건 대조)`, tone: 'ok', title: '창 끝 시각 뒤에 억제가 남아 있지 않습니다.' }
    : { text: `${k}건`, tone: 'bad', title: '억제가 시한을 넘겼거나 판정과 어긋난 적용 — 관리자 확인 필요.' };
}
