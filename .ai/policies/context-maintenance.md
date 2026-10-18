<!-- toolkit:sha256=f7572c4e3f99da2e09ea96fb6dbf16da51ad5bab426f1d38fb65e204c096f198 -->
# Context maintenance

- Keep Markdown context discoverable and authoritative.
- Update routing when project ownership, paths, or workflow boundaries change.
- Keep cross-session task state in the selected project's `ongoing/` directory and list each active task in its `README.md`.
- Read only the ongoing task matching the current work; do not use a global current-task pointer.
- Move durable decisions into focused guidance when a task finishes, then remove its ongoing entry and task document.
- Track unresolved technical debt separately from ongoing task state in the shared `technical-debt/README.md`; index each scoped record there and read only records relevant to the current work.
- In each debt record, date the verified evidence and inventory, describe impact and migration constraints, and define completion and verification criteria. Refresh dated evidence before implementation; recording debt does not authorize the work.
- When debt is resolved, update its index disposition and record verification in the debt record. Do not create history directories.
- Do not introduce generated routing JSON or history directories into this scaffold.
