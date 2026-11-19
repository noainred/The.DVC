// v3.5.0 — IP 관리 재설계 묶음 나(웹): 엑셀 창 · 용도 · 요청자 · 할당자 · 대역 용도 · 상세 창 하나. 설계 docs/design/ipam-redesign.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { exportUrl, EXPORT_SHEET_OPTS } from './IpamExportModal.jsx';
import { topSubnets, filterSubnets, occOf } from './ipamHomeText.js';

const read = (f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const serverSheets = fs.readFileSync(new URL('../../../../server/src/ipam/excelExtra.js', import.meta.url), 'utf8');

describe('엑셀 창', () => {
  it('고른 시트만 주소에 싣고, 하나도 없으면 내려받지 않는다 · 범위를 넘긴다', () => {
    expect(exportUrl({ summary: true, ledger: true })).toBe('/tools/ipam.xlsx?sheets=summary%2Cledger');
    expect(exportUrl({ ledger: true }, 'vc-1')).toBe('/tools/ipam.xlsx?vcenterId=vc-1&sheets=ledger');
    expect(exportUrl({})).toBe(null);
  });
  it('시트 키는 서버 EXPORT_SHEETS 와 같다', () => {
    const m = /EXPORT_SHEETS = Object\.freeze\(\[([^\]]+)\]\)/.exec(serverSheets);
    const server = m[1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(EXPORT_SHEET_OPTS.map(([k]) => k)).toEqual(server);
  });
});

describe('대역 용도 · 점유', () => {
  it('점유 = 대장 + 예약 + DHCP(254 상한) · 상위 목록에 용도 · 용도로 찾기', () => {
    expect(occOf({ used: 250, rsv: 5, dhcp: 5 })).toBe(254);
    const t = topSubnets([{ base: 'a', subnet: 'a/24', used: 10, rsv: 100, purpose: '백업망' }, { base: 'b', subnet: 'b/24', used: 50 }], 2);
    expect(t[0]).toMatchObject({ base: 'a', used: 110, purpose: '백업망' });
    expect(filterSubnets([{ base: '10.1.1', subnet: '10.1.1.0/24', purpose: '웹 서비스망' }], '웹').length).toBe(1);
  });
});

describe('소스 계약', () => {
  it('목록의 IP 를 누르면 상세 창 하나(관리 정보 · 소유 자원 · 원격 접속)가 열린다', () => {
    const core = read('IpamCore.jsx');
    expect(core).toMatch(/onClick=\{\(\) => setHistIp\(r\)\}>\{\/\* v3\.5\.0/);
    expect(core).toMatch(/<MgmtBlock row=\{row\}/);
    expect(core).toMatch(/title=\{`IP 상세 — \$\{ip\}`\}/);
  });
  it('편집기 · 서브넷 대장 · 목록이 새 칸을 쓴다', () => {
    const ed = read('IpamEditors.jsx');
    for (const k of ['purpose', 'requester', 'assigner']) expect(ed).toMatch(new RegExp(`fields = \\{[^}]*\\b${k}\\b`));
    const core = read('IpamCore.jsx');
    expect(core).toMatch(/<th>\{base\}\.X<\/th><th>용도<\/th><th>요청자<\/th><th>할당자<\/th>/);
    expect(core).toMatch(/key: 'ipPurpose', label: '용도'/);
  });
});
