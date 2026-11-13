// 물리서버 폴더 하드웨어(iDRAC) 글자 · iDRAC 접속 주소(v3.3.0). 값이 없으면 '—'/'' (0 으로 쓰지 않는다) · 접속 주소는 호스트 글자만.
import { describe, it, expect } from 'vitest';
import { cpuText, memText, diskText, nicText, hbaText, osText, hwLines, hwSortKey, speedText, diskSizeText, memSizeText, splitHost, idracLinks, hwWhyText } from './hwText.js';

const HW = {
  v: 1, at: 1, cpu: { sockets: 2, cores: 48, threads: 96, model: 'X' }, mem: { gib: 512, dimms: 16 },
  disk: { n: 4, gb: 13760, ssd: 3, hdd: 1, nvme: 1 }, nic: { ports: 4, up: 3, maxGbps: 25, speeds: [[25, 2], [1, 2]] },
  hba: { n: 1, ports: 2 }, os: { name: 'Red Hat Enterprise Linux', ver: '9.2' }, host: 'h', fw: 'f',
};

describe('하드웨어 글자', () => {
  it('요약 세 줄', () => {
    expect(hwLines(HW)).toEqual({ l1: '2×24C · 512 GB', l2: 'SSD 3 · HDD 1 · 13.8 TB', l3: '25G×2 · 1G×2 · FC 1(2포트)' });
    expect(hwLines(null)).toBe(null);
    expect(hwLines({ v: 1 })).toEqual({ l1: '—', l2: '—', l3: '—' });
    expect(hwSortKey(HW)).toBe(48); expect(hwSortKey(null)).toBe(null);
  });
  it('못 읽은 값은 0 이 아니다', () => {
    expect(cpuText({ sockets: 2, cores: null })).toBe('2소켓');
    expect(cpuText({ sockets: 3, cores: 50 })).toBe('50C');
    expect(cpuText({ sockets: 1, cores: 16 })).toBe('16C');
    expect(memText({ gib: null, dimms: 16 })).toBe('');
    expect(diskText({ n: 2, gb: null, ssd: 1, hdd: 1 })).toBe('SSD 1 · HDD 1');
    expect(diskText({ n: 0, gb: 0 })).toBe('디스크 없음');
    expect(diskText({ n: 3, gb: 300, ssd: 0, hdd: 0 })).toBe('기타 3 · 300 GB');
    expect(diskText({ n: null })).toBe('');
    expect(nicText({ ports: 2, speeds: [] })).toBe('2포트');
    expect(nicText({ ports: null, speeds: [] })).toBe('');
    expect(hbaText({ n: 0, ports: 0 })).toBe('FC 없음');
    expect(hbaText({ n: 2, ports: null })).toBe('FC 2');
    expect(hbaText({ n: null })).toBe('');
    expect(hbaText(null)).toBe('');
  });
  it('단위', () => {
    expect([speedText(0.1), speedText(1), speedText(2.5), speedText(25), speedText(null), speedText(0)]).toEqual(['100M', '1G', '2.5G', '25G', '', '']);
    expect([diskSizeText(960), diskSizeText(15360), diskSizeText(null)]).toEqual(['960 GB', '15.4 TB', '']);
    expect([memSizeText(512), memSizeText(1024), memSizeText(1536), memSizeText(null)]).toEqual(['512 GB', '1 TB', '1.5 TB', '']);
  });
  it('OS — 표 칸은 줄인 이름, 툴팁은 전체', () => {
    expect(osText({ name: 'Red Hat Enterprise Linux', ver: '9.2' })).toEqual({ short: 'RHEL 9.2', full: 'Red Hat Enterprise Linux 9.2' });
    expect(osText({ name: 'Microsoft Windows Server 2022 Standard', ver: '10.0.20348' }).short).toBe('Windows Server 2022 Standard');
    expect(osText({ name: 'VMware ESXi', ver: '8.0.2' }).short).toBe('ESXi 8.0.2');
    expect(osText({ name: 'Ubuntu 22.04.4 LTS', ver: '22.04.4 LTS' }).short).toBe('Ubuntu 22.04.4 LTS', '이름에 버전이 들어 있으면 두 번 쓰지 않는다');
    expect(osText(null)).toEqual({ short: '', full: '' });
  });
  it('빈 이유 — 엣지 미전송과 인벤토리 없음을 가른다', () => {
    expect(hwWhyText({ hwVia: 'edge' })).toMatch(/엣지/);
    expect(hwWhyText({ hwVia: 'local' })).toMatch(/인벤토리/);
  });
});

describe('iDRAC 접속 주소', () => {
  it('웹은 등록 주소(포트 포함) · SSH 는 포트를 뗀 호스트', () => {
    expect(idracLinks('192.0.2.5')).toEqual({ web: 'https://192.0.2.5/', ssh: 'ssh://root@192.0.2.5', cmd: 'ssh root@192.0.2.5', sshHost: '192.0.2.5', user: 'root' });
    expect(idracLinks('192.0.2.5:8443', 'admin').web).toBe('https://192.0.2.5:8443/');
    expect(idracLinks('192.0.2.5:8443', 'admin').ssh).toBe('ssh://admin@192.0.2.5');
    expect(idracLinks('idrac-x.example.test').cmd).toBe('ssh root@idrac-x.example.test');
    const v6 = idracLinks('2001:db8::5');
    expect([v6.web, v6.ssh, v6.cmd]).toEqual(['https://[2001:db8::5]/', 'ssh://root@[2001:db8::5]', 'ssh root@2001:db8::5']);
    expect(idracLinks('[2001:db8::5]:443').web).toBe('https://[2001:db8::5]:443/');
  });
  it('주소 · 계정이 형식이 아니면 링크를 만들지 않는다(계정은 root 로)', () => {
    for (const bad of ['', 'a b', 'javascript:alert(1)', 'x@y', '192.0.2.5/x', '"><img>', 'host:port', '[::1', '[::1]x']) expect(idracLinks(bad), bad).toBe(null);
    expect(idracLinks('192.0.2.5', 'ro ot;rm').user).toBe('root');
    expect(idracLinks('192.0.2.5', '').user).toBe('root');
    expect(splitHost('192.0.2.5:99999')).toBe(null);
  });
});
