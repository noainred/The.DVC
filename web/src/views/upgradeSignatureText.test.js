// v2.730 S-10·I-08 — 업그레이드 화면 '릴리스 서명' 칸 문구(그룹 K).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  policyText, trustText, lastVerifyText, countsText, remoteLastGoodText, whereText, WHERE_LABEL,
} from './upgradeSignatureText.js';

const NOW = 1_800_000_000_000;

describe('정책 문구', () => {
  it('require 는 ok, warn 은 bad, 알 수 없는 설정값은 필수로 본다고 말한다', () => {
    expect(policyText({ policy: 'require' }).tone).toBe('ok');
    expect(policyText({ policy: 'warn' }).tone).toBe('bad');
    const inv = policyText({ policy: 'require', policyInvalid: 'off' });
    expect(inv.tone).toBe('warn');
    expect(inv.text).toContain('off');
    expect(inv.text).toContain('필수');
    expect(policyText(null).tone).toBe('muted');
  });
});

describe('신뢰 공개키 문구', () => {
  it('0개면 정책에 따라 bad/warn — 설치 거부 사실을 말한다', () => {
    const t = trustText({ trustedKeys: 0, revokedKeys: 0, policy: 'require' });
    expect(t.tone).toBe('bad');
    expect(t.text).toContain('설치하지 않습니다');
    expect(trustText({ trustedKeys: 0, policy: 'warn' }).tone).toBe('warn');
  });
  it('키 개수와 회수 개수를 밝힌다', () => {
    const t = trustText({ trustedKeys: 2, revokedKeys: 1, policy: 'require' });
    expect(t.text).toBe('2개 · 회수 1개');
    expect(t.tone).toBe('ok');
  });
  it('신뢰 파일을 못 읽으면 사유와 함께 bad', () => {
    const t = trustText({ trustedKeys: 3, fatal: '호스트 키 파일 권한이 넓습니다' });
    expect(t.tone).toBe('bad');
    expect(t.text).toContain('권한');
  });
  it('개수를 모르면 0 으로 지어내지 않는다', () => {
    expect(trustText({ trustedKeys: null }).text).toBe('—');
    expect(trustText({}).text).toBe('—');
  });
});

describe('마지막 검증 문구', () => {
  it('없으면 아직 없다고 말한다', () => {
    expect(lastVerifyText({ last: null }).text).toContain('아직');
  });
  it('확인·경고 허용·거부를 나눈다', () => {
    const at = NOW - 3 * 60_000;
    const ok = lastVerifyText({ last: { at, where: 'remote', ok: true, verified: true, version: '2.730.0', keyId: 'ed25519:abcd' } }, NOW);
    expect(ok.tone).toBe('ok');
    expect(ok.text).toContain('v2.730.0');
    expect(ok.text).toContain('원격 다운로드');
    expect(ok.text).toContain('3분 전');
    expect(ok.detail).toContain('ed25519:abcd');
    const w = lastVerifyText({ last: { at, where: 'watch', ok: true, verified: false, warned: true, reason: '서명 manifest 가 없습니다' } }, NOW);
    expect(w.tone).toBe('warn');
    expect(w.detail).toContain('manifest');
    const r = lastVerifyText({ last: { at, where: 'push-edge', ok: false, verified: false, reason: '서명 검증 실패 — 해시 불일치' } }, NOW);
    expect(r.tone).toBe('bad');
    expect(r.text).toContain('거부');
    expect(r.text).toContain('중앙에서 받은 번들');
  });
  it('모르는 경로 이름은 원문 그대로(지어내지 않는다)', () => {
    expect(whereText('new-path')).toBe('new-path');
    expect(whereText(null)).toBe('—');
  });
});

describe('누적·원격 직전 정상', () => {
  it('누적이 전부 0 이면 빈 문자열', () => {
    expect(countsText({ counts: { verified: 0, warned: 0, rejected: 0 } })).toBe('');
    expect(countsText({ counts: { verified: 2, warned: 0, rejected: 1 } })).toContain('거부 1');
  });
  it('lastGood 이 없으면 null, 있으면 참고용임을 말한다', () => {
    expect(remoteLastGoodText({ ok: false })).toBe(null);
    const t = remoteLastGoodText({ ok: false, lastGood: { checkedAt: NOW - 2 * 3_600_000, latest: '2.729.0' } }, NOW);
    expect(t).toContain('v2.729.0');
    expect(t).toContain('2시간 전');
    expect(t).toContain('참고용');
  });
});

describe('서버 where 값과 대조', () => {
  it('서버가 쓰는 where 값 전부에 이름이 있다', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/src');
    const files = ['upgrade/upgrade.js', 'upgrade/bundleSource.js', 'upgrade/fetchPackage.js', 'upgrade/verifyCli.js', 'routes/upgrade.js', 'routes/collector.js'];
    const seen = new Set();
    for (const f of files) {
      const s = fs.readFileSync(path.join(root, f), 'utf8');
      for (const m of s.matchAll(/where:\s*'([a-z-]+)'/g)) seen.add(m[1]);
    }
    // upgradeFromArchive 의 기본값('watch')·upgradeFromBundleBytes 의 기본값('push')
    seen.add('watch'); seen.add('push');
    const missing = [...seen].filter((w) => !WHERE_LABEL[w]);
    expect(missing).toEqual([]);
    expect(seen.size).toBeGreaterThan(5);
  });
  it('문구에 백틱이 없다', () => {
    const s = fs.readFileSync(fileURLToPath(new URL('./upgradeSignatureText.js', import.meta.url)), 'utf8');
    const strings = [...s.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]).join('\n');
    expect(strings.includes('`')).toBe(false);
  });
});
