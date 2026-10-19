/**
 * pdu/parse.js — APC Rack PDU 2G(rpdu2g) CLI 출력 파서 — **순수 함수**(테스트 대상).
 *
 * 실장비(AP8853 + NMC AP9538, AOS 6.8.2 / rpdu2g 6.8.0) 출력으로 확인한 규약:
 *
 *   apc>tempReading 1:C
 *   E000: Success
 *   22.9 C
 *
 *   apc>humReading
 *   E000: Success
 *   34 %RH
 *
 *   apc>devReading 1:power
 *   E000: Success
 *   1.98 kW
 *
 *   apc>tempReading 2:C
 *   E102: Parameter Error          ← 그 인덱스에 센서/장비가 **없음**
 *
 * ⚠ 명령마다 인자 문법이 다르다(실측):
 *   - tempReading <id>:<F|C>   — id·단위 모두 필수
 *   - humReading  [<id>:]      — 단위를 붙이면 E102. 콜론만 붙이거나 인자 없이.
 *   - devReading  <id>:<power|energy|appower|pf>
 *
 * 설계 원칙(이 저장소 규약):
 *   - `E1xx` 는 **오류가 아니라 '해당 없음'** 으로 다룬다(센서 미장착 PDU가 정상 등록되게).
 *     값은 null 로 두고, 0 으로 채우지 않는다(0 은 '측정값 0'과 구분되지 않는다).
 *   - 단위를 값에 녹이지 않고 그대로 돌려준다 — 화면/DB 에서 환산 규칙을 한 곳에 둔다.
 */

/* 줄 끝 문자(\n·\r·U+2028·U+2029) — 정규식의 '.' 이 맞추지 않는 글자. 줄은 \r?\n 으로 나눴지만 외로운 \r·U+2028 은 남을 수 있다. */
const LINE_TERM = /[\n\r\u2028\u2029]/;

/*
 * v2.744(회귀 검토 GH-R2): '접두 + 공백 + 값' 꼴 정규식(`…\s*(.*)$`)은 값 앞 공백 뒤에 외로운 \r·U+2028 이 오면
 *   (공백 길이 × 줄 길이)로 역추적했다 — 3만 자 공백 줄 하나에 parseCode·parseReading 이 각각 약 1.4초 멈췄다
 *   (svcDiag.js INJPKG-02 와 같은 꼴의 형제 누락). 접두만 정규식으로 맞추고(한 가지로만 맞는 접두) 값은 선형으로 고른다.
 *   규칙: 값 = ':'(또는 숫자) 뒤 앞 공백을 뺀 나머지 · 그 안에 줄 끝 문자가 있으면 맞지 않는다('.' 이 건너지 못한다).
 *   예전 정규식과 결과가 같다(test/audit2744rg.test.js 가 무작위 입력으로 대조한다) — 정규식으로 되돌리지 말 것.
 */

/**
 * (순수) `E000: Success` 줄 — 예전 `/^\s*E(\d{3})\s*:\s*(.*)$/` 와 같은 판정.
 * @returns {[string, string, string]|null} [줄, 코드 숫자 3자리, 메시지(앞 공백 제거)]
 */
export function codeLine(line) {
  const s = String(line);
  const h = /^\s*E(\d{3})\s*:/.exec(s);
  if (!h) return null;
  const v = s.slice(h[0].length).trimStart();
  return LINE_TERM.test(v) ? null : [s, h[1], v];
}

/**
 * (순수) `22.9 C` 값 줄 — 예전 `/^(-?\d+(?:\.\d+)?)\s*(.*)$/` 와 같은 판정.
 * 숫자 접두는 가장 긴 것을 쓴다 — 짧게 끊어도 꼬리(나머지 숫자 + 원래 꼬리)의 줄 끝 문자는 그대로라 결과가 같다.
 * @returns {[string, string, string]|null} [줄, 숫자, 단위(앞 공백 제거)]
 */
export function readingLine(line) {
  const s = String(line);
  const h = /^(-?\d+(?:\.\d+)?)/.exec(s);
  if (!h) return null;
  const v = s.slice(h[0].length).trimStart();
  return LINE_TERM.test(v) ? null : [s, h[1], v];
}

/** 응답 코드 줄 파싱. `E000: Success` → { code:'E000', ok:true } */
export function parseCode(text) {
  // v2.602(SEC2602-02): 예전 `/^\s*E…$/m` 는 m 플래그에서 `\s*` 가 줄을 넘어가 빈 줄이 이어지면 O(n²) 였다
  //   (빈 줄 8만 개 ≈ 5.8초 — 장비 출력도 외부 입력이다). 줄로 먼저 나누고 각 줄을 한 번씩 본다(선형).
  let m = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    m = codeLine(line);                     // v2.744(회귀 검토 GH-R2): 선형 판정
    if (m) break;
  }
  if (!m) return { code: '', ok: false, message: '' };
  return { code: `E${m[1]}`, ok: m[1] === '000', message: (m[2] || '').trim() };
}

/**
 * `E000: Success` 다음의 **첫 유효 값 줄**에서 숫자와 단위를 뽑는다.
 * @returns {{ value:number|null, unit:string, code:string, ok:boolean }}
 *   실패(E1xx·값 없음)면 value=null — 호출부가 '해당 없음'으로 저장한다.
 */
export function parseReading(text) {
  const st = parseCode(text);
  if (!st.ok) return { value: null, unit: '', code: st.code, ok: false };
  const lines = String(text || '').split(/\r?\n/);
  const codeIdx = lines.findIndex((l) => /^\s*E\d{3}\s*:/.test(l));
  for (let i = codeIdx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^apc>/i.test(l)) break;             // 다음 프롬프트 — 값 줄이 없었다
    // 예: '22.9 C' · '34 %RH' · '1.98 kW' · '2.32' · '-1.5 C'
    const m = readingLine(l);               // v2.744(회귀 검토 GH-R2): 선형 판정
    if (!m) continue;
    const v = Number(m[1]);
    if (!Number.isFinite(v)) continue;
    return { value: v, unit: (m[2] || '').trim(), code: st.code, ok: true };
  }
  return { value: null, unit: '', code: st.code, ok: false };
}

/** 섭씨로 정규화. 장비가 F 로 답해도 DB 에는 항상 ℃ 로 저장한다(단위 혼재 방지). */
export function toCelsius(value, unit) {
  if (value == null) return null;
  return /f/i.test(String(unit || '')) ? Math.round(((value - 32) * 5 / 9) * 10) / 10 : value;
}

/**
 * 전력 값을 **W(와트)** 로 정규화. 장비는 kW 로 답한다(실측 '1.98 kW').
 * energy 는 kWh 누적값이라 별도 취급(정규화하지 않고 kWh 유지).
 */
export function toWatts(value, unit) {
  if (value == null) return null;
  const u = String(unit || '').trim().toLowerCase();
  // v2.612(COL2612-07): VA 는 W 와 같은 배율이다 — 예전엔 'kw'·'w' 로 시작하지 않으면 전부 kW 로 봐 1980 VA 가 1,980,000 이 됐다.
  if (u.startsWith('kw') || u.startsWith('kva')) return Math.round(value * 1000);
  if (u.startsWith('w') || u.startsWith('va')) return Math.round(value);
  if (!u) return Math.round(value * 1000); // 단위 미표기는 장비 기본(kW)으로 본다
  return null; // 모르는 단위 — 배율을 지어내지 않는다
}

/**
 * 명령 문자열 빌더 — 문법이 명령마다 달라 한 곳에 모아 둔다(위 주석의 실측 규약).
 * id 는 정수로 강제해 CLI 인젝션 여지를 없앤다(문자열 보간 지점이므로 필수).
 */
export const cmd = {
  temp: (id) => `tempReading ${int(id)}:C`,
  hum: (id) => `humReading ${int(id)}:`,
  dev: (id, what) => `devReading ${int(id)}:${devMetric(what)}`,
  phase: (id, what) => `phReading ${int(id)}:${phMetric(what)}`,
  bank: (id, what) => `bkReading ${int(id)}:${phMetric(what)}`,
  sensorName: (id) => `sensorName ${int(id)}:`,
  about: () => 'about',
};

function int(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 64) throw new Error(`PDU 인덱스가 올바르지 않습니다: ${v}`);
  return n;
}
const DEV_METRICS = ['power', 'energy', 'appower', 'pf'];
const PH_METRICS = ['current', 'voltage', 'power'];
function devMetric(w) {
  const s = String(w || '').toLowerCase();
  if (!DEV_METRICS.includes(s)) throw new Error(`지원하지 않는 devReading 항목: ${w}`);
  return s;
}
function phMetric(w) {
  const s = String(w || '').toLowerCase();
  if (!PH_METRICS.includes(s)) throw new Error(`지원하지 않는 phReading/bkReading 항목: ${w}`);
  return s;
}

/** `about` 출력에서 모델/시리얼을 뽑는다(등록 화면 표시·식별용). 실패해도 수집은 계속한다. */
export function parseAbout(text) {
  // v2.598 INJ-01: about 출력은 실장비에서 수 KB 다 — 64KB 로 자른다(비정상 출력이 루프를 붙잡지 않게).
  const s = String(text || '').slice(0, 65_536);
  const grab = (label) => {
    const m = new RegExp(`${label}\\s*:\\s*(.+)`, 'i').exec(s);
    return m ? m[1].trim() : '';
  };
  // 'Model Number:' 가 본체·NMC 두 번 나온다 — 첫 번째(Hardware Factory)가 PDU 본체.
  const models = [...s.matchAll(/Model Number\s*:\s*(.+)/gi)].map((m) => m[1].trim());
  const serials = [...s.matchAll(/Serial Number\s*:\s*(.+)/gi)].map((m) => m[1].trim());
  return {
    model: models[0] || '',
    serial: serials[0] || '',
    nmcModel: models[1] || '',
    // ⚠ v2.598 INJ-01: 사이 구간을 **유한하게** 묶는다. 무제한 `[\s\S]*?` 는 'aos' 가 나올 때마다 끝까지 훑어
    //   'Version' 이 없는 긴 출력에서 O(n²) 였다(실측 440KB → 2.9초 루프 정지). 실장비의 about 출력은
    //   'Name: aos' 바로 다음 줄이 'Version:' 이라 400자면 충분하다.
    aosVersion: /aos[\s\S]{0,400}?Version\s*:\s*(\S+)/i.exec(s)?.[1] || '',
    appVersion: /rpdu2g[\s\S]{0,400}?Version\s*:\s*(\S+)/i.exec(s)?.[1] || grab('Version'),
  };
}
