/**
 * nameProbe.js — 스캔에 응답한 IP 의 호스트명을 네트워크로 묻는다(v2.991, 사용자 요청 "Angry IP Scanner 처럼 hostname 도 보이게" ·
 * 시안 docs/design/ip-scan-hostname · 컨펌: 방식 3가지 · 새 방식 기본 켜짐 · NetBIOS MAC 수집).
 *
 * 역DNS(dns.reverse)는 scan.js 가 지금처럼 한다. 여기는 대상 장비에 직접 묻는 두 방식이다:
 *   · NetBIOS — 대상 IP 의 UDP 137 로 노드 상태(NBSTAT, 와일드카드 '*') 질의 50바이트 1개. Windows · Samba 가 컴퓨터 이름 ·
 *     작업 그룹 · 어댑터 MAC 을 답한다(RFC 1002 4.2.17~18). 사용자 이름(접미 0x03)은 읽지 않는다(개인정보 — 시안 §5).
 *   · mDNS    — 대상 IP 의 UDP 5353 으로 역방향 PTR(`d.c.b.a.in-addr.arpa`) 질의 1개. 임시 포트에서 보내므로 응답자가 우리 포트로
 *     직접 답한다(RFC 6762 6.7 legacy unicast). **스캐너와 같은 서브넷의 IP 에만** 묻는다 — 응답자는 링크 밖 질의에 답하지 않는다
 *     (RFC 6762 5.5). Angry IP Scanner 는 224.0.0.251 멀티캐스트로 보내지만 여기는 대상 IP 로 직접 보낸다(그 구간의 다른 장비에
 *     질의를 뿌리지 않고, 응답 발신 주소가 곧 대상이라 검증이 단순하다 — README §8).
 *
 * ⚠ 장비가 답한 이름은 신뢰할 수 없는 입력이다: 파서는 오프셋 기반(정규식 없음) · 길이를 먼저 확인 · 이름 압축 포인터는 점프 상한 ·
 *   인쇄 가능한 글자만 · 길이 상한. **물어본 IP · 물어본 포트에서 온, 거래 ID 가 맞는 응답만** 받는다(Angry IP 는 발신 주소를 보지 않는다).
 * ⚠ 소켓은 방식당 UDP 1개로 전 대상을 처리한다(IP 마다 소켓 · 프로세스를 만들지 않는다 — v2.359 FD 폭주 교훈). 전송은 묶음 사이에
 *   쉬고(초당 수천 개 수준), 마지막 전송 뒤 timeoutMs 한 번 기다린다. 이 모듈은 스캔 자식 프로세스(scanWorker)에서 돈다.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import { ipToNum, numToIp } from '../util/ipv4.js';

export const NETBIOS_PORT = 137;
export const MDNS_PORT = 5353;
/** NetBIOS 이름 상한(15자 + 접미 1바이트) · DNS 이름 상한. */
export const NB_NAME_MAX = 15;
export const DNS_NAME_MAX = 253;
const MAX_MSG = 4096;         // 이보다 큰 응답은 보지 않는다(NBSTAT 응답은 수백 바이트)
const SEND_BATCH = 64;        // 한 묶음에 보내는 질의 수
const SEND_GAP_MS = 15;       // 묶음 사이 쉼(약 4,000개/초 — 응답한 IP 에만 묻는다)

// ---- 공용: 이름 바이트 → 표시 글자 ------------------------------------------------
// 인쇄 가능한 ASCII 만 그대로, 그 밖의 바이트는 '?'(지어내지 않고 모른다는 표시), 제어 문자는 버린다.
function asciiText(buf, start, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf[start + i];
    if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c);
    else if (c >= 0x80) s += '?';
  }
  return s;
}

// ---- NetBIOS 노드 상태(NBSTAT) ---------------------------------------------------
/** NBSTAT 요청(50바이트) — 이름 '*'(와일드카드)를 RFC 1001 첫 단계 인코딩한 32바이트 'CKAAAA…'. */
export function nbstatRequest(txid) {
  const b = Buffer.alloc(50);
  b.writeUInt16BE(txid & 0xffff, 0);
  b.writeUInt16BE(0x0000, 2);   // 질의 · 브로드캐스트 아님
  b.writeUInt16BE(1, 4);        // QDCOUNT
  b[12] = 0x20;                 // 이름 길이 32
  b[13] = 0x43; b[14] = 0x4b;   // '*'(0x2A) → 'C','K'
  b.fill(0x41, 15, 45);         // 패딩 0x00 × 15 → 'A','A' × 15
  b[45] = 0x00;                 // 이름 끝
  b.writeUInt16BE(0x0021, 46);  // NBSTAT
  b.writeUInt16BE(0x0001, 48);  // IN
  return b;
}

/** 이름(라벨 열 · 압축 포인터)을 건너뛴 다음 오프셋. 형식이 틀리거나 버퍼를 넘으면 -1. */
export function skipName(buf, off) {
  for (let guard = 0; guard < 128; guard++) {
    if (off >= buf.length) return -1;
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2 <= buf.length ? off + 2 : -1;
    if (len & 0xc0) return -1;   // 0x40·0x80 — 쓰지 않는 라벨 형식
    off += 1 + len;
  }
  return -1;
}

/**
 * NBSTAT 응답 → { name, group, mac } | null. name = 접미 0x00 · unique 이름(없으면 접미 0x20 unique — 파일 서버 이름).
 * group = 접미 0x00 · group 이름(작업 그룹 · 도메인). mac = 이름 표 바로 뒤 6바이트(모두 0 이면 '' — Samba 는 0 을 보낸다).
 */
export function parseNbstat(buf, txid = null) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > MAX_MSG) return null;
  if (txid != null && buf.readUInt16BE(0) !== (txid & 0xffff)) return null;
  const flags = buf.readUInt16BE(2);
  if (!(flags & 0x8000) || (flags & 0x000f) !== 0) return null;   // 응답 아님 · 오류 코드
  if (buf.readUInt16BE(6) < 1) return null;                         // ANCOUNT
  let off = 12;
  const qd = Math.min(buf.readUInt16BE(4), 4);
  for (let i = 0; i < qd; i++) {
    off = skipName(buf, off);
    if (off < 0 || off + 4 > buf.length) return null;
    off += 4;
  }
  off = skipName(buf, off);
  if (off < 0 || off + 10 > buf.length) return null;
  if (buf.readUInt16BE(off) !== 0x0021) return null;
  const rdlen = buf.readUInt16BE(off + 8);
  off += 10;
  const end = off + rdlen;
  if (rdlen < 1 || end > buf.length) return null;
  const n = buf[off];
  off += 1;
  if (off + n * 18 > end) return null;
  let name = ''; let group = ''; let server = '';
  for (let i = 0; i < n; i++) {
    const p = off + i * 18;
    const nm = asciiText(buf, p, NB_NAME_MAX).trim();
    if (!nm) continue;
    const suffix = buf[p + 15];
    const isGroup = (buf[p + 16] & 0x80) !== 0;   // NAME_FLAGS 첫 비트 = G
    if (suffix === 0x00 && !isGroup) { if (!name) name = nm; }
    else if (suffix === 0x00 && isGroup) { if (!group) group = nm; }
    else if (suffix === 0x20 && !isGroup) { if (!server) server = nm; }
  }
  if (!name) name = server;
  if (!name) return null;
  let mac = '';
  const mp = off + n * 18;
  if (mp + 6 <= end) {
    const m = buf.subarray(mp, mp + 6);
    if (m.some((x) => x !== 0)) mac = [...m].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
  }
  return { name, group, mac };
}

// ---- mDNS 역방향 PTR ------------------------------------------------------------
/** '10.0.0.5' → '5.0.0.10.in-addr.arpa'(정규형 IPv4 만 — 아니면 ''). */
export function reverseName(ip) {
  const n = ipToNum(ip);
  if (n == null || numToIp(n) !== String(ip).trim()) return '';
  return `${String(ip).trim().split('.').reverse().join('.')}.in-addr.arpa`;
}
/** PTR 질의 패킷(QTYPE 12 · QCLASS IN). */
export function ptrQuery(txid, ip) {
  const name = reverseName(ip);
  if (!name) return null;
  const parts = name.split('.');
  const qlen = parts.reduce((a, p) => a + 1 + p.length, 1);
  const b = Buffer.alloc(12 + qlen + 4);
  b.writeUInt16BE(txid & 0xffff, 0);
  b.writeUInt16BE(1, 4);
  let o = 12;
  for (const p of parts) { b[o++] = p.length; o += b.write(p, o, 'ascii'); }
  b[o++] = 0;
  b.writeUInt16BE(12, o); b.writeUInt16BE(1, o + 2);
  return b;
}

/** DNS 이름 읽기(압축 포인터 · 점프 16회 · 전체 255바이트 상한). 형식이 틀리면 null. */
export function readDnsName(buf, off) {
  const labels = [];
  let p = off; let jumps = 0; let total = 0;
  for (;;) {
    if (p >= buf.length) return null;
    const len = buf[p];
    if (len === 0) break;
    if ((len & 0xc0) === 0xc0) {
      if (p + 1 >= buf.length || ++jumps > 16) return null;
      p = ((len & 0x3f) << 8) | buf[p + 1];
      continue;
    }
    if (len & 0xc0) return null;
    if (p + 1 + len > buf.length) return null;
    total += len + 1;
    if (total > 255) return null;
    labels.push(asciiText(buf, p + 1, len));
    p += 1 + len;
  }
  return labels.join('.');
}

/**
 * PTR 응답 → 이름 | null. 거래 ID · 응답 표지 · 오류 코드를 보고, 답 중 **물어본 역이름**의 PTR 만 읽는다(끝의 '.' 은 뗀다).
 */
export function parsePtrAnswer(buf, txid, ip) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > MAX_MSG) return null;
  if (buf.readUInt16BE(0) !== (txid & 0xffff)) return null;
  const flags = buf.readUInt16BE(2);
  if (!(flags & 0x8000) || (flags & 0x000f) !== 0) return null;
  const want = reverseName(ip).toLowerCase();
  if (!want) return null;
  let off = 12;
  const qd = Math.min(buf.readUInt16BE(4), 8);
  const an = Math.min(buf.readUInt16BE(6), 32);
  for (let i = 0; i < qd; i++) {
    off = skipName(buf, off);
    if (off < 0 || off + 4 > buf.length) return null;
    off += 4;
  }
  for (let i = 0; i < an; i++) {
    const owner = readDnsName(buf, off);
    off = skipName(buf, off);
    if (off < 0 || off + 10 > buf.length) return null;
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    const rd = off + 10;
    if (rd + rdlen > buf.length) return null;
    if (type === 12 && owner != null && owner.toLowerCase() === want) {
      const v = readDnsName(buf, rd);
      const name = v ? v.replace(/\.$/, '').slice(0, DNS_NAME_MAX) : '';
      if (name) return name;
    }
    off = rd + rdlen;
  }
  return null;
}

// ---- 같은 서브넷 판정(mDNS 대상) -------------------------------------------------
/** 이 장비의 IPv4 인터페이스(내부 · /0 제외) → [{ address, net, mask }]. */
export function localSubnets(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of Array.isArray(list) ? list : []) {
      if (!a || a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      const ip = ipToNum(a.address); const mask = ipToNum(a.netmask);
      if (ip == null || mask == null || mask === 0) continue;
      out.push({ address: a.address, net: (ip & mask) >>> 0, mask });
    }
  }
  return out;
}
/** ip 가 subnets 중 하나와 같은 서브넷인가. */
export function onLink(ip, subnets) {
  const n = ipToNum(ip);
  if (n == null) return false;
  for (const s of subnets || []) if (((n & s.mask) >>> 0) === s.net) return true;
  return false;
}

// ---- UDP 묶음 질의 --------------------------------------------------------------
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * 대상마다 질의 1개를 보내고 timeoutMs 동안 응답을 모은다. 물어본 IP · 그 포트에서 온 응답만 parse 에 넘긴다.
 * @param {string[]} ips 정규형 IPv4
 * @param {{ port:number, build:(txid:number, ip:string)=>Buffer|null, parse:(msg:Buffer, txid:number, ip:string)=>any, timeoutMs:number,
 *           createSocket?:Function }} o
 * @returns {Promise<Map<string, any>>} ip → parse 결과(응답 없는 IP 는 없다)
 */
export async function udpProbe(ips, { port, build, parse, timeoutMs = 700, createSocket = dgram.createSocket } = {}) {
  const out = new Map();
  const targets = [...new Set((ips || []).filter((ip) => { const n = ipToNum(ip); return n != null && numToIp(n) === ip; }))];
  if (!targets.length) return out;
  let sock;
  try { sock = createSocket('udp4'); } catch { return out; }
  const pending = new Map(); // ip → txid
  let txid = Math.floor(Math.random() * 0xffff);
  let done = false;
  let wake = null;
  sock.on('message', (msg, rinfo) => {
    if (done || !rinfo || rinfo.port !== port || msg.length > MAX_MSG) return;
    const id = pending.get(rinfo.address);
    if (id == null) return;
    let r = null;
    try { r = parse(msg, id, rinfo.address); } catch { r = null; }
    if (r == null) return;
    out.set(rinfo.address, r);
    pending.delete(rinfo.address);
    if (!pending.size && wake) wake();
  });
  sock.on('error', () => { if (wake) wake(); });
  try {
    await new Promise((res, rej) => { sock.once('error', rej); sock.bind(0, () => { sock.removeListener('error', rej); res(); }); });
    for (let i = 0; i < targets.length && !done; i++) {
      const ip = targets[i];
      txid = (txid + 1) & 0xffff;
      const pkt = build(txid, ip);
      if (!pkt) continue;
      pending.set(ip, txid);
      sock.send(pkt, port, ip, () => { /* 보내기 실패(경로 없음 등)는 응답 없음과 같다 */ });
      if ((i + 1) % SEND_BATCH === 0) await sleep(SEND_GAP_MS);
    }
    if (pending.size) {
      await new Promise((res) => {
        wake = res;
        const t = setTimeout(res, Math.max(50, Number(timeoutMs) || 700));
        t.unref?.();
      });
    }
  } catch { /* bind 실패 — 이 방식은 이번 스캔에서 답 없음 */ }
  done = true;
  try { sock.close(); } catch { /* */ }
  return out;
}

/** NetBIOS 노드 상태를 묻는다 → Map(ip → { name, group, mac }). */
export function probeNetbios(ips, { timeoutMs = 700, port = NETBIOS_PORT, createSocket } = {}) {
  return udpProbe(ips, { port, timeoutMs, createSocket, build: (id) => nbstatRequest(id), parse: (msg, id) => parseNbstat(msg, id) });
}
/** mDNS 역방향 PTR 을 묻는다 → Map(ip → 이름). 호출부가 같은 서브넷 IP 만 넘긴다. */
export function probeMdns(ips, { timeoutMs = 700, port = MDNS_PORT, createSocket } = {}) {
  return udpProbe(ips, { port, timeoutMs, createSocket, build: (id, ip) => ptrQuery(id, ip), parse: (msg, id, ip) => parsePtrAnswer(msg, id, ip) });
}
