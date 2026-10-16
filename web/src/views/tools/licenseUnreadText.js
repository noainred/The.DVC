/**
 * v2.742(감사 VC-06) — vCenter 라이선스·확장 솔루션 목록을 **읽지 못한** vCenter 를 화면이 말한다(순수).
 *
 * 서버 판정은 `server/src/corelicense/analyze.js vcListUnread` 하나다 — 배열이면 읽은 것(빈 배열 = 보고 0개), 아니면 why 코드
 * (failed·unreachable·pending·maintenance·disabled·not-read)를 싣는다. 예전 화면은 못 읽은 vCenter 를 '라이선스 없음'·'확장 솔루션 정보 없음' 으로
 * 보였고, 라이선스 현황의 제품별 합계는 그 vCenter 를 뺀 **부분 합**인데 그 사실을 말하지 않았다.
 * 이 모듈은 판정을 다시 하지 않는다 — 서버가 준 why 를 문구로 바꿀 뿐이다(키 집합은 서버 LIST_UNREAD_TEXT 와 1:1 — 테스트 대조).
 * 비활성 vCenter 는 일부러 수집하지 않는 것이라 '부분 합 경고' 에 넣지 않고 따로 회색으로 말한다(서버 license-expiry 의 collectionErrors 와 같은 판단).
 * 문구에 백틱·별표를 쓰지 않는다(평문으로 그린다).
 */
export const UNREAD_WHY_LABEL = Object.freeze({
  failed: '조회 실패',
  unreachable: 'vCenter 연결 실패',
  pending: '첫 수집 전',
  maintenance: '점검중',
  disabled: '비활성',
  'not-read': '이 수집 경로가 목록을 싣지 않음(REST 폴백·구버전 엣지)',
});

const whyLabel = (why) => UNREAD_WHY_LABEL[why] || String(why || '사유 미상');
const NAME_MAX = 5;

/** 이름(사유) 목록 — 앞 5곳 + '외 N곳'. */
function namesText(list) {
  const shown = list.slice(0, NAME_MAX).map((u) => `${u.vcenterName || u.vcenterId}(${whyLabel(u.why)})`);
  const more = list.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` 외 ${more}곳` : ''}`;
}

const unreadList = (x) => (Array.isArray(x) ? x.filter((u) => u && typeof u === 'object') : []);

/**
 * 라이선스 사용 현황(/tools/licenses) — `unread`·`partial`.
 * @returns {{ partialNote: string|null, disabledNote: string|null }} 없으면 둘 다 null(빈 줄을 만들지 않는다)
 */
export function licensesUnreadNotes(data) {
  const all = unreadList(data?.unread);
  const off = all.filter((u) => u.why === 'disabled');
  const bad = all.filter((u) => u.why !== 'disabled');
  return {
    partialNote: bad.length
      ? `라이선스 목록을 읽지 못한 vCenter ${bad.length}곳 — ${namesText(bad)}. 그 vCenter 의 라이선스는 0개가 아니라 확인 불가이고, 제품별 합계와 아래 표는 그 vCenter 를 뺀 부분 합입니다.`
      : null,
    disabledNote: off.length ? `비활성 vCenter ${off.length}곳(${off.slice(0, NAME_MAX).map((u) => u.vcenterName || u.vcenterId).join(', ')}${off.length > NAME_MAX ? ` 외 ${off.length - NAME_MAX}곳` : ''})은 수집하지 않아 합계에 없습니다.` : null,
  };
}

/**
 * 솔루션 버전 카드(/tools/solutions 의 vCenter 항목)의 확장 목록 빈 칸 — 못 읽었으면 그 사실, 읽었는데 0개면 null(호출부가 '정보 없음' 을 그린다).
 * @returns {{ text: string, title: string }|null}
 */
export function solutionsUnreadCell(it) {
  const u = it?.solutionsUnread;
  if (!u || typeof u !== 'object') return null;
  const reason = u.text || whyLabel(u.why);
  const text = u.why === 'disabled' ? `확장 솔루션 목록 수집 안 함 — ${reason}` : `확장 솔루션 목록 확인 불가 — ${reason}`;
  return { text, title: typeof u.error === 'string' && u.error ? u.error : '' };
}

/** 솔루션 버전 화면 머리 안내 — 확장 목록을 읽지 못한 vCenter(비활성 제외) 수. 없으면 null. */
export function solutionsUnreadNote(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const bad = items.filter((it) => it?.solutionsUnread && it.solutionsUnread.why !== 'disabled');
  if (!bad.length) return null;
  return `확장 솔루션 목록을 읽지 못한 vCenter ${bad.length}곳은 '없음' 이 아니라 확인 불가입니다(각 카드에 사유).`;
}

/**
 * 라이선스 만료일(/tools/license-expiry) — 비활성 vCenter 만 따로 말한다. 그 밖의 못 읽은 vCenter 는 서버가 collectionErrors 에
 * 한 줄씩 넣어 '일부 수집 실패' 줄이 이미 말한다(같은 사실을 두 번 말하지 않는다).
 * @returns {string|null}
 */
export function expiryUnreadNote(data) {
  const off = unreadList(data?.vcenterLicensesUnread).filter((u) => u.why === 'disabled');
  if (!off.length) return null;
  return `비활성 vCenter ${off.length}곳(${off.slice(0, NAME_MAX).map((u) => u.vcenterName || u.vcenterId).join(', ')}${off.length > NAME_MAX ? ` 외 ${off.length - NAME_MAX}곳` : ''})은 라이선스를 수집하지 않아 이 목록에 없습니다.`;
}

/** 코어 라이선스 행의 licensesUnread(why) — 'vCenter 보고' 칸 문구. 읽었으면 null. */
export function coreLicenseUnreadText(why) {
  if (!why) return null;
  return why === 'disabled' ? '라이선스 목록 수집 안 함(비활성) · 비교 안 함' : `라이선스 목록 확인 불가(${whyLabel(why)}) · 비교 안 함`;
}
