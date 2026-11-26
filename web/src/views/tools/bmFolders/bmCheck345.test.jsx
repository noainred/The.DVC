// v3.45 — 물리서버 점검 화면(드로어의 보증 · 계약 / 펌웨어 기준선 / BIOS 설정 편차 구역 · 자산 원장 올리기 창 · 목록 칩): 렌더 + 소스 스윕.
//   못 읽은 것 · 판정하지 않은 것은 표를 그리지 않고 이유를 쓴다 · 계약 번호는 관리자 판본에만 줄이 있다 · 기준 지정 단추는 서버가 허용한 계정에만.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../../test/_stripComments.js';

vi.mock('../../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), postJson: () => new Promise(() => {}), can: () => true, canCsv: () => true };
});

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const raw = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const W = { state: 'soon', end: '2027-01-10', daysLeft: 45, type: 'ProSupport', purchase: '2022-01-11', ageMonths: 58, contract: 'SYNTH-C1', eos: '', eosPassed: null, note: '' };
const FW = { state: 'behind', behind: 1, ahead: 0, judged: 2, skipped: 2, peers: 3, rows: [
  { key: 'BIOS|bios', type: 'BIOS', label: 'BIOS', installed: '2.19.1', mixed: false, baseline: '2.21.2', basis: 'majority', state: 'behind', peers: 2, known: 3 },
  { key: 'iDRAC|idrac', type: 'iDRAC', label: 'Integrated Dell Remote Access Controller', installed: '7.00.00.171', mixed: false, baseline: '7.00.00.171', basis: 'admin', state: 'same' },
  { key: 'NIC|n', type: 'NIC', label: 'Synth NIC', installed: null, mixed: true, baseline: null, basis: null, state: 'mixed' },
] };
const BIOS = { state: 'diff', diff: 1, group: { size: 3, known: 3 }, rows: [{ k: 'BootMode', v: 'Uefi', major: 'Uefi', majorN: 3, known: 3, state: 'same' }, { k: 'ProcTurboMode', v: 'Enabled', major: 'Disabled', majorN: 2, known: 3, state: 'diff' }] };
const D = (o = {}) => ({ ok: true, kind: 'bm', soonDays: 90, warranty: W, fw: FW, bios: BIOS, model: 'PowerEdge R750', path: 'SVC\\DB', canBaseline: false, ...o });
const R = { key: 'st:SYNTH01', kind: 'bm', name: 'synth-db-01' };
const warranty = async (props) => { const { WarrantySection } = await import('./CheckSections.jsx'); return renderToStaticMarkup(React.createElement(WarrantySection, props)); };
const fwbios = async (props) => { const { FwBiosSections } = await import('./CheckSections.jsx'); return renderToStaticMarkup(React.createElement(FwBiosSections, { r: R, ...props })); };

describe('보증 · 계약 구역', () => {
  it('읽는 중 → 값 줄 · 배지 · 기준 일수 안내 / 계약 번호는 관리자 판본에만', async () => {
    expect(text(await warranty({ chk: { d: null, err: '' } }))).toContain('보증 · 계약 자산 원장(CSV) 읽는 중…');
    const t = text(await warranty({ chk: { d: D(), err: '' }, admin: true }));
    for (const s of ['보증 · 계약', '보증 곧 끝남', '보증 만료 2027-01-10 45일 남음', '보증 종류 ProSupport', '구매일 2022-01-11', '사용 기간 4년 10개월', '유지보수 계약 SYNTH-C1', '지원 종료(제조사) —',
      '보증 만료일까지 90일 이하로 남으면 ‘곧 끝남’ 으로 봅니다.']) expect(t).toContain(s);
    const u = text(await warranty({ chk: { d: D({ warranty: { ...W, contract: '' } }), err: '' }, admin: false }));
    expect(u).not.toContain('유지보수 계약'); expect(u).not.toContain('SYNTH-C1');
    // ‘곧’ 의 기준 일수는 서버 값 — 다른 값을 주면 그 값이 보인다(시험 자료가 90 뿐이면 화면에 90 을 박아도 통과한다: 반증 T3)
    const d45 = text(await warranty({ chk: { d: D({ soonDays: 45 }), err: '' }, admin: true }));
    expect(d45).toContain('보증 만료일까지 45일 이하로 남으면'); expect(d45).not.toContain('90일');
    expect(await warranty({ chk: { d: D(), err: '' }, admin: true })).not.toContain('`');
  });
  it('모름 · 원장을 못 읽음 · 조회 실패는 그 말을 쓴다(빈 값 줄로 덮지 않는다)', async () => {
    const none = text(await warranty({ chk: { d: D({ warranty: { state: 'unknown', why: 'no-entry', end: '', daysLeft: null } }), err: '' } }));
    expect(none).toContain('보증 모름'); expect(none).toContain('자산 원장에 이 서버가 없습니다 — 끝남에도 정상에도 넣지 않습니다.');
    const un = await warranty({ chk: { d: D({ warranty: null, assetsUnreadable: true }), err: '' } });
    expect(text(un)).toContain('자산 원장 파일을 읽지 못해 보증을 판정하지 않았습니다'); expect(un).not.toContain('class="vmh-kv"');
    const err = text(await warranty({ chk: { d: null, err: '서버를 찾지 못했습니다.' } }));
    expect(err).toContain('보증 · 펌웨어 · BIOS 점검'); expect(err).toContain('서버를 찾지 못했습니다.');
  });
});

describe('펌웨어 기준선 · BIOS 설정 편차 구역', () => {
  it('표 — 구성요소 · 설치 · 기준(근거) · 상태 / 설정 · 이 서버 · 다수 값 · 비교(다른 설정이 먼저)', async () => {
    const html = await fwbios({ chk: { d: D(), err: '' } });
    const t = text(html);
    for (const s of ['펌웨어 기준선', '뒤처짐 1', '기준과 다른 구성요소 1개', '구성요소', '설치 버전 · 기준', 'BIOS BIOS 2.19.1 기준 2.21.2 · 다수 버전 · 3대 중 2대 뒤처짐',
      'Integrated Dell Remote Access Controller iDRAC 7.00.00.171 기준 7.00.00.171 · 관리자 지정 같음', 'Synth NIC NIC 섞임 기준 없음 섞임', 'Turbo Mode Enabled 다수 Disabled · 2대 다름',
      '‘뒤처짐’ 은 기준과 다르다는 뜻이고 올려야 한다는 판정이 아닙니다.', '디스크 · 진단 등 2개는 대조하지 않습니다',
      'BIOS 설정 편차', '다른 설정 1', '같은 폴더 · 같은 모델 3대(이 서버 포함)를 견줌', '다수 값이 옳다는 뜻은 아닙니다']) expect(t).toContain(s);
    expect(html).not.toContain('`');   // 그려진 글자에 백틱이 없다(소스의 작은따옴표 문자열만 보던 스윕은 JSX 글자 · title 을 보지 않았다 — 반증 T2)
    expect(t.indexOf('Turbo Mode')).toBeLessThan(t.indexOf('Boot Mode'));   // 다른 설정이 먼저
    expect(t.indexOf('Turbo Mode')).toBeGreaterThan(0);
    // 판정에 쓴 인벤토리를 읽은 시각 — 두 구역 머리에(없으면 쓰지 않는다 · 0 을 지어내지 않는다)
    const NOW = 1_800_000_000_000;
    const aged = text(await fwbios({ chk: { d: D({ invAt: NOW - 3 * 86_400_000 }), err: '' }, now: NOW }));
    expect((aged.match(/인벤토리 3일 전 읽음/g) || []).length).toBe(2);
    expect(aged).toContain('기준과 다른 구성요소 1개 · 인벤토리 3일 전 읽음');
    expect(t).not.toContain('인벤토리'); expect(text(await fwbios({ chk: { d: D({ invAt: null }), err: '' }, now: NOW }))).not.toContain('읽음');
    expect(html).not.toContain('기준으로 지정'); expect(html).not.toContain('지정 해제');   // 허용받지 않은 계정에는 단추가 없다
    expect((html.match(/<th[ >]/g) || []).length).toBe(6);   // 표마다 세 열 — 400px 드로어에서 상태가 가로 스크롤 밖으로 밀리지 않게
    expect((html.match(/<table/g) || []).length).toBe(2);
  });
  it('기준 지정 단추 — 서버가 허용했고 처리기가 있을 때만 · 지정된 줄은 해제 · 섞인 줄은 단추 없음', async () => {
    const html = await fwbios({ chk: { d: D({ canBaseline: true }), err: '' }, onBaseline: () => {} });
    const t = text(html);
    expect(t).toContain('기준으로 지정'); expect(t).toContain('지정 해제');
    expect((html.match(/>기준으로 지정</g) || []).length).toBe(1);   // BIOS 줄만(섞임 줄은 단추 없음 · 지정 줄은 해제)
    expect((html.match(/>지정 해제</g) || []).length).toBe(1);
    expect(html).toContain('전 법인의 같은 모델에 적용됩니다');
    expect(await fwbios({ chk: { d: D({ canBaseline: true }), err: '' } })).not.toContain('기준으로 지정');   // 처리기 없음
    // 처리기가 있어도 **서버가 허용하지 않은 계정**(canBaseline false)에는 단추가 없다(변이 w26: 처리기만 보면 누구에게나 단추가 그려진다)
    const denied = await fwbios({ chk: { d: D({ canBaseline: false }), err: '' }, onBaseline: () => {} });
    expect(denied).not.toContain('기준으로 지정'); expect(denied).not.toContain('지정 해제');
    const busy = await fwbios({ chk: { d: D({ canBaseline: true }), err: '' }, onBaseline: () => {}, busy: true, baseNote: { ok: false, text: '저장하지 못했습니다.' } });
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>기준으로 지정/); expect(busy).toContain('role="alert"'); expect(text(busy)).toContain('저장하지 못했습니다.');
  });
  it('못 읽음 · 보내지 않음 · 미분류 — 표를 그리지 않고 이유를 쓴다 / 읽는 중 · 조회 실패 · ESXi 는 그리지 않는다', async () => {
    const html = await fwbios({ chk: { d: D({ fw: { state: 'unsent', rows: [], behind: 0 }, bios: { state: 'unplaced', rows: [], diff: 0, group: { size: 0, known: 0 } } }), err: '' } });
    const t = text(html);
    expect(html).not.toContain('<table');
    for (const s of ['엣지에서 받지 못함', '엣지에서 펌웨어 목록을 받지 못했습니다', '미분류 — 판정 안 함', '미분류 서버는 견주지 않습니다']) expect(t).toContain(s);
    expect(t).not.toContain('올려야 한다는 판정');   // 표가 없으면 표 설명도 없다
    const nohw = text(await fwbios({ chk: { d: D({ fw: null, bios: null, noHw: true }), err: '' } }));
    expect(nohw).toContain('하드웨어 정보를 찾지 못해 펌웨어를 대조하지 않았습니다.'); expect(nohw).toContain('하드웨어 정보를 찾지 못해 BIOS 설정을 견주지 않았습니다.');
    // 갈림 — ‘뒤처진 것 없음’ · ‘다른 설정 없음’ 이라고 쓰지 않는다
    const spHtml = await fwbios({ chk: { d: D({ fw: { ...FW, state: 'split', behind: 0, open: 1, rows: [FW.rows[2]] }, bios: { ...BIOS, state: 'split', diff: 0, open: 1, rows: [{ k: 'ProcTurboMode', v: 'Enabled', major: null, majorN: 0, known: 2, state: 'tie' }] } }), err: '' } });
    const sp = text(spHtml);
    for (const s of ['갈림 — 판정 못 함', '판정하지 못한 구성요소 1개', '갈림 — 다수 없음', '다수 없음']) expect(sp).toContain(s);
    // 배지가 녹색 ‘없음’ 이 아니다(설명 글에는 그 낱말이 ‘…으로 보지 않습니다’ 로 나온다 — 배지만 본다)
    expect(spHtml).not.toContain('>뒤처진 것 없음<'); expect(spHtml).not.toContain('>다른 설정 없음<'); expect(spHtml).not.toContain('badge green');
    expect(await fwbios({ chk: { d: null, err: '' } })).toBe('');
    expect(await fwbios({ chk: { d: null, err: 'x' } })).toBe('');
    // 값이 남아 있는데 조회 실패가 서 있으면 그리지 않는다(위 줄은 d 가 null 이라 먼저 끝난다 — err 검사를 따로 고정: 반증 T1)
    expect(await fwbios({ chk: { d: D(), err: '실패' } })).toBe('');
    expect(await fwbios({ r: { ...R, kind: 'esxi' }, chk: { d: D(), err: '' } })).toBe('');
  });
});

describe('자산 원장 올리기 창', () => {
  it('처음 — 지금 원장 · 파일 고르기 · 샘플 · 바꾸기 설명 · 검증/적용은 잠겨 있다', async () => {
    const { default: AssetLedger } = await import('./AssetLedger.jsx');
    const html = renderToStaticMarkup(React.createElement(AssetLedger, { meta: { n: 12, at: null }, onClose: () => {}, onChanged: () => {} }));
    const t = text(html);
    for (const s of ['자산 원장(보증 · 계약) 올리기', '포탈은 제조사에 조회하지 않습니다', '지금 원장: 12줄 · 아직 올린 적 없음', '파일 고르기', '고른 파일 없음', '샘플 CSV', '지금 원장 내려받기',
      '원장을 이 파일로 바꾸기 — 파일에 없는 서버를 원장에서 지웁니다', '파일에 없는 열은 원장의 값을 그대로 두고, 열이 있는데 칸이 비어 있으면 그 값을 지웁니다']) expect(t).toContain(s);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>검증<\/button>/); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>적용<\/button>/);
    const un = text(renderToStaticMarkup(React.createElement(AssetLedger, { meta: { unreadable: true }, onClose: () => {} })));
    expect(un).toContain('파일을 읽지 못했습니다(서비스 점검에서 확인 — 올리기가 막힙니다)');
  });
});

describe('소스 스윕 — 연결 · 규약', () => {
  it('드로어 — 점검 1건 조회(열 때 · 기준을 지정하면 다시) · 구역 자리 · 관리자 판본 표지 · 훅은 조기 return 위', () => {
    const s = read('./BmDrawer.jsx');
    const early = s.indexOf('if (!r) return null;');
    for (const hook of ["useOnce('/tools/bm-folders/check', r?.key || '', { n: chkRev, g: gen }, !!r)", 'const [chkRev, setChkRev] = useState(0);', 'const [baseBusy, setBaseBusy] = useState(false);']) {
      const i = s.indexOf(hook); expect(i, hook).toBeGreaterThan(0); expect(i, hook).toBeLessThan(early);
    }
    expect(s).toMatch(/afterIdent=\{<WarrantySection chk=\{chk\} admin=\{admin && !scoped\} \/>\}/);
    expect(s).toMatch(/afterSpec=\{<FwBiosSections r=\{r\} chk=\{chk\} onBaseline=\{onBaseline\} busy=\{baseBusy\} baseNote=\{baseNote && baseNote\.key === r\.key \? baseNote : null\} \/>\}/);
    // 구역 순서: 식별 · 배치 → (보증) → iDRAC · 관리 → 하드웨어 요약 → (펌웨어 · BIOS) → 부품 목록
    const at = (x) => { const i = s.indexOf(x); expect(i, x).toBeGreaterThan(0); return i; };
    expect(at('aria-label="식별 · 배치"')).toBeLessThan(at('{afterIdent}')); expect(at('{afterIdent}')).toBeLessThan(at('aria-label="iDRAC · 관리"'));
    expect(at('aria-label="하드웨어 요약"')).toBeLessThan(at('{afterSpec}')); expect(at('{afterSpec}')).toBeLessThan(at('aria-label="부품 목록"'));
    // 기준 지정은 관리 라우트로 · 성공하면 다시 묻는다 · 다른 서버의 결과를 보이지 않는다
    expect(s).toMatch(/postJson\('\/admin\/bm-fw-baseline', \{ model, key: row\.key, label: row\.label, type: row\.type, version \}\)/);
    // 다시 묻기 · 목록 다시 읽기는 **성공 경로**(try 안 · catch 앞)에 있다 — 실패 쪽으로 옮기면 잡힌다(반증 T5) · 결과 글자는 그 서버 키로
    const ob = s.slice(s.indexOf('const onBaseline = async'), s.indexOf('const onKey = (e) =>'));
    const pos = (x) => { const i = ob.indexOf(x); expect(i, x).toBeGreaterThan(0); return i; };
    expect(pos('setChkRev((n) => n + 1);')).toBeLessThan(pos('} catch (e) {'));
    expect(pos('onChanged?.();')).toBeLessThan(pos('} catch (e) {'));
    expect(pos("setBaseNote({ key: r.key, ok: true,")).toBeLessThan(pos('} catch (e) {'));
    expect(pos('} catch (e) {')).toBeLessThan(pos('setBaseNote({ key: r.key, ok: false,'));
    // 목록의 세대가 바뀌면 점검을 다시 묻는다(폴더에 넣기 · 빼기 뒤 BIOS 묶음이 달라진다 — 반증 B1)
    expect(read('../BmFolders.jsx')).toMatch(/gen=\{`\$\{d\.rev \?\? ''\}:\$\{d\.at \?\? ''\}`\} onChanged=\{\(\) => load\(\)\}/);
  });
  it('목록 — 칩 · 따로 센 것 · 자산 원장 단추(전체 범위 관리자만) · 드로어에 관리자 표지', () => {
    const s = read('../BmFolders.jsx');
    expect(s).toMatch(/const chkN = useMemo\(\(\) => chkCounts\(baseRows\), \[baseRows\]\);/);
    expect(s).toMatch(/chkChips\(chkN, d\.check\?\.soonDays\)\.map\(/);
    expect(s).toMatch(/\{d\.canFleet \? <button type="button" className="logout-btn" style=\{btn\} onClick=\{\(\) => setLedger\(true\)\}/);
    expect(s).toMatch(/\{ledger \? <AssetLedger meta=\{d\.check\?\.assets\} onClose=\{\(\) => setLedger\(false\)\} onChanged=\{\(\) => load\(\)\} \/> : null\}/);
    // 판정하지 않았다는 안내를 목록에도 쓴다 · 칩이 사라진 거르기는 푼다(반증 B5)
    expect(s).toMatch(/\{chkNotices\(d\.check\)\.map\(/);
    expect(s).toMatch(/if \(d && CHK_QUICK\.includes\(quick\) && !chkKeys\.split\(','\)\.includes\(quick\)\) setQuick\(''\);/);
    // 훅(chkN)은 조기 return 위
    const first = s.indexOf('const chkN = useMemo('); const ret = s.search(/\n {2}if \((?:err|!d)[^\n]*\) return /);
    expect(first).toBeGreaterThan(0); expect(ret).toBeGreaterThan(0); expect(first).toBeLessThan(ret);
  });
  it('자산 원장 창 — 적용은 미리본 원장(base)을 함께 보낸다 · CSV 권한이 없으면 단추를 잠그고 이유를 쓴다', () => {
    const s = read('./AssetLedger.jsx');
    expect(s).toMatch(/postJson\('\/admin\/bm-assets\/import', \{ csv: text, dryRun, replace, \.\.\.\(dryRun \? \{\} : \{ expect: res\?\.base \}\) \}\)/);
    expect(s).toMatch(/const checked = !!res && res\.sig === sig;/);   // 검증한 글자 · 바꾸기 선택과 같을 때만 적용이 열린다
    // 바꾸기 + 오류 줄이면 적용이 잠긴다 · 적용이 끝나면 목록을 다시 읽고(onChanged) 다시 검증해야 적용이 열린다(반증 T4 · B11)
    expect(s).toMatch(/const blocked = replace && s && s\.error > 0;/);
    expect(s).toMatch(/if \(r\.changed\) onChanged\?\.\(\);/);
    expect(s).toMatch(/setRes\(\{ \.\.\.r, sig: '', applied: true \}\);/);
    // 파일은 바이트로 받아 글자 인코딩을 판별한다(f.text() 는 UTF-8 로만 읽는다 — 반증 B3) · 깨진 글자가 있으면 올리지 않는다
    expect(s).toMatch(/decodeCsvBytes\(await f\.arrayBuffer\(\)\)/); expect(s).not.toMatch(/await f\.text\(\)/);
    expect(s).toMatch(/if \(t\.includes\('\\uFFFD'\)\)/);
    expect(s).toMatch(/disabled=\{busy \|\| !csvOk \|\| !checked \|\| blocked/);
    expect(s).toMatch(/\{csvOk \? null : <div className="muted bmd-note" role="status">\{CSV_DENIED_NOTE\}<\/div>\}/);
  });
  it('표는 공용 STable · 문구에 백틱 없음 · 대문자 변환 없음 · 숫자 기준을 화면에 박지 않는다', () => {
    for (const f of ['./CheckSections.jsx', './AssetLedger.jsx']) {
      const s = read(f);
      expect(s, f).not.toMatch(/<table/); expect(s, f).toMatch(/<STable /);
      for (const x of s.match(/'[^'\n]*[가-힣][^'\n]*'/g) || []) expect(x, x).not.toContain('`');
    }
    expect(read('./checkText.js')).not.toMatch(/90일/);   // 보증 '곧' 의 기준 일수는 서버 값(soonDays)
    expect(raw('../../../styles.css').split('\n').filter((l) => /\.bmd-(ct|al|chk)/.test(l)).join('\n')).not.toMatch(/text-transform/);
    // 전역 tbody td 가 nowrap 이다 — 드로어 표는 줄바꿈을 켠다(끄면 400px 에서 상태 열이 화면 밖으로 밀린다)
    expect(raw('../../../styles.css')).toMatch(/\.bmd-ct th, \.bmd-ct td \{[^}]*white-space: normal;/);
    expect(raw('../../../styles.css')).toMatch(/\.bmd-ct \.badge \{ white-space: nowrap; \}/);   // 배지가 글자마다 꺾이지 않게(반증 B4)
    for (const cls of ['.bmd-ct {', '.bmd-ct-sub {', '.bmd-al {', '.bmd-chk-aside {', '.bmd-sh-sub {']) expect(raw('../../../styles.css')).toContain(cls);
  });
});

describe('CSV 글자 인코딩 판별(공용 csvDecode — 자산 원장 올리기)', () => {
  it('UTF-8 · EUC-KR(한국어 엑셀 저장본) · UTF-16 을 읽는다 — 한글이 깨진 채 올라가지 않는다(반증 B3)', async () => {
    const { decodeCsvBytes } = await import('../csvDecode.js');
    const utf8 = new TextEncoder().encode('service_tag,note\nSYNTH01,교체 검토');
    expect(decodeCsvBytes(utf8)).toEqual({ text: 'service_tag,note\nSYNTH01,교체 검토', encoding: 'utf-8' });
    // '교체' 의 EUC-KR 바이트(B1 B3 C3 BC) — UTF-8 로는 못 읽는 바이트열이다
    const euckr = Uint8Array.from([...new TextEncoder().encode('service_tag,note\nSYNTH01,'), 0xb1, 0xb3, 0xc3, 0xbc]);
    const r = decodeCsvBytes(euckr);
    expect(r.encoding).toBe('euc-kr'); expect(r.text).toBe('service_tag,note\nSYNTH01,교체'); expect(r.text).not.toContain('\uFFFD');
    const u16 = Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x00, 0xac]);   // BOM + 'A' + '가'
    expect(decodeCsvBytes(u16)).toEqual({ text: 'A가', encoding: 'utf-16' });
    expect(decodeCsvBytes(utf8.buffer).encoding).toBe('utf-8');   // ArrayBuffer 도 받는다
    // 집중 모니터링 쪽 import 는 그대로 같은 함수를 받는다(옮기며 두 벌이 되지 않았다)
    const fm = await import('../focusMonText.js');
    expect(fm.decodeCsvBytes).toBe(decodeCsvBytes);
  });
});
