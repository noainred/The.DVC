/**
 * util/authGuard.js — 인증 실패(401/403) 대상의 **주기 수집 정지** 공용 코어(v2.535).
 *
 * 왜 공용인가: 스토리지(v2.528)가 먼저 가졌던 `storage/authGuard.js` 를 여기로 올렸다.
 * v2.535 자격증명 감사에서 **Horizon 세션 수집에는 같은 방어가 없다**는 것이 확인됐다 —
 * `horizon/sessionCollect.js:82` 가 401/403 을 `kind:'auth'` 로 정확히 분류하는데 폴러는
 * 화면 표시용 `errors` 에 담기만 하고 다음 주기에 같은 AD 계정으로 다시 로그인한다.
 * 주기 기본 5분·하한 60초이므로 서버 1대당 하루 288~1,440회 실패 로그인이고, 그것이
 * **AD 서비스 계정을 스스로 잠그는 경로**다. 20줄을 복사하면 다음 도구에서 또 빠지므로
 * (CLAUDE.md '코어는 하나다') 파일명만 주입하는 팩토리로 만든다.
 *
 * ── 반드시 지킬 것(스토리지 v2.528 규약 그대로) ────────────────────────────────
 * 1. **조용히 멈추지 않는다.** 정지 사실·시각·시도 횟수를 응답에 실어 화면이 말한다.
 *    말없이 멈추면 사용자는 '수집이 되는 줄' 안다 — 이 기능이 만들 수 있는 최악의 거짓이다.
 * 2. **자격증명이 바뀌면 자동 재개**한다(`credHash` 비교). 비밀번호를 고치는 것이 곧 조치인데
 *    버튼을 한 번 더 눌러야 하면 '고쳤는데 왜 안 되지' 가 된다.
 * 3. **수동 실행은 막지 않는다.** 사람이 1회 누르는 것은 잠금 위험이 없고, 고쳤는지 확인할
 *    길을 없애면 안 된다. 막는 것은 **주기 수집뿐**이다.
 * 4. **401/403 만 대상**이다. 타임아웃·연결 실패·형식 오류로 멈추면 일시적 네트워크 장애가
 *    수집을 영구 정지시킨다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from './atomicWrite.js';
import { credFingerprintParts } from './credFingerprint.js';

/**
 * 문구가 '인증 실패' 인가(순수).
 * ⚠ 넓게 잡지 말 것 — '연결 실패' 까지 포함하면 네트워크 장애가 수집을 영구 정지시킨다.
 *
 * ⚠⚠ **v2.541 에 고친 실제 결함 — SSH 인증 실패를 통째로 놓치고 있었다.**
 * ssh2 가 인증에 실패할 때 내는 문구는 `All configured authentication methods failed`
 * 하나뿐인데(`node_modules/ssh2/lib/client.js:863`, `err.level='client-authentication'`),
 * 예전 패턴은 `authentication fail` **연속 일치**만 봤다 — 실제 문구는 사이에 `methods` 가
 * 끼어 있어 **매치되지 않았다**(사용자 화면: `SSH 수집 실패: All configured authentication
 * methods failed`). 결과는 두 가지였다:
 *   ① Unity·Isilon 같은 SSH 수집기는 자격증명이 틀려도 **주기 수집이 멈추지 않아** 매 주기
 *      같은 계정으로 다시 로그인했다 — v2.528 이 막으려던 바로 그 **계정 잠금 경로**다.
 *   ② 화면에 `authStopped`(정지 사실·지문 대조 안내)가 **영원히 뜨지 않아**, 엣지 위임 장비의
 *      '중앙 배포가 상했나 / 실제 비밀번호가 다른가' 를 가려낼 단서가 사라졌다.
 * 그래서 `authentication <낱말 0~3개> fail` 로 넓히고 `client-authentication`(ssh2 의 level)도
 * 함께 본다. 낱말 반복은 `{0,3}` 으로 **상한을 둔다**(무한 반복은 긴 비매치 입력에서 백트래킹).
 *
 * ⚠ 아래 것들은 **여전히 잡지 않는다**(잡으면 규칙 4 위반 — 일시 장애가 수집을 영구 정지시킨다):
 *   `ETIMEDOUT` · `ECONNREFUSED` · `ENOTFOUND` · `socket hang up` · `self signed certificate` ·
 *   `Handshake failed: no matching key exchange algorithm`(협상 실패 — 'failed' 가 들어 있지만
 *   자격증명 문제가 아니다) · `Cannot parse privateKey`(설정 오류이고 **서버에 로그인 시도가
 *   도달하지 않아** 계정을 잠그지 않는다) · 파싱·예산 초과.
 * `test/sshAuthStop2541.test.js` 가 양성 12건·음성 11건을 전부 고정한다.
 * @param {...string} texts
 */
export function isAuthFailureText(...texts) {
  return texts.some((t) => /인증 실패|\b401\b|\b403\b|authentication (?:\w+\s+){0,3}fail|client-authentication|permission denied|invalid (?:user|password|credential)|auth(?:entication)? (?:rejected|denied)/i
    .test(String(t || '')));
}

/** 자격증명 지문 해시 — 바뀌면 자동 재개의 신호다(평문 미포함 — credFingerprint 규약). */
export function credHashOf(dev) {
  const p = credFingerprintParts(dev?.username, dev?.password);
  return `${p.user}:${p.len}:${p.hash}`;
}

/**
 * 도구 하나의 정지 저장소를 만든다.
 * @param {{file:string}} opts file — CONFIG_DIR 아래 파일명(도구마다 달라야 한다. 한 파일에
 *   섞으면 도구 A 의 id 와 도구 B 의 id 가 충돌해 엉뚱한 대상이 멈춘다)
 */
export function createAuthGuard({ file }) {
  if (!file) throw new Error('authGuard: file 이 필요합니다.');
  const FILE = () => path.join(config.configDir, file);

  /* 캐시 성격 — 손상되면 `preserveCorrupt` 하지 않고 새로 시작한다(재생성 가능한 상태이고,
     여기서 원본을 보존해 봐야 쓸모없는 파일만 쌓인다. util/activityLog.js 와 같은 취급). */
  let _mem = null;
  const load = () => {
    if (_mem) return _mem;
    try { _mem = JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {}; }
    catch { _mem = {}; }
    if (!_mem || typeof _mem !== 'object') _mem = {};
    return _mem;
  };
  const persist = () => {
    try { atomicWriteFileSync(FILE(), JSON.stringify(_mem || {}, null, 2), { mode: 0o600 }); }
    catch { /* 정지 상태를 못 써도 수집은 계속돼야 한다 */ }
  };

  return {
    /** 정지 기록. 같은 자격증명으로 반복 실패해도 `since` 는 **처음 시각**을 유지한다. */
    markAuthStopped(id, dev, reason) {
      const db = load();
      const credHash = credHashOf(dev);
      const prev = db[id];
      db[id] = {
        credHash,
        since: prev && prev.credHash === credHash ? prev.since : Date.now(),
        at: Date.now(),
        attempts: (prev && prev.credHash === credHash ? prev.attempts || 0 : 0) + 1,
        reason: String(reason || '인증 실패').slice(0, 200),
      };
      _mem = db; persist();
      return db[id];
    },
    /** 성공했거나 사용자가 해제 — 기록 제거. */
    clearAuthStop(id) {
      const db = load();
      if (!db[id]) return false;
      delete db[id];
      _mem = db; persist();
      return true;
    },
    /**
     * 주기 수집에서 이 대상을 건너뛸 것인가.
     * @returns {null | {since:number, at:number, attempts:number, reason:string}}
     */
    authStopFor(dev) {
      if (!dev?.id) return null;
      const rec = load()[dev.id];
      if (!rec) return null;
      // 자격증명이 바뀌었으면 자동 재개(규칙 2) — 기록을 지우고 이번 주기부터 다시 시도한다.
      if (rec.credHash !== credHashOf(dev)) { this.clearAuthStop(dev.id); return null; }
      return { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason };
    },
    /**
     * **읽기 전용** 조회(v2.590) — 다른 수집기가 '같은 계정이 이미 멈췄나' 를 볼 때 쓴다.
     * ⚠ `authStopFor` 와 달리 기록을 **지우지 않는다**. 호출자가 넘긴 자격증명이 기록과 다르면 null 을
     *   돌려줄 뿐이다 — 호출자 쪽 값이 조금 달라도(예: 앞뒤 공백을 다듬은 사본) 기록의 주인(주 폴러)의
     *   정지를 풀어 버리면 그 폴러가 다음 틱에 다시 로그인한다. 해제는 주인만 한다.
     */
    peekAuthStop(dev) {
      if (!dev?.id) return null;
      const rec = load()[dev.id];
      if (!rec || rec.credHash !== credHashOf(dev)) return null;
      return { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason };
    },
    _resetForTest() { _mem = null; try { fs.rmSync(FILE()); } catch { /* 없음 */ } },
    _fileForTest() { return FILE(); },
  };
}
