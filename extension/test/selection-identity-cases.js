/** Shared mounted-list cases for the portable DOM and Chromium fixtures. */
import { clearSelection, createTabList } from "../js/ui/tablist.js";

/** @param {{host:HTMLElement,click:(node:HTMLElement)=>unknown}} options */
export async function exerciseSelectionIdentity({ host, click }) {
  let sequence = 0;
  const ref = (name, extras = {}) => ({ title: name, url: `https://${name}.test/`, ...extras });
  const flat = (id, names) => ({ id, title: id, meta: "tabs", refs: names.map((name) =>
    typeof name === "string" ? ref(name) : name), loose: false });
  const nested = (windows) => ({ id: "session", title: "Session", meta: "tabs",
    windows: windows.map((names) => ({ refs: names.map((name) => ref(name)) })) });
  const equal = (actual, expected, message) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const mount = (groups, extra = {}) => {
    const section = `selection-identity-${++sequence}`;
    clearSelection(section);
    let list;
    let submitted = [];
    const render = (nextGroups) => {
      list = createTabList({ section, groups: nextGroups, selectable: "tab", rowCap: 20,
        rowActions: [], groupActions: [], windowActions: [], onChange() {},
        bulkActions: (context) => {
          const button = document.createElement("button");
          button.dataset.bulkAction = "copy";
          button.setAttribute("data-bulk-action", "copy");
          button.addEventListener("click", () => {
            submitted = context.selection.flatMap((entry) => entry.picks
              ? entry.picks.flatMap((pick) => pick.indexes.map((index) =>
                entry.group.windows[pick.windowIndex].refs[index].url))
              : entry.indexes.map((index) => entry.group.refs[index].url));
          });
          return [button];
        }, ...extra });
      host.replaceChildren(list);
    };
    render(groups);
    return {
      render,
      select: async (index) => click(list.querySelectorAll(".trow")[index]),
      selected: () => [...list.querySelectorAll(".trow.sel")].map((row) => row._tlRow.ctx.ref.url),
      submit: async () => {
        const button = list.querySelector('[data-bulk-action="copy"]');
        if (!button) throw new Error("Expected a surviving selection action");
        await click(button);
        return submitted;
      }
    };
  };

  // The original review repro: selecting B must never become an action on C.
  let view = mount([flat("saved", ["a", "b", "c"])]);
  await view.select(1);
  view.render([flat("saved", ["b", "c"])]);
  equal(view.selected(), [], "removing an earlier saved occurrence clears the affected selection");

  view = mount([flat("saved", ["a", "b", "c"]), flat("unaffected", ["d"])]);
  await view.select(1);
  await view.select(3);
  view.render([flat("saved", ["c", "a", "b"]), flat("unaffected", ["d"])]);
  equal(view.selected(), [ref("d").url], "reordering one saved group retains other groups' selections");
  equal(await view.submit(), [ref("d").url], "the surviving bulk action receives only the unaffected occurrence");

  const inPlace = flat("saved", ["a", "b", "c"]);
  view = mount([inPlace]);
  await view.select(1);
  inPlace.refs.splice(0, 1);
  view.render([inPlace]);
  equal(view.selected(), [], "in-place mutation cannot rewrite the stored selection comparison");

  for (const changed of [[["b", "c"]], [["c"], ["a", "b"]], [["a"], ["b", "c"]]]) {
    view = mount([nested([["a", "b"], ["c"]])]);
    await view.select(1);
    view.render([nested(changed)]);
    equal(view.selected(), [], "nested deletion, window reorder and boundary changes clear selection");
  }

  const mutableSession = nested([["a", "b"], ["c"]]);
  view = mount([mutableSession]);
  await view.select(1);
  mutableSession.windows[0].refs.splice(0, 1);
  view.render([mutableSession]);
  equal(view.selected(), [], "nested in-place edits cannot rewrite the stored layout");

  const renamedSession = nested([["a", "b"], ["c"]]);
  view = mount([renamedSession]);
  await view.select(1);
  renamedSession.title = "Renamed session";
  renamedSession.windows[0].refs[1].title = "New page title";
  renamedSession.windows[0].refs[1].labels = ["Work"];
  view.render([renamedSession]);
  equal(view.selected(), [ref("b").url], "nested title and label edits retain the chosen occurrence");
  equal(await view.submit(), [ref("b").url], "nested bulk payload keeps the exact chosen URL");

  const firstDuplicate = ref("duplicate", { title: "First", labels: ["first"] });
  const secondDuplicate = ref("duplicate", { title: "Second", labels: ["second"] });
  view = mount([flat("saved", [firstDuplicate, secondDuplicate])]);
  await view.select(0);
  view.render([flat("saved", [secondDuplicate, firstDuplicate])]);
  equal(view.selected(), [], "same-URL occurrences cannot inherit one another's selection on reorder");

  const duplicateSession = nested([["duplicate"], ["duplicate"]]);
  duplicateSession.windows[0].refs = [firstDuplicate];
  duplicateSession.windows[1].refs = [secondDuplicate];
  view = mount([duplicateSession]);
  await view.select(0);
  duplicateSession.windows.reverse();
  view.render([duplicateSession]);
  equal(view.selected(), [], "same-URL occurrences across windows cannot inherit selection");

  view = mount([flat("saved", [ref("duplicate"), ref("duplicate")])]);
  await view.select(0);
  view.render([flat("saved", [ref("duplicate")])]);
  equal(view.selected(), [], "removing an indistinguishable duplicate invalidates the affected group");

  view = mount([flat("saved", ["a", "b"])]);
  await view.select(1);
  const decorated = flat("saved", ["a", ref("b", { title: "New title", labels: ["Work"],
    favIconUrl: "data:image/png;base64,AA==", sessionMemberships: [{ id: "other", name: "Other" }] })]);
  decorated.title = "Renamed group";
  decorated.meta = "different count wording";
  view.render([decorated]);
  equal(view.selected(), [ref("b").url], "ordinary title, favicon, label and membership decoration retain unique occurrences");
  equal(await view.submit(), [ref("b").url], "benign edits keep the correct bulk target");

  const duplicateGroup = flat("saved", [firstDuplicate, secondDuplicate]);
  view = mount([duplicateGroup]);
  await view.select(1);
  view.render([structuredClone(duplicateGroup)]);
  equal(view.selected(), [secondDuplicate.url], "an unchanged duplicate layout survives a fresh snapshot");

  view = mount([flat("saved", ["a", "b"])]);
  await view.select(1);
  view.render([]);
  view.render([flat("saved", ["a", "b"])]);
  equal(view.selected(), [], "an empty render retires selection before a group can reappear");

  const identityGroup = flat("saved", ["a", "b"]);
  identityGroup.data = { id: "saved", createdAt: 1, deviceId: "one" };
  view = mount([identityGroup]);
  await view.select(1);
  view.render([{ ...identityGroup, data: { ...identityGroup.data, createdAt: 2 } }]);
  equal(view.selected(), [], "reusing a saved carrier ID cannot retain an earlier carrier's selection");

  const openGroups = [flat("window", [ref("a", { tabId: 1 }), ref("b", { tabId: 2 })])];
  view = mount(openGroups, { rowKey: (group, index) => `t${group.refs[index].tabId}` });
  await view.select(1);
  view.render([flat("window", [ref("b", { tabId: 2 }), ref("a", { tabId: 1 })])]);
  equal(view.selected(), [ref("b").url], "live lists keep their explicit stable row keys across reorder");
  host.replaceChildren();
}
