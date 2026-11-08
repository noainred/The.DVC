/**
 * bmusage/commonTag.js — 서비스 태그를 **전역 열쇠**로 써도 되는가(2차 재확인 G1) — 판정 하나(순수).
 *
 * 왜: 2차 수정은 ‘서비스 태그는 하드웨어 전역 유일’ 이라 보고 용도 태그를 서비스 태그 단독 키로 저장했다. 그런데 이번 작업이 다루는 바로 그
 *   공통 태그(‘To Be Filled By O.E.M.’ 같은 화이트박스 기본값)는 법인 · 노드를 넘어 여러 서버에 같다 — 범위 관리자 A 가 단 태그가 같은 태그의
 *   B 법인 서버 판정을 바꾸고, B 가 지우면 A 의 태그가 사라졌다(반증 F2 와 같은 꼴 · 재현 rvn1/v2/r1c).
 * 근거는 겹침 판정(insights/fleetInventory.js classifyFleet 의 dk = 서비스 태그 소문자)과 같다:
 *   ① 알려진 기본값 · 꼴(빈 값 · 영숫자 4자 미만 · 한 글자 반복 · 연속 숫자) ② 이 노드 대상 · 대상이 아닌 서버 · 겹침 목록과 엣지 보관분에서
 *   **둘 이상 법인**에 나타나는 태그 ③ 이 노드 겹침 목록에 있는 태그(같은 노드에서 이미 둘 이상 서버가 쓴다).
 * ⚠ 모르면 전역 열쇠로 쓰지 않는다(complete=false): 중앙이 엣지 법인을 맡기면(엣지 위임 · 보관분) 그 엣지의 대상이 아닌 서버까지는 모른다 —
 *   그때 서비스 태그 키도 (법인, 키) 쌍으로 쓴다(쌍 키는 늘 안전하다 — 읽기는 쌍 → 서비스 태그 순). 엣지 · 단일 노드는 자기 함대를 다 안다.
 */
import { pushAll } from '../util/pushAll.js';

// 3차 재확인 보강: 전각 · 호환 문자는 NFKC 로 · 0폭 문자(ZWSP · ZWJ · BOM · 방향 표시)는 지운다 — ‘To Be Filled By O.E.M.’ 에 0폭 문자를 붙여 목록을 비켜 가지 않게.
const ZW_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g;
const norm = (v) => String(v ?? '').slice(0, 256).normalize('NFKC').replace(ZW_RE, '').trim().toLowerCase().slice(0, 128);
const alnumOf = (n) => n.replace(/[^a-z0-9]/g, '');

/** 알려진 공통 기본값(소문자 · BIOS/IPMI/화이트박스가 채우는 자리표시). 꼴 판정(isPlaceholderTag)이 짧은 값 · 반복 · 연속 숫자를 따로 잡는다. */
export const KNOWN_COMMON_TAGS = Object.freeze([
  'to be filled by o.e.m.', 'to be filled by oem', 'to be filled', 'default string', 'default', 'system serial number', 'chassis serial number',
  'base board serial number', 'baseboard serial number', 'serial number', 'system serial', 'not specified', 'not applicable', 'not available',
  'not set', 'none', 'unknown', 'invalid', 'empty', 'o.e.m.', 'oem', 'system product name', 'type1productconfigid', 'product serial',
  // 3차 재확인 보강(반증 r12 — 목록 밖 값): 끝 점 없는 꼴 · 붙여 쓴 꼴 · 접두가 붙은 꼴은 아래 영숫자 비교가 잡는다
  'unspecified', 's/n: n/a', 'changeme', 'to be filled by o.e.m',
]);
const KNOWN = new Set(KNOWN_COMMON_TAGS);
// 영숫자만 남긴 꼴로도 비교한다 — ‘NotSpecified’ · ‘Not_Specified’ · ‘To Be Filled By O.E.M’ · ‘SerialNumber’ 가 같은 값으로 잡힌다.
const KNOWN_ALNUM = new Set(KNOWN_COMMON_TAGS.map(alnumOf).filter((a) => a.length >= 4));
const SEQ = ['0123456789', '1234567890', '9876543210'];

/** 꼴로 보아 공통 기본값인가(순수) — 알려진 값 · 영숫자 4자 미만 · 한 글자 반복(0000000 · xxxxxxx) · 연속 숫자(1234567). */
export function isPlaceholderTag(tag) {
  const n = norm(tag);
  if (!n || KNOWN.has(n)) return true;
  const a = alnumOf(n);
  if (a.length < 4 || KNOWN_ALNUM.has(a)) return true;
  if (/^(.)\1*$/.test(a)) return true;             // 길이 128 상한 · 앵커 — 선형
  return SEQ.some((s) => s.includes(a));
}

/**
 * 판정기(순수). rows = 서비스 태그 · 법인이 있는 행(대상 · 대상이 아닌 서버 · 엣지 보관분 대상) · overlapTags = 이 노드 겹침 목록의 태그 ·
 *   complete = 이 노드가 같은 저장소를 쓰는 서버를 다 아는가.
 * @returns {{ complete:boolean, isCommon:(tag)=>boolean, tagKeyOk:(tag)=>boolean }}
 */
export function commonTagJudge({ rows = [], overlapTags = [], complete = true } = {}) {
  const corps = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const n = norm(r.serviceTag);
    if (!n) continue;
    if (!corps.has(n)) corps.set(n, new Set());
    corps.get(n).add(String(r.vcenterId ?? '').trim());
  }
  const dup = new Set((Array.isArray(overlapTags) ? overlapTags : []).map(norm).filter(Boolean));
  const isCommon = (tag) => isPlaceholderTag(tag) || dup.has(norm(tag)) || (corps.get(norm(tag))?.size || 0) >= 2;
  return { complete: !!complete, isCommon, tagKeyOk: (tag) => !!complete && !isCommon(tag) };
}

/**
 * 지금 상태로 판정기를 만든다(순수 — 호출부가 currentTargets 결과와 엣지 보관분을 넘긴다).
 *   complete: 엣지 노드이거나, 중앙이 맡긴 엣지가 하나도 없을 때(대상이 아닌 서버의 edge-delegated 없음 · 보관분 없음)만 참.
 */
export function tagJudgeOf(tg = {}, edges = []) {
  const recs = (Array.isArray(edges) ? edges : []).filter((r) => r && r.snap && Array.isArray(r.snap.targets));
  const skipped = Array.isArray(tg?.skipped) ? tg.skipped : [];
  const overlaps = Array.isArray(tg?.keyOverlaps) ? tg.keyOverlaps : [];
  const rows = [];
  pushAll(rows, Array.isArray(tg?.targets) ? tg.targets : []); pushAll(rows, skipped); pushAll(rows, overlaps);
  for (const r of recs) pushAll(rows, r.snap.targets);   // 봉투 상한 2,000 — 펼침 push 는 인자 상한에 걸린다(audit2603a 스윕)
  const delegates = skipped.some((s) => s && s.reason === 'edge-delegated') || recs.length > 0 || (Array.isArray(edges) && edges.length > 0);
  return commonTagJudge({ rows, overlapTags: overlaps.map((o) => o?.serviceTag), complete: !!tg?.isEdge || !delegates });
}
