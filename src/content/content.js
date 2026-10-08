// Detection reports metadata only. Secrets arrive separately, only after an explicit Fill.
// Runs in each frame the worker asks about — `origin`/`url` are always that frame's own.
(() => {
  // Popup/palette detection must not select a form in a Peek as a destination for secrets.
  if ([...(location.ancestorOrigins ?? [])].includes(new URL(chrome.runtime.getURL("")).origin)) return null;
  const keybit = globalThis.__keybit;
  return { origin: location.origin, url: location.href, forms: keybit.find().length, newForms: keybit.findNew().length,
    usernameForms: keybit.findUsernameOnly().length, otpForms: keybit.findOtp().length,
    cardForms: keybit.findPayment().length, identityForms: keybit.findIdentity().length };
})();
