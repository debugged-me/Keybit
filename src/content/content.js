// Detection reports metadata only. Secrets arrive separately, only after an explicit Fill.
(() => ({ origin: location.origin, forms: globalThis.__keybit.find().length }))();
