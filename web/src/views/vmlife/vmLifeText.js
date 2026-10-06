// v2.706(C5) — VM 생성·삭제 이력 문구. 판정은 서버 vmlife/analyze.js 가 한다(종류 키는 1:1 — 테스트 대조).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
export const LIFE_KIND_LABEL = Object.freeze({
  create: '새로 생성', clone: '복제', deploy: '템플릿 배포', register: '인벤토리 등록', remove: '삭제·제거', rename: '이름 변경',
});
export const LIFE_KIND_TONE = Object.freeze({ create: 'green', clone: 'green', deploy: 'green', register: 'blue', remove: 'red', rename: 'gray' });
export const ADD_KINDS = Object.freeze(['create', 'clone', 'deploy', 'register']);

/** 지금 인벤토리에 있는가 — 이름으로만 안다(동명 VM 은 구분하지 못한다). null 은 모름(첫 수집 중). */
export function existsText(e) {
  if (!e || e.existsNow == null) return { text: '모름', tone: 'gray', title: '첫 수집 중이라 지금 인벤토리와 대조하지 않았습니다' };
  if (e.kind === 'remove') return e.existsNow
    ? { text: '같은 이름 있음', tone: 'amber', title: '삭제 뒤 같은 이름으로 다시 만들었거나, 인벤토리에서만 제거한 VM 을 다시 등록했을 수 있습니다' }
    : { text: '없음', tone: 'gray', title: '지금 인벤토리에 이 이름의 VM 이 없습니다' };
  return e.existsNow
    ? { text: '있음', tone: 'green', title: '지금 인벤토리에 이 이름의 VM 이 있습니다' }
    : { text: '없음', tone: 'amber', title: '만든 뒤 지웠거나 이름을 바꿨을 수 있습니다' };
}

/** 단명 VM 의 수명 — 분·시간·일. */
export function lifeSpanText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}분`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h}시간`;
  return `${Math.round(ms / 86_400_000)}일`;
}

/** 순증 문구 — 추가 − 삭제. 이름 변경은 세지 않는다. */
export function netText(life) {
  if (!life) return '—';
  const n = Number(life.net) || 0;
  return `${n > 0 ? '+' : ''}${n.toLocaleString()}`;
}

/** 출처 줄(원본 VM·템플릿 / 이름 변경 전후) */
export function sourceText(e) {
  if (!e) return '—';
  if (e.kind === 'rename') return e.oldName || e.newName ? `${e.oldName || '?'} → ${e.newName || '?'}` : '—';
  if (e.source) return e.kind === 'deploy' ? `템플릿 ${e.source}` : `원본 ${e.source}`;
  return e.hasDetail === false ? '모름(상세 없는 이벤트)' : '—';
}

export const REMOVE_NOTE = "vSphere 는 '디스크에서 삭제' 와 '인벤토리에서만 제거' 를 같은 이벤트로 남깁니다 — 이 화면은 둘을 구분하지 못합니다.";
