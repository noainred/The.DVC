// v2.808: 업그레이드 화면 — '새 버전 발견 시 자동 적용 + 재시작' 체크와 저장·확인·적용·재시작 버튼은
// '자동 업그레이드 동작' 카드 **위**(화면 맨 위)에 둔다(사용자 요청 — 설정 카드 끝까지 한참 내려가야 했다).
// 상태가 있는 화면이라 소스 순서로 고정한다. 브라우저 확인(1440/400)은 커밋 보고에 있다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = stripComments(fs.readFileSync(path.join(here, 'Upgrade.jsx'), 'utf8'));

describe('v2.808 업그레이드 화면 — 실행 줄이 맨 위', () => {
  it('자동 적용 체크 → 버튼 4개 → AutoCard → 업그레이드 설정 카드 순서다', () => {
    const at = (re) => { const m = src.search(re); expect(m, String(re)).toBeGreaterThan(-1); return m; };
    const checkbox = at(/checked=\{form\.autoApply\}/);
    const save = at(/'설정 저장'/);
    const check = at(/'새 버전 확인'/);
    const apply = at(/'업그레이드 적용 \+ 재시작'/);
    const restart = at(/'프로세스 재시작'/);
    const autoCard = at(/<AutoCard status=\{status\} \/>/);
    const settingsCard = at(/<b>업그레이드 설정<\/b>/);
    expect(checkbox).toBeLessThan(save);
    expect(save).toBeLessThan(check);
    expect(check).toBeLessThan(apply);
    expect(apply).toBeLessThan(restart);
    expect(restart).toBeLessThan(autoCard);
    expect(autoCard).toBeLessThan(settingsCard);
    // 체크·버튼은 한 번만 그린다(설정 카드에 복제본을 남기지 않는다).
    expect(src.match(/checked=\{form\.autoApply\}/g)).toHaveLength(1);
    expect(src.match(/'프로세스 재시작'/g)).toHaveLength(1);
  });
  it('결과 문구(actionMsg)는 버튼 줄과 같은 카드에 남고, 설정 카드는 저장 위치를 안내한다', () => {
    const restart = src.search(/'프로세스 재시작'/);
    const msg = src.search(/actionMsg\(msg\.action, msg\.r\)/);
    const autoCard = src.search(/<AutoCard status=\{status\} \/>/);
    expect(restart).toBeLessThan(msg);
    expect(msg).toBeLessThan(autoCard);
    expect(src).toMatch(/바꾼 값은 화면 맨 위의 ‘설정 저장’ 버튼으로 저장합니다/);
    // 버튼 줄은 400px 에서 줄바꿈해야 한다(v2.580 가로 넘침 회귀 방지).
    expect(src).toMatch(/flexWrap: 'wrap' \}\}>\s*<button className="login-btn"[^>]*onClick=\{saveSettings\}/);
  });
});
