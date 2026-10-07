# EveryTab

EveryTab is a free, local-first Chrome extension for keeping browser tabs
organized. Save pages to Inbox, arrange Sessions, apply Labels, snooze pages,
suspend unused tabs and find anything again with one search. An optional Vault
keeps a second copy in a folder you control. There is no EveryTab account,
server, analytics or telemetry; your data stays on your device.

## Install

- **Chrome Web Store**: https://chromewebstore.google.com/ (official listing;
  the link is updated on launch day).
- **From source** (any version in this repository):
  1. Open `chrome://extensions` and enable Developer mode.
  2. Choose **Load unpacked** and select the `extension/` directory.
  3. Reload the extension after changing its source.

There is no build step and no package installation. The runtime version is the
`version` field in `extension/manifest.json`; releases are tagged with the same
number.

## Project map

- `extension/`: the extension. `js/` holds the runtime modules, `css/` the
  styles, `_locales/` the message catalogues, `test/` the test suites.
- `tools/`: the test runner, inventory validator, browser harnesses, codebase
  guide generator and the Chrome Web Store packager. See [tools/README.md](tools/README.md).
- `site/`: the public landing copy and [privacy policy](site/privacy.md).
- `docs/`: [localization glossary](docs/localization/fr-glossary.md) and the
  [open-source license research](docs/launch/open-source-license-research.md).

Guides:

- [Architecture](ARCHITECTURE.md): how the parts fit together, with a beginner's map.
- [Engineering](ENGINEERING.md): boundaries and safety rules for changes.
- [Testing](TESTING.md): automated checks and what still needs Chrome.
- [Product](PRODUCT.md), [design system](DESIGN.md) and [domain terms](CONTEXT.md).
- [Changelog](CHANGELOG.md): every runtime version.
- [Beginner's codebase guide](CODEBASE-GUIDE.md), [searchable file explorer](CODEBASE-EXPLORER.html)
  and [source atlas](CODEBASE-ATLAS.json): generated from the current source by
  `node tools/build-codebase-guide.mjs --write`. The test gate checks that they
  are current.

## Run the tests

Node.js 22 is the supported version (`.nvmrc`). No dependencies are installed.

```sh
node tools/test.mjs --check-inventory   # every test/tool file has a decision
node tools/test.mjs                     # portable and performance suites
node tools/test.mjs --list              # executable suite IDs
node tools/test.mjs --lane browser      # real Chrome; set CHROME_BIN if needed
```

[test-inventory.json](test-inventory.json) drives both local runs and CI
(`.github/workflows/extension-cross-platform.yml`). Browser suites use
disposable profiles and synthetic data only. Never run tests against a personal
Vault or browser profile.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. It covers
the test gate, the data-contract rules and the licensing of contributions.
Report security issues privately as described in [SECURITY.md](SECURITY.md).
This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

User-facing language should be short, concrete and understandable
internationally; avoid em dashes, marketing filler and internal milestone codes.

## License and trademarks

EveryTab's source code is licensed under the [Mozilla Public License 2.0](LICENSE).
Copyright 2026 Hadrien Gelas and EveryTab contributors.

The EveryTab name, wordmark, pointed teal stack-and-keeper mark and product
icons identify the official project and are not covered by the code license.
See [TRADEMARKS.md](TRADEMARKS.md).
