/**
 * iDRAC 대역 스캔의 **인증 실패 정지**(v2.591 — 감사 F3).
 *
 * 왜 필요한가: 스캔은 대역의 **모든 IP** 에 스캔 계정으로 인증한다(IP 하나에 Basic 2 + 세션 1 = 3회, Digest 를
 * 광고하면 4회 — 실측). 비밀번호를 회전하면 전력 폴러는 서버당 1회로 멈추지만(v2.590), 스캔은 **주기마다** 대역의
 * 모든 iDRAC 에 3~4회를 다시 시도했다 — 엣지 기본(1시간)이면 시간당 IP 당 3~4회다. iDRAC IP Blocking 이 켜진 현장은
 * **한 번의 탐침이 포탈 IP 를 차단**해 전력·온도 수집까지 막힌다. 그래서:
 *  ① 주기 스캔은 **직전 스캔에서 인증 실패였던 (대역, IP, 계정)** 을 건너뛴다(`scan|<rangeId>|<ip>`).
 *  ② 등록부에 같은 호스트가 있고 **주 전력 폴러가 같은 계정으로 이미 멈췄으면** 건너뛴다(읽기 전용 조회).
 *  ③ 건너뛴 개수·IP 를 결과·로그·화면에 싣는다(조용한 제외 금지 — scan.js 가 `authSkipped*` 로 돌려준다).
 *  ④ 수동 '지금 스캔' 은 **전부 시도**한다(authGuard 규칙 3). 실패·성공은 수동에서도 기록한다(다음 주기가 안다).
 *  ⑤ 대역 계정을 바꾸면 credHash 가 달라져 **자동 재개**한다(peek 가 null — 성공하면 기록을 지운다).
 *
 * ⚠ 정지 파일은 주 폴러(`idrac-auth-stops.json`)와 **나눈다**(`idrac-scan-auth-stops.json`). 판단 근거:
 *   ⓐ 대역은 IP 가 수천 개라(대역당 최대 2,048) 기록이 많고, 주 폴러는 매 60초 그 파일을 읽고 등록 서버마다 조회한다 —
 *      섞으면 그 파일이 스캔 기록으로 불어난다 ⓑ id 체계가 다르다(등록부 id vs 대역·IP) ⓒ 한 실행에 수천 건이
 *      바뀌므로 **지연 기록 + 실행 끝 1회 flush** 를 쓴다(건마다 쓰면 파일 전체를 수천 번 다시 쓴다).
 * ⚠ 비-Dell Redfish(HPE iLO 등 — scan.js 의 '미지원 서버')는 기록하지 않는다. 그 목록은 매 스캔 교체되므로
 *   건너뛰면 화면의 미지원 목록이 조용히 줄어든다(정직 기록: 그 장비에는 스캔마다 Dell 계정 시도가 계속된다).
 */
import { createAuthGuard } from '../util/authGuard.js';
import { idracAuthStopFor } from './poller.js';
import { loadRegistry } from './registry.js';

export const scanAuthGuard = createAuthGuard({ file: 'idrac-scan-auth-stops.json' });

/** 정지 id — 대역마다 따로(같은 IP 를 다른 계정의 두 대역이 가지면 서로의 기록을 지우지 않게). */
export const scanStopId = (rangeId, ip) => `scan|${String(rangeId || '-')}|${ip}`;

/** 등록부 host(`https://10.0.0.1:443/`)를 IP 비교용 주소로 — 스킴·포트·끝 슬래시·IPv6 대괄호를 뗀다. */
export function registryHostKey(v) {
  let s = String(v || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '');
  if (s.startsWith('[')) { const m = /^\[([^\]]+)\]/.exec(s); return m ? m[1] : s; }
  const colon = s.lastIndexOf(':');
  if (colon > 0 && s.indexOf(':') === colon && /^\d+$/.test(s.slice(colon + 1))) s = s.slice(0, colon);
  return s;
}

/**
 * 한 번의 스캔에 쓰는 정책.
 * @param {{rangeId?:string, username:string, password:string, periodic?:boolean}} p
 * @returns {{skip(ip:string): (null|'scan'|'registered'), noteAuthFailed(ip:string, reason?:string): void,
 *            noteOk(ip:string): void, flush(): void, periodic: boolean}}
 */
export function makeScanAuthPolicy({ rangeId = '', username = '', password = '', periodic = false, ilo = null } = {}) {
  // v2.610: iLO 계정이 있으면 스캔 정지 기록의 자격증명 지문에 두 계정을 **함께** 넣는다 — 어느 쪽을 고쳐도
  //   자동 재개된다. 등록 서버 정지 대조는 그 서버의 벤더 계정으로 한다(HPE 는 iLO 계정).
  const iloU = String(ilo?.username || '').trim();
  const iloP = typeof ilo?.password === 'string' ? ilo.password : '';
  const hasIlo = Boolean(iloU && iloP);
  const cred = hasIlo ? { username: `${username}|ilo:${iloU}`, password: `${password}\u0001${iloP}` } : { username, password };
  const credForEntry = (s) => (hasIlo && String(s?.vendor || '').toLowerCase() === 'hpe') ? { username: iloU, password: iloP } : { username, password };
  let byHost = null;
  if (periodic) {
    byHost = new Map();
    try {
      for (const s of loadRegistry() || []) {
        const h = registryHostKey(s?.host);
        if (h && s?.id && !byHost.has(h)) byHost.set(h, s);
      }
    } catch { /* 등록부를 못 읽으면 ② 판정만 빠진다 — ① 은 그대로 */ }
  }
  return {
    periodic: !!periodic,
    skip(ip) {
      if (!periodic) return null;
      if (scanAuthGuard.peekAuthStop({ id: scanStopId(rangeId, ip), ...cred })) return 'scan';
      const s = byHost?.get(String(ip).toLowerCase());
      // 같은 계정으로 주 폴러가 이미 멈췄다 — 넘긴 자격증명이 기록과 다르면 peek 가 null(스캔 계정이 고쳐졌을 수 있다).
      if (s && idracAuthStopFor({ id: s.id, ...credForEntry(s) })) return 'registered';
      return null;
    },
    noteAuthFailed(ip, reason) {
      const id = scanStopId(rangeId, ip);
      scanAuthGuard.markAuthStopped(id, { id, ...cred }, reason || '스캔 인증 실패', { defer: true });
    },
    noteOk(ip) { scanAuthGuard.clearAuthStop(scanStopId(rangeId, ip), { defer: true }); },
    flush() { scanAuthGuard.flush(); },
  };
}
