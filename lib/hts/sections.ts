/**
 * Static HS/HTSUS Section → Chapter mapping. The 22 sections are fixed
 * nomenclature, so we hardcode them rather than parsing. Used to (a) label
 * section notes during ingestion and (b) let get_notes return the relevant
 * Section Notes for a chapter.
 */

export interface HtsSection {
  roman: string;
  title: string;
  /** Inclusive chapter range, zero-padded 2-digit. */
  from: number;
  to: number;
}

export const HTS_SECTIONS: HtsSection[] = [
  { roman: 'I', title: 'Live animals; animal products', from: 1, to: 5 },
  { roman: 'II', title: 'Vegetable products', from: 6, to: 14 },
  { roman: 'III', title: 'Animal, vegetable or microbial fats and oils', from: 15, to: 15 },
  { roman: 'IV', title: 'Prepared foodstuffs; beverages, spirits, vinegar; tobacco', from: 16, to: 24 },
  { roman: 'V', title: 'Mineral products', from: 25, to: 27 },
  { roman: 'VI', title: 'Products of the chemical or allied industries', from: 28, to: 38 },
  { roman: 'VII', title: 'Plastics and articles thereof; rubber and articles thereof', from: 39, to: 40 },
  { roman: 'VIII', title: 'Raw hides, skins, leather, furskins; saddlery; travel goods', from: 41, to: 43 },
  { roman: 'IX', title: 'Wood, cork, straw; basketware and wickerwork', from: 44, to: 46 },
  { roman: 'X', title: 'Pulp of wood; paper and paperboard and articles thereof', from: 47, to: 49 },
  { roman: 'XI', title: 'Textiles and textile articles', from: 50, to: 63 },
  { roman: 'XII', title: 'Footwear, headgear, umbrellas; prepared feathers; artificial flowers', from: 64, to: 67 },
  { roman: 'XIII', title: 'Articles of stone, plaster, cement, ceramics, glass', from: 68, to: 70 },
  { roman: 'XIV', title: 'Natural/cultured pearls, precious stones and metals; jewelry; coin', from: 71, to: 71 },
  { roman: 'XV', title: 'Base metals and articles of base metal', from: 72, to: 83 },
  { roman: 'XVI', title: 'Machinery and mechanical appliances; electrical equipment', from: 84, to: 85 },
  { roman: 'XVII', title: 'Vehicles, aircraft, vessels and associated transport equipment', from: 86, to: 89 },
  { roman: 'XVIII', title: 'Optical, photographic, medical instruments; clocks; musical instruments', from: 90, to: 92 },
  { roman: 'XIX', title: 'Arms and ammunition; parts and accessories thereof', from: 93, to: 93 },
  { roman: 'XX', title: 'Miscellaneous manufactured articles', from: 94, to: 96 },
  { roman: 'XXI', title: 'Works of art, collectors’ pieces and antiques', from: 97, to: 97 },
  { roman: 'XXII', title: 'Special classification provisions; temporary duties (HTSUS Ch 98–99)', from: 98, to: 99 },
];

/** Normalize any code/prefix to a 2-digit chapter string, or null. */
export function chapterOf(input: string): string | null {
  const digits = (input || '').replace(/\D/g, '');
  if (digits.length < 2) return null;
  return digits.slice(0, 2);
}

/** Return the HS section a chapter belongs to. */
export function sectionForChapter(chapter: string): HtsSection | null {
  const n = Number(chapter);
  if (!Number.isFinite(n)) return null;
  return HTS_SECTIONS.find((s) => n >= s.from && n <= s.to) ?? null;
}
