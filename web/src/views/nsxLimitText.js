/**
 * views/nsxLimitText.js — NSX 목록 절단·부분 집계 안내(순수, v2.599 감사 C2599-05).
 * 서버(`nsx/client.js`)가 cursor 페이징 상한에 걸린 목록(`manager.listsTruncated`), 규칙을 조회하지 않은
 * 정책 수(`firewall.policiesOmitted`), 규칙 수가 하한인 경우(`firewall.rulesPartial`), 포트 목록이 잘린
 * 세그먼트(`portsTruncated`)를 싣는다. 화면이 말하지 않으면 '전부 받았다' 는 거짓이 된다 — 문구는 여기 하나가 만든다.
 */
const LIST_LABEL = {
  transportNodes: '전송 노드', tier0s: 'T0 게이트웨이', tier1s: 'T1 게이트웨이',
  segments: '세그먼트', securityPolicies: 'DFW 정책', groups: '보안그룹',
};

/** 매니저별 안내 줄. @returns {string[]} */
export function nsxLimitNotes(managers = [], segments = []) {
  const out = [];
  for (const m of Array.isArray(managers) ? managers : []) {
    const name = m?.name || m?.id || '(이름 없음)';
    const lists = (Array.isArray(m?.listsTruncated) ? m.listsTruncated : []).map((k) => LIST_LABEL[k] || k);
    if (lists.length) out.push(`**${name}**: ${lists.join('·')} 목록이 페이지 상한에 걸려 끝까지 받지 못했습니다 — 표시된 개수는 하한입니다.`);
    // v2.600(감사 COL-2600-06): 조회 자체가 실패한 목록 — 서버가 `listsFailed` 로 싣는다. 그 목록의 0 은 '없음' 이 아니다.
    const failed = (Array.isArray(m?.listsFailed) ? m.listsFailed : []).map((k) => LIST_LABEL[k] || k);
    if (failed.length) out.push(`**${name}**: ${failed.join('·')} 목록을 읽지 못했습니다 — 표시된 0 은 '없음' 이 아니라 **확인 불가**입니다(권한·API 버전·매니저 응답 확인).`);
    const fw = m?.firewall || {};
    const omitted = Number(fw.policiesOmitted);
    if (Number.isFinite(omitted) && omitted > 0) {
      out.push(`**${name}**: DFW 정책 ${fw.policies}개 중 ${omitted}개는 규칙 목록을 조회하지 않았습니다${fw.policiesRuleLimit != null ? `(정책당 조회 상한 ${fw.policiesRuleLimit}개)` : ''} — 규칙 표에는 앞 정책들의 규칙만 있습니다.`);
    }
    if (fw.rulesPartial) out.push(`**${name}**: DFW 규칙 수는 하한입니다(규칙 수를 알 수 없는 정책이 있거나 규칙 목록이 잘렸습니다).`);
  }
  const cut = (Array.isArray(segments) ? segments : []).filter((s) => s?.portsTruncated).length;
  if (cut) out.push(`포트 목록이 페이지 상한에 걸린 세그먼트 ${cut}개 — 그 세그먼트의 VM(포트) 수는 하한입니다(‘+’ 표시).`);
  return out;
}

/** 매니저 행 DFW 칸 표기 — 하한이면 뒤에 '+'. 값이 없으면 '—'. */
export function dfwRulesCell(m) {
  const v = m?.firewall?.rules;
  if (v == null || v === '') return '—';
  return m.firewall.rulesPartial || Number(m.firewall.policiesOmitted) > 0 ? `${v}+` : String(v);
}

/*
 * v2.600(감사 COL-2600-06 후속): 서버 rollup·매니저 행이 **목록 조회 실패**를 null 로 준다(0 은 '없음' 이라는 거짓).
 * 화면은 null 을 0 으로도 'null' 로도 그리지 않는다 — 판정·문구는 여기 하나(V2 NSX · V4 네트워크 · 관제 콘솔 공용).
 */
/** 개수 칸 — null/비숫자는 '—'(단위 없이). */
export function nsxCount(v) {
  return v == null || v === '' || !Number.isFinite(Number(v)) ? '—' : String(Number(v));
}

/** 두 개수의 합 — 하나라도 모르면 null(부분 합을 전체라 말하지 않는다). */
export function nsxAdd(...vs) {
  let a = 0;
  for (const v of vs) { if (v == null || v === '' || !Number.isFinite(Number(v))) return null; a += Number(v); }
  return a;
}

/** rollup.listsFailed({목록: 매니저 수}) → 짧은 문구('조회 실패: 세그먼트·DFW 정책'). 없으면 ''. */
export function nsxFailedShort(r) {
  const lf = r && typeof r.listsFailed === 'object' && r.listsFailed ? Object.keys(r.listsFailed) : [];
  return lf.length ? `조회 실패: ${lf.map((k) => LIST_LABEL[k] || k).join('·')}` : '';
}
