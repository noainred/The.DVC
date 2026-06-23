/**
 * 네트워크 트래픽 분석 — 통신하는 두 서버(A↔B) 사이의 패킷을 A에서 tcpdump로 캡처해 분석한다.
 * 포탈이 SSH로 A에 접속해 `tcpdump host <B>`를 제한 시간/패킷으로 실행하고, 텍스트 출력을 파싱해
 * 핸드셰이크·재전송·RST 등으로 장애/이슈를 자동 진단한다(pcap/tshark 불필요).
 *
 * ⚠️ tcpdump는 root 권한 필요. SSH 사용자가 root가 아니면 무비밀번호 sudo(`sudo -n`)를 시도한다.
 */

import { withSsh } from '../proxy/sshExec.js';

const IPRE = /^[0-9a-fA-F:.]+$/;        // IPv4/IPv6
const IFRE = /^[a-zA-Z0-9._-]+$/;       // 인터페이스명

/** tcpdump 한 줄(`-n -tt`) 파싱 → { ts, src, sport, dst, dport, flags, len } 또는 null. */
export function parseTcpdumpLine(line) {
  // 1700000000.123 IP 10.0.0.1.443 > 10.0.0.2.51234: Flags [S.], seq .., length 0
  const m = /^(\d+\.\d+)\s+IP6?\s+([\d.a-fA-F:]+)\.(\d+)\s+>\s+([\d.a-fA-F:]+)\.(\d+):\s+Flags \[([^\]]*)\]/.exec(line);
  if (!m) return null;
  const len = /length (\d+)/.exec(line);
  return { ts: parseFloat(m[1]), src: m[2], sport: m[3], dst: m[4], dport: m[5], flags: m[6], len: len ? Number(len[1]) : 0 };
}

/** 파싱된 패킷 배열 + peer(B) IP로 요약·진단. */
export function analyzeCapture(pkts, peer) {
  const stat = {
    packets: pkts.length, syn: 0, synAck: 0, rst: 0, fin: 0, retrans: 0,
    toPeer: { packets: 0, bytes: 0 }, fromPeer: { packets: 0, bytes: 0 },
    ports: {}, firstTs: null, lastTs: null, rttMs: null,
  };
  const seenSyn = new Map(); // 5-tuple+seq 근사 재전송 감지
  let firstSynTs = null, firstSynAckTs = null;
  for (const p of pkts) {
    if (stat.firstTs == null) stat.firstTs = p.ts;
    stat.lastTs = p.ts;
    const f = p.flags;
    const isSyn = f.includes('S') && !f.includes('.');
    const isSynAck = f.includes('S') && f.includes('.');
    if (isSyn) stat.syn++;
    if (isSynAck) stat.synAck++;
    if (f.includes('R')) stat.rst++;
    if (f.includes('F')) stat.fin++;
    const dir = p.src === peer ? 'fromPeer' : 'toPeer';
    stat[dir].packets++; stat[dir].bytes += p.len;
    const port = p.src === peer ? p.sport : p.dport;
    stat.ports[port] = (stat.ports[port] || 0) + 1;
    // RTT: 첫 SYN(out) → 첫 SYN-ACK(in)
    if (isSyn && p.src !== peer && firstSynTs == null) firstSynTs = p.ts;
    if (isSynAck && p.src === peer && firstSynAckTs == null) firstSynAckTs = p.ts;
    // 재전송 근사: 같은 (src,dst,sport,dport,flags,len) 반복
    const key = `${p.src}:${p.sport}>${p.dst}:${p.dport}|${f}|${p.len}`;
    if (f.includes('S') || p.len > 0) { const n = (seenSyn.get(key) || 0) + 1; seenSyn.set(key, n); if (n > 1) stat.retrans++; }
  }
  if (firstSynTs != null && firstSynAckTs != null && firstSynAckTs >= firstSynTs) stat.rttMs = Math.round((firstSynAckTs - firstSynTs) * 1000);
  const durSec = stat.firstTs != null ? Math.max(0.001, stat.lastTs - stat.firstTs) : 0;
  const topPorts = Object.entries(stat.ports).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => ({ port: p, packets: n }));

  // 이슈 진단(휴리스틱)
  const issues = [];
  const retransPct = stat.packets ? Math.round((stat.retrans / stat.packets) * 100) : 0;
  if (stat.packets === 0) issues.push({ sev: 'error', title: '트래픽 없음', detail: `캡처 시간 동안 ${peer} 와의 패킷이 없습니다. 통신을 안 하거나, 인터페이스/필터가 맞지 않거나, 방화벽 차단일 수 있습니다.` });
  if (stat.syn > 0 && stat.synAck === 0) issues.push({ sev: 'error', title: '핸드셰이크 미완료(SYN-ACK 없음)', detail: `SYN ${stat.syn}건을 보냈으나 SYN-ACK 응답이 없습니다 — 방화벽 차단/포트 미개방/대상 다운 의심.` });
  if (stat.rst >= 3) issues.push({ sev: 'warning', title: `연결 리셋(RST) ${stat.rst}건`, detail: '대상이 연결을 거부(포트 닫힘/서비스 비정상)하거나 중간 장비가 끊는 중일 수 있습니다.' });
  if (retransPct >= 5) issues.push({ sev: 'warning', title: `재전송 ${retransPct}% (${stat.retrans}건)`, detail: '패킷 손실/혼잡/높은 지연 의심 — 경로 품질 점검 필요.' });
  if (stat.packets > 0 && (stat.toPeer.packets === 0 || stat.fromPeer.packets === 0)) issues.push({ sev: 'warning', title: '단방향 트래픽', detail: '한쪽 방향 패킷만 보입니다 — 비대칭 라우팅/방화벽/응답 누락 의심.' });
  if (stat.rttMs != null && stat.rttMs > 400) issues.push({ sev: 'warning', title: `높은 RTT ${stat.rttMs}ms`, detail: '핸드셰이크 지연이 큽니다(원거리/혼잡). 고RTT 사이트면 정상일 수 있습니다.' });
  if (!issues.length && stat.packets > 0) issues.push({ sev: 'ok', title: '특이사항 없음', detail: `정상 통신으로 보입니다(SYN ${stat.syn}/SYN-ACK ${stat.synAck}, RST ${stat.rst}, 재전송 ${retransPct}%).` });

  return { stat: { ...stat, retransPct, durSec: Number(durSec.toFixed(2)), topPorts }, issues };
}

/**
 * 캡처 실행. opts: { hostA(creds: host,port,username,password,privateKey), peer, iface, seconds, maxPackets, useSudo }.
 * 반환 { ok, command, lines, parsed, analysis, raw, error }.
 */
export async function runTrafficCapture({ hostA, peer, iface = 'any', seconds = 10, maxPackets = 2000, useSudo = true } = {}) {
  if (!peer || !IPRE.test(peer)) throw new Error('대상 서버(B) IP 형식이 올바르지 않습니다.');
  if (!IFRE.test(iface)) throw new Error('인터페이스명이 올바르지 않습니다.');
  const sec = Math.min(120, Math.max(1, Number(seconds) || 10));
  const max = Math.min(20000, Math.max(10, Number(maxPackets) || 2000));
  const isRoot = (hostA.username || '').trim() === 'root';
  const sudo = isRoot ? '' : (useSudo ? 'sudo -n ' : '');
  // -n(no DNS) -tt(epoch) -l(line buffered) -q 미사용. host 필터. timeout으로 상한.
  const cmd = `${sudo}timeout ${sec} tcpdump -i ${iface} -n -tt -c ${max} host ${peer} 2>&1 || true`;
  return withSsh(hostA, async ({ exec }) => {
    const r = await exec(cmd);
    const raw = (r.stdout || '') + (r.stderr || '');
    const lines = raw.split('\n');
    // tcpdump 권한/오류 메시지 감지
    const errLine = lines.find((l) => /permission denied|Operation not permitted|sudo:|command not found|No such device|tcpdump: /i.test(l) && !/listening on/i.test(l));
    const pkts = lines.map(parseTcpdumpLine).filter(Boolean);
    const analysis = analyzeCapture(pkts, peer);
    return {
      ok: true, command: cmd, peer, iface, seconds: sec,
      captured: pkts.length, sample: lines.filter((l) => /Flags \[/.test(l)).slice(0, 40),
      analysis,
      warn: pkts.length === 0 && errLine ? errLine.trim().slice(0, 200) : null,
    };
  });
}
