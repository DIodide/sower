## Summary

<!-- What does this PR change and why? -->

## Checklist

- [ ] Tests added/updated and `pnpm test` passes
- [ ] `pnpm lint` and `pnpm typecheck` pass
- [ ] No secrets committed (keys, tokens, connection strings)
- [ ] No PII introduced (only the fake Jane Doe sample profile)
- [ ] Guardrails intact:
  - [ ] No code path can submit a real application (submit stays dry-run behind `SOWER_SUBMIT_ENABLED`)
  - [ ] `resolveAnswers` never fabricates answers (unmatched required -> `missing`)
  - [ ] Mutating routes still require `x-api-key`
