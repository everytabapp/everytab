/** Load Chrome-style English messages in browser fixtures before production UI renders. */
export async function createBrowserI18nMock() {
  const url = new URL("../_locales/en/messages.json", import.meta.url);
  let messages;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Message catalogue returned ${response.status}`);
    messages = await response.json();
  } catch {
    messages = await new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", url.href);
      request.onload = () => {
        try { resolve(JSON.parse(request.responseText)); }
        catch (error) { reject(error); }
      };
      request.onerror = () => reject(new Error("Could not load the English message catalogue"));
      request.send();
    });
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
