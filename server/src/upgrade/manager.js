/**
 * Orchestrates the auto-upgrade feature for the running portal: tracks the last
 * check, runs the optional background watcher (local folder + remote source),
 * applies newer bundles, pushes them to edges, and re-execs the process.
 *
 * Everything here is a no-op unless config.upgrade.enabled is true (opt-in).
 */

import path from 'node:path';
import { config, currentVersion } from '../config.js';
import {
  findNewerArchive, upgradeFromArchive, checkRemote, upgradeFromRemote,
  restartProcess, pushBundleToEdge, vstr,
} from './upgrade.js';

class UpgradeManager {
  constructor() {
    this.cfg = config.upgrade;
    this.lastCheck = null;     // { at, watch, remote }
    this.lastResult = null;    // last apply result
    this.timer = null;
  }

  get enabled() {
    return this.cfg.enabled;
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      version: currentVersion(),
      watchDir: this.cfg.watchDir || null,
      installDir: this.cfg.installDir || null,
      packageName: this.cfg.packageName,
      remoteConfigured: Boolean(this.cfg.remoteBase),
      remoteBase: this.cfg.remoteBase || null,
      remoteVersionsUrl: this.cfg.remoteBase ? `${this.cfg.remoteBase.replace(/\/+$/, '')}/versions.json` : null,
      autoApply: this.cfg.autoApply,
      pollIntervalMs: this.cfg.pollIntervalMs,
      edges: this.cfg.edges.map((e) => e.url),
      lastCheck: this.lastCheck,
      lastResult: this.lastResult,
    };
  }

  /** Check both sources for an available newer version (no install). */
  async check() {
    const cur = currentVersion();
    const result = { at: Date.now(), current: cur };

    if (this.cfg.watchDir) {
      const found = findNewerArchive(this.cfg.watchDir, cur);
      result.watch = found
        ? { available: true, version: vstr(found.version), path: found.path }
        : { available: false };
    }
    if (this.cfg.remoteBase) {
      result.remote = await checkRemote(this.cfg.remoteBase, cur, { token: this.cfg.token });
    }
    this.lastCheck = result;
    return result;
  }

  /** Install the newest available bundle. source: 'auto' | 'watch' | 'remote'. */
  async apply({ source = 'auto', restart = false } = {}) {
    if (!this.cfg.installDir) {
      return { ok: false, reason: 'UPGRADE_INSTALL_DIR is not set; refusing to apply' };
    }
    const cur = currentVersion();
    const { installDir, packageName, watchDir, remoteBase, token, downloadDir } = this.cfg;
    let res = null;

    if ((source === 'auto' || source === 'watch') && watchDir) {
      const found = findNewerArchive(watchDir, cur);
      if (found) res = upgradeFromArchive(found.path, installDir, cur, packageName);
    }
    if (!res?.ok && (source === 'auto' || source === 'remote') && remoteBase) {
      res = await upgradeFromRemote(remoteBase, installDir, cur, downloadDir, { token, pkgName: packageName });
    }
    if (!res) res = { ok: false, reason: 'no upgrade source produced a candidate' };

    this.lastResult = { at: Date.now(), source, ...res };

    if (res.ok) {
      await this.pushToEdges(res.appliedArchive).catch(() => {});
      if (restart) {
        setTimeout(() => restartProcess(), 250);
        res.restarting = true;
      }
    }
    return res;
  }

  /** Push the most relevant bundle to all configured edges (best-effort). */
  async pushToEdges(archivePath) {
    if (!this.cfg.edges.length) return [];
    // Prefer an explicit archive; otherwise the newest local bundle.
    let bundle = archivePath;
    if (!bundle && this.cfg.watchDir) {
      const found = findNewerArchive(this.cfg.watchDir, '0.0.0');
      bundle = found?.path;
    }
    if (!bundle) return [];
    return Promise.all(this.cfg.edges.map((e) => pushBundleToEdge(e, bundle)));
  }

  start() {
    if (!this.cfg.enabled) return;
    console.log(`  ▸ auto-upgrade: enabled (watch=${this.cfg.watchDir || '-'}, remote=${this.cfg.remoteBase ? 'yes' : 'no'}, autoApply=${this.cfg.autoApply})`);
    if (this.cfg.pollIntervalMs > 0) {
      this.timer = setInterval(() => this.tick().catch((e) => console.error('[upgrade] tick error:', e.message)), this.cfg.pollIntervalMs);
      this.timer.unref?.();
      this.tick().catch(() => {});
    }
  }

  async tick() {
    const check = await this.check();
    const newer = check.watch?.available || check.remote?.available;
    if (newer && this.cfg.autoApply) {
      console.log('[upgrade] newer version detected — applying and restarting');
      await this.apply({ source: 'auto', restart: true });
    }
  }
}

export const upgradeManager = new UpgradeManager();
