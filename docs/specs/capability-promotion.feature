Feature: Governed capability promotion

  Scenario: A complete text or declarative candidate receives a draft activation plan
    Given a candidate has a valid manifest digest and schema
    And protected-path and secret scans pass
    And every fixture has an observed passing result
    And two or more distinct named trusted judges pass for the candidate digest
    And a synthetic canary passes for the candidate digest
    And the rollback digest names a real existing digest-pinned registry seed (active or inactive)
    When the promotion planner evaluates the candidate
    Then it returns an auto-activate disposition
    And it prepares an attributed non-force branch and draft pull-request transaction
    And it performs no commit, push, or remote workflow action

  Scenario: Placeholder or incomplete evidence remains blocked
    Given a candidate has a missing, duplicate, or placeholder judge identity
    Or a fixture has no observed result
    Or the canary names another digest
    Or the rollback digest is missing or equals the candidate digest
    When the promotion planner evaluates the candidate
    Then it returns a blocked disposition
    And it prepares no activation transaction

  Scenario: Protected and executable changes require owner review
    Given a candidate changes a protected path or declares executable tool authority
    When the promotion planner evaluates the candidate
    Then it returns an owner-review disposition
    And it creates only a draft description with no mutation

  Scenario: A post-activation health failure produces a pointer rollback plan
    Given an activation plan points at a candidate digest
    And the active registry pointer still names that candidate digest
    When post-activation health fails
    Then the planner prepares a non-force rollback pull-request transaction
    And the transaction restores the verified prior manifest status, bytes, and digest
    And the transaction contains no arbitrary executable code
