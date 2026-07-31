# US HTS data + classification logic

Full US Harmonized Tariff Schedule pulled from the official USITC site
(`hts.usitc.gov`) for the current revision.

## Files

- `chapters/chapter_NN.csv` — one CSV per chapter (01–99). Chapter 77 is
  **reserved/empty** by design (header only).
- `hts_master.csv` — all chapters concatenated, header once, with an extra
  leading `Chapter` column. ~35,500 rows, ~19,800 full 10-digit statistical codes.
- `download_log.csv` — per-chapter HTTP status / byte / line counts.

## How the data was fetched

USITC exposes a REST endpoint (no key, no auth):

```
https://hts.usitc.gov/reststop/exportList?from=<HTS>&to=<HTS>&format=<FMT>&styles=<bool>
```

- `from` / `to` — HTS number range (inclusive). We used `from=NN00&to=NN99` to
  grab one whole chapter at a time.
- `format` — `CSV`, `JSON`, or `XLSX`.
- `styles` — `true` keeps bold/italic/sub/superscript markup; `false` gives
  clean text. We used `false`.

Re-run everything:

```bash
for n in $(seq 1 99); do ch=$(printf "%02d" $n);
  curl -s -o "chapters/chapter_${ch}.csv" \
  "https://hts.usitc.gov/reststop/exportList?from=${ch}00&to=${ch}99&format=CSV&styles=false";
done
```

Note: the CSV/JSON export carries only the tariff lines. It does **not**
include the Section/Chapter legal **Notes** or the General Rules of
Interpretation — those live in the PDF/online chapter views and are legally
binding for classification (see below).

## CSV columns

`HTS Number, Indent, Description, Unit of Quantity, General Rate of Duty,
Special Rate of Duty, Column 2 Rate of Duty, Quota Quantity, Additional Duties`

- **Indent** — nesting depth. A row's real meaning is its own `Description`
  prefixed by every shallower-indent parent above it. You must walk parents up
  to reconstruct the full product description.
- **HTS Number** — blank on pure heading rows that only group children.
- **General Rate** = Column 1 "general" (most-favored-nation / normal trade).
  **Special Rate** = preferential rates under FTAs (codes in parens: `AU`=Australia,
  `CL`=Chile, `KR`=Korea, `P`/`PA`=Panama, etc.; `Free (A+,…)` = GSP-type).
  **Column 2** = rate for countries without normal trade relations.

## Anatomy of an HTS code (10 digits)

```
0101.21.00.10
└┬┘ └┬┘ └┬┘ └┬┘
 │   │   │   └─ statistical suffix (digits 9–10) — US-only, for trade stats
 │   │   └───── subheading detail (digits 7–8) — US tariff rate line
 │   └───────── subheading (digits 5–6) ── international (WCO, 6-digit HS)
 └───────────── heading (digits 1–4)    ── international
  ^^ first 2 digits = Chapter
```

- **Digits 1–6 are the global HS** — identical in every WCO country.
- **Digits 7–8** set the duty rate (the legally operative US "tariff line").
- **Digits 9–10** are US statistical reporting only.
- Duty/admissibility is decided at the **8-digit** level; the 10-digit suffix
  just refines reporting.

## How to classify a product (the actual legal method)

Classification is governed by the **General Rules of Interpretation (GRI 1–6)**,
applied **in strict order** — you only move to the next rule if the current one
doesn't resolve it:

1. **GRI 1** — Classify by the **terms of the headings** and the **Section/
   Chapter Notes**. This resolves the large majority of cases. The Notes are
   not commentary; they legally include/exclude goods (e.g. a Chapter Note may
   say "this chapter does not cover X — see heading YYYY").
2. **GRI 2** — (a) Incomplete/unassembled goods are classed as the finished
   article if they have its essential character. (b) Mixtures/combinations of a
   material extend to goods partly of that material (then resolve by GRI 3).
3. **GRI 3** — When goods are *prima facie* classifiable under two+ headings:
   (a) the **most specific** description wins; (b) else classify by the
   component giving **essential character**; (c) else the **heading last in
   numeric order**.
4. **GRI 4** — Goods not classifiable above go to the heading for the **most
   akin** goods.
5. **GRI 5** — Cases/packaging: containers shaped for the article and normally
   sold with it follow the article.
6. **GRI 6** — Same principles apply at the **subheading** level, comparing only
   subheadings at the same level. Plus the US **Additional U.S. Rules of
   Interpretation** for the 8/10-digit national level.

### Practical algorithm (for code / an LLM prompt)

1. Identify the product: what it **is**, what it's **made of**, its **function/
   use**, and its **state** (raw, semi-finished, finished, assembled, kit).
2. Pick the candidate **Section → Chapter** by subject matter. Read the
   **Section and Chapter Notes first** — they reroute or exclude goods before
   you ever look at a heading.
3. Find the best **4-digit heading** by GRI 1 (heading text + notes).
4. Drill to the **6-digit** subheading, then the **8-digit** tariff line, then
   the **10-digit** statistical suffix — at each level compare only same-indent
   options (GRI 6), walking the indent tree in the CSV.
5. If two headings compete, apply GRI 3 (specific > essential character > last).
6. Read the duty from **General Rate** (col 1) for normal-trade origins, check
   **Special Rate** for FTA preferences, and check **Chapter 99** for temporary
   additional duties / Section 301/232 tariffs that overlay the base rate.

### Gotchas

- **Chapter 98/99 are special**: Ch 98 = US special classification provisions
  (returned goods, repairs, personal exemptions); Ch 99 = temporary
  duties/quotas/trade-remedy tariffs (Section 232/301, etc.) that **add on top**
  of the normal-chapter code. Many real-world entries need *two* codes.
- **Notes beat intuition.** A plastic kitchen item isn't automatically Ch 39 if
  a Chapter Note pushes it elsewhere. Always check notes.
- **"Other" basket lines** (…00.90, …90) are last resorts — only after no
  specific line fits.
- The export omits Notes; fetch them from the chapter pages / the official PDF
  if you need legally-complete classification.
