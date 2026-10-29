// v2.783(점검 Q2 P-B3 — 데이터 손실): '유령 키 정리' 확인창은 미리보기(dryRun) 결과의 실제 삭제 수·키로 묻고,
//   읽지 못한 출처가 있으면 묻지 않으며, 실제 요청은 미리 본 키 목록만 보낸다.
//   수정 전(77278f7): 확인창은 summary.ghostKeys 로 'N개' 라 묻고 body {} 로 서버 판정 전부를 지웠다(확인창 1개 · 실제 3건).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prunePlan, pruneDoneText } from './fleetPruneText.js';
import { stripComments } from '../../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('P-B3 prunePlan', () => {
  it('미리보기의 키·저장소별 수로 묻고, 그 키만 보낸다', () => {
    const p = prunePlan({ ok: true, dryRun: true, blocked: false, ghostKeys: 2, keys: ['ghost1', 'ghost2'], keysTotal: 2, wouldRemoveTags: 1, wouldRemoveAssign: 1, unreadable: [] });
    expect(p.kind).toBe('confirm');
    expect(p.keys).toEqual(['ghost1', 'ghost2']);
    expect(p.confirm).toContain('유령 키 2개');
    expect(p.confirm).toContain('분류 태그 1건');
    expect(p.confirm).toContain('소속 법인 1건');
    expect(p.confirm).toContain('ghost1, ghost2');
  });
  it('읽지 못한 출처가 있으면(blocked) 묻지 않고 사유를 보인다', () => {
    const p = prunePlan({ ok: true, dryRun: true, blocked: true, keys: ['devtag1'], unreadable: [{ source: 'ome', reason: "OME 연결 'OME-KR' 의 장비 목록을 이 기동에서 아직 받지 못했습니다" }] });
    expect(p.kind).toBe('blocked');
    expect(p.message).toContain('OME-KR');
    expect(p.keys).toBeUndefined();
  });
  it('실패 본문·빈 응답은 정리하지 않는다 · 지울 키가 없으면 묻지 않는다', () => {
    expect(prunePlan({ ok: false, reason: '권한 없음' }).kind).toBe('blocked');
    expect(prunePlan(null).kind).toBe('blocked');
    expect(prunePlan({ ok: true, blocked: false, keys: [] }).kind).toBe('none');
  });
  it('미리보기가 잘렸으면(keysTotal > keys) 그 사실을 말한다', () => {
    const p = prunePlan({ ok: true, blocked: false, keys: ['a', 'b'], keysTotal: 7, wouldRemoveTags: 7, wouldRemoveAssign: 0 });
    expect(p.confirm).toContain('전체 7개 중 이번에는 2개만');
  });
});

describe('P-B3 pruneDoneText', () => {
  it('제거 수와 건너뛴 수를 그대로 말하고, 없으면 숫자를 지어내지 않는다', () => {
    expect(pruneDoneText({ ok: true, removedKeys: 2, removedTags: 1, removedAssign: 1, skipped: 0 })).toBe('유령 키 2개 정리 완료 — 태그 1건 · 소속 1건 제거');
    expect(pruneDoneText({ ok: true, removedKeys: 1, removedTags: 0, removedAssign: 1, skipped: 1 })).toContain('유령이 아니게 된 1개는 지우지 않았습니다');
    expect(pruneDoneText({ ok: true })).not.toMatch(/\d/);
  });
});

describe('P-B3 FleetInventory 소스', () => {
  const src = stripComments(fs.readFileSync(path.join(here, 'FleetInventory.jsx'), 'utf8'));
  const body = src.slice(src.indexOf('const prune = async'), src.indexOf('if (err && !d) return'));
  it('확인창은 요약 숫자(summary.ghostKeys)가 아니라 미리보기 결과로 묻는다', () => {
    expect(body).toContain('dryRun: true');
    expect(body).toContain('prunePlan(');
    expect(body).not.toMatch(/ghostKeys/);
  });
  it('실제 요청은 미리 본 키 목록만 보내고, 실패 본문(409)을 성공으로 읽지 않는다', () => {
    expect(body).toMatch(/postJson\('\/insights\/fleet\/prune', \{ keys: plan\.keys \}\)/);
    expect(body).not.toMatch(/postJson\('\/insights\/fleet\/prune', \{\}\)/);
    expect(body).toMatch(/requireChanged\(await postJson\('\/insights\/fleet\/prune', \{ keys/);
  });
});
