/**
 * Bareos '정책 · 일정' 탭(v2.839 백업 메뉴 개편 2차-a)의 순수 함수 — 글자 · 거르기만. 판정(VM 적용 정책 · 풀 가득 참 · 사용 %)은 서버(bareos/policy.js) 하나.
 *   값이 없으면 '—'(0 이 아니다) · Director 가 키를 싣지 않은 JobDefs 칸은 '기본'(Bareos 기본값 — 지어내지 않는다).
 */
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const p2 = (n) => String(n).padStart(2, '0');

/** 수집 명령 키 → 화면 이름(서버 policyParse.POLICY_CMDS 와 같은 순서 — 테스트가 대조). */
export const POLICY_CMD_LABEL = Object.freeze({ scheduler: '스케줄 · 7일 예정', pools: '풀', volumes: '볼륨', schedules: 'Run 줄', jobdefs: 'JobDefs', filesets: 'FileSet', clients: '클라이언트 보존' });
export const POLICY_CMD_KEYS = Object.freeze(Object.keys(POLICY_CMD_LABEL));
const CODE_TEXT = { denied: '권한 없음', jsonrpc: 'Director 거부', timeout: '시한 초과', aborted: '시한 초과', skipped: '건너뜀', 'auth-stopped': '인증 정지', auth: '인증 실패', pam: '인증 실패', tls: 'TLS 실패',
  connect: '접속 실패', 'not-configured': '설정 덜 됨', 'edge-relay': '엣지 대행', off: '끔', unknown: '결과 모름' };
export const codeText = (c) => CODE_TEXT[c] || (c ? '실패' : '');

/** Director 한 줄의 결과 — 성공 n / 시도 m · 실패 항목 글자. 수집 전이면 null. */
export function directorResult(d) {
  if (!d || d.at == null) return null;
  const cmds = Object.entries(d.cmds || {}).filter(([, c]) => c && c.ok !== null);
  const ok = cmds.filter(([, c]) => c.ok).length;
  const bad = cmds.filter(([, c]) => !c.ok).map(([k, c]) => `${POLICY_CMD_LABEL[k] || k} ${codeText(c.code)}`);
  return { ok, total: cmds.length, bad, denied: cmds.some(([k, c]) => !c.ok && c.code === 'denied' && ['schedules', 'jobdefs', 'filesets'].includes(k)) };
}

/** 판정 → 글자 · 색(서버 vmPolicyVerdict 의 값 — 테스트가 대조). */
export const VERDICT = Object.freeze({
  policy: { text: '정책 있음', color: '#86efac' },
  manual: { text: '수동만', color: '#fcd34d' },
  unregistered: { text: '미등록', color: '#fca5a5' },
  mismatch: { text: '방식 불일치', color: '#fdba74' },
  unknown: { text: '모름', color: 'var(--text-dim)' },
});
export const VERDICT_KEYS = Object.freeze(Object.keys(VERDICT));

/** 보존(초) → '30일' · '1년' · '12시간'. 모르면 '—'. */
export function retentionText(sec) {
  if (!fin(sec) || sec < 0) return '—';
  if (sec === 0) return '0';
  const d = sec / 86_400;
  if (d >= 365 && Number.isInteger(d / 365)) return `${d / 365}년`;
  if (d >= 1 && Number.isInteger(d)) return `${d}일`;
  if (d >= 1) return `${Math.round(d * 10) / 10}일`;
  return `${Math.round(sec / 3600)}시간`;
}
/** JobDefs 칸 — 값이 없으면 '기본'(Director 가 기본값인 칸은 키를 싣지 않는다 — 실측). */
export const defText = (v) => (v === null || v === undefined || v === '' ? '기본' : String(v));
/** 레벨 머리글자(F·D·I·VF·C). */
export const levelShort = (l) => ({ Full: 'F', Differential: 'D', Incremental: 'I', VirtualFull: 'VF', Consolidate: 'C' }[l] || (l ? String(l).slice(0, 2) : ''));
/** 7일 칸 글자 — 'F 8 · D 0 · I 604'(0 인 레벨은 F 만 보인다). */
export function weekLevels(w) {
  const out = [`F ${w.F || 0}`];
  if (w.D) out.push(`D ${w.D}`);
  if (w.I) out.push(`I ${w.I}`);
  if (w.other) out.push(`기타 ${w.other}`);
  return out.join(' · ');
}
/** 시각 'MM-DD HH:MM'(브라우저 시각). */
export const mdhm = (ms) => (fin(ms) ? (() => { const d = new Date(ms); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; })() : '—');
/** 다음 실행 글자 — '오늘 21:00 Incremental' · '11-03 01:00 Full'. */
export function nextRunText(next, now = Date.now()) {
  if (!next || !fin(next.at)) return '—';
  const d = new Date(next.at); const t = new Date(now);
  const same = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  return `${same ? '오늘' : `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`} ${p2(d.getHours())}:${p2(d.getMinutes())}${next.level ? ` ${next.level}` : ''}`;
}
/** 스케줄 표 거르기 — all · director · group · unused(쓰는 잡 0). */
export function filterSchedules(rows, kind = 'all') {
  const list = Array.isArray(rows) ? rows : [];
  if (kind === 'director') return list.filter((r) => r.src === 'director');
  if (kind === 'group') return list.filter((r) => r.src === 'group');
  if (kind === 'unused') return list.filter((r) => r.src === 'director' && !r.jobs);
  return list;
}
/** VM 적용 정책 거르기 — 판정 · OS. */
export function filterVms(rows, { verdict = '', os = '' } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((r) => (!verdict || r.verdict === verdict) && (!os || r.os === os));
}
/** 일정 출처 글자. */
export function srcText(src) {
  if (!src) return '없음(수동)';
  return src.kind === 'group' ? `그룹 ${src.name}` : `Director ${src.name}`;
}
/** 풀 칸 — 'Full 풀 / Incr 풀'(JobDefs 의 레벨별 풀이 없으면 잡의 풀). */
export function poolText(r) {
  if (r.fullPool || r.incPool) return `${r.fullPool || r.pool || '기본'} / ${r.incPool || r.pool || '기본'}`;
  return r.pool || '—';
}
/** 보존 칸 — 그룹 보관 개수(포탈) + 풀 Volume Retention. */
export function keepText(r) {
  const out = [];
  if (fin(r.keep)) out.push(`Full 체인 ${r.keep}개(포탈)`);
  if (fin(r.retentionSec)) out.push(`Volume Retention ${retentionText(r.retentionSec)}`);
  return out.length ? out.join(' · ') : '—';
}

/* ── v2.840 '보존 · 풀' 탭 · 그룹 카드 · 백업 대상 '적용 정책' 줄 — 글자만(판정은 서버 bareos/policy.js) ── */

/** 볼륨 상태 머리글자 — 표 칸 'A · F · U · P · E'(서버 VOL_STATUSES 의 앞 다섯 — 그 밖은 '기타'). */
export const VOL_SHORT = Object.freeze([['Append', 'A'], ['Full', 'F'], ['Used', 'U'], ['Purged', 'P'], ['Error', 'E']]);
/** 볼륨 상태 칸 'A 1 · F 12 · U 0 · P 3 · E 1 · 기타 2'. 요약이 없으면 '—'(수집 전 · 볼륨 명령 실패). */
export function volStatusText(vol) {
  if (!vol) return '—';
  const st = vol.status || {};
  const known = new Set(VOL_SHORT.map(([k]) => k));
  const other = (fin(vol.other) ? vol.other : 0) + Object.entries(st).filter(([k]) => !known.has(k)).reduce((a, [, c]) => a + (fin(c) ? c : 0), 0);
  const out = VOL_SHORT.map(([k, t]) => `${t} ${fin(st[k]) ? st[k] : 0}`);
  if (other) out.push(`기타 ${other}`);
  return out.join(' · ');
}
/** 상한 칸(Max Vols · Max Vol Jobs · Max Vol Bytes) — Bareos 에서 0 은 '제한 없음' · 모르면 '—'. */
export const limitText = (v, fmt = (x) => String(x)) => (!fin(v) ? '—' : v === 0 ? '제한 없음' : fmt(v));
/** 켜짐/꺼짐 칸 — 모르면 '—'. */
export const onOff = (v) => (v === true ? '켬' : v === false ? '끔' : '—');
/** 쓰는 잡 칸 — '포탈 잡 12 · 그룹 1'(추정 — 화면 각주). JobDefs 참조는 따로(usedRefs). */
export function usedText(u) {
  if (!u) return '—';
  const out = [`포탈 잡 ${fin(u.jobs) ? u.jobs : 0}`];
  if (fin(u.groups) && u.groups > 0) out.push(`그룹 ${u.groups}`);
  return out.join(' · ');
}
export const usedRefs = (u) => (Array.isArray(u?.jobdefs) && u.jobdefs.length ? `JobDefs ${u.jobdefs.join(', ')}` : '');
/** 풀 상태 표지 — 가득 참(서버 판정 true) · 오류 볼륨 · 판정 모름. */
export function poolTags(p) {
  const out = [];
  if (p?.full === true) out.push({ text: '가득 참', tone: 'bad' });
  if (fin(p?.vol?.status?.Error) && p.vol.status.Error > 0) out.push({ text: `오류 볼륨 ${p.vol.status.Error}`, tone: 'bad' });
  if (p?.enabled === false) out.push({ text: '꺼짐', tone: 'muted' });
  return out;
}
/** 풀 표 거르기 — Director id · 상태(full · error · unknown). */
export function filterPools(rows, { director = '', state = '' } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((p) => (!director || p.directorId === director)
    && (!state || (state === 'full' ? p.full === true : state === 'error' ? (p.vol?.status?.Error || 0) > 0 : state === 'unknown' ? p.full === null : true)));
}

/** 그룹 카드 '적용 풀 · 보존' 한 줄 — 서버 poolPolicy(null = 정책 수집 전 · missing = 수집한 풀 목록에 없음). */
export function groupPoolText(pp, poolName = '') {
  if (!pp) return poolName ? `풀 ${poolName} · 보존 —(정책 수집 전)` : '풀 기본 · 보존 —(정책 수집 전)';
  if (pp.missing) return `풀 ${pp.name} · 수집한 풀 목록에 없음`;
  const parts = [`풀 ${pp.name}${pp.from === 'site' ? '(법인 기본)' : ''}`];
  parts.push(`Volume Retention ${retentionText(pp.retentionSec)}${pp.retentionFrom === 'volumes' ? '(볼륨 기준)' : ''}`);
  if (pp.full === true) parts.push('가득 참');
  if (fin(pp.pct)) parts.push(`사용 ${pp.pct}%`);
  if (fin(pp.errorVols) && pp.errorVols > 0) parts.push(`오류 볼륨 ${pp.errorVols}`);
  return parts.join(' · ');
}
/** 그룹 카드 겹침 한 줄 — 서버 groupOverlaps 의 한 그룹(없으면 null). 다음 24시간 · 길이를 모르는 회차는 60분으로 본 추정. */
export function overlapLine(o) {
  if (!o || (!o.veeam && !o.bareos)) return null;
  const out = [];
  if (o.veeam) out.push(`Veeam 잡 ${o.veeam.n}개`);
  if (o.bareos) out.push(`다른 Bareos 회차 ${o.bareos.n}개`);
  const from = o.veeam?.from ?? o.bareos?.from;
  return `겹침 — ${out.join(' · ')}(${mdhm(from)}부터 · 다음 24시간 추정)`;
}

/** 백업 대상 행 '적용 정책' 한 줄 — 서버 jobPolicyResolver 의 값(null = 그룹 · 수집본을 못 읽음). */
export function targetPolicyText(p, now = Date.now()) {
  if (!p) return '적용 정책 모름(그룹 파일을 읽지 못함)';
  const parts = [];
  if (p.src?.kind === 'group') parts.push(`그룹 ${p.src.name}`);   // 스케줄 문구는 길어서 뺀다 — 다음 실행이 같은 정보를 준다(전체 문구는 칸 title)
  else if (p.src?.kind === 'director') parts.push(`Director 스케줄 ${p.src.name}`);
  else parts.push(p.verdict === 'unknown' ? '일정 모름(정책 수집 전)' : '예약 없음(수동만)');
  if (p.next) parts.push(`다음 ${nextRunText(p.next, now)}`);
  if (p.pool) parts.push(`풀 ${p.pool}${p.poolFrom === 'group' ? '(그룹)' : ''}`);
  if (fin(p.retentionSec)) parts.push(`보존 ${retentionText(p.retentionSec)}`);
  else if (p.pool && !p.collected) parts.push('보존 —');
  if (fin(p.keep)) parts.push(`Full 체인 ${p.keep}개`);
  if (p.dup) parts.push(`Director 스케줄 ${p.dup} 에도 있어 두 번 돌 수 있음`);
  return parts.join(' · ');
}
