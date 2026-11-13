/**
 * focusmon/codec.js — 표본을 **열(시리즈) 단위 1분 묶음**으로 모으고, 묶음을 압축 바이트로 바꾼다(순수 · v2.976).
 *
 * 왜 묶음인가(설계 docs/design/focus-mon §9-2 — 측정 포함): 2초 표본을 한 줄씩 DB 에 넣으면 20대 30일이 약 4.4억 줄이다.
 * node:sqlite 는 동기 API 라 넣는 동안 이벤트 루프가 선다. 서버 1대 · 1분 = 한 줄(압축 묶음)이면 86만 줄이고, 1분치 20대를 한
 * 트랜잭션으로 넣는 데 중앙값 0.37ms 였다(합성 데이터 · bench/db.mjs).
 *
 * ── 묶음 ─────────────────────────────────────────────────────────────────────────────────────────────
 *  { minute, ts:[ms…], cols: Map<시리즈 이름, (number|null)[]>, meta }  — ts 와 각 열의 길이가 같다(없던 열은 null 로 채운다).
 *  시리즈 이름: `c.pct` · `c.k3`(코어) · `m.pct` · `n.<if>.rx` · `d.<kname>.<iostat 열>` · `t.<iostat 열>`(물리 디스크 합) …
 *  meta: 그 분 마지막 구성(인터페이스 종류 · 속도 · 본딩, 장치 종류 · 부모 · 마운트, 서버 정보) — 값이 아니라 이름표다.
 * ── 바이트 ───────────────────────────────────────────────────────────────────────────────────────────
 *  deflateRaw( [머리 JSON 길이 u32][머리 JSON {v, n, keys, meta}][ts 차이 varint…][열마다: null 비트맵 + 값 ×100 정수의 앞 값 차이 zigzag varint…] )
 *  · 못 읽은 값(null)은 비트맵으로 남는다 — 0 으로 적지 않는다.
 *  · 값은 소수 둘째 자리 정수다(화면 표기와 같은 정밀도). bps · 바이트도 같은 식(2^53 안 — 산술 varint).
 *  · 판 번호 `v` 가 다르면 풀지 않는다(null) — 나중에 형식이 바뀌어도 옛 줄을 엉뚱하게 읽지 않는다.
 */
import zlib from 'node:zlib';
import { IOSTAT_COLS, summaryOf } from './rates.js';

export const CODEC_VERSION = 1;
const SCALE = 100;
const MAX_KEYS = 4096;
const MAX_N = 120; // 분당 표본 상한 — 정상은 주기 1초여도 60개. 엣지가 같은 분에 표본을 수천 개 보내 메모리를 붙잡지 못하게(2026-11-11 반증 1번)

/* ── 표본 → 시리즈 ───────────────────────────────────────────────────────────── */

/** 표본 하나를 (시리즈 이름 → 값) 과 구성 이름표로 편다. */
export function flattenSample(s) {
  const row = new Map();
  const put = (k, v) => { row.set(k, typeof v === 'number' && Number.isFinite(v) ? v : null); };
  // 요약 열(s.*)과 전체 디스크(t.*)를 **먼저** 넣는다 — 열 상한(MAX_KEYS)에 닿으면 뒤에 넣은 장치별 열부터 버려진다.
  //   예전에는 맨 뒤에 넣어 코어 64 · 디스크 300 서버에서 s.cpu 가 빠져 개요 · 비교가 그 서버만 '—' 였다(2026-11-11 반증 8번).
  const sum = summaryOf(s);
  if (sum) { put('s.cpu', sum.cpu); put('s.mem', sum.mem); put('s.net', sum.net); put('s.disk', sum.disk); put('s.wa', sum.wAwait); put('s.ra', sum.rAwait); }
  let rx = null; let tx = null;
  for (const x of s?.net || []) {
    if (x.k === 'virt' || x.m) continue;
    if (x.rx != null) rx = (rx ?? 0) + x.rx;
    if (x.tx != null) tx = (tx ?? 0) + x.tx;
  }
  put('s.rx', rx); put('s.tx', tx);
  if (Array.isArray(s?.dtot)) IOSTAT_COLS.forEach((c, i) => put(`t.${c}`, s.dtot[i]));
  if (s?.cpu) {
    for (const k of ['pct', 'usr', 'sys', 'iow', 'stl', 'irq']) put(`c.${k}`, s.cpu[k]);
    (s.cpu.cores || []).forEach((v, i) => put(`c.k${i}`, v));
  }
  if (Array.isArray(s?.load)) { put('l.1', s.load[0]); put('l.5', s.load[1]); put('l.15', s.load[2]); }
  put('l.run', s?.run); put('l.blk', s?.blk);
  if (s?.mem) for (const k of ['pct', 'total', 'used', 'avail', 'bc', 'free', 'swT', 'swU', 'dirty', 'slab']) put(`m.${k}`, s.mem[k]);
  const meta = { net: Object.create(null), dsk: Object.create(null) }; // 이름은 원격에서 온다 — 프로토타입 없는 객체
  for (const x of s?.net || []) {
    for (const k of ['rx', 'tx', 'u', 'er', 'dr']) put(`n.${x.n}.${k}`, x[k]);
    meta.net[x.n] = { k: x.k, sp: x.sp, st: x.st, m: x.m, md: x.md, mem: x.mem, act: x.act };
  }
  for (const d of s?.dsk || []) {
    IOSTAT_COLS.forEach((c, i) => put(`d.${d.n}.${c}`, d.v[i]));
    put(`d.${d.n}.fl`, d.fl);
    meta.dsk[d.n] = { dn: d.dn, k: d.k, p: d.p, mp: d.mp, sz: d.sz };
  }
  return { row, meta };
}

/** 새 묶음. */
export function newBlock(minute) { return { minute, ts: [], cols: new Map(), meta: null }; }

/** 묶음에 표본 하나를 붙인다(시각 순서가 아니면 끼워 넣는다 — 엣지 묶음이 늦게 올 수 있다). 같은 시각이면 덮는다. */
export function appendToBlock(block, ts, row, meta) {
  if (block.ts.length >= MAX_N) return false;
  let idx = block.ts.length;
  if (idx && ts <= block.ts[idx - 1]) {
    idx = block.ts.findIndex((x) => x >= ts);
    if (block.ts[idx] === ts) {
      for (const [k, v] of row) {
        if (!block.cols.has(k)) { if (block.cols.size >= MAX_KEYS) continue; block.cols.set(k, new Array(block.ts.length).fill(null)); }
        block.cols.get(k)[idx] = v;
      }
      if (meta) block.meta = meta;
      return true;
    }
    block.ts.splice(idx, 0, ts);
    for (const arr of block.cols.values()) arr.splice(idx, 0, null);
  } else {
    block.ts.push(ts);
    for (const arr of block.cols.values()) arr.push(null);
  }
  for (const [k, v] of row) {
    if (!block.cols.has(k)) { if (block.cols.size >= MAX_KEYS) continue; block.cols.set(k, new Array(block.ts.length).fill(null)); }
    block.cols.get(k)[idx] = v;
  }
  if (meta) block.meta = meta;
  return true;
}

/* ── varint ─────────────────────────────────────────────────────────────────── */
function putVar(out, n) { // n ≥ 0 정수(2^53 안)
  let x = n;
  while (x >= 128) { out.push((x % 128) + 128); x = Math.floor(x / 128); }
  out.push(x);
}
function getVar(buf, pos) {
  let x = 0; let mul = 1; let p = pos.i;
  for (;;) {
    if (p >= buf.length) throw new Error('varint 가 끊겼습니다');
    const b = buf[p++];
    x += (b & 127) * mul;
    if (b < 128) break;
    mul *= 128;
    if (mul > 2 ** 56) throw new Error('varint 가 너무 깁니다');
  }
  pos.i = p;
  return x;
}
const zz = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzz = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/* ── 묶음 ↔ 바이트 ─────────────────────────────────────────────────────────── */

export function encodeBlock(block) {
  const keys = [...block.cols.keys()];
  const n = block.ts.length;
  const head = Buffer.from(JSON.stringify({ v: CODEC_VERSION, n, m: block.minute, keys, meta: block.meta || null }), 'utf8');
  const out = [];
  let prev = block.minute * 60_000;
  for (const t of block.ts) { putVar(out, zz(Math.round(t - prev))); prev = Math.round(t); }
  for (const k of keys) {
    const arr = block.cols.get(k);
    const bm = new Array(Math.ceil(n / 8)).fill(0);
    for (let i = 0; i < n; i++) if (arr[i] == null) bm[i >> 3] |= 1 << (i & 7);
    for (const b of bm) out.push(b);
    let pv = 0;
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) continue;
      const q = Math.round(arr[i] * SCALE);
      putVar(out, zz(q - pv)); pv = q;
    }
  }
  const len = Buffer.alloc(4); len.writeUInt32LE(head.length, 0);
  return zlib.deflateRawSync(Buffer.concat([len, head, Buffer.from(out)]), { level: 6 });
}

/** 바이트 → 묶음. 형식이 다르거나 깨졌으면 null(던지지 않는다 — 한 줄이 조회 전체를 깨지 않게). */
export function decodeBlock(buf) {
  try {
    const raw = zlib.inflateRawSync(buf, { maxOutputLength: 32 * 1024 * 1024 });
    const hl = raw.readUInt32LE(0);
    if (hl > raw.length - 4 || hl > 4 * 1024 * 1024) return null;
    const h = JSON.parse(raw.subarray(4, 4 + hl).toString('utf8'));
    if (h?.v !== CODEC_VERSION || !Array.isArray(h.keys) || !(h.n >= 0) || h.n > MAX_N) return null;
    const pos = { i: 4 + hl };
    const ts = [];
    let prev = h.m * 60_000;
    for (let i = 0; i < h.n; i++) { prev += unzz(getVar(raw, pos)); ts.push(prev); }
    const cols = new Map();
    const nb = Math.ceil(h.n / 8);
    for (const k of h.keys) {
      const bm = raw.subarray(pos.i, pos.i + nb); pos.i += nb;
      const arr = new Array(h.n).fill(null);
      let pv = 0;
      for (let i = 0; i < h.n; i++) {
        if (bm[i >> 3] & (1 << (i & 7))) continue;
        pv += unzz(getVar(raw, pos));
        arr[i] = pv / SCALE;
      }
      cols.set(String(k), arr);
    }
    return { minute: h.m, ts, cols, meta: h.meta || null };
  } catch { return null; }
}

/* ── 프로세스 묶음(1분 안의 상위 30 표본들) ──────────────────────────────────── */

export function encodeProcBlock(list) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ v: CODEC_VERSION, s: list }), 'utf8'), { level: 6 });
}
export function decodeProcBlock(buf) {
  try {
    const j = JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8'));
    return j?.v === CODEC_VERSION && Array.isArray(j.s) ? j.s : null;
  } catch { return null; }
}
