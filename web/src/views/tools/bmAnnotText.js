/**
 * views/tools/bmAnnotText.js — 리눅스 성능 6단계 **운영 주석**(◆ 핀 · 목록 · 입력)의 문구 · 좌표(순수 · vitest `bmStage6Text.test.jsx`).
 *
 * ⚠ 저장 · 정제 · 범위는 서버(`bmusage/annotations.js` · `routes/api/bmAnnotations.js`). 연결은 권한을 주지 않는다 — 여는 사람의 권한으로 본다.
 * ⚠ 기계 이벤트(변경 이벤트)는 ● 점, 사람 주석은 ◆ 핀(같은 줄 · 다른 모양). 지운 주석(흔적)은 핀을 그리지 않고 목록에만 ‘삭제됨’.
 * ⚠ 문구에 백틱 금지.
 */
import { numOrNull } from '../../numOrNull.js';
import { fmtHm } from '../../components/vmperf/vmPerfText.js';
import { shortStamp } from './bmOpsText.js';

const n = numOrNull;
/** 종류(server ANNOT_KINDS) → 이름(1:1). */
export const ANNOT_KIND_TEXT = Object.freeze({ work: '작업(수동 실행 · 배치)', change: '변경(설정 · 배포)', external: '외부 요인(네트워크 · 전원 · 공조)', incident: '사고 · 복구', memo: '메모' });
export const ANNOT_KIND_SHORT = Object.freeze({ work: '작업', change: '변경', external: '외부 요인', incident: '사고 · 복구', memo: '메모' });
export const TARGET_TYPE_TEXT = Object.freeze({ server: '이 서버', servers: '선택 서버', corp: '법인 전체' });

/** 주석 → 추이 핀(창 안 · 지운 것 제외). 범위 주석은 end 를 실어 띠로 그린다. */
export function annotMarks(list = [], win = {}) {
  const f = n(win.from); const e = n(win.to);
  if (f == null || e == null || !(e > f)) return [];
  return (Array.isArray(list) ? list : []).filter((a) => a && !a.deleted && n(a.at) != null && (n(a.end) ?? a.at) >= f && a.at <= e)
    .map((a) => ({ t: Math.max(f, a.at), end: n(a.end) == null ? null : Math.min(e, a.end), pin: true, title: `◆ ${fmtHm(a.at)}${n(a.end) != null ? `~${fmtHm(a.end)}` : ''} · ${a.by || '—'} · ${ANNOT_KIND_SHORT[a.kind] || a.kind}\n${a.text || ''}` }));
}
/** 목록 한 줄의 시각(범위) 글자. */
export function annotWhenText(a) { return `${shortStamp(a.at)}${n(a.end) != null ? ` ~ ${fmtHm(a.end)}` : ''}`; }
/** 대상 글자 — ‘이 서버 + 이름들’ · 법인 전체. */
export function annotTargetText(a) {
  const tg = a?.target || {};
  if (tg.type === 'corp') return `법인 ${(tg.vcenterIds || [])[0] || '—'}`;
  const names = (tg.names || []).filter(Boolean);
  return names.length ? names.slice(0, 3).join(' · ') + (names.length > 3 ? ` 외 ${names.length - 3}` : '') : `${tg.count ?? 0}대`;
}
/** 연결 → 링크(해시 라우팅 · 권한은 여는 사람 것). 집중 세션은 그 서버 상세의 집중 탭 안이라 글자만. */
export function annotLinks(links = {}) {
  const out = [];
  if (links?.issue) out.push({ href: `#/issues/list/${encodeURIComponent(links.issue)}`, text: `이슈 ${links.issue}` });
  if (links?.wiki?.id) out.push({ href: `#/wiki/${encodeURIComponent(links.wiki.space || 'pub')}/${encodeURIComponent(links.wiki.id)}`, text: `위키 ${links.wiki.id}` });
  if (links?.focus) out.push({ href: '', text: `집중 세션 ${String(links.focus).slice(0, 8)}` });
  if (links?.backup) out.push({ href: '', text: `백업 작업 ${links.backup}` });
  return out;
}
/** 입력 → 서버 본문(순수 — 빈 칸은 보내지 않는다 · 형식 판정은 서버). */
export function annotBody({ keys = [], corp = '', at, end = null, kind = 'work', text = '', issue = '', wikiSpace = '', wikiId = '' } = {}) {
  const links = {};
  if (String(issue).trim()) links.issue = String(issue).trim().toUpperCase();
  if (String(wikiId).trim()) links.wiki = { space: String(wikiSpace).trim() || 'pub', id: String(wikiId).trim().toUpperCase() };
  return { ...(corp ? { corp } : { keys }), at, ...(n(end) != null ? { end } : {}), kind, text, ...(Object.keys(links).length ? { links } : {}) };
}
/** datetime-local 값 ↔ ms(브라우저 로컬 시각 — 화면 입력용). */
export function localInputOf(ms) {
  const x = n(ms); if (x == null) return '';
  const d = new Date(x);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function msOfLocalInput(v) { const x = Date.parse(String(v || '')); return Number.isFinite(x) ? x : null; }
export const ANNOT_HONEST = '주석은 중앙에 남습니다(사람이 쓰는 데이터 — 엣지에 두지 않습니다). 작성자 · 시각은 자동이고 감사 기록에 남습니다. 고치면 이력이 남고, 지우면 내용은 지우되 ‘삭제됨’ 흔적은 남습니다. 연결(이슈 · 위키)은 권한을 주지 않습니다 — 여는 사람의 권한으로 봅니다.';
