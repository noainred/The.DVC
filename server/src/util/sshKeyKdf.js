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
/** 머리(매직 · cipher · kdf · kdf 옵션)를 읽는 데 푸는 본문 앞부분 글자 수 — 정상 키의 머리는 100바이트 남짓이다. */
const HEAD_CHARS = 64 * 1024;

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
  try { buf = Buffer.from(s.slice(from, Math.min(b, from + HEAD_CHARS)), 'base64'); } catch { return { kind: 'none' }; }
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
