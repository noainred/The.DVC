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
 * 합치기에서 빠진 항목(mergeRedactedKeyStore 의 dropped) → 사람이 읽을 문구. **복원 즉시 · 예약 적용 두 경로가 같은 함수**(5회차 반증 R5R-6 —
 * 예약 적용은 수만 세고 어디에도 보이지 않았다 · 괄호 사유가 account-key 항목과 맞지 않았다). 앞에 'ssh-keys.json:' 이 붙어 있어도 된다.
 * 이름은 키 · 공통 계정 이름뿐(비밀 없음 — 백업 화면은 설정 소유자 등급).
 */
export function keyStoreDropNotes(dropped = []) {
  const list = (Array.isArray(dropped) ? dropped : []).map((d) => String(d).replace(/^ssh-keys\.json:/, ''));
  const by = (p) => list.filter((d) => d.startsWith(p));
  const ids = by('key-id:'); const keys = by('key:'); const accs = by('account:'); const accKeys = by('account-key:');
  const notes = list.filter((d) => d.startsWith('('));
  const other = list.length - ids.length - keys.length - accs.length - accKeys.length - notes.length;
  const names = (arr) => `${arr.slice(0, 5).map((d) => d.slice(d.indexOf(':') + 1) || '이름 없음').join(', ')}${arr.length > 5 ? ` 외 ${arr.length - 5}개` : ''}`;
  const out = [];
  if (ids.length) out.push(`SSH 키 ${ids.length}개(${names(ids)})는 지금 승인 대기 중이라 지금 id 를 지켰습니다 — 백업에서 그 키를 쓰던 서버는 승인 뒤 설정 › 보안 › SSH 공용 접속의 ‘키 고르기’ 로 다시 묶으세요.`);
  if (keys.length) out.push(`개인키가 번들에 없어 되살리지 못한 SSH 키 ${keys.length}개(${names(keys)}).`);
  if (accs.length) out.push(`비밀번호를 되살리지 못한 공통 계정 ${accs.length}개(${names(accs)}) — 비밀번호는 번들에 없어 비운 채로 두었습니다.`);
  if (accKeys.length) out.push(`가리키던 기본 키가 없어 기본 키를 뗀 공통 계정 ${accKeys.length}개(${names(accKeys)}).`);
  for (const n of notes.slice(0, 3)) out.push(`SSH 키 저장소: ${n.replace(/^\(|\)$/g, '')}.`);
  if (other > 0) out.push(`SSH 키 저장소의 다른 항목 ${other}개를 되살리지 못했습니다.`);
  return out;
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
  const curById = new Map(curKeys.map((k) => [String(k.id || ''), k]));
  let restored = 0; const dropped = []; const kept = [];
  const keys = []; const idRemap = new Map();
  for (const k of (Array.isArray(b?.keys) ? b.keys : [])) {
    if (!k || typeof k !== 'object') continue;
    const o = { ...k };
    // v3.9.0(점검 A-3 · C-1): 지금 파일에 같은 키(지문)가 있으면 **폴더 · 허용 기능 · 상태(퇴역)** 는 지금 값을 쓴다 — 이 셋은 설정 소유자 + OTP 로만
    //   좁히는 값인데 복원 라우트는 OTP 를 묻지 않는다(server/CLAUDE.md v2.842 — OTP 로만 끄는 보안 설정을 복원이 되살리지 않는다).
    const cur0 = curKeyByFp.get(String(o.fingerprint || ''));
    if (cur0) for (const f of ['folderCorp', 'folderServer', 'features', 'status', 'retiredAt']) { if (cur0[f] === undefined) delete o[f]; else o[f] = cur0[f]; }
    // v3.10.0(테스트 ⑥-c): **개인키 · passphrase 는 번들에서 받지 않는다** — 정상 번들은 가린다(redactKeyStoreText). 지금 파일의 같은 지문 키 것을 쓰고,
    //   지금 파일에 없는 키는 뺀다. 가리지 않은 개인키가 실린 번들(손으로 만든 번들)을 복원하면 OTP · 두 사람 승인 없이 활성 로그인 키가 들어갔고,
    //   같은 지문에 다른 원문을 실으면 원문만 바꿔치기할 수 있었다.
    if (!cur0 || typeof cur0.privateKey !== 'string' || !cur0.privateKey) { dropped.push(`key:${String(o.name || o.id || '').slice(0, 64)}`); continue; }
    o.privateKey = cur0.privateKey; o.passphrase = typeof cur0.passphrase === 'string' ? cur0.passphrase : '';
    // v3.10.0(점검 A3): 공개키 · 알고리즘 칸도 지금 파일의 것 — 같은 지문에 남의 공개키를 실은 번들이 ‘공개키 복사’ · authorized_keys 줄에 남의 키를 싣지 못하게.
    // 공개키 · 알고리즘 · 이름은 지금 것(점검 A3 · 1회차 A6 — 이름은 CSV os_key 가 고르는 열쇠라 복원(OTP 없음)이 그 뜻을 바꿨다).
    for (const f of ['publicKey', 'algo', 'sshType', 'bits', 'name']) { if (cur0[f] === undefined) delete o[f]; else o[f] = cur0[f]; }
    // 키 id: 번들의 id 가 **지금 다른 지문의 키** 것이면 지금 이 지문의 id 를 쓴다(반증 R7 — 두 키의 id 를 맞바꾸면 keyRef 로 묶인 서버가 다른 키를 썼다).
    //   그 밖에는 번들 id 그대로 — 같은 키를 새 id 로 다시 등록한 설치에 옛 백업을 복원해도 번들 안의 참조(공통 계정 · 서버)가 이어진다(1회차 D2 — 항상 지금 id 로 바꾸자 참조가 조용히 끊겼다).
    { const owner = curById.get(String(o.id || '')); if (owner && String(owner.fingerprint || '') !== String(o.fingerprint || '')) o.id = cur0.id; }
    // 승인 대기 키는 지금 id 를 지킨다 — 열린 등록 요청이 그 id 를 가리킨다(4회차 D4-1 — 번들 id 로 바꾸자 요청이 키를 잃었고, 지문으로 대신 찾는 길이 다른 범위의 대기 키를 집었다).
    if (cur0 && cur0.status === 'pending' && cur0.id) {
      // 번들 안의 옛 id 참조(공통 계정 기본 키)는 지금 id 로 옮기고, 바뀐 사실을 결과에 밝힌다(4회차 반증 R4R-4 — 서버의 키 참조는 bm-storage 복원본에 옛 id 로 남는다: 승인 뒤 키 고르기로 다시 묶는다).
      if (String(o.id || '') && String(o.id) !== String(cur0.id)) { idRemap.set(String(o.id), String(cur0.id)); dropped.push(`key-id:${String(cur0.name || cur0.id).slice(0, 64)}`); }
      o.id = cur0.id;
    }
    restored += 1;
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
    // v3.10.0(점검 A4): 비밀번호는 가렸든(정상 번들) 아니든(손으로 만든 번들) **번들에서 받지 않는다** — 같은 계정(종류 · 법인 · 계정명)의 지금 값만 쓴다.
    //   복원 라우트는 OTP 를 묻지 않으므로 번들의 평문 비밀번호로 공통 계정의 비밀을 바꿀 수 있었다.
    if ((typeof o.password === 'string' && o.password) || o.password === REDACTED_SECRET) {
      const c = curAccById.get(String(o.id || ''));
      const same = c && String(c.kind || '') === String(o.kind || '') && lc(c.corp) === lc(o.corp) && lc(c.username) === lc(o.username);
      if (same && typeof c.password === 'string' && c.password) { o.password = c.password; restored += 1; } else { o.password = ''; dropped.push(`account:${String(o.name || o.id || '').slice(0, 64)}`); }
    }
    if (o.keyRef && idRemap.has(String(o.keyRef))) o.keyRef = idRemap.get(String(o.keyRef));   // 승인 대기 키의 지금 id 로(R4R-4)
    // 번들의 기본 키가 합친 키에 없으면 떼고 그 사실을 밝힌다(1회차 D2 — 조용히 비웠다).
    if (o.keyRef && !keys.some((k) => k.id === o.keyRef)) { dropped.push(`account-key:${String(o.name || o.id || '').slice(0, 64)}`); o.keyRef = ''; }
    accounts.push(o);
  }
  const accIds = new Set(accounts.map((a) => String(a.id || '')));
  const accNames = new Set(accounts.map((a) => `${a.kind}|${lc(a.name)}`));
  for (const c of curAccs) {
    if (accIds.has(String(c.id || ''))) continue;
    const o = { ...c };
    if (accNames.has(`${o.kind}|${lc(o.name)}`)) o.name = `${String(o.name).slice(0, 55)}-restored`;
    // 지금 파일에만 있는 계정의 기본 키: 합친 키에 같은 id 가 없으면 **같은 지문의 키**(번들 id 로 되살아난 같은 키)로 옮기고,
    //   그것도 없을 때만 떼고 밝힌다(2회차 D2-4 — 조용히 비웠다).
    if (o.keyRef && !keys.some((k) => k.id === o.keyRef)) {
      const fp = String(curById.get(String(o.keyRef))?.fingerprint || '');
      const same = fp ? keys.find((k) => String(k.fingerprint || '') === fp) : null;
      if (same) o.keyRef = same.id;
      else { dropped.push(`account-key:${String(o.name || o.id || '').slice(0, 64)}`); o.keyRef = ''; }
    }
    accounts.push(o); kept.push(`account:${String(c.name || c.id || '').slice(0, 64)}`);
  }
  return { text: JSON.stringify({ keys, accounts }, null, 2), restored, dropped, kept };
}
