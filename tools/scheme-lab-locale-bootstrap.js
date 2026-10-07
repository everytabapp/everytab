/* Provide Chrome's packaged message API when Scheme Lab runs from a file URL. */
(() => {
  if (globalThis.chrome?.i18n?.getMessage) return;

  const request = new XMLHttpRequest();
  request.open("GET", "../extension/_locales/en/messages.json", false);
  request.send();
  if (request.status !== 0 && request.status !== 200) {
    throw new Error(`Could not load Scheme Lab messages (${request.status}).`);
  }
  const catalogue = JSON.parse(request.responseText);
  const getMessage = (key, substitutions = []) => {
    const entry = catalogue[key];
    if (!entry?.message) return "";
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    let output = entry.message;
    for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
      const value = placeholder.content.replace(/\$(\d+)/g, (_, index) =>
        String(values[Number(index) - 1] ?? ""));
      output = output.replaceAll(`$${name.toUpperCase()}$`, value);
    }
    return output;
  };
  globalThis.chrome = { ...(globalThis.chrome ?? {}), i18n: { getMessage } };
})();
