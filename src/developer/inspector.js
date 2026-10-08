import { element, announce, siteTile } from "../ui/common.js";

const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
let tabId = params.has("tab") ? Number(params.get("tab")) : null;
if (!Number.isInteger(tabId) && params.get("url")) {
  // Opened with a page address instead of a tab id (e.g. reloaded reports). Match in JS:
  // the tabs API's url filter is a match pattern, and patterns cannot express ports.
  const wanted = params.get("url");
  const tabs = await chrome.tabs.query({}).catch(() => []);
  tabId = tabs.find(tab => tab.url === wanted)?.id;
}

const fieldName = field =>
  field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : field.label ? `"${field.label}"` : `${field.tag} type=${field.type}`;

function fieldRow(field) {
  const attrs = [];
  if (field.autocomplete) attrs.push(element("span", { className: "chiplet" }, `autocomplete=${field.autocomplete}`));
  if (field.placeholder) attrs.push(element("span", { className: "chiplet" }, `placeholder=${field.placeholder.slice(0, 40)}`));
  if (field.required) attrs.push(element("span", { className: "chiplet" }, "required"));
  const flags = [];
  if (!field.usable) flags.push(field.disabled ? "disabled" : field.readonly ? "readonly" : "hidden");
  if (field.shadow) flags.push(field.depth > 1 ? `shadow ×${field.depth}` : "shadow DOM");
  if (!field.inForm && ["password", "email", "text", "tel", "url"].includes(field.type)) flags.push("no <form>");
  const roles = field.roles.map(role => element("span", { className: "chiplet role" }, role));
  return element("tr", {},
    element("td", {},
      element("div", { className: "field-name" }, fieldName(field)),
      element("div", { className: "field-kind" }, `${field.tag} · type=${field.type}${field.formId ? ` · form #${field.formId}` : ""}`),
      field.label ? element("div", { className: "field-label" }, field.label) : null),
    element("td", {}, attrs.length ? attrs : element("span", { className: "muted" }, "—")),
    element("td", {}, flags.map(flag => element("span", { className: "chiplet flag" }, flag))),
    element("td", {}, roles.length ? roles : element("span", { className: "muted" }, "ignored")));
}

function findingList(title, className, items) {
  if (!items.length) return null;
  return element("div", { className },
    element("h3", {}, `${title} (${items.length})`),
    element("ul", {}, items.map(item => element("li", {}, item))));
}

function summaryLine(frame) {
  const parts = [];
  if (frame.error) return frame.error;
  if (frame.counts.login) parts.push(`${frame.counts.login} login form${frame.counts.login > 1 ? "s" : ""}`);
  if (frame.counts.newPassword) parts.push(`${frame.counts.newPassword} new-password form${frame.counts.newPassword > 1 ? "s" : ""}`);
  if (frame.counts.username) parts.push(`${frame.counts.username} username step${frame.counts.username > 1 ? "s" : ""}`);
  if (frame.counts.otp) parts.push(`${frame.counts.otp} one-time code form${frame.counts.otp > 1 ? "s" : ""}`);
  if (frame.counts.payment) parts.push(`${frame.counts.payment} payment form${frame.counts.payment > 1 ? "s" : ""}`);
  if (frame.counts.identity) parts.push(`${frame.counts.identity} identity form${frame.counts.identity > 1 ? "s" : ""}`);
  if (!parts.length) return "No fillable forms detected.";
  return parts.join(" · ");
}

function frameCard(frame, index) {
  const badges = [];
  if (frame.crossOrigin) badges.push(element("span", { className: "badge warn" }, "cross-origin"));
  if (frame.shadow) badges.push(element("span", { className: "badge info" }, "Shadow DOM"));
  const card = element("section", { className: "frame-card" },
    element("div", { className: "frame-head" },
      element("h2", {}, frame.top ? "Top frame" : `Embedded frame ${index}`),
      element("span", { className: "origin" }, frame.origin),
      badges.length ? element("span", { className: "badges" }, badges) : null));
  if (frame.error) {
    card.append(element("p", { className: "frame-error" }, frame.error));
    return card;
  }
  card.append(element("p", { className: "frame-summary" }, summaryLine(frame)));
  const rows = frame.fields.filter(field =>
    field.roles.length || field.type === "password" || /user|email|login|otp|code|card|cvv|name/i.test(`${field.name} ${field.id} ${field.autocomplete}`));
  if (rows.length) {
    card.append(element("table", { className: "field-table" },
      element("thead", {}, element("tr", {},
        element("th", {}, "Field"), element("th", {}, "Attributes"), element("th", {}, "Flags"), element("th", {}, "Detected as"))),
      element("tbody", {}, rows.map(fieldRow))));
  }
  card.append(element("div", { className: "findings" },
    findingList("Issues", "issues", frame.issues),
    findingList("Recommendations", "recommendations", frame.recommendations),
    findingList("Notes", "notes", frame.notes)));
  return card;
}

async function load() {
  $("#empty").hidden = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "INSPECT", tabId });
    if (!response?.ok) throw new Error(response?.error ?? "Inspection failed.");
    const report = response.data;
    $("#page-name").textContent = report.title || report.url;
    $("#page-url").textContent = report.url;
    const tile = siteTile(report.origin || report.url, "", report.url);
    tile.id = "site-tile";
    $("#site-tile").replaceWith(tile);
    const frames = $("#frames");
    frames.textContent = "";
    report.frames.forEach((frame, index) => frames.append(frameCard(frame, index)));
    $("#empty").hidden = report.frames.length > 0;
  } catch (error) {
    announce(error.message, true);
    $("#page-name").textContent = "Could not inspect this page";
    $("#page-url").textContent = "";
    $("#frames").textContent = "";
    $("#empty").hidden = true;
  }
}

$("#inspect-again").addEventListener("click", () => void load());
if (!Number.isInteger(tabId)) announce("No tab to inspect. Open the inspector from the KeyBit popup.", true);
else void load();
