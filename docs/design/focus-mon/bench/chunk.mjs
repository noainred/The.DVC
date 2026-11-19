// 집중 모니터링 DB 저장 검토 — 1분 묶음(청크)의 크기와 속도를 합성 데이터로 잰다. 실서버 값이 아니다.
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
const frac = (x) => x - Math.floor(x);
const hash = (a, b) => frac(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
const noisy = (base, rel, seed, t) => Math.max(0, base * (1 + rel * (hash(seed, t) - 0.5) * 2 + rel * 0.5 * Math.sin((t + seed) / 17)));

// 서버 1대의 열(시리즈) 구성: CPU 8 · 메모리 8 · 인터페이스 6개 × 6 · 블록 장치 17개 × 13(iostat 열) — 보내 주신 화면의 장치 수(sda~sdk 11 + dm 6 = 17)
function seriesDefs(server) {
  const d = [];
  for (let i = 0; i < 8; i++) d.push({ base: [62, 18, 13, 0.3, 1, 0.5, 38, 1284][i], rel: 0.08, q: 100 });
  for (let i = 0; i < 8; i++) d.push({ base: [215, 31, 9.8, 0, 1.2, 6.4, 84, 0][i], rel: 0.004, q: 100 });
  for (let n = 0; n < 6; n++) { const idle = n >= 4; for (let i = 0; i < 6; i++) d.push({ base: idle ? 0 : [4.6e9, 2.9e9, 380000, 240000, 0, 23][i], rel: i === 4 ? 0 : 0.2, q: i < 4 ? 1 : 100 }); }
  for (let b = 0; b < 17; b++) {
    const kind = b % 17 < 7 ? 'busy' : b % 17 < 11 ? 'light' : 'idle';   // 7개 바쁨 · 4개 가벼움 · 6개 조용
    const B = kind === 'busy' ? [0, 40, 800, 2000, 35, 130, 120, 40, 14, 6, 18, 0.2, 60] : kind === 'light' ? [0, 1, 2, 30, 0.1, 0.8, 50, 0.1, 1.2, 0.9, 1.3, 0.3, 2] : new Array(13).fill(0);
    for (let i = 0; i < 13; i++) d.push({ base: B[i], rel: kind === 'idle' ? 0 : 0.25, q: 100 });
  }
  return d.map((x, i) => ({ ...x, seed: server * 1000 + i }));
}
function chunkOf(server, minute, perMin) {
  const defs = seriesDefs(server);
  const cols = defs.map((s) => { const a = new Float64Array(perMin); for (let k = 0; k < perMin; k++) a[k] = noisy(s.base, s.rel, s.seed, minute * perMin + k); return a; });
  return { defs, cols };
}
// (a) 표본마다 JSON 객체 → gzip
function encJson({ cols }, perMin) { const rows = []; for (let k = 0; k < perMin; k++) rows.push(cols.map((c) => Math.round(c[k] * 100) / 100)); return zlib.gzipSync(Buffer.from(JSON.stringify(rows)), { level: 6 }); }
// (b) 열 방향 · 정수로 양자화(소수 둘째 자리) · 앞 값과의 차이 · 가변 길이 정수 → deflate
function varint(out, v) { let z = (v << 1) ^ (v >> 31); z >>>= 0; while (z >= 0x80) { out.push((z & 0x7f) | 0x80); z >>>= 7; } out.push(z); }
function encCol({ defs, cols }, perMin) {
  const out = [];
  cols.forEach((c, i) => { let prev = 0; const q = defs[i].q; for (let k = 0; k < perMin; k++) { let v = Math.round(c[k] * q); if (v > 0x3fffffff) v = Math.round(c[k] / 1000); varint(out, v - prev); prev = v; } });
  return zlib.deflateRawSync(Buffer.from(out), { level: 6 });
}
function measure(label, perMin) {
  let a = 0, b = 0, tA = 0, tB = 0, tD = 0; const N = 60;
  for (let m = 0; m < N; m++) { const ch = chunkOf(1 + (m % 20), 5000 + m, perMin);
    let t = performance.now(); const ja = encJson(ch, perMin); tA += performance.now() - t; a += ja.length;
    t = performance.now(); const cb = encCol(ch, perMin); tB += performance.now() - t; b += cb.length;
    t = performance.now(); zlib.inflateRawSync(cb); tD += performance.now() - t; }
  const vals = seriesDefs(1).length * perMin;
  console.log(`${label}: 시리즈 ${seriesDefs(1).length}개 × ${perMin}표본 = ${vals}값/분 | JSON+gzip ${(a / N / 1024).toFixed(1)}KB (${(tA / N).toFixed(2)}ms) | 열 방향+deflate ${(b / N / 1024).toFixed(1)}KB (${(tB / N).toFixed(2)}ms, 풀기 ${(tD / N).toFixed(2)}ms)`);
  return { json: a / N, col: b / N };
}
const r2 = measure('2초 주기(1분 30표본)', 30);
const r10 = measure('10초 주기(1분 6표본)', 6);
const r60 = measure('1분 평균 1표본(롤업)', 1);

// 프로세스: 5초마다 상위 30개 — 1분 12표본. 신원표(pid · 시작 · 사용자 · 명령) + 표본별 (번호 · CPU×10 · RSS MB)
function procChunk(server, minute) {
  const ids = []; for (let i = 0; i < 36; i++) ids.push({ pid: 3000 + ((server * 97 + i * 131) % 60000), st: 1700000000 + i * 977, user: ['oracle', 'wasadm', 'root', 'bareos'][i % 4], cmd: i % 3 === 0 ? 'oracleORCL (LOCAL=NO)' : i % 3 === 1 ? 'java -Xms8g -Xmx12g -Ddb.url=jdbc:oracle:thin:@kr-db-01:1521/KRPRD -Ddb.password=[가림] -jar /app/order-api-' + i + '.jar' : 'ora_p0' + (i % 10) + '_ORCL' });
  const samples = []; for (let k = 0; k < 12; k++) { const row = []; for (let i = 0; i < 30; i++) { const who = (i + (hash(server, minute * 12 + k) > 0.8 ? 1 : 0)) % 36; row.push([who, Math.round(noisy(990 - i * 25, 0.1, server * 50 + i, minute * 12 + k)), 1400 - i * 30]); } samples.push(row); }
  return zlib.gzipSync(Buffer.from(JSON.stringify({ ids, samples })), { level: 6 });
}
let p = 0; for (let m = 0; m < 60; m++) p += procChunk(1 + (m % 20), 7000 + m).length; p /= 60;
console.log(`프로세스 1분 묶음(12표본 × 30개 · 신원표 36개): gzip ${(p / 1024).toFixed(2)}KB`);

const GB = 1024 ** 3; const perDay = 1440;
const line = (name, bytesPerMin) => { const d = bytesPerMin * perDay; console.log(`  ${name}: 서버 1대 하루 ${(d / 1048576).toFixed(1)}MB · 20대 30일 ${(d * 20 * 30 / GB).toFixed(2)}GB`); };
console.log('연속 수집(24시간 내내)일 때 30일 크기 — 열 방향 기준:');
line('지표 2초', r2.col); line('지표 10초', r10.col); line('지표 1분 평균', r60.col); line('프로세스 5초', p); line('프로세스 1분(12표본 중 평균 상위 30)', p / 12 * 1.6);
console.log(JSON.stringify({ col2: Math.round(r2.col), col10: Math.round(r10.col), col60: Math.round(r60.col), json2: Math.round(r2.json), proc: Math.round(p) }));
