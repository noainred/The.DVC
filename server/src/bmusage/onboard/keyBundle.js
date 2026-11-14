/**
 * bmusage/onboard/keyBundle.js — SSH 키 저장소 파일(ssh-keys.json)의 **번들 가림 · 복원 병합**(순수 · 의존 없음 — 7b단계).
 *
 * 번들 = 백업 아카이브 · 엣지 설정 push(`backup/service.js putCollected` 한 곳을 둘 다 쓴다). 개인키 · passphrase · 비밀번호는 봉인돼 있어도
 * 번들에 싣지 않는다(엣지 push 는 법인 밖으로 나가고 백업은 다른 곳에 보관된다) — 지문 · 공개키 · 이름만 남는다.
 * 복원은 지금 파일의 같은 키(지문) · 같은 계정(id · 종류 · 법인 · 계정명)의 **저장된 값(봉인 그대로)** 을 옮겨 붙인다(복호 · 재봉인 없음).
 */
export const KEY_FILE_NAME = 'ssh-keys.json';
const lc = (v) => String(v ?? '').trim().toLowerCase();

export const REDACTED_SECRET = '__redacted__';
const BUNDLE_SECRET_FIELDS = ['privateKey', 'passphrase', 'password'];

/**
 * 번들에 싣는 ssh-keys.json 내용 — 개인키 · passphrase · 비밀번호를 표지로 바꾼다(지문 · 공개키 · 이름만 남는다).
 * 못 읽는 내용(손상)은 **아무것도 싣지 않는다**(빈 키 목록 + 표지) — 원문 조각이 번들로 새지 않게.
 * @returns {{text:string, redacted:number}}
 */
export function redactKeyStoreText(text) {
  let j;
  try { j = JSON.parse(String(text ?? '')); } catch { return { text: JSON.stringify({ keys: [], accounts: [], unreadable: true }), redacted: 1 }; }
  let n = 0;
  const strip = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => {
    const o = { ...x };
    for (const f of BUNDLE_SECRET_FIELDS) if (typeof o[f] === 'string' && o[f] !== '') { o[f] = REDACTED_SECRET; n += 1; }
    return o;
  });
  return { text: JSON.stringify({ keys: strip(j?.keys), accounts: strip(j?.accounts) }, null, 2), redacted: n };
}

/**
 * 복원 병합 — 번들의 가린 칸은 **지금 파일의 같은 키(지문) · 같은 계정(id)** 값으로 되살린다. 되살릴 수 없는 키는 빼고, 비밀번호를 되살릴 수 없는 계정은 비밀번호 없이 남긴다.
 * 7b 반증 F13(결정): 번들에는 개인키가 없으므로 복원이 키를 **다시 만들 수 없다** → 지금 파일에만 있는 키 · 계정(백업 뒤 등록분)은 **지우지 않고 그대로 둔다**(합집합).
 *   지우면 '복원 전' 자동 백업으로 되돌려도 개인키가 없어 영구 손실이다. 남긴 것은 kept 로 밝힌다(복원 결과 sshKeysKept).
 * @returns {{text:string, restored:number, dropped:string[], kept:string[]}}
 */
export function mergeRedactedKeyStore(bundleText, currentText) {
  let b; try { b = JSON.parse(String(bundleText ?? '')); } catch { return { text: String(currentText ?? ''), restored: 0, dropped: ['(번들 내용을 읽지 못해 지금 파일을 유지)'], kept: [] }; }
  let cur = { keys: [], accounts: [] };
  try { const c = JSON.parse(String(currentText ?? '')); cur = { keys: Array.isArray(c?.keys) ? c.keys : [], accounts: Array.isArray(c?.accounts) ? c.accounts : [] }; } catch { /* 지금 파일 없음 · 손상 */ }
  const curKeys = cur.keys.filter((k) => k && typeof k === 'object');
  const curAccs = cur.accounts.filter((a) => a && typeof a === 'object');
  const curKeyByFp = new Map(curKeys.map((k) => [String(k.fingerprint || ''), k]));
  const curAccById = new Map(curAccs.map((a) => [String(a.id || ''), a]));
  let restored = 0; const dropped = []; const kept = [];
  const keys = [];
  for (const k of (Array.isArray(b?.keys) ? b.keys : [])) {
    if (!k || typeof k !== 'object') continue;
    const o = { ...k };
    // v3.9.0(점검 A-3 · C-1): 지금 파일에 같은 키(지문)가 있으면 **폴더 · 허용 기능 · 상태(퇴역)** 는 지금 값을 쓴다 — 이 셋은 설정 소유자 + OTP 로만
    //   좁히는 값인데 복원 라우트는 OTP 를 묻지 않는다(server/CLAUDE.md v2.842 — OTP 로만 끄는 보안 설정을 복원이 되살리지 않는다).
    const cur0 = curKeyByFp.get(String(o.fingerprint || ''));
    if (cur0) for (const f of ['folderCorp', 'folderServer', 'features', 'status', 'retiredAt']) { if (cur0[f] === undefined) delete o[f]; else o[f] = cur0[f]; }
    if (o.privateKey === REDACTED_SECRET) {
      const c = curKeyByFp.get(String(o.fingerprint || ''));
      if (!c || typeof c.privateKey !== 'string' || !c.privateKey) { dropped.push(`key:${String(o.name || o.id || '').slice(0, 64)}`); continue; }
      o.privateKey = c.privateKey; o.passphrase = typeof c.passphrase === 'string' ? c.passphrase : ''; restored += 1;
    } else if (o.passphrase === REDACTED_SECRET) {
      const c = curKeyByFp.get(String(o.fingerprint || ''));
      o.passphrase = c && typeof c.passphrase === 'string' ? c.passphrase : '';
    }
    keys.push(o);
  }
  const fps = new Set(keys.map((k) => String(k.fingerprint || '')));
  const ids = new Set(keys.map((k) => String(k.id || '')));
  const names = new Set(keys.map((k) => lc(k.name)));
  for (const c of curKeys) {
    if (fps.has(String(c.fingerprint || ''))) continue;
    const o = { ...c };
    if (ids.has(String(o.id || ''))) o.id = `k_${String(o.id).replace(/^k_/, '').replace(/[^0-9a-f]/g, '0').padEnd(10, '0').slice(0, 10)}ff`;   // 다른 지문인데 id 가 같은 경우(무작위 48비트 — 사실상 없음)
    if (names.has(lc(o.name))) o.name = `${String(o.name).slice(0, 55)}-restored`;
    keys.push(o); kept.push(`key:${String(c.name || c.id || '').slice(0, 64)}`);
  }
  const accounts = [];
  for (const a of (Array.isArray(b?.accounts) ? b.accounts : [])) {
    if (!a || typeof a !== 'object') continue;
    const o = { ...a };
    if (o.password === REDACTED_SECRET) {
      const c = curAccById.get(String(o.id || ''));
      const same = c && String(c.kind || '') === String(o.kind || '') && lc(c.corp) === lc(o.corp) && lc(c.username) === lc(o.username);
      if (same && typeof c.password === 'string' && c.password) { o.password = c.password; restored += 1; } else { o.password = ''; dropped.push(`account:${String(o.name || o.id || '').slice(0, 64)}`); }
    }
    if (o.keyRef && !keys.some((k) => k.id === o.keyRef)) o.keyRef = '';
    accounts.push(o);
  }
  const accIds = new Set(accounts.map((a) => String(a.id || '')));
  const accNames = new Set(accounts.map((a) => `${a.kind}|${lc(a.name)}`));
  for (const c of curAccs) {
    if (accIds.has(String(c.id || ''))) continue;
    const o = { ...c };
    if (accNames.has(`${o.kind}|${lc(o.name)}`)) o.name = `${String(o.name).slice(0, 55)}-restored`;
    if (o.keyRef && !keys.some((k) => k.id === o.keyRef)) o.keyRef = '';
    accounts.push(o); kept.push(`account:${String(c.name || c.id || '').slice(0, 64)}`);
  }
  return { text: JSON.stringify({ keys, accounts }, null, 2), restored, dropped, kept };
}
