// dbg3221 7회차 — VM · 호스트 분석 화면 결함 회귀:
//   ① toolIdsOf — 응답은 왔는데 고른 법인 줄이 0개(법인 0곳 리전 등)면 null. 예전에는 [] 를 돌려 도구 쪽에서 ‘전부’ 로 읽혀
//      본체 합은 ‘—’ 인데 도구 칸 · 패널 · 과할당 보기만 사용자 범위 전 법인 합(꺼진 VM 10대 · 1,000 GB)을 보였다.
//   ② 구성 점검 패널(호스트 · VM) — 비활성(why 'disabled') 법인만 있으면 ‘값을 읽지 못한 법인이 있어 일부만 센 수’ 경고를 띄우지 않는다.
//      개수도 판정 코어(notReadPartialIn · 서버 isNotReadMissing)처럼 읽지 못함 · 비활성을 따로 센다.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';

vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), toolAllowed: () => true, hasRole: () => true };
});

const { pickRows, toolIdsOf } = await import('./insightCore.js');
const { offView, hygieneView } = await import('../vms/insight-tools/vmToolPanelsText.js');
const { hostHygieneView } = await import('../hosts/insight-tools/hostToolPanelsText.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../..');
const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

describe('① 법인 0곳 범위 — 도구 칸 · 패널이 범위 전체를 더하지 않는다', () => {
  const waste = { rows: [{ vcenterId: 'A', vms: 17, poweredOff: 7, poweredOffGB: 700 }, { vcenterId: 'B', vms: 13, poweredOff: 3, poweredOffGB: 300 }] };

  it('응답이 왔고 줄이 0개(리전에 법인 없음)면 null — 도구 쪽 [] 는 ‘전부’ 라 쓰면 안 된다', () => {
    const rows = [];
    const ids = toolIdsOf({ ids: [], region: '중국', rows, picked: pickRows(rows, []), loaded: true });
    expect(ids).toBeNull();
    // 예전 값([])을 도구 칸에 넘기면 범위 전체 10대 · 1,000 GB 가 나온다 — 그래서 null 이어야 한다
    expect(offView(waste, null, []).count).toBe(10);
  });
  it('리전 없이 범위 안 법인이 0개여도 null', () => {
    expect(toolIdsOf({ ids: [], region: '', rows: [], picked: pickRows([], []), loaded: true })).toBeNull();
  });
  it('고른 법인이 응답 줄에 하나도 없으면 null(본체 합 ‘—’ 과 같은 집합)', () => {
    const rows = [{ id: 'A' }, { id: 'B' }];
    expect(toolIdsOf({ ids: ['X'], region: 'EU', rows, picked: pickRows(rows, ['X']), loaded: true })).toBeNull();
  });
  it('응답 전(loaded 아님)에는 이전 규칙 그대로 ids', () => {
    expect(toolIdsOf({ ids: ['B'], region: '', rows: [], picked: pickRows([], ['B']) })).toEqual(['B']);
    expect(toolIdsOf({ ids: [], region: '중국', rows: [], picked: pickRows([], []), loaded: false })).toEqual([]);
  });
  it('줄이 있으면 이전 규칙 그대로 — 리전이면 응답 줄 · 둘 다 없으면 []', () => {
    const rows = [{ id: 'A' }, { id: 'B' }];
    expect(toolIdsOf({ ids: [], region: 'EU', rows, picked: pickRows(rows, []), loaded: true })).toEqual(['A', 'B']);
    expect(toolIdsOf({ ids: [], region: '', rows, picked: pickRows(rows, []), loaded: true })).toEqual([]);
    expect(toolIdsOf({ ids: ['B'], region: '', rows, picked: pickRows(rows, ['B']), loaded: true })).toEqual(['B']);
  });
  it('소스: 두 화면 모두 응답 유무(loaded: !!data)를 넘긴다', () => {
    for (const f of ['views/vms/VmInsight.jsx', 'views/hosts/HostInsight.jsx']) {
      expect(read(f)).toMatch(/toolIdsOf\(\{ ids, region, rows, picked, loaded: !!data \}\)/);
    }
  });
});

describe('② 구성 점검 패널 — 비활성 법인은 ‘못 읽음’ 경고가 아니다', () => {
  const base = { rows: [{ vcenterId: 'a', hosts: 10, vms: 10, problem: 2, crit: 1 }] };
  const disabledOnly = { ...base, notReadVcenters: [{ vcenterId: 'b', name: 'B', why: 'disabled' }], partial: false };
  const mixed = { ...base, notReadVcenters: [{ vcenterId: 'b', name: 'B', why: 'disabled' }, { vcenterId: 'c', name: 'C', why: 'unreachable' }], partial: true };

  for (const [name, fn] of [['호스트', hostHygieneView], ['VM', hygieneView]]) {
    it(`${name}: 비활성만 — partial 거짓 · 못 읽음 0 · 비활성 1`, () => {
      const v = fn(disabledOnly, []);
      expect(v.partial).toBe(false);
      expect(v.notReadVcenters).toBe(0);
      expect(v.notReadDisabled).toBe(1);
      const v2 = fn(disabledOnly, ['a', 'b']);
      expect(v2.partial).toBe(false);
      expect(v2.notReadVcenters).toBe(0);
    });
    it(`${name}: 비활성 + 연결 실패 — partial 참 · 못 읽음 1 · 비활성 1`, () => {
      const v = fn(mixed, ['a', 'b', 'c']);
      expect(v.partial).toBe(true);
      expect(v.notReadVcenters).toBe(1);
      expect(v.notReadDisabled).toBe(1);
    });
  }
  it('소스: 경고는 v.partial 일 때만 · 비활성은 따로 적는다', () => {
    for (const f of ['views/hosts/insight-tools/HostToolPanels.jsx', 'views/vms/insight-tools/VmToolPanels.jsx']) {
      const src = read(f);
      expect(src).not.toMatch(/v\.partial \|\| v\.notReadVcenters > 0/);
      expect(src).toMatch(/\{v\.partial && <div className="vit-note warn">값을 읽지 못한 법인이 있어 일부만 센 수입니다/);
      expect(src).toMatch(/v\.notReadDisabled > 0 && <div className="vit-note">수집하지 않는\(비활성\) 법인/);
    }
  });
});
