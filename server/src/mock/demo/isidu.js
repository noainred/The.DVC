/**
 * mock/demo/isidu.js — 데모(mock) 모드의 아이실론 디렉터리 사용량(v2.736). **접속하지 않는다.**
 *
 *  · 데모 아이실론(mock/demo/storage.js 의 `mock-st-ps-*`)에 대상 3개를 둔다 — 설정이 **비어 있을 때만**, id 는 `mock-` 접두
 *    (live 로 바꾸면 폴러가 건너뛴다 — v2.719). 저장 경로는 실제와 같다(settings.saveSettings 의 검증을 그대로 탄다).
 *  · du 출력은 실제 OneFS(FreeBSD) `du -A -h|-k -d 1` 과 **같은 모양의 글자**로 만들고 진짜 파서(isidu/parse.js)가 읽는다 —
 *    숫자를 바로 넣지 않는다(파서까지 데모가 지나가게).
 *  · 사용자 이름은 **합성**이다(흔한 성·이름 음절 조합 — 실제 운영 식별자가 아니다. 공개 저장소 — v2.513 규약).
 *  · 같은 대상·같은 날은 언제나 같은 값(결정적). 일부 사용자는 최근 7일 안에 생기고, 일부는 사라지고, 한 대상은 권한 오류 줄을 낸다.
 *  · 이력은 처음 한 번만 60일치를 채운다(그 대상에 성공 스캔이 하나도 없을 때만).
 */
import { demoHash, demoRand, isMockMode } from './flags.js';

const DAY = 86_400_000;
const GIB = 1024 ** 3;
const FIRST = ['jiwon', 'minsu', 'seoyeon', 'hyunwoo', 'yuna', 'dongha', 'sujin', 'taeyang', 'eunji', 'jaehyun', 'haneul', 'soyoung', 'kyungmin', 'ara', 'junho', 'nari', 'sihyun', 'bora', 'woojin', 'yerin'];
const LAST = ['kim', 'lee', 'park', 'choi', 'jung', 'kang', 'cho', 'yoon', 'jang', 'lim', 'han', 'oh', 'seo', 'shin', 'kwon', 'hwang', 'ahn', 'song', 'ryu', 'hong'];

/** 데모 대상(데모 아이실론 id 를 가리킨다). */
export const DEMO_TARGETS = Object.freeze([
  { id: 'mock-isidu-sel', label: '서울 사용자 홈', deviceId: 'mock-st-ps-sel-01', path: '/ifs/data/workspace/users', sizeMode: 'h', users: 260, bigGiB: 900, errEvery: 0 },
  { id: 'mock-isidu-fra', label: 'Frankfurt 프로젝트', deviceId: 'mock-st-ps-fra-01', path: '/ifs/data/workspace/projects', sizeMode: 'h', users: 90, bigGiB: 2600, errEvery: 3 },
  { id: 'mock-isidu-ash', label: 'Ashburn 사용자 홈(정확)', deviceId: 'mock-st-ps-ash-01', path: '/ifs/data/workspace/users', sizeMode: 'k', users: 140, bigGiB: 420, errEvery: 0 },
]);
const SPEC = new Map(DEMO_TARGETS.map((d) => [d.id, d]));

/** FreeBSD du -h 표기(1024 단위 · 10 미만은 소수 1자리 · 4글자 넘으면 다음 단위). */
export function fmtH(bytes) {
  const U = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = Math.max(0, bytes); let i = 0;
  while (v >= 999.5 && i < U.length - 1) { v /= 1024; i++; }
  if (i === 0) return `${Math.round(v)}B`;
  if (v < 9.95) return `${(Math.round(v * 10) / 10).toFixed(1)}${U[i]}`;
  return `${Math.round(v)}${U[i]}`;
}

/** 사용자 i 의 이름 — 겹치면 숫자를 붙인다(실제 현장에도 있는 모양). */
function nameOf(seed, i) {
  const h = demoHash(`${seed}|n|${i}`);
  const base = `${FIRST[h % FIRST.length]}.${LAST[(h >>> 8) % LAST.length]}`;
  return (h >>> 16) % 7 === 0 ? `${base}${(h >>> 4) % 9 + 1}` : base;
}

/**
 * 그 대상의 그날(dayIdx = 에포크 일) 폴더 목록 — 이름 → 바이트.
 * 사용자마다 시작일·(일부) 종료일·기준 크기·하루 증가율이 결정적이다.
 */
export function demoFolders(spec, dayIdx) {
  const out = new Map();
  const today = Math.floor(Date.now() / DAY);
  for (let i = 0; i < spec.users; i++) {
    const r = (k) => demoRand(`${spec.id}|${k}|${i}`);
    let name = nameOf(spec.id, i);
    if (out.has(name)) name = `${name}${i}`;
    // 대부분은 오래전부터 있고, 약 4% 는 최근 10일 안에 생긴다. 약 3% 는 최근 6일 안에 사라진다(오늘 기준 — 날마다 바뀌지 않게).
    const isNew = r('born') < 0.04;
    const born = isNew ? today - Math.floor(r('bd') * 10) : -Infinity;
    const gone = r('gone') < 0.03 ? today - 1 - Math.floor(r('gd') * 6) : Infinity;
    if (dayIdx < born || dayIdx >= gone) continue;
    // 오늘 크기: 꼬리가 긴 분포 — 소수는 수백 GB, 대다수는 수 MB~수 GB, 일부는 빈 폴더 수준(16K).
    const z = r('size');
    let base;
    if (z > 0.97) base = spec.bigGiB * GIB * (0.3 + r('big') * 0.7);
    else if (z > 0.8) base = (20 + r('mid') * 180) * GIB;
    else if (z > 0.35) base = (0.2 + r('sm') * 9) * GIB;
    else if (z > 0.08) base = (1 + r('xs') * 900) * 1024 * 1024;
    else base = 16 * 1024;
    // 하루 증감률 — 대부분 −0.2%~+0.6%, 신규 사용자는 빠르게(하루 +15%) 채워진다. 크기는 '오늘' 을 기준으로 앞뒤 날을 만든다.
    const grow = isNew ? 0.15 : (r('g') - 0.25) * 0.008;
    const wiggle = 1 + (demoRand(`${spec.id}|w|${i}|${dayIdx}`) - 0.5) * 0.004;
    out.set(name, Math.max(16 * 1024, Math.round(base * (1 + grow) ** (dayIdx - today) * wiggle)));
  }
  return out;
}

/**
 * 그날 du 출력(글자) — collect.js 가 실제 SSH 출력처럼 파서에 넣는다.
 * @returns {{stdout:string, stderr:string, code:number}}
 */
export function demoDuOutput(t, ts = Date.now()) {
  const spec = SPEC.get(String(t?.id)) || { id: String(t?.id), users: 40, bigGiB: 200, errEvery: 0 };
  const root = String(t?.path || spec.path || '/ifs/data').replace(/\/+$/, '');
  const dayIdx = Math.floor(ts / DAY);
  const folders = demoFolders(spec, dayIdx);
  const k = (t?.sizeMode || spec.sizeMode) === 'k';
  const fmt = (b) => (k ? String(Math.ceil(b / 1024)) : fmtH(b));
  const lines = [];
  let total = 0;
  for (const [name, b] of folders) { lines.push(`${fmt(b)}\t${root}/${name}`); total += b; }
  total += 48 * 1024; // 루트 바로 아래 파일(하위 폴더 합과 루트 합계가 조금 다르다 — 실제와 같다)
  lines.push(`${fmt(total)}\t${root}`);
  let stderr = ''; let code = 0;
  if (spec.errEvery && dayIdx % spec.errEvery === 0) {
    const victim = [...folders.keys()][demoHash(`${spec.id}|err|${dayIdx}`) % Math.max(1, folders.size)] || 'archive';
    stderr = `du: ${root}/${victim}/.snapshot_tmp: Permission denied\n`;
    code = 1;
  }
  return { stdout: `${lines.join('\n')}\n`, stderr, code };
}

let _done = false; let _inflight = null; let _last = null;

/**
 * 데모 시드 + 60일 이력(처음 한 번). mock 모드가 아니면 아무것도 하지 않는다.
 * @returns {Promise<object|null>}
 */
export async function ensureIsiduDemo({ now = Date.now(), days = 60 } = {}) {
  if (!isMockMode()) return null;
  if (_done) return _last;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const out = { at: now, demo: true, seeded: 0, scans: 0 };
    try {
      const { ensureStorageDemo } = await import('./storage.js');
      await ensureStorageDemo();
      const reg = await import('../../storage/registry.js');
      const S = await import('../../isidu/settings.js');
      const devices = reg.listDevices();
      const cur = S.loadSettings();
      if (!cur.targets.length && !S.isiduSettingsLoadError()) {
        const have = DEMO_TARGETS.filter((d) => devices.some((x) => x.id === d.deviceId && x.type === 'isilon'));
        if (have.length) {
          const { pickAgent, pickDatacenter } = await import('../../cvp/formChoices.js');
          const r = S.saveSettings({
            targets: have.map((d) => ({ id: d.id, label: d.label, deviceId: d.deviceId, path: d.path, sizeMode: d.sizeMode, intervalHours: 24, topN: 10, timeoutMin: 30, auth: 'key', username: 'root' })),
            retentionDays: 400,
          }, { devices, agents: [], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
          if (r.ok) out.seeded = have.length; else out.seedError = r.error;
        }
      }
      // 이력 — 성공 스캔이 하나도 없는 데모 대상만(60일 · 하루 1회 · 마지막은 지금보다 3시간 전).
      const db = await import('../../isidu/db.js');
      const { parseDuOutput, totalsOf } = await import('../../isidu/parse.js');
      for (const d of DEMO_TARGETS) {
        const tg = S.loadSettings().targets.find((x) => x.id === d.id);
        if (!tg) continue;
        const l = await db.latestOf('', d.id);
        if (l == null || l.okScan) continue;
        const last = now - 3 * 3_600_000;
        for (let i = days - 1; i >= 0; i--) {
          const ts = last - i * DAY;
          const o = demoDuOutput(tg, ts);
          const p = parseDuOutput(o.stdout, tg.path, { mode: tg.sizeMode, stderr: o.stderr });
          const tot = totalsOf(p.entries, p.total);
          const rec = { agent: '', node: '', targetId: d.id, ts, ok: true, path: tg.path, host: '', sizeMode: tg.sizeMode, trig: 'demo',
            durationMs: 40_000 + Math.round(demoRand(`${d.id}|dur|${i}`) * 400_000), total: p.total, sumBytes: tot.sumBytes, sumRes: tot.sumRes,
            count: p.entries.length, skipped: p.skipped, errLines: p.errLines, errSample: p.errSample, truncated: p.truncated, entries: p.entries };
          const r = await db.insertScan(rec);
          if (r.ok && !r.duplicate) out.scans++;
        }
        // 실패 한 번(최근 10일 안 — 수집 상태 화면의 실패 표시가 보이게). 성공 스캔보다 앞이라 최신 상태는 성공이다.
        if (d.errEvery) await db.insertScan({ agent: '', node: '', targetId: d.id, ts: last - 4 * DAY - 2 * 3_600_000, ok: false, path: tg.path, host: '', sizeMode: tg.sizeMode, trig: 'demo', durationMs: 1_800_000, kind: 'timeout', error: 'du 시한 초과(30분) — 데모' });
      }
    } catch (e) { out.error = e.message; }
    _done = !out.error;
    _last = out;
    if (out.seeded || out.scans) console.log(`[mock] 아이실론 디렉터리 사용량 데모: 대상 ${out.seeded} · 이력 스캔 ${out.scans}건`);
    return out;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

export function _resetIsiduDemoForTest() { _done = false; _inflight = null; _last = null; }
