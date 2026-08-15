/**
 * storage/collectors/isilonSsh.js — Isilon SSH 수집 모드(v2.304, 사용자 요구).
 *
 * 장비에 SSH 로 접속해 `isi status` 출력을 파싱한다 — 운영자가 실제로 보는 화면과 동일한
 * 소스라서 REST 통계 파생(HDD=전체−SSD 가정)보다 정확하다는 사용자 판단을 반영. 기존
 * withSsh(proxy/sshExec.js — GPU 게스트 수집과 동일 인프라)를 재사용한다(새 프로토콜 없음).
 *
 * 파서(parseIsiStatus)는 **순수 함수**로 분리해 사용자가 준 실물 샘플 2종(무디스크 노드·
 * L3 캐시 표기·SSD 0(n/a)·노드 수 상이)을 테스트로 고정한다 — isi status 는 사람용 표라
 * 버전에 따라 미세하게 달라질 수 있고, 그때 파서 테스트가 어디가 깨졌는지 즉시 알려준다.
 * 노드 수는 가변(요구사항) — 노드 행 패턴(숫자|IP|…)을 만나는 만큼 수집한다.
 *
 * 부가 명령(각각 best-effort — 실패해도 status 파싱은 유지):
 *  - `isi version`                       → OneFS 버전 문자열
 *  - `isi auth users list --format json` → 관리 계정 목록(API 모드와 동등 정보 유지)
 */

import { withSsh } from '../../proxy/sshExec.js';
import { emptySnapshot } from '../types.js';

/* ── 단위 파서 ──────────────────────────────────────────────────────────── */
// 저장 용량(2.5P·55.1T·373G·0): isi 표기는 2진 기반(TiB 등) — 1024 거듭제곱.
const SIZE_UNIT = { k: 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
export function parseSize(s) {
  const m = /^([\d.]+)\s*([kKMGTP])?$/.exec(String(s || '').trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] ? SIZE_UNIT[m[2]] : 1));
}
// 네트워크 처리량(260k·2.2M bps): 10진 접두(관례) — 1000 거듭제곱.
const BPS_UNIT = { k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
export function parseBps(s) {
  const m = /^([\d.]+)\s*([kKMG])?$/.exec(String(s || '').trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? BPS_UNIT[m[2]] : 1));
}

/** "2.0T/ 107T( 2%)" → {usedBytes,totalBytes,pct} · "(No Storage HDDs)" → null · "L3: 373G" → {l3Bytes} */
function parsePoolCell(s) {
  const t = String(s || '').trim();
  if (!t || /no storage/i.test(t)) return null;
  const l3 = /L3:\s*([\d.]+[kKMGTP]?)/.exec(t);
  if (l3) return { l3Bytes: parseSize(l3[1]) };
  const m = /([\d.]+[kKMGTP]?)\s*\/\s*([\d.]+[kKMGTP]?)\s*\(\s*([\d.]+)%\s*\)/.exec(t);
  if (!m) return null;
  return { usedBytes: parseSize(m[1]), totalBytes: parseSize(m[2]), pct: Number(m[3]) };
}

/**
 * `isi status` 전체 출력 파싱(순수 — storageMon.test.js 실물 샘플 고정).
 * 반환: { name, health, dataReduction, storageEfficiency,
 *         hdd:{sizeBytes,usedBytes,usedPct}|null, ssd:{...}|null, vhsBytes, l3TotalBytes,
 *         nodes:[{id,ip,health,ext,inBps,outBps,totalBps,hdd,ssd,l3Bytes}] }
 */
export function parseIsiStatus(text) {
  const lines = String(text || '').split('\n');
  const out = { name: '', health: '', dataReduction: '', storageEfficiency: '', hdd: null, ssd: null, vhsBytes: 0, l3TotalBytes: 0, nodes: [],
    criticalEvents: [], jobs: { running: [], paused: [], failed: [], recent: [] } };
  const grab = (re) => { for (const l of lines) { const m = re.exec(l); if (m) return m; } return null; };
  out.name = grab(/Cluster Name:\s*(\S+)/)?.[1] || '';
  out.health = grab(/Cluster Health:\s*\[\s*([A-Z]+)/i)?.[1]?.toUpperCase() || '';
  out.dataReduction = grab(/Data Reduction:\s*([\d.]+\s*:\s*\d+)/)?.[1]?.replace(/\s/g, '') || '';
  out.storageEfficiency = grab(/Storage Efficiency:\s*([\d.]+\s*:\s*\d+)/)?.[1]?.replace(/\s/g, '') || '';

  // 클러스터 저장소 블록 — 각 행이 [라벨, HDD 열, SSD 열]. SSD 열은 '0 (0 Raw)'/'0 (n/a)' 가능.
  // 열 분리는 '괄호 묶음 포함 토큰' 2개로 잡는다: 값 뒤에 (…)가 붙거나 안 붙거나.
  const twoCols = (label) => {
    const m = grab(new RegExp(`^${label}:\\s+([\\d.]+[kKMGTP]?)(?:\\s*\\([^)]*\\))?\\s+([\\d.]+[kKMGTP]?)(?:\\s*\\([^)]*\\))?`, 'm'));
    return m ? [m[1], m[2]] : null;
  };
  const pct = (label) => {
    // Used/Avail 행의 퍼센트: "55.1T (2%)   0 (n/a)" — HDD 쪽 %, SSD 쪽 %(없으면 null)
    const m = grab(new RegExp(`^${label}:\\s+[\\d.]+[kKMGTP]?\\s*\\(([\\d.]+)%\\)(?:\\s+[\\d.]+[kKMGTP]?\\s*\\((?:([\\d.]+)%|n/a)\\))?`, 'm'));
    return m ? [m[1] != null ? Number(m[1]) : null, m[2] != null ? Number(m[2]) : null] : [null, null];
  };
  const size = twoCols('Size');
  const used = twoCols('Used');
  const [hddPct, ssdPct] = pct('Used');
  if (size) {
    const mk = (sz, us, p) => { const t = parseSize(sz); return t > 0 ? { sizeBytes: t, usedBytes: parseSize(us || '0'), usedPct: p } : null; };
    out.hdd = mk(size[0], used?.[0], hddPct);
    out.ssd = mk(size[1], used?.[1], ssdPct);
  }
  out.vhsBytes = parseSize(grab(/^VHS Size:\s+([\d.]+[kKMGTP]?)/m)?.[1] || '0');

  // 노드 표 — 행 형태: " 1|10.94.42.184 | OK | C | 0| 260k| 260k| 2.0T/ 107T( 2%)| L3: 373G"
  // 노드 수 가변(요구사항): 패턴을 만나는 모든 행을 수집. Cluster Totals 행은 L3 합계만 취한다.
  for (const l of lines) {
    if (/^\s*Cluster Totals:/.test(l)) {
      const m = /L3:\s*([\d.]+[kKMGTP]?)/.exec(l);
      if (m) out.l3TotalBytes = parseSize(m[1]);
      continue;
    }
    if (!/^\s*\d+\|/.test(l)) continue;
    const c = l.split('|').map((x) => x.trim());
    if (c.length < 8) continue; // 표 형식이 아니면 버림(장식선 등)
    const hddCell = parsePoolCell(c[7]);
    const ssdCell = parsePoolCell(c[8] || '');
    out.nodes.push({
      id: Number(c[0]) || 0,
      ip: c[1] || '',
      health: c[2] || '',           // 'OK' 또는 D/A/S/R 플래그(범례: Down/Attention/Smartfailed/Read-Only)
      ext: c[3] || '',              // C=Connected / N=Not Connected
      inBps: parseBps(c[4]), outBps: parseBps(c[5]), totalBps: parseBps(c[6]),
      hdd: hddCell && hddCell.totalBytes != null ? hddCell : null,   // '(No Storage HDDs)' → null
      ssd: ssdCell && ssdCell.totalBytes != null ? ssdCell : null,
      l3Bytes: (hddCell?.l3Bytes ?? ssdCell?.l3Bytes) || 0,          // SSD 가 L3 캐시로만 쓰이는 노드
    });
  }
  // ── isi status 꼬리 섹션(v2.307, 사용자 요구): Critical Events + Cluster Job Status ──
  // 섹션 헤더로 모드를 전환하며 행을 파싱한다. 각 표의 컬럼 수·형식은 실물 샘플 기준
  // (storageMon.test.js 픽스처 고정 — 버전별 차이는 테스트가 위치를 알려줌).
  let mode = '';
  for (const l of lines) {
    const t = l.trim();
    if (/^Critical Events:/.test(t)) { mode = 'events'; continue; }
    if (/^Running jobs:/.test(t)) { mode = 'running'; continue; }
    if (/^Paused and waiting jobs:/.test(t)) { mode = 'paused'; continue; }
    if (/^Failed jobs:/.test(t)) { mode = 'failed'; continue; }
    if (/^No failed jobs\./.test(t)) { mode = ''; continue; }
    if (/^Recent job results:/.test(t)) { mode = 'recent'; continue; }
    if (/^Cluster Job Status:/.test(t)) { mode = ''; continue; }
    if (!t || /^[-+\s|]+$/.test(t) || /^(Time|Job)\s/.test(t)) continue; // 빈 줄·구분선·헤더행
    if (mode === 'events') {
      // "08/15 22:10:03   3   <이벤트 문구...>" — 시간(2토큰) + LNN + 나머지 전부 이벤트.
      const m = /^(\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\d+)\s+(.+)$/.exec(t);
      if (m && out.criticalEvents.length < 50) out.criticalEvents.push({ time: m[1], lnn: Number(m[2]), event: m[3].trim() });
      continue;
    }
    if (mode === 'running' || mode === 'paused') {
      // "SmartPools[118838]  Low  6  LOW  1/2  12:18:39 [State]" — 잡명은 공백 없음(Name[id]).
      // ⚠ Run Time 은 "12:18:39" 또는 "17d 8:46"(일수 포함 2토큰) — 후자를 못 잡으면 대기 잡이
      //   통째로 누락된다(실물 샘플의 MediaScan 17d 8:46 로 테스트 고정).
      const m = /^(\S+\[\d+\])\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+((?:\d+d\s+)?[\d:]+)(?:\s+(\S+))?$/.exec(t);
      if (m) out.jobs[mode].push({ job: m[1], impact: m[2], pri: Number(m[3]), policy: m[4], phase: m[5], runTime: m[6], ...(m[7] ? { state: m[7] } : {}) });
      continue;
    }
    if (mode === 'failed') {
      const m = /^(\S+\[\d+\])\s+(.+)$/.exec(t);
      if (m) out.jobs.failed.push({ job: m[1], detail: m[2].trim() });
      continue;
    }
    if (mode === 'recent') {
      // "08/15 22:10:03   SnapshotDelete[118873]   Succeeded"
      const m = /^(\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\S+\[\d+\])\s+(.+)$/.exec(t);
      if (m && out.jobs.recent.length < 20) out.jobs.recent.push({ time: m[1], job: m[2], event: m[3].trim() });
      continue;
    }
  }
  return out;
}

/** 파싱 결과 → NormalizedSnapshot(공통 스키마 — API 모드와 동일 화면에 그대로 얹힌다). */
export function normalizeIsiStatus(device, parsed, { version = '', users = null } = {}) {
  const snap = emptySnapshot(device);
  if (parsed.name) { snap.name = parsed.name; snap.sections.config = 'ok'; }
  snap.version = version;
  const mk = (p) => (p ? { totalBytes: p.sizeBytes, usedBytes: p.usedBytes, pct: p.usedPct ?? (p.sizeBytes ? Math.round((p.usedBytes / p.sizeBytes) * 1000) / 10 : null) } : null);
  if (parsed.hdd || parsed.ssd) {
    snap.media = { hdd: mk(parsed.hdd), ssd: mk(parsed.ssd) };
    const t = (parsed.hdd?.sizeBytes || 0) + (parsed.ssd?.sizeBytes || 0);
    const u = (parsed.hdd?.usedBytes || 0) + (parsed.ssd?.usedBytes || 0);
    snap.capacity = { totalBytes: t, usedBytes: u, pct: t ? Math.round((u / t) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
  }
  if (parsed.nodes.length) {
    snap.nodes = {
      count: parsed.nodes.length,
      unhealthy: parsed.nodes.filter((n) => n.health && n.health !== 'OK').length,
      list: parsed.nodes.slice(0, 64).map((n) => ({
        id: n.id, ip: n.ip, health: n.health === 'OK' ? 'ok' : (n.health || 'unknown').toLowerCase(),
        ext: n.ext, inBps: n.inBps, outBps: n.outBps,
        hdd: n.hdd ? { totalBytes: n.hdd.totalBytes, usedBytes: n.hdd.usedBytes, pct: n.hdd.pct } : null,
        ssd: n.ssd ? { totalBytes: n.ssd.totalBytes, usedBytes: n.ssd.usedBytes, pct: n.ssd.pct } : null,
        l3Bytes: n.l3Bytes || 0,
      })),
    };
    snap.sections.nodes = 'ok';
  }
  if (users) {
    snap.accounts = users.slice(0, 200).map((u) => ({ name: u.name || u.id || '', enabled: u.enabled !== false }));
    snap.sections.accounts = 'ok';
  }
  // Critical Events(v2.307) — SSH 모드의 경보 소스(그동안 alerts 섹션이 '건너뜀'이던 갭 해소).
  snap.alerts.unresolved = (parsed.criticalEvents || []).length;
  snap.sections.alerts = 'ok';
  // isi status 에 없는 부가 정보(사용자 화면의 상단 블록) — extra 로 그대로 노출.
  snap.extra = {
    collectMethod: 'ssh', clusterHealth: parsed.health,
    dataReduction: parsed.dataReduction, storageEfficiency: parsed.storageEfficiency,
    vhsBytes: parsed.vhsBytes, l3TotalBytes: parsed.l3TotalBytes,
    criticalEvents: parsed.criticalEvents || [],
    jobs: parsed.jobs || { running: [], paused: [], failed: [], recent: [] },
  };
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok) snap.error = 'isi status 파싱 실패 — 출력 형식이 예상과 다릅니다(버전 확인 필요)';
  return snap;
}

export async function collectViaSsh(device) {
  try {
    const r = await withSsh(
      { host: device.host, port: Number(device.sshPort) || 22, username: device.username, password: device.password || '' },
      async (sh) => {
        const status = await sh.exec('isi status'); // 핵심 — 실패하면 아래 catch 로(수집 실패)
        // 부가 명령은 각각 best-effort: 버전·계정이 없어도 status 파싱 결과는 살린다.
        const ver = await sh.exec('isi version').catch(() => ({ stdout: '' }));
        const usersRaw = await sh.exec('isi auth users list --format json').catch(() => ({ stdout: '' }));
        return { status: status.stdout || '', ver: ver.stdout || '', usersRaw: usersRaw.stdout || '' };
      },
    );
    const parsed = parseIsiStatus(r.status);
    const version = /OneFS\s*v?([\d.]+)/i.exec(r.ver)?.[1] || '';
    let users = null;
    try { const j = JSON.parse(r.usersRaw); users = Array.isArray(j) ? j : null; } catch { /* 계정 섹션만 생략 */ }
    const snap = normalizeIsiStatus(device, parsed, { version, users });
    if (!users) snap.sections.accounts = r.usersRaw ? '오류: users JSON 파싱 실패' : '오류: isi auth users list 실행 실패';
    return snap;
  } catch (e) {
    const snap = emptySnapshot(device);
    snap.extra = { collectMethod: 'ssh' };
    snap.error = `SSH 수집 실패: ${e.message}`;
    return snap;
  }
}
