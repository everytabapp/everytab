const variants = [
  { id: "A", name: "Quiet crossfade", note: "Recommended baseline. The fixed button changes state with one short icon-and-label crossfade." },
  { id: "B", name: "Vertical handoff", note: "Start Focus leaves upward and End Focus rises into the same fixed slot." },
  { id: "C", name: "Icon transform", note: "The label crossfades while the play mark contracts and the stop mark settles into place." },
  { id: "D", name: "Accent sweep", note: "The accent fill moves through the button from left to right, then reveals the active label." },
  { id: "E", name: "Perimeter pulse", note: "The state changes directly, then the control emits one restrained accent halo before settling." }
];

const nav = `<div class="nav-label">Now</div><div class="nav-row active">▣ Open tabs <span>132</span></div><div class="nav-row">⌑ Inbox <span>29</span></div><div class="nav-row">◷ Snoozed <span>8</span></div>
  <div class="nav-label">Saved</div><div class="nav-row">▤ Sessions <span>12</span></div><div class="nav-row">◇ Labels <span>57</span></div><div class="nav-row">□ Archive <span>621</span></div>
  <div class="nav-label">More</div><div class="nav-row">◉ Activity <span></span></div><div class="nav-row">⚙ Settings <span></span></div>`;
const rows = ["EveryTab motion review", "Focus-safe sites", "Chrome Web Store", "Research notes", "Keyboard interaction checklist"]
  .map((title, index) => `<div class="row"><span class="check"></span><span class="favicon"></span><span class="copy"><b>${title}</b><small>${index % 2 ? "docs.example.com" : "everytab.local"} · ${index + 2}m ago</small></span><span class="age">Open</span></div>`).join("");

const host = document.querySelector("#prototype");
const variantName = document.querySelector("#variant-name");
let active = false;

function currentIndex() {
  const raw = new URL(location.href).searchParams.get("variant")?.toUpperCase();
  const index = variants.findIndex((item) => item.id === raw);
  return index < 0 ? 0 : index;
}

function markup(item) {
  return `<section class="stage"><div class="dashboard variant-${item.id.toLowerCase()}">
    <aside class="sidebar"><div class="brand"><span class="mark">✳</span>EveryTab</div>${nav}</aside>
    <section class="canvas">
      <div class="utility-shell"><div class="utility"><div class="search">Search open, saved, and browser History...</div><span class="needs">Needs you&nbsp; 2</span>
          <div class="focus-control"><button class="focus-main" type="button" aria-pressed="false">
            <span class="focus-label off"><span class="play"></span><span>Start Focus</span></span><span class="focus-label on"><span class="stop"></span><span>End Focus</span></span>
          </button><button class="focus-settings" type="button" aria-label="Focus settings">☷</button></div>
        </div></div>
      <div class="focus-slot"><div class="focus-slot-inner"><div class="focus-band"><strong>Focus active</strong><span>3 guarded sites</span><span class="timer">24:58</span><button type="button">End Focus</button></div></div></div>
      <div class="workspace"><div class="section-line"><h1>Open tabs</h1><p>132 in 5 windows</p></div><div class="window"><div class="window-head">Window 4 <small>(current window)</small></div>${rows}</div></div>
      <p class="note"><strong>Shared band:</strong> the page opens at one seam, the Focus band settles into it, and two centre-drawn rails glow once. <strong>${item.name}:</strong> ${item.note}</p>
    </section></div></section>`;
}

function setActive(next) {
  active = next;
  const dashboard = document.querySelector(".dashboard");
  dashboard?.classList.toggle("focus-on", active);
  document.querySelector(".focus-main")?.setAttribute("aria-pressed", String(active));
}

function render() {
  const item = variants[currentIndex()];
  active = false;
  host.innerHTML = markup(item);
  variantName.textContent = `${item.id} · ${item.name}`;
  document.querySelector(".focus-main").addEventListener("click", () => setActive(!active));
  document.querySelector(".focus-band button").addEventListener("click", () => setActive(false));
}

function move(delta) {
  const index = (currentIndex() + delta + variants.length) % variants.length;
  const url = new URL(location.href);
  url.searchParams.set("variant", variants[index].id);
  history.replaceState(null, "", url);
  render();
}

document.querySelector("#previous").addEventListener("click", () => move(-1));
document.querySelector("#next").addEventListener("click", () => move(1));
document.querySelector("#replay").addEventListener("click", () => {
  setActive(false);
  requestAnimationFrame(() => requestAnimationFrame(() => setActive(true)));
});
addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea, [contenteditable]")) return;
  if (event.key === "ArrowLeft") move(-1);
  if (event.key === "ArrowRight") move(1);
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActive(!active); }
});
render();
