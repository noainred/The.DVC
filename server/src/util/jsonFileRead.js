/**
 * util/jsonFileRead.js — 설정 · 저장소 JSON 파일 **읽기 판정**(순수 단계 — 상태 등록부 없음). `util/jsonFileLoad.js` 에서 떼어 냈다.
 *
 * 왜 따로: 등록부 공용 판정(util/registryCore.js — 결정 78 남긴 것 ①)이 같은 읽기 판정(read-error · corrupt · missing · ok)을 써야 하는데,
 *   jsonFileLoad 는 settingsLoadError 를 import 하고 settingsLoadError 는 registryCore(corruptOnlyReason)를 import 한다 — registryCore 가
 *   jsonFileLoad 를 바로 import 하면 util/ 안에 import 순환이 생긴다(arch2579 · archCheck2614 상한). 판정은 이 파일 **하나**이고(사본 금지),
 *   jsonFileLoad 는 이것을 그대로 다시 내보낸다(기존 호출부 · 테스트 무변경). 판정 설명은 jsonFileLoad 머리말.
 *
 * ⚠ util/ 규약(arch2579): 도메인 모듈을 import 하지 않는다 — 이 파일은 fs · path · atomicWrite · jsonObject 만.
 */
import fs from 'node:fs';
import path from 'node:path';
import { preserveCorrupt } from './atomicWrite.js';
import { parseJsonObject } from './jsonObject.js';

/** 읽기 오류 뒤 다시 읽기까지의 간격(ms). */
export const READ_RETRY_MS = 30_000;

let _now = () => Date.now();
/** 테스트 전용 — 재읽기 간격 판정의 시계를 바꾼다(인자 없으면 원래대로). jsonFileLoad 가 같은 시계를 쓴다(nowMs). */
export function _setJsonFileLoadClockForTest(fn = null) { _now = typeof fn === 'function' ? fn : () => Date.now(); }
/** 재읽기 간격 판정의 지금 시각(테스트 시계 포함) — jsonFileLoad 의 재판정 간격도 이 시계를 쓴다. */
export function nowMs() { return _now(); }

const codeOf = (e) => String((e && typeof e === 'object' ? e.code : '') || 'read-error').slice(0, 32);

/**
 * 한 번 읽기(상태 없음). 부수효과는 `corrupt` 일 때의 preserveCorrupt 하나다(`preserve:false` 면 그것도 없다).
 * @param {string} file
 * @param {{ parse?: (text:string) => any, preserve?: boolean }} [opts]  parse 기본값은 parseJsonObject(객체가 아닌 JSON 은 손상)
 * @returns {{kind:'missing'} | {kind:'read-error', error:any} | {kind:'corrupt', error:any, backup:(string|null)} | {kind:'ok', value:any, text:string}}
 */
export function readJsonFile(file, { parse = parseJsonObject, preserve = true } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'read-error', error: e };
  }
  try { return { kind: 'ok', value: parse(text), text }; } catch (e) {
    const backup = preserve ? preserveCorrupt(file, e?.message || String(e)) : null;
    return { kind: 'corrupt', error: e, backup };
  }
}

/**
 * 재읽기 간격이 있는 읽기. 읽기 오류의 첫 회 · 회복을 콘솔에 한 번씩 남긴다(요청마다 부르는 경로라 콘솔을 채우지 않게).
 * @param {() => string} fileOf
 * @param {{ parse?: Function, preserve?: boolean, retryMs?: number, tag?: string }} [opts]  tag = 콘솔 머리(예 'cost')
 */
export function makeJsonFileReader(fileOf, { parse = parseJsonObject, preserve = true, retryMs = READ_RETRY_MS, tag = '' } = {}) {
  let retryAt = 0; let lastError = null;
  const head = () => `[${tag || 'jsonFileLoad'}] ${path.basename(String(fileOf() || ''))}`;
  return {
    /** @returns 위 readJsonFile 결과 + read-error 이면 `deferred`(간격 안 — 디스크를 보지 않았다) · `retryAt` */
    read() {
      if (lastError && _now() < retryAt) return { kind: 'read-error', error: lastError, deferred: true, retryAt };
      const r = readJsonFile(fileOf(), { parse, preserve });
      if (r.kind === 'read-error') {
        if (!lastError) console.warn(`${head()} 읽기 오류(${codeOf(r.error)}) — 손상이 아니라 원본은 그대로 둡니다 · 그동안 저장은 거절하고 ${Math.round(retryMs / 1000)}초마다 다시 읽습니다`);
        lastError = r.error; retryAt = _now() + retryMs;
        return { ...r, retryAt };
      }
      if (lastError) console.warn(`${head()} 다시 읽었습니다(읽기 오류 풀림)`);
      lastError = null; retryAt = 0;
      return r;
    },
    /** 저장 성공 · 테스트 초기화 — 다음 read() 는 곧바로 디스크를 본다. */
    reset() { lastError = null; retryAt = 0; },
    /** 읽기 오류로 다시 읽기를 기다리는 중인가. */
    pending: () => !!lastError,
  };
}
