export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== false && value != null) node.setAttribute(name === "className" ? "class" : name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
export function announce(text, error = false) {
  const node = document.querySelector("#message");
  node.textContent = text; node.classList.toggle("error", error); node.hidden = !text;
}
export async function openPage(path) { await chrome.tabs.create({ url: chrome.runtime.getURL(path) }); }
export function clearFields(container) {
  for (const input of container.querySelectorAll("input, textarea")) if (!["checkbox", "button"].includes(input.type)) input.value = "";
}
export async function copyText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch { throw new Error("Could not copy. Keep this window focused and try again."); }
}
