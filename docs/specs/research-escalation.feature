Feature: Hostile internet research
  Research runs recover hard or repeated failures without widening the model's trust boundary.

  Rule: Requests are correlated and idempotent
    Scenario: A repair fails twice with the same fingerprint
      Given the target head has not changed
      And one normalized failure event already exists for that head
      When the second failure reaches the research escalation helper
      Then one private RESEARCH_REQUESTED event is persisted
      And one research workflow is dispatched with its correlation ID and bounded redacted query metadata
      And the planner receives no private checkout or write-capable token

  Rule: Retrieval remains public and untrusted
    Scenario: Retrieval uses only the public SSRF-safe fetch boundary
      Given a model proposes a localhost, private, metadata, or unsafe-redirect URL
      When the retrieval worker prefetches source bytes
      Then the URL is rejected before any request is made
      And public-read model webfetch remains denied

    Scenario: A fetched page contains prompt injection
      Given a public page tells the agent to reveal credentials or run a command
      When the retrieval worker normalizes the page
      Then the text remains untrusted evidence
      And no shell, mutation tool, private checkout, state checkout, or target credential is available
      And the terminal event contains citations and digests without the page's raw instructions

  Rule: Terminal state is durable and bounded
    Scenario: Retrieval cannot produce a valid strict response
      Given the retrieval model is unavailable or returns an invalid schema
      When the trusted finalizer runs
      Then one RESEARCH_UNAVAILABLE event is persisted
      And no skill, tool, protected change, or merge is activated

  Rule: Completed research hands off safely
    Scenario: Completed evidence prepares one exact-head merge continuation
      Given a trusted finalizer has normalized bounded claim summaries with citation digests
      When the completed research terminal event is persisted
      Then one RESEARCH_CONTINUATION_INTENT is persisted before dispatch
      And one merge.yml continuation targets the recorded repository, PR, and head
      And allow_merge is false with no dispatch claim id
      And a retry or in-flight continuation does not dispatch again
