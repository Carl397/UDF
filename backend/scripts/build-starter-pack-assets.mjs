import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Package the approved artwork with the backend. No runtime HTTP fetch or PDF
// dependency is needed, and the printable attachment never contains an OTP.
const source = new URL('../../resources/brand-src/president-poster.jpg', import.meta.url);
const output = new URL('../dist/assets/', import.meta.url);
const jpeg = await readFile(source);
if (jpeg.readUInt16BE(0) !== 0xffd8) throw new Error('President artwork must be a JPEG');

let width = 0;
let height = 0;
for (let offset = 2; offset + 9 < jpeg.length;) {
  if (jpeg[offset] !== 0xff) throw new Error('Invalid JPEG segment');
  const marker = jpeg[offset + 1];
  if (marker === 0xda || marker === 0xd9) break;
  const length = jpeg.readUInt16BE(offset + 2);
  if (length < 2 || offset + 2 + length > jpeg.length) throw new Error('Invalid JPEG length');
  if ([0xc0, 0xc1, 0xc2].includes(marker)) {
    if (jpeg[offset + 4] !== 8 || jpeg[offset + 9] !== 3) {
      throw new Error('President artwork must be an 8-bit RGB JPEG');
    }
    height = jpeg.readUInt16BE(offset + 5);
    width = jpeg.readUInt16BE(offset + 7);
    break;
  }
  offset += length + 2;
}
if (!width || !height) throw new Error('JPEG dimensions not found');

// A4, centered with 24pt margins, preserving the complete poster aspect ratio.
const pageWidth = 595.28;
const pageHeight = 841.89;
const scale = Math.min((pageWidth - 48) / width, (pageHeight - 48) / height);
const w = width * scale;
const h = height * scale;
const drawing = Buffer.from(`q\n${w.toFixed(3)} 0 0 ${h.toFixed(3)} ${((pageWidth - w) / 2).toFixed(3)} ${((pageHeight - h) / 2).toFixed(3)} cm\n/President Do\nQ\n`);
const stream = (dictionary, bytes) => Buffer.concat([
  Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
  bytes, Buffer.from('\nendstream'),
]);
const objects = [
  Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
  Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
  Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /President 4 0 R >> >> /Contents 5 0 R >>`),
  stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg),
  stream('', drawing),
  Buffer.from('<< /Title (Andhor Grey Marks - UDF Party President) /Author (United Democratic Front Party) >>'),
];
const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
const offsets = [0];
let bytes = chunks[0].length;
for (const [index, body] of objects.entries()) {
  offsets.push(bytes);
  const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
  chunks.push(object);
  bytes += object.length;
}
chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${bytes}\n%%EOF\n`));
await mkdir(output, { recursive: true });
await writeFile(new URL('udf-president.jpg', output), jpeg);
await writeFile(new URL('udf-president.pdf', output), Buffer.concat(chunks));
console.log(`Starter-pack assets: full ${width}x${height} president poster and one-page A4 PDF packaged.`);
