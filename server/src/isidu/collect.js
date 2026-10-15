/**
 * isidu/collect.js — 대상 하나를 실제로 조사한다(SSH → `du -A -h|-k -d 1 '<경로>'` → 해석, v2.736).
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────
 *  · 접속은 `proxy/sshExec.js withSsh` 하나 — 호스트키 확인(장비 신뢰, S-01)이 인증 **전에** 걸린다. ssh2 를 직접 열지 않는다.
 *  · 시한은 세션을 실제로 끊는다(`withDeadline` + signal — v2.417). 명령 시한은 대상 설정(최대 180분 — v2.739, sshExec 긴 명령 관문 `{ long: true }`).
 *  · 인증 거부는 **주기 수집을 멈춘다**(util/authGuard — 계정 잠금 방지). 키나 계정이 바뀌면 자동 재개, 수동 실행은 막지 않는다.
 *    호스트키 거부는 인증 실패가 아니다(`isSshAuthError` 가 가른다 — 승인하면 바로 붙어야 한다).
 *  · du 는 권한 오류가 있어도 종료코드 1 로 끝나며 나머지 결과를 낸다 — 해석된 폴더가 있으면 성공으로 적고 오류 줄 수를 함께 남긴다
 *    (그 폴더 크기는 실제보다 작을 수 있다). 해석된 것이 하나도 없으면 실패다(빈 결과를 '사용자 0명' 으로 만들지 않는다).
 */
import { withSsh, withDeadline, isSshAuthError, isSshHostKeyError } from '../proxy/sshExec.js';
import { createAuthGuard, isAuthFailureText } from '../util/authGuard.js';
import { parseDuOutput, duCommand, totalsOf } from './parse.js';
import { privateKeyForConnect, keyInfo, ensureKey } from './sshKey.js';
import { isMockMode } from '../mock/demo/flags.js';
import { sessionPlanOf } from './settings.js';
import { runDetached, killCommand, JOB_RE } from './detach.js';

export const authGuard = createAuthGuard({ file: 'isidu-auth-stops.json' });

/** 실패 종류 — 웹 `isiduText.js FAIL_TEXT` 와 1:1(테스트가 대조). */
export const FAIL_KINDS = Object.freeze(['no-key', 'device-missing', 'device-not-isilon', 'auth', 'hostkey', 'timeout', 'unreachable', 'exec', 'parse', 'output-cap', 'db']);

/** 이 노드에서 대상의 접속 정보를 만든다. 실패면 { error, kind }. */
export async function credsFor(t) {
  if (t.auth === 'device') {
    const { getDeviceWithSecret } = await import('../storage/registry.js');
    const dev = t.deviceId ? getDeviceWithSecret(t.deviceId) : null;
    if (!dev) return { kind: 'device-missing', error: '이 노드의 스토리지 등록부에 그 아이실론이 없습니다(엣지면 스토리지 설정을 아직 받지 못했을 수 있습니다)' };
    if (dev.type !== 'isilon') return { kind: 'device-not-isilon', error: '고른 장비가 아이실론이 아닙니다' };
    // v2.740 A-01: 저장된 장비 비밀번호는 **등록부의 그 장비 주소로만** 보낸다(접속처 고정 — server/CLAUDE.md H-2·v2.503 S-2).
    // 예전 `t.host || dev.host` 는 엣지 /isidu-test 본문의 host 를 믿어, 다른 주소로 그 비밀번호가 SSH 인증으로 나갔다(재현).
    const host = String(dev.host || '').trim();
    if (!host) return { kind: 'device-missing', error: '등록부의 그 아이실론에 주소가 없습니다' };
    const username = t.username || dev.username || '';
    return { creds: { host, port: t.port || 22, username, password: String(dev.password || '') }, credId: { id: t.id, username, password: String(dev.password || '') } };
  }
  let pem = privateKeyForConnect();
  let created = false;
  if (!pem) {
    const info = keyInfo({ fresh: true });
    if (!info.present) { try { const r = ensureKey(); created = !!r.created; } catch (e) { return { kind: 'no-key', error: `SSH 키를 만들지 못했습니다(${e.message})` }; } pem = privateKeyForConnect(); }
    if (!pem) return { kind: 'no-key', error: keyInfo().error || 'SSH 키가 없습니다' };
  }
  const fp = keyInfo().fingerprint || '';
  return { creds: { host: t.host, port: t.port || 22, username: t.username, privateKey: pem }, credId: { id: t.id, username: t.username, password: fp }, keyCreated: created };
}

/**
 * 화면용 — 이 대상의 주기 수집이 인증 거부로 멈춰 있는가(읽기만 한다 — 기록을 지우지 않는다). 이 노드가 조사하는 대상에만 뜻이 있다.
 * @returns {Promise<null|{since:number, at:number, attempts:number, reason:string}>}
 */
export async function authStopOf(t) {
  if (!t?.id) return null;
  let credId;
  if (t.auth === 'device') {
    const { getDeviceWithSecret } = await import('../storage/registry.js');
    const dev = t.deviceId ? getDeviceWithSecret(t.deviceId) : null;
    if (!dev) return null;
    credId = { id: t.id, username: t.username || dev.username || '', password: String(dev.password || '') };
  } else {
    credId = { id: t.id, username: t.username, password: keyInfo().fingerprint || '' };
  }
  return authGuard.peekAuthStop(credId);
}

/**
 * 실패 종류 판정(v2.741 DEV-01 — 순서가 계약이다).
 *  ① 호스트키 거부 ② 구조 표지로 확인한 SSH 인증 거부(ssh2 `err.level` — 문구가 아니다)
 *  ③ 시한·출력 상한 ④ 이름 해석·연결 거부(로그인 시도가 장비에 닿지 않았다) ⑤ 그 밖의 인증 문구 ⑥ 그 밖의 연결 끊김.
 * 시한·출력 상한 문구에는 **명령(경로)** 이 실리고(`SSH exec 타임아웃(7200s): du … '/ifs/x-403'`), DNS 실패 문구에는 **호스트 이름**이 실린다 —
 * 문구 판정(`isAuthFailureText` 의 401·403)을 먼저 보면 경로·이름 속 '-403' 이 인증 거부가 되어 주기 수집이 **영구 정지**됐다(재현).
 * 실제 인증 거부는 ②가 먼저 잡으므로 ③·④를 앞으로 옮겨도 놓치지 않는다.
 */
export function classifyCollectError(e) {
  const msg = String(e?.message || e || '');
  if (isSshHostKeyError(e)) return 'hostkey';
  if (isSshAuthError(e)) return 'auth';
  if (/타임아웃|timeout|timed out|시한 초과/i.test(msg)) return 'timeout';
  if (/출력 상한/.test(msg)) return 'output-cap';
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(msg)) return 'unreachable';
  if (isAuthFailureText(msg)) return 'auth';
  if (/ECONNRESET|닫혔습니다|connect/i.test(msg)) return 'unreachable';
  return 'exec';
}
const classify = classifyCollectError;

/** 시한에 걸린 분리 실행 작업을 멈춘다(짧은 새 세션 — 원래 세션은 시한으로 이미 끊겼다). 실패해도 다음 실행이 2일 지난 파일을 지운다. */
async function killRemoteJob(creds, jobId) {
  if (!jobId || !JOB_RE.test(String(jobId))) return false;
  try {
    await withDeadline(30_000, (signal) => withSsh({ ...creds, signal }, (api) => api.exec(killCommand(jobId), 20_000)), '작업 정지 시한 초과');
    return true;
  } catch { return false; }
}

/**
 * 대상 하나 조사. 결과는 db.insertScan 모양(entries 포함).
 * @param {object} t  실행 정보(resolveTarget 결과 또는 엣지 사본)
 * @param {{trigger?:string, manual?:boolean, attachJob?:string|null, onJob?:Function}} [opts]
 *   v2.737: t.detach !== false 면 장비에서 분리 실행한다(isidu/detach.js) — attachJob 은 재시작 전에 띄운 작업 id(같은 작업에 다시 붙는다),
 *   onJob 은 새 작업을 띄운 직후 불린다(실행 중 스캔 기록에 작업 id 를 남긴다).
 */
export async function collectTarget(t, { trigger = 'schedule', manual = false, attachJob = null, onJob = null } = {}) {
  const started = Date.now();
  const base = { agent: '', targetId: t.id, path: t.path, host: t.host, sizeMode: t.sizeMode || 'h', trig: trigger };
  const fail = (kind, error, extra = {}) => ({ ...base, ts: Date.now(), ok: false, kind, error: String(error || '').slice(0, 600), durationMs: Date.now() - started, ...extra });
  if (t.issue) return fail(t.issue, t.issue === 'device-missing' ? '스토리지 등록부에서 그 아이실론이 사라졌습니다' : '고른 장비가 아이실론이 아닙니다');

  let stdout = ''; let stderr = ''; let code = null; let runInfo = {};
  if (String(t.id).startsWith('mock-') && isMockMode()) {
    const { demoDuOutput } = await import('../mock/demo/isidu.js');
    ({ stdout, stderr, code } = demoDuOutput(t, started));
  } else {
    const c = await credsFor(t);
    if (c.error) return fail(c.kind, c.error);
    if (!manual) {
      const stop = authGuard.authStopFor(c.credId);
      if (stop) return fail('auth', `인증 거부로 주기 수집을 멈췄습니다(${new Date(stop.since).toISOString()} 이후 ${stop.attempts}회) — 키·계정이 바뀌면 자동으로 다시 시도합니다. '지금 수집' 은 막지 않습니다`, { authStopped: true });
    }
    const plan = sessionPlanOf(t);
    const detach = t.detach !== false;
    let jobRef = attachJob || null;
    try {
      const r = await withDeadline(plan.sessionMs, (signal) => withSsh({ ...c.creds, signal }, async (api) => {
        if (detach) {
          return runDetached(api, t, { cmdMs: plan.cmdMs, attachJob, signal, started,
            onJob: (job) => { jobRef = job.id; try { onJob?.(job); } catch { /* */ } } });
        }
        const x = await api.exec(duCommand(t.path, t.sizeMode), plan.cmdMs, { long: true });
        return { x, mode: 'attached' };
      }), 'du 시한 초과', { long: true });   // v2.739: 세션 시한도 긴 작업 상한(3시간)까지 연다 — 명령 시한(EXEC_LONG_MAX_MS)과 같은 값
      stdout = r.x?.stdout || ''; stderr = r.x?.stderr || ''; code = r.x?.code ?? null;
      runInfo = { runMode: r.mode || 'attached', ...(r.attached ? { attached: true } : {}), ...(r.detachFallback ? { detachFallback: r.detachFallback } : {}) };
    } catch (e) {
      const kind = classify(e);
      if (kind === 'auth') authGuard.markAuthStopped(c.credId.id, c.credId, e.message);
      // 포탈 쪽 시한(세션 시한)에 걸리면 장비의 du 를 멈춘다 — 재시작으로 끝날 때는 여기 오지 않는다(그때는 이어 받는다).
      const jid = e?.jobId || jobRef;
      let killed = null;
      if (detach && kind === 'timeout' && jid && !/장비의 du 작업을 멈췄습니다/.test(String(e?.message || ''))) killed = await killRemoteJob(c.creds, jid);
      const tail = killed === true ? ' — 장비의 du 작업을 멈췄습니다' : killed === false ? ' — 장비의 du 작업을 멈추지 못했습니다(다음 실행이 2일 지난 작업 파일을 지웁니다)' : '';
      return fail(kind, kind === 'hostkey' ? `${e.message} — 설정 › 보안 › 장비 신뢰에서 이 아이실론의 호스트키 지문을 확인하고 승인하세요` : `${e.message}${tail}`, detach ? { runMode: 'detached' } : {});
    }
    authGuard.clearAuthStop(t.id);
  }
  const parsed = parseDuOutput(stdout, t.path, { mode: t.sizeMode || 'h', stderr });
  if (!parsed.entries.length && !parsed.total) {
    const why = parsed.errSample[0] || (code != null && code !== 0 ? `du 종료코드 ${code}` : '출력이 비었습니다');
    return fail(parsed.errLines ? 'exec' : 'parse', `du 결과를 읽지 못했습니다 — ${why}`, { skipped: parsed.skipped, errLines: parsed.errLines, errSample: parsed.errSample });
  }
  const tot = totalsOf(parsed.entries, parsed.total);
  return {
    ...base, ts: Date.now(), ok: true, durationMs: Date.now() - started,
    total: parsed.total, sumBytes: tot.sumBytes, sumRes: tot.sumRes, count: parsed.entries.length,
    skipped: parsed.skipped, errLines: parsed.errLines, errSample: parsed.errSample, truncated: parsed.truncated,
    entries: parsed.entries, ...runInfo,
  };
}

/**
 * 연결 시험 — 경로가 있는지만 본다(`ls -d`, du 는 돌리지 않는다). 메인 라우트와 엣지 원격 시험(`/api/collector/isidu-test`)이 같은 함수를 쓴다.
 * 이 노드의 키·등록부로 접속한다(엣지면 엣지의 키 — 메인이 대신 접속하지 않는다).
 * @param {object} r  실행 정보(resolveTarget 결과 또는 cleanEdgeTarget 결과)
 * @param {{clearStopId?:string}} [o]  성공하면 이 id 의 인증 정지를 푼다(저장된 대상일 때만 — v2.590 규약)
 * @returns {Promise<{ok:boolean, ms:number, out?:string, err?:string, code?:number|null, command:string, reason?:string, kind?:string, demo?:boolean, keyCreated?:boolean, attempted?:false}>}
 *   `attempted:false` = 접속 정보를 만들지 못해 접속을 시도하지 않았다(키 없음·등록부에 장비 없음).
 */
export async function testTargetPath(r, { clearStopId = '' } = {}) {
  const command = duCommand(r.path, r.sizeMode);
  if (String(r.id || '').startsWith('mock-') && isMockMode()) return { ok: true, demo: true, ms: 0, out: `${r.path} (데모 — 접속하지 않았습니다)`, command };
  const c = await credsFor(r);
  if (c.error) return { ok: false, ms: 0, kind: c.kind, reason: c.error, command, attempted: false };
  const started = Date.now();
  try {
    const x = await withDeadline(40_000, (signal) => withSsh({ ...c.creds, signal }, (sh) => sh.exec(`ls -d '${r.path}'`, 30_000)), '연결 시험 시한 초과');
    const out = String(x?.stdout || '').trim().split('\n')[0].slice(0, 300);
    const err = String(x?.stderr || '').trim().split('\n')[0].slice(0, 300);
    const ok = x?.code === 0 && out.length > 0;
    if (ok && clearStopId) authGuard.clearAuthStop(clearStopId);
    return { ok, ms: Date.now() - started, out, err, code: x?.code ?? null, command, ...(c.keyCreated ? { keyCreated: true } : {}),
      ...(ok ? {} : { reason: err || `종료코드 ${x?.code} — 경로가 없거나 그 계정에 읽기 권한이 없습니다` }) };
  } catch (e) {
    const kind = classify(e);
    return { ok: false, ms: Date.now() - started, kind, command, ...(c.keyCreated ? { keyCreated: true } : {}),
      reason: kind === 'hostkey' ? `${e.message} — 설정 › 보안 › 장비 신뢰에서 이 아이실론의 호스트키 지문을 확인하고 승인하세요` : e.message };
  }
}
