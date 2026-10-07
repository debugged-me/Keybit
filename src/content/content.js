// Detection reports metadata only. Secrets arrive separately, only after an explicit Fill.
(() => ({ origin: location.origin, url: location.href, forms: globalThis.__keybit.find().length, newForms: globalThis.__keybit.findNew().length }))();
