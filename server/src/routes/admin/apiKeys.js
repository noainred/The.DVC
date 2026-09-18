/**
 * 설정 › 연동 키 — 외부 포탈용 API 키 관리 라우트 (v2.562).
 *
 * ⚠⚠ **게이트는 `adminOnly + requireSettingsOwner` 다.** 이 키는 전 함대의 조회 데이터에
 * **상시** 접근 권한을 주는 자격증명이므로, 백업 아카이브·중앙 토큰 배달 경로와 같은 등급으로
 * 다룬다(`server/CLAUDE.md` — 백업 라우트 전부에 `requireSettingsOwner`, v2.210 · H3).
 * adminOnly 만 두면 소유자가 아닌 admin 이 스스로 키를 발급해 범위 경계를 우회할 수 있다.
 *
 * ⚠⚠ **평문 키는 발급 응답에만 실린다.** 목록·단건·수정 응답에는 절대 없다(`publicKey()` 가
 * `hash` 를 빼고 돌려준다). 화면이 그 사실을 먼저 말하고, 잃으면 재발급뿐이다.
 *
 * ⚠ 전부 `logAudit` 한다 — **키 값은 남기지 않고** 이름과 앞 8자 지문만(v2.419 규약).
 */

import express from 'express';
import { adminOnly, requireSettingsOwner } from './shared.js';
import { logAudit } from '../../audit.js';
import {
  issueApiKey, revokeApiKey, deleteApiKey, updateApiKey, listApiKeys, DEFAULT_RPM, KEY_PREFIX,
} from '../../publicapi/keys.js';
import { GROUPS, ENDPOINTS } from '../../publicapi/allowlist.js';

export function registerApiKeys(adminRouter) {
  const owner = [adminOnly, requireSettingsOwner];

  /**
   * 목록 + 카탈로그. 화면이 분류 라벨·설명·엔드포인트를 **서버에서 받아** 쓴다 —
   * 문구를 웹에 복제하면 분류를 늘린 날 화면만 낡는다(CLAUDE.md '코어는 하나다').
   */
  adminRouter.get('/api-keys', adminOnly, (_req, res) => {
    const keys = listApiKeys();
    res.json({
      ok: true,
      keys,
      groups: GROUPS,
      endpoints: ENDPOINTS.map((e) => ({
        path: e.path, method: e.method, group: e.group, summary: e.summary,
        fields: e.fields, requiresFullScope: !!e.requiresFullScope, scoped: !!e.scoped,
      })),
      defaults: { rpm: DEFAULT_RPM, prefix: KEY_PREFIX },
      /*
       * 화면이 '지금 무슨 상태인가' 를 세는 근거 — 겹치지 않게 나눈다(v2.553 KPI 규약).
       * ⚠ `합계 = 사용중 + 폐기 + 만료 + 분류없음` 이 성립해야 한다.
       */
      counts: (() => {
        const now = Date.now();
        let live = 0; let revoked = 0; let expired = 0; let noGroups = 0;
        for (const k of keys) {
          if (k.revokedAt) { revoked += 1; continue; }
          if (k.expiresAt != null && now > k.expiresAt) { expired += 1; continue; }
          if (!(k.groups || []).length) { noGroups += 1; continue; }
          live += 1;
        }
        return { total: keys.length, live, revoked, expired, noGroups };
      })(),
    });
  });

  /**
   * 발급. **평문은 이 응답에만** 있다.
   * ⚠ 응답의 `plaintext` 를 로그·감사에 남기지 말 것.
   */
  adminRouter.post('/api-keys', owner, (req, res) => {
    const { key, plaintext, issues } = issueApiKey(req.body || {}, req.user?.username || '');
    if (!key) return res.status(400).json({ ok: false, reason: issues[0] || '발급할 수 없습니다.', issues });
    logAudit({
      user: req.user?.username || 'unknown',
      action: 'apikey.issue',
      target: key.name,
      // ⚠ 지문만 — 평문을 남기면 발급의 의미가 없다.
      detail: `${key.fp} · groups=${key.groups.join('|') || '(없음)'} · vcenters=${key.vcenters.length || '전체'} · rpm=${key.rpm}`,
    });
    res.json({
      ok: true, key, plaintext, issues,
      warning: '이 값은 지금 한 번만 보입니다 — 서버는 해시만 보관합니다. 잃으면 재발급해야 합니다.',
    });
  });

  /** 수정 — 허용 분류·범위·만료·상한만. 키 값은 바뀌지 않는다. */
  adminRouter.patch('/api-keys/:id', owner, (req, res) => {
    const r = updateApiKey(req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason, issues: r.issues || [] });
    logAudit({
      user: req.user?.username || 'unknown', action: 'apikey.update', target: r.key.name,
      detail: `${r.key.fp} · groups=${r.key.groups.join('|') || '(없음)'} · vcenters=${r.key.vcenters.length || '전체'}`,
    });
    res.json({ ok: true, key: r.key, issues: r.issues || [] });
  });

  /** 폐기 — 행은 남기고 `revokedAt` 을 찍는다(감사 흔적). 같은 값은 다시 살아나지 않는다. */
  adminRouter.post('/api-keys/:id/revoke', owner, (req, res) => {
    const r = revokeApiKey(req.params.id, req.user?.username || '');
    if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason });
    logAudit({ user: req.user?.username || 'unknown', action: 'apikey.revoke', target: r.key.name, detail: r.key.fp });
    res.json({ ok: true, key: r.key });
  });

  /** 완전 삭제 — 폐기된 것만(산 키를 실수로 지우지 못하게). */
  adminRouter.delete('/api-keys/:id', owner, (req, res) => {
    const before = listApiKeys().find((k) => k.id === req.params.id);
    const r = deleteApiKey(req.params.id);
    if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason });
    logAudit({ user: req.user?.username || 'unknown', action: 'apikey.delete', target: before?.name || req.params.id, detail: before?.fp || '' });
    res.json({ ok: true });
  });
}

export default registerApiKeys;
