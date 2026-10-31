/**
 * VM 게스트 OS 문자열 → 'windows' | 'linux' | 'other' | null (v2.834 — Bareos 백업 대상 OS 구분).
 * 입력은 인벤토리 `vm.guestOS`(vCenter summary.config.guestFullName — 사람이 VM 에 설정한 OS 이고, 게스트 안에서 확인한 값이 아니다).
 * 비었거나 'unknown'(값이 없을 때 수집기가 넣는 글자 — vcenter/soapClient.js)은 null = 모름 — '기타' 로 세지 않는다(못 읽은 값은 0 이 아니다).
 * 판정은 서버 한 곳 — 웹은 결과 키만 받아 거르고 표시한다(bareosText.js OS_FILTERS).
 */
const LINUX = /linux|red hat|rhel|centos|ubuntu|debian|suse|sles|rocky|alma|photon|fedora|coreos/i;

export function osKind(guestOS) {
  if (typeof guestOS !== 'string') return null;
  const s = guestOS.slice(0, 200).trim();   // 정규식에 넣기 전에 길이를 자른다(외부 입력)
  if (!s || s.toLowerCase() === 'unknown') return null;
  if (/windows/i.test(s)) return 'windows';
  if (LINUX.test(s)) return 'linux';
  return 'other';
}

/** 응답에 싣는 OS 칸 — 분류와 원문(200자). 모르면 둘 다 null. */
export function osFields(vm) {
  const os = osKind(vm?.guestOS);
  return { os, guestOS: os ? vm.guestOS.slice(0, 200).trim() : null };
}
