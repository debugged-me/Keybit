window.fixtureEvents = { input: 0, change: 0, submit: 0 };
document.addEventListener("input", () => { window.fixtureEvents.input++; });
document.addEventListener("change", () => { window.fixtureEvents.change++; });
document.addEventListener("submit", event => { event.preventDefault(); window.fixtureEvents.submit++; });
document.querySelector("#add-form")?.addEventListener("click", () => {
  const form = document.createElement("form");
  for (const [id, type] of [["user", "text"], ["pass", "password"]]) {
    const label = document.createElement("label"); label.textContent = id === "user" ? "Username" : "Password";
    const input = document.createElement("input"); input.id = id; input.type = type; label.append(input); form.append(label);
  }
  document.querySelector("#mount").replaceChildren(form);
});
if (location.pathname.includes("controlled-login")) {
  // Exercises React-style value tracking: assigning input.value directly would update
  // the tracker and prevent the simulated controlled state from receiving a change.
  window.controlledState = {};
  for (const input of document.querySelectorAll("input")) {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    let tracked = input.value;
    Object.defineProperty(input, "value", { get: () => native.get.call(input), set(value) { tracked = value; native.set.call(input, value); }, configurable: true });
    input.addEventListener("input", () => {
      if (input.value !== tracked) { window.controlledState[input.id] = input.value; tracked = input.value; }
    });
  }
}
