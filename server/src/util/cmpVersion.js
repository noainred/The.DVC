/**
 * semver 형태 버전 비교 — **단일 소스**(v2.575 IMP-04).
 *
 * v2.574 까지 같은 이름의 함수가 **3벌**이었고 **동작이 달랐다**:
 *  - `portalcheck/tokenScan.js` — `v` 접두를 벗기지 않고, 세그먼트 수 제한이 없으며 -1/0/1 반환
 *  - `routes/api/partFaults.js` / `routes/api/edgeLog.js` — `v` 접두를 벗기고 **3세그먼트 필수**,
 *    차이값(정수)을 그대로 반환
 * 그래서 같은 입력이 한쪽에서는 `null`(= 화면 '버전 미상'), 다른 쪽에서는 숫자(= '구버전')가 됐다.
 * CLAUDE.md 는 이 둘을 **반드시 구분하라**고 못 박고 있다(조치가 다르다 — '업그레이드하세요' vs
 * '버전을 확인할 수 없습니다'). 운영 값이 항상 `x.y.z` 라 오늘 눈에 띄지 않았을 뿐이다.
 *
 * 통일한 규칙(더 관용적인 쪽 + 모르는 것은 null):
 *  - 선행 `v`/공백을 벗긴다(`v2.5.0` == `2.5.0`).
 *  - 세그먼트가 **전부 숫자**여야 한다. 하나라도 아니면 `null` — `''`·`dev`·`2.x` 는 **모르는 것**이고,
 *    **낮은 버전으로 보지 않는다**.
 *  - 세그먼트 수는 제한하지 않고 짧은 쪽을 0 으로 채운다(`2.5` == `2.5.0`). 3세그먼트 강제는
 *    파싱 가능한 값을 '미상' 으로 만들어 관리자에게 **엉뚱한 안내**를 하게 한다.
 *  - 반환은 **부호만 의미 있는 -1/0/1**(호출부는 전부 `<0`·`>0`·`!=null` 만 본다).
 */
export function cmpVersion(a, b) {
  const parse = (v) => {
    const s = String(v ?? '').trim().replace(/^v/i, '');
    if (!s) return null;
    const parts = s.split('.').map((x) => Number(x));
    if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
    return parts;
  };
  const pa = parse(a); const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export default cmpVersion;
