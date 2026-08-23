# Integrity Firewall Policy: Detector-Evasion Tooling vs Thesis Prose (v2)

Status: BINDING for all work in this repository. Effective immediately upon
adoption. Supersedes any skill instruction in conflict.

## 1. Statement of exposure

The repository contains a humanizer/AI-detector-writing-tool skill whose
stated optimization goal is total evasion of AI detectors, executed via a
local StealthRL-lineage pipeline adjacent to a cited 2026 work (Ranganath).
Simultaneously, this thesis STUDIES AI-text detection, and a Chapter 2 RRL
has already been submitted through Turnitin. Unmanaged, this creates:

- Evidentiary circularity: manuscript prose processed by the very class of
  tooling the thesis measures, contaminating any claim about detection.
- Misconduct exposure: institutional policies treat detector-evasion of
  submitted academic work as dishonesty irrespective of intent.
- Contradiction of our own commitments: authorship-tracking and
  participant-data-guard principles become unenforceable if prose
  provenance is opaque.

## 2. Binding rules

R1. PROHIBITION. Detector-evasion tooling (humanizer skill, StealthRL
    pipeline, any derivative) SHALL NOT be applied to any thesis text:
    drafts, revisions, abstracts, emails to committee, or appendices.
    No exception procedure exists. Violation requires immediate disclosure
    and retraction of affected prose.

R2. INSTRUMENT-ONLY USE. Evasion/humanization tooling may be used solely as
    a research instrument on EXPERIMENT DATA (e.g., constructing evaded
    test conditions), never on authoring workflows.

R3. MANUAL PARAPHRASE WORKFLOW. Thesis prose revision follows the
    researcher's own paraphrasing workflow (learned-rules.md). Assistant
    systems may suggest edits which the researcher accepts, rejects, or
    rewrites; the researcher's typed/reworked text is the manuscript.

R4. COMPOSITION PROVENANCE LEDGER. Maintain the ledger below (also shipped
    as thesis Appendix H). Every section gets a row BEFORE defense.

R5. PROACTIVE DISCLOSURE. Before ANY further Turnitin submission, disclose
    to the adviser: (a) existence and purpose of evasion tooling in the
    repo; (b) this firewall policy; (c) the provenance ledger; (d) the
    StealthRL/Ranganath lineage and how the thesis cites it (threats
    section T11 only).

R6. SKILL SCOPE LABELING. The humanizer skill directory gains no thesis-
    facing invocation paths; thesis assistant prompts must not reference it
    except to enforce R1-R2.

## 3. Composition provenance ledger (maintained per section)

Schema: | Section | Typed-by-researcher % | Assistant-suggested % |
Accepted-with-edit % | Tools touched text? | Reviewer | Date |

Baseline rows to create upon adoption of this policy:

| Section | Status |
|---|---|
| ch1 (migrated from Introduction.docx) | LEDGER-REQUIRED before compile |
| ch2 (migrated from RRL 'final') | LEDGER-REQUIRED (Turnitin history) |
| ch3-ch6 (this v2 package) | Assistant-drafted scaffolds; ALL prose
  subject to R3 rewrite + ledger row before submission |

## 4. Enforcement hooks

- Pre-commit: manuscript_lint.py extended check -> fail if ledger lacks a
  row for any changed chapter file.
- Defense prep: rehearse a 90-second answer to "did you use AI to evade
  Turnitin?" grounded in this policy: NO evasion tooling touched prose;
  tooling is instrumented research subject matter; provenance is disclosed
  per section; adviser was informed before resubmission.

## 5. Relationship to other v2 documents

- threats T11 (ch6): cites this policy as mitigation.
- wiki/index.md: indexes this policy as governance asset G-03.
- references.bib: ranganath2026stealth carries the cite-only-in-T11 rule.