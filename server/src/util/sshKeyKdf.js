/**
 * util/sshKeyKdf.js — OpenSSH 새 형식 개인키(openssh-key-v1)의 bcrypt KDF **반복 횟수(rounds)** 를 parseKey 전에 읽는다(순수 · 전체 점검 21회차 L-6).
 *
 * 왜: ssh2 의 parseKey 는 패스프레이즈가 있으면 키 안의 rounds(uint32 — 키를 만든 쪽이 정한다)만큼 bcrypt 를 **동기로** 돈다
 *   (실측 16 → 171ms · 64 → 686ms · 256 → 2.7초). rounds 100,000 키 한 장이면 이벤트 루프가 약 17분 멈춘다.
 *   ssh-keygen 기본은 16(-a 로 바꿈 · 흔한 강화값 64~100). 상한을 넘으면 파싱하지 않고 거절한다.
 * ⚠ util/ 규약: 도메인 모듈을 import 하지 않는다.
 */
export const SSH_KDF_ROUNDS_MAX = 128;

const BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const END = '-----END OPENSSH PRIVATE KEY-----';
const MAGIC = 'openssh-key-v1\0';
/** 머리(매직 · cipher · kdf · kdf 옵션)를 읽는 데 푸는 본문 앞부분 **base64 글자** 수 — 정상 키의 머리는 100바이트 남짓이다. */
const HEAD_CHARS = 64 * 1024;

/*
 * 113회차 R1(재현 — 실제 ssh2 · 108회차 A6 수정이 만든 회귀): 앞부분을 **글자 수**로 자르면, 디코더가 건너뛰는 글자(공백 · 줄바꿈 · '!' …)를
 *   본문 앞에 6만 5천 자 넘게 채운 키가 '빈 머리 = 새 형식이 아님' 으로 통과했다 — ssh2 는 그 글자를 건너뛰고 뒤의 진짜 머리를 읽어 rounds 만큼 돈다
 *   (rounds 256 · 채움 7만 자: 사전 검사 null · parseKey 3.4초. 108회차 전 판본은 글자를 지우고 풀어 이 입력을 거절했다).
 *   통합 계정 '키 검사'(POST /tools/credentials/inspect-key)는 길이 상한 없이 이 검사만 믿는다.
 *   자르는 자리를 **디코더가 글자로 세는 것** HEAD_CHARS 개째로 잡는다. Node 디코더는 앞에서부터 차례로 풀므로(받지 않는 글자는 건너뛰고 '=' 에서 멈춘다)
 *   그렇게 자른 앞부분을 푼 결과는 전체를 푼 결과의 앞부분과 같다.
 *   ⚠ 이 표는 Node 가 글자로 받는 것(A–Z a–z 0–9 + / 와 base64url 의 - _)의 **부분집합**이어야 한다 — 디코더가 건너뛰는 글자를 여기서 세면
 *     같은 우회가 다시 열린다(모자라게 세는 쪽은 더 길게 풀 뿐이라 안전하다). rebut113 이 채움 글자 0~255 · 그 밖 표본으로 대조한다.
 */
const isB64Char = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 45 || c === 95;
/** [from, to) 안에서 base64 글자 HEAD_CHARS 개가 들어가는 구간의 끝(그만큼 없으면 to). */
function headEnd(s, from, to) {
  if (to - from <= HEAD_CHARS) return to;
  let n = 0;
  for (let i = from; i < to; i++) if (isB64Char(s.charCodeAt(i)) && ++n >= HEAD_CHARS) return i + 1;
  return to;
}

/*
 * 108회차 A6(재현 — 실제 ssh2): 이 사전 검사가 ssh2 와 **다른 바이트**를 읽어 상한을 비켜 갈 수 있었다.
 *   ① 본문에서 `[^A-Za-z0-9+/=]` 를 지우고 풀었는데, ssh2 는 `Buffer.from(본문, 'base64')` 그대로다 — Node 는 base64url 글자('-' · '_')를
 *      '+' · '/' 로 **받는다**. salt 의 '++++' 를 '----' 로 바꾼 키는 여기서 3바이트가 빠진 채 읽혀 rounds 256 이 0 으로 보였고(통과),
 *      ssh2 는 원래 바이트 그대로 256 회를 돌았다(3.4초 — 65,536 이면 10분대).
 *   ② 본문이 64KB 를 넘거나 ③ END 표지가 본문 중간에 하나 더 있으면(ssh2 는 **마지막** END 까지 읽는다) '읽을 수 없음 = 검사 대상 아님' 으로 통과했다.
 *   이제 ssh2 와 같은 구간(첫 BEGIN 뒤 ~ 마지막 END 앞)을 **같은 함수로**(글자를 지우지 않고) 풀고, 머리만 보면 되므로 앞부분만 푼다.
 *   kdf 가 bcrypt 인데 옵션(salt · rounds)을 읽지 못하면 통과시키지 않는다 — 그런 키는 ssh2 도 Malformed 로 거절한다(정상 키는 영향 없음).
 * @returns {{kind:'none'}|{kind:'unreadable'}|{kind:'rounds', rounds:number}}
 */
function probeKdf(pem) {
  const s = String(pem ?? '');
  const a = s.indexOf(BEGIN);
  if (a < 0) return { kind: 'none' };
  const from = a + BEGIN.length;
  const b = s.lastIndexOf(END);
  if (b < from) return { kind: 'none' };
  let buf;
  try { buf = Buffer.from(s.slice(from, headEnd(s, from, b)), 'base64'); } catch { return { kind: 'none' }; }   // 113회차 R1: 글자 수가 아니라 base64 글자 수로 자른다
  if (buf.length < MAGIC.length || buf.toString('latin1', 0, MAGIC.length) !== MAGIC) return { kind: 'none' };
  let off = MAGIC.length;
  const str = () => { if (off + 4 > buf.length) return null; const n = buf.readUInt32BE(off); off += 4; if (off + n > buf.length) return null; const v = buf.subarray(off, off + n); off += n; return v; };
  const cipher = str(); const kdf = str();
  if (!cipher || !kdf) return { kind: 'none' };
  if (kdf.toString('latin1') !== 'bcrypt') return { kind: 'none' };
  const opts = str();
  if (!opts || opts.length < 8) return { kind: 'unreadable' };
  const saltLen = opts.readUInt32BE(0);
  if (4 + saltLen + 4 > opts.length) return { kind: 'unreadable' };
  return { kind: 'rounds', rounds: opts.readUInt32BE(4 + saltLen) };
}

/** PEM 문자열 → bcrypt rounds(수) · bcrypt 가 아니거나 새 형식이 아니면 null(검사 대상 아님) · 읽을 수 없으면 null. */
export function opensshKdfRounds(pem) {
  const p = probeKdf(pem);
  return p.kind === 'rounds' ? p.rounds : null;
}

/** 상한을 넘는 rounds 면 사람이 읽을 사유, 아니면 null. bcrypt 키인데 KDF 옵션을 읽지 못해도 사유를 준다(108회차 A6 — 모르는 rounds 로 돌리지 않는다). */
export function sshKdfRoundsIssue(pem) {
  const p = probeKdf(pem);
  if (p.kind === 'unreadable') return '개인키의 KDF 옵션(bcrypt salt · 반복 횟수)을 읽을 수 없습니다 — 형식이 깨졌거나 머리가 너무 큽니다. ssh-keygen -p -a 16 으로 다시 저장한 키를 쓰세요.';
  const r = p.kind === 'rounds' ? p.rounds : null;
  if (r == null || r <= SSH_KDF_ROUNDS_MAX) return null;
  return `개인키의 KDF 반복 횟수(${r})가 상한(${SSH_KDF_ROUNDS_MAX})보다 큽니다 — 처리에 오래 걸려 받지 않습니다. ssh-keygen -p -a 16(또는 64) 로 다시 암호화하세요.`;
}
