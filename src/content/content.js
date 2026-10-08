// Detection reports metadata only. Secrets arrive separately, only after an explicit Fill.
// Runs in each frame the worker asks about — `origin`/`url` are always that frame's own.
(() => {
  const keybit = globalThis.__keybit;
  return { origin: location.origin, url: location.href, forms: keybit.find().length, newForms: keybit.findNew().length,
    usernameForms: keybit.findUsernameOnly().length, otpForms: keybit.findOtp().length,
    cardForms: keybit.findPayment().length, identityForms: keybit.findIdentity().length };
})();
