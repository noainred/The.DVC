import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import { currentVersion } from '../config.js';
import { requireRole } from '../auth/auth.js';
import { upgradeManager } from '../upgrade/manager.js';
import { upgradeFromBundleBytes, restartProcess } from '../upgrade/upgrade.js';

export const upgradeRouter = Router();

// All control endpoints require the admin role.
const adminOnly = requireRole('admin');

// Current upgrade status (version, config summary, last check/result).
upgradeRouter.get('/status', adminOnly, (_req, res) => {
  res.json(upgradeManager.status());
});

// Check both sources for a newer version (no install).
upgradeRouter.post('/check', adminOnly, async (_req, res) => {
  if (!upgradeManager.enabled) return res.status(409).json({ ok: false, reason: 'auto-upgrade disabled' });
  res.json(await upgradeManager.check());
});

// Apply the newest available bundle. Body: { source?: 'auto'|'watch'|'remote', restart?: bool }
upgradeRouter.post('/apply', adminOnly, async (req, res) => {
  if (!upgradeManager.enabled) return res.status(409).json({ ok: false, reason: 'auto-upgrade disabled' });
  const { source = 'auto', restart = false } = req.body || {};
  res.json(await upgradeManager.apply({ source, restart: Boolean(restart) }));
});

// Re-exec the process (loads freshly installed code). Allowed even if the
// upgrade feature is off, so admins can restart after a manual reinstall.
upgradeRouter.post('/restart', adminOnly, (_req, res) => {
  res.json({ ok: true, restarting: true });
  setTimeout(() => restartProcess(), 250);
});

// Read the editable upgrade settings (token redacted).
upgradeRouter.get('/settings', adminOnly, (_req, res) => {
  res.json(upgradeManager.status());
});

// Update upgrade settings from the portal (internet/remote + manual/watch).
upgradeRouter.put('/settings', adminOnly, (req, res) => {
  const b = req.body || {};
  const allowed = ['enabled', 'watchDir', 'installDir', 'packageName', 'remoteBase', 'token', 'pollIntervalMs', 'autoApply'];
  const partial = {};
  for (const k of allowed) if (b[k] !== undefined) partial[k] = b[k];
  res.json({ ok: true, settings: upgradeManager.updateSettings(partial) });
});

// Edge endpoint: accept a tar.gz bundle pushed by the portal and self-install.
// Raw gzip body; admin-gated like the rest.
upgradeRouter.post('/bundle', adminOnly, express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '256mb' }),
  (req, res) => {
    const s = upgradeManager.settings;
    if (!upgradeManager.enabled) return res.status(409).json({ ok: false, reason: 'auto-upgrade disabled' });
    if (!s.installDir) return res.status(409).json({ ok: false, reason: 'installDir not set' });
    if (!req.body || !req.body.length) return res.status(400).json({ ok: false, reason: 'empty bundle' });

    const result = upgradeFromBundleBytes(req.body, s.installDir, currentVersion(), s.packageName);
    upgradeManager.lastResult = { at: Date.now(), source: 'edge-push', ...result };
    res.json(result);
    if (result.ok && String(req.query.restart) === 'true') setTimeout(() => restartProcess(), 250);
  });
