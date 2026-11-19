// SPDX-License-Identifier: MIT
import { arr, ref, str, stream } from './pdf-bytes.mjs';

export const font = (pdf, name = 'Helvetica', encoding = '') => pdf.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} ${encoding} >>`);
export const text = (label, x = 24, y = 255, size = 13) => `BT /F0 ${size} Tf ${x} ${y} Td ${str(label)} Tj ET\n`;
export const marker = label => `q .13 .34 .62 rg 24 232 16 9 re f Q\n${text(label)}`;
export const resources = (f, extra = '') => `<< /Font << /F0 ${ref(f)} >> ${extra} >>`;
export const box = '[0 0 320 290]';

export class Pages {
  constructor(pdf) {
    this.pdf = pdf;
    this.catalog = pdf.reserve();
    this.root = pdf.reserve();
    this.font = font(pdf);
    this.base = resources(this.font);
    this.catalogDict();
  }
  catalogDict(extra = '') { this.pdf.set(this.catalog, `<< /Type /Catalog /Pages ${ref(this.root)} ${extra} >>`); }
  node(id, kids, count = kids.length, attrs = `/MediaBox ${box} /Resources ${this.base}`, parent) {
    this.pdf.set(id, `<< /Type /Pages /Count ${count} /Kids ${arr(kids.map(x => ref(x)))} ${parent ? `/Parent ${ref(parent)}` : ''} ${attrs} >>`);
  }
  leaf(parent, contents, attrs = '', id = this.pdf.reserve()) {
    this.pdf.set(id, `<< /Type /Page /Parent ${ref(parent)} ${contents ? `/Contents ${contents}` : ''} ${attrs} >>`);
    return id;
  }
  content(mark, extra = '', flate = false) { return this.pdf.add(stream(marker(mark) + extra, '', flate)); }
  simple(mark, extra = '', attrs = '') {
    const data = this.content(mark, extra);
    const page = this.leaf(this.root, ref(data), attrs);
    this.node(this.root, [page]);
    return { data, page };
  }
}

// A reproducible geometric raster; no external imagery or color profiles.
export function pixels(w, h, channels, seed) {
  return Buffer.from(Array.from({ length: w * h * channels }, (_, i) => {
    const p = Math.floor(i / channels), x = p % w, y = Math.floor(p / w);
    return (x * (5 + (seed % 13)) + y * 11 + ((x ^ y) & 7) * 15 + (i % channels) * 73 + seed * 19) & 255;
  }));
}
export const image = (pdf, w, h, channels, payload, extra = '', flate = false) => pdf.add(stream(payload,
  `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /BitsPerComponent 8 /ColorSpace /${channels === 1 ? 'DeviceGray' : 'DeviceRGB'} ${extra}`, flate));
