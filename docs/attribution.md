# Attribution

AlphaCouncil is MIT licensed. This file records third-party work whose structure
influenced parts of this repository, and the licence obligations that come with it.

Nothing here is vendored. Where an upstream project shaped a framework, the framework was
re-implemented and the wording is original. Personas that adapt an upstream structure
carry a machine-readable `source` block in their frontmatter, and the persona registry
refuses to load an adapted persona that does not name its licence.

To see exactly which files carry attribution, check the provenance column in
[`personas.md`](./personas.md), which is generated from the persona files themselves.

---

## ai-berkshire

- Repository: https://github.com/xbtlin/ai-berkshire
- Licence: MIT
- Copyright: Copyright (c) 2026 xbtlin

**What was adapted.** The five-category economic-moat table and the pre-purchase checklist
shape in `personas/masters/masters-value/buffett.md`; the failure-path table with its
path / probability / severity columns in `personas/masters/masters-value/munger.md`; the
stop-doing-list and business-model framing in `duan_yongping.md`; and the ten-year-certainty
and management-integrity framing in `li_lu.md`.

**What was deliberately not adopted.** The star-rating scores (`★★★☆☆: the model is
understandable but ten-year certainty is low`) are not falsifiable, so the table shapes
were adapted without them, and a test rejects any persona body that reintroduces them.
The generated report corpus, the personal trading track record, and the cached
third-party market-data CSV were all excluded — the last because upstream's MIT licence
covers its own work, not data scraped from a vendor.

### MIT License

```
MIT License

Copyright (c) 2026 xbtlin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Projects reviewed and deliberately not used

**yichen-skills** — https://github.com/mcncarl/yichen-skills

Reviewed while researching how to source social-platform data. It is **not** open source:
it ships a custom "Personal Learning and Non-Commercial Use License" whose clause 2
forbids republishing or repackaging it, or a derivative work, as a public skill
collection or marketplace item. That is exactly what this repository is.

No code, prose or skill file from it has been copied, and none will be without a written
licence grant from its author. Where a future X/social layer needs the same underlying
mechanisms — decoding a Snowflake ID into a timestamp, and proving from a session
transcript that a named search tool actually ran — those are public algorithms and general
patterns, and they will be implemented from scratch.

---

## Named individuals

The master personas are named after real investors and are **interpretations of publicly
documented methodologies**, not statements by, endorsements from, or affiliations with
those individuals. They are written as analytical lenses — what each approach asks and
what would make it walk away — rather than as impersonations. No private communication,
proprietary research, or non-public information from any of them is used.

## On the master lenses

`personas/masters/` contains 21 lenses named after real investors, traders and authors.
Each one is a reconstruction of a publicly documented method — a simulation of how that
person's stated approach would read the evidence in front of it, and what they would
plausibly decide. **None of it is a quotation, a statement, a view, or an endorsement by
the named person, and no file contains anything they actually said.** The wording,
the ordering of concerns and the stated failure modes were written for this project.

The methods themselves are drawn from published books, letters and interviews, which is
why the lenses can be checked against the record. The voice cannot be, and is not offered
as anything but a device for making a committee disagree with itself usefully.
