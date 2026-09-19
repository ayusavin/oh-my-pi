Edit scoped long-term memories by id. Only ids returned by `recall`.

Operations:
- `update`: replace a memory's full content. Mem0 ignores `importance`.
- `forget`: permanently delete the scoped memory.
- `invalidate`: softly supersede a Mnemopi memory; unavailable with Mem0.

Mem0 accepts only project-scoped records from the active repository. Mnemopi fact ids returned by `recall` remain read-only.

MUST read `memory://<id>` before `update`. Recall previews can be clipped; `update` replaces content wholesale and would otherwise delete unseen content.
