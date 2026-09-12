# Account onboarding — credential rotation pool

How to add model-auth account N+1 to the fleet rotation pool. Names only below —
never paste secret values into docs, chat, or logs.

## Slot convention

| Slot | Env / secret name | Notes |
| --- | --- | --- |
| 1 | `FLEET_OPENCODE_AUTH` | Legacy slot; auto-refreshed by the keepalive agent |
| 2..9 | `FLEET_OPENCODE_AUTH_2` … `FLEET_OPENCODE_AUTH_9` | Numbered slots; probed in order, empties ignored |

Each slot holds one account's opencode auth content (same format as slot 1).
The pool selects the least-recently-healthy non-cooldown slot per model call.

## Add account N+1 locally (Mac first)

> Mac scope: this MacBook is staging/authoring only — not part of the fleet.
> Fleet runtime = GH Actions + fleet-control state; no runtime dependency on
> Mac paths, Mac auth files, or the LaunchAgent keepalive (Mac-only helper).

1. Sign the new account in (normal owner OAuth flow) and locate that account's
   auth content (same JSON shape the keepalive refresh reads for slot 1).
2. Export it in every shell that runs lanes (slot number = next free N+1):

       export FLEET_OPENCODE_AUTH_2="$(cat <that-account-auth.json>)"

   (`<that-account-auth.json>` is a placeholder for that account's auth file —
   never commit it; `raw/` stays git-ignored.)
3. Only slot 1 is auto-refreshed every 30 min; numbered slots are static until
   you re-export them. Re-export after any re-login on that account.
4. No code changes needed: `scripts/lib/model.mjs` picks the pool up
   automatically, and single-key deploys behave exactly as before.

## Mirror to GitHub Actions (second)

1. Add secret `FLEET_OPENCODE_AUTH_2` (…`_3`, …) on **both** repos
   (`M1Vj/fleet-runtime` and `M1Vj/fleet-control`), same as slot 1 today.
2. Map each secret into the jobs that call models — add one env line next to
   the existing `FLEET_OPENCODE_AUTH` entries in `.github/workflows/*.yml`:

       FLEET_OPENCODE_AUTH_2: ${{ secrets.FLEET_OPENCODE_AUTH_2 }}

3. Optional tuning: `FLEET_MODEL_CHAIN` is already a repo var (model fallback
   order); `FLEET_AUTH_COOLDOWN_MS` (slot cooldown, default 15 min) can be
   exported locally or added as a repo var plus the same one-line env mapping
   as step 2.

## Rotation and recovery behavior

- Per call, the pool picks the least-recently-healthy slot that is not
  cooling down.
- Auth/quota/429-class failures (`429`, `rate limit`, `quota`, `credits`,
  `payment`, `unauthorized`, `401`/`403`, `auth`) cool that slot down for
  15 min (`FLEET_AUTH_COOLDOWN_MS` overrides); other failures leave it alone.
- Success clears the slot (cooldown and error count reset).
- Expired cooldowns rejoin automatically — selection rounds back to slot 1
  first ("go back to account 1").
- All slots cooling down: the run records `STALLED` (`why:
  credential-pool-exhausted`) and files — or comment-updates — the
  `[FLEET-AUTH] credential pool exhausted — add account N+1` issue on
  `M1Vj/fleet-control`. Add the account, or wait out the cooldown.

## Reading pool health

Pool health lives at `state/credential-health.json` under `FLEET_STATE_ROOT`
(the fleet-control checkout on runners / the owner Mac) — slot numbers only,
never key material:

    {"updatedUtc":"<iso>","slots":{"1":{"cooldownUntil":0,"consecutiveErrors":0,
    "lastOk":"<iso>","lastAuthError":"429 rate limit… (scrubbed, last 200 chars)"}}}

- `cooldownUntil`: epoch ms; `> now` means the slot is cooling down.
- `consecutiveErrors`: auth-class failures since the last success.
- `lastOk`: last successful call on that slot (selection prefers the oldest).
- Absent/corrupt file = healthy pool; it is recreated on the next call.

## Exhausted-pool alert meaning

`[FLEET-AUTH] … exhausted` means every configured slot hit auth/quota/429
failures inside the cooldown window — usually all accounts out of quota at
once, or a gateway-side auth outage. It is not a code bug: onboard account
N+1 per this doc, or wait for cooldowns to expire and confirm slots rejoin
(slot 1 first) in `credential-health.json`.
