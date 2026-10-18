import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "crypto";
import { Api, TelegramClient } from "telegram";
import { serializeBytes } from "telegram/tl/generationHelpers";

// GramJS (TL layer 198) does not yet ship Telegram's passkey types, so we build
// these requests and parse their responses by hand from the documented schema:
//   account.getPasskeys#ea1f0c52 = account.Passkeys;
//   account.passkeys#f8e0aa1c passkeys:Vector<Passkey> = account.Passkeys;
//   passkey#98613ebf flags:# id:string name:string date:int
//                    software_emoji_id:flags.0?long last_usage_date:flags.1?int = Passkey;
//   account.deletePasskey#f5b5563f id:string = Bool;
//   account.initPasskeyRegistration#429547e8 = account.PasskeyRegistrationOptions;
//   account.passkeyRegistrationOptions#e16b5ce1 options:DataJSON = account.PasskeyRegistrationOptions;
//   account.registerPasskey#55b41fd6 credential:InputPasskeyCredential = Passkey;
//   inputPasskeyCredentialPublicKey#3c27b78f id:string raw_id:string response:InputPasskeyResponse = InputPasskeyCredential;
//   inputPasskeyResponseRegister#3e63935c client_data:DataJSON attestation_data:bytes = InputPasskeyResponse;
//   dataJSON#7d748d04 data:string = DataJSON;
//   auth.initPasskeyLogin#518ad0b7 api_id:int api_hash:string = auth.PasskeyLoginOptions;
//   auth.passkeyLoginOptions#e2037789 options:DataJSON = auth.PasskeyLoginOptions;
//   auth.finishPasskeyLogin#9857ad07 flags:# credential:InputPasskeyCredential from_dc_id:flags.0?int from_auth_key_id:flags.0?long = auth.Authorization;
//   inputPasskeyResponseLogin#c31fc14a client_data:DataJSON authenticator_data:bytes signature:bytes user_handle:string = InputPasskeyResponse;
// See https://core.telegram.org/api/passkeys

const GET_PASSKEYS_ID = 0xea1f0c52;
const DELETE_PASSKEY_ID = 0xf5b5563f;
const INIT_REGISTRATION_ID = 0x429547e8;
const REGISTER_PASSKEY_ID = 0x55b41fd6;
const INPUT_CREDENTIAL_PUBKEY_ID = 0x3c27b78f;
const INPUT_RESPONSE_REGISTER_ID = 0x3e63935c;
const INPUT_RESPONSE_LOGIN_ID = 0xc31fc14a;
const INIT_LOGIN_ID = 0x518ad0b7;
const FINISH_LOGIN_ID = 0x9857ad07;
const DATA_JSON_ID = 0x7d748d04;
const BOOL_TRUE_ID = 0x997275b5;

const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
};
const i32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v, 0);
  return b;
};

export type Passkey = {
  id: string;
  name: string;
  date: number;
  softwareEmojiId: string | null;
  lastUsageDate: number | null;
};

// A minimal request object shaped like a GramJS TLRequest: invoke() only needs
// classType, resolve(), getBytes() and readResult().
class GetPasskeysRequest {
  CONSTRUCTOR_ID = GET_PASSKEYS_ID;
  SUBCLASS_OF_ID = 0;
  className = "account.getPasskeys";
  classType = "request" as const;

  async resolve() {
    /* no entity params to resolve */
  }

  getBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(this.CONSTRUCTOR_ID, 0);
    return b;
  }

  // Returns an object (not a bare array) so GramJS's post-invoke entity
  // processing safely finds no users/chats and no-ops.
  readResult(reader: any): { passkeys: Passkey[] } {
    reader.readInt(false); // account.passkeys#f8e0aa1c
    reader.readInt(false); // Vector 0x1cb5c415
    const count = reader.readInt();
    const passkeys: Passkey[] = [];
    for (let i = 0; i < count; i++) passkeys.push(readPasskey(reader));
    return { passkeys };
  }
}

// passkey#98613ebf flags:# id:string name:string date:int
//                  software_emoji_id:flags.0?long last_usage_date:flags.1?int
function readPasskey(reader: any): Passkey {
  reader.readInt(false); // passkey#98613ebf
  const flags = reader.readInt();
  const id = reader.tgReadString();
  const name = reader.tgReadString();
  const date = reader.readInt();
  const softwareEmojiId = flags & 1 ? reader.readLong() : null;
  const lastUsageDate = flags & 2 ? reader.readInt() : null;
  return {
    id,
    name,
    date,
    softwareEmojiId: softwareEmojiId != null ? String(softwareEmojiId) : null,
    lastUsageDate: lastUsageDate ?? null,
  };
}

class DeletePasskeyRequest {
  CONSTRUCTOR_ID = DELETE_PASSKEY_ID;
  SUBCLASS_OF_ID = 0;
  className = "account.deletePasskey";
  classType = "request" as const;

  constructor(private readonly passkeyId: string) {}

  async resolve() {
    /* no entity params to resolve */
  }

  getBytes(): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(this.CONSTRUCTOR_ID, 0);
    return Buffer.concat([head, serializeBytes(this.passkeyId)]);
  }

  readResult(reader: any): boolean {
    return reader.readInt(false) === BOOL_TRUE_ID;
  }
}

// account.initPasskeyRegistration -> account.passkeyRegistrationOptions (a DataJSON blob)
class InitPasskeyRegistrationRequest {
  CONSTRUCTOR_ID = INIT_REGISTRATION_ID;
  SUBCLASS_OF_ID = 0;
  className = "account.initPasskeyRegistration";
  classType = "request" as const;

  async resolve() {}

  getBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(this.CONSTRUCTOR_ID, 0);
    return b;
  }

  // Returns the WebAuthn PublicKeyCredentialCreationOptions JSON (as a string).
  readResult(reader: any): { options: string } {
    reader.readInt(false); // account.passkeyRegistrationOptions#e16b5ce1
    reader.readInt(false); // dataJSON#7d748d04
    return { options: reader.tgReadString() };
  }
}

type BuiltCredential = {
  id: string;
  rawId: string;
  clientDataJson: string;
  attestationData: Buffer;
};

// account.registerPasskey credential:inputPasskeyCredentialPublicKey -> Passkey
class RegisterPasskeyRequest {
  CONSTRUCTOR_ID = REGISTER_PASSKEY_ID;
  SUBCLASS_OF_ID = 0;
  className = "account.registerPasskey";
  classType = "request" as const;

  constructor(private readonly cred: BuiltCredential) {}

  async resolve() {}

  getBytes(): Buffer {
    return Buffer.concat([
      u32(this.CONSTRUCTOR_ID),
      u32(INPUT_CREDENTIAL_PUBKEY_ID),
      serializeBytes(this.cred.id), // id:string
      serializeBytes(this.cred.rawId), // raw_id:string
      u32(INPUT_RESPONSE_REGISTER_ID),
      u32(DATA_JSON_ID), // client_data:DataJSON
      serializeBytes(this.cred.clientDataJson), // dataJSON.data:string
      serializeBytes(this.cred.attestationData), // attestation_data:bytes
    ]);
  }

  readResult(reader: any): Passkey {
    return readPasskey(reader);
  }
}

// auth.initPasskeyLogin -> auth.passkeyLoginOptions (a DataJSON blob) on a fresh session
class InitPasskeyLoginRequest {
  CONSTRUCTOR_ID = INIT_LOGIN_ID;
  SUBCLASS_OF_ID = 0;
  className = "auth.initPasskeyLogin";
  classType = "request" as const;

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
  ) {}

  async resolve() {}

  getBytes(): Buffer {
    return Buffer.concat([
      u32(this.CONSTRUCTOR_ID),
      i32(this.apiId), // api_id:int
      serializeBytes(this.apiHash), // api_hash:string
    ]);
  }

  readResult(reader: any): { options: string } {
    reader.readInt(false); // auth.passkeyLoginOptions#e2037789
    reader.readInt(false); // dataJSON#7d748d04
    return { options: reader.tgReadString() };
  }
}

type BuiltAssertion = {
  id: string;
  rawId: string;
  clientDataJson: string;
  authenticatorData: Buffer;
  signature: Buffer;
  userHandle: Buffer; // raw bytes (decoded user.id), NOT the base64url string
};

// auth.finishPasskeyLogin credential:inputPasskeyCredentialPublicKey -> auth.Authorization
class FinishPasskeyLoginRequest {
  CONSTRUCTOR_ID = FINISH_LOGIN_ID;
  SUBCLASS_OF_ID = 0;
  className = "auth.finishPasskeyLogin";
  classType = "request" as const;

  constructor(private readonly a: BuiltAssertion) {}

  async resolve() {}

  getBytes(): Buffer {
    return Buffer.concat([
      u32(this.CONSTRUCTOR_ID),
      i32(0), // flags:# (no from_dc_id / from_auth_key_id)
      u32(INPUT_CREDENTIAL_PUBKEY_ID),
      serializeBytes(this.a.id), // id:string
      serializeBytes(this.a.rawId), // raw_id:string
      u32(INPUT_RESPONSE_LOGIN_ID),
      u32(DATA_JSON_ID), // client_data:DataJSON
      serializeBytes(this.a.clientDataJson), // dataJSON.data:string
      serializeBytes(this.a.authenticatorData), // authenticator_data:bytes
      serializeBytes(this.a.signature), // signature:bytes
      serializeBytes(this.a.userHandle), // user_handle:string
    ]);
  }

  // auth.Authorization is a known GramJS type, so let the reader parse it (incl. user).
  readResult(reader: any): any {
    return reader.tgReadObject();
  }
}

// ── Minimal CBOR encoder (only what the attestation object and COSE key need) ──
const cborUint = (major: number, n: number): Buffer => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
};
const cborInt = (v: number): Buffer => (v >= 0 ? cborUint(0, v) : cborUint(1, -1 - v));
const cborBytes = (buf: Buffer): Buffer => Buffer.concat([cborUint(2, buf.length), buf]);
const cborText = (s: string): Buffer => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([cborUint(3, b.length), b]);
};
const cborMap = (pairs: Buffer[][]): Buffer =>
  Buffer.concat([cborUint(5, pairs.length), ...pairs.flat()]);

// Runs the WebAuthn create() ceremony ourselves (no browser): generate an ES256
// keypair, act as a virtual authenticator and emit a "none"-attestation credential.
// Returns the private key too, so callers can persist it for a later passkey login.
export type RegisteredCredentialMaterial = {
  credential: BuiltCredential;
  credentialId: string; // base64url
  privateKeyPem: string;
  publicKeyCoseHex: string;
  rpId: string;
  userHandle: string; // base64url user.id, echoed back as user_handle on login
};

export function buildPasskeyRegistration(
  optionsJson: string,
  originOverride?: string,
): RegisteredCredentialMaterial {
  const parsed = JSON.parse(optionsJson);
  const publicKey = parsed.publicKey ?? parsed;
  const challenge: string = publicKey.challenge;
  const rpId: string = publicKey.rp?.id;
  const userHandle: string = publicKey.user?.id;
  if (!challenge || !rpId || !userHandle) {
    throw new Error(
      "passkey registration options missing challenge, rp.id or user.id",
    );
  }
  const origin = originOverride ?? `https://${rpId}`;

  // ES256 (alg -7) keypair; we are the authenticator.
  const { publicKey: pub, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = pub.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");

  // COSE_Key for EC2/P-256: {1:2, 3:-7, -1:1, -2:x, -3:y}
  const cose = cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(x)],
    [cborInt(-3), cborBytes(y)],
  ]);

  const credentialId = randomBytes(32);

  // authenticatorData = rpIdHash | flags | signCount | attestedCredentialData
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const flags = Buffer.from([0x5d]); // UP | UV | BE | BS | AT (synced passkey)
  const signCount = Buffer.alloc(4); // 0
  const aaguid = Buffer.alloc(16); // zeros for "none" attestation
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(credentialId.length, 0);
  const authData = Buffer.concat([
    rpIdHash,
    flags,
    signCount,
    aaguid,
    credIdLen,
    credentialId,
    cose,
  ]);

  // attestationObject = {fmt:"none", attStmt:{}, authData}
  const attestationData = cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborBytes(authData)],
  ]);

  const clientDataJson = JSON.stringify({
    type: "webauthn.create",
    challenge, // base64url, echoed verbatim from the options
    origin,
    crossOrigin: false,
  });

  const credIdB64 = credentialId.toString("base64url");
  return {
    credential: {
      id: credIdB64,
      rawId: credIdB64,
      clientDataJson,
      attestationData,
    },
    credentialId: credIdB64,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyCoseHex: cose.toString("hex"),
    rpId,
    userHandle,
  };
}

// Runs the WebAuthn get() ceremony ourselves: sign the login challenge with the
// stored private key and emit the assertion Telegram expects.
function buildPasskeyAssertion(
  optionsJson: string,
  secret: {
    credentialId: string;
    privateKeyPem: string;
    rpId: string;
    userHandle: string;
  },
  originOverride?: string,
): BuiltAssertion {
  const parsed = JSON.parse(optionsJson);
  const publicKey = parsed.publicKey ?? parsed;
  const challenge: string = publicKey.challenge;
  if (!challenge) throw new Error("passkey login options missing challenge");
  const rpId = publicKey.rpId ?? secret.rpId;
  const origin = originOverride ?? `https://${rpId}`;

  const clientDataJson = JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin,
    crossOrigin: false,
  });

  // authenticatorData for an assertion: rpIdHash | flags | signCount (no AT).
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const flags = Buffer.from([0x1d]); // UP | UV | BE | BS
  const signCount = Buffer.alloc(4);
  const authenticatorData = Buffer.concat([rpIdHash, flags, signCount]);

  const clientDataHash = createHash("sha256").update(clientDataJson).digest();
  const signature = sign(
    "sha256",
    Buffer.concat([authenticatorData, clientDataHash]),
    createPrivateKey(secret.privateKeyPem),
  ); // DER-encoded ECDSA (ES256), as WebAuthn expects

  return {
    id: secret.credentialId,
    rawId: secret.credentialId,
    clientDataJson,
    authenticatorData,
    signature,
    // user_handle is the raw decoded bytes of user.id, not the base64url string
    userHandle: Buffer.from(secret.userHandle, "base64url"),
  };
}

export async function invokeGetPasskeys(
  client: TelegramClient,
): Promise<Passkey[]> {
  const result = (await client.invoke(new GetPasskeysRequest() as any)) as {
    passkeys: Passkey[];
  };
  return result.passkeys;
}

export async function invokeDeletePasskey(
  client: TelegramClient,
  passkeyId: string,
): Promise<boolean> {
  return client.invoke(new DeletePasskeyRequest(passkeyId) as any);
}

export type RegisterPasskeyResult = {
  passkey: Passkey;
  credentialId: string;
  privateKeyPem: string;
  publicKeyCoseHex: string;
  rpId: string;
  userHandle: string;
};

// Full registration: init options -> run the ceremony -> register the credential.
export async function invokeRegisterPasskey(
  client: TelegramClient,
  originOverride?: string,
): Promise<RegisterPasskeyResult> {
  const { options } = (await client.invoke(
    new InitPasskeyRegistrationRequest() as any,
  )) as { options: string };
  const material = buildPasskeyRegistration(options, originOverride);
  const passkey = (await client.invoke(
    new RegisterPasskeyRequest(material.credential) as any,
  )) as Passkey;
  return {
    passkey,
    credentialId: material.credentialId,
    privateKeyPem: material.privateKeyPem,
    publicKeyCoseHex: material.publicKeyCoseHex,
    rpId: material.rpId,
    userHandle: material.userHandle,
  };
}

export type PasskeySecretLike = {
  credentialId: string;
  privateKeyPem: string;
  rpId: string;
  userHandle: string;
};

// Performs the passkey login factor: init options -> sign assertion -> finish.
// Returns the raw auth.Authorization; throws SESSION_PASSWORD_NEEDED when the
// account also has a 2FA cloud password (the credential itself was accepted).
export async function invokePasskeyLogin(
  client: TelegramClient,
  apiId: number,
  apiHash: string,
  secret: PasskeySecretLike,
  originOverride?: string,
): Promise<any> {
  const { options } = (await client.invoke(
    new InitPasskeyLoginRequest(apiId, apiHash) as any,
  )) as { options: string };
  const assertion = buildPasskeyAssertion(options, secret, originOverride);
  return client.invoke(new FinishPasskeyLoginRequest(assertion) as any);
}

export type PasskeyLoginVerification = {
  ok: boolean;
  passwordRequired: boolean; // passkey accepted, but 2FA cloud password still needed
  userId: string;
  firstName: string | null;
  username: string | null;
};

// Proves a passkey works by performing a full passkey login on a fresh session,
// then logging that throwaway authorisation straight back out.
export async function invokeVerifyPasskeyLogin(
  client: TelegramClient,
  apiId: number,
  apiHash: string,
  secret: PasskeySecretLike,
  originOverride?: string,
): Promise<PasskeyLoginVerification> {
  let auth: any;
  try {
    auth = await invokePasskeyLogin(client, apiId, apiHash, secret, originOverride);
  } catch (err: any) {
    const msg = err?.errorMessage ?? err?.message ?? "";
    // The credential was accepted; only the second factor (cloud password) remains.
    // That is conclusive proof the passkey works, and no session was created.
    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      return {
        ok: true,
        passwordRequired: true,
        userId: "",
        firstName: null,
        username: null,
      };
    }
    throw err;
  }

  const user = auth?.user;
  // Clean up the authorisation this login just created so it does not linger.
  await client.invoke(new Api.auth.LogOut()).catch(() => undefined);
  return {
    ok: !!user,
    passwordRequired: false,
    userId: user?.id != null ? String(user.id) : "",
    firstName: user?.firstName ?? null,
    username: user?.username ?? null,
  };
}
