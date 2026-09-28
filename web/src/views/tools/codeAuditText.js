/**
 * views/tools/codeAuditText.js — '포탈 점검 › 코드 감사' 의 **문구·필터·정렬**(순수, v2.636).
 *
 * 사용자 요청(2026-09-28): "전체 코드 분석해서 아키텍처 리뷰·버그·개선 포인트·튜닝 포인트 각각 10개씩 찾아서 문서로 저장하고
 * 화면에도 보여줘". 서버 `portalcheck/codeAudit.js` 가 카탈로그(`codeAudit.json`)와 **앵커 확인 결과**(`check.state`)를 주고
 * 문장은 여기 하나가 만든다(v2.614 `archCheckText.js` 관례).
 *
 * ── 이 화면이 만들 수 있는 거짓 — 전부 여기서 막는다 ─────────────────────────
 *  ① **'gone'(앵커가 사라짐)을 '고쳤다' 로 말하지 않는다** — 조각이 바뀐 것일 수도 있다. 고침은 카탈로그의 `status:'fixed'` 만이다.
 *  ② **'no-source' 를 결함이 없는 것으로 말하지 않는다** — 이 설치본에 그 소스 트리(web/src 등)가 없어 확인하지 못한 것이다.
 *  ③ 신뢰도(재현 확정/코드 확인/추정)를 심각도와 섞지 않는다 — 두 축을 따로 보여 준다.
 *  ④ 판정을 여기서 다시 하지 않는다 — 서버 값(`check.state`·`severity`)을 읽기만 하고 모르는 값은 '확인 안 함'.
 *
 * ⚠ 문구에 **백틱 금지**(`BoldText` 는 `**강조**` 만 해석 — v2.576 스윕). 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';

const t = (v) => String(v ?? '').trim();
const n = numOrNull;

export const CATEGORIES = Object.freeze(['arch', 'bug', 'improve', 'tuning']);
export const CATEGORY_LABEL = Object.freeze({ arch: '아키텍처 리뷰', bug: '버그', improve: '개선 포인트', tuning: '튜닝 포인트' });
export const SEVERITY_LABEL = Object.freeze({ high: '높음', medium: '중간', low: '낮음' });
export const SEVERITY_TONE = Object.freeze({ high: 'red', medium: 'amber', low: 'gray' });
export const CONFIDENCE_LABEL = Object.freeze({ confirmed: '재현 확정', likely: '코드 확인', speculative: '추정' });
export const CONFIDENCE_TONE = Object.freeze({ confirmed: 'green', likely: 'amber', speculative: 'gray' });
/** 앵커 상태 — 서버 `ANCHOR_STATES` 와 1:1(테스트 대조). */
export const ANCHOR_LABEL = Object.freeze({
  present: '소스에 있음', moved: '줄이 옮겨짐', gone: '조각이 사라짐', 'missing-file': '파일 없음', 'no-source': '소스 미포함', unchecked: '확인 안 함',
});
export const ANCHOR_TONE = Object.freeze({ present: 'green', moved: 'amber', gone: 'amber', 'missing-file': 'red', 'no-source': 'gray', unchecked: 'gray' });
export const STATUS_LABEL = Object.freeze({ open: '미조치', fixed: '고침' });

const SEV_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

export const categoryLabel = (c) => CATEGORY_LABEL[t(c)] || t(c) || '분류 없음';
export const severityLabel = (s) => SEVERITY_LABEL[t(s)] || '—';
export const severityTone = (s) => SEVERITY_TONE[t(s)] || 'gray';
export const confidenceLabel = (c) => CONFIDENCE_LABEL[t(c)] || '확인 안 함';
export const confidenceTone = (c) => CONFIDENCE_TONE[t(c)] || 'gray';
export const anchorState = (f) => (Object.prototype.hasOwnProperty.call(ANCHOR_LABEL, t(f?.check?.state)) ? t(f.check.state) : 'unchecked');
export const anchorLabel = (f) => ANCHOR_LABEL[anchorState(f)];
export const anchorTone = (f) => ANCHOR_TONE[anchorState(f)] || 'gray';
export const statusOf = (f) => (t(f?.status) === 'fixed' ? 'fixed' : 'open');
export const statusLabel = (f) => (statusOf(f) === 'fixed' ? `고침${t(f?.fixedIn) ? `(v${t(f.fixedIn)})` : ''}` : STATUS_LABEL.open);

/** 위치 문자열 — 감사 시점 줄 + 지금 줄(옮겨졌으면). */
export function locationText(f) {
  const file = t(f?.file); const line = n(f?.line);
  if (!file) return '—';
  const base = line != null ? `${file}:${line}` : file;
  const now = n(f?.check?.lineNow);
  return anchorState(f) === 'moved' && now != null ? `${base} → 지금 ${now}줄` : base;
}

/** 앵커 상태의 뜻 — 툴팁·각주. 'gone' 을 '고침' 으로 말하지 않는다(규칙 ①). */
export function anchorNote(f, source) {
  switch (anchorState(f)) {
    case 'present': return '감사 시점과 같은 줄에 그 코드 조각이 있습니다 — 발견이 그대로 유효할 가능성이 높습니다.';
    case 'moved': return '코드 조각은 있지만 줄이 옮겨졌습니다 — 그 파일의 다른 곳이 바뀐 것이고 발견 자체는 남아 있을 가능성이 높습니다.';
    case 'gone': return '파일은 있는데 그 코드 조각이 없습니다 — 고쳐졌을 수도, 조각만 바뀌었을 수도 있습니다. 고침 여부는 카탈로그의 상태(status)로만 확정합니다.';
    case 'missing-file': return '그 파일이 이 설치본에 없습니다 — 파일이 옮겨졌거나 지워진 것입니다.';
    case 'no-source': {
      const tree = t(f?.file).split('/').slice(0, 2).join('/');
      const why = tree === 'web/src' && source && source.webSrc === false ? ' 오프라인 패키지·업그레이드 번들은 web/dist 만 담고 web/src 를 담지 않습니다.' : '';
      return `이 설치본에 그 소스 트리(${tree || '—'})가 없어 확인하지 못했습니다 — 발견이 없다는 뜻이 아닙니다.${why}`;
    }
    default: return statusOf(f) === 'fixed' ? '고친 발견은 앵커를 확인하지 않습니다.' : '앵커를 확인하지 않았습니다.';
  }
}

/** 카테고리별·심각도별·앵커별 개수(항등식 — 카테고리 합 = 전체). 서버 kpi 와 어긋나면 화면이 말한다(kpiMismatchNote). */
export function kpiOf(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const by = (keys, pick) => Object.fromEntries(keys.map((k) => [k, list.filter((f) => pick(f) === k).length]));
  return {
    total: list.length,
    byCategory: by(CATEGORIES, (f) => t(f?.category)),
    bySeverity: by(Object.keys(SEVERITY_LABEL), (f) => t(f?.severity)),
    byConfidence: by(Object.keys(CONFIDENCE_LABEL), (f) => t(f?.confidence)),
    byAnchor: by(Object.keys(ANCHOR_LABEL), anchorState),
    open: list.filter((f) => statusOf(f) === 'open').length,
    fixed: list.filter((f) => statusOf(f) === 'fixed').length,
  };
}

export function kpiMismatchNote(serverKpi, findings) {
  const mine = kpiOf(findings);
  const sv = n(serverKpi?.total);
  if (sv == null || sv === mine.total) return '';
  return `⚠ 서버 요약(${sv}건)과 화면이 센 개수(${mine.total}건)가 다릅니다 — 응답이 잘렸거나 모양이 바뀐 것입니다. 표의 개수를 기준으로 보세요.`;
}

/** 배너 — 무엇을 보고 있는지 한 번만. */
export function bannerText(data) {
  if (!data) return { tone: 'gray', text: '감사 결과를 아직 받지 못했습니다.' };
  if (data.ok === false || (Array.isArray(data.errors) && data.errors.length)) {
    return { tone: 'red', text: `감사 카탈로그를 읽지 못했거나 모양이 맞지 않습니다 — ${(data.errors || []).slice(0, 3).join(' · ') || '사유 없음'}. 화면은 읽은 만큼만 보여 줍니다.` };
  }
  const k = kpiOf(data.findings);
  const ver = t(data.version); const base = t(data.base); const date = t(data.date);
  const srv = t(data.serverVersion);
  const drift = srv && ver && srv !== ver ? ` 지금 서버는 **v${srv}** 라 감사 시점과 다릅니다 — 표의 ‘앵커’ 열이 각 발견이 아직 소스에 있는지를 말합니다.` : '';
  const gone = k.byAnchor.gone + k.byAnchor['missing-file'];
  const noSrc = k.byAnchor['no-source'];
  const parts = [
    `**${date}** 감사(v${ver}, 기준 커밋 ${base}) — 아키텍처 리뷰 ${k.byCategory.arch} · 버그 ${k.byCategory.bug} · 개선 ${k.byCategory.improve} · 튜닝 ${k.byCategory.tuning}, 합계 **${k.total}건**(높음 ${k.bySeverity.high} · 중간 ${k.bySeverity.medium} · 낮음 ${k.bySeverity.low}).`,
    `이 화면은 감사 시점의 **목록**이고 수정은 별도 요청으로 진행합니다 — 고친 발견은 ‘고침’ 으로 표시되고 목록에서 지워지지 않습니다.${drift}`,
  ];
  if (gone) parts.push(`앵커가 사라지거나 파일이 없는 발견 **${gone}건**은 고쳐졌다는 뜻이 아닙니다 — 조각이 바뀐 것일 수 있어 카탈로그 상태로만 확정합니다.`);
  if (noSrc) parts.push(`소스 미포함 **${noSrc}건**은 이 설치본에 그 소스 트리가 없어 확인하지 못한 것입니다(발견이 없다는 뜻이 아닙니다).`);
  const tone = k.bySeverity.high > 0 ? 'red' : k.bySeverity.medium > 0 ? 'amber' : 'green';
  return { tone, text: parts.join(' ') };
}

/** 필터 — 분류·심각도·검색어·조치 상태(AND). 검색은 id·제목·파일·근거·조치. */
export function filterFindings(findings, { category = 'all', severity = 'all', q = '', onlyOpen = false } = {}) {
  const needle = t(q).toLowerCase();
  return (Array.isArray(findings) ? findings : []).filter((f) => {
    if (category !== 'all' && t(f?.category) !== category) return false;
    if (severity !== 'all' && t(f?.severity) !== severity) return false;
    if (onlyOpen && statusOf(f) !== 'open') return false;
    if (!needle) return true;
    return [f?.id, f?.title, f?.file, f?.evidence, f?.impact, f?.fix, f?.prior].some((v) => t(v).toLowerCase().includes(needle));
  });
}

/** 정렬 — 분류 순서 → rank. (한 분류 안에서는 감사가 매긴 순위가 곧 중요도다.) */
export function sortFindings(findings) {
  return [...(Array.isArray(findings) ? findings : [])].sort((a, b) => {
    const ca = CATEGORIES.indexOf(t(a?.category)); const cb = CATEGORIES.indexOf(t(b?.category));
    if (ca !== cb) return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb);
    const ra = n(a?.rank) ?? 99; const rb = n(b?.rank) ?? 99;
    if (ra !== rb) return ra - rb;
    return (SEV_RANK[t(a?.severity)] ?? 9) - (SEV_RANK[t(b?.severity)] ?? 9);
  });
}

/** 상단 메타 줄 — 서버가 준 시각·버전. */
export function metaLine(data, agoFn) {
  if (!data) return '';
  const at = n(data.at);
  const bits = [];
  if (at != null && typeof agoFn === 'function') bits.push(`서버 확인 ${agoFn(at)}`);
  if (t(data.serverVersion)) bits.push(`서버 v${t(data.serverVersion)}`);
  if (t(data.doc)) bits.push(`문서 docs/${t(data.doc)}`);
  return bits.join(' · ');
}

/** 표 아래 각주 — 앵커 상태 중 **표에 실제로 있는 종류만**(v2.509 규약). */
export function tableFootnotes(findings, source) {
  const states = new Set((Array.isArray(findings) ? findings : []).map(anchorState));
  const out = [];
  for (const s of Object.keys(ANCHOR_LABEL)) if (states.has(s)) out.push(`**${ANCHOR_LABEL[s]}** — ${anchorNote({ check: { state: s }, file: s === 'no-source' ? 'web/src/x' : 'server/src/x' }, source)}`);
  return out;
}

/** 빈 표 문구 — 이유를 나눈다. */
export function emptyText({ total = 0, shown = 0 } = {}) {
  if (total === 0) return '발견이 없습니다 — 서버가 카탈로그를 내려 주지 않았습니다(배너의 사유를 보세요).';
  if (shown === 0) return '조건에 맞는 발견이 없습니다 — 분류·심각도·검색어를 지우면 전체가 보입니다.';
  return '';
}
