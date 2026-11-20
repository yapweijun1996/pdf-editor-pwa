import { PDFDocument, rgb } from '../../vendor/pdf-lib/dist/pdf-lib.esm.min.js';

// Synthetic portrait Letter pages with artwork and no real document data.
export async function mobilePage() {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let page = 0; page < 3; page++) {
    const sheet = pdf.addPage([612, 792]);
    sheet.drawRectangle({ x: 40, y: 720, width: 532, height: 50, color: rgb(.08, .24, .47) });
    for (let i = 0; i < 9; i++) {
      sheet.drawRectangle({ x: 40, y: 670 - 70 * i, width: 200 + i * 20, height: 8, color: rgb(.16, .52, .48) });
    }
  }
  return { name: 'synthetic-mobile-long-document-filename-for-truncation.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
}
