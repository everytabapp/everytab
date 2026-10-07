import assert from "node:assert/strict";
import { faviconSource, cachedFaviconUrl } from "../js/ui/favicon-source.js";

globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://everytab${path}` } };
const pageUrl = "https://example.com/article?x=1&y=2#part";
const cache = cachedFaviconUrl(pageUrl);
assert.equal(new URL(cache).searchParams.get("pageUrl"), pageUrl);
assert.equal(new URL(cache).protocol, "chrome-extension:");
assert.equal(new URL(cache).pathname, "/_favicon/");
for (const captured of [
  "https://tracker.example/icon?recipient=fixture", "http://tracker.example/icon",
  "//tracker.example/icon", "javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
  "chrome-extension://other-extension/icon.png", "file:///tmp/icon.png", "garbage"
]) {
  const ref = Object.freeze({ url: pageUrl, favIconUrl: captured });
  assert.equal(faviconSource(ref), cache, "untrusted sources never become a network image source");
  assert.equal(ref.favIconUrl, captured, "stored identity is left intact");
}
for (const captured of [
  "data:image/png;base64,iVBORw0KGgo=",
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
  "chrome-extension://everytab/icon.png", cache
]) assert.equal(faviconSource({ url: pageUrl, favIconUrl: captured }), captured);
for (const url of ["javascript:alert(1)", "data:text/html,hello", "file:///tmp/test", "garbage", ""]) {
  assert.equal(cachedFaviconUrl(url), "");
  assert.equal(faviconSource({ url, favIconUrl: "https://tracker.example/icon" }), "");
}
delete globalThis.chrome;
assert.equal(faviconSource({ url: pageUrl }), "", "fixtures without Chrome keep their fallback");
console.log("PASS: favicon display restricts sources to embedded or extension-local images");
