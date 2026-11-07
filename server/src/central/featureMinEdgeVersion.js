/**
 * central/featureMinEdgeVersion.js — 엣지 기능의 **최소 엣지 버전을 릴리스 노트(사실의 원천)에서 읽는 공용 함수**(6단계 — 5단계 perfOpsMinEdgeVersion 일반화).
 *
 * 왜(반증 F15 · v2.933 bmUsageMinEdgeVersion 사고): 예정 번호를 상수로 박으면 다른 세션의 릴리스와 번호가 겹쳐 그 사이 엣지에 거짓 안내가 된다.
 *   그래서 ‘그 기능을 처음 실은 게시 번호’ 를 release-notes.json 에서 제목 표지(정규식)로 찾는다 — 제목은 메인이 릴리스 때 그대로 쓴다.
 *   노트에 아직 없으면(개발 중 · 릴리스 직전) 지금 실행 중인 package.json 번호(5단계 함수와 같은 폴백).
 * ⚠ 이 값은 게이트가 아니다 — 판정은 ‘그 경로가 엣지에 있는가’(구버전 엣지는 collector 라우터에 경로가 없어 401/404 → old-version)이고
 *   이 번호는 안내 문구(‘엣지 v… 이상 필요’)와 pullFromEdge 의 minVersion 표기에만 들어간다.
 * 한 번 읽어 표지별로 메모한다(노트는 프로세스 수명 동안 바뀌지 않는다 — 업그레이드는 재시작).
 */
import fs from 'node:fs';
import { currentVersion } from '../config.js';

/** 5단계 · 6단계 · 7a단계 표지(릴리스 노트 제목에 그대로 들어가는 문구). */
export const STAGE5_TITLE_RE = /리눅스 통합 성능 모니터링 5단계/;
export const STAGE6_TITLE_RE = /리눅스 통합 성능 모니터링 6단계/;
/** 7a단계(로그 분석 — 봉투 logSummary · 엣지 대행 /bm-usage/logs) 표지. */
export const STAGE7A_TITLE_RE = /리눅스 통합 성능 모니터링 7a단계/;
/** 7b단계(서버 등록 배포 — 엣지 인출 /api/central/bm-onboard · 엣지 적용 bmOnboardPull) 표지. */
export const STAGE7B_TITLE_RE = /리눅스 통합 성능 모니터링 7b단계/;

const verCmp = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const _memo = new Map();   // re.source → 버전

/** 노트 목록에서 표지 제목의 가장 낮은 게시 번호(순수 — 없으면 null). */
export function firstReleaseOf(notes, titleRe) {
  return (Array.isArray(notes) ? notes : [])
    .filter((x) => titleRe.test(String(x?.title || '')) && /^\d+\.\d+\.\d+$/.test(String(x?.version || '')))
    .map((x) => String(x.version)).sort(verCmp)[0] || null;
}

/**
 * @param {RegExp} titleRe  기능 표지(제목 정규식)
 * @param {{notesFile?:URL|string, fallback?:()=>string}} [o]
 */
export function featureMinEdgeVersion(titleRe, { notesFile = new URL('../release-notes.json', import.meta.url), fallback = currentVersion } = {}) {
  const k = titleRe.source;
  if (_memo.has(k)) return _memo.get(k);
  let v = null;
  try { v = firstReleaseOf(JSON.parse(fs.readFileSync(notesFile, 'utf8'))?.notes, titleRe); } catch { v = null; }
  if (!v) v = fallback();
  if (v && v !== '0.0.0') _memo.set(k, v);
  return v;
}
/** 6단계(서버 비교 엣지 묶음 계열 · 수집 건강 봉투) 최소 엣지 버전. */
export const stage6MinEdgeVersion = (o) => featureMinEdgeVersion(STAGE6_TITLE_RE, o);
/** 7a단계(로그 분석 봉투 · 엣지 대행) 최소 엣지 버전. */
export const stage7aMinEdgeVersion = (o) => featureMinEdgeVersion(STAGE7A_TITLE_RE, o);
/** 7b단계(서버 등록 배포를 받는 엣지) 최소 엣지 버전 — 숫자를 박지 않는다(릴리스 노트의 7b단계 첫 번호 · 없으면 지금 버전). */
export const stage7bMinEdgeVersion = (o) => featureMinEdgeVersion(STAGE7B_TITLE_RE, o);
export function _resetFeatureMinEdgeVersionForTest(titleRe = null) { if (titleRe) _memo.delete(titleRe.source); else _memo.clear(); }
