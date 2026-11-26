// v3.44 — 물리서버 상세 드로어(시안 docs/design/bm-drawer · 사용자 컨펌 '드로어 기본값대로'): 렌더(옛 옆 패널의 값 · 동작이 빠지지 않는다 ·
//   상태별 화면 — 값 없음 · 엣지 요약만 · 범위 계정 · ESXi 호스트 · 조회 실패) + 소스 스윕(틀은 VM 드로어 · ‹ › 순서 = 표가 정렬한 순서 ·
//   훅은 조기 return 위 · 폴링 없음 · 떠 있는 상자가 드로어 위).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../../test/_stripComments.js';
import { whyOf } from './whyText.js';
import { OS_WHY } from './hwText.js';

vi.mock('../../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), can: () => true };
});

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const raw = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
// 인벤토리 나이 글자('3분 전')는 화면이 지금 시각으로 계산한다(분은 반올림) — 읽은 시각을 '지금 − 3분 5초' 로 두어 시험이 도는 동안 글자가 바뀌지 않게 한다
//   (3분 30초가 돼야 '4분 전' — 여유 25초. 정시 기준으로 두면 실행한 분에 따라 달라졌다: 첫 판본의 실수).
const INV_AT = Date.now() - 3 * 60_000 - 5_000;
const SUM = { v: 1, at: INV_AT, cpu: { sockets: 2, cores: 32, threads: 64, model: 'Xeon Gold 6246R' }, mem: { gib: 512, dimms: 8 }, disk: { n: 12, ssd: 0, hdd: 12, gb: 48000 },
  nic: { ports: 8, speeds: [[10, 4]] }, hba: { n: 0 }, os: { name: 'Red Hat Enterprise Linux Server', ver: '7.8' }, fw: '7.00.00.183', host: 'selsbpdps09' };
const DETAIL = {
  summary: SUM,
  cpus: [{ n: 2, model: 'Intel(R) Xeon(R) Gold 6246R CPU @ 3.40GHz', cores: 16, threads: 32, mhz: 4000 }],
  dimms: [{ n: 8, gb: 64, type: 'DDR4', mhz: 2933, maker: 'Micron Technology' }],
  disks: [{ n: 11, model: 'ST4000NM016A-2HZ', gb: 4000, media: 'HDD', proto: 'SATA' }],
  ctrls: [{ n: 1, model: 'PERC H730P Adapter', fw: '25.5.9.0001' }],
  nics: [{ model: 'BRCM GbE 4P 5720-t rNDC', ports: 4, up: 0, speeds: [] }, { model: 'Intel(R) 10GbE 2P X710 Adapter', ports: 2, up: 2, speeds: [10] }],
  hbas: [],
  os: { name: 'Red Hat Enterprise Linux Server', ver: '7.8', host: 'selsbpdps09' },
  idrac: { fw: '7.00.00.183', model: '14G Monolithic', ipv4: '10.20.42.98' },
};
const row = (o = {}) => ({ key: 'st:AAA1111', kind: 'bm', corp: 'vc-kr2', name: 'SELSBPDPS09', serviceTag: 'AAA1111', model: 'PowerEdge R740xd', src: 'collector', agent: '수집 서버 KR2',
  path: 'KR2_Service\\SBP\\DP\\Airflow', place: 'manual', powered: true, cpu: 37, mem: 62, usrc: { cpu: 'os', mem: 'os' }, watts: 462, faults: 1, cores: 32, memGB: 512, addr: '10.20.42.98', hw: SUM, ...o });
const CORPS = [{ vcenterId: 'vc-kr2', name: 'KR2', writable: true, folders: [{ path: 'KR2_Service\\SBP\\DP\\Airflow' }, { path: 'KR2_Service\\SBP\\DP\\GPDB' }] }];
const corpName = (id) => CORPS.find((c) => c.vcenterId === id)?.name || id;
const base = { corps: CORPS, corpName, scoped: false, op: async () => true, busy: false, onClose: () => {}, onMove: () => {}, rows: [] };
const render = async (props) => {
  const { default: BmDrawer } = await import('./BmDrawer.jsx');
  return renderToStaticMarkup(React.createElement(BmDrawer, { ...base, ...props }));
};
const sections = async (props) => {
  const { DrawerSections } = await import('./BmDrawer.jsx');
  return renderToStaticMarkup(React.createElement(DrawerSections, { corpName, scoped: false, onClose: () => {}, hw: { d: null, err: '' }, trend: { d: null, err: '' }, ...props }));
};
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('BmDrawer — 틀 · 머리 · 단추 줄 · 바닥 줄', () => {
  it('VM 드로어와 같은 뼈대(가림막 + .vmh-drawer · 머리 · 단추 줄 · 본문 · 바닥 줄)', async () => {
    const html = await render({ r: row(), rows: [row({ key: 'st:P' }), row(), row({ key: 'st:N' })] });
    expect(html).toContain('class="vmh-drawer-overlay"');
    expect(html).toMatch(/<aside class="vmh-drawer" role="dialog" aria-modal="true" aria-label="서버 상세 — SELSBPDPS09" tabindex="-1">/);
    for (const cls of ['vmh-dh', 'vmh-acts bmd-acts', 'vmh-db bmd-db', 'vmh-df']) expect(html).toContain(`class="${cls}"`);
    expect(html).toContain('<h2 title="SELSBPDPS09">SELSBPDPS09</h2>');
  });
  it('‹ › 는 목록의 이웃이 있을 때만 열리고 자리(n/전체)를 쓴다', async () => {
    const mid = await render({ r: row(), rows: [row({ key: 'st:P' }), row(), row({ key: 'st:N' })] });
    expect(mid).toMatch(/aria-label="이전 서버" title="이전 서버\(↑\)">‹<\/button>/);
    expect(mid).toMatch(/aria-label="다음 서버" title="다음 서버\(↓\)">›<\/button>/);
    expect(text(mid)).toContain('목록 2/3');
    const alone = await render({ r: row(), rows: [] });
    expect(alone).toMatch(/aria-label="이전 서버" title="이전 서버\(↑\)" disabled="">/);
    expect(alone).toMatch(/aria-label="다음 서버" title="다음 서버\(↓\)" disabled="">/);
    expect(text(alone)).not.toMatch(/목록 \d+\/\d+/);
  });
  it('머리 — 신호 배지 · 전원 · 법인 › 폴더 · 종류 · 모델 · 서비스 태그', async () => {
    const t = text(await render({ r: row() }));
    for (const s of ['부품 장애 1건', '전원 켜짐', 'KR2', 'KR2_Service › SBP › DP › Airflow', '베어메탈', 'PowerEdge R740xd', 'AAA1111']) expect(t).toContain(s);
  });
  it('단추 줄 — iDRAC 접속(같은 접속 상자) · 폴더 고르기 · 옮기기 · 폴더에서 빼기(손 등록만)', async () => {
    const html = await render({ r: row() });
    expect(html).toMatch(/class="login-btn bmd-idc-btn"[^>]*>iDRAC 접속<\/button>/);
    // 태그 이름을 글자로 이어 쓴다 — 소스 스윕(selectSort.test.js '날 select 금지')이 이 파일의 글자까지 센다
    expect(html).toContain(`<${'select'} class="select bmd-sel" aria-label="옮길 폴더">`);
    expect(html).toContain('<option value="KR2_Service\\SBP\\DP\\GPDB">KR2_Service › SBP › DP › GPDB</option>');
    expect(html).not.toContain('<option value="KR2_Service\\SBP\\DP\\Airflow">');   // 지금 폴더는 고를 대상이 아니다
    expect(html).toMatch(/disabled="">옮기기<\/button>/);                              // 폴더를 고르기 전에는 잠겨 있다
    expect(html).toContain('>폴더에서 빼기</button>');
    const rule = await render({ r: row({ place: 'rule' }) });
    expect(rule).not.toContain('폴더에서 빼기');                                       // 규칙이 넣은 자리는 빼기가 없다(옛 패널과 같다)
    const un = await render({ r: row({ place: null, path: '' }) });
    expect(un).toMatch(/aria-label="넣을 폴더"/);
    expect(un).toMatch(/>넣기<\/button>/);
  });
  it('조회 전용 법인 · 법인 미지정은 폴더 단추 대신 안내 한 줄', async () => {
    const ro = await render({ r: row(), corps: [{ ...CORPS[0], writable: false }] });
    expect(ro).not.toContain('bmd-sel');
    expect(text(ro)).toContain('이 법인은 조회 전용입니다 — 폴더를 옮기거나 뺄 수 없습니다.');
    const noCorp = await render({ r: row({ corp: '', place: null, path: '' }) });
    expect(text(noCorp)).toContain('법인을 몰라 폴더에 넣을 수 없습니다.');
  });
  it('범위 계정 판본 — 접속 단추 · 서비스 태그가 없다(주소는 글자로만)', async () => {
    const html = await render({ r: row({ serviceTag: undefined, agent: undefined }), scoped: true });
    expect(html).not.toContain('bmd-idc-btn');
    expect(html).not.toContain('bmf-idc-b');
    expect(text(html)).not.toContain('서비스 태그');
    expect(html).toContain('<span class="mono">10.20.42.98</span>');
    // 서버가 싣지 않는 것이 규약이지만, 행에 태그가 실려 와도 범위 계정 화면은 그리지 않는다(변이 39 — 머리 줄 · 값 줄 둘 다)
    const leaked = await render({ r: row(), scoped: true });
    expect(text(leaked)).not.toContain('AAA1111');
  });
  it('바닥 줄 — 옛 패널의 바로가기 4개 · 키 안내', async () => {
    const html = await render({ r: row() });
    for (const [href, label] of [['#/tools/bm-usage', '베어메탈 사용률(추이)'], ['#/tools/part-faults', '물리 부품 장애'], ['#/tools/fleet', '통합 서버 인벤토리'], ['#/tools/svc-inventory', '서비스 인벤토리']]) {
      expect(html).toContain(`<a href="${href}">${label}</a>`);
    }
    expect(text(html)).toContain('Esc 닫기 · ↑↓ 이전/다음 서버');
  });
  it('서버가 없으면 아무것도 그리지 않는다', async () => { expect(await render({ r: null })).toBe(''); });
});

describe('DrawerSections — 한눈에 · 추이 · 신호 · 값 줄', () => {
  it('타일 4장 — 값 · 출처 표지 · 막대 · 용량', async () => {
    const html = await sections({ r: row() });
    const t = text(html);
    for (const s of ['한눈에 · 지금 값', 'CPU', '37 %', '32코어 · 2×16C', '메모리', '62 %', '512 GB', '전력', '462 W', '전원 켜짐', '부품 장애', '1 건', '물리 부품 장애에서 보기']) expect(t).toContain(s);
    expect(html).toContain('class="bmf-sc os"');
    expect(html).toMatch(/class="vmh-bar"[^>]*><i style="width:37%/);
  });
  it('값이 없으면 — 로 쓰고 단위 · 막대를 붙이지 않는다(0 으로 그리지 않는다)', async () => {
    const html = await sections({ r: row({ cpu: null, mem: null, watts: null, faults: null, powered: null }) });
    const t = text(html);
    expect(html).not.toContain('class="vmh-bar"');
    expect(t).not.toMatch(/— ?%|— ?W|— ?건/);
    expect(t).toContain('못 읽음 — 0건이 아닙니다');
    expect(t).toContain('전원 모름');
  });
  it('사용률 값 없음 — 타일 하나로 합치고 서버 사유를 그 자리에 · 신호 줄에 사유 전문', async () => {
    const why = whyOf('edge-no-record');
    const html = await sections({ r: row({ cpu: null, mem: null, why: { code: 'edge-no-record' }, faults: 0, powered: null }) });
    const t = text(html);
    expect(html).toContain('class="vmh-dtile bmd-tile2"');
    expect(t).toContain('CPU · 메모리 사용률');
    expect(t).toContain('32코어 · 512 GB — 사유를 누르면 자세히');
    expect(t).toContain('신호 2 — 봐야 할 것');
    expect(t).toContain(`사용률 값 없음 — ${why.s}`);
    expect(t).toContain(why.l);
    expect(t).toContain(why.a);
    expect(t).toContain('전원 상태를 읽지 못했습니다 — 켜짐으로도 꺼짐으로도 세지 않습니다.');
    expect(html).toContain('class="vmh-dot bmd-dot-none"');   // 등급 none 은 빈 원(색만으로 가르지 않는다)
  });
  it('신호가 없으면 무엇을 봤는지 말한다', async () => {
    const t = text(await sections({ r: row({ faults: 0 }) }));
    expect(t).toContain('신호 0');
    expect(t).toContain('신호 없음 — 부품 장애 · 사용률 값 없음 · 전원 꺼짐/모름 · 임시 키 모두 해당하지 않습니다.');
  });
  it('식별 · 배치 — 법인 · 종류 · 폴더(등록 방식) · 모델 · 태그 · 전원 · 받는 길 · OS · 호스트명', async () => {
    const t = text(await sections({ r: row(), hw: { d: { ok: true, kind: 'bm', via: 'remote', addr: '10.20.42.98', detail: DETAIL }, err: '' } }));
    for (const s of ['식별 · 배치', '법인 KR2', '종류 베어메탈', '폴더 KR2_Service › SBP › DP › Airflow 손 등록', '모델 PowerEdge R740xd', '서비스 태그 AAA1111', '전원 켜짐', '수집 서버 KR2',
      'OS Red Hat Enterprise Linux Server 7.8', 'OS 호스트명 selsbpdps09']) expect(t).toContain(s);
  });
});

describe('DrawerSections — 추이', () => {
  const pts = Array.from({ length: 6 }, (_, i) => ({ ts: NOW - (5 - i) * HOUR, cpu: i === 2 ? null : 30 + i, mem: i === 2 ? null : 60 }));
  it('읽는 중 → 그림(마지막 값 · 점 개수 · 못 읽은 구간 띠)', async () => {
    expect(text(await sections({ r: row() }))).toContain('읽는 중…');
    const html = await sections({ r: row(), trend: { d: { ok: true, hours: 24, via: 'local', rows: pts, why: '' }, err: '' } });
    const t = text(html);
    expect(html).toMatch(/<svg viewBox="0 0 578 150" width="578" height="150"[^>]*role="img" aria-label="지난 24시간 CPU 마지막 35% · 메모리 마지막 60%">/);
    expect(t).toContain('CPU 35%');
    expect(t).toContain('메모리 60%');
    expect(t).toContain('점 6개(구간 평균) · 옅은 띠는 못 읽은 구간(선을 잇지 않습니다)');
    expect(html).toContain('<rect');
    expect(t).toContain('열 때 1회 조회 · 구간 평균');
  });
  it('엣지에서 받은 추이는 그렇게 밝힌다', async () => {
    const t = text(await sections({ r: row(), trend: { d: { ok: true, via: 'edge', rows: pts, why: '' }, err: '' } }));
    expect(t).toContain('이 서버를 수집하는 엣지에서 받았습니다(구간 평균)');
  });
  it('값이 없는 이유는 서버 코드의 글자 그대로 · 사유 원문은 뒤에', async () => {
    const t1 = text(await sections({ r: row(), trend: { d: { ok: true, rows: [], why: 'no-target' }, err: '' } }));
    expect(t1).toContain('베어메탈 사용률 수집 대상이 아닙니다(특수 기능 › 베어메탈 사용률에서 그 법인 수집을 켜야 추이가 쌓입니다).');
    const t2 = text(await sections({ r: row(), trend: { d: { ok: true, rows: [], why: 'edge-fail', reason: 'timeout' }, err: '' } }));
    expect(t2).toContain('이 서버를 수집하는 엣지에서 추이를 받지 못했습니다(잠시 뒤 다시 열어 보십시오). — timeout');
    const t3 = text(await sections({ r: row(), trend: { d: { ok: true, rows: pts, why: 'none' }, err: '' } }));
    expect(t3).toContain('이 기간에 쌓인 사용률 값이 없습니다');
  });
  it('조회 실패는 그 글자를 보인다(빈 그림으로 덮지 않는다)', async () => {
    const html = await sections({ r: row(), trend: { d: null, err: '요청을 처리하지 못했습니다.' } });
    expect(text(html)).toContain('요청을 처리하지 못했습니다.');
    expect(html).not.toContain('<svg');
  });
});

describe('DrawerSections — iDRAC · 하드웨어', () => {
  it('상세를 받으면 iDRAC 값 4개 · 요약 5칸 · 부품 6종', async () => {
    const html = await sections({ r: row(), hw: { d: { ok: true, kind: 'bm', via: 'remote', addr: '10.20.42.98', detail: DETAIL }, err: '' } });
    const t = text(html);
    for (const s of ['iDRAC · 관리', '3분 전 읽음 · 수집 서버', 'iDRAC 주소', '관리 NIC IPv4 10.20.42.98', 'iDRAC 모델 14G Monolithic', 'iDRAC 펌웨어 7.00.00.183',
      '하드웨어 요약', '2×16C', '32코어 / 64스레드', '512 GB', 'DIMM 8개', '48 TB', 'HDD 12', '10G×4', '어댑터 2', '읽었고 0개',
      '부품 목록', '같은 부품은 묶어 개수로', '2 ×', 'Intel(R) Xeon(R) Gold 6246R CPU @ 3.40GHz', '16코어/32스레드 · 최대 4.0GHz', '8 ×', '64 GB DDR4 2933MHz', 'Micron Technology',
      '11 ×', 'ST4000NM016A-2HZ', '4 TB · HDD(SATA)', 'PERC H730P Adapter', '펌웨어 25.5.9.0001', 'BRCM GbE 4P 5720-t rNDC', '4포트 · 링크 업 0', '2포트 · 링크 업 2 · 10G', 'FC HBA 없음']) expect(t).toContain(s);
    expect(html).toMatch(/class="bmf-idc-b mono"[^>]*>10\.20\.42\.98<\/button>/);   // 주소를 누르면 접속 상자(옛 패널과 같다)
  });
  it('읽는 중에는 목록 행의 요약으로 5칸을 먼저 그리고 부품 목록만 기다린다', async () => {
    const t = text(await sections({ r: row() }));
    expect(t).toContain('2×16C');
    expect(t).toContain('8포트');          // 부품 목록이 아직 없어 어댑터 수를 모른다
    expect(t).not.toContain('어댑터');
    expect(t).toMatch(/부품 목록 읽는 중…/);
  });
  it('엣지가 요약만 올린 서버 — 요약까지만 채우고 부품 목록 자리에 이유', async () => {
    const t = text(await sections({ r: row({ src: 'edge', agent: 'edge-pl1' }), hw: { d: { ok: true, kind: 'bm', via: 'edge', summary: SUM, why: 'summary-only' }, err: '' } }));
    expect(t).toContain('3분 전 읽음 · 엣지 요약');
    expect(t).toContain('2×16C');
    expect(t).toContain('엣지가 보낸 요약만 있습니다 — 엣지는 부품별 목록을 중앙으로 보내지 않습니다(부품별 목록은 그 엣지의 iDRAC 인벤토리 화면에서 봅니다).');
    expect(t).toContain('iDRAC 모델 —');   // 받지 못한 값은 —
  });
  it('요약도 없으면 서버가 준 이유(원인을 단정하지 않는다)', async () => {
    const edge = text(await sections({ r: row({ hw: null }), hw: { d: { ok: true, kind: 'bm', via: 'edge', why: 'edge-none' }, err: '' } }));
    expect(edge).toContain('엣지가 하드웨어 요약을 보내지 않았습니다');
    expect(edge).toContain('부품 목록이 없습니다 — 위 하드웨어 요약의 이유와 같습니다.');
    const none = text(await sections({ r: row({ hw: null }), hw: { d: { ok: true, kind: 'bm', via: '', why: 'no-inv' }, err: '' } }));
    expect(none).toContain('iDRAC 인벤토리를 아직 읽지 못했습니다');
  });
  it('조회 실패 — 주소(목록 행 값)와 접속은 그대로 · 실패 글자 · 요약은 목록 행 값', async () => {
    const html = await sections({ r: row(), hw: { d: null, err: '서버를 찾지 못했습니다.' } });
    const t = text(html);
    expect(html).toMatch(/class="bmf-idc-b mono"[^>]*>10\.20\.42\.98<\/button>/);
    expect(t).toContain('서버를 찾지 못했습니다.');
    expect(t).toContain('2×16C');
    expect(t).toContain('부품 목록을 받지 못했습니다.');
    const noSum = text(await sections({ r: row({ hw: null }), hw: { d: null, err: '서버를 찾지 못했습니다.' } }));
    expect(noSum).toContain('하드웨어 요약을 받지 못했습니다.');
  });
  it('OS 를 못 읽었으면 — 와 이유(벤더 에이전트)', async () => {
    const t = text(await sections({ r: row({ hw: { ...SUM, os: null } }), hw: { d: { ok: true, kind: 'bm', via: 'remote', detail: { ...DETAIL, os: { name: '', ver: '', host: '' }, summary: { ...SUM, os: null, host: '' } } }, err: '' } }));
    expect(t).toContain('OS —');
    expect(t).toContain(OS_WHY);
    expect(t).not.toContain('OS 호스트명');
  });
  it('주소를 모르면 — (관리자 판본이 아니거나 모름)', async () => {
    const html = await sections({ r: row({ addr: undefined }), hw: { d: { ok: true, kind: 'bm', via: 'remote', detail: DETAIL }, err: '' } });
    expect(html).toContain('title="관리 주소는 관리자 판본에서만 보입니다(또는 이 서버의 iDRAC 주소를 모릅니다)"');
  });
  it('ESXi 호스트 — 하드웨어 구역이 없고 추이 자리에 호스트 화면 안내(옛 패널과 같다)', async () => {
    const html = await render({ r: row({ kind: 'esxi', usrc: { cpu: 'vcenter', mem: 'vcenter' }, hw: undefined, addr: undefined }) });
    const t = text(html);
    expect(t).toContain('ESXi 호스트의 추이는 호스트 화면에서 봅니다.');
    for (const s of ['iDRAC · 관리', '하드웨어 요약', '부품 목록', 'OS ']) expect(t).not.toContain(s);
    expect(html).not.toContain('bmd-idc-btn');
    expect(html).toContain('class="bmf-sc vcenter"');
    expect(t).toContain('ESXi 호스트');
  });
});

describe('소스 스윕 — 틀 · 순서 · 훅 · 겹침', () => {
  it('Bare Metal Server 화면은 드로어 하나를 연다(옛 옆 패널 파일은 없다)', () => {
    const s = read('../BmFolders.jsx');
    expect(s).toMatch(/import BmDrawer from '\.\/bmFolders\/BmDrawer\.jsx'/);
    expect(s).not.toMatch(/SidePanel|HwPanel/);
    expect(fs.existsSync(new URL('./SidePanel.jsx', import.meta.url))).toBe(false);
    expect(fs.existsSync(new URL('./HwPanel.jsx', import.meta.url))).toBe(false);
    expect(s).toMatch(/<BmDrawer r=\{panelRow\} rows=\{drawerRows\}[^>]*onClose=\{\(\) => setPanel\(''\)\} onMove=\{setPanel\} \/>/);
    // 표 행 · 맵 · 좁은 화면 카드 — 여는 곳은 setPanel 하나(설계 §5 결정 6)
    expect((s.match(/onPick=\{setPanel\}/g) || []).length).toBe(2);
    expect(s).toMatch(/onOpen=\{setPanel\}/);
    expect(s).toMatch(/onClick=\{\(\) => setPanel\(r\.key\)\}/);
  });
  it('‹ › 순서 = 표가 정렬한 순서(STable onOrder · 행의 data-rowid) · 표가 없으면 걸러진 행 순서', () => {
    const s = read('../BmFolders.jsx');
    expect(s).toMatch(/<STable className="table bmf-t" minWidth=\{720\} limit=\{ROW_LIMIT\} onOrder=\{setOrder\}>/);
    expect(s).toMatch(/<tr key=\{r\.key\} data-rowid=\{r\.key\}/);
    expect(s).toMatch(/const tableShown = sel\.type !== 'all' && view !== 'map' && !narrow && rows\.length > 0;/);
    expect(s).toMatch(/tableShown \? orderRows\(rows, order\) : rows\.slice\(0, ROW_LIMIT\)/);
    const t = read('../../../components/STable.jsx');
    expect(t).toMatch(/rowIdsOf\(sort \? sortedKids : tbodyKids, cap\)/);
    // 훅(순서 계산 · 알림)은 조기 return 위
    expect(t.indexOf('const orderKey = useMemo(')).toBeGreaterThan(0);
    expect(t.indexOf('useEffect(() => { if (orderKey != null)')).toBeLessThan(t.indexOf('if (!thead || !tbody) return render(children);'));
    // onOrder 를 주지 않은 표는 계산하지 않는다
    expect(t).toMatch(/if \(!onOrder \|\| tbodyKids === undefined\) return null;/);
  });
  it('드로어 — 틀은 VM 드로어 · 훅은 조기 return 위 · 폴링 없음 · 넘기는 동안은 잠깐 기다렸다 묻는다', () => {
    const s = read('./BmDrawer.jsx');
    expect(s).toMatch(/import '\.\.\/\.\.\/vms\/vmHub\.css'/);
    const early = s.indexOf('if (!r) return null;');
    expect(early).toBeGreaterThan(0);
    for (const hook of ["useOnce('/tools/bm-folders/hw'", "useOnce('/tools/bm-folders/trend'", 'useEffect(() => { setTo(\'\');', 'useState(\'\')', 'useRef(null)']) {
      const i = s.indexOf(hook);
      expect(i, hook).toBeGreaterThan(0);
      expect(i, hook).toBeLessThan(early);
    }
    expect(s).not.toMatch(/setInterval|usePolling/);
    expect(s).toMatch(/const delay = first\.current \? 0 : FETCH_DELAY_MS;/);
    expect(s).toMatch(/return \(\) => \{ alive = false; clearTimeout\(t\); \};/);       // 넘어가면 이전 요청의 응답을 버린다
    expect(s).toMatch(/return st\.key === key \? st : \{ key, d: null, err: '' \};/);   // 다른 서버의 응답을 이 서버 것으로 그리지 않는다
    // 입력 칸에서 누른 ↑↓ 는 서버를 넘기지 않는다
    expect(s).toMatch(/if \(tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select'\) return;/);
  });
  it('문구에 백틱 · 대문자 변환이 없다(화면 규약)', () => {
    const s = read('./BmDrawer.jsx');
    const strings = s.match(/'[^'\n]*[가-힣][^'\n]*'/g) || [];
    for (const x of strings) expect(x, x).not.toContain('`');
    expect(raw('../../../styles.css').split('\n').filter((l) => /\.bmd-/.test(l)).join('\n')).not.toMatch(/text-transform/);
  });
  it('스타일 — 옛 옆 패널 규칙은 지웠고, 떠 있는 상자(사유 · 접속)는 드로어보다 위', () => {
    const css = raw('../../../styles.css');
    for (const dead of ['.bmf-drawer {', '.bmf-kv {', '.bmf-hwsec {', '.bmf-links a']) expect(css).not.toContain(dead);
    const z = (re) => Number((css.match(re) || [])[1]);
    const drawerZ = Number((raw('../../vms/vmHub.css').match(/\.vmh-drawer \{[^}]*z-index: (\d+)/) || [])[1]);
    expect(drawerZ).toBeGreaterThan(0);
    expect(z(/\.bmf-why-pop \{[^}]*z-index: (\d+)/)).toBeGreaterThan(drawerZ);
    expect(z(/\.bmf-idc-pop \{[^}]*z-index: (\d+)/)).toBeGreaterThan(drawerZ);
    // 포탈 웹 SSH 창(모달)은 드로어보다 위에서 열린다
    expect(z(/\.modal-overlay \{[^}]*z-index: (\d+)/)).toBeGreaterThan(drawerZ);
    // 좁은 화면 경계는 VM 드로어와 같은 값
    expect(css).toMatch(/@media \(max-width: 719px\) \{\n {2}\.vmh-acts > \.bmd-sel/);
  });
  it('상태 점 판정은 한 곳(rowTone) — 표 행 · 카드 · 드로어 머리', () => {
    const s = read('../BmFolders.jsx');
    expect((s.match(/StatusDot tone=\{rowTone\(r\)\}/g) || []).length).toBe(2);
    expect(s).not.toMatch(/r\.faults > 0 \? 'red' : r\.cpu == null/);
    expect(read('./BmDrawer.jsx')).toMatch(/<StatusDot tone=\{rowTone\(r\)\} \/>/);
  });
});
