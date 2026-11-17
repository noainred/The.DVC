/**
 * hostaccess/service.js — 호스트 접근 제어 실행 계층(v2.485): 상태 조회 · 계획 · 적용(런타임) · 확정 · 되돌림.
 *
 * 잠금 사고 방지(commit-confirm):
 *  - apply 는 **런타임에만** 적용한다(--permanent 없음). confirmMinutes 안에 confirm 하지 않으면 `firewall-cmd --reload`
 *    로 영구 설정(=직전 상태)을 되살린다. 확정은 `--runtime-to-permanent`.
 *  - 대기 상태(pending)는 파일에 남겨 포탈이 재시작돼도 기한이 지나면 되돌린다(resumePending).
 *  - sshd 서비스 중지는 확정 단계에서만 실행한다(런타임 실험 중엔 SSH 세션을 유지).
 *  - 웹 허용목록은 요청자 IP 포함이 필수(render.planCommands 가 오류로 막는다).
 * exec 는 주입 가능(테스트에서 가짜 실행기).
 */
import { config } from '../config.js';
import { loadHostAccess, saveHostAccess } from './settings.js';
import { normalizeSettings, parseListAll, planCommands, fingerprint, normalizeRequesterIp } from './render.js';
import * as realExec from './exec.js';
import { listeningPortalPorts } from '../util/httpsServer.js';

/**
 * v2.731(G2b A4-02): 관리 대상·자기 잠금 검사에 넣는 포탈 포트 = **실제로 듣는 포트 전부**(util/httpsServer.js 하나가 판정).
 *   `TLS_PORT ≠ PORT` 로 HTTPS 만 열면 PORT 는 듣지 않는다 — config.port 로 허용목록을 만들면 실제 포탈 포트가 모든 출처에
 *   열린 채 남는다(재현: web.ports ['4000'] · 4443/tcp 그대로). HTTP·HTTPS 를 함께 열면(TLS_HTTP_ALSO) 둘 다 관리한다.
 */
const portalPorts = () => listeningPortalPorts(config.port);

let deps = realExec;
export function _setExec(e) { deps = e || realExec; }
let revertTimer = null;
let busy = false;

export const SUDOERS_HINT = (user = 'vmportal') => [
  `${user} ALL=(root) NOPASSWD: /usr/bin/firewall-cmd`,
  `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl stop sshd.service, /usr/bin/systemctl start sshd.service, /usr/bin/systemctl disable sshd.service, /usr/bin/systemctl enable sshd.service`,
].join('\n');

/**
 * v2.689(NNP 조사): 본체 유닛(packaging/offline/vmware-portal.service)은 NoNewPrivileges=true 다. 그 프로세스의 자식은
 * setuid 로 권한을 얻을 수 없어 sudo 가 sudoers 와 무관하게 거부한다 — 이 컨테이너에서 setpriv --no-new-privs 로
 * 재현했다(sudo 1.9.15p5: 'The "no new privileges" flag is set, which prevents sudo from running as root.').
 * 실서버(systemd)에서는 확인하지 못했다. 유닛은 바꾸지 않고 화면 문구로 원인 후보를 알린다(detail 이 화면에 그대로 나간다).
 */
export const NNP_NOTE = '본체 유닛에 NoNewPrivileges=true 가 있으면 sudoers 가 맞아도 거부됩니다 — 실서버에서 sudo -n /usr/bin/firewall-cmd --state 로 확인하세요.';
// 구버전 sudo 는 NNP 아래에서 'effective uid is not 0' 으로 끝난다(추정 — 이 컨테이너 sudo 1.9.15p5 는 위 문구). nosuid 마운트도 같은 문구다.
const NNP_RE = /no new privileges|effective uid is not 0/i;

/** firewalld 상태 + 기본 존 --list-all. 실패 사유를 구조화(sudo 거부 / firewalld 미동작 / 미설치). */
export async function readEngine() {
  const st = await deps.fw(['--state']);
  if (!st.ok) {
    const err = String(st.stderr || '').trim();
    if (deps.isSudoDenied(st)) return { ok: false, reason: 'sudo-denied', detail: `${err} — ${NNP_NOTE}`, hint: SUDOERS_HINT(process.env.USER || 'vmportal') };
    if (/not running/i.test(st.stdout + st.stderr)) return { ok: false, reason: 'not-running', detail: 'firewalld 가 실행 중이 아닙니다(systemctl enable --now firewalld).' };
    const raw = (st.stderr || st.stdout || `exit ${st.code}`).trim();
    // sudo 가 NNP 플래그로 거부하면 위 sudo-denied 정규식에 걸리지 않아 여기로 온다 — 원인을 함께 말한다.
    return { ok: false, reason: 'unavailable', detail: NNP_RE.test(raw) ? `${raw} — ${NNP_NOTE}` : raw };
  }
  const dz = await deps.fw(['--get-default-zone']);
  const zone = dz.ok ? dz.stdout.trim() : 'public';
  const la = await deps.fw([`--zone=${zone}`, '--list-all']);
  if (!la.ok) return { ok: false, reason: 'unavailable', detail: (la.stderr || la.stdout).trim() };
  const cur = parseListAll(la.stdout);
  if (!cur.zone) cur.zone = zone;
  return { ok: true, zone, current: cur };
}

export async function hostAccessStatus({ requesterIp = '' } = {}) {
  const st = loadHostAccess();
  const engine = await readEngine();
  let sshdActive = null;
  try { sshdActive = await deps.sshdActive(); } catch { sshdActive = null; }
  const ports = portalPorts();
  return {
    // v2.771(R6-F5-2): 화면 '내 IP 추가' 가 이 값을 그대로 넣는다 — '::ffff:a.b.c.d' 면 IPv4 로(라우트도 정규화하지만 이중 방어).
    ok: true, draft: st.draft, applied: st.applied, pending: st.pending, engine, sshdActive, requesterIp: normalizeRequesterIp(requesterIp),
    // portalPort(하나)는 예전 화면 호환 — 광고 포트(TLS 면 TLS_PORT). 관리 대상은 portalPorts 전부다.
    portalPort: ports[0], portalPorts: ports, busy,
    revertRetryWindowMs,   // 결정(56~75) 64 F2: 되돌림 자동 재시도 시한(화면 배너가 숫자를 박지 않게)
    dirty: st.applied ? fingerprint(st.draft) !== st.applied.fingerprint : true,
  };
}

/** 초안 저장(적용 아님). */
export function saveDraft(input) {
  const { settings, errors } = normalizeSettings(input, { portalPorts: portalPorts() });
  if (errors.length) return { ok: false, errors, settings };
  saveHostAccess({ draft: settings });
  return { ok: true, settings };
}

/** 계획(dry-run): 현재 존 상태와 초안을 비교 — 실행하지 않는다. */
export async function planHostAccess(input, { requesterIp = '', peerIp = '' } = {}) {
  const { settings, errors } = normalizeSettings(input, { portalPorts: portalPorts() });
  const engine = await readEngine();
  if (!engine.ok) return { ok: false, errors: [...errors, `방화벽 엔진 사용 불가: ${engine.detail || engine.reason}`], engine, settings };
  const prevRich = loadHostAccess().applied?.rich || [];
  const plan = planCommands(settings, engine.current, { prevRich, requesterIp, peerIp });
  return { ok: !errors.length && !plan.errors.length, settings, engine, ...plan, errors: [...errors, ...plan.errors] };
}

/** 적용(런타임) → pending. 오류가 하나라도 있으면 아무것도 실행하지 않는다. */
export async function applyHostAccess(input, { requesterIp = '', peerIp = '', by = '' } = {}) {
  if (busy) return { ok: false, errors: ['다른 적용/되돌림이 진행 중입니다.'] };
  busy = true;
  try {
    const st = loadHostAccess();
    if (st.pending) return { ok: false, errors: ['확정 대기 중인 적용이 있습니다 — 먼저 확정하거나 되돌리세요.'] };
    const p = await planHostAccess(input, { requesterIp, peerIp });
    if (!p.ok) return { ok: false, errors: p.errors, warnings: p.warnings || [], commands: p.commands || [] };
    const executed = [];
    for (const args of p.commands) {
      const r = await deps.fw(args);
      executed.push({ args, ok: r.ok, out: (r.stdout || r.stderr || '').trim().slice(0, 300) });
      if (!r.ok) {
        // 중간 실패 — 런타임을 영구 설정으로 되돌려 반쯤 적용된 상태를 남기지 않는다.
        await deps.fw(['--reload']);
        return { ok: false, errors: [`명령 실패: firewall-cmd ${args.join(' ')} → ${(r.stderr || r.stdout).trim()}`, '런타임을 --reload 로 되돌렸습니다.'], executed };
      }
    }
    const deadline = Date.now() + p.settings.confirmMinutes * 60_000;
    const pending = { at: Date.now(), deadline, by, fingerprint: fingerprint(p.settings), rich: p.desiredRich, settings: p.settings };
    saveHostAccess({ draft: p.settings, pending });
    armRevertTimer(deadline);
    return { ok: true, pending, executed, warnings: p.warnings, commands: p.commands, noop: p.commands.length === 0 };
  } finally { busy = false; }
}

/**
 * 64회차 F2(재현): 되돌림의 --reload 가 실패하면 예전에는 pending 을 먼저 지워 **다시 시도하지 않았다** — 잠금 사고를 막으려고
 *   적용한 런타임 규칙(SSH 차단 등)이 확정 없이 다음 reload · 재부팅까지 남았다(commit-confirm 의 뜻이 깨진다). 이제 reload 가
 *   성공해야 pending 을 지우고, 실패하면 pending 을 남겨(사유 revertError) 자동 되돌림이 늘어나는 간격으로 다시 시도한다.
 */
const REVERT_RETRY_MIN_MS = 15_000;
const REVERT_RETRY_MAX_MS = 5 * 60_000;
/*
 * 결정(56~75 남긴 것) 64 F2 시한: 자동 재시도는 **처음 실패한 시각부터 최대 6시간**이다(간격 상한 5분은 그대로). 시한이 지나면 자동 재시도를
 *   멈추고 pending 은 남긴 채 `revertGaveUp` 으로 '되돌림 실패 — 수동 조치 필요' 를 밝힌다(화면 배너 · 되돌리기 버튼으로 다시 시도 — 수동 시도는
 *   실패해도 자동 재시도를 다시 걸지 않는다). 처음 실패 시각(revertFirstFailedAt)은 pending 파일에 남아 재시작해도 시한이 이어진다.
 *   되돌림 성공 · 확정 때 실패 연속 수를 0 으로 돌린다(예전에는 확정으로 끝나도 남아 다음 첫 재시도 간격이 길었다 — 66회차 ③).
 */
export const REVERT_RETRY_WINDOW_MS = 6 * 3_600_000;
let revertRetryMinMs = REVERT_RETRY_MIN_MS;
let revertRetryWindowMs = REVERT_RETRY_WINDOW_MS;
let revertFailStreak = 0;
function revertRetryDelay() { return Math.min(REVERT_RETRY_MAX_MS, revertRetryMinMs * 2 ** Math.max(0, revertFailStreak - 1)); }
/** 테스트용 — 재시도 첫 간격(ms). 인자 없으면 기본값. */
export function _setRevertRetryMinMs(ms) { revertRetryMinMs = Number(ms) > 0 ? Number(ms) : REVERT_RETRY_MIN_MS; revertFailStreak = 0; }
/** 테스트용 — 자동 재시도 시한(ms). 인자 없으면 기본값. */
export function _setRevertRetryWindowMs(ms) { revertRetryWindowMs = Number(ms) > 0 ? Number(ms) : REVERT_RETRY_WINDOW_MS; }
/** 테스트 · 진단용 — 지금 실패 연속 수. */
export function _revertFailStreak() { return revertFailStreak; }

function armRevertTimer(deadline) {
  if (revertTimer) clearTimeout(revertTimer);
  revertTimer = setTimeout(async () => {
    revertTimer = null;
    try {
      // 확정이 끝나 pending 이 없으면 되돌릴 것이 없다(확정 성공 경로는 이 타이머를 지운다 — 이것은 재무장분의 방어선).
      if (!loadHostAccess().pending) return;
      const r = await revertHostAccess({ by: 'auto-timeout' });
      // v2.591 L6: revert 는 busy 면 throw 가 아니라 `{ok:false}` 를 **반환**한다 — 예전에는 그 값을 보지 않아 기한 직전 확정이
      //   진행 중이면 자동 되돌림이 조용히 버려지고, 그 확정이 실패하면 기한 뒤에도 런타임 규칙이 남았다(재현: --reload 0회).
      //   진행 중인 작업이 끝난 뒤 다시 본다.
      if (r && r.ok === false && r.busy && loadHostAccess().pending) {
        console.warn(`[host-access] 자동 되돌림 보류 — ${(r.errors || []).join(' ') || '진행 중인 작업'} · 2초 뒤 다시 시도합니다`);
        armRevertTimer(Date.now() + 2000);
      } else if (r && r.ok === false) {
        // 64회차 F2: --reload 자체가 실패했다 — revertHostAccess 가 pending 을 남기고 늘어나는 간격(15초 → 최대 5분)으로 이미 다시 걸었다
        //   (결정(56~75): 처음 실패부터 시한이 지났으면 걸지 않고 gaveUp — 수동 조치 필요).
        console.warn(`[host-access] 자동 되돌림 실패${r.gaveUp ? '(자동 재시도 시한 지남 — 수동 조치 필요)' : ''} — ${(r.errors || []).join(' ')}`);
      }
    } catch (e) { console.error('[host-access] 자동 되돌림 실패:', e.message); }
  }, Math.max(0, deadline - Date.now()));
  revertTimer.unref?.();
}

/** 확정: 런타임 → 영구. sshd 중지/재개는 여기서만. */
export async function confirmHostAccess({ by = '' } = {}) {
  if (busy) return { ok: false, errors: ['다른 적용/되돌림이 진행 중입니다.'] };
  busy = true;
  try {
    const st = loadHostAccess();
    if (!st.pending) return { ok: false, errors: ['확정 대기 중인 적용이 없습니다.'] };
    if (Date.now() > st.pending.deadline) return { ok: false, errors: ['확정 기한이 지났습니다 — 자동으로 되돌렸거나 곧 되돌립니다. 다시 적용하세요.'] };
    const r = await deps.fw(['--runtime-to-permanent']);
    if (!r.ok) return { ok: false, errors: [`--runtime-to-permanent 실패: ${(r.stderr || r.stdout).trim()}`] };
    if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
    revertFailStreak = 0;   // 결정(56~75) 64 F2: 확정으로 끝났다 — 다음 적용의 첫 재시도 간격이 앞선 실패에 끌려 길어지지 않게
    const s = st.pending.settings || st.draft;
    const notes = [];
    let sshdStopped = !!st.applied?.sshdStopped;
    if (s.ssh.mode === 'deny' && s.ssh.stopService) {
      const a = await deps.sshdCtl('stop'); const b = await deps.sshdCtl('disable');
      if (a.ok && b.ok) { sshdStopped = true; notes.push('sshd 서비스를 중지·비활성했습니다.'); }
      else notes.push(`sshd 중지 실패(방화벽 차단은 적용됨): ${(a.stderr || b.stderr || '').trim()}`);
    } else if (sshdStopped) {
      const a = await deps.sshdCtl('enable'); const b = await deps.sshdCtl('start');
      if (a.ok && b.ok) { sshdStopped = false; notes.push('포탈이 중지했던 sshd 서비스를 다시 시작했습니다.'); }
      else notes.push(`sshd 재시작 실패: ${(a.stderr || b.stderr || '').trim()}`);
    }
    const applied = { at: Date.now(), by, fingerprint: st.pending.fingerprint, rich: st.pending.rich || [], sshdStopped };
    saveHostAccess({ applied, pending: null, draft: s });
    return { ok: true, applied, notes };
  } finally { busy = false; }
}

/** 되돌림(수동/자동): --reload 로 영구 설정 복원, pending 제거. */
export async function revertHostAccess({ by = '', now = Date.now() } = {}) {
  if (busy) return { ok: false, busy: true, errors: ['다른 적용/되돌림이 진행 중입니다.'] };
  busy = true;
  try {
    const st = loadHostAccess();
    if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
    const r = await deps.fw(['--reload']);
    const had = !!st.pending;
    if (!r.ok) {
      // 64회차 F2: 되돌리지 못했다 — 확정되지 않은 런타임 규칙이 그대로다. pending 을 지우지 않는다(자동 되돌림 · 화면 · 재적용 거부가 계속 본다).
      const why = String(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300);
      revertFailStreak += 1;
      if (had) {
        // 결정(56~75) 64 F2 시한: 처음 실패 시각부터 revertRetryWindowMs 안에서만 자동으로 다시 건다. 지났거나 이미 포기한 상태면 걸지 않는다.
        const firstFailedAt = Number(st.pending.revertFirstFailedAt) > 0 ? Number(st.pending.revertFirstFailedAt) : now;
        const gaveUp = st.pending.revertGaveUp === true || now - firstFailedAt >= revertRetryWindowMs;
        saveHostAccess({ pending: { ...st.pending, revertError: why, revertFailedAt: now, revertFirstFailedAt: firstFailedAt, revertFailures: (Number(st.pending.revertFailures) || 0) + 1,
          ...(gaveUp ? { revertGaveUp: true, revertGaveUpAt: Number(st.pending.revertGaveUpAt) > 0 ? Number(st.pending.revertGaveUpAt) : now } : {}) } });
        // 위에서 타이머를 지웠다 — 기한 전이면 기한에, 지났으면 늘어나는 간격 뒤에 다시 되돌린다(수동 되돌림 실패도 자동 되돌림을 잃지 않게 — 시한 안에서만).
        if (!gaveUp) armRevertTimer(Math.max(Number(st.pending.deadline) || 0, Date.now() + revertRetryDelay()));
        else console.warn(`[host-access] 되돌림 실패가 ${Math.round((now - firstFailedAt) / 60_000)}분째 — 자동 재시도를 멈췄습니다(수동 조치 필요 · pending 유지): ${why}`);
        return { ok: false, gaveUp, errors: [`--reload 실패: ${why}`, gaveUp ? '되돌림 실패 — 수동 조치 필요: 자동 재시도 시한이 지나 더 시도하지 않습니다(확정 대기는 남겨 두었습니다 — firewalld 를 살핀 뒤 되돌리기 버튼으로 다시 시도하세요).' : '확정 대기(pending)를 남겼습니다 — 되돌림을 다시 시도합니다.'], hadPending: had };
      }
      return { ok: false, errors: [`--reload 실패: ${why}`], hadPending: had };
    }
    revertFailStreak = 0;
    saveHostAccess({ pending: null, revertedAt: Date.now(), revertedBy: by });
    console.warn(`[host-access] 런타임 방화벽을 영구 설정으로 되돌림(by=${by}, pending=${had})`);
    return { ok: true, hadPending: had };
  } finally { busy = false; }
}

/** 기동 시: 확정 대기가 남아 있으면 기한을 이어받아 타이머 재무장(기한 경과면 즉시 되돌림). */
export async function resumeHostAccessPending() {
  try {
    const st = loadHostAccess();
    if (!st.pending) return;
    // 결정(56~75) 64 F2 시한: 자동 재시도를 포기한 상태(revertGaveUp)는 재시작으로 다시 자동 시도하지 않는다 — 수동 조치(되돌리기 버튼)를 기다린다.
    if (st.pending.revertGaveUp === true) { console.warn('[host-access] 되돌림 실패 — 수동 조치 필요(자동 재시도 시한 지남 · 확정 대기 유지). 설정 › 호스트 접근 제어에서 되돌리기를 다시 시도하세요.'); return; }
    if (Date.now() >= st.pending.deadline) {
      const r = await revertHostAccess({ by: 'auto-restart' });
      // 64회차 F2: 기동 때 되돌림이 실패하면 다시 시도하지 않았다 — 실패는 revertHostAccess 가 재시도를 걸고, busy 면 여기서 건다.
      if (r && r.ok === false && r.busy && loadHostAccess().pending) armRevertTimer(Date.now() + 2000);
      return;
    }
    armRevertTimer(st.pending.deadline);
  } catch (e) { console.error('[host-access] 대기 상태 복구 실패:', e.message); }
}
