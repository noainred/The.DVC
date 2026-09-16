/**
 * views/tools/storageListText.js — 스토리지 목록의 '왜 비었나' 문구(순수, v2.522).
 *
 * 2026-09-16 사용자 신고: "표에는 없는데, 등록하려고 하면 있는 장비라고 나온다."
 * 재현 화면에서 표 안은 **`등록된 장비가 없습니다 — "+ 장비 등록"으로 시작하세요.`** 였는데,
 * 바로 위 머리글은 `장비 0대 (전체 42대 중) · 조건에 맞는 장비가 없습니다` 였다.
 * 즉 **42대가 등록돼 있는데 표가 '등록된 게 없다' 고 말하고 있었다.** 그 문구를 믿으면
 * 중복 오류는 설명이 안 되고, 사용자는 시스템이 잘못됐다고 판단한다.
 *
 * 저장소 규약(CLAUDE.md):
 *  · 값이 없는 이유를 **한 문구로 덮지 않는다**(v2.493). '등록 0대'·'필터로 0대'·'검색으로
 *    0대'는 사용자가 할 일이 서로 다르다 — 각각 다르게 말한다.
 *  · 웹 테스트는 node 환경(DOM 없음)이라 판정·문구는 순수 모듈에 두고 회귀로 고정한다.
 */

/**
 * 표가 비었을 때 보여 줄 문구.
 *
 * @param {object} p
 * @param {number} p.registered  등록부 전체 대수(필터 이전)
 * @param {boolean} p.facetOn    법인/타입 칩 선택이 하나라도 걸려 있는가
 * @param {string}  p.query      빠른 찾기 입력값
 * @returns {{ text: string, canClear: boolean }}
 *          `canClear` 는 '필터 해제' 버튼을 띄울지 — 해제해도 0대인 상황(= 진짜 등록 0)에
 *          버튼을 띄우면 눌러도 아무 일이 없어 사용자를 두 번 헤매게 한다.
 */
export function emptyListText({ registered = 0, facetOn = false, query = '' } = {}) {
  const q = String(query || '').trim();
  const total = Number(registered) || 0;

  // 등록 자체가 0대 — 이때만 '시작하세요' 가 참이다.
  if (total === 0) return { text: '등록된 장비가 없습니다 — "+ 장비 등록"으로 시작하세요.', canClear: false };

  if (q && facetOn) {
    return {
      text: `조건에 맞는 장비가 없습니다 — 등록된 ${total}대 중 0대. 찾기 "${q}" 와 법인·타입 필터가 함께 걸려 있습니다.`,
      canClear: true,
    };
  }
  if (q) {
    return { text: `찾기 "${q}" 에 맞는 장비가 없습니다 — 등록된 ${total}대 중 0대.`, canClear: true };
  }
  if (facetOn) {
    return { text: `필터에 맞는 장비가 없습니다 — 등록된 ${total}대 중 0대. 법인·타입 선택을 해제하면 다시 보입니다.`, canClear: true };
  }
  // 필터도 검색도 없는데 0대인데 등록은 있다 = 상위에서 이미 나눈 목록(법인/타입 그룹)이 빈 것.
  // 여기서 '등록이 없다' 고 말하면 거짓이므로 사실만 말한다.
  return { text: `이 목록에 표시할 장비가 없습니다 — 등록은 ${total}대 있습니다.`, canClear: false };
}

/**
 * 중복 등록 거부 안내(서버 `conflict` 를 화면 문장으로).
 * 서버는 법인 **id** 만 알고 있으므로(법인 이름은 별도 스토어) 이름 변환은 화면이 한다 —
 * `dcName` 을 주입받는다. 주입이 없으면 id 를 그대로 쓴다(지어내지 않는다).
 *
 * @returns {{ head: string, where: string, hint: string } | null}
 */
export function conflictText(conflict, { dcName = (x) => x, typeLabel = (x) => x } = {}) {
  if (!conflict) return null;
  const name = String(conflict.name || conflict.id || '이름 없음');
  const dc = conflict.datacenterId ? String(dcName(conflict.datacenterId) || conflict.datacenterId) : '법인 미지정';
  const who = conflict.agent ? `수집 ${conflict.agent}` : '수집 중앙';
  const bits = [dc, who, `종류 ${typeLabel(conflict.type) || conflict.type}`];
  if (conflict.enabled === false) bits.push('비활성');
  if (conflict.pulled) bits.push('중앙 배포분');
  return {
    head: `이미 등록된 장비입니다 — '${name}' (${conflict.host})`,
    where: bits.join(' · '),
    hint: '같은 host 의 같은 종류는 한 대만 등록됩니다. 아래 "그 장비 보기" 를 누르면 필터를 풀고 이동합니다.',
  };
}
