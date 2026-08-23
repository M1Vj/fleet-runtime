# FRONT MATTER — Canonical Manuscript Package (v2)

> STATUS: Draft spine instantiated 2026-08-23 from existing project evidence.
> This file defines the VSU-template ordering, the manuscript-wide conventions,
> and the completion ledger. It is the intended target for
> v2/tools/manuscript_lint.py. Nothing outside v2/ is modified or deleted;
> sibling archives (raw/) are treated as read-only inputs (see Convention 5).

## 0. Manuscript conventions (binding for all v2 chapter files)

1. **Value slots.** Every numeric cell that must be transcribed from an existing
   result artifact appears as a bracketed slot of the form:

       [FILL: <artifact-file>#<anchor>]

   Examples used throughout: [FILL: full_study_results.md#auroc-main-table],
   [FILL: pilot_results.md#summary], [FILL: validity_audit_2026-07-25.md#headroom].
   Slots are mechanical TODOs, not estimates. No number may be invented to close a
   slot; if the anchor is missing, open the artifact and extend it instead.
2. **Tense policy (manuscript-mode ON).** Because pilot and full-study results now
   exist, methodology and results chapters use past tense; the introduction states
   objectives in present tense; future tense appears only in the Future Work
   section of Chapter VI. Exception: the Abstract uses past tense for what was
   done and present tense for interpretation. This supersedes the proposal-era
   future-tense convention (see governance/style-authority-and-decisions.yml,
   Decision D-03).
3. **Citation and evidence policy.** All in-text citations resolve to
   v2/references/references.bib. Entries carry an `annote` recording (a) the exact
claim they support and (b) verification status. Entries marked VERIFY-BEFORE-SUBMISSION
must pass CrossRef/OpenAlex lookup before any committee circulation. This policy also
covers front-matter literature claims: an empirical assertion without a slot or a bib
key is flagged `[CITATION NEEDED: <topic>]` and must be resolved before circulation.
4. **Style authority.** VSU 2010 thesis manual is the default until the adviser
   rules otherwise between ATR Referencing Style and VSU 2010 (Decision D-01).
   Formatting details (margins, spacing) are intentionally left to the template;
   this package fixes *structure and order* only.
5. **Immutability rule.** raw/ (including raw/chapters docx/pdf variants) is treated
   as a read-only archive: it may be read as evidence, never edited. Where the
   submitted RRL is authoritative, Chapter II incorporates its argument structure
   and cites the archive location in a marginal provenance note.
6. **Claim discipline.** No comparative or causal statement ("outperforms",
   "corroborates", "complementary to") may appear unless the corresponding
   experiment/baseline exists in an artifact; otherwise it is rewritten as a
   comparison to be reported or deleted.

## 1. Ordering of manuscript sections (VSU template)

| Order | Section | File in this package |
| ----- | ------- | -------------------- |
| 1 | Title Page | 00-front-matter.md §2 |
| 2 | Approval Sheet | 00-front-matter.md §3 |
| 3 | Abstract | 00-front-matter.md §4 |
| 4 | Acknowledgment | 00-front-matter.md §5 |
| 5 | Table of Contents | 00-front-matter.md §6 |
| 6 | List of Tables / List of Figures (separate pages per template) | 00-front-matter.md §7 |
| 7 | Chapter I — Introduction | ch01-introduction.md |
| 8 | Chapter II — Review of Related Literature | ch02-review-of-related-literature.md |
| 9 | Chapter III — Operational Definitions | ch03-operational-definitions.md |
| 10 | Chapter IV — Methodology | ch04-methodology.md |
| 11 | Chapter V — Results and Discussion | ch05-results-and-discussion.md |
| 12 | Chapter VI — Summary, Conclusions, and Future Work | ch06-summary-conclusions-future-work.md |
| 13 | Literature Cited | references/references.bib (rendered) |
| 14 | Appendices | appendices/appendix-manifest.md |

## 2. Title Page (content block; typeset per VSU template)

    DETECTING AI-GENERATED TEXT THROUGH TOPOLOGICAL AND
    INTRINSIC-DIMENSION FEATURES OF LANGUAGE-MODEL REPRESENTATIONS:
    A SURROGATE-CORPUS STUDY WITH PARAPHRASE-ATTACK ROBUSTNESS
    EVALUATION ON THE RAID BENCHMARK

    A Thesis Presented to the Faculty of the Department of Computer Science
    College of Engineering and Technology
    VISAYAS STATE UNIVERSITY
    Baybay City, Leyte, Philippines

    In Partial Fulfillment of the Requirements for the Degree
    BACHELOR OF SCIENCE IN COMPUTER SCIENCE

    By
    [AUTHOR SURNAME, GIVEN NAME MIDDLE NAME]
    [Month Year]

Note (working copy): this title consolidates earlier idea-phase variants —
topological/intrinsic-dimension features as primary; representation probing and
short-text extension as scoped secondary elements. OPEN ITEM: verify word count
against the VSU manual's title-length guideline; prepare a shortened variant
(feature-based detection + paraphrase robustness on RAID) in case the adviser
requires one.

## 3. Approval Sheet (structure only — signatures collected offline)

- Adviser: [NAME], recommendation statement and signature/date line.
- Panel members: [NAME 1], [NAME 2], [NAME 3], approval lines.
- Department Chair: [NAME], acceptance line.
- Date of oral defense: [DATE]. Revision-completion date: [DATE].

## 4. Abstract (draft; slots closed from result artifacts only — no invented numbers)

Large language models now produce fluent academic and professional prose, and
likelihood-based detectors have been reported to degrade under paraphrasing and
domain shift [CITATION NEEDED: paraphrase/domain-shift degradation of statistical
detectors — resolve against ch02 RRL anchor and references.bib before circulation].
This thesis asks whether **geometry-based features** — intrinsic-dimension estimates
and topological summaries of token-level representations — can discriminate
machine-generated from human-written text, and how discrimination holds up under
paraphrase attack. A gated surrogate corpus (surrogate_v2; generation configurations
and acceptance thresholds defined in Chs. III–IV) was constructed, complemented by a
second corpus (phd_rescued) with device-level provenance records. The detector
pipeline was evaluated across multiple generator families and decoding conditions,
evaluated out-of-corpus on the RAID benchmark including its paraphrase condition,
and audited for tokenization and split integrity. On the surrogate corpora,
geometric features reached an AUROC of
[FILL: full_study_results.md#auroc-main-table] for the strongest configuration,
degrading by [FILL: full_study_results.md#paired-deltas] AUROC points under paired
paraphrase attack. On RAID, the pipeline obtained AUROC of
[FILL: full_study_results.md#raid-auroc-table]; whether this replicates the
surrogate findings is assessed in Ch. V, alongside residual headroom relative to
oracle bounds ([FILL: validity_audit_2026-07-25.md#headroom]). Pending those values,
the thesis reports (i) the discriminative strength of representation geometry on its
own terms, (ii) paraphrase-induced degradation as the quantity that bounds any
deployment claim, and (iii) explicitly scoped surrogate-to-human generalization.
Contributions: (a) a provenance-complete evaluation protocol; (b) a consolidated
gap map linking objectives to experiments; (c) scoping considerations offered as
input to institutional AI-writing policy discussions — not as policy recommendations.

**Keywords:** AI-generated text detection; intrinsic dimension; topological data
analysis; paraphrase attack; RAID benchmark; surrogate corpus; AUROC.

## 5. Acknowledgment (skeleton)

Adviser [NAME] — direction and rigor; panel members; the Department of Computer
Science; peers who discussed early drafts; open-source maintainers of the datasets
and libraries used; family. [One paragraph each, formal register, no superlatives.]

## 6. Table of Contents (generated after slot closure; canonical order = §1 table)

## 7. Lists seeded from known artifacts

**List of Tables**
- T4.1 Generation configurations and gate thresholds (source: config/*.json,
  surrogate_v2_gate.json)
- T4.2 Corpus inventory and shard/partition statistics
  (source: DEVICE_PROVENANCE.csv, shard manifests)
- T5.1 Pilot-study summary (source: pilot_results.md#summary)
- T5.2 Full-study AUROC by model × condition
  (source: full_study_results.md#auroc-main-table)
- T5.3 Paired paraphrase deltas (source: full_study_results.md#paired-deltas)
- T5.4 RAID main vs paraphrase AUROC (source: full_study_results.md#raid-auroc-table)
- T5.5 Headroom analysis (source: validity_audit_2026-07-25.md#headroom)
- T6.1 Objective-to-experiment gap map (source: proposal PPTX/draft-2 diff via
  raw/ archive reference; ch01 objectives) — aligns with Abstract contribution (b)

**List of Figures**
- F1.1 Conceptual framework schematic (to be drawn from ch01 §3)
- F4.1 Pipeline diagram (from src/ module graph)
- F4.2 Split construction schematic (LOGO / partitions)
- F5.1 Reliability plot set (source: implementation/results figures)
- F5.2 AUROC-by-condition bar chart (source: full_study_results figures)

## 8. Completion ledger (pre-lint checklist)

- [ ] Close every [FILL:] slot; occurrence count must be zero:
      `rg -o '\[FILL:' v2/manuscript | wc -l` → `0`.
- [ ] Resolve every `[CITATION NEEDED:]` flag into a verified references.bib entry.
- [ ] Render references.bib to Literature Cited in ruled style (D-01).
- [ ] Run v2/tools/manuscript_lint.py against v2/manuscript/ (wiring per governance file).
- [ ] Verify both VERIFY-BEFORE-SUBMISSION bib entries via paper-lookup/CrossRef.
- [ ] Seed figures F1.1–F5.2 from listed sources; mark any missing figure in ledger.
- [ ] Insert signed approval sheet scan post-defense.