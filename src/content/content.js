// Detection reports metadata only. Secrets arrive separately, only after an explicit Fill.
(() => {
  const keybit = globalThis.__keybit;
  return { origin: location.origin, url: location.href, forms: keybit.find().length, newForms: keybit.findNew().length,
    usernameForms: keybit.findUsernameOnly().length, otpForms: keybit.findOtp().length };
})();
