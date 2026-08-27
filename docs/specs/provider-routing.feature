Feature: Governed autonomous model routing

  Rule: Private fleet data stays on the protected paid provider

    Scenario: A judge evaluates private revision memory
      Given the request is classified as private
      When the fleet selects a model route
      Then it selects a healthy Zen Opus route
      And it does not send the request to a free public-only provider

  Rule: Public research prefers verified free routes

    Scenario: A public repository audit runs on the owner Mac
      Given the target is verified public
      And local Antigravity OAuth is explicitly enabled
      When the fleet selects a public model route
      Then it tries Gemini 3.7 Flash High through Antigravity first
      And it does not copy or export the OAuth cache

    Scenario: A public repository audit runs in GitHub Actions
      Given the target is verified public
      And Antigravity OAuth is unavailable on the runner
      When the fleet selects a public model route
      Then it skips local Antigravity
      And it tries configured Gemini API, OpenRouter, and NVIDIA routes before paid Opus

    Scenario: A direct public provider has no fresh health record
      Given its credential and policy gates are valid
      And no current record marks the provider unavailable
      When the fleet sends the bounded task request
      Then that request is also the live health canary
      And the fleet does not spend quota on a separate preflight prompt

  Rule: Additional account credentials are recovery only

    Scenario: A provider reports a rate limit or exhausted quota
      When the fleet evaluates another credential for the same provider
      Then it does not rotate credentials
      And it may continue to a different provider

  Rule: Internet model discovery cannot activate hostile metadata

    Scenario: An official discovery endpoint returns instructions or malformed identifiers
      When the scheduled refresh parses the response
      Then it discards every field except bounded allowlisted model identifiers
      And it writes only a redacted proposal artifact
      And the active registry remains unchanged
