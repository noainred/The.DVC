import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentVersion, config } from '../config.js';
import { requireRole } from '../auth/auth.js';
import { upgradeManager } from '../upgrade/manager.js';
import { upgradeFromBundleBytes, restartProcess } from '../upgrade/upgrade.js';
import { ssrfBlockReason } from '../collector/registry.js';

export const upgradeRouter = Router();

// ── PUT /settings 입력 검증(감사 H16) ─────────────────────────────────────────
// installDir는 업그레이드 시 '디렉터리 통째 교체' 대상이고 watchDir는 번들 탐색 경로,
// remoteBase/edges[].url은 서버가 직접 호출하는 주소다. 형식 무검증 수용은 경로 이탈(예:
// installDir=/etc)과 SSRF로 이어지므로 저장 전에 막는다.
// ★ 실제 배포 기본값이 반드시 통과해야 한다: installDir=/opt/vmware-portal/app,
//   CONFIG_DIR=/etc/vmware-portal(패키지 폴더가 그 하위), remoteBase=GitHub releases,
//   폐쇄망 사내 미러(http://10.x.x.x:4000/dl) → 모두 아래 규칙을 통과한다.
// 특이 배치(예: /usr/local 외 다른 prefix, Windows 경로)로 정상 설정이 거부되면
// UPGRADE_PATH_ALLOW_BASES(':' 또는 ',' 구분)로 베이스를 추가하거나 UPGRADE_PATH_CHECK=off.
function allowedPathBases() {
  const extra = String(process.env.UPGRADE_PATH_ALLOW_BASES || '').split(/[:,]/);
  return [
    config.configDir,               // CONFIG_DIR(=/etc/vmware-portal) — packages/ 가 그 하위
    config.appRoot,                 // 실행 중인 앱 루트(엣지 자동 installDir 기본값)
    path.dirname(config.appRoot),   // 앱 설치 prefix(예: /opt/vmware-portal/app → /opt/vmware-portal)
    config.upgrade?.downloadDir || '',
    config.packages?.dir || '',
    os.tmpdir(),
    '/etc/vmware-portal',           // 오프라인 패키지의 표준 CONFIG_DIR(다른 CONFIG_DIR로 떠 있어도 허용)
    '/opt', '/var', '/srv', '/data', '/app', '/mnt', '/media', '/home',
    '/usr/local', '/usr/share', '/usr/lib',
    ...extra,
  ].map((b) => String(b || '').trim()).filter(Boolean).map((b) => path.resolve(b));
}

function pathReason(label, raw) {
  const v = String(raw).trim();
  if (!v) return null; // 빈 값 = 미설정(기존 동작 유지 — 원격만 쓰는 구성)
  if (v.includes('\0') || [...v].some((c) => c.charCodeAt(0) < 32)) return `${label}에 사용할 수 없는 문자가 있습니다.`;
  if (!path.isAbsolute(v)) return `${label}는 절대경로여야 합니다.`;
  if (v.split(/[\\/]+/).includes('..')) return `${label}에 상위 경로(..)는 사용할 수 없습니다.`;
  if (String(process.env.UPGRADE_PATH_CHECK || '').toLowerCase() === 'off') return null;
  const abs = path.resolve(v);
  const bases = allowedPathBases();
  const under = bases.some((b) => abs === b || abs.startsWith(b.endsWith(path.sep) ? b : b + path.sep));
  if (!under) return `${label}가 허용 범위를 벗어났습니다: ${abs} (허용: ${bases.join(', ')} 하위. 다른 위치가 필요하면 UPGRADE_PATH_ALLOW_BASES 또는 UPGRADE_PATH_CHECK=off)`;
  return null;
}

function urlReason(label, raw) {
  const v = String(raw).trim();
  if (!v) return null; // 빈 값 = 원격 소스 미사용
  if (!/^https?:\/\//i.test(v)) return `${label}는 http:// 또는 https:// URL이어야 합니다.`;
  const ssrf = ssrfBlockReason(v);
  if (ssrf) return `${label}: ${ssrf}`;
  return null;
}

/** 업그레이드 설정 부분 업데이트 검증. 문제가 있으면 한국어 사유, 없으면 null. */
export function validateUpgradeSettings(body = {}) {
  for (const [k, label] of [['installDir', '설치 경로(installDir)'], ['watchDir', '감시 폴더(watchDir)']]) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'string') return `${label}는 문자열이어야 합니다.`;
    const r = pathReason(label, body[k]);
    if (r) return r;
  }
  if (body.remoteBase !== undefined) {
    if (typeof body.remoteBase !== 'string') return '원격 소스(remoteBase)는 문자열이어야 합니다.';
    const r = urlReason('원격 소스(remoteBase)', body.remoteBase);
    if (r) return r;
  }
  // edges는 현재 이 라우트에서 저장하지 않지만(allowed 목록 미포함), 클라이언트가 보내면
  // 검증해 잘못된/내부 주소가 조용히 통과·저장되는 회귀를 막는다.
  if (body.edges !== undefined) {
    if (!Array.isArray(body.edges)) return '엣지 목록(edges)은 배열이어야 합니다.';
    for (const e of body.edges) {
      const u = typeof e === 'string' ? e : e?.url;
      if (!u || typeof u !== 'string') return '엣지 URL(edges[].url)이 필요합니다.';
      const r = urlReason('엣지 URL(edges[].url)', u);
      if (r) return r;
    }
  }
  return null;
}

// ── 설치 경로 자동 감지 ───────────────────────────────────────────────────────
// 실행 중인 프로세스가 로드한 앱 루트(config.appRoot = server/..)가 곧 업그레이드 스왑
// 대상이다. 추측이 아니라 실제 실행 경로에서 도출하고, applyPackage의 renameSync 스왑이
// 성립하는 조건(부모 디렉터리 쓰기 권한 — 백업/스테이징이 형제 경로로 생성됨)과 저장 시
// 통과해야 하는 경로 정책까지 함께 점검해 근거를 응답에 싣는다. 저장은 하지 않는다 —
// 클라이언트가 폼에 채운 뒤 기존 PUT /settings 검증 경로로 저장한다.
export function detectInstallState(dir) {
  const abs = path.resolve(String(dir));
  const parent = path.dirname(abs);
  const checks = [];

  let version = null;
  try {
    version = String(JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')).version || '') || null;
  } catch { /* 아래에서 실패로 보고 */ }
  checks.push({
    key: 'package', ok: Boolean(version),
    label: version ? `package.json 확인 (v${version})` : 'package.json을 읽지 못했습니다 — 앱 루트가 아닐 수 있습니다',
  });

  const hasServer = fs.existsSync(path.join(abs, 'server', 'src'));
  checks.push({
    key: 'layout', ok: hasServer,
    label: hasServer ? 'server/src 디렉터리 확인' : 'server/src 디렉터리가 없습니다',
  });

  let parentWritable = false;
  try { fs.accessSync(parent, fs.constants.W_OK); parentWritable = true; } catch { /* 권한 없음 */ }
  checks.push({
    key: 'writable', ok: parentWritable,
    label: parentWritable
      ? `부모 디렉터리 쓰기 가능 (${parent}) — 백업/스왑 가능`
      : `부모 디렉터리(${parent}) 쓰기 권한이 없어 업그레이드 스왑(rename)이 실패합니다 — 서비스 계정 권한을 확인하세요`,
  });

  const policy = validateUpgradeSettings({ installDir: abs });
  checks.push({ key: 'policy', ok: !policy, label: policy || '경로 정책(허용 베이스) 통과' });

  return { installDir: abs, version, ok: checks.every((c) => c.ok), checks };
}

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

// 현재 서버 상태를 분석해 설치 경로(installDir) 자동 감지값과 점검 근거를 돌려준다(읽기 전용).
upgradeRouter.get('/detect-install', adminOnly, (_req, res) => {
  const out = detectInstallState(config.appRoot);
  out.source = '실행 중인 프로세스의 앱 루트';
  // 환경변수로 다른 경로가 강제돼 있으면 참고로 함께 알린다(감지값과 다를 때만).
  const envDir = String(process.env.UPGRADE_INSTALL_DIR || '').trim();
  if (envDir && path.resolve(envDir) !== out.installDir) out.envInstallDir = path.resolve(envDir);
  res.json(out);
});

// Update upgrade settings from the portal (internet/remote + manual/watch).
upgradeRouter.put('/settings', adminOnly, (req, res) => {
  const b = req.body || {};
  // 경로/URL 형식 검증 — 통과하지 못하면 저장하지 않는다(감사 H16).
  const bad = validateUpgradeSettings(b);
  if (bad) return res.status(400).json({ ok: false, reason: bad });
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
