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

  Rule: Named credential slots balance deterministically without quota evasion

    Scenario: Healthy Gemini project credentials use a stable run assignment
      Given two Gemini API credentials have explicit, distinct project groups
      And the run provides a deterministic seed or GitHub run ID
      When the fleet selects the healthy Gemini route twice in that run
      Then both selections use the same named credential
      And different run seeds may select different healthy credentials

    Scenario: An authentication failure can recover with another credential
      Given the selected credential is rejected by the provider
      And another named credential is present and healthy
      When the fleet retries the same model reference
      Then it selects the other credential

    Scenario: Gemini project quota allows bounded group failover
      Given Gemini reports a rate limit for one declared project group
      And every involved credential has a validated, distinct project group
      When the fleet retries the same model reference
      Then it may select a credential in another project group
      And it does not create an account, project, or API key

    Scenario: Provider-wide or account-wide limits stop same-provider rotation
      Given a provider reports a provider-wide limit
      Or the provider has account-wide limits such as OpenRouter free access
      When the fleet evaluates another credential for the same provider
      Then it does not rotate credentials
      And it may continue to a different provider

    Scenario: NVIDIA Kimi K3 stays a gated public prototype
      Given NVIDIA lists moonshotai/kimi-k3 on its free hosted chat endpoint
      When the fleet evaluates the NVIDIA fallback
      Then the target must be verified public
      And FLEET_NVIDIA_ENABLE and NVIDIA_API_KEY must both be present
      And rate or quota exhaustion stops all NVIDIA routes for that account

    Scenario: Antigravity OAuth remains one owner-Mac keyring session
      Given the official Antigravity CLI exposes one OS-keyring OAuth session
      When the owner runs the provider account login/status helper
      Then login launches the official sandbox flow and status reports only slot health
      And the owner uses the CLI's documented logout path before switching accounts
      And it does not copy HOME, OAuth caches, or create concurrent profiles

  Rule: Internet model discovery cannot activate hostile metadata

    Scenario: An official discovery endpoint returns instructions or malformed identifiers
      When the scheduled refresh parses the response
      Then it discards every field except bounded allowlisted model identifiers
      And it writes only a redacted proposal artifact
      And the active registry remains unchanged
