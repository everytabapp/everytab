# Security policy

EveryTab runs entirely on your device. It has no server, account, analytics or
telemetry, so most security questions are about what the extension does with
tab data on the local machine and in the optional Vault folder.

## Report a vulnerability privately

Please do not open a public issue for a security problem. Use one of these
channels:

- GitHub private vulnerability reporting: open the **Security** tab of this
  repository and choose **Report a vulnerability**.
- Email: everytabapp@gmail.com

Include the EveryTab version (Settings > About, or `extension/manifest.json`),
your Chrome version and operating system, the steps to reproduce, and what an
attacker could gain. A minimal synthetic example is ideal.

## What not to send

Do not send your own tab library, Vault folder, browser profile, or real page
addresses and titles. Use made-up addresses such as `https://example.com/`.
Nothing you report should contain personal browsing data.

## Scope

In scope:

- The extension source in `extension/` and the tools it ships with.
- Handling of saved data, imports and exports, Vault files and recovery
  records, including anything that could corrupt or expose them.
- Any behavior that contradicts the privacy policy in `site/privacy.md`, for
  example an unexpected network request.

Out of scope:

- Chrome itself and third-party file sync services used with a Vault folder.
- Issues that require the attacker to already control the user's machine or
  browser profile.
- Forks that do not come from this repository.

## What to expect

EveryTab is maintained by one person in their spare time. Reports are handled
on a best-effort basis. You should normally receive an acknowledgement within
a week. Confirmed problems are fixed in the next release and noted in the
CHANGELOG without personal details. There is no bug bounty. We are happy to
credit reporters who want to be named.
