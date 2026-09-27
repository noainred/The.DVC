/**
 * audit2632b.test.js — v2.632 감사 그룹 B(스토리지 합계 일관성) 회귀 고정.
 *
 * - AX2-2632-01 · AX1-2632-06: 공개 API /inventory/summary 의 스토리지 합계가 내부 /summary(v2.631)와 같은 기준이어야 한다
 *   — 사용량 미상 DS 를 사용 0 으로 더하지 않고, 설치 용량 전체·미상 개수를 따로 밝힌다. 예전 대조 테스트는 내부 라우트가
 *   아니라 스냅샷 재구현과 비교해 두 경로가 갈라진 것을 못 봤다 — 여기서는 **두 라우트를 같은 스냅샷으로 실제로 부른다**.
 * - AX1-2632-04: 내부 /summary 가 byVcenter.storageTotalTBAll(설치 용량)을 싣는다 — 프로비저닝 비교의 분모.
 * - AX1-2632-05: 낭비 리포트 엑셀 요약이 절감률 null 을 'null%' 로 쓰지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWasteSheets, pctText } from '../src/tools/wasteExport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const FIXED_AT = Date.UTC(2026, 8, 27, 3, 30, 0); // 기준 시각 고정(Date.now 금지)

test('AX1-2632-05: 절감률을 모르면 null% 가 아니라 — 이고, 사용률 모름 VM 수를 밝힌다', () => {
  const waste = { overAllocated: {
    usageUnknown: { cpu: 3, mem: 2 },
    cpu: { idleGHz: 0, allocGHz: 0, usedGHz: 0, savingPct: null, candidates: 0 },
    mem: { idleGB: 0, allocGB: 0, usedGB: 0, savingPct: null, candidates: 0 },
  } };
  const sheets = buildWasteSheets({ waste, generatedAt: FIXED_AT });
  const text = JSON.stringify(sheets[0].rows);
  assert.ok(!/null%/.test(text), `요약에 null% 가 남았습니다: ${text}`);
  assert.match(text, /절감 가능 —/);
  assert.match(text, /사용률 모름 3대 제외/);
  assert.match(text, /사용률 모름 2대 제외/);
  // 값이 있으면 그대로 퍼센트
  const ok = buildWasteSheets({ waste: { overAllocated: { cpu: { idleGHz: 1, allocGHz: 2, usedGHz: 1, savingPct: 40, candidates: 1 } } }, generatedAt: FIXED_AT });
  assert.match(JSON.stringify(ok[0].rows), /절감 가능 40%/);
  assert.ok(!/사용률 모름/.test(JSON.stringify(ok[0].rows)), '미상이 없으면 표지를 붙이지 않는다');
  assert.equal(pctText(''), '—');
  assert.equal(pctText(0), '0%');
});

function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2632b-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const v1 = (await import(${JSON.stringify(path.join(SRC, 'routes/publicApi.js'))})).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const keys = await import(${JSON.stringify(path.join(SRC, 'publicapi/keys.js'))});
    await store.refresh({ force: true });
    const app = express();
    app.use('/api/v1', v1);
    app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (p, key) => { const r = await fetch(base + p, { headers: key ? { 'X-Api-Key': key } : {} }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
    const out = await (async () => { ${script} })();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-1500)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-800)}`);
  return JSON.parse(line.slice(2));
}

test('AX2-2632-01·AX1-2632-06·AX1-2632-04: 공개 API 스토리지 합계 == 내부 /summary(사용량 미상 DS 가 있는 스냅샷)', () => {
  const r = runLive(`
    const snap = store.get();
    // 사용량을 못 읽은 DS 2개를 만든다(용량은 알고 used/free 가 없다 — freeSpace 미수신).
    const cand = snap.datastores.filter((d) => (d.capacityGB || 0) > 0).slice(0, 2);
    for (const d of cand) { d.usedGB = null; d.freeGB = null; }
    // freeGB 만 있는 DS 도 하나(dsUsedOf 폴백).
    const f = snap.datastores.find((d) => !cand.includes(d) && (d.capacityGB || 0) > 0 && d.usedGB != null);
    if (f) { f.freeGB = f.capacityGB - f.usedGB; f.usedGB = null; }
    const k = keys.issueApiKey({ name: 'b', groups: ['inventory'] }).plaintext;
    const pub = (await get('/api/v1/inventory/summary', k)).body;
    const internal = (await get('/api/summary')).body;
    return { pub: pub && pub.data, st: internal && internal.storage, byVc: internal && internal.byVcenter, injected: cand.length };
  `);
  assert.equal(r.injected, 2);
  const { pub, st } = r;
  assert.ok(pub && st, '두 응답을 받지 못했습니다');
  const near = (gb, tb, what) => assert.ok(Math.abs(gb / 1024 - tb) <= 0.06, `${what}: v1=${gb}GB(${(gb / 1024).toFixed(2)}TB) 내부=${tb}TB — 두 경로가 갈라졌습니다`);
  near(pub.storageCapacityGB, st.capacityTB, 'storageCapacityGB ↔ capacityTB');
  near(pub.storageUsedGB, st.usedTB, 'storageUsedGB ↔ usedTB');
  near(pub.storageCapacityAllGB, st.capacityTBAll, 'storageCapacityAllGB ↔ capacityTBAll');
  assert.equal(pub.datastoresUsageUnknown, st.usageUnknown);
  assert.ok(st.usageUnknown >= 2, `미상 DS 가 세어지지 않았습니다(${st.usageUnknown})`);
  assert.ok(pub.storageCapacityAllGB > pub.storageCapacityGB, '설치 용량 전체가 읽은 DS 용량보다 커야 한다');
  // byVcenter 설치 용량 합 == capacityTBAll, 행마다 storageTotalTBAll >= storageTotalTB
  const sumAll = r.byVc.reduce((a, x) => a + (x.storageTotalTBAll || 0), 0);
  assert.ok(Math.abs(sumAll - st.capacityTBAll) <= 0.1 * r.byVc.length, `byVcenter storageTotalTBAll 합 ${sumAll} ≠ ${st.capacityTBAll}`);
  for (const x of r.byVc) assert.ok(x.storageTotalTBAll >= x.storageTotalTB, `${x.id}: 설치 용량이 읽은 DS 용량보다 작다`);
});
