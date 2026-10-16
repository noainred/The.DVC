/**
 * Orchestrates the auto-upgrade feature for the running portal: tracks the last
 * check, runs the optional background watcher (local folder + remote source),
 * applies newer bundles, pushes them to edges, and re-execs the process.
 *
 * Settings come from settings.js (env defaults + values edited in the admin UI)
 * and can be reloaded at runtime. Everything is a no-op unless enabled.
 */

import { currentVersion, config } from '../config.js';
import { loadSettings, saveSettings, redactSettings, clampPollMs } from './settings.js';
import { checkpointConfigDbs } from './dbCheckpoint.js';
import {
  findNewerArchive, upgradeFromArchive, checkRemote, upgradeFromRemote,
  restartProcess, pushBundleToEdge, vstr, safeUrlText,
} from './upgrade.js';
import { signatureStatus } from './signature.js';     // v2.730(검토 S-10): 화면이 서명 검증 상태를 보인다
import { rememberRemoteCheck } from './versionsDoc.js'; // v2.730(검토 I-08): 직전 정상 확인 결과 유지 계약
import { resolveBundleBytes, bundleFromArchive, lastBundleReject } from './bundleSource.js';
import { pushUpgradeToCollectors, pushConcurrencyOf } from '../collector/upgradePush.js'; // v2.741(TIMING-07): push 동시 개수(엣지 push 도 같은 값)
import { loadCollectors } from '../collector/registry.js';
// v2.736.2(사용자 신고 — 자동 업그레이드가 왜 안 되는지 화면이 말하지 않았다): 상태 판정 + 기록 정제 + 재시작 뒤에도 남는 기록.
import { autoUpgradeState, sanitizeCheck, sanitizeResult, sanitizeTick, restoreStatus, sanitizeDeferral } from './autoState.js';
import { upgradeStatusFile, readUpgradeStatus, writeUpgradeStatus } from './statusStore.js';
import { runningScans, resumeOutlookText, queuedScans } from '../util/scanJournal.js'; // v2.737: 실행 중 스캔이 끝날 때까지 자동 적용을 미룬다 · v2.742: 대기 요청
import { runningBulkDeploys as bulkDeployRuns } from '../agent/bulkDeploy.js';             // v2.742(TIMING-04): 진행 중인 에이전트 대량 배포도 기다린다(읽기만)
import { runnerStatus as vmcloneRunnerStatus } from '../vmclone/runner.js';  // v2.741(TIMING-01 ③): 실행 중 VM 복제 잡도 기다린다(읽기만)
import { getJob as vmcloneJob } from '../vmclone/store.js';
import { poolSettled } from '../util/pool.js';
import { numOrNull } from '../util/numOrNull.js';
import { localStamp } from '../util/dayKey.js';       // v2.740(B-08): 사람이 읽는 시각은 포탈 시각
import { cmpVersion } from '../util/cmpVersion.js';

/**
 * v2.737(사용자 신고 "업그레이드되면 scan 하던 게 중단된다"): 자동 적용은 이 노드에서 **실행 중인 스캔**(아이실론 du·iDRAC 대역·IP 대역 —
 *   util/scanJournal)이 끝날 때까지 기다린다. 상한(기본 2시간)을 넘기면 적용한다 — 끝나지 않는 스캔이 업그레이드를 영원히 막지 않게.
 *   기다리는 동안 1분마다 다시 보고, 스캔이 끝나면 곧바로 적용한다(다음 확인 주기까지 미루지 않는다). 0 이면 기다리지 않는다.
 *   ⚠ 수동 '업그레이드 적용' 은 기다리지 않는다(화면이 실행 중 스캔을 먼저 경고한다). 중앙이 보낸 번들 push 도 기다리지 않는다 —
 *   그 경로는 받은 즉시 설치 디렉터리를 바꾸므로 재시작만 미루면 옛 프로세스가 새 파일을 읽게 된다. 끊긴 스캔은 자동 재개가 잇는다.
 */
export function scanDeferMaxMs(v = process.env.UPGRADE_SCAN_DEFER_MAX_MS) {
  const n = numOrNull(v);
  if (n == null || n < 0) return 7_200_000;
  return Math.min(12 * 3_600_000, Math.round(n));
}
const DEFER_RECHECK_MS = 60_000;

/**
 * v2.741(감사 TIMING-01 ③): 자동 적용이 기다리는 **실행 중 VM 복제 잡**(vmclone/runner.js — 스캔 기록 밖이다).
 *   복제 도중 재시작이 오면 원본 VM 에 임시 스냅샷(portal-clone-*)이 남고 그 잡을 이어 받는 경로가 없다 — 그래서 스캔처럼 끝나기를 기다린다
 *   (상한은 스캔과 같은 UPGRADE_SCAN_DEFER_MAX_MS). 대기열에만 있는 잡은 아직 아무것도 건드리지 않았으므로 기다리지 않는다.
 * @returns {{kind:'vm-clone', key:string, label:string, since:number|null, phase:string, resumable:false}[]}
 */
export function runningVmClones() {
  let st = null;
  try { st = vmcloneRunnerStatus(); } catch { return []; }
  const r = st?.running;
  if (!r || !r.jobId) return [];
  let name = '';
  try { name = String(vmcloneJob(r.jobId)?.vmName || ''); } catch { name = ''; }
  return [{ kind: 'vm-clone', key: String(r.jobId), label: `VM 복제 ${name || r.jobId}`.slice(0, 120), since: numOrNull(r.startedAt), phase: String(r.phase || '').slice(0, 120), resumable: false }];
}

/**
 * v2.742(감사 TIMING-04): 자동 적용이 기다리는 **진행 중인 에이전트 대량 배포**(agent/bulkDeploy.js — 스캔 기록 밖이다).
 *   실행 상태가 메모리에만 있고 노드마다 원격 install.sh 를 동기로 돌려, 재시작이 오면 진행 기록이 사라지고 설치가 중간에 끊긴 노드가 남을 수 있다
 *   (이어 받는 경로가 없다). 상한은 스캔과 같은 UPGRADE_SCAN_DEFER_MAX_MS 다.
 */
export function runningBulkDeploys() {
  try { return bulkDeployRuns(); } catch { return []; }
}
/**
 * v2.742(감사 RECENT-02): 자동 적용이 기다리는 **시작하지 못한 '지금 수집' 대기 요청**(util/scanJournal queuedScans).
 *   기록이 파일에 남은(resumable) 대기 요청은 재시작 뒤 그 기능의 대기열로 돌아오므로 기다리지 않는다(분리 실행 du 와 같은 판단 — TIMING-03).
 *   기록을 쓰지 못했거나 재개가 꺼진(SCAN_RESUME=0) 기동이면 재시작이 그 요청을 지우므로 기다린다.
 */
function queuedEntries(list) { return (Array.isArray(list) ? list : []).filter((x) => x && x.queued); }
const queuedLabel = (x) => `'지금 수집' 대기 ${x.label || x.key || x.kind}`.slice(0, 120);

/** 상한을 넘겨 적용할 때 — 스캔은 자동 재개가 잇고(resumeOutlookText), VM 복제·대량 배포·기록 못 한 대기 요청은 잇지 않는다(조용히 '재개된다' 고 말하지 않는다). */
const NON_SCAN_KINDS = new Set(['vm-clone', 'bulk-deploy']);
const scansOnly = (list) => (Array.isArray(list) ? list : []).filter((x) => !NON_SCAN_KINDS.has(x.kind) && !x.queued);
function cloneOutlookText(blocking) {
  const list = Array.isArray(blocking) ? blocking : [];
  const n = list.filter((x) => x.kind === 'vm-clone').length;
  const d = list.filter((x) => x.kind === 'bulk-deploy').length;
  const q = queuedEntries(list).length;
  return joinOutlook(
    n ? `VM 복제 ${n}개는 중간에 끊깁니다 — 원본 VM 에 임시 스냅샷(portal-clone-*)이 남았는지 VM 복제 화면에서 확인하세요` : '',
    d ? `에이전트 대량 배포 ${d}건은 중간에 끊깁니다 — 설치가 끝나지 않은 노드가 남았는지 배포 화면에서 확인하고 다시 실행하세요` : '',
    q ? `'지금 수집' 대기 요청 ${q}개는 기록을 남기지 못해 재시작 뒤 다시 돌지 않습니다 — 다시 누르세요` : '',
  );
}
function joinOutlook(...parts) { return parts.filter(Boolean).join(' · '); }

/** 기다리지 않은 분리 실행 du 가 있으면 그 사실을 적는다(조용히 끊지 않는다) — 없으면 ''. */
function detachedNote(detached) {
  const n = Array.isArray(detached) ? detached.length : 0;
  if (!n) return '';
  const names = detached.slice(0, 3).map((x) => x.label || x.kind).filter(Boolean).join(', ');
  return ` · 장비에서 분리 실행 중인 스캔 ${n}개${names ? `(${names}${n > 3 ? ' …' : ''})` : ''}는 기다리지 않습니다(재시작 뒤 같은 작업에 다시 붙어 결과를 받습니다)`;
}
/** v2.742(RECENT-02): 기다리지 않은(기록이 남은) 대기 요청이 있으면 그 사실을 적는다 — 없으면 ''. */
function queuedNote(kept) {
  const n = Array.isArray(kept) ? kept.length : 0;
  if (!n) return '';
  const names = kept.slice(0, 3).map((x) => x.label || x.key).filter(Boolean).join(', ');
  return ` · 시작을 기다리는 '지금 수집' ${n}개${names ? `(${names}${n > 3 ? ' …' : ''})` : ''}는 기다리지 않습니다(재시작 뒤 대기열로 돌아와 차례로 시작합니다)`;
}


const originOf = (u) => { try { return new URL(String(u)).origin; } catch { return ''; } }; // 경로·쿼리에 비밀이 실릴 수 있어 origin 만
/**
 * 엣지 번들 push 결과 요약(순수 — v2.605 LEFT2605-04). 실패 목록은 주소·사유(글자)만, 최대 20건.
 * @returns {{ total:number, ok:number, failed:{edge:string,status:number|null,reason:string}[] }}
 */
export function summarizeEdgePush(results) {
  const list = Array.isArray(results) ? results.filter((r) => r && typeof r === 'object') : [];
  const failed = list.filter((r) => r.ok !== true).slice(0, 20)
    .map((r) => ({ edge: originOf(r.edge), status: Number.isFinite(r.status) ? r.status : null, reason: typeof r.reason === 'string' ? r.reason.slice(0, 300) : '' }));
  return { total: list.length, ok: list.filter((r) => r.ok === true).length, failed };
}

/** 두 출처(원격 latest · 감시 폴더 버전) 중 큰 버전 — 비교할 수 없는 값은 건너뛴다(v2.740 B-02 ③). */
function newestVersion(...vs) {
  let best = null;
  for (const v of vs) { if (!v) continue; if (best == null || (cmpVersion(v, best) ?? 0) > 0) best = v; }
  return best;
}

/**
 * v2.740(감사 B-02): 감시 폴더 번들을 거부한 뒤 원격도 실패(또는 '이미 최신')하면 감시 폴더 사유를 결과에 남긴다.
 * 예전에는 원격 결과로 통째로 덮어 감시 폴더 거부(서명 manifest 없음 등)가 기록·화면 어디에도 없었고, 원격이 '최신' 이면
 * upToDate 로 기록돼 매 주기 같은 거부가 반복되는데도 화면은 정상으로 보였다. 대상 버전(target)은 감시 폴더 번들 버전이다.
 */
export function withWatchFailure(watch, remote) {
  const rem = !remote ? '시도하지 않음'
    : remote.upToDate ? `새 버전 없음${remote.check?.latest ? `(최신 v${remote.check.latest})` : ''}`
      : (remote.reason || '실패');
  const out = {
    ok: false,
    reason: `감시 폴더 번들 v${watch.version} 을 적용하지 못했습니다 — ${watch.res.reason || '사유 없음'} · 원격 소스: ${rem}`,
    target: watch.version,
  };
  if (watch.res.code) out.code = watch.res.code;
  if (watch.res.signature) out.signature = watch.res.signature;
  if (remote?.check) out.check = remote.check;
  return out;
}

export class UpgradeManager {
  constructor() {
    this.settings = loadSettings();
    this.lastCheck = null;
    this.#lastResult = null;
    this.lastTick = null;       // v2.736.2: 백그라운드 확인 한 번의 결과(언제·무엇을 했나)
    this.timer = null;
    this.armedAt = null;        // v2.736.2: 백그라운드 타이머를 무장한 시각(다음 확인 시각 계산 — setInterval 과 같은 규칙)
    this.armedMs = 0;
    this.persist = { enabled: false, file: null, error: null, corruptKept: null, restored: false };
    this.deferral = null;       // v2.737: { since, until, latest, scans } — 실행 중 스캔이 끝나기를 기다리는 중
    this.deferTimer = null;
  }

  // v2.736.2: 적용 결과는 routes(엣지·수집기 push 수신)도 대입한다 — 대입하면 파일에도 남는다.
  #lastResult = null;
  get lastResult() { return this.#lastResult; }
  set lastResult(v) { this.#lastResult = v || null; this.#save(); }

  /**
   * v2.736.2: 기록을 파일에 남기기 시작한다(서버 프로세스만 — start() 가 부른다). 재시작 전 기록을 되살린다 —
   * 이 프로세스가 이미 만든 기록이 있으면 그것이 더 최신이므로 덮지 않는다.
   */
  enablePersistence(file = upgradeStatusFile()) {
    const r = readUpgradeStatus(file);
    const prev = restoreStatus(r.doc, currentVersion());
    if (!this.lastCheck && prev.lastCheck) this.lastCheck = prev.lastCheck;
    if (!this.#lastResult && prev.lastResult) this.#lastResult = prev.lastResult;
    if (!this.lastTick && prev.lastTick) this.lastTick = prev.lastTick;
    this.persist = { enabled: true, file, error: r.error || null, corruptKept: r.corruptKept || null, restored: !!(prev.lastCheck || prev.lastResult || prev.lastTick) };
    if (r.error) console.warn(`[upgrade] ${r.error}${r.corruptKept ? ` — 원본은 ${r.corruptKept}` : ''}`);
    return this.persist;
  }

  #save() {
    if (!this.persist?.enabled || !this.persist.file) return;
    const err = writeUpgradeStatus(this.persist.file, { lastCheck: this.lastCheck, lastResult: this.#lastResult, lastTick: this.lastTick });
    if (err && err !== this.persist.error) console.warn(`[upgrade] ${err}`);
    this.persist.error = err;
  }

  get enabled() {
    return this.settings.enabled;
  }

  status() {
    const s = this.settings;
    return {
      ...redactSettings(s),
      version: currentVersion(),
      remoteConfigured: Boolean(s.remoteBase),
      // v2.730(I-08): 주소의 계정·비밀번호·쿼리(토큰)는 화면에 싣지 않는다.
      remoteVersionsUrl: s.remoteBase ? safeUrlText(`${s.remoteBase.replace(/\/+$/, '')}/versions.json`) : null,
      // v2.736.2: 기록은 정제해 싣는다(아는 필드만 · 주소의 계정·쿼리 제거 — 예전에는 적용 결과의 check.downloadUrl 이 그대로 나갔다).
      lastCheck: sanitizeCheck(this.lastCheck),
      lastResult: sanitizeResult(this.#lastResult),
      lastTick: sanitizeTick(this.lastTick),
      // v2.736.2: '자동 업그레이드가 지금 동작하는가 · 왜 안 하는가 · 다음 확인은 언제인가' — 판정은 autoState.js 하나.
      auto: autoUpgradeState({
        settings: s, intervalMs: this.timer ? this.armedMs : 0, armedAt: this.timer ? this.armedAt : null,
        lastCheck: sanitizeCheck(this.lastCheck), lastResult: sanitizeResult(this.#lastResult), lastTick: sanitizeTick(this.lastTick),
        currentVersion: currentVersion(), deferral: this.deferral, now: Date.now(),
      }),
      // v2.737: 화면이 수동 적용 전에 '지금 스캔 N개가 끊긴다' 를 경고하고, 대기 중이면 무엇을 기다리는지 말한다.
      // v2.741(TIMING-03): resumable — 재시작 뒤 같은 작업에 다시 붙는 스캔(아이실론 분리 실행 du). 자동 적용은 그 스캔을 기다리지 않는다.
      runningScans: runningScans().slice(0, 20).map((x) => ({ kind: x.kind, label: x.label, since: x.since, trigger: x.trigger, resumable: !!x.resumable })),
      // v2.741(TIMING-01 ③): 실행 중 VM 복제 잡 — 수동 적용 전 경고와 자동 적용 대기가 함께 본다.
      runningClones: runningVmClones().map((x) => ({ kind: x.kind, label: x.label, since: x.since, phase: x.phase })),
      // v2.742(TIMING-04): 진행 중인 에이전트 대량 배포 — 수동 적용 전 경고와 자동 적용 대기가 함께 본다.
      runningDeploys: runningBulkDeploys().map((x) => ({ kind: x.kind, label: x.label, since: x.since })),
      // v2.742(RECENT-02): 시작을 기다리는 '지금 수집' — resumable 이면 재시작 뒤 대기열로 돌아온다(아니면 재시작이 지운다).
      queuedScans: queuedScans().slice(0, 20).map((x) => ({ kind: x.kind, label: x.label, since: x.since, trigger: x.trigger, resumable: !!x.resumable })),
      deferral: sanitizeDeferral(this.deferral), scanDeferMaxMs: scanDeferMaxMs(),
      ticking: this.#ticking,
      applying: !!this._applying,
      persist: { enabled: !!this.persist?.enabled, error: this.persist?.error || null, corruptKept: this.persist?.corruptKept || null },
      signature: (() => { try { return signatureStatus(); } catch (e) { return { error: String(e?.message || e).slice(0, 200) }; } })(),
    };
  }

  /** Persist edited settings and restart the background poller. */
  updateSettings(partial) {
    this.settings = saveSettings(partial);
    this.#restartTimer();
    return this.status();
  }

  /** Check both sources for an available newer version (no install). trigger: 'auto'(백그라운드) | 'manual'(화면 버튼). */
  async check({ trigger = 'manual' } = {}) {
    const s = this.settings;
    const cur = currentVersion();
    const result = { at: Date.now(), current: cur, trigger };

    if (s.watchDir) {
      const found = findNewerArchive(s.watchDir, cur);
      result.watch = found ? { available: true, version: vstr(found.version), path: found.path } : { available: false };
    }
    if (s.remoteBase) {
      // v2.730(I-08): 실패한 확인은 직전 정상값을 `lastGood` 으로 **참고만** 싣는다 — available 은 이번 확인 기준(false)이고,
      //   설치(apply)는 언제나 upgradeFromRemote 가 방금 새로 받은 메타데이터로만 진행한다.
      result.remote = rememberRemoteCheck(this, await checkRemote(s.remoteBase, cur, { token: s.token }));
    }
    this.lastCheck = result;
    this.#save();
    return result;
  }

  /** Install the newest available bundle. source: 'auto' | 'watch' | 'remote'. */
  async apply({ source = 'auto', restart = false, trigger = 'manual' } = {}) {
    // single-flight — 적용 후 엣지/수집기 푸시(타깃당 최대 600s)가 끝나기 전에 다음 tick이나
    // 수동 apply가 겹치면 같은 installDir에 renameSync 스왑이 경합해 설치가 깨질 수 있다.
    if (this._applying) return { ok: false, reason: '업그레이드 적용이 이미 진행 중입니다.' };
    this._applying = true;
    try { return await this.#applyInner({ source, restart, trigger }); }
    finally { this._applying = false; }
  }

  async #applyInner({ source, restart, trigger }) {
    const s = this.settings;
    if (!s.installDir) {
      // v2.736.2: 이 실패도 기록한다 — 예전에는 lastResult 를 남기지 않아 자동 적용이 매 주기 여기서 멈춰도 화면에 흔적이 없었다.
      const r0 = { ok: false, code: 'no-install-dir', reason: '설치 경로(installDir)가 설정되지 않아 적용할 수 없습니다.' };
      this.lastResult = { at: Date.now(), source, trigger, ...r0 };
      return r0;
    }
    const cur = currentVersion();
    let res = null;

    // 파일 복사(config 디렉터리 보존) 전에 라이브 WAL SQLite를 체크포인트 → 복사본 정합성 확보.
    // best-effort: 실패/미지원이어도 업그레이드는 그대로 진행.
    try {
      const r = await checkpointConfigDbs(config.configDir);
      if (r.ok && r.checkpointed?.length) console.log(`[upgrade] 라이브 SQLite 체크포인트 완료(복사 정합성): ${r.checkpointed.join(', ')}`);
    } catch { /* never block upgrade */ }

    let watchFail = null; // v2.740(B-02): 감시 폴더 번들을 거부한 사유 — 원격 결과로 덮지 않는다
    if ((source === 'auto' || source === 'watch') && s.watchDir) {
      const found = findNewerArchive(s.watchDir, cur);
      if (found) {
        res = upgradeFromArchive(found.path, s.installDir, cur, s.packageName);
        if (!res.ok && !res.upToDate) { if (!res.target) res.target = vstr(found.version); watchFail = { version: vstr(found.version), res }; }
      }
    }
    if (!res?.ok && (source === 'auto' || source === 'remote') && s.remoteBase) {
      const r = await upgradeFromRemote(s.remoteBase, s.installDir, cur, s.downloadDir, { token: s.token, pkgName: s.packageName });
      res = (watchFail && !r.ok) ? withWatchFailure(watchFail, r) : r;
    }
    if (!res) res = { ok: false, reason: '적용할 업그레이드 소스가 없습니다 (감시 폴더/원격 미설정).' };

    if (res.ok && restart) res.restarting = true; // 재시작 직전에 기록이 파일에 남도록 먼저 표시한다
    this.lastResult = { at: Date.now(), source, trigger, ...res };
    if (res.ok) {
      // v2.605(감사 LEFT2605-04): 엣지 push 결과를 버리지 않는다 — 예전에는 .catch(() => {}) 로 통째로 버려 실패한 엣지가 구버전으로 남아도
      //   흔적이 없었다(형제 pushToCollectors 는 '성공 n/m' 을 찍는다). 요약을 lastResult 에 싣고 콘솔에도 남긴다(pushToEdges 안).
      const edgePush = await this.pushToEdges(res.appliedArchive).catch((e) => { console.warn(`[upgrade] 엣지 업그레이드 푸시 실패: ${e?.message || e}`); return null; });
      if (Array.isArray(edgePush) && edgePush.length) { this.#lastResult.edgePush = summarizeEdgePush(edgePush); this.#save(); }
      // v2.740(B-03): 수집기에도 **방금 적용한 번들**을 민다(엣지 push 와 같은 대상) — 예전에는 resolveBundleBytes 를 다시 불러
      //   감시 폴더의 옛 번들을 고르거나(그 manifest 가 없으면) 조용히 생략했다.
      await this.pushToCollectors(res.appliedArchive).catch(() => {});
      if (restart) setTimeout(() => restartProcess(), 250);
    }
    return res;
  }

  /**
   * After a successful self-upgrade, push the same bundle to every registered
   * collector agent so all datacenters stay on the same version automatically.
   */
  async pushToCollectors(archivePath) {
    if (!loadCollectors().some((c) => c.enabled !== false)) return [];
    const bundle = archivePath ? bundleFromArchive(archivePath) : await resolveBundleBytes(this.settings);
    if (!bundle) {
      if (archivePath) console.warn(`[upgrade] 수집 에이전트 업그레이드 푸시 생략 — 적용한 번들을 다시 확인하지 못했습니다: ${lastBundleReject() || '사유 없음'}`);
      return [];
    }
    const results = await pushUpgradeToCollectors(bundle.bytes, { manifest: bundle.manifest || null }); // v2.730(S-10): 서명 manifest 를 함께
    const ok = results.filter((r) => r.ok).length;
    if (results.length) console.log(`[upgrade] 수집 에이전트 업그레이드 푸시: ${ok}/${results.length} 성공`);
    return results;
  }

  async pushToEdges(archivePath) {
    const s = this.settings;
    if (!s.edges?.length) return [];
    let bundle = archivePath;
    if (!bundle && s.watchDir) bundle = findNewerArchive(s.watchDir, '0.0.0')?.path;
    if (!bundle) return [];
    // v2.741(감사 TIMING-07): 동시 개수 상한(UPGRADE_PUSH_CONCURRENCY, 기본 4) — 예전 Promise.all 은 모든 엣지에 번들(수십 MB)을 한꺼번에
    //   올려 업링크를 나눠 쓰다 개별 업로드가 시한(EDGE_PUSH_TIMEOUT_MS)을 넘길 수 있었고, 엣지마다 번들을 따로 읽어 메모리에 동시에 올렸다.
    //   결과 배열 모양·순서는 예전 그대로이고, 던진 항목(번들 파일 읽기 실패 등)은 그 엣지만 실패로 남긴다(예전에는 전체가 거부됐다).
    const settled = await poolSettled(s.edges, pushConcurrencyOf(), (e) => pushBundleToEdge(e, bundle));
    const results = settled.map((r, i) => (r.status === 'fulfilled' ? r.value
      : { edge: s.edges[i]?.url, ok: false, status: null, reason: String(r.reason?.message || r.reason || '푸시 실패').slice(0, 300) }));
    const sum = summarizeEdgePush(results);
    if (results.length) console.log(`[upgrade] 엣지 업그레이드 푸시: ${sum.ok}/${sum.total} 성공`);
    for (const f of sum.failed) console.warn(`[upgrade] 엣지 업그레이드 푸시 실패 ${f.edge}: ${f.reason}`);
    return results;
  }

  /** v2.737: 대기를 끝낸다(적용·설정 변경). */
  #clearDeferral() {
    if (this.deferTimer) { clearInterval(this.deferTimer); this.deferTimer = null; }
    this.deferral = null;
  }

  /**
   * v2.737: 자동 적용 직전 — 실행 중 스캔이 있으면 기다릴지 정한다(순수에 가깝다 — 상태만 갱신).
   * @returns {{wait:boolean, forced:boolean, scans:object[]}}
   */
  #deferDecision(latest, now = Date.now()) {
    const max = scanDeferMaxMs();
    const all = runningScans();
    // v2.741(감사 TIMING-03): 재시작 뒤 같은 작업에 다시 붙는 스캔(아이실론 분리 실행 du — scanJournal resumable)은 기다리지 않는다 —
    //   재시작이 와도 장비의 du 는 계속 돌고 다음 기동이 결과만 받는다. 예전에는 그것까지 '스캔 1개' 로 세어 거의 늘 상한까지 미뤘다.
    const detached = all.filter((x) => x.resumable);
    // v2.742(감사 RECENT-02): 시작하지 못한 '지금 수집' 대기 요청 — 기록이 남은 것은 재시작 뒤 대기열로 돌아오므로 기다리지 않고(queuedKept),
    //   기록을 못 남긴 것(쓰기 실패·SCAN_RESUME=0)은 재시작이 지우므로 기다린다.
    const queued = queuedScans();
    const queuedKept = queued.filter((x) => x.resumable);
    // v2.741(감사 TIMING-01 ③): 실행 중 VM 복제 잡도 기다린다(재시작이 오면 원본 VM 에 임시 스냅샷이 남는다 — 이어 받는 경로가 없다).
    // v2.742(감사 TIMING-04): 진행 중인 에이전트 대량 배포도 기다린다(재시작이 원격 설치를 중간에 끊는다 — 이어 받는 경로가 없다).
    const scans = [...all.filter((x) => !x.resumable), ...queued.filter((x) => !x.resumable).map((x) => ({ ...x, label: queuedLabel(x) })), ...runningVmClones(), ...runningBulkDeploys()];
    if (!scans.length || max <= 0) { const forced = false; this.#clearDeferral(); return { wait: false, forced, scans, detached, queuedKept }; }
    if (!this.deferral || this.deferral.latest !== latest) this.deferral = { since: now, until: now + max, latest, scans: [] };
    this.deferral.scans = scans.map((x) => ({ kind: x.kind, label: x.label, since: x.since }));
    if (now >= this.deferral.until) return { wait: false, forced: true, scans, detached, queuedKept };
    if (!this.deferTimer) {
      this.deferTimer = setInterval(() => { this.#deferTick().catch((e) => console.warn(`[upgrade] 대기 확인 실패: ${e?.message || e}`)); }, DEFER_RECHECK_MS);
      this.deferTimer.unref?.();
    }
    return { wait: true, forced: false, scans, detached, queuedKept };
  }

  /** v2.737: 대기 중 1분마다 — 스캔이 끝났거나 상한을 넘겼으면 곧바로 적용한다. */
  async #deferTick() {
    if (!this.deferral) { this.#clearDeferral(); return; }
    if (!this.settings.enabled || !this.settings.autoApply) { this.#clearDeferral(); return; }
    if (this.#ticking || this._applying) return;
    const latest = this.deferral.latest;
    // v2.740(B-07): 대기 시작 시각은 판정 **전에** 잡는다 — #deferDecision 이 스캔이 끝났으면 대기를 지워, 그 뒤에 읽으면 언제나 '0분 기다림' 이었다.
    const since = this.deferral.since;
    const d = this.#deferDecision(latest);
    if (d.wait) return;
    const waited = Date.now() - (since || Date.now());
    const note = `${d.forced ? `실행 중 스캔 ${d.scans.length}개가 대기 상한(${Math.round(scanDeferMaxMs() / 60_000)}분)을 넘겨 적용합니다 — ${joinOutlook(scansOnly(d.scans).length ? resumeOutlookText(scansOnly(d.scans)) : '', cloneOutlookText(d.scans))}` : `실행 중이던 스캔이 끝나 적용합니다(${Math.round(waited / 60_000)}분 기다림)`}${detachedNote(d.detached)}${queuedNote(d.queuedKept)}`;
    this.#clearDeferral();
    this.#ticking = true;
    const at = Date.now();
    let rec = { at, outcome: 'error' };
    try {
      console.log(`[upgrade] ${note}`);
      this.lastTick = { at, outcome: 'applying', latest, reason: note }; this.#save();
      const r = await this.apply({ source: 'auto', restart: true, trigger: 'auto' });
      rec = r.ok ? { at, outcome: 'applied', latest, version: r.version || null, reason: note } : { at, outcome: 'apply-failed', latest, reason: r.reason || null };
    } catch (e) {
      rec = { at, outcome: 'error', reason: String(e?.message || e).slice(0, 300) };
    } finally {
      this.lastTick = { ...rec, finishedAt: Date.now() };
      this.#save();
      this.#ticking = false;
    }
  }

  #restartTimer() {
    this.#clearDeferral();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.armedAt = null; this.armedMs = 0;
    const s = this.settings;
    // v2.591 L3: env·옛 파일의 값도 같은 범위로(저장 시 클램프만으로는 env 기본값이 새지 않는다).
    const ms = clampPollMs(s.pollIntervalMs);
    if (s.enabled && ms > 0) {
      this.timer = setInterval(() => this.tick().catch((e) => console.error('[upgrade] tick error:', e.message)), ms);
      this.timer.unref?.();
      this.armedAt = Date.now(); this.armedMs = ms;
      this.tick().catch(() => {});
    }
  }

  start() {
    this.enablePersistence();
    const s = this.settings;
    if (s.enabled) {
      console.log(`  ▸ auto-upgrade: enabled (watch=${s.watchDir || '-'}, remote=${s.remoteBase ? 'yes' : 'no'}, autoApply=${s.autoApply})`);
    }
    this.#restartTimer();
  }

  // v2.591 L3: 재진입 가드 — 확인이 주기를 넘기면(고RTT 원격 소스) 겹쳐 실행되고, autoApply 면 apply() 가 겹칠 수 있다.
  #ticking = false;
  // v2.736.2: 한 번의 결과를 lastTick 에 남긴다(언제·무엇을 했나 — 화면이 '자동 확인이 돌고 있는가' 를 말한다).
  async tick() {
    if (this.#ticking) return;
    this.#ticking = true;
    const at = Date.now();
    let rec = { at, outcome: 'error' };
    let dd = null;
    try {
      const check = await this.check({ trigger: 'auto' });
      // v2.740(B-02 ③): 두 출처 중 큰 버전 — 예전에는 원격 값을 먼저 써서 감시 폴더에만 있는 더 새 버전을 기록하지 않았다.
      const latest = newestVersion(check.remote?.latest, check.watch?.available ? check.watch.version : null);
      const newer = check.watch?.available || check.remote?.available;
      // v2.741(감사 RECENT-01): '확인하지 못했다' 는 '받을 것이 없다' 가 아니다 — 원격 확인 실패(available 은 rememberRemoteCheck 가
      //   false 로 둔다)는 대기 기록(since·until)과 1분 재확인을 그대로 둔다. 예전에는 실패 한 번이 대기를 지워 다음 성공 확인에서
      //   상한('늦어도 X')이 새로 시작됐다. 판정은 아래 'check-failed' 와 같은 조건이다.
      const checkFailed = !!(check.remote && check.remote.ok === false && !check.watch?.available);
      if (!this.settings.autoApply || (!newer && !checkFailed)) this.#clearDeferral(); // v2.737: 받을 것이 없어졌거나 자동 적용을 껐으면 대기도 끝
      // v2.736.2(리뷰 F3): 원격 소스·감시 폴더가 둘 다 없으면 아무것도 확인하지 않았다 — '최신' 이라 기록하지 않는다.
      if (!check.remote && !check.watch) rec = { at, outcome: 'no-source' };
      else if (checkFailed) rec = { at, outcome: 'check-failed', reason: check.remote.error || null };
      else if (!newer) rec = { at, outcome: 'up-to-date', latest };
      else if (!this.settings.autoApply) rec = { at, outcome: 'available', latest };
      else if ((dd = this.#deferDecision(latest)).wait) {
        // v2.737: 실행 중 스캔이 끝날 때까지(상한 안에서) 기다린다 — 1분마다 다시 보고 끝나면 곧바로 적용한다(#deferTick).
        const scans = this.deferral?.scans || [];
        rec = { at, outcome: 'deferred', latest, reason: `실행 중 스캔 ${scans.length}개(${scans.slice(0, 3).map((x) => x.label || x.kind).join(', ')})가 끝나면 적용합니다 — 늦어도 ${localStamp(this.deferral.until)}` }; // v2.740(B-08): UTC ISO 가 아니라 포탈 시각
      } else {
        if (dd?.forced) console.warn(`[upgrade] 실행 중 스캔 ${dd.scans.length}개 — 대기 상한(${Math.round(scanDeferMaxMs() / 60_000)}분)을 넘겨 적용합니다(${joinOutlook(scansOnly(dd.scans).length ? resumeOutlookText(scansOnly(dd.scans)) : '', cloneOutlookText(dd.scans))})`);
        this.#clearDeferral();
        // v2.741(TIMING-03): 기다리지 않은 분리 실행 du 가 있으면 그 사실을 기록에 남긴다(조용히 끊지 않는다).
        const dnote = `${detachedNote(dd?.detached)}${queuedNote(dd?.queuedKept)}`.replace(/^ · /, '');
        console.log(`[upgrade] 새 버전 감지 — 적용 후 재시작합니다${dnote ? ` — ${dnote}` : ''}`);
        // 적용 도중 프로세스가 끝나면(강제 종료 등) 결과가 남지 않는다 — '적용 시작' 을 먼저 남긴다(새 프로세스가 되살린다).
        this.lastTick = { at, outcome: 'applying', latest, ...(dnote ? { reason: dnote } : {}) }; this.#save();
        const r = await this.apply({ source: 'auto', restart: true, trigger: 'auto' });
        rec = r.ok ? { at, outcome: 'applied', latest, version: r.version || null, ...(dnote ? { reason: dnote } : {}) } : { at, outcome: 'apply-failed', latest, reason: r.reason || null };
      }
    } catch (e) {
      rec = { at, outcome: 'error', reason: String(e?.message || e).slice(0, 300) };
      throw e;
    } finally {
      this.lastTick = { ...rec, finishedAt: Date.now() };
      this.#save();
      this.#ticking = false;
    }
  }
}

export const upgradeManager = new UpgradeManager();
