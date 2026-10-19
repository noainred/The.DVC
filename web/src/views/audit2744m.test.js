// v2.744 리드 후속 그룹 FC — 웹 회귀.
//  ① 호스트·VM 구성 점검: 서버 notReadVcenters 를 coverage 줄과 배너가 말한다(문구는 bizreport/notReadText.js 한 벌).
//  ② 엣지 iDRAC 등록부 손상으로 중앙이 직전 베어메탈 목록을 유지 중(fleetPartials.registryUnreadable)이면 통합 서버 인벤토리·
//     베어메탈 사용률이 각주 한 번 + 행 표지로 말한다.
// 두 화면은 데이터를 효과(useEffect)에서 받아 renderToStaticMarkup 으로는 데이터 상태를 그릴 수 없다 — 문구는 순수 함수로,
// '화면이 그 값을 실제로 넘기는가' 는 마지막 수단으로 소스(주석 제거)를 본다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageText as hostCoverageText } from './hostcfg/hostCfgText.js';
import { coverageText as vmCoverageText } from './vmcfg/vmHygieneText.js';
import { notReadNote, notReadKpiSub } from './bizreport/notReadText.js';
import { fleetHeldNote, fleetHeldBadge, fleetPartialsNote } from './fleetPartialText.js';
import { stripComments } from '../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => stripComments(fs.readFileSync(path.resolve(here, p), 'utf8'));
const NR = [{ vcenterId: 'vc-u', name: 'VC-U', why: 'unreachable' }, { vcenterId: 'vc-p', name: 'VC-P', why: 'pending' }, { vcenterId: 'vc-o', name: 'VC-O', why: 'disabled' }];

describe('① 호스트·VM 구성 점검 — 읽지 못한 vCenter', () => {
  it('coverage 줄이 읽지 못한 vCenter(비활성 제외)를 하한으로 말한다 · 없으면 예전 문구 그대로', () => {
    const hc = { hosts: 2, cfg: 2, notCollected: 0, disconnected: 0 };
    expect(hostCoverageText(hc)).toBe('호스트 2대 · 구성 읽음 2');
    expect(hostCoverageText(hc, [])).toBe('호스트 2대 · 구성 읽음 2');
    expect(hostCoverageText(hc, NR)).toBe(`호스트 2대 · 구성 읽음 2 · ${notReadKpiSub(NR)}`);
    expect(hostCoverageText(hc, NR)).toContain('읽지 못한 vCenter 2곳 제외');
    expect(hostCoverageText(hc, [NR[2]])).toBe('호스트 2대 · 구성 읽음 2');   // 비활성만이면 하한이 아니다
    const vc = { vms: 3, cfg: 3, dev: 3, notCollected: 0, templates: 0, excepted: 0 };
    expect(vmCoverageText(vc)).toBe('VM 3대 · 구성 읽음 3 · 장치 읽음 3');
    expect(vmCoverageText(vc, NR)).toContain('읽지 못한 vCenter 2곳 제외 — 하한');
    expect(vmCoverageText(vc, null)).toBe('VM 3대 · 구성 읽음 3 · 장치 읽음 3');
  });
  it('두 화면이 응답의 notReadVcenters 를 coverage 줄과 배너(notReadNote)에 넘긴다', () => {
    for (const f of ['tools/HostHygieneTool.jsx', 'tools/VmHygieneTool.jsx']) {
      const s = src(f);
      expect(s, f).toMatch(/coverageText\(cov, data\.notReadVcenters\)/);
      expect(s, f).toMatch(/notReadNote\(data\.notReadVcenters\)/);
    }
    expect(notReadNote(NR)).toContain('VC-U');
  });
});

describe('② 등록부 손상으로 직전 목록 유지 중인 엣지', () => {
  const fp = { edges: 2, partialEdges: 0, partials: [], omitted: 0, vcenterBlanked: 0, registryUnreadableEdges: 1, registryUnreadable: [{ agent: 'edge-x', reason: '형식 오류', since: 1, holdExpired: false }] };
  it('각주는 서버가 준 엣지 이름·사유를 그대로 말하고 조치를 적는다 · 없으면 빈 문자열', () => {
    const t = fleetHeldNote(fp);
    expect(t).toContain('edge-x');
    expect(t).toContain('형식 오류');
    expect(t).toContain('직전 목록');
    expect(t).toContain('idrac.json.corrupt');
    expect(fleetHeldNote(null)).toBe('');
    expect(fleetHeldNote({ registryUnreadable: [] })).toBe('');
    expect(fleetHeldNote({ registryUnreadable: [null, 'x', { reason: '이름 없음' }] })).toBe('');   // 모양이 틀린 원소로 던지지 않는다
    expect(fleetPartialsNote(fp)).toBe('');   // '일부 목록' 문구와 섞지 않는다(조치가 다르다)
    const many = { registryUnreadable: Array.from({ length: 7 }, (_, i) => ({ agent: `e${i}`, reason: 'r', holdExpired: i === 0 })) };
    expect(fleetHeldNote(many)).toContain('외 2곳');
    expect(fleetHeldNote(many)).toContain('보류 시한');
  });
  it('행 표지는 그 엣지 행에만 · 시한이 지났으면 만료 예정으로', () => {
    expect(fleetHeldBadge(fp, 'edge-x')).toMatchObject({ text: '직전 목록' });
    expect(fleetHeldBadge(fp, 'edge-x').title).toContain('edge-x');
    expect(fleetHeldBadge(fp, 'edge-y')).toBe(null);
    expect(fleetHeldBadge(fp, '')).toBe(null);
    expect(fleetHeldBadge({ registryUnreadable: [{ agent: 'a', holdExpired: true }] }, 'a').text).toBe('목록 만료 예정');
  });
  it('문구에 백틱·별표 두 개가 없다', () => {
    const all = [fleetHeldNote(fp), fleetHeldBadge(fp, 'edge-x').text, fleetHeldBadge(fp, 'edge-x').title, hostCoverageText({ hosts: 1, cfg: 1 }, NR)];
    for (const s of all) { expect(s).not.toMatch(/`/); expect(s).not.toMatch(/\*\*/); }
  });
  it('통합 서버 인벤토리는 각주 한 번 + 엣지 행 표지, 베어메탈 사용률은 각주를 그린다', () => {
    const fi = src('tools/FleetInventory.jsx');
    expect(fi).toMatch(/fleetHeldNote\(d\.fleetPartials\)/);
    expect(fi).toMatch(/<HeldMark fp=\{d\.fleetPartials\} agent=\{b\.remoteAgent\} \/>/);
    expect(fi).toMatch(/fleetHeldBadge\(fp, agent\)/);
    expect(src('tools/BmUsage.jsx')).toMatch(/fleetHeldNote\(data\?\.fleetPartials\)/);
  });
});
