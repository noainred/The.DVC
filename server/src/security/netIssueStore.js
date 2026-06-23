/**
 * 게스트 네트워크 이슈 저장소 — 스캔마다 직전 카운터와 비교해 '증가분(델타)'을 산출하고,
 * 임계 이상 드롭/에러 발생 시 이슈로 기록한다. 상태(직전 카운터)와 이슈 이력을 보관.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const STATE = path.join(config.configDir, 'net-issues-state.json');
const FILE = path.join(config.configDir, 'net-issues.ndjson');
const MAX = 50_000;
const RETAIN_MS = 90 * 86_400_000;

let last = null;   // key(vm|iface) -> { rxDrop,txDrop,rxErr,txErr,rxPkts,txPkts, ts }
let issues = null; // ndjson ring

function load() {
  if (!last) { try { last = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { last = {}; } }
  if (!issues) { issues = []; try { for (const l of fs.readFileSync(FILE, 'utf8').split('\n')) if (l.trim()) issues.push(JSON.parse(l)); } catch { issues = []; } }
}
let t1 = null, t2 = null;
function persistState() { if (t1) return; t1 = setTimeout(() => { t1 = null; try { fs.writeFileSync(STATE, JSON.stringify(last), { mode: 0o600 }); } catch { /* */ } }, 3000); t1.unref?.(); }
function persistIssues() { if (t2) return; t2 = setTimeout(() => { t2 = null; const cut = Date.now() - RETAIN_MS; issues = issues.filter((r) => r.ts >= cut).slice(-MAX); try { fs.writeFileSync(FILE, issues.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } }, 3000); t2.unref?.(); }

/** 한 VM 스캔 결과를 반영 → 새 이슈 배열 반환. threshold: 인터벌 내 신규 드롭+에러 합. */
export function recordNetScan({ vcenterId = '', vm = '', os = '' } = {}, ifaces = [], { threshold = 1 } = {}) {
  load();
  const now = Date.now();
  const found = [];
  for (const f of ifaces) {
    const key = `${vcenterId}|${vm}|${f.iface}`;
    const prev = last[key];
    const cur = { rxDrop: f.rxDrop || 0, txDrop: f.txDrop || 0, rxErr: f.rxErr || 0, txErr: f.txErr || 0, rxPkts: f.rxPkts || 0, txPkts: f.txPkts || 0, ts: now };
    if (prev) {
      const d = (a, b) => Math.max(0, (a || 0) - (b || 0)); // 카운터 리셋(재부팅) 시 음수 방지
      const newDrop = d(cur.rxDrop, prev.rxDrop) + d(cur.txDrop, prev.txDrop);
      const newErr = d(cur.rxErr, prev.rxErr) + d(cur.txErr, prev.txErr);
      const newPkts = d(cur.rxPkts, prev.rxPkts) + d(cur.txPkts, prev.txPkts);
      if (newDrop + newErr >= threshold) {
        const rec = { ts: now, vcenterId, vm, os, iface: f.iface, newDrop, newErr, newPkts, dropRate: newPkts ? Number(((newDrop / newPkts) * 100).toFixed(3)) : null };
        issues.push(rec); found.push(rec);
      }
    }
    last[key] = cur;
  }
  if (found.length) persistIssues();
  persistState();
  return found;
}

export function getNetIssues(sinceTs = 0) { load(); return issues.filter((r) => r.ts >= sinceTs); }

export function analyzeNetIssues({ vcenterId = '', days = 7 } = {}) {
  load();
  const since = Date.now() - Math.max(1, days) * 86_400_000;
  const rows = issues.filter((r) => r.ts >= since && (!vcenterId || r.vcenterId === vcenterId));
  const byVm = new Map(); const byIface = new Map();
  for (const r of rows) {
    const vk = `${r.vcenterId}/${r.vm}`;
    const v = byVm.get(vk) || { key: vk, vm: r.vm, vcenterId: r.vcenterId, os: r.os, drop: 0, err: 0, events: 0, maxRate: 0 };
    v.drop += r.newDrop; v.err += r.newErr; v.events++; v.maxRate = Math.max(v.maxRate, r.dropRate || 0); byVm.set(vk, v);
    byIface.set(r.iface, (byIface.get(r.iface) || 0) + r.newDrop + r.newErr);
  }
  const hourly = new Map();
  for (const r of rows) { const h = Math.floor(r.ts / 3_600_000) * 3_600_000; const g = hourly.get(h) || { ts: h, drop: 0, err: 0 }; g.drop += r.newDrop; g.err += r.newErr; hourly.set(h, g); }
  const top = [...byVm.values()].sort((a, b) => (b.drop + b.err) - (a.drop + a.err));
  return {
    config: { days, vcenterId: vcenterId || '' },
    summary: { total: rows.length, vms: byVm.size, drops: rows.reduce((a, r) => a + r.newDrop, 0), errors: rows.reduce((a, r) => a + r.newErr, 0) },
    topVms: top.slice(0, 50),
    byIface: [...byIface.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([key, count]) => ({ key, count })),
    timeline: [...hourly.values()].sort((a, b) => a.ts - b.ts).slice(-Math.min(days * 24, 336)),
    recent: rows.sort((a, b) => b.ts - a.ts).slice(0, 100),
    generatedAt: Date.now(),
  };
}
