# EveryTab open-source license, publication, and trademark research

**Prepared:** 2026-08-06  
**Scope:** Decision support, not legal advice. Primary and official sources only.

**Decision status, 2026-08-06.** The user accepted MPL-2.0 for code, a curated
exact-release public repository, inbound-equals-outbound contributions without
a launch CLA, and a separate friendly trademark policy. Formal trademark
registration is not settled. The current recommendation is to complete free
preliminary clearance now (not a substitute for professional similarity
analysis) and defer paid filing until actual traction, publicity, contributor
interest, or marketing investment makes the cost proportionate.

## Executive recommendation

Use **MPL-2.0** for EveryTab's code.

It is the best fit between two project goals that pull in different directions:

1. EveryTab should be genuinely reusable, auditable, and contributor-friendly.
2. A distributor that modifies an existing EveryTab source file and ships the
   result should make that file's source available under MPL-2.0.

MPL-2.0 is file-level copyleft. Modified covered files remain open when
distributed, while separate new files and a larger combined product may use
other terms. It also includes an express contributor patent grant and excludes
trademark rights. Mozilla's official FAQ describes this boundary directly and
specifically addresses JavaScript distribution. [MPL-2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)

This is more protective than MIT or Apache-2.0 without GPL-3.0's project-wide
copyleft. It will not prevent commercial redistribution, charging money,
clean-room competitors, or every possible proprietary wrapper. No OSI open
source license can prohibit commercial use: free redistribution and use in any
field are part of the Open Source Definition. [Open Source Definition](https://opensource.org/osd)

Keep the **EveryTab name, wordmark, pointed teal stack-and-keeper mark, and
product icon governed by a separate trademark policy**. Open code does not mean
that forks may present themselves as official EveryTab releases.

## Decision matrix

| License | Commercial use and redistribution | What a distributed fork must publish | Patent position | Fit for EveryTab |
|---|---|---|---|---|
| **MIT** | Permits use, modification, sublicensing, sale, and redistribution | Nothing beyond retaining the copyright and permission notice | No express patent grant in the license text | Simplest and lowest-friction, but permits a fully closed commercial fork of EveryTab |
| **Apache-2.0** | Permissive, including commercial redistribution and differently licensed derivatives | No source-release duty; preserve the license and applicable notices, and mark changed files | Express contributor patent grant with patent-litigation termination | Best permissive option; preferable to MIT if EveryTab decides that maximum reuse matters more than keeping distributed improvements open |
| **MPL-2.0** | Permits commercial use, sale, and distribution | Source for MPL-covered files, including modifications to them; separate new files may remain under other terms | Express contributor patent grant with patent-litigation termination | **Recommended balance**: precise file-level reciprocity, manageable compliance, flexible larger works |
| **GPL-3.0** | Permits commercial sale and redistribution | The covered work and a derivative program as a whole must remain GPL when conveyed; object-code distribution requires Corresponding Source | Express patent protections and termination provisions | Strongest protection against closed derivative extensions, but broader obligations and more compatibility/contribution friction than EveryTab appears to need |
| **AGPL-3.0** | Same commercial freedom as GPL | GPL-style duties plus source access for users interacting remotely with a modified networked version | Similar GNU patent framework | No material benefit for the present local extension; relevant only if covered server software is operated over a network |

Primary texts: [MIT](https://opensource.org/license/mit),
[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/),
[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html), and
[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html).

### MIT

MIT gives recipients broad rights to use, copy, modify, merge, publish,
distribute, sublicense, and sell the software, subject mainly to preserving the
notice. It does not require source publication or contain an express patent
grant. A company could therefore ship a closed modified EveryTab, provided it
kept the required notice. [OSI MIT text](https://opensource.org/license/mit)

Choose MIT only if the priority is the shortest familiar permission grant and
EveryTab is comfortable receiving no reciprocal source obligation.

### Apache-2.0

Apache-2.0 is also permissive, but is more explicit. Contributors grant
copyright and patent licenses; a recipient who starts specified patent
litigation loses the patent license for that work. Redistributors must include
the license, mark modified files, preserve applicable notices, and reproduce a
project `NOTICE` file if one exists. Derivatives may be distributed under
different terms. Section 6 expressly withholds trademark permission except for
reasonable description of origin and reproduction of notices.
[Apache-2.0 sections 2-6](https://www.apache.org/licenses/LICENSE-2.0)

If the user ultimately rejects copyleft, Apache-2.0 is the recommended fallback
over MIT because its patent, contribution, notice, and trademark provisions
are clearer.

### MPL-2.0

MPL-2.0 defines a Modification at file level: changing a covered source file,
or creating a file that contains covered code, keeps that file covered. New
files containing no MPL code can use other terms, even in a proprietary Larger
Work. When covered software is distributed in executable form, its source must
also be made available and recipients must be told how to obtain it. The
executable or larger work may otherwise use different terms that do not limit
the recipient's MPL rights. [MPL-2.0 sections 1.10 and 3](https://www.mozilla.org/en-US/MPL/2.0/)

For EveryTab, plain HTML, CSS, and JavaScript are already the preferred form for
modification. Mozilla says minified JavaScript is executable form, not source;
EveryTab's zero-build, unminified package avoids that distinction today.
[Mozilla MPL FAQ, questions 8-17](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)

MPL does not force private modifications to be published. Obligations arise on
external distribution. It also cannot stop a third party from charging for a
fork. Its practical value is that recipients of a distributed modified fork
can obtain the modified covered files.

### GPL-3.0

GPL-3.0 applies stronger copyleft to a covered program and works based on it,
not merely to modified files. A conveyed modified work must carry notices and
be licensed as a whole under GPL-3.0. When object code is conveyed, the
Corresponding Source needed to modify, build, install, and run it must be made
available through one of the license's permitted routes. GPL permits selling
copies; copyleft concerns recipients' freedoms, not price.
[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html),
[GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)

Because EveryTab ships source-form JavaScript with no build, source compliance
would be simpler than for a compiled application. The remaining cost is the
broader derivative-work boundary and the care needed when combining code under
other licenses. GPL-3.0 is defensible if the user's overriding goal becomes
"every distributed derivative extension must stay open." It is stronger than
the current adoption-first brief requires.

### Why AGPL-3.0 does not help the local extension

AGPL-3.0 adds section 13: if a modified covered program lets users interact
with it remotely over a network, those users must be offered its Corresponding
Source. GNU describes this as the distinction from GPL for modified software
run as a network service. [AGPL-3.0 section 13](https://www.gnu.org/licenses/agpl-3.0.html),
[GNU GPL FAQ on network services](https://www.gnu.org/licenses/gpl-faq.html#UnreleasedMods)

EveryTab runs locally and its client code is delivered to the user. There is no
EveryTab-hosted application whose server modifications could be hidden from
remote users. AGPL therefore adds complexity without closing a present gap. A
future hosted service can receive its own license decision if it is actually
built.

### Short note on EUPL-1.2

EUPL-1.2 is a legitimate Europe-native option. It is an official EU open-source
license, available as equally authoritative text in 23 EU languages. It is
reciprocal, covers network communication, and contains an outbound
compatibility mechanism for named licenses including GPL-3.0, AGPL-3.0, and
MPL-2.0. [European Commission EUPL overview](https://commission.europa.eu/about/departments-and-executive-agencies/digital-services/open-source-strategy-history/european-union-public-licence_en),
[official EUPL-1.2 text and language versions](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12),
[official EUPL introduction](https://interoperable-europe.ec.europa.eu/collection/eupl/introduction-eupl-licence)

It does not materially improve the fit for this local extension. Its network
coverage is unnecessary today, while MPL provides a more precise file-level
boundary and official JavaScript-specific guidance. The judgment that EUPL
would create more recognition and compatibility explanation for likely
extension contributors is a practical inference, not a legal defect in EUPL.
Use EUPL only if multilingual EU-native governance itself becomes a leading
project value.

## Chrome Web Store implications

The reviewed Chrome Web Store rules do not impose a particular open-source
license or prohibit copyleft. They require readable, non-obfuscated code and,
for Manifest V3, functionality that is discernible from submitted code.
[Chrome Web Store technical requirements](https://developer.chrome.com/docs/webstore/program-policies/policies)

The Developer Agreement matters separately:

- The publisher grants Google rights needed to host, test, display, and
  distribute the product.
- The agreement supplies users a default use license, but says a separate EULA
  included in the product may govern instead.
- The publisher promises it has the rights necessary to make those grants.
- Google and the developer retain their separate brand features.

[Chrome Web Store Developer Agreement, sections 5-6](https://developer.chrome.com/docs/webstore/program-policies/terms)

Practical conclusion: put the selected open-source license inside the extension
package and make it conspicuous in About and the listing, rather than relying
only on the Store's default user license. Maintain a public exact-version source
link. Nothing in the reviewed policy creates a categorical MPL or GPL ban.

For GPL specifically, have counsel or an experienced open-source reviewer
confirm that the Store agreement's direct license grants are compatible once
third-party GPL contributions exist. This is not an identified prohibition; it
is a rights-chain question created by the publisher's promise that it can grant
the Store all specified rights. MPL-2.0's executable-form flexibility makes it
the cleaner copyleft choice here.

## Source-publication plan

Do not publish the current working directory blindly. It contains internal
planning, local tool settings, screenshots, research, performance fixtures, and
large campaign-working files in addition to the extension. First audit it for
private information, third-party material, and assets that should not be part
of the public product source.

Recommended launch structure:

1. Create a curated public repository, ideally `everytabapp/everytab`, whose
   canonical product source is the `extension/` tree plus tests, public-facing
   documentation, contribution instructions, and required notices.
2. Add the unmodified official license text as root `LICENSE`, identify it as
   `MPL-2.0` in the README and repository metadata, and use the MPL Exhibit A
   notice or `SPDX-License-Identifier: MPL-2.0` where appropriate. MPL permits a
   likely-to-be-found license location when per-file notices are undesirable.
   [MPL FAQ, questions 1 and 27](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
3. Add `TRADEMARKS.md`, `CONTRIBUTING.md`, `SECURITY.md`, and a third-party
   notices file if the dependency and asset audit finds anything requiring it.
4. Tag every Chrome Web Store release, beginning with the public v1 release.
   Keep the exact unminified source for every published package available. Link
   that tagged source from Settings > About, the public website, and the Store
   listing.
5. Generate the Store ZIP only from the tagged public source. Record its version
   and checksum. Because EveryTab has no build step, a reviewer should be able
   to compare the packaged files directly with the tag.
6. Keep private planning and local agent configuration outside the public
   release mirror. Document the one-way publication procedure so a future
   release does not silently omit source or expose local files.

MPL's source duty is owed to recipients when covered executable form is
distributed. A stable public tag is the simplest practical method, even though
the current unminified extension package itself consists largely of source.

## Contributions and dual licensing

Use a simple **inbound equals outbound** contribution rule: contributions are
submitted under MPL-2.0. Explain that in `CONTRIBUTING.md` and require
contributors to affirm they have the right to submit their work. A lightweight
Developer Certificate of Origin process can record provenance if contributions
grow. Do not add a contributor copyright assignment at launch without a real
need.

Dual licensing is not useful for the settled model:

- There is no proprietary paid edition or commercial embedding offer to
  justify maintaining a separate commercial license.
- Offering the same code under both MPL and a permissive license would let a
  recipient choose the permissive route and would nullify the intended
  reciprocity.
- MPL-2.0 already has a Secondary Licenses mechanism for combining eligible
  covered code into GPL-family larger works, unless the project deliberately
  marks it incompatible. EveryTab should not add MPL Exhibit B.
  [MPL-2.0 sections 1.5, 1.12, and 3.3](https://www.mozilla.org/en-US/MPL/2.0/)

One future constraint should be accepted knowingly: once outside contributors
own copyright in accepted patches, relicensing the whole project under
incompatible terms can require their permission unless a contributor agreement
gave broader rights. That is a reason to choose MPL carefully now, not a reason
to impose a high-friction CLA for a hypothetical business model.

## Copyright license and EveryTab trademark are separate

Copyright licensing answers who may copy and modify the code and artwork.
Trademark law answers whether a name or symbol identifies the source of a
product and whether another use is likely to confuse users. MPL itself grants no
rights in contributor trademarks, service marks, or logos except as necessary
for license notices. [MPL-2.0 section 2.3](https://www.mozilla.org/en-US/MPL/2.0/)

Adopt a short, friendly trademark policy with these rules:

- `EveryTab`, the EveryTab wordmark, pointed teal stack-and-keeper mark, and
  official product icon identify the official project and releases.
- Truthful textual references such as "forked from EveryTab," "based on
  EveryTab," and compatibility statements are allowed when they do not imply
  sponsorship.
- A modified distribution must choose a distinct product name and replace the
  official wordmark and product icon. It may give accurate attribution in text.
- No confusing product, extension, publisher, package, or domain name may use
  the EveryTab marks without permission.
- Unmodified redistribution, community events, merchandise, and prominent logo
  use should have explicit, simple rules and a contact route.

Mozilla's official policy demonstrates why an open-source project can allow
code modification while requiring modified products to use their own identity.
Apache's policy similarly distinguishes nominative reference from confusing
product branding. [Mozilla Trademark Guidelines](https://www.mozilla.org/en-US/foundation/trademarks/policy/),
[Apache Trademark Policy](https://www.apache.org/foundation/marks/)

Brand files needed to display the official unmodified extension may remain in
the source repository. The policy should state that their copyright license
does not grant permission to use them as source-identifying marks for a fork.

## France and EU registration basics

A repository trademark policy is useful, but registration determines stronger
territorial rights. Before filing, search not only exact matches but similar
word, sound, meaning, logo, company-name, and domain rights in the relevant
goods and services. INPI explicitly recommends similarity research beyond its
free identical-name search. [INPI availability guidance](https://www.inpi.fr/disponibilite-dune-marque-dun-logo-dun-nom-de-societe-dun-nom-de-domaine)

Protection choices are territorial:

- An INPI filing covers France.
- One EUIPO application can cover all EU Member States; the basic online fee is
  EUR 850 for one class and protection lasts ten years, renewable. EUIPO notes
  that an EU mark is unitary, so a problem in part of the EU can defeat the EU
  application, subject to possible conversion to national applications.
  [EUIPO: where to register](https://www.euipo.europa.eu/en/trade-marks/before-applying/where-to-register),
  [EUIPO fees](https://www.euipo.europa.eu/en/trade-marks/before-applying/fees-payments)
- Goods and services must be selected by Nice class; protection is tied to the
  filed sign, territory, and specified goods/services. The exact classes for a
  downloadable browser extension, related documentation, and any future hosted
  service should be professionally checked.

For a limited budget, the word mark `EveryTab` is normally the first filing to
evaluate because it is not tied to one rendering of the logo. That is a product
recommendation, not a legal conclusion. Run a proper clearance search before
filing or widening the launch. Register the logo separately later if its extra
protection justifies another filing. Do not use the registered symbol until the
mark is actually registered; EUIPO warns that using it on an unregistered mark
can have legal consequences. [EUIPO registration guidance](https://www.euipo.europa.eu/en/trade-marks/after-applying/registration)

## Recommended decision wording

> EveryTab's source code is released under the Mozilla Public License 2.0.
> Distributed modifications to MPL-covered files remain available under the
> same license, while separate works may use other terms. EveryTab's name,
> wordmark, pointed teal stack-and-keeper mark, and product icon identify the
> official project and are governed by the separate EveryTab trademark policy.
> All local v1 features remain free; neither the source license nor the
> trademark policy creates a paid product tier.

## Questions that remain for legal review

1. Who is the precise copyright owner today: the individual creator, a company,
   or multiple contributors, including any ownership implications from tools
   used to generate code and art?
2. Does every icon, font, fixture, screenshot, imported sample, and campaign
   asset intended for the public repository have a documented compatible
   provenance and license?
3. Does putting the MPL license in the extension and linking the exact tagged
   source satisfy the current Chrome Web Store agreement cleanly, especially
   after third-party contributions are accepted?
4. What exact boundary should `TRADEMARKS.md` draw for unmodified mirrors and
   screenshots without making ordinary discussion or attribution burdensome?
5. Is `EveryTab` available after professional similarity searches in the
   relevant French, EU, and other launch territories and classes?
6. Should the first registration cover France only or the EU, and should it be
   a word mark, figurative mark, or both?
7. Is any contributor agreement needed for the expected contribution model, or
   is MPL-2.0 plus an inbound-equals-outbound/DCO process sufficient?
8. If a hosted service is later built, is it a separate work with its own
   license, or derived from covered extension code in a way that changes the
   analysis?
