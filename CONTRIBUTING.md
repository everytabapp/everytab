# Contributing to EveryTab

Thank you for helping. EveryTab is a local-first Chrome extension written in
plain ES modules, CSS and Manifest V3. There is no build step, no bundler and
no runtime dependency. Keep it that way.

## Run it locally

1. Install Node.js 22 (see `.nvmrc`). Nothing needs `npm install`.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**
   and select the `extension/` directory.
3. Reload the extension after changing its source.

## Test gate

Run commands from the repository root.

```sh
node tools/test.mjs --check-inventory   # every test/tool file has a decision
node tools/test.mjs                     # portable and performance suites
node tools/test.mjs some-suite.mjs      # one suite by ID
node tools/test.mjs --lane browser      # needs Chrome; set CHROME_BIN if needed
```

[test-inventory.json](test-inventory.json) lists every file under
`extension/test/` and `tools/` with an execution or exclusion decision. A new
or moved file without an entry fails the gate. [TESTING.md](TESTING.md)
explains lanes, Chrome requirements and what each kind of check proves.

Some suites read source text to guard architecture rules (for example that a
page never imports a background owner). If a harmless rename fails one of
them, update the suite together with the change and say so in the PR.

After changing anything under `extension/`, `tools/` or `.github/`, run
`node tools/build-codebase-guide.mjs --write` and commit the regenerated
`CODEBASE-*` files. The portable gate checks that they are current.

## Rules that protect user data

The complete rules are in [ENGINEERING.md](ENGINEERING.md). In short:

- Database names, stored keys, discriminators and file-format fields are data
  contracts. Do not rename them to tidy the source.
- Read fresh state inside `mutateStores` for read-modify-write operations. The
  `everytab-store` Web Lock is not reentrant.
- Persist a recoverable saved record before closing a browser tab, and
  revalidate the live tab right before the close.
- Report partial failures as partial. Never describe Library, Recovery, Vault
  and Chrome tab effects as one atomic transaction.
- Logs must not contain page URLs, titles or user text.
- Use synthetic fixtures. Never test against a personal Vault or browser
  profile.

## Pull requests

- Keep PRs short and focused on one change. Large rewrites are hard to review
  and are unlikely to be merged as a whole.
- Describe what you tested and which kind of evidence it is: a Node suite with
  mocks, a source-text assertion, a real Chrome run or a manual check.
- Do not bump `extension/manifest.json` or edit `CHANGELOG.md`; the maintainer
  does that when a release is cut.
- Do not build or attach Store packages.
- Open an issue first for new features so we can agree on the behavior.

## UI copy

User-facing language is short, concrete and understandable for people who do
not read English every day. Do not use em dashes in product copy. Avoid
marketing filler and internal code names. Do not claim that nothing can be
lost: EveryTab saves addresses, not page contents. Keep keyboard and pointer
parity, visible focus and reduced-motion behavior. Reuse the shared controls
and semantic tokens described in [DESIGN.md](DESIGN.md).

## Adding a language

1. Copy `extension/_locales/en/messages.json` to `extension/_locales/<code>/`
   and translate every message. Keep keys and `$PLACEHOLDER$` tokens
   byte-identical to the English file.
2. Add the language code to `UI_LANGUAGE_VALUES` in `extension/js/lib/types.js`
   and to the Settings language choice.
3. Add a completeness suite modeled on
   `extension/test/locale-fr-completeness.mjs` and register it in the
   inventory.
4. Record glossary decisions in `docs/localization/`. Product names such as
   EveryTab stay untranslated; follow the browser's own vocabulary for Chrome
   features.

Please open an issue before starting a new language so the work is not
duplicated.

## License and ownership of contributions

EveryTab is licensed under the [Mozilla Public License 2.0](LICENSE). By
submitting a contribution you agree that it is licensed under MPL-2.0, the
same license as the project (inbound equals outbound). There is no
contributor license agreement and no copyright assignment. You must have the
right to submit the work; do not paste code or assets whose license you do
not know. A `Signed-off-by` line in commits is welcome but not required.

New source files carry the two-line header used across the project:

```js
// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0
```

The EveryTab name, wordmark, mark and icons are not covered by the code
license. See [TRADEMARKS.md](TRADEMARKS.md).

## Conduct and security

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Report
security issues privately as described in [SECURITY.md](SECURITY.md), never in
a public issue.
