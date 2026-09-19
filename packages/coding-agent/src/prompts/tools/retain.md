Store ≥1 fact in long-term memory for future sessions.

Use: durable, reusable knowledge—user preferences, project decisions, architectural choices; anything improving future responses. No ephemeral task state.

Each item MUST be specific, self-contained: who, what, when, why. Batch related facts per call; deduplicated and consolidated.

When Mem0 is active, `retain` stores assistant facts only in the active project's scope. A standing global user preference requires the user's explicit `/memory save --global <text>` command.
