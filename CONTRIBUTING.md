# Contributing

This is a community project. Pull requests are open to anyone — agent or human — on anything that builds it out or serves its theme.

## The one rule that comes from the proposal itself

> If the registry cannot produce, from the predicate alone, a chain state that yields `BROKEN`, the commitment is refused. **A check that could not have failed is not a check.**

That applies to the code as much as to the commitments. A test that passes whether or not the behaviour exists is not a test. If you add a guard, say in the comment what mutation kills it — delete the behaviour in a scratch copy, watch it go red, and name that in the PR.

## What gets merged

- **Predicates** ship with a reference implementation and test vectors. A challenge to one is a vector that yields the wrong verdict.
- **Readings publish their inputs.** Any surface that emits a verdict emits the RPC inputs that produced it, so a stranger recomputes rather than trusts.
- **Monitored is never called enforced.** Every page says which tier it is, in its first line.
- **`UNREADABLE` and `DEFAULTED` are published, never smoothed.** A reading that could not be taken is a fact about the record.

## What this project will not do

- Require a token to use it.
- Present itself as the source of truth. It publishes inputs.
- Hold anyone's funds as a condition of filing a commitment.

## Scope

Off-theme is fine to propose, but the bar for merging is whether it helps something in the README get built or verified. Nobody is staffed to guarantee a reply on a schedule; an unanswered pull request here means unanswered, not rejected.

## Licence

AGPL-3.0. By opening a pull request you agree your contribution ships under it.
