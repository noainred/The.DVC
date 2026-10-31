/**
 * Bareos '정책 · 일정' 탭(v2.839 백업 메뉴 개편 2차-a)의 순수 함수 — 글자 · 거르기만. 판정(VM 적용 정책 · 풀 가득 참 · 사용 %)은 서버(bareos/policy.js) 하나.
 *   값이 없으면 '—'(0 이 아니다) · Director 가 키를 싣지 않은 JobDefs 칸은 '기본'(Bareos 기본값 — 지어내지 않는다).
 */
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const p2 = (n) => String(n).padStart(2, '0');

/** 수집 명령 키 → 화면 이름(서버 policyParse.POLICY_CMDS 와 같은 순서 — 테스트가 대조). */
export const POLICY_CMD_LABEL = Object.freeze({ scheduler: '스케줄 · 7일 예정', pools: '풀', volumes: '볼륨', schedules: 'Run 줄', jobdefs: 'JobDefs', filesets: 'FileSet' });
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
