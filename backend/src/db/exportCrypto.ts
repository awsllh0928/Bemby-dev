import crypto from "crypto";

// The envelope a backup file is wrapped in when it carries credentials. Shared by the
// accounts export and the full data export, which each had their own identical copy: two
// copies of a format is one that can drift, and a backup written by one has to open in the
// other.

export type EncryptedEnvelope = {
  encrypted: true;
  version: "1";
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

export function encryptPayload(plaintext: string, secret: string): EncryptedEnvelope {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    encrypted: true,
    version: "1",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: encrypted.toString("base64"),
  };
}

export function decryptPayload(envelope: EncryptedEnvelope, secret: string): string {
  const salt = Buffer.from(envelope.salt, "hex");
  const key = crypto.scryptSync(secret, salt, 32);
  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(Buffer.from(envelope.data, "base64")) + decipher.final("utf8");
}
