/**
 * sshaccess/check.js — **키 점검**(v3.9.0 · 설계 docs/design/ssh-access §8 · 시안 SshSec ‘키 점검’).
 *
 * 항목(법인마다 · 전 법인 합): 개인키 암호화 저장(평문 정책 · 평문으로 남은 값) · 저장소 파일 권한 · 키 바꿔치기(저장 원문 지문 ≠ 등록 지문) ·
 *   폴더 미지정 · 허용 기능 미지정 · 키 나이(회전 예정일 · 만든 지 ROTATE_DAYS 일) · 승인 안 된 키 파일 · 받는 곳 파일 권한 · 법인 사용 중지.
 * 판정 등급: 'bad'(지금 위험 — 바꿔치기 · 평문 저장) · 'warn'(손볼 것) · 'ok'. 못 읽은 항목은 'unknown'(0 으로 세지 않는다).
 *
 * 성능: 무결성 확인은 키를 하나씩 다시 풀어야 한다(passphrase 키는 OpenSSH bcrypt — 키당 ~175ms 동기). 키 사이마다 setImmediate 로 이벤트 루프에
 *   양보한다(키 하나의 풀기 자체는 나눌 수 없다 — 키 200개 상한). 주기 점검(10분)에서만 돌고 화면 조회는 마지막 결과를 쓴다.
 *   결과(바꿔치기 표지)는 `keyStore.markKeyIntegrity` 로 접속 판정에 반영된다.
 */
import { parsePrivateKey } from '../bmusage/onboard/keyParse.js';
import * as KS from '../bmusage/onboard/keyStore.js';
import { listStops, stateLoadError } from './state.js';

export const ROTATE_DAYS = 180;
const DAY = 86_400_000;
const t = (v, max = 128) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const tick = () => new Promise((r) => setImmediate(r));

/**
 * 저장된 키 원문을 다시 풀어 지문을 대조한다(비동기 — 키 사이 양보). 바뀐 키는 접속에 쓰지 않게 표지한다.
 * @returns {Promise<{checked:number, mismatch:string[], unreadable:string[]}>}
 */
export async function verifyKeyIntegrity() {
  const out = { checked: 0, mismatch: [], unreadable: [] };
  if (KS.keyStoreLoadError()) return out;
  for (const k of KS.listKeysRaw()) {
    if (k.status !== 'active') continue;
    await tick();
    if (!k.privateKey) { out.unreadable.push(k.id); continue; }   // 봉인을 못 풀었다 — 접속 판정이 이미 key-unreadable 로 막는다
    const p = parsePrivateKey(k.privateKey, k.passphrase || '');
    out.checked += 1;
    const ok = p.ok && p.fingerprint === k.fingerprint;
    KS.markKeyIntegrity(k.id, ok);
    if (!ok) out.mismatch.push(k.id);
  }
  return out;
}

/**
 * 키 점검 결과(화면 · 주기 사건 공용). 비밀 없음.
 * @param {{now?:number, policyMode?:string, inbox?:{items:object[], exists:boolean, unknownFolders:string[]}|null, integrity?:object|null,
 *          corpName?:(id:string)=>string}} o
 */
export function buildKeyCheck({ now = Date.now(), policyMode = '', inbox = null, integrity = null, corpName = (x) => x } = {}) {
  const items = [];
  const add = (level, code, title, detail, extra = {}) => items.push({ level, code, title, detail, ...extra });
  const storeErr = KS.keyStoreLoadError();
  if (storeErr) {
    add('unknown', 'store-unreadable', 'SSH 키 저장소를 읽지 못함', '손상 보존본을 확인하세요 — 그동안 키로 접속하지 않습니다.');
    return { at: now, items, summary: summarize(items) };
  }
  const keys = KS.listKeysRaw().filter((k) => k.status === 'active');
  // ① 암호화 저장
  const plainIds = KS.plainStoredKeyIds();
  if (policyMode !== 'encrypted') add('bad', 'policy-plain', '자격증명 저장 방식이 평문', '새 로그인 키를 받지 않습니다. 설정 › 보안 › 자격증명 저장 방식에서 암호화로 바꾸면 저장된 키도 함께 암호화됩니다.');
  if (plainIds == null) add('unknown', 'plain-unknown', '개인키 저장 형식을 확인하지 못함', '저장소 파일을 읽지 못했습니다.');
  else if (plainIds.length) add('bad', 'plain-stored', `평문으로 저장된 키 ${plainIds.length}개`, '디스크에 개인키가 그대로 있습니다 — 저장 방식을 암호화로 바꾸세요.', { keys: plainIds.slice(0, 50) });
  else if (keys.length) add('ok', 'encrypted', '개인키 암호화 저장', `키 ${keys.length}개 모두 암호화돼 있습니다.`);
  // ② 파일 권한
  const loose = KS.keyStoreLoosePerm();
  if (loose == null) add('unknown', 'perm-unknown', '저장소 파일 권한을 확인하지 못함', '');
  else if (loose) add('bad', 'perm-loose', '저장소 파일을 다른 계정이 읽을 수 있음', 'ssh-keys.json 권한을 0600 으로 바꾸세요(포탈은 0600 으로 씁니다 — 누군가 바꿨습니다).');
  // ③ 바꿔치기
  if (integrity) {
    if (integrity.mismatch?.length) add('bad', 'tampered', `지문이 등록 때와 다른 키 ${integrity.mismatch.length}개`, '바꿔치기 의심 — 그 키로는 접속하지 않습니다. 키를 지우고 새로 등록하세요.', { keys: integrity.mismatch.slice(0, 50) });
    else if (integrity.checked) add('ok', 'integrity', '키 바꿔치기 감시', `키 ${integrity.checked}개의 지문이 등록 때와 같습니다.`);
  } else add('unknown', 'integrity-pending', '키 바꿔치기 감시', '아직 확인하지 않았습니다(기동 직후 · 주기마다 확인합니다).');
  // ④ 폴더 · 허용 기능
  const noFolder = keys.filter((k) => !k.folderCorp);
  if (noFolder.length) add('warn', 'no-folder', `폴더가 없는 키 ${noFolder.length}개`, '어느 법인 서버에든 쓰일 수 있습니다 — 키 폴더에서 법인(공통/서버별)을 정하세요.', { keys: noFolder.map((k) => k.id).slice(0, 50) });
  const noFeat = keys.filter((k) => !Array.isArray(k.features));
  if (noFeat.length) add('warn', 'no-features', `허용 기능을 정하지 않은 키 ${noFeat.length}개`, '모든 기능이 이 키로 접속할 수 있습니다 — 쓸 기능만 고르세요.', { keys: noFeat.map((k) => k.id).slice(0, 50) });
  // ⑤ 나이
  const old = keys.filter((k) => (k.rotateAt && k.rotateAt <= now) || (!k.rotateAt && k.createdAt && now - k.createdAt >= ROTATE_DAYS * DAY));
  if (old.length) add('warn', 'rotate-due', `교체할 때가 된 키 ${old.length}개`, `회전 예정일이 지났거나 만든 지 ${ROTATE_DAYS}일이 넘었습니다.`, { keys: old.map((k) => k.id).slice(0, 50) });
  else if (keys.length) add('ok', 'age', '키 나이', `교체 기준(${ROTATE_DAYS}일 · 회전 예정일) 안입니다.`);
  // ⑥ 받는 곳
  if (inbox) {
    const pend = (inbox.items || []).filter((x) => x.code === 'ready' || x.needPassphrase);
    if (pend.length) add('warn', 'inbox-pending', `승인 안 된 키 파일 ${pend.length}개`, '폴더에 직접 넣은 키입니다 — 승인하기 전에는 쓰지 않습니다. 승인하거나 지우세요(평문 파일이 디스크에 남아 있습니다).', { files: pend.map((x) => x.relPath).slice(0, 50) });
    const looseFiles = (inbox.items || []).filter((x) => x.loosePerm);
    if (looseFiles.length) add('warn', 'inbox-perm', `다른 계정이 읽을 수 있는 키 파일 ${looseFiles.length}개`, '받는 곳의 파일은 0600 이어야 합니다.', { files: looseFiles.map((x) => x.relPath).slice(0, 50) });
    if (inbox.unknownFolders?.length) add('warn', 'inbox-unknown', `법인 · 서버를 모르는 폴더 ${inbox.unknownFolders.length}개`, '폴더 이름이 지금 있는 법인 · 서버와 맞지 않아 읽지 않았습니다.', { files: inbox.unknownFolders.slice(0, 50) });
  }
  // ⑦ 사용 중지
  if (stateLoadError()) add('bad', 'state-unreadable', 'SSH 공용 접속 상태 파일을 읽지 못함', '사용 중지 기록을 모르므로 모든 키 접속을 멈췄습니다.');
  else for (const s of listStops()) add('bad', 'corp-stopped', `${corpName(s.corp)} — 키 사용 중지 중`, `${t(s.by, 64) || '—'} · ${new Date(s.at || now).toISOString().slice(0, 16).replace('T', ' ')} UTC${s.reason ? ` · ${t(s.reason, 200)}` : ''}`, { corp: s.corp });
  return { at: now, items, summary: summarize(items) };
}

function summarize(items) {
  const c = { bad: 0, warn: 0, ok: 0, unknown: 0 };
  for (const i of items) c[i.level] = (c[i.level] || 0) + 1;
  return c;
}
