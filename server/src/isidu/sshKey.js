/**
 * isidu/sshKey.js — 아이실론 접속용 SSH 키(비밀번호 없는 접속, v2.736).
 *
 * v2.976: 판정 본체는 `util/sshKeyStore.js` 공장으로 옮겼다(집중 모니터링이 같은 규칙을 쓴다 — 두 벌 금지). 이 파일은 그 공장을
 * `isidu_key` 로 부르는 껍데기이고 내보내는 이름 · 동작은 예전 그대로다.
 *
 * 사용자 요청: "서버에서 ssh password-less 방식으로 접속하는 방식이야".
 *
 * ── 키를 어디서 읽는가 ─────────────────────────────────────────────────────────
 *  포탈 서비스는 `ProtectHome=true` · `--no-create-home` 계정(vmportal)으로 돈다(packaging/offline/vmware-portal.service) —
 *  `~/.ssh` 는 **없거나 읽을 수 없다**. 그래서 키는 CONFIG_DIR 아래에 둔다. 찾는 순서:
 *    ① env `ISIDU_SSH_KEY`(절대 경로 — 호스트에서만 정한다. 화면·API 로 경로를 받지 않는다: 아무 파일이나 키로 읽게 하지 않으려고)
 *    ② `<CONFIG_DIR>/ssh/isidu_key`(이 모듈이 만든 키)
 *    ③ `<CONFIG_DIR>/ssh/id_ed25519` · `id_ecdsa` · `id_rsa`(관리자가 기존 키를 복사해 둔 경우)
 *  키가 하나도 없으면 `ensureKey()` 가 **ECDSA P-256 키를 새로 만든다**(Node crypto SEC1 PEM — ssh2 가 확실히 읽는 형식.
 *  ⚠ `ssh2.utils.generateKeyPairSync('ed25519')` 는 자기 파서가 거부하는 키를 0.52% 만든다 — CLAUDE.md v2.590 기록).
 *  새로 만든 키의 **공개키**를 화면이 보여 주고, 관리자가 아이실론 계정의 authorized_keys 에 넣는다.
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────
 *  · 개인키는 어떤 응답에도 싣지 않는다 — 공개키·지문·종류만. 파일은 0600, 디렉터리는 0700, 이미 있으면 **덮어쓰지 않는다**(`wx`).
 *  · 암호가 걸린 키는 쓰지 않는다(비밀번호 없는 접속이 목적이다) — 그 사실을 상태로 말한다.
 *  · 키 파일은 백업 번들에 들어가지 않는다(백업은 .json/.env 만 — 서버 불변조건). 잃으면 새로 만들고 다시 등록해야 한다(화면이 말한다).
 */
import { createSshKeyStore, sshKeyDir } from '../util/sshKeyStore.js';

const store = createSshKeyStore({
  name: 'isidu_key', envVar: 'ISIDU_SSH_KEY', comment: 'vmware-portal-isidu', tag: '[isidu]',
  purpose: '아이실론 접속용', where: '아이실론 계정의 authorized_keys',
});

export const KEY_FILE_NAME = store.KEY_FILE_NAME;
export const keyDir = sshKeyDir;
/** 후보 경로(순서대로) — [{path, source}] */
export const keyCandidates = store.keyCandidates;
/** 지금 쓸 키의 정보(공개 정보만). 후보가 없으면 { present:false }. */
export const keyInfo = store.keyInfo;
/** 접속에 쓸 개인키(PEM 버퍼). 없거나 쓸 수 없으면 null — 사유는 keyInfo().error. */
export const privateKeyForConnect = store.privateKeyForConnect;
/** 키가 없으면 만든다(있으면 아무것도 하지 않는다). 쓸 수 없는 키가 있으면 덮어쓰지 않고 그 사실을 돌려준다. */
export const ensureKey = store.ensureKey;
/** 공개 정보만(화면·push 용). 경로는 파일 이름만. */
export const publicKeyView = store.publicKeyView;

export function _resetKeyCacheForTest() { store.resetCache(); }
