/**
 * sshaccess/authorizedKeys.js — 서버의 `~/.ssh/authorized_keys` 를 **읽어 지문만** 뽑는다(v3.9.0 · 설계 docs/design/ssh-access §9 ‘서버에 들어 있는 키 읽기’).
 *
 *  · 서버에서 받은 글은 믿지 않는다 — 길이를 먼저 자르고(전체 MAX_BYTES · 줄 MAX_LINE · 줄 수 MAX_LINES), 정규식은 앵커 있는 선형 꼴만(외부 입력 ReDoS 규약).
 *  · 옵션(`from=` · `restrict` 등)은 따옴표를 존중해 건너뛴다. 키 본문은 ssh2 로 풀어 **지문**을 만든다(사람이 적은 종류를 믿지 않는다).
 *  · 설명(comment)은 사람 이름 · 호스트가 실리므로 화면에만(관리자 · 설정 소유자 등급 라우트) — 제어문자를 지우고 120자로 자른다.
 *  · 포탈이 넣은 줄은 설명 머리 `portal-ssh:` 로 안다(2단계 ‘키 로그인 설정’ 이 붙인다).
 * 원격 명령(읽기 전용 · 고정 문자열 — 사용자 입력이 들어가지 않는다): READ_COMMAND.
 */
import ssh2 from 'ssh2';
import { sshHostKeyFingerprint } from '../proxy/sshExec.js';
import { PORTAL_MARK } from './akScript.js';

export const MAX_BYTES = 256 * 1024;
export const MAX_LINE = 16 * 1024;
export const MAX_LINES = 400;
export { PORTAL_MARK };   // 표식 글자는 한 곳(akScript — 순수)에서만 정한다
/**
 * 읽기 명령 — 홈의 기본 경로만(AuthorizedKeysFile 이 다른 서버는 화면이 ‘읽은 파일’ 경로를 밝히고, 최종 판정은 실제 접속으로 한다).
 * 첫 줄에 파일 상태(없음 · 읽음)를 표지로 낸다 — 파일이 없는 것과 비어 있는 것을 가른다. 출력은 head -c 로 자른다.
 */
// 2회차 E2-3: 없음 · 못 읽음 · 일반 파일 아님을 가른다(예전에는 모르는 것을 ‘없음’ 으로, 못 읽는 파일을 ‘0줄’ 로 말했다). 앞 표지 한 줄 뒤에 내용.
export const READ_COMMAND = "f=\"$HOME/.ssh/authorized_keys\"; if [ -f \"$f\" ]; then if [ -r \"$f\" ]; then echo '##AK present'; head -c 262144 \"$f\"; else echo '##AK unreadable'; fi; elif [ -e \"$f\" ] || [ -L \"$f\" ]; then echo '##AK notfile'; else echo '##AK missing'; fi";

const KEY_TYPE_RE = /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,3}$/;

/** 옵션 칸을 건너뛴 나머지(따옴표 안 공백은 옵션의 일부). 순수 · 선형. */
function splitOptions(line) {
  let i = 0; let q = false;
  for (; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && q) { i += 1; continue; }
    if (ch === '"') q = !q;
    else if (!q && (ch === ' ' || ch === '\t')) break;
  }
  return { options: line.slice(0, i), rest: line.slice(i).trimStart() };
}
const cleanComment = (s) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').trim().slice(0, 120);

/**
 * @param {string} text  authorized_keys 내용(읽기 명령 출력에서 표지 줄을 뗀 것)
 * @returns {{keys:{fingerprint:string,type:string,comment:string,portal:boolean,hasOptions:boolean}[], bad:number, truncated:number}}
 */
export function parseAuthorizedKeys(text) {
  const src = String(text ?? '').slice(0, MAX_BYTES);
  const out = { keys: [], bad: 0, truncated: 0 };
  const lines = src.split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    let line = lines[n].replace(/\r$/, '');
    if (line.length > MAX_LINE) { out.bad += 1; continue; }
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (out.keys.length >= MAX_LINES) { out.truncated += 1; continue; }
    let parts = line.split(/[ \t]+/);
    if (!KEY_TYPE_RE.test(parts[0])) {
      const { rest } = splitOptions(line);
      parts = rest.split(/[ \t]+/);
      if (!KEY_TYPE_RE.test(parts[0] || '')) { out.bad += 1; continue; }
      parts.hasOptions = true;
    }
    const [type, b64, ...cm] = parts;
    if (!b64 || !B64_RE.test(b64)) { out.bad += 1; continue; }
    let fp = '';
    try {
      const k = ssh2.utils.parseKey(`${type} ${b64}`);
      const kk = Array.isArray(k) ? k[0] : k;
      if (kk && !(kk instanceof Error) && typeof kk.getPublicSSH === 'function') fp = sshHostKeyFingerprint(kk.getPublicSSH()) || '';
    } catch { fp = ''; }
    if (!fp) { out.bad += 1; continue; }
    const comment = cleanComment(cm.join(' '));
    out.keys.push({ fingerprint: fp, type, comment, portal: comment.startsWith(PORTAL_MARK), hasOptions: !!parts.hasOptions });
  }
  return out;
}

/** 읽기 명령 출력 → { present, keys … }. 표지가 없으면 읽지 못한 것. */
export function parseReadOutput(stdout) {
  const s = String(stdout ?? '');
  const nl = s.indexOf('\n');
  const head = (nl >= 0 ? s.slice(0, nl) : s).trim();
  if (head === '##AK missing') return { ok: true, present: false, keys: [], bad: 0, truncated: 0 };
  if (head === '##AK unreadable') return { ok: false, code: 'unreadable', reason: 'authorized_keys 가 있지만 이 계정으로 읽을 수 없습니다(권한).' };
  if (head === '##AK notfile') return { ok: false, code: 'notfile', reason: 'authorized_keys 가 일반 파일이 아니거나 따라갈 수 없는 링크입니다.' };
  if (head !== '##AK present') return { ok: false, reason: '읽기 명령의 출력이 예상과 다릅니다(셸이 다르거나 로그인 메시지가 섞임).' };
  return { ok: true, present: true, ...parseAuthorizedKeys(nl >= 0 ? s.slice(nl + 1) : '') };
}
