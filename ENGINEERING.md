# Engineering rules

## Source and interfaces

Use plain ES modules, CSS, and named JSDoc contracts. The manifest is the runtime
version source. There is no compilation step or framework layer to introduce
for a cleanup. Keep browser effects behind existing adapters and event owners.
Validate adapter capabilities before the operation can write data.

Prefer a module that owns a complete responsibility to several wrappers that
only forward arguments. Name public inputs, outputs, and state. Comments should
explain an invariant, a browser limitation, or an otherwise surprising decision,
not celebrate an implementation or repeat a historical milestone number.

## Saved data and browser actions

- Read fresh state inside `mutateStores` for read-modify-write operations. Do
  not mutate a cached snapshot and write it back as though it were current.
- The `everytab-store` Web Lock is not reentrant. Do not call another operation
  that takes the same lock from inside its callback. Use the existing commit
  path so records, journal entries, and outbox changes stay consistent.
- Persist a recoverable saved record before closing a browser tab. Revalidate
  the live tab identity immediately before the close. Numeric tab IDs alone
  are insufficient after navigation, reload, or browser restart.
- Preserve exact target identity for Undo and partial failures. Do not report
  whole-action success when only some requested browser effects completed.
- Library and Recovery transactions are separate. Folder publication and
  Chrome tab actions are also separate effects. Never describe them as one
  atomic transaction.
- Do not rename existing database names, serialized keys, discriminators, or
  file-format fields to tidy the source. Versioned source names can be cleaned
  up without changing those data contracts.

## Privacy and lifecycle

Keep incognito provenance through every capture and restore path. Do not read
personal Vaults, browser databases, or browsing history for a development test.
Use fixtures. Logs must not contain page URLs, titles, user text, or raw error
messages that may embed them. Prefer an operation label and an allowlisted
error class.

Register Chrome event listeners once. Keep asynchronous event work retained
through the existing owners. Do not add startup work ahead of suspended-tab
recovery without measuring first-visible recovery and testing lifecycle races.

## UI and language

Use existing list/picker/action components and semantic tokens. Maintain fast
keyboard paths, visible focus, reduced-motion behavior, and layout at narrow
widths. Use short, concrete language suitable for non-native English readers.
Do not use em dashes in product copy. Avoid claims such as "nothing can ever
be lost" when a feature saves addresses but cannot save page contents.

## Evidence and housekeeping

Run focused behavior tests and the portable gate described in [TESTING.md](TESTING.md).
A source-text assertion proves source shape, not UI behavior. A mock proves its
contract, not Chrome timing. Record exactly which kind of check ran.

Keep maintained tools in `tools/`, test fixtures in `extension/test/`, and
runtime code in `extension/js/`. Move superseded work to a dated archive with
original-path mappings and verified hashes. Never delete historical documents
or one-off studies. [Archive procedure](archive/README.md).

Keep current guides short and replace their state instead of prepending another
history block. Store detailed receipts in `review-evidence/`. Do not generate
release candidates, packages, or publish changes without explicit approval.
