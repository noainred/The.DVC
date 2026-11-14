/**
 * sshaccess/check.js — **키 점검**(v3.9.0 · 설계 docs/design/ssh-access §8 · 시안 SshSec ‘키 점검’).
 *
 * 항목(법인마다 · 전 법인 합): 개인키 암호화 저장(평문 정책 · 평문으로 남은 값) · 저장소 파일 권한 · 키 바꿔치기(저장 원문 지문 ≠ 등록 지문) ·
 *   폴더 미지정 · 허용 기능 미지정 · 키 나이(회전 예정일 · 만든 지 ROTATE_DAYS 일) · 승인 안 된 키 파일 · 받는 곳 파일 권한 · 법인 사용 중지.
 * 판정 등급: 'bad'(지금 위험 — 바꿔치기 · 평문 저장) · 'warn'(손볼 것) · 'ok'. 못 읽은 항목은 'unknown'(0 으로 세지 않는다).
 *
 * 바꿔치기: 디스크 ↔ 메모리 대조(checkKeyDrift — 키를 풀지 않는다) + 첫 사용 때 원문 ↔ 지문 대조(refs). 결과는 `keyStore` 의 표지로 접속 판정에 반영된다.
 */
import * as KS from '../bmusage/onboard/keyStore.js';
import { listStops, stateLoadError } from './state.js';

export const ROTATE_DAYS = 180;
const DAY = 86_400_000;
const t = (v, max = 128) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();

/**
 * 키 저장소 파일이 포탈 밖에서 바뀌었는가(디스크 ↔ 메모리 — keyStore.diskDrift). 키를 다시 풀지 않는다(빠르다 — 점검 D-1:
 * 예전에는 키마다 원문을 다시 풀어 passphrase 키 200개면 47초가 걸렸고, 메모리끼리 대조해 실행 중 디스크 변경을 보지도 못했다).
 * 원문 ↔ 지문 대조는 첫 사용 때 refs.integrityOk 가 한다.
 * @returns {{at:number, ok:boolean, changed:string[], added:object[], removed:string[], reason?:string}}
 */
export function checkKeyDrift({ now = Date.now() } = {}) {
  return { at: now, ...KS.diskDrift() };
}

/**
 * 키 점검 결과(화면 · 주기 사건 공용). 비밀 없음.
 * @param {{now?:number, policyMode?:string, inbox?:{items:object[], exists:boolean, unknownFolders:string[]}|null, integrity?:object|null,
 *          corpName?:(id:string)=>string}} o
 */
export function buildKeyCheck({ now = Date.now(), policyMode = '', inbox = null, drift = null, servers = null, corpName = (x) => x, guards = null, pendingApprovals = null } = {}) {
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
  // ③ 바꿔치기 — 디스크 ↔ 메모리(drift) + 첫 사용 대조 표지(tampered)
  const tampered = KS.tamperedKeyIds();
  if (drift && !drift.ok) add('unknown', 'drift-unknown', '키 저장소 파일 대조', `디스크 파일을 읽지 못해 대조하지 못했습니다(${String(drift.reason || '').slice(0, 60)}).`);
  if (drift?.changed?.length || tampered.length) add('bad', 'tampered', `포탈 밖에서 바뀐 키 ${new Set([...(drift?.changed || []), ...tampered]).size}개`, '그 키로는 접속하지 않습니다 — 누가 바꿨는지 확인한 뒤 키를 새로 등록하거나, 바뀐 내용이 맞으면 ‘키 저장소 다시 읽기’ 로 받아들이세요.', { keys: [...new Set([...(drift?.changed || []), ...tampered])].slice(0, 50) });
  if (drift?.removed?.length) add('bad', 'removed-outside', `포탈 밖에서 파일에서 빠진 키 ${drift.removed.length}개`, '포탈은 아직 메모리의 키를 쓰지만 재시작하면 사라집니다 — 누가 지웠는지 확인하세요(맞으면 ‘키 저장소 다시 읽기’).', { keys: drift.removed.slice(0, 50) });
  if (drift?.accountsChanged?.length) add('bad', 'account-changed-outside', `포탈 밖에서 바뀐 공통 계정 ${drift.accountsChanged.length}개`, '그 계정으로는 접속하지 않습니다 — 누가 바꿨는지 확인한 뒤 ‘키 저장소 다시 읽기’ 로 받아들이거나 파일을 되돌리세요.', { keys: drift.accountsChanged.slice(0, 50) });
  if (drift?.added?.length) add('bad', 'added-outside', `포탈 밖에서 들어온 키 ${drift.added.length}개`, '키 저장소 파일에 포탈이 넣지 않은 키가 있습니다 — 재시작하면 쓰이게 됩니다. 모르는 키면 파일에서 지우고, 맞는 키면 ‘키 저장소 다시 읽기’ 로 받아들이세요.', { keys: drift.added.map((k) => k.name).slice(0, 50) });
  if (drift?.ok && !drift.changed.length && !drift.added.length && !drift.removed.length && !(drift.accountsChanged || []).length && !tampered.length) add('ok', 'integrity', '키 저장소 파일 대조', '디스크 파일이 포탈이 마지막으로 쓴 내용과 같습니다.');
  else if (!drift) add('unknown', 'integrity-pending', '키 저장소 파일 대조', '아직 대조하지 않았습니다.');
  // ④ 폴더 · 허용 기능
  const noFolder = keys.filter((k) => !k.folderCorp);
  if (noFolder.length) add('warn', 'no-folder', `폴더가 없는 키 ${noFolder.length}개`, '어느 법인 서버에든 쓰일 수 있습니다 — 키 폴더에서 법인(공통/서버별)을 정하세요.', { keys: noFolder.map((k) => k.id).slice(0, 50) });
  const noFeat = keys.filter((k) => !Array.isArray(k.features));
  if (noFeat.length) add('warn', 'no-features', `허용 기능을 정하지 않은 키 ${noFeat.length}개`, '모든 기능이 이 키로 접속할 수 있습니다 — 쓸 기능만 고르세요.', { keys: noFeat.map((k) => k.id).slice(0, 50) });
  // ⑤ 나이
  const old = keys.filter((k) => (k.rotateAt && k.rotateAt <= now) || (!k.rotateAt && k.createdAt && now - k.createdAt >= ROTATE_DAYS * DAY));
  if (old.length) add('warn', 'rotate-due', `교체할 때가 된 키 ${old.length}개`, `회전 예정일이 지났거나 만든 지 ${ROTATE_DAYS}일이 넘었습니다.`, { keys: old.map((k) => k.id).slice(0, 50) });
  // 만든 시각 · 회전 예정일이 둘 다 없는 키는 나이를 모른다 — ‘기준 안’ 으로 세지 않는다(반증 지적).
  const ageUnknown = keys.filter((k) => !k.rotateAt && !k.createdAt);
  if (ageUnknown.length) add('unknown', 'age-unknown', `나이를 모르는 키 ${ageUnknown.length}개`, '만든 시각 · 회전 예정일이 기록돼 있지 않습니다 — 회전 예정일을 정하세요.', { keys: ageUnknown.map((k) => k.id).slice(0, 50) });
  if (!old.length && keys.length > ageUnknown.length) add('ok', 'age', '키 나이', `교체 기준(${ROTATE_DAYS}일 · 회전 예정일) 안입니다${ageUnknown.length ? '(나이를 모르는 키 제외)' : ''}.`);
  // ⑤-2 서버 쪽(점검 B-1 · B-4) — 폴더 · 기능 때문에 접속하지 못하는 서버 · 법인 칸이 없어 사용 중지가 닿지 않는 서버(service 가 계산해 넘긴다)
  if (servers) {
    if (servers.blocked?.length) add('warn', 'placement-blocked', `키 폴더 · 기능 때문에 키로 접속하지 못하는 서버 ${servers.blocked.length}대`, '서버의 키를 이 서버 폴더 · 법인 공통 폴더의 키로 고르거나 키의 기능을 더하세요(수집이 이 사유로 실패합니다).', { files: servers.blocked.slice(0, 50) });
    if (servers.unrestricted?.length) add('warn', 'restrict-missing', `키 줄에 서버 쪽 제한이 없는 서버 ${servers.unrestricted.length}대`, '서버의 authorized_keys 에서 읽은 그 키 줄에 출발지 제한 · 포워딩 금지가 없습니다 — ‘키 로그인 설정’ 으로 다시 넣으면 제한이 붙습니다(마지막으로 읽은 내용 기준).', { files: servers.unrestricted.slice(0, 50) });
    if (servers.noCorp?.length) add('warn', 'no-corp-key', `법인이 지정되지 않았는데 키로 접속하는 서버 ${servers.noCorp.length}대`, '법인 키 사용 중지가 이 서버에는 닿지 않습니다(법인을 모른다) — 서버 등록에서 법인(vCenter)을 지정하세요.', { files: servers.noCorp.slice(0, 50) });
  }
  // ⑥ 받는 곳
  if (inbox) {
    const pend = (inbox.items || []).filter((x) => x.code === 'ready' || x.needPassphrase);
    if (pend.length) add('warn', 'inbox-pending', `승인 안 된 키 파일 ${pend.length}개`, '폴더에 직접 넣은 키입니다 — 승인하기 전에는 쓰지 않습니다. 승인하거나 지우세요(평문 파일이 디스크에 남아 있습니다).', { files: pend.map((x) => x.relPath).slice(0, 50) });
    const looseFiles = (inbox.items || []).filter((x) => x.loosePerm);
    if (looseFiles.length) add('warn', 'inbox-perm', `다른 계정이 읽을 수 있는 키 파일 ${looseFiles.length}개`, '받는 곳의 파일은 0600 이어야 합니다.', { files: looseFiles.map((x) => x.relPath).slice(0, 50) });
    if (inbox.unknownFolders?.length) add('warn', 'inbox-unknown', `법인 · 서버를 모르는 폴더 ${inbox.unknownFolders.length}개`, '폴더 이름이 지금 있는 법인 · 서버와 맞지 않아 읽지 않았습니다.', { files: inbox.unknownFolders.slice(0, 50) });
  }
  // ⑥-2 보호 장치 · 승인 대기(v3.10.0)
  if (guards && !guards.unreadable) {
    if (!guards.twoPerson) add('warn', 'two-person-off', '두 사람 승인이 꺼져 있음', '키 등록 · 교체 · 삭제 · 사용 재개가 본인 OTP 만으로 실행됩니다 — 설정 소유자가 둘 이상이면 켜 두세요.');
    if (!guards.serverRestrict) add('warn', 'restrict-off', '서버 쪽 제한이 꺼져 있음', '서버에 넣는 키 줄에 출발지 제한 · 포워딩 금지를 붙이지 않습니다 — 키가 새면 다른 곳에서도 쓸 수 있습니다.');
  }
  if (pendingApprovals) add('warn', 'approvals-pending', `승인을 기다리는 요청 ${pendingApprovals}건`, '다른 설정 소유자가 승인해야 실행됩니다 — 24시간이 지나면 사라집니다.');
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
