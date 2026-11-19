import { PDFDocument, rgb } from '../../vendor/pdf-lib/dist/pdf-lib.esm.min.js';

// Original synthetic artwork. A tall single page makes the viewer scroll even at fit width.
export async function mobilePage() {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const sheet = pdf.addPage([420, 1100]);
  sheet.drawRectangle({ x: 30, y: 1000, width: 360, height: 60, color: rgb(.08, .24, .47) });
  for (let i = 0; i < 12; i++) {
    sheet.drawRectangle({ x: 30, y: 900 - 73 * i, width: 160 + i * 12, height: 8, color: rgb(.16, .52, .48) });
  }
  return { name: 'synthetic-mobile.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
}
