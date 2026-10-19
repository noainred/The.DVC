/**
 * v2.744 최종 검토 FA(웹) — FC HBA 문구가 서버의 최종 대표값·알림 판정과 같은 말을 하는가.
 *
 *  RV-2  detailNotes 의 명목 초과 문구가 고정 문장('서버 대표 HBA 사용률은 나머지 포트 기준이고 임계 알림은 초과로 보지 않습니다')이라
 *        같은 서버에 데이터율을 크게 넘은 포트가 있으면 바로 위 줄('대표값을 비웠습니다 — 임계 알림은 초과로 봅니다')과 모순됐다.
 *        서버 parse/fcRate.js fcNominalRestKind 와 같은 규칙으로 고르게 했고, 같은 입력으로 대조한다(번들 경계라 두 벌).
 *  RV-1  각주(hbaBasisFootnote — 화면에 실제로 보이는 경로)가 서버마다 기록된 최종 대표값(rep)·출처(src)를 반영한다.
 */
import { describe, it, expect } from 'vitest';
import * as text from './bmUsageText.js';
import { fcUtilization, fcRowPctFields, fcRepresentative, fcNominalRestKind as serverKind } from '../../../../server/src/bmusage/parse/fcRate.js';
import { buildUsage } from '../../../../server/src/bmusage/usage.js';

/** 서버와 같은 함수로 FC 행을 만든다(방향당 B/s · 속도 bit/s). */
const fcRow = (host, bps, bits) => ({ host, bps, ...fcRowPctFields(fcUtilization(bps, bits)) });
const KIND = {
  nom104: [1.3e9, 10e9], nom50: [0.625e9, 10e9], dr30: [0.48e9, 16e9], dr105: [1.68e9, 16e9], dr156: [2.5e9, 16e9], nospeed: [1e8, null],
};
const rowsOf = (ks, p = 'h') => ks.map((k, i) => fcRow(`${p}${i}`, ...KIND[k]));
const nominalLine = (notes) => notes.find((x) => x.includes('명목 속도(Gbit)를 넘는'));

describe('RV-2 detailNotes — 명목 초과 문구가 같은 서버의 다른 줄과 모순되지 않는다', () => {
  it('데이터율을 크게 넘은 포트가 같은 서버에 있으면 \'나머지 포트 기준 · 알림 초과 아님\' 이라 말하지 않는다', () => {
    const notes = text.detailNotes({ fc: rowsOf(['nom104', 'dr156']) });
    expect(notes.some((x) => x.includes('크게 나온 포트 1개') && x.includes('초과로 봅니다'))).toBe(true);
    const t = nominalLine(notes);
    expect(t).toBeTruthy();
    expect(t).not.toContain('나머지 포트 기준');
    expect(t).not.toContain('초과로 보지 않습니다');
    expect(t).toContain('다른 포트 때문에 비웠습니다');
  });

  it('나머지 포트 값이 대표면 예전 문구 · 값이 없으면 판정 보류 · iDRAC 이 정했으면 iDRAC', () => {
    expect(nominalLine(text.detailNotes({ fc: rowsOf(['nom104', 'dr30']) }))).toContain('나머지 포트 기준이고 임계 알림은 초과로 보지 않습니다');
    const hold = nominalLine(text.detailNotes({ fc: rowsOf(['nom104']) }));
    expect(hold).toContain('판정 보류');
    expect(hold).not.toContain('나머지 포트 기준');
    const fbv = nominalLine(text.detailNotes({ fc: rowsOf(['nom104']), idracFc: rowsOf(['dr30'], 'F') }));
    expect(fbv).toContain('iDRAC 측정으로 정했습니다');
    const fbo = nominalLine(text.detailNotes({ fc: rowsOf(['nom104']), idracFc: rowsOf(['dr156'], 'F') }));
    expect(fbo).toContain('iDRAC 측정에서 데이터율을 크게 넘은 포트 때문에 비웠습니다');
    expect(fbo).not.toContain('초과로 보지 않습니다');
  });

  it('fcNominalRestKind 는 서버 parse/fcRate.js 와 같은 판정이다(같은 입력 전수 대조)', () => {
    expect(typeof text.fcNominalRestKind).toBe('function');
    const kinds = Object.keys(KIND);
    const lists = [[]];
    for (const a of kinds) { lists.push([a]); for (const b of kinds) lists.push([a, b]); }
    let n = 0;
    for (const osK of lists) {
      for (const idK of lists) {
        const os = rowsOf(osK); const id = rowsOf(idK, 'F');
        const fallback = id.length ? fcRepresentative(id) : null;
        expect(text.fcNominalRestKind(os, id), `${osK}|${idK}`).toBe(serverKind(os, { fallback }));
        n += 1;
      }
    }
    expect(n).toBe(lists.length * lists.length);
  });

  it('서버 buildUsage 결과를 그대로 넣어도 서버가 고른 분기와 같고 최종 값과 모순되지 않는다', () => {
    const T0 = 1_700_000_000_000; const NOW = T0 + 300_000;
    const hbaRow = (host, k, tx) => ({ host, state: 'Online', speedRaw: KIND[k][1] ? `${KIND[k][1] / 1e9} Gbit` : 'unknown', bitsPerSec: KIND[k][1], txBytes: tx, rxBytes: 0 });
    const cycle = (osK, idK) => buildUsage({
      target: { key: 'K', name: 's', vcenterId: 'vc' }, now: NOW, intervalMs: 300_000,
      prev: { at: T0, counters: osK.length ? { hbas: osK.map((k, i) => hbaRow(`host${i}`, k, 0)) } : null,
        idrac: idK.length ? { nics: [], fcs: idK.map((k, i) => ({ host: `F${i}`, bitsPerSec: KIND[k][1], rxBytes: 0, txBytes: 0, at: T0 })) } : null },
      os: osK.length ? { ok: true, osKind: 'linux', at: NOW, mem: { usedPct: 1 }, mounts: [], read: [], missing: [], absent: [], counters: { hbas: osK.map((k, i) => hbaRow(`host${i}`, k, KIND[k][0] * 300)) } } : null,
      idrac: idK.length ? { ok: true, at: NOW, nics: [], fcs: idK.map((k, i) => ({ host: `F${i}`, bitsPerSec: KIND[k][1], rxBytes: 0, txBytes: KIND[k][0] * 300, at: NOW })) } : null,
    });
    const kinds = Object.keys(KIND);
    let checked = 0;
    for (const a of kinds) for (const b of [null, ...kinds]) for (const c of [[], ...kinds.map((k) => [k])]) {
      const osK = b ? [a, b] : [a];
      const r = cycle(osK, c);
      const notes = text.detailNotes(r.detail).filter((x) => x.includes('HBA') || x.includes('FC'));
      const fallback = r.detail.hbaRepSrc === 'idrac' ? fcRepresentative(r.detail.idracFc) : null;
      expect(text.fcNominalRestKind(r.detail.fc, r.detail.idracFc)).toBe(serverKind(r.detail.fc, { fallback }));
      const tag = `${osK}|${c} ${JSON.stringify({ p: r.row.hba_pct, o: r.row.hba_over })}\n${notes.join('\n')}`;
      if (r.row.hba_over === true) expect(notes.some((x) => x.includes('초과로 보지 않습니다')), tag).toBe(false);
      if (r.row.hba_pct != null) expect(notes.some((x) => /서버 대표 HBA 사용률(은|을)[^.]*비웠/.test(x) || x.includes('판정 보류')), tag).toBe(false);
      if (r.row.hba_pct == null && r.row.hba_over !== true) expect(notes.some((x) => x.includes('초과로 봅니다')), tag).toBe(false);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe('RV-1 hbaBasisFootnote — 서버마다 기록된 최종 대표값(rep)·출처(src)로 말한다', () => {
  const base = { ports: 2, dataRate: 1, nominal: 1, noSpeed: 0, clamped: 0, blanked: 0, nominalOver: 1, unread: 0, clampMaxPct: 110 };

  it('rep 별로 명목 초과 조각을 고른다 — over·none 에서 \'나머지 포트 기준\' 이라 말하지 않는다', () => {
    expect(text.hbaBasisFootnote([{ hbaBasis: { ...base, src: 'os', rep: 'value' } }])).toContain('나머지 포트 기준이고 알림은 초과로 보지 않습니다');
    const over = text.hbaBasisFootnote([{ hbaBasis: { ...base, blanked: 1, src: 'os', rep: 'over', overBlank: true } }]);
    expect(over).not.toContain('나머지 포트 기준');
    expect(over).not.toContain('초과로 보지 않습니다');
    expect(over).toContain('다른 포트 때문에 비웠고');
    const none = text.hbaBasisFootnote([{ hbaBasis: { ...base, dataRate: 0, nominal: 1, ports: 1, src: 'os', rep: 'none' } }]);
    expect(none).toContain('판정 보류');
    expect(none).not.toContain('나머지 포트 기준');
  });

  it('서버가 여럿이고 모양이 다르면 개수와 함께 나눠 말한다', () => {
    const t = text.hbaBasisFootnote([
      { hbaBasis: { ...base, src: 'os', rep: 'value' } },
      { hbaBasis: { ...base, blanked: 1, src: 'os', rep: 'over', overBlank: true } },
    ]);
    expect(t).toContain('포트 1개: 서버 HBA 사용률은 나머지 포트 기준');
    expect(t).toContain('포트 1개: 그 서버의 HBA 사용률은 데이터율을 크게 넘은 다른 포트 때문에');
  });

  it('rep 가 없는 옛 기록 — overBlank 가 있으면 over, 없으면 언제나 참인 말만', () => {
    expect(text.hbaBasisFootnote([{ hbaBasis: { ...base, overBlank: true } }])).toContain('다른 포트 때문에 비웠고');
    const u = text.hbaBasisFootnote([{ hbaBasis: base }]);
    expect(u).toContain('이 포트 값은 서버 HBA 사용률에 쓰지 않았고 알림은 초과로 보지 않습니다');
    expect(u).not.toContain('나머지 포트 기준');
  });

  it('iDRAC 포트로 센 서버를 밝히고, OS 에 값이 없어 iDRAC 이 정한 서버의 OS 쪽 명목 초과를 버리지 않는다', () => {
    const t = text.hbaBasisFootnote([{ hbaBasis: { ports: 1, dataRate: 1, nominalOver: 0, src: 'idrac', rep: 'value', osFallback: { ports: 1, nominalOver: 1 } } }]);
    expect(t).toContain('iDRAC 측정 포트로 센 서버 1대');
    expect(t).toContain('OS 측정 HBA 에 사용률이 없어 iDRAC 측정으로 판정했습니다');
    expect(t).toContain('OS 쪽 명목 속도를 넘어 사용률을 비운 포트 1개');
    expect(t).not.toContain('나머지 포트 기준');
    // OS 경로 서버만이면 출처 조각을 내지 않는다
    expect(text.hbaBasisFootnote([{ hbaBasis: { ...base, src: 'os', rep: 'value' } }])).not.toContain('iDRAC');
  });

  it('문구에 백틱이 없다(BoldText 는 별표만 해석한다)', () => {
    const t = text.hbaBasisFootnote([
      { hbaBasis: { ...base, src: 'os', rep: 'none' } },
      { hbaBasis: { ...base, src: 'idrac', rep: 'over', overBlank: true, osFallback: { ports: 2, nominalOver: 1 } } },
    ]);
    expect(t.includes('`')).toBe(false);
    expect(text.detailNotes({ fc: rowsOf(['nom104']), idracFc: rowsOf(['dr156'], 'F') }).join('').includes('`')).toBe(false);
  });
});
