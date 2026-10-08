// Runs in the page's own JavaScript world (manifest "world": "MAIN") so it can offer KeyBit's
// passkeys inside navigator.credentials.create/get. Anything KeyBit cannot or should not answer
// is handed back to the real implementation, so the platform authenticator always still works.
(() => {
  if (window !== window.top) return;
  const credentials = /** @type {any} */ (navigator.credentials);
  if (!credentials || typeof credentials.create !== "function" || typeof credentials.get !== "function") return;
  if (credentials.__keybitPasskey) return; // Re-injection after an extension update.
  const originalCreate = credentials.create.bind(credentials);
  const originalGet = credentials.get.bind(credentials);

  let sequence = 0;
  const pending = new Map();
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.__keybit !== "passkey-result") return;
    const settle = pending.get(event.data.id);
    if (settle) { pending.delete(event.data.id); settle(event.data); }
  });
  function ask(kind, options) {
    const id = `keybit-${++sequence}`;
    return new Promise(resolve => {
      pending.set(id, resolve);
      window.postMessage({ __keybit: "passkey-request", id, kind, options }, location.origin);
      // If the extension context is gone, hand the ceremony back rather than leaving a dead promise.
      setTimeout(() => { if (pending.delete(id)) resolve({ action: "delegate" }); }, 150000);
    });
  }

  const b64url = buffer => {
    const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  };
  const unb64url = value => {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const ids = list => (Array.isArray(list) ? list.slice(0, 64).flatMap(credential => {
    try { return credential?.type === "public-key" && credential.id ? [b64url(credential.id)] : []; } catch { return []; }
  }) : []);
  const denied = () => new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");

  function encodeCreation(publicKey) {
    if (!publicKey || !publicKey.challenge || !publicKey.user?.id || !publicKey.user?.name) return null;
    try {
      return { challenge: b64url(publicKey.challenge), rpId: publicKey.rp?.id ?? null,
        user: { id: b64url(publicKey.user.id), name: String(publicKey.user.name).slice(0, 1024), displayName: String(publicKey.user.displayName ?? publicKey.user.name).slice(0, 1024) },
        excludeIds: ids(publicKey.excludeCredentials) };
    } catch { return null; }
  }
  function encodeGet(publicKey) {
    if (!publicKey || !publicKey.challenge) return null;
    try {
      return { challenge: b64url(publicKey.challenge), rpId: publicKey.rpId ?? null, allowIds: ids(publicKey.allowCredentials) };
    } catch { return null; }
  }

  // navigator.credentials must return a PublicKeyCredential-shaped object. KeyBit's result carries
  // the same fields and methods; relying parties read response.* or call toJSON().
  function attestationCredential(c) {
    const response = {
      clientDataJSON: unb64url(c.clientDataJSON).buffer,
      attestationObject: unb64url(c.attestationObject).buffer,
      getTransports: () => ["internal"],
      getAuthenticatorData: () => unb64url(c.authenticatorData).buffer,
      getPublicKey: () => unb64url(c.publicKey).buffer,
      getPublicKeyAlgorithm: () => -7,
    };
    return {
      id: c.id, rawId: unb64url(c.rawId).buffer, type: "public-key", authenticatorAttachment: "platform",
      response, getClientExtensionResults: () => ({}),
      toJSON: () => ({ type: "public-key", id: c.id, rawId: c.rawId, authenticatorAttachment: "platform",
        clientExtensionResults: {}, response: { clientDataJSON: c.clientDataJSON, attestationObject: c.attestationObject, transports: ["internal"] } }),
    };
  }
  function assertionCredential(c) {
    const response = {
      authenticatorData: unb64url(c.authenticatorData).buffer,
      clientDataJSON: unb64url(c.clientDataJSON).buffer,
      signature: unb64url(c.signature).buffer,
      userHandle: c.userHandle ? unb64url(c.userHandle).buffer : null,
    };
    return {
      id: c.id, rawId: unb64url(c.rawId).buffer, type: "public-key", authenticatorAttachment: "platform",
      response, getClientExtensionResults: () => ({}),
      toJSON: () => ({ type: "public-key", id: c.id, rawId: c.rawId, authenticatorAttachment: "platform",
        clientExtensionResults: {}, response: { authenticatorData: c.authenticatorData, clientDataJSON: c.clientDataJSON,
          signature: c.signature, userHandle: c.userHandle ?? null } }),
    };
  }

  // Conditional UI (passkey autofill) and silent mediation belong to the browser, not to a prompt card.
  const ours = options => !!options?.publicKey && (!options.mediation || options.mediation === "optional" || options.mediation === "required");

  credentials.create = function (options, ...rest) {
    if (!ours(options)) return originalCreate(options, ...rest);
    const encoded = encodeCreation(options.publicKey);
    if (!encoded) return originalCreate(options, ...rest);
    return ask("create", encoded).then(result => {
      if (result.action === "keybit") return attestationCredential(result.credential);
      if (result.action === "cancel") throw denied();
      return originalCreate(options, ...rest);
    }, () => originalCreate(options, ...rest));
  };
  credentials.get = function (options, ...rest) {
    if (!ours(options)) return originalGet(options, ...rest);
    const encoded = encodeGet(options.publicKey);
    if (!encoded) return originalGet(options, ...rest);
    return ask("get", encoded).then(result => {
      if (result.action === "keybit") return assertionCredential(result.credential);
      if (result.action === "cancel") throw denied();
      return originalGet(options, ...rest);
    }, () => originalGet(options, ...rest));
  };
  credentials.__keybitPasskey = true;
})();
