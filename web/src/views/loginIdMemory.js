// 로그인 ID 기억 — 마지막으로 **로그인에 성공한** ID 를 브라우저(localStorage)에 남겨
// 다음 접속 때 ID 칸을 미리 채운다. 비밀번호·OTP 는 절대 저장하지 않는다(ID 만).
// 저장소 접근은 사생활 보호 모드·차단 정책에서 예외를 던질 수 있으므로 전부 try/catch —
// 실패하면 '기억 없음' 과 같게 동작한다(로그인 자체는 막지 않는다).

export const LOGIN_ID_KEY = 'dvc.loginId';
const MAX_LEN = 128;

/** 저장·복원 공통 정제 — 앞뒤 공백 제거, 제어문자가 섞였거나 비었거나 너무 길면 버린다. */
export function cleanLoginId(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > MAX_LEN) return '';
  if (/[\u0000-\u001f\u007f]/.test(s)) return '';
  return s;
}

function store(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** 기억해 둔 ID(없거나 못 읽으면 ''). */
export function loadLoginId(storage) {
  try { return cleanLoginId(store(storage)?.getItem(LOGIN_ID_KEY)); } catch { return ''; }
}

/** 로그인 성공 직후 호출 — 정제 결과가 비면 저장하지 않는다. */
export function saveLoginId(id, storage) {
  const s = cleanLoginId(id);
  if (!s) return false;
  try { store(storage)?.setItem(LOGIN_ID_KEY, s); return true; } catch { return false; }
}
