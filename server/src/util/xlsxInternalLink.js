/**
 * util/xlsxInternalLink.js — 같은 파일 안 시트로 가는 링크(`#'시트'!A1`)를 OOXML 규격 모양으로 쓴다(v2.802 — 호스트·클러스터 엑셀).
 *
 * exceljs 4.4.0 은 칸 링크를 전부 **외부 관계**(`xl/worksheets/_rels/sheetN.xml.rels` 의 TargetMode="External")로 쓰고,
 *   대상이 `시트!A1` 모양이면 `<hyperlink r:id=… location=…>` 처럼 관계와 위치를 **둘 다** 싣는다. 규격의 시트 안 링크는
 *   `<hyperlink ref="A1" location="'시트'!A1"/>` — 관계 없이 위치만이다. 둘 다 실은 파일은 판마다 해석이 다를 수 있어
 *   (v2.799.1 의 '복구하시겠습니까?' 와 같은 종류의 위험) 규격 모양 하나로 쓴다.
 *
 * 고치는 법(xlsxSheetPrOrder.js 와 같은 방식 — exceljs 의 함수 둘만 감싼다):
 *  · 워크시트 prepare 뒤 — 대상이 '#' 로 시작하는 링크는 관계 목록에서 빼고 location 만 남긴다(다른 관계의 Id 는 그대로 — Id 는 이름일 뿐이다).
 *  · 링크 render — location 만 있는 링크는 `ref`·`location`(·tooltip)만 쓴다.
 *  · 바깥 링크(https:// 등)는 손대지 않는다. 함수가 없으면(판이 바뀜) 바꾸지 않고 상태만 남긴다 — 회귀 테스트가 생성 파일을 직접 본다.
 *  · 워커 스레드는 모듈 캐시가 따로다 — 엑셀을 만드는 모듈(워커가 불러오는 것)이 이 파일을 import 해야 워커에도 걸린다.
 */
import { createRequire } from 'node:module';

let state = 'unpatched';

/** 바로잡기를 건다(여러 번 불러도 한 번). @returns {'patched'|'missing'} */
export function ensureInternalLinks() {
  if (state !== 'unpatched') return state;
  try {
    const fromExcel = createRequire(createRequire(import.meta.url).resolve('exceljs'));
    const Sheet = fromExcel('./lib/xlsx/xform/sheet/worksheet-xform.js')?.prototype;
    const Link = fromExcel('./lib/xlsx/xform/sheet/hyperlink-xform.js')?.prototype;
    if (!Sheet || typeof Sheet.prepare !== 'function' || !Link || typeof Link.render !== 'function') { state = 'missing'; return state; }
    const prepare = Sheet.prepare;
    Sheet.prepare = function prepareInternalLinks(model, options) {
      const r = prepare.call(this, model, options);
      const drop = new Set();
      for (const h of model.hyperlinks || []) {
        if (typeof h.target === 'string' && h.target.startsWith('#')) { h.location = h.target.slice(1); if (h.rId) drop.add(h.rId); h.rId = undefined; }
      }
      if (drop.size && Array.isArray(model.rels)) model.rels = model.rels.filter((x) => !drop.has(x.Id));
      return r;
    };
    const render = Link.render;
    Link.render = function renderInternalLink(xmlStream, model) {
      if (model && model.location && !model.rId) { xmlStream.leafNode('hyperlink', { ref: model.address, location: model.location, tooltip: model.tooltip }); return; }
      render.call(this, xmlStream, model);
    };
    state = 'patched';
  } catch {
    state = 'missing';
  }
  return state;
}

/** 진단·테스트 — 지금 상태. */
export const internalLinkState = () => state;

/** 시트 안 링크 대상 — `#'이름'!A1`(이름 안 작은따옴표는 두 번). */
export const sheetLink = (name, cell = 'A1') => `#'${String(name).replace(/'/g, "''")}'!${cell}`;

ensureInternalLinks();
