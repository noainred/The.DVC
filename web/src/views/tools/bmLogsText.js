/**
 * 리눅스 성능 7a단계 — **로그 분석** 화면 문구 · 형식(순수 — React 없음 · vitest node 환경).
 * ⚠ 판정(분류 · 심각도 · 집중 · 공통 원인 후보)은 서버가 한다 — 여기는 서버 값을 글자 · 색으로 옮기기만(웹이 다시 판정하지 않는다).
 * ⚠ 숫자(줄 상한 · 보관 · 집중 임계 · 연계 창)는 API 값만 쓴다 — 문구에 박지 않는다. 값이 없으면 ‘—’(0 이 아니다).
 * ⚠ 문구에 백틱 금지(BoldText 는 ‘**’ 만 해석) — 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';

export const CLASS_ORDER = Object.freeze(['fault', 'perf', 'sec', 'issue']);
/** 분류 색은 :root 토큰만(새 hex 없음). */
export const CLASS_TEXT = Object.freeze({
  fault: { label: '장애', color: 'var(--red)', desc: 'MCE · EDAC · PCIe AER · 커널 패닉 · 디스크 I/O 오류 · 파일시스템 손상' },
  perf: { label: '성능', color: 'var(--amber)', desc: 'I/O 시한 · OOM · soft lockup · hung task · NIC 링크 Down/Up · 스로틀 · tcp_mem' },
  sec: { label: '보안', color: 'var(--purple)', desc: 'SSH 실패(집중) · root 로그인 · sudo · 계정/권한 변경 · SELinux 거부 · auditd' },
  issue: { label: '이슈', color: 'var(--accent-2)', desc: '유닛 실패 · 재시작 반복 · 코어 덤프 · 시각 점프 · 읽기 전용 재마운트 · 디스크 가득 · 용도 로그' },
});
export const SEV_TEXT = Object.freeze({
  critical: { label: 'critical', tone: 'bad', rank: 5 }, high: { label: 'high', tone: 'bad', rank: 4 }, medium: { label: 'medium', tone: 'warn', rank: 3 },
  low: { label: 'low', tone: 'idle', rank: 2 }, info: { label: 'info', tone: 'idle', rank: 1 },
});
export const SRC_LABEL = Object.freeze({ journal: 'journald', kernel: 'dmesg', secure: '/var/log/secure', audit: 'auditd', gpdb: 'GPDB pg_log', airflow: 'Airflow scheduler' });
export const STATUS_TEXT = Object.freeze({
  ok: { label: '읽음', tone: 'ok' },
  perm: { label: '권한 없음', tone: 'warn', title: '수집 계정이 읽을 수 없습니다 — 0 이 아니라 모르는 것입니다(journald 는 systemd-journal · adm 그룹, /var/log/secure · audit.log 는 root 권한이 필요할 수 있습니다).' },
  absent: { label: '없음', tone: 'idle', title: '그 출처가 서버에 없습니다(도구 · 파일 · 폴더 없음 — 예: auditd 미설치 · rsyslog 없음 · 용도 로그 폴더 없음).' },
  nofile: { label: '파일 없음', tone: 'idle', title: '용도 로그 폴더는 있는데 파일이 없습니다.' },
  failed: { label: '실패', tone: 'bad', title: '명령이 실패했습니다(시한 · 형식) — 읽기 위치는 넘어가지 않았습니다.' },
  missing: { label: '못 받음', tone: 'warn', title: '이번 출력에 그 구획이 오지 않았습니다(출력이 앞에서 끊김).' },
  cut: { label: '잘린 출력', tone: 'warn', title: '출력 상한 · 시한으로 끝이 잘려 그 구획을 버렸습니다 — 다음 주기에 같은 줄을 다시 읽습니다.' },
});
/** 로그 규칙 등급(튜닝 근거 등급과 뜻이 다르다 — 여기서는 ‘메시지 형식을 실장비 표본으로 확인했는가’). */
export const LOG_GRADE_TEXT = Object.freeze({ '●': '실장비 확인', '◐': '문서 발췌', '○': '실장비 표본 없음' });
export const RANGE_OPTIONS = Object.freeze([['1h', '1시간'], ['24h', '24시간'], ['7d', '7일']]);
export const SEC_ROWS = Object.freeze([
  { kind: 'fail', label: 'SSH · 로그인 실패', parts: [['fail_ip', 'IP'], ['fail_user', '계정']] },
  { kind: 'ok', label: 'SSH 성공', parts: [['ok', '계정 · IP']] },
  { kind: 'root', label: 'root 직접 로그인', parts: [['root', 'IP']] },
  { kind: 'sudo', label: 'sudo', parts: [['sudo', '계정 → 대상 명령']] },
  { kind: 'sudofail', label: 'sudo 거부 · 실패', parts: [['sudofail', '계정']] },
  { kind: 'acct', label: '계정 · 권한 변경', parts: [['acct', '동작 계정']] },
  { kind: 'avc', label: 'SELinux 거부(AVC)', parts: [['avc', '프로세스 · 클래스']] },
]);
const n = numOrNull;   // ‘못 읽은 값’ 판정은 하나(web/src/numOrNull.js — Number('')===0 함정)
export const numText = (v) => { const x = n(v); return x == null ? '—' : x.toLocaleString('ko-KR'); };
const pad = (x) => String(x).padStart(2, '0');
export function stamp(ts, { date = true } = {}) {
  const x = n(ts); if (x == null) return '—';
  const d = new Date(x);
  return `${date ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** KPI 4칸(분류별 패턴 수 · 줄 수). 한 번도 읽지 않았으면 값은 ‘—’. */
export function kpiCards(resp) {
  const never = !!resp?.read?.never;
  return CLASS_ORDER.map((c) => {
    const k = resp?.kpi?.[c] || {};
    return { key: c, label: CLASS_TEXT[c].label, color: CLASS_TEXT[c].color, value: never ? '—' : numText(k.patterns), sub: never ? '아직 읽지 않음' : `패턴 ${numText(k.patterns)} · 줄 ${numText(k.lines)}`, desc: CLASS_TEXT[c].desc };
  });
}
/** 출처 상태 칩(읽음 · 권한 없음 · 없음 …) — 서버 status 그대로. */
export function sourceChips(sources) {
  if (!sources || typeof sources !== 'object') return [];
  return Object.keys(SRC_LABEL).filter((s) => sources[s]).map((s) => {
    const x = sources[s]; const st = STATUS_TEXT[x.status] || { label: x.status || '—', tone: 'idle' };
    const extra = [x.truncated > 0 ? `잘림 ${numText(x.truncated)}줄` : '', x.rotated ? (x.lost ? '로테이트 — 그 사이 줄 모름' : '로테이트 감지') : '', x.rebooted ? '재부팅 — 링 버퍼 처음부터' : '', x.cursorReset ? '커서 재시작' : '', x.first ? '첫 읽기(최근만)' : '',
      x.svc ? `auditd ${x.svc}` : ''].filter(Boolean).join(' · ');
    return { src: s, label: SRC_LABEL[s], status: x.status, text: st.label, tone: st.tone, title: st.title || '', extra };
  });
}
/** ‘읽은 양’ 칸 — 줄 · 상한 · 잘림 · 분류 안 됨 · 마지막 읽음. */
export function readCard(read) {
  if (!read || read.never) return { value: '—', sub: '아직 이 서버의 로그를 읽은 주기가 없습니다(첫 주기 전 · 로그 읽기 꺼짐 · OS 경로 없음).' };
  const parts = [read.lineCap != null ? `상한 ${numText(read.lineCap)}줄/주기(출처마다)` : '', `잘림 ${numText(read.truncated)}`, `분류 안 됨 ${numText(read.none)}(세기만 · 보관 안 함)`, read.at ? `마지막 읽음 ${stamp(read.at)}` : ''];
  return { value: numText(read.lines), sub: parts.filter(Boolean).join(' · '), cut: read.ended === false ? '마지막 주기 출력이 잘려 끝 구획을 버렸습니다(다음 주기에 다시 읽음).' : '', reset: read.cursorReset ? '읽기 위치 기록이 손상돼 처음 읽기로 돌아갔습니다(손상본은 보존).' : '' };
}

/** 시간대별 누적 막대(순수 — 그리기 좌표만). null 칸(그 시간 못 읽음)은 막대 없이 점선 칸. */
export function hourlyBars(hourly = [], { height = 120 } = {}) {
  const rows = Array.isArray(hourly) ? hourly : [];
  let max = 0;
  for (const h of rows) { const s = CLASS_ORDER.reduce((a, c) => a + (n(h[c]) || 0), 0); if (s > max) max = s; }
  const scale = max > 0 ? height / max : 0;
  return {
    max, bars: rows.map((h) => {
      const unread = CLASS_ORDER.every((c) => n(h[c]) == null);
      let y = height; const segs = [];
      if (!unread) for (const c of CLASS_ORDER) { const v = n(h[c]) || 0; if (!v) continue; const hh = Math.max(1, v * scale); y -= hh; segs.push({ cls: c, y, h: hh, v, color: CLASS_TEXT[c].color }); }
      return { t: h.t, unread, total: unread ? null : CLASS_ORDER.reduce((a, c) => a + (n(h[c]) || 0), 0), segs };
    }),
  };
}

/** 보안 패널 행(서버 값 그대로 · 가림은 서버가 했다). */
export function secPanelRows(sec = {}) {
  const tot = sec?.totals || {};
  return SEC_ROWS.map((r) => {
    const total = r.kind === 'fail' ? n(tot.fail_ip) : n(tot[r.parts[0][0]]);
    const tops = r.parts.map(([k, lbl]) => ({ k, lbl, items: Array.isArray(sec?.[k]) ? sec[k].slice(0, 5) : [] }));
    return { ...r, total, tops };
  });
}
export const SEC_HONEST = 'IP · 계정은 시간 · 종류마다 상위만 보관하고(나머지는 ‘(기타)’) 원문 줄은 가림 뒤 표본만 남깁니다. ‘SSH 실패 집중’ 은 같은 IP 의 실패가 설정 창 안에 임계 이상일 때입니다(포탈 로그인 실패 판정 재사용). 포탈은 차단 · 계정 잠금을 하지 않습니다 — 알림 규칙 ‘로그 — 장애/보안 high’ 까지입니다.';
export const SEC_HIDDEN_TEXT = '**관리자 판본이 아닙니다** — IP · 계정은 가림 토큰(같은 값은 같은 토큰)으로, 보안 분류 패턴의 표본은 싣지 않았습니다. 개수 · 분류 · 규칙은 같습니다.';

/** 연계 칩(서버가 맞춘 것 · 규칙 표지) → [{kind, text, tab}]. ‘인과 아님’ 은 표 머리가 말한다. */
export const HEALTH_LABEL = Object.freeze({ chrony: '시각 동기', units: '실패 유닛', oom: 'OOM', dmesg: '커널 오류', uptime: '재부팅 필요', fdct: 'FD · conntrack', cert: '인증서', tuned: 'TuneD · SELinux · firewalld' });
export function corrChips(corr = {}) {
  const out = [];
  for (const e of corr?.changes || []) out.push({ kind: 'changes', text: `변경 ${stamp(e.ts)} ${e.item || e.kind || ''}`.trim(), tab: 'trend' });
  for (const f of corr?.focus || []) out.push({ kind: 'focus', text: `집중 세션 ${stamp(f.start)}`, tab: 'focus' });
  if (corr?.cross) out.push({ kind: 'cross', text: `교차 판정 ‘${corr.cross}’`, tab: 'summary' });
  if (corr?.health) out.push({ kind: 'health', text: `점검 소모품 ‘${HEALTH_LABEL[corr.health] || corr.health}’`, tab: 'summary' });
  if (corr?.faults) out.push({ kind: 'faults', text: '장애 기록(탭에서 시각 대조)', tab: 'faults' });
  if (corr?.playbook) out.push({ kind: 'playbook', text: `플레이북 ‘${corr.playbook}’`, tab: 'playbook' });
  return out;
}
export function corrHeadText(windowMs) {
  const m = n(windowMs);
  return `연계(±${m == null ? '—' : Math.round(m / 60_000)}분 시각 매칭 · 인과 아님)`;
}

/** 패턴 표 CSV(보이는 값 그대로 — 표본은 가린 것). */
const csvCell = (v) => { const s = String(v ?? ''); const g = /^[=+\-@]/.test(s) ? `'${s}` : s; return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g; };
export function patternCsv(resp = {}) {
  const rows = [['class', 'severity', 'count', 'first', 'last', 'source', 'unit', 'signature', 'rule', 'sample']];
  for (const p of resp.patterns || []) rows.push([p.cls, p.severity, p.count ?? '', p.first ? new Date(p.first).toISOString() : '', p.last ? new Date(p.last).toISOString() : '', p.src, p.unit, p.tmpl, p.ruleId, p.samples?.at?.(-1)?.text ?? '']);
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** 수집 방식 카드 문장(API 값만). */
export function methodLines(m = {}) {
  if (!m) return [];
  return [
    `**증분 읽기**: 5분 주기 수집과 같은 SSH 세션에서 별도 명령 1회 — 구획 ${(m.sections || []).map((s) => `‘${s}’`).join(' · ') || '—'}. journald 는 우선순위 warning 이상 · 커서 증분(첫 읽기는 최근 ${numText(m.firstSinceMin)}분), dmesg 는 boot_id + 마지막 초 이후, 파일은 offset + inode(첫 읽기는 마지막 ${numText(m.firstFileLines)}줄 · 로테이트 감지).`,
    `**상한**: 출처마다 주기당 ${numText(m.lineCap)}줄 · 줄 폭 ${numText(m.lineWidth)}자 — 넘친 줄은 ‘잘림’ 으로 셉니다(읽기 위치는 끝까지 넘깁니다). 보관 ${numText(m.keepDays)}일.`,
    '**엣지에서 분류 · 집계 · 가림**: 정규식 규칙(처음 맞는 하나) → 서명(숫자 · IP · 계정 · 경로 · UUID 치환 뒤 해시) → 패턴 · 시간 집계 · 보안 상위 + 가린 표본 5줄. 원문 전체는 저장 · 전송하지 않습니다(법인 밖으로 나가지 않음).',
    `**보안 집중**: 같은 IP 의 실패가 ${numText(m.burst?.windowMin)}분 안 ${numText(m.burst?.count)}줄 이상이면 ‘SSH 실패 집중’(high).`,
    '**정직하게**: 규칙은 실장비 표본 없이 업스트림 메시지 문구로 만들어 전부 ○ 등급입니다(첫 실수집 뒤 ‘분류 안 됨’ 표본으로 좁힙니다). auditd · SELinux 는 활성일 때만, 권한이 없으면 ‘권한 없음’ 으로 둡니다. 용도 로그 경로는 흔한 설치 관례의 상수 후보라 현장 경로와 다르면 ‘없음’ 입니다.',
  ];
}

/* ── 함대 ─────────────────────────────────────────────────────────────── */
export function fleetKpiCards(resp) {
  const k = resp?.kpi || {};
  return [
    { key: 'fault', label: '로그 장애 서버', value: numText(k.faultServers), tone: n(k.faultServers) ? 'bad' : 'idle', sub: '24시간 장애 분류 줄이 있는 서버' },
    { key: 'sec', label: '보안 high 서버', value: numText(k.secHighServers), tone: n(k.secHighServers) ? 'bad' : 'idle', sub: '24시간 보안 high 이상(집중 포함)' },
    { key: 'servers', label: '요약이 있는 서버', value: numText(k.servers), tone: 'idle', sub: `못 읽음 ${numText(k.unread)} · 잘림 있음 ${numText(k.truncated)}` },
    { key: 'common', label: '공통 원인 후보', value: numText(resp?.common?.length), tone: (resp?.common?.length || 0) ? 'warn' : 'idle', sub: '같은 규칙 · 같은 시간대 여러 서버(후보 — 원인 확정 아님)' },
  ];
}
export const NODE_STATE_TEXT = Object.freeze({
  ok: '요약 받음', 'old-version': '엣지 판이 낮음(로그 분석 이전 판) — 엣지 업그레이드 뒤 보입니다', 'no-cycle': '엣지가 아직 로그 주기를 돌리지 않았습니다', none: '보관분 없음(엣지 사용률을 아직 당기지 않음)', 'db-unavailable': '이 노드 DB 를 열지 못했습니다',
});
export function nodeNotes(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).filter((x) => x && x.state !== 'ok').map((x) => `${x.via === 'edge' ? `엣지 ${x.agent || '?'}` : '이 노드'}: ${NODE_STATE_TEXT[x.state] || x.state}`);
}
export function fleetFilter(rows = [], { corp = '', cls = '', rule = '', q = '' } = {}) {
  const qq = String(q || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => (!corp || r.vcenterId === corp)
    && (!cls || (n(r.cls?.[cls]?.lines) || 0) > 0)
    && (!rule || (r.top || []).some((p) => p.ruleId === rule))
    && (!qq || String(r.name || '').toLowerCase().includes(qq) || String(r.key || '').toLowerCase().includes(qq)));
}
export function topRuleText(top = []) {
  return (Array.isArray(top) ? top : []).slice(0, 3).map((p) => `${p.ruleId || '(묶음)'} ${numText(p.count)}`).join(' · ') || '—';
}
export function commonHonest(windowMs) {
  const m = n(windowMs);
  return `같은 규칙이 여러 서버에서 같은 시간대(마지막 발생이 서로 ${m == null ? '—' : `${Math.round(m / 60_000)}분`} 안)에 떴다는 뜻입니다 — 원인이 같다는 증거가 아닙니다(같은 스위치 · 같은 배포 · 같은 공격원을 먼저 의심해 볼 후보).`;
}
