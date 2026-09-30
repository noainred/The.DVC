/**
 * util/xlsxChart.js — exceljs 가 만든 .xlsx 에 **꺾은선 차트**를 넣는다(v2.661 — iDRAC 통합 추이 엑셀 내보내기).
 *
 * 왜 직접 XML 을 쓰나: exceljs 4.4 는 차트를 만들지 못한다(이미지만 넣을 수 있다). 차트를 이미지로 그려 넣으면 엑셀에서
 * 값을 고치거나 범위를 바꿀 수 없어 '엑셀로 차트를 그려' 라는 요청의 뜻이 사라진다. 그래서 워크북 버퍼를 jszip 으로 열어
 * DrawingML 차트 파트(chartN.xml)·드로잉(drawingN.xml)·관계·콘텐츠 형식을 더한다. 차트는 시트의 셀 범위를 참조하므로
 * 엑셀에서 데이터를 고치면 차트도 바뀐다.
 *
 * 지킬 것:
 *  · 빈 셀은 선을 끊는다(`dispBlanksAs gap`) — 결측을 0 으로 이으면 '유휴·급냉' 이라는 거짓이 된다.
 *  · 보조 축(secondary)은 단위가 다른 계열(전력 W)용이다 — 퍼센트·℃ 와 한 축에 두면 값이 눌려 보이지 않는다.
 *  · 시트 XML 의 `<drawing>` 은 스키마 순서상 `legacyDrawing`·`tableParts`·`extLst` **앞**에 있어야 한다(엑셀이 복구 대화상자를 띄운다).
 *  · jszip 은 exceljs 의 의존성이다 — exceljs 가 설치된 위치에서 불러온다(별도 의존성을 늘리지 않는다).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
function loadJsZip() {
  const fromExcel = createRequire(require.resolve('exceljs'));
  return fromExcel('jszip');
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 시트 이름을 수식 참조로(작은따옴표 이스케이프). */
export const sheetRef = (name) => `'${String(name).replace(/'/g, "''")}'`;
/** 1 → A, 27 → AA. */
export function colLetter(n) {
  let s = ''; let x = Math.floor(n);
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

const txPr = (sz = 900) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}"/></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>`;
const titleXml = (text, sz = 1200) => `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="1"/></a:pPr><a:r><a:rPr lang="ko-KR" sz="${sz}" b="1"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

/** 화면 모양 키 → DrawingML 프리셋(웹 idracTrendText.js DASHES 와 같은 키). */
export const PRST_DASH = { dash: 'dash', dot: 'sysDot', dashdot: 'dashDot' };

function serXml(s, idx, catRef) {
  const color = /^[0-9A-Fa-f]{6}$/.test(String(s.color || '').replace('#', '')) ? String(s.color).replace('#', '') : '4472C4';
  // v2.662: 선 모양 — 허용 목록 밖은 실선. 스키마 순서: solidFill → prstDash → round.
  const dash = PRST_DASH[s.dash] || null;
  const w = Number.isInteger(s.width) && s.width >= 1 && s.width <= 4 ? s.width * 9525 : 19050;
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>`
    + `<c:tx><c:strRef><c:f>${esc(s.nameRef)}</c:f></c:strRef></c:tx>`
    + `<c:spPr><a:ln w="${w}" cap="${dash ? 'flat' : 'rnd'}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${dash ? `<a:prstDash val="${dash}"/>` : ''}<a:round/></a:ln></c:spPr>`
    + (s.marker
      ? `<c:marker><c:symbol val="circle"/><c:size val="4"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>`
      : '<c:marker><c:symbol val="none"/></c:marker>')
    + `<c:cat><c:strRef><c:f>${esc(catRef)}</c:f></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>${esc(s.ref)}</c:f></c:numRef></c:val>`
    + '<c:smooth val="0"/></c:ser>';
}

function axisPair({ catId, valId, pos, deleteCat, valTitle, min, max, crossesMax }) {
  const scaling = `<c:scaling><c:orientation val="minMax"/>${max != null ? `<c:max val="${max}"/>` : ''}${min != null ? `<c:min val="${min}"/>` : ''}</c:scaling>`;
  const cat = `<c:catAx><c:axId val="${catId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="${deleteCat ? 1 : 0}"/>`
    + '<c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>'
    + `<c:tickLblPos val="nextTo"/>${txPr(800)}<c:crossAx val="${valId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:tickLblSkip val="${deleteCat ? 1 : 'AUTO'}"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const val = `<c:valAx><c:axId val="${valId}"/>${scaling}<c:delete val="0"/><c:axPos val="${pos}"/>`
    + (pos === 'l' ? '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' : '')
    + (valTitle ? `<c:title><c:tx><c:rich><a:bodyPr rot="-5400000" vert="horz"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:r><a:rPr lang="ko-KR" sz="900"/><a:t>${esc(valTitle)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` : '')
    + '<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>'
    + `${txPr(800)}<c:crossAx val="${catId}"/><c:crosses val="${crossesMax ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`;
  // tickLblSkip 은 정수만 허용된다 — AUTO 는 빼고 엑셀이 정하게 둔다.
  return { cat: cat.replace('<c:tickLblSkip val="AUTO"/>', ''), val };
}

/**
 * 차트 XML(순수 — 테스트로 고정). spec:
 * { title, catRef, series:[{ nameRef, ref, color, axis:'primary'|'secondary' }], y1:{title,min,max}, y2:{title,min} }
 */
export function chartXml(spec) {
  const prim = (spec.series || []).filter((s) => s.axis !== 'secondary');
  const sec = (spec.series || []).filter((s) => s.axis === 'secondary');
  let idx = 0;
  const lineChart = (list, catId, valId) => `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${list.map((s) => serXml(s, idx++, spec.catRef)).join('')}<c:marker val="1"/><c:axId val="${catId}"/><c:axId val="${valId}"/></c:lineChart>`;
  let plot = '<c:plotArea><c:layout/>';
  const axes = [];
  if (prim.length) {
    plot += lineChart(prim, 500100, 500200);
    const a = axisPair({ catId: 500100, valId: 500200, pos: 'l', valTitle: spec.y1?.title, min: spec.y1?.min, max: spec.y1?.max });
    axes.push(a.cat, a.val);
  }
  if (sec.length) {
    const catId = prim.length ? 500300 : 500100;
    plot += lineChart(sec, catId, 500400);
    const a = axisPair({ catId, valId: 500400, pos: prim.length ? 'r' : 'l', deleteCat: !!prim.length, valTitle: spec.y2?.title, min: spec.y2?.min, max: spec.y2?.max, crossesMax: !!prim.length });
    axes.push(a.cat, a.val);
  }
  plot += axes.join('') + '</c:plotArea>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<c:roundedCorners val="0"/><c:chart>' + (spec.title ? titleXml(spec.title) : '') + '<c:autoTitleDeleted val="0"/>'
    + plot + `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txPr(900)}</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function drawingXml(anchor) {
  const a = { fromCol: 0, fromRow: 0, toCol: 12, toRow: 24, ...anchor };
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
    + '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>'
    + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>'
    + '</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>';
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const relsDoc = (rels) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${rels}</Relationships>`;

/**
 * 워크북 버퍼에 차트를 넣은 새 버퍼를 돌려준다.
 * @param {Buffer} buf  exceljs writeBuffer 결과
 * @param {Array<{ sheet:number, anchor?:object } & object>} charts  sheet = 1부터(워크북 시트 순서 = exceljs sheetN.xml)
 */
export async function addLineCharts(buf, charts = []) {
  if (!charts.length) return buf;
  const JSZip = loadJsZip();
  const zip = await JSZip.loadAsync(buf);
  let types = await zip.file('[Content_Types].xml').async('string');
  const addOverride = (part, ct) => {
    if (!types.includes(`PartName="${part}"`)) types = types.replace('</Types>', `<Override PartName="${part}" ContentType="${ct}"/></Types>`);
  };
  let n = 0;
  for (const c of charts) {
    n += 1;
    const sheetPath = `xl/worksheets/sheet${c.sheet}.xml`;
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) throw new Error(`시트 ${c.sheet} 이 없습니다`);
    zip.file(`xl/charts/chart${n}.xml`, chartXml(c));
    zip.file(`xl/drawings/drawing${n}.xml`, drawingXml(c.anchor));
    zip.file(`xl/drawings/_rels/drawing${n}.xml.rels`, relsDoc(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${n}.xml"/>`));
    addOverride(`/xl/charts/chart${n}.xml`, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml');
    addOverride(`/xl/drawings/drawing${n}.xml`, 'application/vnd.openxmlformats-officedocument.drawing+xml');
    // 시트 관계 — 이미 있으면 사용하지 않은 rId 로 더한다.
    const relPath = `xl/worksheets/_rels/sheet${c.sheet}.xml.rels`;
    const relFile = zip.file(relPath);
    let rels = relFile ? await relFile.async('string') : relsDoc('');
    let rid = 1; while (rels.includes(`Id="rIdDrw${rid}"`)) rid += 1;
    const rId = `rIdDrw${rid}`;
    rels = rels.replace('</Relationships>', `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`);
    zip.file(relPath, rels);
    let sx = await sheetFile.async('string');
    if (/<drawing\b/.test(sx)) throw new Error(`시트 ${c.sheet} 에 이미 드로잉이 있습니다`);
    if (!/xmlns:r=/.test(sx.slice(0, 600))) sx = sx.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    const tag = `<drawing r:id="${rId}"/>`;
    const before = sx.search(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
    sx = before >= 0 ? sx.slice(0, before) + tag + sx.slice(before) : sx.replace('</worksheet>', `${tag}</worksheet>`);
    zip.file(sheetPath, sx);
  }
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
