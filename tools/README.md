# Maintained developer tools

`tools/` contains maintained local developer utilities and browser harnesses.
The shipped extension remains under `extension/`; harnesses should be served
from the repository root so their `../extension/` paths resolve correctly.

Use `node tools/test.mjs` for the portable and performance gate, `--list` for
its executable IDs, or one listed ID for a targeted run. `--list --all` shows
every classification, including helpers, browser qualification tools and manual
work. The root [test inventory](../test-inventory.json) supplies the same plans
to local runs and CI; the runner no longer extracts commands from workflow text.
It also checks runtime JavaScript syntax and parses the manifest on portable
lane runs. Every maintained test/tool file needs an inventory decision.

`tools/testing/` owns catalogue validation, platform/lane selection and their
regression tests. The runner rejects unclassified files, invalid arguments and
implicit package execution. [TESTING.md](../TESTING.md) documents lane commands,
Chrome requirements, platform exclusions and evidence limits. Inventory inclusion
alone does not mean a browser fixture or manual qualification has been run.

`node tools/build-codebase-guide.mjs --write` regenerates the root beginner guide,
file explorer and machine-readable source atlas. It preserves prior outputs by
verified hash under `archive/codebase-guides/` before replacement. The authored
introduction, per-runtime-file explanations, explorer template and nonexecuting
source scanner live in `tools/codebase/`. Update those inputs, not generated text.
Regenerate after source, tests, inventory or root-guide edits. There is no production
build step and this command never changes extension runtime files.

`node tools/build-codebase-guide.mjs --check` compares all three outputs without
writing; it also runs in the portable gate. The source scope is explicit, skips
symlinks and excludes generated outputs, archives, evidence and arbitrary root files.
Literal dependencies are useful navigation, not a complete call graph or test coverage.

`node tools/check-codebase-explorer.mjs` checks the root learning explorer in a
disposable Chrome profile: file search, filters, selection, relationships and
empty results, native keyboard activation and narrow layout. It starts its own localhost server.

`node tools/check-data-import.mjs` loads the unpacked extension into disposable
Chrome and checks import operation ownership with native IndexedDB and Web Locks.
It imports only synthetic URLs and creates no release package.

Packaging is paused and is never part of the default runner. Invoke packaging
tools explicitly only when that work is authorized. The obsolete
`vault-health-report.mjs` legacy-format diagnostic is archived; prefer the
current Vault diagnostics for normal health investigations.

Prototype and frozen evidence files are preserved under
`archive/2026-09-10-architecture-cleanup/extension/tools/` as historical records.
