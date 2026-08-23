/** Browser-test adapter for Chrome's packaged i18n catalogue. */
export async function createBrowserI18nMock() {
  const url = new URL("../_locales/en/messages.json", import.meta.url);
  let messages;
  if (url.protocol === "file:") {
    const request = new XMLHttpRequest();
    request.open("GET", url.href, false);
    request.send();
    messages = JSON.parse(request.responseText);
  } else {
    const response = await fetch(url);
    messages = await response.json();
  }
  return {
    getMessage(key, substitutions = []) {
      if (key === "@@ui_locale") return "en";
      if (key === "@@bidi_dir") return "ltr";
      const entry = messages[key];
      if (!entry) return "";
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      let value = entry.message;
      for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
        const index = Number(placeholder.content.slice(1)) - 1;
        value = value.replaceAll(`$${name.toUpperCase()}$`, String(values[index] ?? ""));
      }
      return value;
    }
  };
}
