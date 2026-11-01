/**
 * bareos/edgeSetup.js — **엣지에서** 대행하는 자동 설정 단계(v2.824 · 사용자 결정 '입력한 SSH·vCenter 비밀번호를 그 작업에만 실어 엣지로 1회 전달').
 *
 * 중앙 라우트가 권한·OTP·입력 판정을 먼저 하고(bareosBackup.js setupGate), 작업에는 비밀이 아닌 입력(args.body)과 그 단계에 필요한
 * 중앙 값(공통 기본값·매핑 한 줄)만 싣는다. 비밀(SSH·vCenter·새 콘솔 비밀번호)은 secretArgs 로 따로 와서 이 실행에만 쓰인다.
 * Director 접속값은 이 엣지의 사본(bareos/edgeStore.js)에서 — 중앙 값을 믿지 않는다. autoSetup.js 는 같은 코드(ctx 로 값만 바꾼다)라
 * 쓰기 전 살피기·MARKER·되돌리기·root 만·화이트리스트 규칙이 그대로다.
 * 2단계(Director 리소스)가 새 콘솔로 접속에 성공하면 이 엣지 사본을 그 콘솔로 바로 바꾼다(다음 배정 인출 전 작업이 옛 비밀번호로 실패하지 않게).
 * 중앙은 회신 ok 를 받고 그 값으로 저장한다(중앙은 보내기 전에 저장이 될지 먼저 본다 — checkDirectorUpdate · 그래도 실패하면 사실대로 알린다).
 * 엣지 시한(작업 ttl — signal)은 본 작업 SSH 세션에 걸리고, 2단계는 시한이 지난 뒤에는 사본을 바꾸지 않고 되돌린다(v2.824 검토 P3·S3b —
 * 중앙이 '결과 모름' 으로 손을 뗀 뒤 엣지만 새 비밀번호가 되는 어긋남을 막는다).
 */
import { preflight, setupDirector, setupFdPlugin, setupFdIni, readFdThumbprint } from './autoSetup.js';
import { planManage, applyManage } from './manage/apply.js';
import { updateEdgeDirectorConn } from './edgeStore.js';
import { bareosAuthGuard } from './service.js';
import { directorCred } from './settings.js';

export const SETUP_KINDS = new Set(['setup.preflight', 'setup.director', 'setup.fdPlugin', 'setup.fdIni', 'setup.thumbprint', 'setup.manage', 'setup.scan']);

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
 * @param {{ signal?: AbortSignal }} [o] 엣지 시한(워커 — 받은 시각 + ttl)
 */
/**
 * v2.825.1 버그 점검(G8 — 재현): 이 엣지에서 같은 Director·같은 서버의 자동 설정은 한 번에 하나 — **시한 뒤 되돌리기까지 끝날 때까지**.
 * 중앙은 회신 시한(RESULT_MS)이 지나면 '결과 모름' 으로 잠금을 푸는데, 엣지의 되돌리기(새 SSH 세션 + reload)는 그보다 오래 걸릴 수 있어
 * 곧바로 다시 실행한 작업과 겹쳐 옛 되돌리기가 새 콘솔 파일을 지웠다(새 비밀번호만 저장되고 Director 에는 콘솔이 없다).
 * 중앙 직접 경로는 라우트가 되돌리기 끝까지 잠금을 쥔다(같은 규칙 — S6).
 */
const _busyDir = new Set();
const _busyHost = new Set();
export async function runSetupOp(kind, dir, args = {}, secretArgs = {}, { signal = null } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('요청 시한이 지나 시작하지 않았습니다.'), { code: 'not-sent', notSent: true });
  const hostKey = String(args?.body?.host || dir.host || '').trim().toLowerCase();
  if (_busyDir.has(dir.id) || (hostKey && _busyHost.has(hostKey))) {
    throw Object.assign(new Error('이 엣지에서 같은 Director·서버의 이전 자동 설정(또는 시한 뒤 되돌리기)이 아직 끝나지 않았습니다 — 끝난 뒤 다시 실행하세요. 아무것도 바꾸지 않았습니다.'), { code: 'conflict' });
  }
  _busyDir.add(dir.id);
  if (hostKey) _busyHost.add(hostKey);
  try { return await runSetupOne(kind, dir, args, secretArgs, signal); } finally { _busyDir.delete(dir.id); if (hostKey) _busyHost.delete(hostKey); }
}

async function runSetupOne(kind, dir, args, secretArgs, signal) {
  const b = { ...bodyOf(args), directorId: dir.id, password: String(secretArgs.password ?? '') };
  const site = args?.site && typeof args.site === 'object' ? { ...args.site, directorId: dir.id } : null;
  switch (kind) {
    case 'setup.preflight': return preflight(b, { dir, signal });
    case 'setup.thumbprint': return readFdThumbprint(b, { site, signal });
    case 'setup.fdIni': return setupFdIni({ ...b, vcpass: String(secretArgs.vcpass ?? '') }, { site, signal });
    case 'setup.fdPlugin': return setupFdPlugin(b, { dir, signal });
    // v2.845 법인별 설정 — 중앙이 판정한 입력을 엣지가 **같은 함수로 다시** 판정한다(받은 값을 믿지 않는다). 계정 비밀번호는 secretArgs 로만.
    case 'setup.scan': return applyManage(planManage('scan', args?.input && typeof args.input === 'object' ? args.input : {}), b, {}, { signal });
    case 'setup.manage': {
      const input = args?.input && typeof args.input === 'object' ? args.input : {};
      const known = args?.known && typeof args.known === 'object' ? args.known : {};
      const plan = planManage(String(args?.action || ''), input, known);
      if (plan.action === 'scan') throw Object.assign(new Error('읽기는 setup.scan 으로 보냅니다.'), { code: 'invalid' });
      return applyManage(plan, b, { accountPassword: secretArgs.accountPassword == null ? undefined : String(secretArgs.accountPassword) }, { signal });
    }
    case 'setup.director': {
      const defaults = args?.defaults && typeof args.defaults === 'object' ? args.defaults : {};
      return setupDirector(b, {
        dir, cur: { directors: [dir], defaults }, consolePassword: secretArgs.consolePassword, signal,
        save: (conn) => {
          // 시한이 지났으면 중앙은 이미 '결과 모름' 으로 손을 뗐다(저장하지 않는다) — 사본을 바꾸지 않고 던져 autoSetup 이 되돌리게 한다
          if (signal?.aborted) throw Object.assign(new Error('엣지 시한이 지나 저장하지 않고 되돌립니다.'), { code: 'aborted' });
          if (!updateEdgeDirectorConn(dir.id, conn)) throw Object.assign(new Error('엣지 사본을 갱신하지 못했습니다.'), { code: 'save' });
          return { director: null, droppedSecrets: [] };
        },
        clearAuthStop: () => { try { bareosAuthGuard.clearAuthStop(directorCred(dir).id); } catch { /* */ } },
      });
    }
    default: throw Object.assign(new Error(`알 수 없는 자동 설정 단계(${kind})`), { code: 'invalid' });
  }
}
