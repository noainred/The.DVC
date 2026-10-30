/**
 * bareos/edgeSetup.js — **엣지에서** 대행하는 자동 설정 단계(v2.824 · 사용자 결정 '입력한 SSH·vCenter 비밀번호를 그 작업에만 실어 엣지로 1회 전달').
 *
 * 중앙 라우트가 권한·OTP·입력 판정을 먼저 하고(bareosBackup.js setupGate), 작업에는 비밀이 아닌 입력(args.body)과 그 단계에 필요한
 * 중앙 값(공통 기본값·매핑 한 줄)만 싣는다. 비밀(SSH·vCenter·새 콘솔 비밀번호)은 secretArgs 로 따로 와서 이 실행에만 쓰인다.
 * Director 접속값은 이 엣지의 사본(bareos/edgeStore.js)에서 — 중앙 값을 믿지 않는다. autoSetup.js 는 같은 코드(ctx 로 값만 바꾼다)라
 * 쓰기 전 살피기·MARKER·되돌리기·root 만·화이트리스트 규칙이 그대로다.
 * 2단계(Director 리소스)가 새 콘솔로 접속에 성공하면 이 엣지 사본을 그 콘솔로 바로 바꾼다(다음 배정 인출 전 작업이 옛 비밀번호로 실패하지 않게).
 * 중앙은 회신 ok 를 받고 그 값으로 저장한다(저장이 실패하면 사실대로 알린다 — 재실행하면 MARKER 파일을 덮는다).
 */
import { preflight, setupDirector, setupFdPlugin, setupFdIni, readFdThumbprint } from './autoSetup.js';
import { updateEdgeDirectorConn } from './edgeStore.js';
import { bareosAuthGuard } from './service.js';
import { directorCred } from './settings.js';

export const SETUP_KINDS = new Set(['setup.preflight', 'setup.director', 'setup.fdPlugin', 'setup.fdIni', 'setup.thumbprint']);

/** 비밀이 아닌 입력만(중앙이 보낸 body) — 모르는 키는 버린다. */
const BODY_KEYS = ['host', 'sshPort', 'username', 'directorPort', 'consoleName', 'restoreClient', 'restoreStorage', 'restorePool', 'pools', 'schedule', 'vcenterId', 'vcuser', 'vcthumbprint'];
function bodyOf(args) {
  const src = args?.body && typeof args.body === 'object' ? args.body : {};
  return Object.fromEntries(BODY_KEYS.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
}

/**
 * @param {string} kind SETUP_KINDS
 * @param {object} dir 이 엣지 사본의 Director(접속값 포함)
 * @param {{ body?, defaults?, site? }} args
 * @param {{ password?, vcpass?, consolePassword? }} secretArgs
 */
export async function runSetupOp(kind, dir, args = {}, secretArgs = {}) {
  const b = { ...bodyOf(args), directorId: dir.id, password: String(secretArgs.password ?? '') };
  const site = args?.site && typeof args.site === 'object' ? { ...args.site, directorId: dir.id } : null;
  switch (kind) {
    case 'setup.preflight': return preflight(b, { dir });
    case 'setup.thumbprint': return readFdThumbprint(b, { site });
    case 'setup.fdIni': return setupFdIni({ ...b, vcpass: String(secretArgs.vcpass ?? '') }, { site });
    case 'setup.fdPlugin': return setupFdPlugin(b, { dir });
    case 'setup.director': {
      const defaults = args?.defaults && typeof args.defaults === 'object' ? args.defaults : {};
      return setupDirector(b, {
        dir, cur: { directors: [dir], defaults }, consolePassword: secretArgs.consolePassword,
        save: (conn) => {
          if (!updateEdgeDirectorConn(dir.id, conn)) throw Object.assign(new Error('엣지 사본을 갱신하지 못했습니다.'), { code: 'save' });
          return { director: null, droppedSecrets: [] };
        },
        clearAuthStop: () => { try { bareosAuthGuard.clearAuthStop(directorCred(dir).id); } catch { /* */ } },
      });
    }
    default: throw Object.assign(new Error(`알 수 없는 자동 설정 단계(${kind})`), { code: 'invalid' });
  }
}
