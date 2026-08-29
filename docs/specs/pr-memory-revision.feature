Feature: Governed revision progress and public mirror idempotency

  Rule: A revision must make byte-level progress

    Scenario: Byte-identical revision output is held privately
      Given the revision model returns files byte-identical to the exact PR head
      When the revision validates the output
      Then no Git blob, tree, commit, or ref update is attempted
      And one bounded NO_PROGRESS event is persisted
      And no revision mirror is posted

  Rule: Judge history must show progress across heads

    Scenario: A higher minimum score can tolerate stochastic lens movement
      Given the prior head has correctness 70 and standards 82
      When the new head has correctness 75 and standards 78
      Then the revision cycle is considered progress

    Scenario: Equal-count blocker replacement is not progress
      Given the prior head has blocker IDs A and B
      When the new head has blocker IDs B and C at the same minimum score
      Then the result is NO_PROGRESS
      And no duplicate public judge mirror is posted

  Rule: Changed heads are judged exactly once

    Scenario: A successful changed-head revision queues a fresh judge
      Given an attributed revision creates a new exact commit head
      When the revision completes
      Then one safe merge-gate dispatch targets that new head
      And the dispatch cannot permit a live merge

  Rule: Public mirrors are idempotent

    Scenario: An equivalent same-head mirror is not duplicated
      Given a matching fingerprint, normalized body, and verified author already exist
      When the workflow attempts the same gate, judge, or revision mirror
      Then it returns the exact existing comment
      And no second public comment is posted

    Scenario: Concurrent mirror attempts have one durable owner
      Given no equivalent public comment exists yet
      When two runs attempt the same exact-head fingerprint
      Then one run commits the durable comment intent before posting
      And the other run posts no public comment

  Rule: Research continuation stays bounded and untrusted

    Scenario: A completed exact-head research run releases one held revision
      Given a same-head NO_PROGRESS hold is correlated to a newer exact-target RESEARCH_REQUESTED event
      And state/research.jsonl contains a newer matching RESEARCH_COMPLETED event
      When the merge gate consumes the completion
      Then RESEARCH_CONTINUATION_CONSUMED is persisted before exactly one REVISION_INTENT
      And the next revision prompt contains only bounded normalized claim summaries and citation metadata in untrusted delimiters
      And raw page text, merge permission, and a public comment are never forwarded
      And another run for the same head remains held
