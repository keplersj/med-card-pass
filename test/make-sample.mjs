// Builds a made-up card PDF laid out like a printed state card:
// a raster QR code, printed labels, and a column of values (name, dates, provider).
import { PDFDocument, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';

export const SAMPLE = {
  qr: 'PAT-26-0000012345,1990-04-15',
  id: 'PAT-26-0000012345',
  name: 'Jane Q. Sample',
  dob: '1990-04-15',
  issued: '2026-10-02',
  expiration: '2027-10-01',
  provider: 'Pat Example, NP',
};

export async function makeSamplePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const H = 792;
  page.drawText('MedicalCard.Sample-Person.2027.10.01', { x: 8, y: H - 10, size: 8, font });
  page.drawText('https://example.invalid/card?Id=sample', { x: 330, y: H - 10, size: 8, font });
  page.drawText('Medical Cannabis Card', { x: 70, y: H - 95, size: 9, font: bold });
  const png = await QRCode.toBuffer(SAMPLE.qr, { errorCorrectionLevel: 'M', margin: 0, scale: 12 });
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 99, y: H - 140, width: 28, height: 28 });
  const labels = ['Name:', 'DOB:', 'Issued:', 'Expiration:', 'Provider:'];
  const values = [SAMPLE.name, '04/15/1990', '10/02/2026', '10/01/2027', SAMPLE.provider];
  values.forEach((v, i) => {
    page.drawText(labels[i], { x: 60, y: H - 175 - i * 11.25, size: 6.5, font: bold });
    page.drawText(v, { x: 119.8, y: H - 175 - i * 11.25, size: 6.5, font });
  });
  ['Start low and go slow.', 'Call 1-800-000-0000 for help.', 'Call 911 if it is an emergency.']
    .forEach((t, i) => page.drawText(t, { x: 232, y: H - 100 - i * 8, size: 5.5, font }));
  page.drawText('1 of 1', { x: 8, y: 8, size: 8, font });
  page.drawText('10/2/26, 15:24', { x: 540, y: 8, size: 8, font });
  return doc.save();
}
