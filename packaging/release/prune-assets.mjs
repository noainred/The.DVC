/**
 * 릴리스 자산 prune — 롤링 'downloads' 릴리스는 자산 1000개 상한이 있어, 버전이 쌓이면
 * 새 업로드가 422(file_count limited to 1000)로 거부된다. 이 스크립트는 현재 릴리스의
 * 자산 이름 목록(stdin, 줄바꿈 구분)을 받아 '유지할 버전'의 자산만 남기고 나머지
 * '오래된 버전 자산' 이름을 stdout으로 출력한다(삭제 대상). 버전이 없는 자산(versions.json 등)은
 * 항상 유지한다.
 *
 * 인자(둘 중 하나):
 *   - <versions.json 경로> : 그 파일의 versions[].version 목록에 있는 버전만 유지(권장).
 *       → versions.json이 참조하는 버전과 릴리스 자산을 '정확히' 일치시켜, semver/게시순서
 *         차이로 versions.json이 가리키는 자산이 삭제되거나 고아 자산이 남는 문제를 없앤다.
 *   - <N>(숫자) : semver 상위 N개 버전만 유지(파일 없을 때의 폴백).
 *
 *   gh release view downloads --json assets -q '.assets[].name' | node prune-assets.mjs dist-offline/versions.json
 */

import fs from 'node:fs';

const arg = process.argv[2] || '15';

// 유지할 버전 집합을 결정한다. versions.json 경로면 그 목록, 숫자면 나중에 semver top-N.
let keepVersions = null; // Set<string> | null(=semver top-N 모드)
let keepN = 15;
if (/^\d+$/.test(arg)) {
  keepN = Math.max(1, Number(arg));
} else {
  try {
    const doc = JSON.parse(fs.readFileSync(arg, 'utf8'));
    const vs = Array.isArray(doc?.versions) ? doc.versions.map((v) => v && v.version).filter(Boolean) : [];
    if (vs.length) keepVersions = new Set(vs);
  } catch (e) {
    process.stderr.write(`[prune] versions.json(${arg}) 읽기 실패 → semver top-${keepN} 폴백: ${e.message}\n`);
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const names = input.split('\n').map((s) => s.trim()).filter(Boolean);
  const verRe = /(\d+)\.(\d+)\.(\d+)/;
  const byVersion = new Map(); // "x.y.z" -> [assetName...]
  for (const name of names) {
    const m = name.match(verRe);
    if (!m) continue; // 버전 없는 자산(versions.json 등) → 유지
    const v = `${m[1]}.${m[2]}.${m[3]}`;
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(name);
  }

  let dropVersions;
  if (keepVersions) {
    // versions.json 목록에 없는 버전은 모두 삭제 대상.
    dropVersions = [...byVersion.keys()].filter((v) => !keepVersions.has(v));
  } else {
    const cmp = (a, b) => {
      const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pb[i] - pa[i]; }
      return 0;
    };
    const versions = [...byVersion.keys()].sort(cmp); // 최신 → 오래된
    dropVersions = versions.slice(keepN);
  }

  const toDelete = [];
  for (const v of dropVersions) toDelete.push(...byVersion.get(v));
  process.stdout.write(toDelete.join('\n') + (toDelete.length ? '\n' : ''));
  const mode = keepVersions ? `versions.json 목록(${keepVersions.size}개 버전)` : `semver top-${keepN}`;
  process.stderr.write(`[prune] 유지 기준=${mode}, 삭제 대상 ${dropVersions.length}개 버전(${toDelete.length} 자산)\n`);
});
