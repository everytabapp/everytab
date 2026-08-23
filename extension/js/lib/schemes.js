/** D3 — one DOM-free source of truth for scheme identity and behavior. */
const BUILT_IN_SCHEME_META = {
  cream:      { label: "Cream",       accent: "#bc5f3c", defaultMode: "light" },
  candy:      { label: "Candy",       accent: "#7b2ff7", defaultMode: "light" },
  solarized:  { label: "Solarized",   accent: "#268bd2", defaultMode: "light" },
  laser:      { label: "Laser",       accent: "#f425a9", defaultMode: "dark" },
  godspeed:   { label: "Godspeed",    accent: "#ee9b3a", defaultMode: "light" },
  cyberwave:  { label: "Cyberwave",   accent: "#8f7bff", defaultMode: "dark" },
  sunset:     { label: "Sunset Surf", accent: "#ffa305", defaultMode: "light" },
  nautilus:   { label: "Nautilus",    accent: "#f5c14e", defaultMode: "dark" },
  easter:     { label: "Easter",      accent: "#a678cf", defaultMode: "light" },
  ink:        { label: "Ink",         accent: "#575044", defaultMode: "light" },
  ember:      { label: "Ember",       accent: "#b3402e", defaultMode: "light" },
  phosphor:   { label: "Phosphor",    accent: "#3fd96b", defaultMode: "dark" },
  tide:       { label: "Tide",        accent: "#177f72", defaultMode: "light" },
  meadow:     { label: "Meadow",      accent: "#4f7a33", defaultMode: "light" },
  forest:     { label: "Forest",      accent: "#58a072", defaultMode: "dark" },
  nord:       { label: "Nord",        accent: "#88c0d0", defaultMode: "dark" },
  gruvbox:    { label: "Gruvbox",     accent: "#fe8019", defaultMode: "dark" },
  matcha:     { label: "Matcha",      accent: "#52732a", defaultMode: "light" },
  dracula:    { label: "Dracula",     accent: "#bd93f9", defaultMode: "dark" },
  tokyonight: { label: "Tokyo Night",    accent: "#7aa2f7", defaultMode: "dark" },
  one:        { label: "One",            accent: "#61afef", defaultMode: "dark" },
  miaminights:{ label: "Miami Nights",   accent: "#ff3d9a", defaultMode: "dark" },
  darling:    { label: "Darling",        accent: "#59091f", defaultMode: "light" },
  redsamurai: { label: "Red Samurai",    accent: "#f1bf52", defaultMode: "dark" },
  devtty:     { label: "/dev/tty",       accent: "#d94843", defaultMode: "light" },
  frozenllama:{ label: "Frozen Llama",   accent: "#0f638f", defaultMode: "light" },
  goodnight:  { label: "Good Night",     accent: "#e0bd5d", defaultMode: "light" },
  oblivion:   { label: "Oblivion",       accent: "#39789a", defaultMode: "light" },
  chocolatier:{ label: "Chocolatier",    accent: "#d9a441", defaultMode: "dark" },
  perestroika:{ label: "Perestroika",    accent: "#d9ae72", defaultMode: "dark" },
  metropolis: { label: "Metropolis",     accent: "#37c7d4", defaultMode: "dark" },
  hineybeige: { label: "Hiney Beige",    accent: "#5f5546", defaultMode: "light" },
  taiga:      { label: "Taiga",          accent: "#72bc87", defaultMode: "dark" },
  bushido:    { label: "Bushido",        accent: "#f4646e", defaultMode: "dark" },
  dasher:     { label: "Dasher",         accent: "#4bc6dd", defaultMode: "dark" },
  jamon:      { label: "Jamón",          accent: "#e34b4f", defaultMode: "dark" }
};

// Built-ins are release fixtures, not editable scheme records. Freeze each
// entry as well as the portfolio so the Lab and QA cannot mutate a swatch or
// canonical mode through a shared object reference.
export const SCHEME_META = Object.freeze(Object.fromEntries(
  Object.entries(BUILT_IN_SCHEME_META).map(([id, meta]) => [id, Object.freeze(meta)])
));

export const SCHEMES = Object.freeze(Object.keys(SCHEME_META));
export const SCHEME_LABELS = Object.freeze(Object.fromEntries(
  SCHEMES.map((id) => [id, SCHEME_META[id].label])
));
export const SCHEME_ACCENTS = Object.freeze(Object.fromEntries(
  SCHEMES.map((id) => [id, SCHEME_META[id].accent])
));

/**
 * One exclusive 2×2 browsing model for the built-in portfolio. Rows describe
 * the scheme's authored default mode; columns describe its visual energy.
 * Custom schemes stay in Yours because their portable format does not claim a
 * Soft/Vivid classification.
 */
export const SCHEME_GROUPS = Object.freeze([
  Object.freeze({ id: "light-soft", label: "Light default · Soft",
    defaultMode: "light", tone: "soft", ids: Object.freeze([
    "cream", "devtty", "goodnight", "hineybeige", "ink", "matcha", "meadow",
    "oblivion", "solarized", "tide"
  ]) }),
  Object.freeze({ id: "light-vivid", label: "Light default · Vivid",
    defaultMode: "light", tone: "vivid", ids: Object.freeze([
    "candy", "darling", "easter", "ember", "frozenllama", "godspeed", "sunset"
  ]) }),
  Object.freeze({ id: "dark-soft", label: "Dark default · Soft",
    defaultMode: "dark", tone: "soft", ids: Object.freeze([
    "bushido", "chocolatier", "dasher", "dracula", "forest", "gruvbox",
    "metropolis", "nord", "one", "taiga", "tokyonight"
  ]) }),
  Object.freeze({ id: "dark-vivid", label: "Dark default · Vivid",
    defaultMode: "dark", tone: "vivid", ids: Object.freeze([
    "cyberwave", "jamon", "laser", "miaminights", "nautilus", "perestroika",
    "phosphor", "redsamurai"
  ]) })
]);

/** Permanent compatibility boundary for technically-live pre-beta installs. */
export function normalizeScheme(id) {
  const canonical = {
    everforest: "matcha",
    catppuccin: "dracula",
    rosepine: "dracula"
  }[id] ?? id;
  return SCHEMES.includes(canonical) ? canonical : "cream";
}

/** Resolve the stored mode without requiring window.matchMedia in tests/workers. */
export function resolveSchemeMode(uiMode, scheme, prefersDark = false) {
  if (uiMode === "light" || uiMode === "dark") return uiMode;
  if (uiMode === "scheme") return SCHEME_META[normalizeScheme(scheme)].defaultMode;
  return prefersDark ? "dark" : "light";
}
