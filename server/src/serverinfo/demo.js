/**
 * serverinfo/demo.js — 데모(mock) 서버의 합성 서버 정보(순수 · 서버 id 로 정해지는 값 — 누를 때마다 바뀌지 않게).
 * 사람이 등록한 서버에는 쓰지 않는다(service.readOne 이 isDemoId 일 때만 — bm-storage 데모와 같은 규칙).
 * 값은 그림용 가상값이다(제조사 · 모델 이름도 가상 — ‘가상’ 을 붙인다). 권한이 필요한 칸(시리얼 · 디스크 상태)은 Linux 에서 ‘못 읽음 · 권한’ 으로 보인다(실제와 같은 모양).
 */
import crypto from 'node:crypto';

const seedOf = (id) => crypto.createHash('sha256').update(String(id)).digest();
const cell = (value, reason = '') => (value == null ? { value: null, missing: true, reason: reason || 'unread' } : { value, missing: false });

export function demoServerInfo(s) {
  const h = seedOf(s.id);
  const win = s.os === 'windows';
  const cores = [16, 24, 32, 48, 64][h[0] % 5];
  const memGb = [128, 256, 384, 512, 768][h[1] % 5];
  const nDisks = 2 + (h[2] % 4);
  const base = {
    os: cell(win ? 'Microsoft Windows Server 2022 Standard (10.0.20348)' : ['Rocky Linux 9.4 (Blue Onyx)', 'Red Hat Enterprise Linux 8.10 (Ootpa)', 'Ubuntu 22.04.4 LTS'][h[3] % 3]),
    kernel: cell(win ? 'build 20348' : ['Linux 5.14.0-427.13.1.el9_4.x86_64', 'Linux 4.18.0-553.el8_10.x86_64', 'Linux 5.15.0-105-generic'][h[3] % 3]),
    hostname: cell(`${s.name || s.host}.corp.example`),
    vendor: cell('가상제조'),
    model: cell(`가상 서버 GX-${600 + (h[4] % 5) * 10}`),
    serial: win ? cell(`VSN${h.readUInt32BE(5).toString(16).toUpperCase()}`) : cell(null, 'permission'),
    bios: cell(`가상 BIOS 2.${h[9] % 20}.${h[10] % 9}`),
    cpuModel: cell(`가상 CPU ${cores / 2}C @ 2.${h[11] % 9}GHz`),
    cpuSockets: cell(2),
    cpuCores: cell(cores),
    cpuThreads: cell(cores * 2),
    memBytes: cell(memGb * 1024 ** 3),
    swapBytes: win ? cell(null, 'absent') : cell(8 * 1024 ** 3),
  };
  const disks = Array.from({ length: nDisks }, (_, i) => {
    const ssd = (h[12 + i] % 3) !== 0;
    const size = ssd ? [480, 960, 1920, 3840][h[16 + i] % 4] * 1e9 : [2400, 4000, 8000][h[16 + i] % 3] * 1e9;
    return win
      ? { dev: `Disk ${i}`, model: `가상 ${ssd ? 'SSD' : 'HDD'}-${Math.round(size / 1e9)}`, serial: `VD${i}${h[20 + i].toString(16)}`, wwn: '', sizeBytes: size, media: ssd ? 'SSD' : 'HDD', tran: 'SAS', health: 'Healthy' }
      : { dev: i === 0 && ssd ? '/dev/nvme0n1' : `/dev/sd${String.fromCharCode(97 + i)}`, model: `가상 ${ssd ? 'SSD' : 'HDD'}-${Math.round(size / 1e9)}`, serial: `VD${i}${h[20 + i].toString(16)}`, wwn: '', sizeBytes: size, media: ssd ? 'SSD' : 'HDD', tran: i === 0 && ssd ? 'nvme' : 'sas' };
  });
  const fsRow = (mount, gb, pct, type) => ({ source: '', type, mount, sizeKB: gb * 1024 * 1024, usedKB: Math.round(gb * 1024 * 1024 * pct / 100), availKB: Math.round(gb * 1024 * 1024 * (100 - pct) / 100), usePct: pct });
  const fs = win
    ? [fsRow('C:', 200, 30 + (h[24] % 50), 'NTFS'), fsRow('D:', 2000, 20 + (h[25] % 70), 'NTFS')]
    : [fsRow('/', 70, 20 + (h[24] % 60), 'xfs'), fsRow('/var', 100, 10 + (h[26] % 70), 'xfs'), fsRow('/data', 3500, 15 + (h[25] % 80), 'xfs')];
  return { ok: true, code: 'ok', os: win ? 'windows' : 'linux', via: 'ssh', auth: { kind: 'key', account: 'demo-svc', source: 'corp' }, ms: 800 + (h[27] % 1200), demo: true, base, disks, fs };
}
