/**
 * 성능점검 CSV 로그 — 고부하(1만 대 서버 / 일 2GB+) 대응 스트림 라이터.
 *
 * 규모 가정과 설계 근거
 * - 1만 대 × 항목 10개 × 60초 주기 ≈ 1,700 결과/초. 행당 ~150B → 일 ~22GB 상한, 실사용 2GB+.
 * - **appendFileSync 금지**: 결과 1건마다 동기 write 를 하면 그 자체가 이벤트 루프 블로킹이고
 *   fsync 로 디스크에 직렬화된다(초당 수천 건에서 즉시 붕괴). 대신
 *   ① 인메모리 링버퍼에 넣고 ② WriteStream 으로 배치 flush(200ms 또는 256KB) ③ 백프레셔
 *   (`stream.write() === false`)면 drain 까지 대기, 그 사이 버퍼가 상한을 넘으면 **가장 오래된
 *   행부터 버리고 drop 수를 카운트**한다(로그 때문에 점검이 밀리는 것이 더 나쁘다).
 * - 파일 회전은 시각 기준(hour/day/week/month/quarter) + **크기 기준 분할**(maxFileMB)을 함께
 *   본다. 일 2GB 를 한 파일에 담으면 엑셀·grep·전송이 모두 불가능해진다 → part 접미(-p02).
 * - prune 은 파일이 새로 열릴 때만(매 행마다 readdir 금지). 보관은 파일 수 + 총량(MB) 둘 다.
 *
 * 파일명: results-YYYYMMDD[-HH][-pNN].csv · week=YYYY-Www · month=YYYYMM · quarter=YYYYQn
 */

import fs from 'node:fs';
import path from 'node:path';
import { getLogSettings, logDir, ROTATE_UNITS, ROTATE_LABEL } from './logsettings.js';

const HEADER = ['시각', '경로', '대상', '호스트', '점검명', '유형', '상태', '응답', 'ms', '연속횟수'];
const BOM = '﻿';
const FLUSH_MS = 200;              // 배치 주기 — 지연보다 스루풋 우선
const FLUSH_BYTES = 256 * 1024;    // 이 크기를 넘으면 즉시 flush
const MAX_BUFFER_BYTES = 32 * 1024 * 1024; // 백프레셔 상한(32MB) — 초과분은 오래된 행부터 폐기

const pad = (n, w = 2) => String(n).padStart(w, '0');

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - yearStart) / 86400000 + 1) / 7) };
}

/** 시간 구간 키 — 이 값이 바뀌면 파일을 회전한다. */
export function periodKey(ts, rotate) {
  const d = new Date(ts);
  switch (rotate) {
    case 'hour': return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}`;
    case 'week': { const w = isoWeek(d); return `${w.year}-W${pad(w.week)}`; }
    case 'month': return `${d.getFullYear()}${pad(d.getMonth() + 1)}`;
    case 'quarter': return `${d.getFullYear()}Q${Math.floor(d.getMonth() / 3) + 1}`;
    case 'day': default: return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }
}

export function fileNameFor(ts, rotate, part = 1) {
  const suffix = part > 1 ? `-p${pad(part)}` : '';
  return `results-${periodKey(ts, rotate)}${suffix}.csv`;
}

function cell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;                       // 엑셀 수식 인젝션 방어
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;  // RFC 4180
  return s;
}

/* ── 라이터 상태 ── */
let stream = null;
let curKey = '';        // 현재 시간 구간
let curPart = 1;
let curBytes = 0;       // 현재 파일에 쓴 바이트(크기 회전 판단)
let buf = [];           // 대기 행
let bufBytes = 0;
let draining = false;   // 백프레셔 대기 중
let timer = null;
const stats = { written: 0, dropped: 0, bytes: 0, rotations: 0, lastError: '' };

export function logStats() { return { ...stats, buffered: buf.length, bufferBytes: bufBytes }; }

function openFile(ts, cfg) {
  const dir = logDir();
  const name = fileNameFor(ts, cfg.rotate, curPart);
  const file = path.join(dir, name);
  const isNew = !fs.existsSync(file);
  curBytes = isNew ? 0 : fs.statSync(file).size;
  stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600, highWaterMark: 1024 * 1024 });
  stream.on('error', (e) => { stats.lastError = e?.message || String(e); stream = null; });
  if (isNew) {
    const head = BOM + HEADER.join(',') + '\n';
    stream.write(head);
    curBytes += Buffer.byteLength(head);
    stats.rotations += 1;
    pruneOld(dir, cfg);   // 새 파일이 열릴 때만 정리(매 행 readdir 금지)
  }
  return file;
}

function ensureStream(ts, cfg) {
  const key = periodKey(ts, cfg.rotate);
  const maxBytes = Math.max(1, cfg.maxFileMB || 512) * 1024 * 1024;
  if (stream && key === curKey && curBytes < maxBytes) return;
  if (stream && key === curKey && curBytes >= maxBytes) curPart += 1; // 같은 구간 내 크기 분할
  if (key !== curKey) { curKey = key; curPart = 1; }
  if (stream) { try { stream.end(); } catch { /* noop */ } stream = null; }
  openFile(ts, cfg);
}

function flush() {
  timer = null;
  if (!buf.length || draining) return;
  const cfg = getLogSettings();
  if (!cfg.enabled) { buf = []; bufBytes = 0; return; }
  try {
    ensureStream(Date.now(), cfg);
    if (!stream) { buf = []; bufBytes = 0; return; }
    const chunk = buf.join('');
    const size = bufBytes;
    buf = []; bufBytes = 0;
    const okToContinue = stream.write(chunk);
    curBytes += size; stats.bytes += size;
    if (!okToContinue) {                 // 백프레셔 — drain 까지 새 write 를 멈춘다
      draining = true;
      stream.once('drain', () => { draining = false; schedule(); });
    }
  } catch (e) {
    stats.lastError = e?.message || String(e);
    buf = []; bufBytes = 0;              // 디스크 문제로 무한 적재되지 않게 비운다
  }
}

function schedule() {
  if (timer || draining) return;
  timer = setTimeout(flush, FLUSH_MS);
  timer.unref?.();
}

/**
 * 결과 1건 적재(비동기 배치). 로그 비활성/모드 불일치면 no-op.
 * 워커에서 대량으로 호출되는 경로이므로 동기 I/O·객체 생성을 최소화한다.
 */
export function appendResult({ ts, target, test, result, changed }) {
  const cfg = getLogSettings();
  if (!cfg.enabled) return;
  if (cfg.mode === 'changes' && !changed) return;
  const line = [
    new Date(ts).toISOString(),
    target.path, target.name, target.host,
    test.name, test.type,
    result.status, result.reply, result.ms ?? '', result.streak ?? '',
  ].map(cell).join(',') + '\n';
  const size = Buffer.byteLength(line);
  if (bufBytes + size > MAX_BUFFER_BYTES) {
    // 상한 초과 — 오래된 행부터 버린다(점검을 멈추는 것보다 로그 유실이 낫다).
    while (buf.length && bufBytes + size > MAX_BUFFER_BYTES) {
      bufBytes -= Buffer.byteLength(buf.shift());
      stats.dropped += 1;
    }
  }
  buf.push(line); bufBytes += size; stats.written += 1;
  if (bufBytes >= FLUSH_BYTES) flush(); else schedule();
}

/** 보관 정책 — 파일 수 + 총량(MB) 초과분을 오래된 것부터 삭제. */
export function pruneOld(dir, cfg = getLogSettings()) {
  try {
    const names = fs.readdirSync(dir).filter((f) => /^results-.*\.csv$/.test(f)).sort();
    let removed = 0;
    // ① 파일 수
    for (let i = 0; i < names.length - cfg.keepFiles; i += 1) {
      fs.unlinkSync(path.join(dir, names[i])); removed += 1;
    }
    // ② 총량
    const maxTotal = (cfg.maxTotalMB || 0) * 1024 * 1024;
    if (maxTotal > 0) {
      const left = fs.readdirSync(dir).filter((f) => /^results-.*\.csv$/.test(f)).sort()
        .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }));
      let total = left.reduce((a, x) => a + x.size, 0);
      for (const x of left) {
        if (total <= maxTotal) break;
        fs.unlinkSync(path.join(dir, x.f)); total -= x.size; removed += 1;
      }
    }
    return removed;
  } catch { return 0; }
}

/** 종료 시 잔여 버퍼 flush(프로세스 재시작에서 마지막 배치 유실 방지). */
export function closeCsvLog() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (buf.length && stream) { try { stream.write(buf.join('')); } catch { /* noop */ } }
  buf = []; bufBytes = 0;
  if (stream) { try { stream.end(); } catch { /* noop */ } stream = null; }
}

/** 설정 화면용 현황. */
export function logStatus() {
  const cfg = getLogSettings();
  const dir = logDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^results-.*\.csv$/.test(f)).sort().reverse()
      .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, sizeBytes: st.size, modifiedAt: st.mtimeMs }; });
  } catch { /* 접근 실패 → 빈 목록 */ }
  return {
    ...cfg, dir,
    rotateUnits: ROTATE_UNITS,
    rotateLabels: ROTATE_LABEL,
    files: files.slice(0, 100),
    fileCount: files.length,
    totalBytes: files.reduce((a, f) => a + f.sizeBytes, 0),
    stats: logStats(),
  };
}

/** 다운로드용 — 이름 화이트리스트 + 디렉터리 재확인으로 경로 탈출 차단. */
export function logFilePath(name) {
  if (!/^results-[A-Za-z0-9-]+\.csv$/.test(name)) return null;
  const base = path.resolve(logDir());
  const p = path.resolve(base, name);
  if (path.dirname(p) !== base) return null;
  return fs.existsSync(p) ? p : null;
}
