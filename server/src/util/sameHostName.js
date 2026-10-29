/**
 * util/sameHostName.js — 두 호스트 이름이 같은 장비를 가리키는가(v2.777 — 사용자 요청 '엣지에서 보고하는 호스트네임을 기록해서 검증').
 * 대소문자 무시 · 끝 점 무시 · 한쪽만 FQDN 이면 첫 마디(짧은 이름)로 비교한다(os.hostname() 이 배포판마다 짧은 이름·FQDN 으로 갈린다).
 * 빈 값은 판정하지 않는다(null) — '모름' 을 '다름' 으로 읽지 않는다.
 * @returns {boolean|null}
 */
export function sameHostName(a, b) {
  // 끝 점은 반복문으로 벗긴다(외부 입력에 /\.+$/ 금지 — 루트 CLAUDE.md 정규식 규칙). 길이를 먼저 자른다(DNS 이름 상한 253).
  const norm = (v) => {
    if (typeof v !== 'string') return '';
    const t = v.slice(0, 256).trim().toLowerCase();
    let e = t.length;
    while (e > 0 && t[e - 1] === '.') e--;
    return t.slice(0, e);
  };
  const x = norm(a); const y = norm(b);
  if (!x || !y) return null;
  if (x === y) return true;
  if (x.includes('.') && y.includes('.')) return false;   // 둘 다 FQDN 인데 다르면 다른 장비
  return x.split('.')[0] === y.split('.')[0];
}
