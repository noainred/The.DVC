/**
 * 테스트용 — 받은 메일 원문에서 제목을 꺼낸다(RFC 5322 헤더 펴기 + RFC 2047 encoded-word 해석). 가짜 SMTP 를 쓰는 테스트 5곳이 같은 두 줄을
 * 복사해 쓰고 있었는데 **첫 줄만** 읽었다 — v3.10.4 에 util/smtp.js 가 긴 제목을 75자 이하 encoded-word 여러 개로 접자(RFC 2047 §2)
 * 그 복사본들이 제목 뒷부분을 잃었다. 코어는 하나다.
 */
export function decodeSubject(raw) {
  const head = String(raw ?? '').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');   // 헤더 펴기
  const m = /^Subject: (.*)$/mi.exec(head);
  if (!m) return '';
  return m[1]
    .replace(/(\?=)\s+(=\?)/g, '$1$2')                                                      // 이웃한 encoded-word 사이 공백은 지운다(RFC 2047 §6.2)
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_x, b) => Buffer.from(b, 'base64').toString('utf8'));
}
