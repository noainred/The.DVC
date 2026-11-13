/**
 * 물리서버 폴더 — 하드웨어(iDRAC) 요약 글자(순수 · v3.3.0). 판정(요약 값)은 서버 `idrac/hwSummary.js` — 여기서는 글자만 만든다.
 * 값이 없으면 '—'(0 으로 쓰지 않는다 · 단위를 붙이지 않는다 — CLAUDE.md '못 읽은 값은 0 이 아니다').
 */
import { numOrNull } from '../../../numOrNull.js';

const N = (v) => numOrNull(v);
const r1 = (x) => Math.round(x * 10) / 10;

/** 링크 속도(Gbps) → '100M' · '1G' · '2.5G' · '25G'. */
export function speedText(gbps) {
  const g = N(gbps);
  if (g == null || g <= 0) return '';
  return g < 1 ? `${Math.round(g * 1000)}M` : `${r1(g)}G`;
}
/** 디스크 용량(GB, 10진) → '960 GB' · '15.4 TB'. */
export function diskSizeText(gb) {
  const g = N(gb);
  if (g == null) return '';
  return g >= 1000 ? `${r1(g / 1000)} TB` : `${Math.round(g)} GB`;
}
/** 메모리(GiB) → '512 GB' · '1 TB' · '1.5 TB'(GiB 를 사람들이 부르는 대로 GB/TB 로). */
export function memSizeText(gib) {
  const g = N(gib);
  if (g == null) return '';
  return g >= 1024 ? `${r1(g / 1024)} TB` : `${Math.round(g)} GB`;
}
/** CPU — 소켓 × 소켓당 코어('2×24C'), 나누어떨어지지 않으면 합계('48C'). */
export function cpuText(cpu) {
  if (!cpu) return '';
  const so = N(cpu.sockets); const co = N(cpu.cores);
  if (co == null) return so != null ? `${so}소켓` : '';
  if (so != null && so > 1 && co % so === 0) return `${so}×${co / so}C`;
  return `${co}C`;
}
export function memText(mem) {
  if (!mem) return '';
  return memSizeText(mem.gib);
}
/** 디스크 — 'SSD 8 · HDD 2 · 15.4 TB'. 읽었고 없으면 '디스크 없음'. 합을 못 냈으면(일부 용량 못 읽음) 개수만. */
export function diskText(disk) {
  if (!disk) return '';
  const n = N(disk.n);
  if (n == null) return '';
  if (n === 0) return '디스크 없음';
  const ssd = N(disk.ssd) || 0; const hdd = N(disk.hdd) || 0; const other = Math.max(0, n - ssd - hdd);
  const parts = [ssd ? `SSD ${ssd}` : '', hdd ? `HDD ${hdd}` : '', other ? `기타 ${other}` : ''].filter(Boolean);
  const size = diskSizeText(disk.gb);
  return [parts.join(' · ') || `${n}개`, size].filter(Boolean).join(' · ');
}
/** NIC — 속도별 포트('25G×2 · 1G×2'). 속도를 못 읽었으면 포트 수만. */
export function nicText(nic) {
  if (!nic) return '';
  const sp = Array.isArray(nic.speeds) ? nic.speeds.filter((x) => Array.isArray(x) && speedText(x[0]) && N(x[1]) != null) : [];
  if (sp.length) return sp.map(([g, c]) => `${speedText(g)}×${c}`).join(' · ');
  const p = N(nic.ports);
  return p != null ? `${p}포트` : '';
}
/** FC HBA — 'FC 2' · 'FC 1(2포트)' · 'FC 없음'. 못 읽었으면 ''. */
export function hbaText(hba) {
  if (!hba) return '';
  const n = N(hba.n);
  if (n == null) return '';
  if (n === 0) return 'FC 없음';
  const p = N(hba.ports);
  return p ? `FC ${n}(${p}포트)` : `FC ${n}`;
}
const OS_SHORT = [
  [/^red hat enterprise linux( server)?/i, 'RHEL'],
  [/^microsoft windows server/i, 'Windows Server'],
  [/^vmware esxi/i, 'ESXi'],
  [/^suse linux enterprise server/i, 'SLES'],
];
/** OS — { short, full }. short 는 표 칸(‘RHEL 9.2’), full 은 툴팁. 없으면 둘 다 ''. */
export function osText(os) {
  const name = String(os?.name || '').trim(); const ver = String(os?.ver || '').trim();
  if (!name && !ver) return { short: '', full: '' };
  let short = name;
  for (const [re, to] of OS_SHORT) if (re.test(short)) { short = short.replace(re, to); break; }
  // Windows 는 이름에 판(2022)이 들어 있고 버전은 빌드 번호라 표 칸에는 이름만
  const showVer = ver && !/^windows/i.test(short) && !short.includes(ver);
  return { short: [short, showVer ? ver : ''].filter(Boolean).join(' ').slice(0, 60), full: [name, ver].filter(Boolean).join(' ') };
}

/**
 * 표 칸 세 줄 — CPU · 메모리 / 디스크 / NIC · HBA. 줄마다 없으면 '—'.
 * compact(표 칸): FC 가 없으면(읽었고 0) 'FC 없음' 을 쓰지 않는다 — 1440px 실측에서 가장 긴 줄이 열 폭을 정했다(옆 패널 · 카드는 그대로 '없음' 을 말한다).
 */
export function hwLines(hw, { compact = false } = {}) {
  if (!hw) return null;
  const join = (...xs) => xs.filter(Boolean).join(' · ') || '—';
  const hba = compact && hw.hba && hw.hba.n === 0 ? '' : hbaText(hw.hba);
  return { l1: join(cpuText(hw.cpu), memText(hw.mem)), l2: join(diskText(hw.disk)), l3: join(nicText(hw.nic), hba) };
}
/** 정렬 값 — 코어 합(없으면 null → 표 정렬에서 뒤로). */
export const hwSortKey = (hw) => N(hw?.cpu?.cores);

/** 하드웨어 칸이 빈 이유(서버가 준 hwVia 로 — 원인을 단정하지 않는다). */
export function hwWhyText(r) {
  if (r?.hwVia === 'edge') return '엣지가 하드웨어 요약을 아직 보내지 않았습니다 — 그 엣지를 이 버전 이상으로 올리면 다음 전송부터 보입니다(엣지 포탈에서는 바로 보입니다).';
  return 'iDRAC 인벤토리를 아직 읽지 못했습니다 — 등록 직후 · 수집 전 · OME 로만 보이는 서버 · 수집 서버가 아직 보내지 않은 경우 비어 있습니다.';
}
/** OS 칸이 빈 이유. */
export const OS_WHY = 'iDRAC 이 OS 이름을 보고하지 않았습니다 — 서버 OS 에 iSM(iDRAC Service Module)이 있어야 채워집니다. 엣지 · 수집 서버가 이 버전보다 낮아도 비어 있습니다.';

/* ───────── iDRAC 접속 주소(웹 · SSH) ───────── */
const HOST_RE = /^[A-Za-z0-9._:[\]-]{1,255}$/;
const USER_RE = /^[A-Za-z0-9._-]{1,32}$/;
/** 'host' · 'host:port' · IPv6 · '[v6]:port' → { host(포트 없음 · URL 용 괄호), port }. 형식이 아니면 null. */
const portOk = (p) => /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
export function splitHost(addr) {
  const a = String(addr || '').trim();
  if (!HOST_RE.test(a)) return null;
  if (a.startsWith('[')) {
    const e = a.indexOf(']'); if (e < 0) return null;
    const rest = a.slice(e + 1);
    if (rest && !(rest.startsWith(':') && portOk(rest.slice(1)))) return null;
    return { host: a.slice(0, e + 1), port: rest ? rest.slice(1) : '' };
  }
  const colons = (a.match(/:/g) || []).length;
  if (colons > 1) return { host: `[${a}]`, port: '' };   // 괄호 없는 IPv6
  if (colons === 1) { const [h, p] = a.split(':'); return h && portOk(p) ? { host: h, port: p } : null; }
  return { host: a, port: '' };
}
/**
 * 접속 주소 — 웹은 등록 주소 그대로(포트 포함 · https), SSH 는 포트를 뗀 호스트(22). 계정이 형식이 아니면 root.
 * @returns {{ web:string, ssh:string, cmd:string, sshHost:string, user:string } | null}
 */
export function idracLinks(addr, user = 'root') {
  const h = splitHost(addr);
  if (!h) return null;
  const u = USER_RE.test(String(user || '')) ? String(user) : 'root';
  const web = `https://${h.host}${h.port ? `:${h.port}` : ''}/`;
  try { const x = new URL(web); if (x.protocol !== 'https:') return null; } catch { return null; }
  const sshHost = h.host.startsWith('[') ? h.host.slice(1, -1) : h.host;
  return { web, ssh: `ssh://${u}@${h.host}`, cmd: `ssh ${u}@${sshHost}`, sshHost, user: u };
}
export const SSH_USER_KEY = 'bmf.idracSshUser';
