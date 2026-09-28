#!/usr/bin/env node
/**
 * scripts/code-audit-doc.mjs — 코드 감사 문서 생성기(v2.636).
 *
 * 원천은 `server/src/portalcheck/codeAudit.json` 하나다(화면 '포탈 점검 › 코드 감사' 가 같은 파일을 읽는다).
 * 이 스크립트는 그 JSON 을 `docs/<data.doc>`(예: AUDIT-2026-09-28.md) 로 **투사**한다 — 문서와 화면이 다른 말을 할 수 없다
 * (CLAUDE.md v2.563 '문서는 손으로 적는 목록을 두지 않는다' · v2.614 tools-catalog 와 같은 관례).
 *
 * 규약:
 *  · **못 읽은 것을 조용히 넘기지 않는다** — JSON 이 모양 검사(`validateCodeAudit`)를 통과하지 못하면 종료코드 1, 문서 미기록.
 *  · **내용이 같으면 파일을 다시 쓰지 않는다**. `--check` 는 파일을 쓰지 않고 다르면 종료코드 1(CI 용).
 *  · 마크다운 안의 코드 조각은 백틱으로 감싸지만, JSON 의 문장 필드(title·evidence·impact·fix·prior)에는 백틱이 없어야 한다
 *    (화면이 BoldText 로 그린다 — 검사기가 거부한다).
 *
 * 사용: node scripts/code-audit-doc.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MOD = path.join(ROOT, 'server/src/portalcheck/codeAudit.js');

const CAT_TITLE = { arch: '아키텍처 리뷰', bug: '버그', improve: '개선 포인트', tuning: '튜닝 가능한 포인트' };
const SEV = { high: 'high', medium: 'medium', low: 'low' };
const CONF = { confirmed: '재현·실행으로 확정', likely: '코드로 확인(재현 없음)', speculative: '추정' };
const STATUS = { open: '미조치', fixed: '고침' };

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** JSON → 마크다운(순수). 테스트가 이 함수로 생성물을 대조한다. */
export function renderDoc(data, { CATEGORIES }) {
  const L = [];
  const f = data.findings;
  const cnt = (c) => f.filter((x) => x.category === c).length;
  const sev = (s) => f.filter((x) => x.severity === s).length;
  const conf = (c) => f.filter((x) => x.confidence === c).length;
  L.push(`# 코드 감사 ${data.date} — 아키텍처 리뷰 · 버그 · 개선 포인트 · 튜닝 포인트 (v${data.version})`);
  L.push('');
  L.push(`> ⚠ 이 문서는 \`server/src/portalcheck/codeAudit.json\` 에서 \`scripts/code-audit-doc.mjs\` 가 **생성**한다 — 손으로 고치지 말 것(다음 생성에서 사라진다). 같은 JSON 을 운영 포탈의 **특수 기능 › 포탈 점검 › 코드 감사** 화면이 읽어 각 발견의 코드 조각(앵커)이 지금 소스에 아직 있는지 확인해 보여 준다.`);
  L.push('');
  L.push(`- 기준 커밋: \`${data.base}\` · 감사일: ${data.date} · 요청: ${esc(data.request || '')}`);
  L.push(`- 방법: ${esc(data.method || '')}`);
  if (data.notes) for (const n of data.notes) L.push(`- ${esc(n)}`);
  L.push('');
  L.push('## 요약');
  L.push('');
  L.push('| 분류 | 건수 | high | medium | low |');
  L.push('|---|---:|---:|---:|---:|');
  for (const c of CATEGORIES) {
    const rows = f.filter((x) => x.category === c);
    L.push(`| ${CAT_TITLE[c]} | ${rows.length} | ${rows.filter((x) => x.severity === 'high').length} | ${rows.filter((x) => x.severity === 'medium').length} | ${rows.filter((x) => x.severity === 'low').length} |`);
  }
  L.push(`| **합계** | **${f.length}** | ${sev('high')} | ${sev('medium')} | ${sev('low')} |`);
  L.push('');
  L.push(`신뢰도: 재현·실행으로 확정 **${conf('confirmed')}** · 코드로 확인 **${conf('likely')}** · 추정 **${conf('speculative')}**. 조치 상태: 미조치 ${f.filter((x) => (x.status || 'open') === 'open').length} · 고침 ${f.filter((x) => x.status === 'fixed').length}.`);
  L.push('');
  for (const c of CATEGORIES) {
    L.push(`## ${CAT_TITLE[c]} (${cnt(c)}건)`);
    L.push('');
    const rows = f.filter((x) => x.category === c).sort((a, b) => a.rank - b.rank);
    L.push('| # | id | 심각도 | 신뢰도 | 제목 | 위치 |');
    L.push('|---:|---|---|---|---|---|');
    for (const x of rows) L.push(`| ${x.rank} | ${x.id} | ${SEV[x.severity]} | ${CONF[x.confidence]} | ${esc(x.title)} | \`${x.file}:${x.line}\` |`);
    L.push('');
    for (const x of rows) {
      const st = (x.status || 'open');
      L.push(`### ${x.id} — ${esc(x.title)}`);
      L.push('');
      L.push(`- 심각도 **${SEV[x.severity]}** · 신뢰도 **${CONF[x.confidence]}** · 상태 ${STATUS[st]}${st === 'fixed' && x.fixedIn ? `(v${esc(x.fixedIn)})` : ''}`);
      L.push(`- 위치: \`${x.file}:${x.line}\` — 앵커 \`${String(x.anchor).replace(/`/g, "'")}\`${Array.isArray(x.also) && x.also.length ? ` · 함께: ${x.also.map((a) => `\`${a}\``).join(', ')}` : ''}`);
      L.push(`- 근거: ${x.evidence}`);
      L.push(`- 영향: ${x.impact}`);
      if (x.repro) { L.push('- 재현:'); L.push('  ```'); for (const ln of String(x.repro).split('\n')) L.push(`  ${ln}`); L.push('  ```'); }
      L.push(`- 제안: ${x.fix}`);
      if (x.prior) L.push(`- 참조: ${x.prior}`);
      L.push('');
    }
  }
  return `${L.join('\n').replace(/\n+$/, '')}\n`;
}

export async function generate({ check = false } = {}) {
  const mod = await import(pathToFileURL(MOD).href);
  const loaded = mod.loadCodeAudit();
  if (!loaded.ok) {
    console.error(`code-audit-doc: codeAudit.json 이 모양 검사를 통과하지 못했습니다 — 문서를 쓰지 않습니다\n  ${loaded.errors.join('\n  ')}`);
    return 1;
  }
  const data = loaded.data;
  const out = path.join(ROOT, 'docs', String(data.doc));
  const next = renderDoc(data, { CATEGORIES: mod.CATEGORIES });
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (cur === next) { if (!check) console.log(`code-audit-doc: 변경 없음 (${path.relative(ROOT, out)})`); return 0; }
  if (check) { console.error(`code-audit-doc: ${path.relative(ROOT, out)} 이 낡았습니다 — 'node scripts/code-audit-doc.mjs' 를 실행하세요`); return 1; }
  fs.writeFileSync(out, next);
  console.log(`code-audit-doc: ${path.relative(ROOT, out)} 갱신(${data.findings.length}건)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await generate({ check: process.argv.includes('--check') });
}
