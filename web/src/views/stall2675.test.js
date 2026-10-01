/**
 * v2.675 — 운영 멈춤 후보 개선의 화면 쪽(순수 문구 + 소스 스윕).
 *  ① 첫 병합 전 골격(/overview initial)이면 0 대가 아니라 '첫 수집 중' 을 말한다(엔지니어·경영 보기 · V6)
 *  ② 로그인 실패 분석: 무엇을 얼마나 훑었는지·잘렸는지·언제 분석한 값인지 말한다 · 분석은 상태보다 드물게 부른다
 *  ③ 롤업 백필 상태 한 줄  ④ 하단 상태바(개발 포탈·V6) — 첫 수집 중이면 0 이 아니라 '—'
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { firstCollectNotice } from './overviewCardsText.js';
import { scanNote, analyzedAtText, ANALYSIS_REFRESH_MS } from './loginFailsText.js';
import { serverSegments } from '../version_6/v6Data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.join(HERE, rel), 'utf8'));
const G = (o) => ({ vcenters: 0, vcentersDisabled: 0, vcentersMaintenance: 0, vcentersUnreachable: 0, vcentersPending: 0, ...o });

describe('① 첫 수집 중 안내(firstCollectNotice)', () => {
  it('골격이 아니면 null — 평소 화면 그대로', () => {
    expect(firstCollectNotice(null)).toBe(null);
    expect(firstCollectNotice({ global: G({ vcenters: 3, vcentersPending: 3 }) })).toBe(null);
    expect(firstCollectNotice({ initial: 'true', global: G({ vcenters: 3, vcentersPending: 3 }) })).toBe(null);
  });
  it('첫 수집 중 — 몇 곳을 읽는지 · 기다리면 채워진다', () => {
    const n = firstCollectNotice({ initial: true, global: G({ vcenters: 28, vcentersPending: 28 }) });
    expect(n.title).toBe('첫 수집 중 — vCenter 28곳을 처음 읽고 있습니다');
    expect(n.detail).toMatch(/끝나면 이 화면이 채워집니다/);
    expect(n.detail).not.toMatch(/\d+초|\d+분 걸/);   // 주기·데드라인 숫자를 박지 않는다(v2.509)
  });
  it('인증 정지·점검·비활성은 각각 따로 말한다(기다려도 안 되는 것을 숨기지 않는다)', () => {
    const n = firstCollectNotice({ initial: true, global: G({ vcenters: 10, vcentersPending: 6, vcentersUnreachable: 2, vcentersMaintenance: 1, vcentersDisabled: 1 }) });
    expect(n.detail).toMatch(/인증 실패로 수집을 멈춘 vCenter 2곳은 기다려도 채워지지 않습니다/);
    expect(n.detail).toMatch(/점검 중 1곳/);
    expect(n.detail).toMatch(/비활성 1곳/);
  });
  it('읽을 것이 없을 때 — 등록 없음 · 전부 꺼짐 · 마무리', () => {
    expect(firstCollectNotice({ initial: true, global: G({}) }).title).toBe('등록된 vCenter 가 없습니다');
    expect(firstCollectNotice({ initial: true, global: G({ vcenters: 2, vcentersDisabled: 2 }) }).title).toBe('켜진 vCenter 가 없습니다');
    const m = firstCollectNotice({ initial: true, global: G({ vcenters: 2, vcentersMaintenance: 1, vcentersUnreachable: 1 }) });
    expect(m.title).toBe('첫 수집을 마무리하고 있습니다');
    expect(m.detail).toMatch(/인증 실패/);
    expect(firstCollectNotice({ initial: true }).title).toBe('등록된 vCenter 가 없습니다');   // global 이 없어도 던지지 않는다
  });
  it('문구에 백틱·별표 없음(BoldText 규약)', () => {
    for (const g of [G({ vcenters: 5, vcentersPending: 3, vcentersUnreachable: 1, vcentersMaintenance: 1 }), G({}), G({ vcenters: 1, vcentersDisabled: 1 })]) {
      const n = firstCollectNotice({ initial: true, global: g });
      expect(n.title + n.detail).not.toMatch(/`|\*\*/);
    }
  });
  it('V6 서버 3구분 — 골격이면 0 이 아니라 값 없음(—) + 첫 수집 중', () => {
    const s = serverSegments({ initial: true, global: { hosts: 0, vms: 0 }, physical: { servers: 0 } });
    expect(s.phys.value).toBe(null); expect(s.host.value).toBe(null); expect(s.vm.value).toBe(null);
    expect(s.host.sub).toMatch(/첫 수집 중/);
    const t = serverSegments({ global: { hosts: 5, vms: 9 }, physical: { servers: 2 } });
    expect(t.host.value).toBe(5); expect(t.vm.value).toBe(9);
  });
  it('소스 — 엔지니어·경영 보기는 골격이면 안내를 그리고, V6 Overview 는 initial 을 본다', () => {
    const ov = src('Overview.jsx');
    expect(ov).toMatch(/const fc = firstCollectNotice\(ov\);/);
    expect(ov).toMatch(/if \(!ov\.global \|\| fc\) return/);
    const ex = src('ExecOverview.jsx');
    expect(ex).toMatch(/const fc = firstCollectNotice\(ov\);/);
    expect(ex).toMatch(/if \(!g \|\| fc\) return/);
    expect(ex.indexOf('if (!g || fc)')).toBeLessThan(ex.indexOf('headline(g)'));   // '0개 법인 정상 운영 중' 헤드라인보다 먼저
    expect(src('../version_6/pages/Overview.jsx')).toMatch(/if \(!ov\.global \|\| ov\.initial\)/);
  });
});

describe('② 로그인 실패 분석 — 범위·잘림·분석 시각', () => {
  it('scan 이 없으면(구버전 서버) 빈 문구', () => {
    expect(scanNote(null)).toEqual({ text: '', warn: '' });
    expect(scanNote('x')).toEqual({ text: '', warn: '' });
  });
  it('훑은 범위 · 숫자는 서버 값만', () => {
    const r = scanNote({ days: 7, chunks: 168, candidates: 12345, ms: 812, truncated: false, rowsMax: 20000 });
    expect(r.text).toBe('vCenter 이벤트 7일치 · 1시간 조각 168개 · 후보 12,345건 · 분석 812ms');
    expect(r.warn).toBe('');
  });
  it('잘렸으면 상한과 함께 경고(전부인 것처럼 보이지 않게)', () => {
    expect(scanNote({ days: 7, truncated: true, rowsMax: 20000 }).warn).toMatch(/최근 20,000건까지만 셌습니다/);
    expect(scanNote({ truncated: true }).warn).toMatch(/최근 상한까지만/);   // 상한을 모르면 숫자를 지어내지 않는다
  });
  it('DB 를 못 읽었으면 vCenter 실패를 세지 않았다고 말한다', () => {
    const r = scanNote({ source: 'unavailable', chunks: 0 });
    expect(r.text).toBe('');
    expect(r.warn).toMatch(/vCenter 로그 DB 를 읽지 못해/);
  });
  it('빈 값·null 은 0 으로 읽지 않는다', () => {
    expect(scanNote({ days: '', chunks: null, candidates: undefined, ms: '' }).text).toBe('');
  });
  it('분석 시각 — 언제 분석한 값인지', () => {
    const t = Date.UTC(2026, 9, 1, 3, 4, 5);
    expect(analyzedAtText(null)).toBe('');
    expect(analyzedAtText(0)).toBe('');
    expect(analyzedAtText(t, t + 12_000)).toMatch(/\(12초 전\)$/);
    expect(analyzedAtText(t, t + 5 * 60_000)).toMatch(/\(5분 전\)$/);
    expect(analyzedAtText(t, t + 2 * 3_600_000)).toMatch(/\(2시간 전\)$/);
    expect(analyzedAtText(t, t - 5_000)).toMatch(/\(0초 전\)$/);   // 시계가 조금 어긋나도 음수를 말하지 않는다
  });
  it('분석 결과는 상태(30초)보다 드물게 다시 부른다', () => {
    expect(ANALYSIS_REFRESH_MS).toBeGreaterThan(30_000);
    const s = src('LoginFails.jsx');
    expect(s).toMatch(/setInterval\(loadAnalysis, ANALYSIS_REFRESH_MS\)/);
    expect(s).toMatch(/setInterval\(loadStatus, 30_000\)/);
    expect(s).not.toMatch(/setInterval\(load, 30_000\)/);
    expect(s).toMatch(/scanNote\(d\.scan\)/);
  });
  it('문구에 백틱·별표 없음', () => {
    for (const sc of [{ source: 'unavailable' }, { truncated: true, rowsMax: 5 }, { days: 1, chunks: 2, candidates: 3, ms: 4 }]) {
      const r = scanNote(sc);
      expect(r.text + r.warn).not.toMatch(/`|\*\*/);
    }
  });
});

import { rollupBackfillNote } from './rollupBackfillText.js';
describe('③ 롤업 백필 상태 한 줄(설정 › 지표 수집)', () => {
  const NOW = Date.UTC(2026, 9, 1, 4, 0, 0);
  it('구버전 서버·대상 아님은 표시하지 않는다', () => {
    for (const rb of [null, undefined, {}, { state: 'idle' }, { state: 'unsupported' }]) expect(rollupBackfillNote(rb, NOW)).toEqual({ text: '', warn: '' });
  });
  it('진행 중 — 서버가 준 숫자만(범위 관리자는 숫자 없이)', () => {
    expect(rollupBackfillNote({ state: 'running', keysDone: 120, keysTotal: 900, hours: 34567 }, NOW).text).toMatch(/진행 중 — 키 120\/900.* · 옮긴 시간 34,567/);
    const scoped = rollupBackfillNote({ state: 'running', startedAt: NOW - 1000 }, NOW).text;
    expect(scoped).toMatch(/진행 중\. /);
    expect(scoped).not.toMatch(/키 |옮긴 시간|0\/0/);
  });
  it('완료 — 언제 · 무엇을 옮겼나 · 옮길 것이 없었나', () => {
    expect(rollupBackfillNote({ state: 'done', marker: { doneAt: NOW - 3 * 3_600_000, keysFilled: 32, hours: 1087 } }, NOW).text).toBe('옛 원본 → 시간당 롤업 이전 완료(3시간 전) — 키 32개 · 시간당 1,087행.');
    expect(rollupBackfillNote({ state: 'done', marker: { doneAt: NOW - 60_000, keysFilled: 0, hours: 0 } }, NOW).text).toMatch(/옮길 옛 원본이 없었습니다/);
    expect(rollupBackfillNote({ state: 'done' }, NOW).text).toBe('옛 원본 → 시간당 롤업 이전 완료.');
  });
  it('멈춤(디스크·오류)은 경고로 사유를 그대로 · 진행 못 한 키는 센다', () => {
    const w = rollupBackfillNote({ state: 'disk-low', lastError: '디스크 여유 1.0GB — 하한 5.0GB 아래라 멈췄습니다' }, NOW);
    expect(w.text).toBe(''); expect(w.warn).toMatch(/멈춤: 디스크 여유 1\.0GB/);
    expect(rollupBackfillNote({ state: 'error' }, NOW).warn).toMatch(/사유 미상/);
    expect(rollupBackfillNote({ state: 'done', stuckKeys: 2 }, NOW).text).toMatch(/건너뛴 키 2개/);
  });
  it('꺼짐·대기 · 문구에 백틱·별표·숫자 박기 없음', () => {
    expect(rollupBackfillNote({ state: 'off' }, NOW).text).toMatch(/꺼져 있습니다/);
    const w = rollupBackfillNote({ state: 'waiting' }, NOW).text;
    expect(w).toMatch(/잠시 후/); expect(w).not.toMatch(/\d+분/);
    for (const st of ['off', 'waiting', 'running', 'done', 'disk-low', 'error']) {
      const r = rollupBackfillNote({ state: st, lastError: 'x', marker: { doneAt: NOW, keysFilled: 1, hours: 1 } }, NOW);
      expect(r.text + r.warn).not.toMatch(/`|\*\*/);
    }
  });
  it('소스 — 설정 화면이 상태를 그린다', () => {
    expect(src('MetricsSettings.jsx')).toMatch(/rollupBackfillNote\(status\.rollupBackfill\)/);
  });
});

import { statusCounts, FIRST_COLLECT_TITLE } from './statusBarText.js';
describe('④ 하단 상태바 — 첫 수집 중·미수신이면 0 이 아니라 —', () => {
  it('/health 를 아직 받지 못했으면 — (0 이 아니다)', () => {
    for (const h of [null, undefined, 'x']) {
      const r = statusCounts(h);
      expect([r.hosts, r.vms, r.vmsOn, r.alarms]).toEqual(['—', '—', '—', '—']);
      expect(r.pending).toBe(false);
    }
  });
  it('첫 병합 전 골격(initial)이면 서버가 0 을 보내도 — · 툴팁이 이유를 말한다', () => {
    const r = statusCounts({ initial: true, hosts: 0, vms: 0, vmsPoweredOn: 0, alarms: 0 });
    expect([r.hosts, r.vms, r.vmsOn, r.alarms]).toEqual(['—', '—', '—', '—']);
    expect(r.pending).toBe(true);
    expect(r.title).toBe(FIRST_COLLECT_TITLE);
    expect(r.title).not.toMatch(/`|\*\*/);
  });
  it('보고가 있으면 개수 — 0 은 0 이다(카운터)', () => {
    const r = statusCounts({ hosts: 1234, vms: 0, vmsPoweredOn: 0, alarms: 3 });
    expect(r.hosts).toBe((1234).toLocaleString());
    expect([r.vms, r.vmsOn, r.alarms]).toEqual(['0', '0', '3']);
    expect(r.pending).toBe(false);
    expect(r.title).toBeUndefined();
    expect(statusCounts({ initial: false, hosts: 2 }).hosts).toBe('2');
  });
  it('소스 — 개발 포탈·V6 상태바가 같은 판정을 쓰고 health.hosts 를 0 으로 채우지 않는다', () => {
    const app = src('../App.jsx');
    expect(app).toMatch(/const sbCounts = statusCounts\(health\);/);
    expect(app).toMatch(/\{sbCounts\.hosts\}/);
    expect(app).not.toMatch(/\(health\?\.hosts \|\| 0\)/);
    expect(app).not.toMatch(/\(health\?\.vms \|\| 0\)/);
    expect(app, '헤더 pill 분모가 비활성을 포함한다(V6 와 다른 숫자)').toMatch(/\$\{conn\}\/\$\{Math\.max\(0, total - off\)\} vCenter/);
    expect(app).not.toMatch(/`\$\{conn\}\/\$\{total\} vCenter`/);
    const v6 = src('../version_6/V6Shell.jsx');
    expect(v6).toMatch(/const sb = statusCounts\(health\);/);
    expect(v6).toMatch(/sb\.pending \? '—' : fmtInt\(health\?\.hosts\)/);
  });
});
