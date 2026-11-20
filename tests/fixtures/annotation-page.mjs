import { PDFDocument, PDFName, PDFString } from '../../vendor/pdf-lib/dist/pdf-lib.esm.min.js';

export const pageSize = [400, 440];
export const foreignNote = 'Synthetic note not owned by Paperplane';

export async function annotationPage() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage(pageSize);
  // Keep the note away from the drawn marks and include real base-page content.
  page.drawText('Annotation test page', { x: 280, y: 417, size: 10 });
  const note = pdf.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [350, 12, 370, 32],
    Contents: PDFString.of(foreignNote), NM: PDFString.of('fixture-note'),
  });
  page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(note)]));
  return Buffer.from(await pdf.save());
}
