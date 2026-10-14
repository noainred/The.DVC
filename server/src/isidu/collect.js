/**
 * isidu/collect.js — 대상 하나를 실제로 조사한다(SSH → `du -A -h|-k -d 1 '<경로>'` → 해석, v2.736).
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────
 *  · 접속은 `proxy/sshExec.js withSsh` 하나 — 호스트키 확인(장비 신뢰, S-01)이 인증 **전에** 걸린다. ssh2 를 직접 열지 않는다.
 *  · 시한은 세션을 실제로 끊는다(`withDeadline` + signal — v2.417). 명령 시한은 대상 설정(최대 30분 — sshExec 관문과 같은 상한).
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
    const username = t.username || dev.username || '';
    return { creds: { host: t.host || dev.host, port: t.port || 22, username, password: String(dev.password || '') }, credId: { id: t.id, username, password: String(dev.password || '') } };
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

function classify(e) {
  const msg = String(e?.message || e || '');
  if (isSshHostKeyError(e)) return 'hostkey';
  if (isSshAuthError(e) || isAuthFailureText(msg)) return 'auth';
  if (/타임아웃|timeout|timed out/i.test(msg)) return 'timeout';
  if (/출력 상한/.test(msg)) return 'output-cap';
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|닫혔습니다|connect/i.test(msg)) return 'unreachable';
  return 'exec';
}

/**
 * 대상 하나 조사. 결과는 db.insertScan 모양(entries 포함).
 * @param {object} t  실행 정보(resolveTarget 결과 또는 엣지 사본)
 * @param {{trigger?:string, manual?:boolean, now?:()=>number}} [opts]
 */
export async function collectTarget(t, { trigger = 'schedule', manual = false } = {}) {
  const started = Date.now();
  const base = { agent: '', targetId: t.id, path: t.path, host: t.host, sizeMode: t.sizeMode || 'h', trig: trigger };
  const fail = (kind, error, extra = {}) => ({ ...base, ts: Date.now(), ok: false, kind, error: String(error || '').slice(0, 600), durationMs: Date.now() - started, ...extra });
  if (t.issue) return fail(t.issue, t.issue === 'device-missing' ? '스토리지 등록부에서 그 아이실론이 사라졌습니다' : '고른 장비가 아이실론이 아닙니다');

  let stdout = ''; let stderr = ''; let code = null;
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
    const timeoutMs = Math.max(60_000, Math.min(30, Number(t.timeoutMin) || 30) * 60_000);
    try {
      const r = await withDeadline(timeoutMs + 30_000, (signal) => withSsh({ ...c.creds, signal }, async (api) => {
        const x = await api.exec(duCommand(t.path, t.sizeMode), timeoutMs);
        return { x };
      }), 'du 시한 초과');
      stdout = r.x?.stdout || ''; stderr = r.x?.stderr || ''; code = r.x?.code ?? null;
    } catch (e) {
      const kind = classify(e);
      if (kind === 'auth') authGuard.markAuthStopped(c.credId.id, c.credId, e.message);
      return fail(kind, kind === 'hostkey' ? `${e.message} — 설정 › 보안 › 장비 신뢰에서 이 아이실론의 호스트키 지문을 확인하고 승인하세요` : e.message);
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
    entries: parsed.entries,
  };
}
