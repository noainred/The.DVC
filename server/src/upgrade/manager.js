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
import { resolveBundleBytes } from './bundleSource.js';
import { pushUpgradeToCollectors } from '../collector/upgradePush.js';
import { loadCollectors } from '../collector/registry.js';
// v2.736.2(사용자 신고 — 자동 업그레이드가 왜 안 되는지 화면이 말하지 않았다): 상태 판정 + 기록 정제 + 재시작 뒤에도 남는 기록.
import { autoUpgradeState, sanitizeCheck, sanitizeResult, sanitizeTick, restoreStatus } from './autoState.js';
import { upgradeStatusFile, readUpgradeStatus, writeUpgradeStatus } from './statusStore.js';


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
        now: Date.now(),
      }),
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

    if ((source === 'auto' || source === 'watch') && s.watchDir) {
      const found = findNewerArchive(s.watchDir, cur);
      if (found) res = upgradeFromArchive(found.path, s.installDir, cur, s.packageName);
    }
    if (!res?.ok && (source === 'auto' || source === 'remote') && s.remoteBase) {
      res = await upgradeFromRemote(s.remoteBase, s.installDir, cur, s.downloadDir, { token: s.token, pkgName: s.packageName });
    }
    if (!res) res = { ok: false, reason: '적용할 업그레이드 소스가 없습니다 (감시 폴더/원격 미설정).' };

    if (res.ok && restart) res.restarting = true; // 재시작 직전에 기록이 파일에 남도록 먼저 표시한다
    this.lastResult = { at: Date.now(), source, trigger, ...res };
    if (res.ok) {
      // v2.605(감사 LEFT2605-04): 엣지 push 결과를 버리지 않는다 — 예전에는 .catch(() => {}) 로 통째로 버려 실패한 엣지가 구버전으로 남아도
      //   흔적이 없었다(형제 pushToCollectors 는 '성공 n/m' 을 찍는다). 요약을 lastResult 에 싣고 콘솔에도 남긴다(pushToEdges 안).
      const edgePush = await this.pushToEdges(res.appliedArchive).catch((e) => { console.warn(`[upgrade] 엣지 업그레이드 푸시 실패: ${e?.message || e}`); return null; });
      if (Array.isArray(edgePush) && edgePush.length) { this.#lastResult.edgePush = summarizeEdgePush(edgePush); this.#save(); }
      await this.pushToCollectors().catch(() => {});
      if (restart) setTimeout(() => restartProcess(), 250);
    }
    return res;
  }

  /**
   * After a successful self-upgrade, push the same bundle to every registered
   * collector agent so all datacenters stay on the same version automatically.
   */
  async pushToCollectors() {
    if (!loadCollectors().some((c) => c.enabled !== false)) return [];
    const bundle = await resolveBundleBytes(this.settings);
    if (!bundle) return [];
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
    const results = await Promise.all(s.edges.map((e) => pushBundleToEdge(e, bundle)));
    const sum = summarizeEdgePush(results);
    if (results.length) console.log(`[upgrade] 엣지 업그레이드 푸시: ${sum.ok}/${sum.total} 성공`);
    for (const f of sum.failed) console.warn(`[upgrade] 엣지 업그레이드 푸시 실패 ${f.edge}: ${f.reason}`);
    return results;
  }

  #restartTimer() {
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
    try {
      const check = await this.check({ trigger: 'auto' });
      const latest = check.remote?.latest || check.watch?.version || null;
      const newer = check.watch?.available || check.remote?.available;
      if (check.remote && check.remote.ok === false && !check.watch?.available) rec = { at, outcome: 'check-failed', reason: check.remote.error || null };
      else if (!newer) rec = { at, outcome: 'up-to-date', latest };
      else if (!this.settings.autoApply) rec = { at, outcome: 'available', latest };
      else {
        console.log('[upgrade] 새 버전 감지 — 적용 후 재시작합니다');
        // 적용 도중 프로세스가 끝나면(강제 종료 등) 결과가 남지 않는다 — '적용 시작' 을 먼저 남긴다(새 프로세스가 되살린다).
        this.lastTick = { at, outcome: 'applying', latest }; this.#save();
        const r = await this.apply({ source: 'auto', restart: true, trigger: 'auto' });
        rec = r.ok ? { at, outcome: 'applied', latest, version: r.version || null } : { at, outcome: 'apply-failed', latest, reason: r.reason || null };
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
