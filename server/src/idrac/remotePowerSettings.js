/**
 * idrac/remotePowerSettings.js — 물리서버 원격 전원 조작 · 위치 LED 켜기/끄기 **켜기 스위치**(v3.52 · ⑦ ⑥). 기본 **꺼짐**.
 *  (전력 집계 표시 설정 idrac/powerSettings.js 와 다른 것이다 — 이름이 겹치지 않게 따로 둔다.)
 *  · enabled: 전원 · LED 단추를 연다(꺼져 있으면 라우트가 403 — 화면도 단추를 그리지 않는다).
 *  · allowForce: 강제 재시작 · 강제 끄기(운영체제를 기다리지 않는다 — 데이터 손실 위험)를 따로 연다. 기본 꺼짐 · enabled 가 꺼지면 함께 꺼진다.
 *  · 바꾸기는 전체 범위 관리자 + 본인 OTP(라우트) · 감사. 엣지에 배포하지 않는다(중앙이 판단해 엣지에 한 건씩 보낸다).
 *  · 손상 · 모르는 꼴이면 꺼짐으로 읽고 쓰기를 막는다(서비스 점검).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.configDir, 'bm-power.json');
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const emptyRemotePower = () => ({ v: 1, enabled: false, allowForce: false, at: null, by: '' });
const shape = (d) => (isObj(d) ? { v: 1, enabled: d.enabled === true, allowForce: d.enabled === true && d.allowForce === true, at: numOrNull(d.at), by: typeof d.by === 'string' ? d.by.slice(0, 80) : '' } : emptyRemotePower());
const parse = (text) => { const v = JSON.parse(text); if (!isObj(v)) throw new Error('형식이 아닙니다(객체여야 합니다)'); if (v.v !== undefined && v.v !== 1) throw new Error('이 판이 모르는 파일 판 번호입니다'); return v; };
const _file = makeJsonFileLoader(FILE, { label: '물리서버 원격 전원 · LED 켜기 설정', tag: 'bm-power', parse, confirm: () => remotePower._confirm() });
let _cache = null;
export const remotePower = {
  get() {
    if (_cache && !_file.recheckDue()) return _cache;
    const r = _file.load();
    if (r.kind === 'read-error') return emptyRemotePower();
    _cache = r.kind === 'ok' ? shape(r.value) : emptyRemotePower();
    return _cache;
  },
  loadError: () => { remotePower.get(); return _file.loadError(); },
  refusal: () => { remotePower.get(); return _file.refusal('물리서버 원격 전원 · LED 켜기 설정'); },
  save({ enabled, allowForce } = {}, { by = '', now = Date.now() } = {}) {
    const refused = remotePower.refusal();
    if (refused) return { ok: false, status: 409, ...refused };
    if (typeof enabled !== 'boolean' || (allowForce !== undefined && typeof allowForce !== 'boolean')) return { ok: false, status: 400, reason: 'enabled · allowForce 는 참/거짓이어야 합니다.' };
    const next = shape({ enabled, allowForce: allowForce === true, at: now, by });
    try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2)); } catch (e) { return { ok: false, status: 500, reason: `설정 파일을 쓰지 못했습니다 — ${String(e?.code || e?.message || e).slice(0, 120)}` }; }
    _cache = next; _file.saved();
    return { ok: true, value: next };
  },
  _confirm() { atomicWriteFileSync(FILE(), JSON.stringify(emptyRemotePower(), null, 2)); _cache = null; _file.saved(); },
  _resetForTest() { _cache = null; _file.resetRetry(); },
};
