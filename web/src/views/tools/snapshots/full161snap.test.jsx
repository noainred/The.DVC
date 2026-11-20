// 전체 점검 161회차(5축 반증) — 스냅샷 화면(153 · 156 이 바꾼 것을 Chromium 1440 · 400 으로 직접 봤다).
//  B2 보류 창 400px(156 A7 반증): 표를 옆으로 밀지 않은 상태에서 창이 표 상자 오른쪽 밖으로 42px 나가, 사유 칸 31px · 저장 실패 사유의 줄 끝 12px 가 잘렸다.
//  B3 ‘만든 계정’ 줄(153): 한 줄 말줄임(.snp-sub — 300px)이라 ‘ · 일부만 읽음’ 이 ‘ · 일…’ 로, 가장 긴 사유가 중간에서 잘렸다 → 그 줄만 접는다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../../test/_stripComments.js';
import { creatorText } from './SnapshotTool.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = stripComments(fs.readFileSync(path.join(here, 'snapshots.css'), 'utf8'));
const jsx = stripComments(fs.readFileSync(path.join(here, 'SnapshotTool.jsx'), 'utf8'));

describe('B2 보류 창 — 좁은 화면에서 표를 밀지 않아도 표 상자 안에 든다', () => {
  it('폭 상한이 화면 여백(82px) + 창이 시작하는 자리(고르기 칸 36px + 칸 여백 8px)를 뺀다', () => {
    const m = /@media \(max-width: 720px\) \{ \.snp-hold \{([^}]*)\} \}/.exec(css);
    expect(m).not.toBeNull();
    const px = Number(/max-width: calc\(100vw - (\d+)px\);/.exec(m[1])?.[1]);
    // Chromium 400px 실측: 표 상자 x 41 ~ 359(= 100vw - 82) · 창 시작 x 85(= 41 + 44) → 폭이 100vw - 126px 를 넘으면 오른쪽이 잘린다
    expect(px).toBeGreaterThanOrEqual(126);
    expect(px).toBeLessThanOrEqual(160);   // 너무 줄이면 사유 칸이 쓸 수 없게 좁아진다(400px 에서 240px 이상)
    expect(m[1]).toMatch(/position: sticky; left: 0;/);
    expect(m[1]).toMatch(/white-space: normal;/);
  });
  it('전제 — 창은 고르기 칸 다음 칸(colSpan)에 놓이고, 고르기 단추 20px · 칸 여백 8px 이다(바뀌면 위 숫자를 다시 잰다)', () => {
    expect(jsx).toMatch(/<tr key=\{`\$\{k\}:f`\} className="foot"><td \/><td colSpan=\{cols - 1\}>/);
    expect(css).toMatch(/\.snp-ck \{ width: 20px;/);
    expect(css).toMatch(/\.snp-tbl td \{ padding: 8px;/);
  });
});

describe('B3 ‘만든 계정’ 줄 — 못 읽은 이유 · ‘일부만 읽음’ 이 말줄임으로 잘리지 않는다', () => {
  it('그 줄은 접는 줄(snp-sub wrap)이다 — 한 줄 말줄임 규칙을 푼다', () => {
    expect(jsx).toMatch(/creators\?\.ok && <span className="snp-sub wrap" title=/);
    const base = /\.snp-sub \{([^}]*)\}/.exec(css)?.[1] || '';
    expect(base).toMatch(/white-space: nowrap;/);          // 다른 줄(스냅샷 이름 · 설명)은 그대로 한 줄
    expect(base).toMatch(/max-width: 300px;/);
    const wrap = /\.snp-sub\.wrap \{([^}]*)\}/.exec(css)?.[1] || '';
    expect(wrap).toMatch(/white-space: normal;/);
    expect(wrap).toMatch(/overflow-wrap: anywhere;/);
    expect(css.indexOf('.snp-sub.wrap {')).toBeGreaterThan(css.indexOf('.snp-sub {'));   // 같은 명시도 — 뒤에 와야 이긴다
  });
  it('왜 접어야 하나 — 실제 문구가 한 줄(300px · 11.5px 글자)에 들지 않는다(Chromium: 361px · 366px)', () => {
    const c = { ok: true, vcenters: { a: 'partial', b: 'not-collected' }, byVm: { 'a\nvm-1': { user: 'CORP\\svc-commvault', ts: Date.UTC(2026, 10, 19) } } };
    const some = creatorText(c, { vcenterId: 'a', id: 'vm-1' });
    expect(some).toMatch(/^최근 만든 계정 CORP\\svc-commvault · .+ · 일부만 읽음$/);   // 꼬리가 잘리면 ‘읽은 만큼만’ 이라는 단서가 사라진다
    expect(creatorText(c, { vcenterId: 'b', id: 'vm-9' })).toBe('만든 계정 — 이 vCenter 의 이벤트를 모으지 않아 모름(비활성 · 점검중)');
  });
});
