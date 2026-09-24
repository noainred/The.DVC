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
  restartProcess, pushBundleToEdge, vstr,
} from './upgrade.js';
import { resolveBundleBytes } from './bundleSource.js';
import { pushUpgradeToCollectors } from '../collector/upgradePush.js';
import { loadCollectors } from '../collector/registry.js';


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

class UpgradeManager {
  constructor() {
    this.settings = loadSettings();
    this.lastCheck = null;
    this.lastResult = null;
    this.timer = null;
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
      remoteVersionsUrl: s.remoteBase ? `${s.remoteBase.replace(/\/+$/, '')}/versions.json` : null,
      lastCheck: this.lastCheck,
      lastResult: this.lastResult,
    };
  }

  /** Persist edited settings and restart the background poller. */
  updateSettings(partial) {
    this.settings = saveSettings(partial);
    this.#restartTimer();
    return this.status();
  }

  /** Check both sources for an available newer version (no install). */
  async check() {
    const s = this.settings;
    const cur = currentVersion();
    const result = { at: Date.now(), current: cur };

    if (s.watchDir) {
      const found = findNewerArchive(s.watchDir, cur);
      result.watch = found ? { available: true, version: vstr(found.version), path: found.path } : { available: false };
    }
    if (s.remoteBase) {
      result.remote = await checkRemote(s.remoteBase, cur, { token: s.token });
    }
    this.lastCheck = result;
    return result;
  }

  /** Install the newest available bundle. source: 'auto' | 'watch' | 'remote'. */
  async apply({ source = 'auto', restart = false } = {}) {
    // single-flight — 적용 후 엣지/수집기 푸시(타깃당 최대 600s)가 끝나기 전에 다음 tick이나
    // 수동 apply가 겹치면 같은 installDir에 renameSync 스왑이 경합해 설치가 깨질 수 있다.
    if (this._applying) return { ok: false, reason: '업그레이드 적용이 이미 진행 중입니다.' };
    this._applying = true;
    try { return await this.#applyInner({ source, restart }); }
    finally { this._applying = false; }
  }

  async #applyInner({ source, restart }) {
    const s = this.settings;
    if (!s.installDir) return { ok: false, reason: '설치 경로(installDir)가 설정되지 않아 적용할 수 없습니다.' };
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

    this.lastResult = { at: Date.now(), source, ...res };
    if (res.ok) {
      // v2.605(감사 LEFT2605-04): 엣지 push 결과를 버리지 않는다 — 예전에는 .catch(() => {}) 로 통째로 버려 실패한 엣지가 구버전으로 남아도
      //   흔적이 없었다(형제 pushToCollectors 는 '성공 n/m' 을 찍는다). 요약을 lastResult 에 싣고 콘솔에도 남긴다(pushToEdges 안).
      const edgePush = await this.pushToEdges(res.appliedArchive).catch((e) => { console.warn(`[upgrade] 엣지 업그레이드 푸시 실패: ${e?.message || e}`); return null; });
      if (Array.isArray(edgePush) && edgePush.length) this.lastResult.edgePush = summarizeEdgePush(edgePush);
      await this.pushToCollectors().catch(() => {});
      if (restart) { setTimeout(() => restartProcess(), 250); res.restarting = true; }
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
    const results = await pushUpgradeToCollectors(bundle.bytes);
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
    const s = this.settings;
    // v2.591 L3: env·옛 파일의 값도 같은 범위로(저장 시 클램프만으로는 env 기본값이 새지 않는다).
    const ms = clampPollMs(s.pollIntervalMs);
    if (s.enabled && ms > 0) {
      this.timer = setInterval(() => this.tick().catch((e) => console.error('[upgrade] tick error:', e.message)), ms);
      this.timer.unref?.();
      this.tick().catch(() => {});
    }
  }

  start() {
    const s = this.settings;
    if (s.enabled) {
      console.log(`  ▸ auto-upgrade: enabled (watch=${s.watchDir || '-'}, remote=${s.remoteBase ? 'yes' : 'no'}, autoApply=${s.autoApply})`);
    }
    this.#restartTimer();
  }

  // v2.591 L3: 재진입 가드 — 확인이 주기를 넘기면(고RTT 원격 소스) 겹쳐 실행되고, autoApply 면 apply() 가 겹칠 수 있다.
  #ticking = false;
  async tick() {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const check = await this.check();
      const newer = check.watch?.available || check.remote?.available;
      if (newer && this.settings.autoApply) {
        console.log('[upgrade] 새 버전 감지 — 적용 후 재시작합니다');
        await this.apply({ source: 'auto', restart: true });
      }
    } finally { this.#ticking = false; }
  }
}

export const upgradeManager = new UpgradeManager();
