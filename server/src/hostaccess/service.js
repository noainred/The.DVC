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
import { normalizeSettings, parseListAll, planCommands, fingerprint } from './render.js';
import * as realExec from './exec.js';

let deps = realExec;
export function _setExec(e) { deps = e || realExec; }
let revertTimer = null;
let busy = false;

export const SUDOERS_HINT = (user = 'vmportal') => [
  `${user} ALL=(root) NOPASSWD: /usr/bin/firewall-cmd`,
  `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl stop sshd.service, /usr/bin/systemctl start sshd.service, /usr/bin/systemctl disable sshd.service, /usr/bin/systemctl enable sshd.service`,
].join('\n');

/** firewalld 상태 + 기본 존 --list-all. 실패 사유를 구조화(sudo 거부 / firewalld 미동작 / 미설치). */
export async function readEngine() {
  const st = await deps.fw(['--state']);
  if (!st.ok) {
    if (deps.isSudoDenied(st)) return { ok: false, reason: 'sudo-denied', detail: st.stderr.trim(), hint: SUDOERS_HINT(process.env.USER || 'vmportal') };
    if (/not running/i.test(st.stdout + st.stderr)) return { ok: false, reason: 'not-running', detail: 'firewalld 가 실행 중이 아닙니다(systemctl enable --now firewalld).' };
    return { ok: false, reason: 'unavailable', detail: (st.stderr || st.stdout || `exit ${st.code}`).trim() };
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
  return {
    ok: true, draft: st.draft, applied: st.applied, pending: st.pending, engine, sshdActive, requesterIp,
    portalPort: config.port, busy,
    dirty: st.applied ? fingerprint(st.draft) !== st.applied.fingerprint : true,
  };
}

/** 초안 저장(적용 아님). */
export function saveDraft(input) {
  const { settings, errors } = normalizeSettings(input, { portalPort: config.port });
  if (errors.length) return { ok: false, errors, settings };
  saveHostAccess({ draft: settings });
  return { ok: true, settings };
}

/** 계획(dry-run): 현재 존 상태와 초안을 비교 — 실행하지 않는다. */
export async function planHostAccess(input, { requesterIp = '' } = {}) {
  const { settings, errors } = normalizeSettings(input, { portalPort: config.port });
  const engine = await readEngine();
  if (!engine.ok) return { ok: false, errors: [...errors, `방화벽 엔진 사용 불가: ${engine.detail || engine.reason}`], engine, settings };
  const prevRich = loadHostAccess().applied?.rich || [];
  const plan = planCommands(settings, engine.current, { prevRich, requesterIp });
  return { ok: !errors.length && !plan.errors.length, settings, engine, ...plan, errors: [...errors, ...plan.errors] };
}

/** 적용(런타임) → pending. 오류가 하나라도 있으면 아무것도 실행하지 않는다. */
export async function applyHostAccess(input, { requesterIp = '', by = '' } = {}) {
  if (busy) return { ok: false, errors: ['다른 적용/되돌림이 진행 중입니다.'] };
  busy = true;
  try {
    const st = loadHostAccess();
    if (st.pending) return { ok: false, errors: ['확정 대기 중인 적용이 있습니다 — 먼저 확정하거나 되돌리세요.'] };
    const p = await planHostAccess(input, { requesterIp });
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
      if (r && r.ok === false && loadHostAccess().pending) {
        console.warn(`[host-access] 자동 되돌림 보류 — ${(r.errors || []).join(' ') || '진행 중인 작업'} · 2초 뒤 다시 시도합니다`);
        armRevertTimer(Date.now() + 2000);
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
export async function revertHostAccess({ by = '' } = {}) {
  if (busy) return { ok: false, errors: ['다른 적용/되돌림이 진행 중입니다.'] };
  busy = true;
  try {
    const st = loadHostAccess();
    if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
    const r = await deps.fw(['--reload']);
    const had = !!st.pending;
    saveHostAccess({ pending: null, revertedAt: Date.now(), revertedBy: by });
    if (!r.ok) return { ok: false, errors: [`--reload 실패: ${(r.stderr || r.stdout).trim()}`], hadPending: had };
    console.warn(`[host-access] 런타임 방화벽을 영구 설정으로 되돌림(by=${by}, pending=${had})`);
    return { ok: true, hadPending: had };
  } finally { busy = false; }
}

/** 기동 시: 확정 대기가 남아 있으면 기한을 이어받아 타이머 재무장(기한 경과면 즉시 되돌림). */
export async function resumeHostAccessPending() {
  try {
    const st = loadHostAccess();
    if (!st.pending) return;
    if (Date.now() >= st.pending.deadline) { await revertHostAccess({ by: 'auto-restart' }); return; }
    armRevertTimer(st.pending.deadline);
  } catch (e) { console.error('[host-access] 대기 상태 복구 실패:', e.message); }
}
