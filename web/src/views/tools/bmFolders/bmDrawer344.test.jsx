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
// 인벤토리 나이 글자('3분 전')의 기준 시각은 구역 컴포넌트에 `now` 로 넣는다(아래 sections) — 실제 시각에 기대면 실행한 분 · 느린 실행에 따라 글자가 달라진다
//   (첫 판본은 정시 기준으로 두어 실행한 분에 따라 깨졌고, 둘째 판본 '지금 − 3분 5초' 는 여유가 25초뿐이었다 — 반증 B7).
const INV_AT = NOW - 3 * 60_000;
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
  return renderToStaticMarkup(React.createElement(DrawerSections, { corpName, scoped: false, onClose: () => {}, hw: { d: null, err: '' }, trend: { d: null, err: '' }, now: NOW, ...props }));
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
    expect(t).toContain('값 없음 — 0건이 아닙니다');
    expect(t).toContain('전원 모름');
    // 값이 없는 것은 신호(봐야 할 것)로 올리지 않고 따로 밝힌다 — 정상으로도 세지 않는다(반증 A2)
    expect(t).toContain('신호 1 — 봐야 할 것');
    expect(t).toContain('값이 없어 판단하지 않은 것: 부품 장애 · 전원 — 정상으로 세지 않습니다.');
    expect(t).not.toContain('전원 상태를 읽지 못했습니다');
    expect(html).toContain('class="vmh-dot bmd-dot-none"');   // 사유를 받지 못한 사용률 신호: 등급 none 은 빈 원(색만으로 가르지 않는다)
  });
  it('전원 · 부품 장애 값이 없는 서버(엣지 수집 · 기능 꺼짐)는 신호 0 — 본 것만 나열하고 못 본 것은 따로', async () => {
    const t = text(await sections({ r: row({ faults: null, powered: null }) }));
    expect(t).toContain('신호 0');
    expect(t).toContain('신호 없음 — 사용률 값 없음(CPU · 메모리 둘 다) · 임시 키에 해당하는 것이 없습니다.');
    expect(t).toContain('값이 없어 판단하지 않은 것: 부품 장애 · 전원 — 정상으로 세지 않습니다.');
  });
  it('사용률 값 없음 — 타일 하나로 합치고 서버 사유를 그 자리에 · 신호 줄에 사유 전문', async () => {
    const why = whyOf('edge-no-record');
    const html = await sections({ r: row({ cpu: null, mem: null, why: { code: 'edge-no-record' }, faults: 0, powered: null }) });
    const t = text(html);
    expect(html).toContain('class="vmh-dtile bmd-tile2"');
    expect(t).toContain('CPU · 메모리 사용률');
    expect(t).toContain('32코어 · 512 GB — 사유를 누르면 자세히');
    expect(t).toContain('신호 1 — 봐야 할 것');
    expect(t).toContain(`사용률 값 없음 — ${why.s}`);
    expect(t).toContain(why.l);
    expect(t).toContain(why.a);
    expect(t).toContain('값이 없어 판단하지 않은 것: 전원 — 정상으로 세지 않습니다.');
  });
  it('신호가 없으면 무엇을 봤는지 말한다', async () => {
    const t = text(await sections({ r: row({ faults: 0 }) }));
    expect(t).toContain('신호 0');
    expect(t).toContain('신호 없음 — 부품 장애 · 사용률 값 없음(CPU · 메모리 둘 다) · 전원 꺼짐 · 임시 키에 해당하는 것이 없습니다.');
    expect(t).not.toContain('값이 없어 판단하지 않은 것');   // 다 읽은 서버에는 그 줄이 없다
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
  it('OS 칸 설명 — 요약을 받지 못했으면(조회 실패 · 읽는 중) BMC 가 보고하지 않았다고 단정하지 않는다(반증 A10)', async () => {
    const fail = await sections({ r: row({ hw: null }), hw: { d: null, err: '서버를 찾지 못했습니다.' } });
    expect(fail).not.toContain(OS_WHY.slice(0, 20));
    const loading = await sections({ r: row({ hw: null }) });
    expect(loading).not.toContain(OS_WHY.slice(0, 20));
    // 요약은 받았는데 OS 만 없을 때는 그 이유를 단다
    const noOs = await sections({ r: row({ hw: { ...SUM, os: null } }), hw: { d: { ok: true, kind: 'bm', via: 'remote', detail: { ...DETAIL, os: { name: '', ver: '', host: '' }, summary: { ...SUM, os: null, host: '' } } }, err: '' } });
    expect(noOs).toContain(`title="${OS_WHY.slice(0, 20)}`);
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
    // note = 쓰기 결과 알림 — 호출부의 카드는 가림막 뒤라(좁은 화면은 화면 밖) 드로어 안에도 보인다(반증 A6)
    expect(s).toMatch(/<BmDrawer r=\{panelRow\} rows=\{drawerRows\}[^>]*onClose=\{\(\) => setPanel\(''\)\} onMove=\{setPanel\} note=\{note\} admin=\{!!d\.admin\} gen=\{[^\n]*?\} onChanged=\{\(\) => load\(\)\} \/>/);
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
    // 맵: 묶음 순서대로 그린 칸(묶음당 상한까지) — 걸러진 행 순서를 그대로 쓰면 ‹ › 가 맵의 다른 묶음으로 튄다(반증 A8 · B2)
    expect(s).toMatch(/const mapRows = view === 'map' \? mapVisibleRows\(sel\.type === 'all' \? filterRows\(servers, q, quick\) : rows, groupBy, corpName\) : null;/);
    expect(s).toMatch(/const drawerRows = mapRows \|\| \(sel\.type === 'all' \? \[\] : tableShown \?/);
    expect(read('./MapView.jsx')).toMatch(/const CELL_MAX = MAP_CELL_MAX;/);   // 맵이 그리는 상한 = 순서가 쓰는 상한(한 값)
    const t = read('../../../components/STable.jsx');
    // 정렬 · 상한을 이 표가 맡을 때만 그 결과를, 아니면(자체 정렬 · sortable=false · thead 없음) 받은 순서를 상한 없이(반증 B4)
    expect(t).toMatch(/const ids = managed \? rowIdsOf\(sort \? sortedKids : tbodyKids, cap\) : rowIdsOf\(rawKids, 0\);/);
    expect(t).toMatch(/const managed = !!thead && !!tbody && managesSort\(thead\);/);
    // 훅(순서 계산 · 알림)은 조기 return 위 — 두 위치를 다 찾은 뒤에 견준다(못 찾은 −1 은 '앞' 으로 읽혀 헛통과한다: 반증 B3)
    const memoAt = t.indexOf('const orderKey = useMemo(');
    const effAt = t.indexOf('useEffect(() => { if (orderKey != null)');
    const earlyAt = t.indexOf('if (!managed) return render(children);');
    // 조기 return 은 하나 — '맡는가' 판정(managesSort)이 순서 알림과 같은 값을 쓴다(두 벌이면 화면과 다른 순서를 알린다)
    expect((t.match(/return render\(children\);/g) || []).length).toBe(1);
    expect(t).not.toMatch(/selfSorted/);
    for (const at of [memoAt, effAt, earlyAt]) expect(at).toBeGreaterThan(0);
    expect(memoAt).toBeLessThan(earlyAt);
    expect(effAt).toBeLessThan(earlyAt);
    // 알림은 순서 글자가 바뀔 때만(deps 가 [orderKey] 하나 — onOrder 를 넣으면 인라인 콜백에서 매 렌더 다시 부른다)
    expect(t).toMatch(/useEffect\(\(\) => \{ if \(orderKey != null\) onOrderRef\.current\?\.\(orderKey === '' \? \[\] : orderKey\.split\('\\u0000'\)\); \}, \[orderKey\]\);/);
    // onOrder 를 주지 않은 표는 계산하지 않는다
    expect(t).toMatch(/if \(!onOrder \|\| !hasBody\) return null;/);
    expect(t).toMatch(/const anyTbody = onOrder \? kids\.find\(/);
  });
  it('드로어 — 틀은 VM 드로어 · 훅은 조기 return 위 · 폴링 없음 · 넘기는 동안은 잠깐 기다렸다 묻는다', () => {
    const s = read('./BmDrawer.jsx');
    expect(s).toMatch(/import '\.\.\/\.\.\/vms\/vmHub\.css'/);
    const early = s.indexOf('if (!r) return null;');
    expect(early).toBeGreaterThan(0);
    for (const hook of ["useOnce('/tools/bm-folders/hw'", "useOnce('/tools/bm-folders/trend'", 'useEffect(() => { setTo(\'\');', 'useState(\'\')', 'useRef(null)', "window.addEventListener('keydown', h)"]) {
      const i = s.indexOf(hook);
      expect(i, hook).toBeGreaterThan(0);
      expect(i, hook).toBeLessThan(early);
    }
    expect(s).not.toMatch(/setInterval|usePolling/);
    expect(s).toMatch(/const delay = first\.current \? 0 : FETCH_DELAY_MS;/);
    expect(s).toMatch(/return \(\) => \{ alive = false; clearTimeout\(t\); \};/);       // 넘어가면 이전 요청의 응답을 버린다
    expect(s).toMatch(/return st\.key === key \? \{ \.\.\.st, stale: st\.sig !== sig \} : \{ key, d: null, err: '', stale: false \};/);   // 다른 서버의 응답을 이 서버 것으로 그리지 않는다 · 같은 서버를 다시 묻는 중은 stale(v3.48 반증 B3)
    // 입력 칸에서 누른 ↑↓ 는 서버를 넘기지 않는다
    expect(s).toMatch(/if \(tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select'\) return;/);
  });
  it('↑↓ 는 드로어 DOM 안에서 난 키만 — 웹 SSH 창(포털) · 열린 상자 안의 키는 서버를 넘기지 않는다(반증 A1)', () => {
    const s = read('./BmDrawer.jsx');
    const onKey = s.slice(s.indexOf('const onKey = (e) => {'), s.indexOf('return (', s.indexOf('const onKey = (e) => {')));
    const guards = ['if (modalAbove()) return;', 'if (!inside && el !== document.body) return;', "el.closest('.bmf-idc-pop, .bmf-why-pop')) return;",
      'if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;', "if (tag === 'input' || tag === 'textarea' || tag === 'select') return;"];
    const moveAt = onKey.indexOf("e.key === 'ArrowDown'");
    expect(moveAt).toBeGreaterThan(0);
    for (const g of guards) { const at = onKey.indexOf(g); expect(at, g).toBeGreaterThan(0); expect(at, g).toBeLessThan(moveAt); }
    expect(s).toMatch(/const modalAbove = \(\) => typeof document !== 'undefined' && !!document\.querySelector\('\.modal-overlay'\);/);
    expect(onKey).toMatch(/const inside = !!root && !!el && typeof el\.nodeType === 'number' && root\.contains\(el\);/);
    // 창에서 듣는다 — 드로어 요소의 onKeyDown(포털을 넘어 올라오는 React 이벤트)은 쓰지 않는다 · 리스너는 한 번 달고 닫을 때 뗀다
    expect(s).not.toMatch(/onKeyDown=/);
    expect(s).toMatch(/const h = \(e\) => keyRef\.current\?\.\(e\);\n\s*window\.addEventListener\('keydown', h\);\n\s*return \(\) => window\.removeEventListener\('keydown', h\);\n\s*\}, \[\]\);/);
    expect(s).toMatch(/keyRef\.current = onKey;/);
    // 서버가 없으면(조기 return) 처리기를 비운다 — 이전 렌더의 처리기가 남아 닫힌 뒤의 키를 받지 않게
    expect(s.indexOf('keyRef.current = null;')).toBeGreaterThan(0);
    expect(s.indexOf('keyRef.current = null;')).toBeLessThan(s.indexOf('if (!r) return null;'));
    // 가드가 가리키는 클래스가 실제로 그 상자 · 그 모달의 것이다(이름이 바뀌면 가드가 조용히 죽는다)
    expect(read('./IdracConnect.jsx')).toMatch(/className="bmf-idc-pop"/);
    expect(read('./parts.jsx')).toMatch(/bmf-why-pop/);
    expect(read('../../../components/Modal.jsx')).toMatch(/className="modal-overlay"/);
    // 서버가 바뀌면 접속 상자 · 사유 상자의 상태(열림 · 웹 SSH 창)를 물려받지 않는다 — key = 서버(반증 A7)
    expect((s.match(/<IdracConnect key=\{r\.key\} /g) || []).length).toBe(2);
    expect((s.match(/<IdracConnect /g) || []).length).toBe(2);
    expect(s).toMatch(/<WhyTip key=\{r\.key\} /);
  });
  it('포커스 · 목록에서 빠진 서버 · 쓰기 결과 — 잠긴 단추에서 포커스를 되찾고, 빠진 자리에서 ‹ › 를 잇고, 결과를 드로어 안에 보인다', () => {
    const s = read('./BmDrawer.jsx');
    const early = s.indexOf('if (!r) return null;');
    // 포커스 되찾기: body 로 빠졌을 때만 · 모달이 위에 있으면 가져오지 않는다 · 훅은 조기 return 위(반증 A3)
    const fx = s.indexOf("if (typeof document === 'undefined' || modalAbove()) return;");
    expect(fx).toBeGreaterThan(0); expect(fx).toBeLessThan(early);
    expect(s).toMatch(/if \(!a \|\| a === document\.body\) rootRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
    // 방금까지 있던 자리(반증 A4)
    expect(s).toMatch(/const nb = neighborOfKey\(rows, r\.key, lastIdx\.current\);\n\s*if \(nb\.index >= 0\) lastIdx\.current = nb\.index;/);
    expect(s).toMatch(/nb\.gone \? <span className="pos"[^>]*>목록에서 빠짐<\/span>/);
    // 쓰기 결과(반증 A6): 새로 온 것만 · 실패는 alert
    expect(s).toMatch(/const opNote = freshNote\(note, seen\.current\.note\);/);
    // 넘긴 첫 렌더부터 이전 서버의 알림을 그리지 않는다 — 렌더 중에 키로 갈아 낀다(effect 에서 바꾸면 한 박자 늦는다)
    expect(s).toMatch(/if \(seen\.current\.key !== r\?\.key\) seen\.current = \{ key: r\?\.key, note \};/);
    expect(s).toMatch(/role=\{opNote\.ok \? 'status' : 'alert'\}>\{opNote\.text\}/);
  });
  it('요약은 방금 받은 응답이 먼저 — 응답이 인벤토리 없음이면 목록 행의 예전 요약을 내세우지 않는다(반증 A11)', async () => {
    const s = read('./BmDrawer.jsx');
    expect(s).toMatch(/const sum = d \? \(det\?\.summary \|\| d\.summary \|\| null\) : \(r\.hw \|\| null\);/);
    // 렌더로도: 목록 행에는 요약이 있는데 응답은 '인벤토리 없음' → 요약 칸을 채우지 않고 이유를 쓴다
    const t = text(await sections({ r: row(), hw: { d: { ok: true, kind: 'bm', via: '', why: 'no-inv' }, err: '' } }));
    expect(t).toContain('iDRAC 인벤토리를 아직 읽지 못했습니다');
    expect(t).not.toContain('2×16C 32코어 / 64스레드');
    // 읽은 시각이 없는 요약: '읽음' 을 지어내지 않고 — 로 · 받는 길은 그대로 보인다(반증 A12)
    const noAt = text(await sections({ r: row(), hw: { d: { ok: true, kind: 'bm', via: 'edge', summary: { ...SUM, at: null }, why: 'summary-only' }, err: '' } }));
    expect(noAt).toContain('인벤토리 — · 엣지 요약');
    expect(noAt).not.toMatch(/전 읽음/);
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
    // 포탈 웹 SSH 창(모달)은 드로어보다 위에서 열린다 — 그리고 떠 있는 상자는 그 모달보다 아래다(상자가 모달을 덮지 않게: 반증 B7)
    const modalZ = z(/\.modal-overlay \{[^}]*z-index: (\d+)/);
    expect(modalZ).toBeGreaterThan(drawerZ);
    expect(z(/\.bmf-why-pop \{[^}]*z-index: (\d+)/)).toBeLessThan(modalZ);
    expect(z(/\.bmf-idc-pop \{[^}]*z-index: (\d+)/)).toBeLessThan(modalZ);
    // 단추 줄: 공용 .login-btn 의 위 여백이 남으면 옆 단추와 높이가 어긋난다(반증 B5)
    expect(css).toMatch(/\.bmd-idc-btn \{[^}]*margin: 0;/);
    expect(css).toMatch(/\.bmd-btn \{[^}]*margin: 0;/);
    // 좁은 화면 경계는 VM 드로어와 같은 값
    expect(css).toMatch(/@media \(max-width: 719px\) \{\n {2}\.vmh-acts > \.bmd-sel/);
  });
  it('상태 점 판정은 한 곳(rowTone) — 표 행 · 카드 · 드로어 머리', () => {
    const s = read('../BmFolders.jsx');
    // 설명 글자도 한 곳(rowDotTitle) — 색 이름표('켜짐 · 장애 없음')를 그대로 쓰면 값이 없는 서버에서 없는 사실을 말한다(반증 A5)
    expect((s.match(/<StatusDot tone=\{rowTone\(r\)\} title=\{rowDotTitle\(r\)\} \/>/g) || []).length).toBe(2);
    expect((s.match(/tone=\{rowTone\(r\)\}/g) || []).length).toBe(2);   // 서버 행의 점은 이 둘뿐 — 설명 없는 판본이 따로 남지 않는다
    expect(s).not.toMatch(/r\.faults > 0 \? 'red' : r\.cpu == null/);
    expect(read('./BmDrawer.jsx')).toMatch(/<StatusDot tone=\{rowTone\(r\)\} title=\{rowDotTitle\(r\)\} \/>/);
  });
  it('머리 상태 점의 설명 — 전원 · 부품 장애를 모르는 서버에 켜짐 · 장애 없음이라고 쓰지 않는다', async () => {
    const html = await render({ r: row({ powered: null, faults: null }) });
    expect(html).toContain('title="전원 모름 · 부품 장애 값 없음"');
    expect(html).not.toContain('켜짐 · 장애 없음');
    expect(await render({ r: row({ faults: 0 }) })).toContain('title="전원 켜짐 · 부품 장애 없음"');
  });
  it('iDRAC 접속 단추 — 주소가 접속 링크로 쓸 수 없는 값이면 단추를 그리지 않는다(누를 수 없는 단추를 두지 않는다)', async () => {
    const { IdracConnect } = await import('./IdracConnect.jsx');
    const btn = (addr) => renderToStaticMarkup(React.createElement(IdracConnect, { addr, name: 'X', corp: 'vc-kr2', button: true }));
    expect(btn('10.20.42.98')).toContain('bmd-idc-btn');
    expect(btn('')).toBe('');
    expect(btn('javascript:alert(1)')).toBe('');
    expect(btn('10.20.42.98/../x')).toBe('');
  });
});
