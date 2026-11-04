import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// v2.882.1 Bareos 백업 대상 상세 패널 머리 줄 — 1440(패널 폭 약 320px)에서 이름 + 실행 배지 + OS 배지가 넘치면
// 한 줄 flexWrap 이던 머리 줄이 닫기를 둘째 줄로 내렸다(사용자 요청 '1440 패널 닫기 줄바꿈도 고쳐줘' · Chromium A/B).
// 지금 모양: 바깥은 줄바꿈 없는 flex · 이름과 배지는 안쪽 묶음(min-width 0)에서만 줄바꿈 · 닫기는 묶음 밖(flex none).
describe('상세 패널 머리 줄', () => {
  const src = fs.readFileSync(new URL('./BareosBackupTool.jsx', import.meta.url), 'utf8');
  const start = src.indexOf('<div data-panel-head=""');
  const head = src.slice(start, src.indexOf('>닫기</button>', start) + 12);

  it('머리 줄이 있고 닫기 단추가 그 안에 있다', () => {
    expect(start).toBeGreaterThan(0);
    expect(head).toContain('aria-label="닫기"');
  });

  it('바깥 줄은 줄바꿈하지 않는다 — 닫기가 둘째 줄로 내려가지 않게', () => {
    const outer = head.slice(0, head.indexOf('>') + 1);
    expect(outer).toContain("display: 'flex'");
    expect(outer).not.toContain('flexWrap');
  });

  it('이름 · 배지는 안쪽 묶음(min-width 0)에서만 줄바꿈하고, 닫기는 그 묶음 밖에 있다', () => {
    const innerAt = head.indexOf("flexWrap: 'wrap'");
    expect(innerAt).toBeGreaterThan(0);
    const inner = head.slice(head.lastIndexOf('<div', innerAt), head.indexOf('>', innerAt) + 1);
    expect(inner).toContain('minWidth: 0');
    const nameAt = head.indexOf('{j.vmName}');
    const groupEnd = head.indexOf('</div>', innerAt);
    const closeAt = head.indexOf('aria-label="닫기"');
    expect(nameAt).toBeGreaterThan(innerAt);
    expect(nameAt).toBeLessThan(groupEnd);      // 이름은 묶음 안
    expect(closeAt).toBeGreaterThan(groupEnd);   // 닫기는 묶음 밖
    expect(head.slice(closeAt)).toContain("flex: 'none'");
    expect(head).not.toContain("marginLeft: 'auto'");   // 예전 모양(한 줄 + 오른쪽 밀기)으로 되돌리지 않는다
  });
});
