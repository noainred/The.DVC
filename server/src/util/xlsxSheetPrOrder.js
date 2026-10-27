/**
 * util/xlsxSheetPrOrder.js — exceljs 가 쓰는 시트 속성(`<sheetPr>`)의 하위 요소 순서를 OOXML 스키마 순서로 바로잡는다(v2.799.1).
 *
 * 사용자 보고(2026-10-27): 'vm-list-OC2-all-20261027-1044.xlsx 의 내용에 문제가 있습니다. 복구하시겠습니까?' — VM 목록 내보내기 엑셀을
 *   열 때마다 Excel 이 복구를 물었다. 원인(재현 — 목 데이터 5개 파일 모두): exceljs 4.4.0 `sheet-properties-xform.js render` 가
 *   `pageSetUpPr` 를 `outlinePr` **앞**에 쓴다. 스키마(CT_SheetPr)는 tabColor → outlinePr → pageSetUpPr 순서이고 Excel 은 순서가 틀린
 *   파일을 손상으로 본다. 한 시트에 '폭 한 장 인쇄'(pageSetup.fitToPage)와 '개요 단추 위치'(properties.outlineProperties)를 함께 두면
 *   생긴다 — veeam/vmListXlsx.js 'VM 목록(폴더 트리)' 시트(v2.792 부터). LibreOffice·openpyxl·exceljs 는 순서를 보지 않아 그동안 드러나지 않았다.
 *
 * 고치는 법: exceljs 의 그 렌더 함수 하나를 스키마 순서판으로 바꾼다(출력 내용은 같고 순서만 다르다 — 압축을 다시 푸는 후처리보다 싸다).
 *  · exceljs 가 설치된 위치에서 불러온다(같은 모듈 캐시 — `import ExcelJS from 'exceljs'` 가 쓰는 바로 그 클래스다).
 *  · 그 파일·함수가 없으면(판이 바뀜) 바꾸지 않고 상태만 남긴다 — 회귀 테스트(xlsxSheetPr2799)가 생성 파일의 순서를 직접 보므로 그때 드러난다.
 *  · 워커 스레드는 모듈 캐시가 따로다 — 엑셀을 만드는 모듈(워커가 불러오는 것)이 이 파일을 import 해야 워커에도 걸린다.
 * 같은 종류의 다른 순서 규칙: util/xlsxChart.js(`<drawing>` 은 legacyDrawing·tableParts·extLst 앞).
 */
import { createRequire } from 'node:module';

let state = 'unpatched';

/** 바로잡기를 건다(여러 번 불러도 한 번). @returns {'patched'|'missing'} */
export function ensureSheetPrOrder() {
  if (state !== 'unpatched') return state;
  try {
    const fromExcel = createRequire(createRequire(import.meta.url).resolve('exceljs'));
    const Xform = fromExcel('./lib/xlsx/xform/sheet/sheet-properties-xform.js');
    const proto = Xform?.prototype;
    if (!proto || typeof proto.render !== 'function') { state = 'missing'; return state; }
    proto.render = function render(xmlStream, model) {
      if (!model) return;
      xmlStream.addRollback();
      xmlStream.openNode('sheetPr');
      let inner = false;
      inner = this.map.tabColor.render(xmlStream, model.tabColor) || inner;
      inner = this.map.outlinePr.render(xmlStream, model.outlineProperties) || inner;   // 스키마: outlinePr 가 pageSetUpPr 앞
      inner = this.map.pageSetUpPr.render(xmlStream, model.pageSetup) || inner;
      if (inner) { xmlStream.closeNode(); xmlStream.commit(); } else { xmlStream.rollback(); }
    };
    proto.render.__sheetPrOrder = true;
    state = 'patched';
  } catch {
    state = 'missing';
  }
  return state;
}

/** 진단·테스트 — 지금 상태. */
export const sheetPrOrderState = () => state;

ensureSheetPrOrder();
