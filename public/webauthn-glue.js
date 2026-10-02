/**
 * Passkey（WebAuthn）浏览器端胶水层——无第三方依赖，同源随仓库走。
 * 负责 base64url ↔ ArrayBuffer 转换，并把 navigator.credentials 的结果序列化成
 * 服务端 @simplewebauthn/server 期望的格式。
 */
(function (root) {
  function b64urlToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function bufToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const supported = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

  async function startRegistration(options) {
    const pk = { ...options };
    pk.challenge = b64urlToBuf(options.challenge);
    pk.user = { ...options.user, id: b64urlToBuf(options.user.id) };
    if (options.excludeCredentials) pk.excludeCredentials = options.excludeCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
    const cred = await navigator.credentials.create({ publicKey: pk });
    const r = cred.response;
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(r.clientDataJSON),
        attestationObject: bufToB64url(r.attestationObject),
        transports: r.getTransports ? r.getTransports() : [],
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
    };
  }

  async function startAuthentication(options) {
    const pk = { ...options };
    pk.challenge = b64urlToBuf(options.challenge);
    if (options.allowCredentials) pk.allowCredentials = options.allowCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
    const cred = await navigator.credentials.get({ publicKey: pk });
    const r = cred.response;
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(r.clientDataJSON),
        authenticatorData: bufToB64url(r.authenticatorData),
        signature: bufToB64url(r.signature),
        userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
    };
  }

  root.WebAuthnGlue = { supported, startRegistration, startAuthentication };
})(window);
