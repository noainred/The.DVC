/**
 * v2.783(점검 Q2 P-B3 — 데이터 손실): 통합 서버 인벤토리 '유령 키 정리' 의 확인·결과 문구(순수 — 화면·테스트가 같이 쓴다).
 *
 * 예전 확인창은 화면 요약(summary.ghostKeys)의 숫자로 'N개를 제거합니다' 라고 물었고, 실제 삭제는 서버가 다른 판정으로 했다
 * (확인창 '1개' · 실제 3건 — 살아 있는 원격 베어메탈의 법인 귀속·분류 태그). 이제
 *  ① 확인 전에 미리보기(dryRun)를 받아 **그 결과의 숫자·키**로 묻는다.
 *  ② 미리보기가 blocked(읽지 못한 출처)면 묻지 않고 사유를 보인다.
 *  ③ 실제 요청에는 미리 본 키 목록(keys)을 보낸다 — 서버는 '그 목록 ∩ 지금도 유령' 만 지운다.
 * 숫자를 못 읽으면 숫자를 지어내지 않는다.
 */
const num = (v) => (Number.isFinite(v) ? v : null);
const SHOW_KEYS = 10;

/**
 * 미리보기 응답 → 다음 동작.
 * @returns {{kind:'blocked', message:string} | {kind:'none', message:string} | {kind:'confirm', confirm:string, keys:string[]}}
 */
export function prunePlan(dry) {
  if (!dry || typeof dry !== 'object' || dry.ok === false) {
    const why = dry && typeof dry.reason === 'string' && dry.reason.trim() ? dry.reason.trim() : '미리보기 응답을 읽지 못했습니다.';
    return { kind: 'blocked', message: `유령 키 정리를 하지 않았습니다 — ${why}` };
  }
  if (dry.blocked) {
    const reasons = (Array.isArray(dry.unreadable) ? dry.unreadable : []).map((u) => u && u.reason).filter((x) => typeof x === 'string' && x);
    const list = reasons.length ? reasons.slice(0, 5).join(' · ') + (reasons.length > 5 ? ` 외 ${reasons.length - 5}건` : '') : (dry.reason || '사유 미상');
    return { kind: 'blocked', message: `지금은 유령 키를 정리할 수 없습니다 — 읽지 못한 출처가 있어 살아 있는 서버의 키를 지울 수 있습니다: ${list}` };
  }
  const keys = (Array.isArray(dry.keys) ? dry.keys : []).filter((k) => typeof k === 'string' && k);
  if (!keys.length) return { kind: 'none', message: '지울 유령 키가 없습니다(그 사이 정리됐거나 서버와 다시 맞춰졌습니다).' };
  const t = num(dry.wouldRemoveTags); const a = num(dry.wouldRemoveAssign); const total = num(dry.keysTotal);
  const parts = [t != null ? `분류 태그 ${t}건` : null, a != null ? `소속 법인 ${a}건` : null].filter(Boolean).join(' · ');
  const more = total != null && total > keys.length ? `\n(전체 ${total}개 중 이번에는 ${keys.length}개만 정리합니다 — 나머지는 다시 누르세요.)` : '';
  const shown = keys.slice(0, SHOW_KEYS).join(', ') + (keys.length > SHOW_KEYS ? ` 외 ${keys.length - SHOW_KEYS}개` : '');
  return {
    kind: 'confirm',
    keys,
    confirm: `유령 키 ${keys.length}개${parts ? `(${parts})` : ''}를 제거합니다 — 어느 서버·호스트와도 맞지 않는 잔재입니다.\n키: ${shown}${more}\n진행할까요?`,
  };
}

/** 실제 정리 응답(성공 본문) → 완료 문구. */
export function pruneDoneText(r) {
  const k = num(r?.removedKeys); const t = num(r?.removedTags); const a = num(r?.removedAssign); const s = num(r?.skipped);
  if (k == null && t == null && a == null) return '유령 키 정리 요청을 서버가 받았습니다(제거 수는 응답에 없습니다).';
  const head = k != null ? `유령 키 ${k}개 정리 완료` : '유령 키 정리 완료';
  const detail = [t != null ? `태그 ${t}건` : null, a != null ? `소속 ${a}건` : null].filter(Boolean).join(' · ');
  return `${head}${detail ? ` — ${detail} 제거` : ''}${s ? ` · 미리 본 뒤 유령이 아니게 된 ${s}개는 지우지 않았습니다` : ''}`;
}
