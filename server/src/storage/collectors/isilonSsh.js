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
import { sshFailureSnapshot } from './cliSsh.js';
import { emptySnapshot } from '../types.js';

const fmtStep = (b) => {
  for (const [u, k] of [['PiB', 5], ['TiB', 4], ['GiB', 3], ['MiB', 2], ['KiB', 1]]) {
    const v = b / 1024 ** k; if (v >= 1) return `${Math.round(v * 10) / 10} ${u}`;
  }
  return `${b} B`;
};

/* ── 단위 파서 ──────────────────────────────────────────────────────────── */
// 저장 용량(2.5P·55.1T·373G·0): isi 표기는 2진 기반(TiB 등) — 1024 거듭제곱.
const SIZE_UNIT = { k: 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
export function parseSize(s) {
  const m = /^([\d.]+)\s*([kKMGTP])?$/.exec(String(s || '').trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] ? SIZE_UNIT[m[2]] : 1));
}
/** 사용량처럼 결측과 0 을 구분해야 하는 값 — 형식이 맞지 않으면 null(v2.595). */
export function parseSizeOrNull(s) {
  const m = /^([\d.]+)\s*([kKMGTP])?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] ? SIZE_UNIT[m[2]] : 1));
  return Number.isFinite(n) ? n : null;
}
/**
 * v2.604(감사 COL-2604-01): 표기 한 칸의 크기(바이트) — '5.0P' 는 소수 1자리 P 라 0.1 PiB(= 102.4 TiB) 단위로만 움직인다.
 * isi status 는 사람용 반올림 표기라 이것이 곧 그 값의 해상도다. 읽지 못하면 null.
 */
export function sizeStep(s) {
  const m = /^(\d+)(?:\.(\d+))?\s*([kKMGTP])?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const dec = m[2] ? m[2].length : 0;
  return Math.pow(10, -dec) * (m[3] ? SIZE_UNIT[m[3]] : 1);
}

/**
 * v2.604(감사 COL-2604-01): `isi statistics query current --keys ifs.bytes.* --format json` 출력 → 정확한 바이트.
 * REST 경로(isilon.js)가 쓰는 것과 **같은 키**다. ⚠ 정직 기록 — 이 CLI 의 JSON 출력을 실장비에서 본 적이 없다.
 *   그래서 모양을 셋 다 받는다: ① REST 와 같은 [{key,value}] / {stats:[…]} ② 행 객체([{node:'cluster','ifs.bytes.total':N}])
 *   ③ 그 밖은 못 읽음(null). 값은 **음이 아닌 정수 바이트**일 때만 쓴다 — 단위가 붙은 사람용 표기('5.0P')가 오면
 *   정밀도가 isi status 와 같아 이득이 없으므로 받지 않는다.
 * @returns {{total:number, used:number|null, ssdTotal:number|null, ssdUsed:number|null}|null}
 */
export function parseIsiStatsBytes(text) {
  let j;
  try { j = JSON.parse(String(text || '').trim()); } catch { return null; }
  const vals = {};
  const take = (k, v) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN);
    if (Number.isSafeInteger(n) && n >= 0 && !(k in vals)) vals[k] = n;
  };
  const list = Array.isArray(j) ? j : Array.isArray(j?.stats) ? j.stats : null;
  if (!list) return null;
  const rows = list.filter((x) => x && typeof x === 'object');
  if (rows.some((x) => typeof x.key === 'string')) {
    for (const x of rows) if (typeof x.key === 'string' && (x.devid == null || Number(x.devid) === 0)) take(x.key, x.value);
  } else {
    // 행 객체 — 클러스터 합계 행을 쓴다(노드별 행만 있으면 판단하지 않는다).
    const row = rows.find((x) => String(x.node ?? x.Node ?? '').toLowerCase() === 'cluster') || (rows.length === 1 ? rows[0] : null);
    if (!row) return null;
    for (const [k, v] of Object.entries(row)) if (/^ifs\./.test(k)) take(k, v);
  }
  const total = vals['ifs.bytes.total'];
  if (!(total > 0)) return null;
  return {
    total,
    used: vals['ifs.bytes.used'] ?? null,
    ssdTotal: vals['ifs.ssd.bytes.total'] ?? null,
    ssdUsed: vals['ifs.ssd.bytes.used'] ?? null,
  };
}
export const ISI_STATS_CMD = 'isi statistics query current --keys ifs.bytes.total,ifs.bytes.used,ifs.ssd.bytes.total,ifs.ssd.bytes.used --format json';

// 네트워크 처리량(260k·2.2M bps): 10진 접두(관례) — 1000 거듭제곱.
const BPS_UNIT = { k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
export function parseBps(s) {
  const m = /^([\d.]+)\s*([kKMG])?$/.exec(String(s || '').trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? BPS_UNIT[m[2]] : 1));
}

/** (export — v2.603 테스트용) "2.0T/ 107T( 2%)" → {usedBytes,totalBytes,pct} · "(No Storage HDDs)" → null · "L3: 373G" → {l3Bytes} */
export function parsePoolCell(s) {
  const t = String(s || '').trim();
  if (!t || /no storage/i.test(t)) return null;
  const l3 = /L3:\s*([\d.]+[kKMGTP]?)/.exec(t);
  if (l3) return { l3Bytes: parseSize(l3[1]) };
  // v2.603(감사 SEC2603-05): 숫자·점 구간의 시작에서만 시도한다(뒤보기) — 예전 정규식은 구간 안의 모든 위치에서
  //   끝까지 다시 훑어 긴 셀에서 O(n²) 였다. 가장 왼쪽 매치는 언제나 구간 시작이라 결과(캡처 포함)는 같다.
  const m = /(?<![\d.])([\d.]+[kKMGTP]?)\s*\/\s*([\d.]+[kKMGTP]?)\s*\(\s*([\d.]+)%\s*\)/.exec(t);
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
    criticalEvents: [], criticalEventCount: 0, sawEvents: false, jobs: { running: [], paused: [], failed: [], recent: [] } };
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
    // v2.595(감사 C2595-01): Used 칸을 못 읽으면 사용량은 null(예전 parseSize(us||'0') 은 0 — '비었다' 는 거짓).
    // v2.604: 표기 해상도(sizeStep/usedStep)도 싣는다 — 정규화가 '이 값은 반올림 표기' 임을 밝히는 근거.
    const mk = (sz, us, p) => { const t = parseSize(sz); return t > 0 ? { sizeBytes: t, usedBytes: parseSizeOrNull(us), usedPct: p, sizeStep: sizeStep(sz), usedStep: sizeStep(us) } : null; };
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
    if (/^Critical Events:/.test(t)) { mode = 'events'; out.sawEvents = true; continue; }
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
      // v2.590 F10: 개수는 **상한 없이** 센다 — 목록만 50개로 자른다. 예전엔 50에서 세기를 멈춰 '미해결 경보' 가 과소였다.
      if (m) { out.criticalEventCount += 1; if (out.criticalEvents.length < 50) out.criticalEvents.push({ time: m[1], lnn: Number(m[2]), event: m[3].trim() }); }
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
export function normalizeIsiStatus(device, parsed, { version = '', users = null, exact = null } = {}) {
  const snap = emptySnapshot(device);
  if (parsed.name) { snap.name = parsed.name; snap.sections.config = 'ok'; }
  snap.version = version;
  const mk = (p) => (p ? { totalBytes: p.sizeBytes, usedBytes: p.usedBytes ?? null, pct: p.usedPct ?? (p.sizeBytes && p.usedBytes != null ? Math.round((p.usedBytes / p.sizeBytes) * 1000) / 10 : null) } : null);
  if (parsed.hdd || parsed.ssd) {
    snap.media = { hdd: mk(parsed.hdd), ssd: mk(parsed.ssd) };
    const t = (parsed.hdd?.sizeBytes || 0) + (parsed.ssd?.sizeBytes || 0);
    // v2.595: 있는 풀 중 하나라도 사용량을 못 읽었으면 합계 사용량은 null(부분 합 금지).
    const present = [parsed.hdd, parsed.ssd].filter(Boolean);
    const u = present.some((p) => p.usedBytes == null) ? null : present.reduce((a, p) => a + p.usedBytes, 0);
    snap.capacity = { totalBytes: t, usedBytes: u, pct: t && u != null ? Math.round((u / t) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
  }
  /*
   * v2.604(감사 COL-2604-01): isi status 의 Size/Used 는 **사람용 반올림 표기**('5.0P')다. 그 값으로 바이트를 만들면
   *   증가량이 0.1 PiB(= 102.4 TiB) 계단으로만 움직이고, 사용률도 장비가 찍은 %와 어긋난다(예: 1.2P/2.2P = 54.5% vs 장비 56%).
   *   ① 같은 세션에서 `isi statistics` 로 정확한 바이트를 읽었으면 그것을 쓴다(REST 경로와 같은 키).
   *   ② 못 읽었으면 값은 그대로 두되 **반올림 표기라는 사실과 해상도**를 밝히고(capacityApprox·capacityBasisNote),
   *      풀이 하나뿐이면 사용률은 장비가 보고한 %를 쓴다(1% 해상도가 0.1P 해상도보다 곱다).
   */
  if (exact && exact.total > 0) {
    const eu = exact.used;
    snap.capacity = { totalBytes: exact.total, usedBytes: eu ?? null, pct: eu != null ? Math.round((eu / exact.total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
    // 매체 분리 — REST(isilon.js)와 같은 규칙: SSD 카운터가 있으면 HDD = 전체 − SSD. 없으면 isi status 의 매체 값을 둔다.
    if (exact.ssdTotal != null) {
      const sT = exact.ssdTotal; const sU = exact.ssdUsed;
      const hT = Math.max(0, exact.total - sT);
      const hU = eu != null && (sU != null || !(sT > 0)) ? Math.max(0, eu - (sU || 0)) : null;
      const pctOf = (a, b) => (b > 0 && a != null ? Math.round((a / b) * 1000) / 10 : null);
      snap.media = { hdd: hT > 0 ? { totalBytes: hT, usedBytes: hU, pct: pctOf(hU, hT) } : null, ssd: sT > 0 ? { totalBytes: sT, usedBytes: sU ?? null, pct: pctOf(sU, sT) } : null };
    }
    snap.extra.capacityBasis = 'isi statistics (ifs.bytes.*)';
  } else if (snap.sections.capacity === 'ok') {
    const present = [parsed.hdd, parsed.ssd].filter(Boolean);
    const steps = present.flatMap((p) => [p.sizeStep, p.usedStep]).filter((x) => x != null);
    const step = steps.length ? Math.max(...steps) : null;
    snap.extra.capacityBasis = 'isi status (반올림 표기)';
    snap.extra.capacityApprox = { source: 'isi status', resolutionBytes: step };
    if (present.length === 1 && present[0].usedPct != null && snap.capacity.usedBytes != null) snap.capacity.pct = present[0].usedPct;
    const res = step == null ? '' : ` — 한 칸이 약 ${fmtStep(step)} 라 증가량이 그 단위 계단으로만 움직입니다`;
    snap.extra.capacityBasisNote = `용량은 ‘isi status’ 의 **반올림 표기**로 읽었습니다${res}. 정확한 바이트(‘isi statistics’ ifs.bytes.*)를 이 세션에서 읽지 못했습니다.`
      + (present.length === 1 && present[0].usedPct != null ? ' 사용률은 장비가 보고한 %입니다.' : '');
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
  // v2.590 F10: 'Critical Events' 절을 찾지 못하면 '경보 0건' 이라 말하지 않는다(형식 변화일 수 있다) — null + 미수집.
  if (parsed.sawEvents === false) {
    snap.alerts.unresolved = null;
    snap.sections.alerts = '미수집: isi status 출력에서 Critical Events 절을 찾지 못했습니다(경보 수를 모릅니다)';
  } else {
    snap.alerts.unresolved = parsed.criticalEventCount ?? (parsed.criticalEvents || []).length;
    snap.sections.alerts = 'ok';
  }
  // isi status 에 없는 부가 정보(사용자 화면의 상단 블록) — extra 로 그대로 노출.
  snap.extra = {
    ...snap.extra,   // v2.604: 위에서 채운 용량 근거(capacityBasis·capacityApprox·capacityBasisNote)를 덮지 않는다
    collectMethod: 'ssh', clusterHealth: parsed.health,
    dataReduction: parsed.dataReduction, storageEfficiency: parsed.storageEfficiency,
    vhsBytes: parsed.vhsBytes, l3TotalBytes: parsed.l3TotalBytes,
    criticalEvents: parsed.criticalEvents || [],
    criticalEventsOmitted: Math.max(0, (parsed.criticalEventCount || 0) - (parsed.criticalEvents || []).length),
    jobs: parsed.jobs || { running: [], paused: [], failed: [], recent: [] },
  };
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok) snap.error = 'isi status 파싱 실패 — 출력 형식이 예상과 다릅니다(버전 확인 필요)';
  return snap;
}

export async function collectViaSsh(device) {
  try {
    const r = await withSsh(
      { host: device.host, port: Number(device.sshPort) || 22, username: device.username, password: device.password || '', signal: device._signal },
      async (sh) => {
        const status = await sh.exec('isi status'); // 핵심 — 실패하면 아래 catch 로(수집 실패)
        // 부가 명령은 각각 best-effort: 버전·계정이 없어도 status 파싱 결과는 살린다.
        const ver = await sh.exec('isi version').catch(() => ({ stdout: '' }));
        const usersRaw = await sh.exec('isi auth users list --format json').catch(() => ({ stdout: '' }));
        // v2.604(COL-2604-01): 정확한 용량 바이트(best-effort) — 못 읽으면 isi status 반올림 값을 쓰고 그 사실을 밝힌다.
        const stats = await sh.exec(ISI_STATS_CMD, 20_000).catch(() => ({ stdout: '' }));
        return { status: status.stdout || '', ver: ver.stdout || '', usersRaw: usersRaw.stdout || '', stats: stats.stdout || '' };
      },
    );
    const parsed = parseIsiStatus(r.status);
    const version = /OneFS\s*v?([\d.]+)/i.exec(r.ver)?.[1] || '';
    let users = null;
    try { const j = JSON.parse(r.usersRaw); users = Array.isArray(j) ? j : null; } catch { /* 계정 섹션만 생략 */ }
    const snap = normalizeIsiStatus(device, parsed, { version, users, exact: parseIsiStatsBytes(r.stats) });
    if (!users) snap.sections.accounts = r.usersRaw ? '오류: users JSON 파싱 실패' : '오류: isi auth users list 실행 실패';
    return snap;
  } catch (e) {
    // ⚠ 실패 문구 조립을 여기서 **복제하지 않는다**(v2.541 — CLAUDE.md '코어는 하나다').
    // 예전에는 이 5줄이 cliSsh.sshFailureSnapshot 과 따로 있었고, 자격증명 거부를
    // '인증 실패' 로 못 박는 수정이 cliSsh 에만 들어가면 Isilon 만 조용히 빠진다.
    return sshFailureSnapshot(device, e);
  }
}
