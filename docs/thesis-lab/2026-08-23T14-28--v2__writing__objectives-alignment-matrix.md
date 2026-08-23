# Proposal-to-Results Alignment Matrix and Tense Reconciliation (v2, rev L-104)

Purpose: retire the classic defense-killer where Chapter 1 promises work
that is already done (or done work diverges from what was promised). This
matrix diffs every proposal-stage commitment against executed deliverables
and issues binding rewrite directives for the Ch1 migration into
`v2/manuscript/chapters/ch1-introduction.tex`.

Ground truth sources: `raw/chapters/Introduction.docx` (proposal stage),
`raw/drafts/preproposal`, `implementation/results/pilot_results.md`,
`implementation/results/full_study_results.md`, paired-delta artifacts,
`validity_audit_2026-07-25/*`.

## 1. Binding tense rules (apply mechanically during migration)

| Location | Rule |
|---|---|
| Ch1 Background/Motivation | Present tense; literature-grounded |
| Ch1 Objectives | Past-neutral declarative: \"This study examined...\" (NOT \"will examine\") |
| Ch1 Scope | Executed scope, including what was cut (RAID full -> subsample; own-corpus freeze) stated as deliberate design |
| Ch1 Significance | Present tense, claims sized to Ch5 evidence |
| Ch2 RRL | Present perfect for lit status; migrate 'final' version only |
| Ch3 Definitions | Present tense (definitions are timeless within study) |
| Ch4 Methodology | Past tense (executed); exceptions: standing policies in present |
| Ch5 Results | Past tense; interpretation may use present |
| Ch6 Conclusions | Present tense; future work in conditional |

Ban list for migrated Ch1: \"will be conducted\", \"the researchers will\",
\"expected outputs\", \"proposed timeline\". Replace with executed equivalents
or move to Ch6 future work.

## 2. Objective-by-objective reconciliation

Status legend: ALIGNED / REWRITE / CUT / SUPERSEDED.

### O1. Detection system construction
- Proposal: build detector for machine-generated academic text.
- Executed: surrogate_v2-trained classifier + baselines; pipeline validated
  by pilot then scaled (full_study_results.md).
- Directive: REWRITE objective to name surrogate-training strategy and the
  three data tiers explicitly. Cross-link Ch4 Sec 4.3.

### O2. Robustness to evasion
- Proposal: evaluate resistance to evasion (idea-phase \"evaders\").
- Executed: paraphrase evader suite + RAID adversarial strata + repair
  attempts; degradation curves in Ch5 RQ4.
- Directive: ALIGNED in substance; REWRITE wording from future to executed
  and bind to named strata, not generic \"attacks\".

### O3. Human-collected validation corpus
- Proposal: collect and analyze student/participant writing.
- Executed: consent-gated own corpus; frozen feasibility gate; author-level
  splits; quarantined phd_rescued tier dual-reported.
- Directive: REWRITE to disclose the freeze decision and the salvage tier
  as designed components; silence about either invites hostile discovery.

### O4. Benchmark comparison
- Proposal: compare against existing detectors/benchmarks.
- Executed: stratified RAID subsample; zero-shot + embedding baseline
  families; paired deltas with Holm correction.
- Directive: REWRITE scope sentence: claims are subsample-scoped (Ch4 4.3.2,
  Ch6 T7).

### O5. Measurement quality (novelty-chain payoff)
- Proposal (implicit): better-than-AUROC assessment.
- Executed: calibration/reliability + headroom-by-length + mixed-authorship
  + linguistic-splitting slices; intrinsic-dimension descriptive probes.
- Directive: PROMOTE from implicit to explicit objective; this is the
  documented novelty chain: idea-phase (intrinsic dimension, linguistic
  splitting, evaders) -> finalized RQ1-RQ4 -> Ch5 audit apparatus. Expand
  this row into a single genealogy paragraph and place it in Ch1 §Novelty.

## 3. Scope-change register (must appear in Ch1 Scope paragraph)

1. RAID: full benchmark -> stratified subsample (reason: compute budget;
   mitigation: manifest + floor per stratum).
2. Own corpus: open-ended collection -> gated, then FROZEN (reason:
   predeclared adequacy criteria met/frozen before outcome inspection).
3. Data tiers: two -> four (added F2 salvage tier; added external tier E).
4. Timeline: proposal schedule -> executed dates; insert executed milestone
   dates from wiki/log.md backfill.

## 4. Expected-outputs conversion table

| Proposal \"expected output\" | Executed artifact | Action |
|---|---|---|
| Working detector | surrogate_v2-trained system + configs | Keep, retense |
| Evaluation framework | metrics/classify/embeddings/topology + audit suite | Keep, elevate to contribution |
| Validation dataset | own corpus (gated) + RAID subsample | Keep, add governance framing |
| Robustness analysis | evasion curves + adversarial strata + repairs | Keep |
| (none promised) | validity_audit_2026-07-25 threat catalog | ADD to Ch1 outputs list |

## 5. Verification checklist (run before ch1 migration compiles)

1. grep migrated ch1 for ban-list phrases -> expect zero hits.
2. Every objective maps to >=1 Ch5 section AND >=1 Ch6 finding.
3. Every scope change in Sec 3 appears in Ch1 Scope and Ch6 limitations.
4. Novelty genealogy paragraph present in Ch1 and mirrored in Ch5 synthesis.
5. manuscript_lint.py passes on the migrated chapter file.
6. On migration completion: append the corresponding entry to
   v2/wiki/log.md and clear the affected known-debt items in
   v2/wiki/index.md (traceability is part of the task, not an afterthought).