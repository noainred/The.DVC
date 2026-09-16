/**
 * storage/duplicate.js — 장비 중복 판정과 **그 사유를 행동 가능하게 말하는 것**(순수, v2.522).
 *
 * 2026-09-16 사용자 신고: "장비를 등록하려고 하는데, 표에는 없는데, 등록하려고 하면 있는
 * 장비라고 나온다". 원인은 두 가지가 겹친 것이다 —
 *   ① 중복 판정은 **등록부 전체**(host+type)인데 화면은 법인·타입 칩으로 걸러져 있었다.
 *      42대 중 필터에 맞는 0대만 보이는 상태라 충돌 장비가 시야 밖이었다.
 *   ② 오류가 `같은 host 의 같은 타입 장비가 이미 있습니다.` 뿐이라 **어디에 있는지** 알 수
 *      없었다. 13개 법인·42대에서 이 문구만으로 찾는 것은 사실상 불가능하다.
 *
 * 그래서 판정은 그대로 두고(아래 ⚠), 충돌 장비를 **지목**한다. 화면은 이 값으로 '그 장비 보기'
 * 를 띄워 필터를 풀고 해당 장비로 데려간다.
 *
 * ⚠ **식별 키(host+type)를 바꾸지 말 것** — 2026-09-16 사용자 결정 "규칙은 그대로, 안내만
 *   고친다". 이 키는 저장 경로만의 것이 아니라 **CSV/자유텍스트 가져오기의 멱등성 키**이기도
 *   하다(`storage/csv.js:75 keyOf`, `util/bulkImport.js`). 키에 법인·수집주체를 더하면
 *   '내보내기 → 편집 → 가져오기' 왕복에서 같은 장비가 **중복 생성**된다. 사설 IP 가 법인마다
 *   겹칠 수 있다는 점은 사실이지만, 그것은 별도 결정이 필요한 데이터 모델 변경이다.
 *
 * ⚠ **비밀번호를 담지 말 것**. 이 객체는 400 응답 본문으로 나가 화면에 그대로 그려진다.
 *   여기 있는 필드는 이미 `listDevices()` 가 돌려주는 것들뿐이다(같은 노출 등급).
 */

/** 응답에 실어도 되는 필드만 추린다(비밀번호·기타 내부 필드 제외 — 화이트리스트). */
export function conflictInfo(dev) {
  if (!dev) return null;
  return {
    id: String(dev.id || ''),
    name: String(dev.name || ''),
    host: String(dev.host || ''),
    type: String(dev.type || ''),
    datacenterId: String(dev.datacenterId || ''),
    agent: String(dev.agent || ''),
    enabled: dev.enabled !== false,
    // 엣지가 중앙 설정 pull 로 받아 온 항목인지(현장에서 지울 수 없는 이유를 설명해 준다).
    pulled: dev.pulled === true,
  };
}

/**
 * 사람이 읽는 한 줄 — **어디를 봐야 하는지**까지 말한다.
 * 법인 이름은 서버가 모르는 경우가 있어(법인 목록은 별도 스토어) id 를 그대로 싣고,
 * 화면이 `dcName()` 으로 사람 이름으로 바꿔 다시 그린다. 여기서 지어내지 않는다.
 */
export function duplicateMessage(c) {
  if (!c) return '같은 host 의 같은 타입 장비가 이미 있습니다.';
  const where = c.datacenterId ? `법인 ${c.datacenterId}` : '법인 미지정';
  const who = c.agent ? `수집 ${c.agent}` : '수집 중앙';
  const off = c.enabled ? '' : ' · 비활성';
  return `같은 host 의 같은 타입 장비가 이미 등록돼 있습니다 — '${c.name || c.id}' (${where} · ${who}${off}). `
    + '화면에 안 보이면 법인·타입 필터가 걸려 있는 것입니다(필터 해제 후 확인하세요).';
}

/**
 * 신규 등록이 중복인가. 중복이면 `{ conflict, message }`, 아니면 null.
 * @param {Array} devices 등록부 전체
 * @param {{host:string,type:string}} input 정규화(trim)된 입력
 */
export function duplicateIssue(devices, { host, type } = {}) {
  const h = String(host ?? '');
  const t = String(type ?? '');
  if (!h || !t) return null;
  const hit = (devices || []).find((d) => d && d.host === h && d.type === t);
  if (!hit) return null;
  const conflict = conflictInfo(hit);
  return { conflict, message: duplicateMessage(conflict) };
}
