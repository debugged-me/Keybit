// Peek: page-world half of the frame script. Only inside KeyBit's preview frame (the Peek page
// names it before insertion): pushState becomes replaceState, so in-page navigation never adds
// entries to the tab's Back history. The isolated-world agent hears "keybit-peek-push" and lets
// the Peek page record the step in its own back/forward stack instead.
(() => {
  if (window === window.top || window.name !== "keybit-peek-frame") return;
  const replace = History.prototype.replaceState;
  History.prototype.pushState = function (state, title, url) {
    document.dispatchEvent(new CustomEvent("keybit-peek-push"));
    return replace.call(this, state, title, url);
  };
})();
