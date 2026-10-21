<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Trading rules live as pure functions in src/lib/bot/strategy.ts (tested in strategy.test.ts); the engine (engine.ts) only does I/O and must route every decision through them — keeps safety rules testable.
- Contract duration (1 tick) and barriers are constants, never config — the user must not be able to change them.
- tsconfig has noUncheckedIndexedAccess, exactOptionalPropertyTypes and noPropertyAccessFromIndexSignature off — Deriv API payloads are loosely typed JSON.
