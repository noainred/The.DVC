/**
 * Orchestrates the auto-upgrade feature for the running portal: tracks the last
 * check, runs the optional background watcher (local folder + remote source),
 * applies newer bundles, pushes them to edges, and re-execs the process.
 *
 * Settings come from settings.js (env defaults + values edited in the admin UI)
 * and can be reloaded at runtime. Everything is a no-op unless enabled.
 */

import { currentVersion } from '../config.js';
import { loadSettings, saveSettings, redactSettings } from './settings.js';
import {
  findNewerArchive, upgradeFromArchive, checkRemote, upgradeFromRemote,
  restartProcess, pushBundleToEdge, vstr,
} from './upgrade.js';

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
    const s = this.settings;
    if (!s.installDir) return { ok: false, reason: '설치 경로(installDir)가 설정되지 않아 적용할 수 없습니다.' };
    const cur = currentVersion();
    let res = null;

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
      await this.pushToEdges(res.appliedArchive).catch(() => {});
      if (restart) { setTimeout(() => restartProcess(), 250); res.restarting = true; }
    }
    return res;
  }

  async pushToEdges(archivePath) {
    const s = this.settings;
    if (!s.edges?.length) return [];
    let bundle = archivePath;
    if (!bundle && s.watchDir) bundle = findNewerArchive(s.watchDir, '0.0.0')?.path;
    if (!bundle) return [];
    return Promise.all(s.edges.map((e) => pushBundleToEdge(e, bundle)));
  }

  #restartTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const s = this.settings;
    if (s.enabled && s.pollIntervalMs > 0) {
      this.timer = setInterval(() => this.tick().catch((e) => console.error('[upgrade] tick error:', e.message)), s.pollIntervalMs);
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

  async tick() {
    const check = await this.check();
    const newer = check.watch?.available || check.remote?.available;
    if (newer && this.settings.autoApply) {
      console.log('[upgrade] 새 버전 감지 — 적용 후 재시작합니다');
      await this.apply({ source: 'auto', restart: true });
    }
  }
}

export const upgradeManager = new UpgradeManager();
