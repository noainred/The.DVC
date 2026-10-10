// v2.733(점검 3회차 C3-02a 후속 — 리드): 서버 GET /admin/guest-scans 가 쓰기 범위 밖 작업에 writable:false 를 싣는다.
// 화면은 그 작업의 '지금·중지/시작·삭제' 를 잠그고 사유(title)를 말해야 한다 — 안 잠그면 누를 때마다 403 이다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';

const src = stripComments(fs.readFileSync(new URL('./GuestScanJobs.jsx', import.meta.url), 'utf8'));

describe('GuestScanJobs 쓰기 범위 밖 작업 잠금', () => {
  it('행 버튼 셋이 모두 writable === false 로 잠긴다', () => {
    for (const label of ['>지금</button>', "{j.enabled ? '중지' : '시작'}</button>", '>삭제</button>']) {
      const i = src.indexOf(label);
      expect(i).toBeGreaterThan(0);
      const btn = src.slice(src.lastIndexOf('<button', i), i);
      expect(btn).toContain('j.writable === false');
      expect(btn).toContain('title={roTitle(j)}');
    }
  });
  it('잠금 사유 문구가 있다(백틱 없음)', () => {
    expect(src).toMatch(/쓰기 범위 밖 vCenter 작업입니다/);
  });
});
