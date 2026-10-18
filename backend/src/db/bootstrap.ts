import { col } from "./collection";
import {
  ENCRYPTED_ACCOUNT_COLUMNS,
  encryptSecret,
  isEncryptedSecret,
  isSecretEncryptionEnabled,
} from "./secretColumns";
import { getSetting, runOnce, setSetting } from "./repos/settings";
import { createSupplier, createModel } from "./repos/ai";
import type { AccountDoc } from "./types";

/**
 * Everything SQLite used to do at import time: creating tables, seeding defaults, running the
 * occasional data fix-up, encrypting any credential left in plain text.
 *
 * MongoDB creates collections implicitly, so DDL disappears entirely. What remains is exactly
 * the work that was about rows rather than schema, and it now has to be awaited -- the reason
 * being that it can no longer happen while the module loads, only once a connection exists.
 */

/** Default settings, seeded once and thereafter owned by whoever edits them in the panel. */
const DEFAULT_SETTINGS: Record<string, string> = {
  default_timezone: "Australia/Sydney",
  default_max_retry: "5",
  check_daily_run: "true",
  default_ua: "SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0",
  default_play_duration: "300",
  default_device_name: "Mac",
  ai_base_url: "https://openrouter.ai/api/v1",
  ai_api_key: "",
  ai_model: "nvidia/nemotron-nano-12b-v2-vl:free",
  ai_timeout_ms: "25000",
  ai_fallback_enabled: "true",
  account_display_with_tg_name: "false",
  log_retention_days: "0",
  ua_presets: JSON.stringify([
    { name: "SenPlayer (Mac)", value: "SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0" },
    { name: "Yamby (Android TV)", value: "Yamby/2.0.3.4(Android)" },
    { name: "Hills (Windows)", value: "Hills/0.2.1" },
    { name: "Lenna (iOS)", value: "Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0" },
    { name: "VidHub (iOS)", value: "VidHub/2.2.4" },
  ]),
};

const DEFAULT_TG_APP_CLIENTS = [
  {
    id: "preset-ios",
    name: "iOS",
    deviceModel: "iPhone 13 Pro Max",
    systemVersion: "iOS 15.4.1",
    appVersion: "8.4.2",
    langCode: "en",
    langPack: "ios",
    systemLangCode: "en-US",
    isDefault: false,
  },
  {
    id: "preset-android",
    name: "Android",
    deviceModel: "Samsung SM-G991B",
    systemVersion: "Android 12",
    appVersion: "9.1.1",
    langCode: "en",
    langPack: "android",
    systemLangCode: "en-US",
    isDefault: false,
  },
  {
    id: "preset-windows",
    name: "Windows",
    deviceModel: "Desktop",
    systemVersion: "Windows 10",
    appVersion: "4.16.5",
    langCode: "en",
    langPack: "tdesktop",
    systemLangCode: "en-US",
    isDefault: false,
  },
  {
    id: "preset-mac",
    name: "Mac",
    deviceModel: "MacBook Pro",
    systemVersion: "macOS 13.2",
    appVersion: "8.4.2",
    langCode: "en",
    langPack: "macos",
    systemLangCode: "en-US",
    isDefault: false,
  },
  {
    id: "preset-linux",
    name: "Linux",
    deviceModel: "PC 64bit",
    systemVersion: "Ubuntu 22.04 LTS",
    appVersion: "4.16.5",
    langCode: "en",
    langPack: "tdesktop",
    systemLangCode: "en-US",
    isDefault: true,
  },
];

/**
 * Any row touched while BEMBY_DATA_KEY was off is still plain text in there. This brings it up
 * to date, and is deliberately not a runOnce: the key can be switched on at any point, and rows
 * written while it was off have to be caught the next time Bemby starts with it on. Rows
 * already encrypted are skipped, so a boot with nothing to do costs one scan.
 */
async function encryptExistingSecrets(): Promise<void> {
  const rows = await col<AccountDoc>("tg_accounts")
    .find({}, { projection: { api_hash: 1, session_string: 1, passkey: 1 } })
    .toArray();

  let converted = 0;
  for (const r of rows) {
    const pending = ENCRYPTED_ACCOUNT_COLUMNS.some(
      (c) => r[c as keyof AccountDoc] && !isEncryptedSecret(r[c as keyof AccountDoc] as any),
    );
    if (!pending) continue;
    await col<AccountDoc>("tg_accounts").updateOne(
      { _id: r._id },
      {
        $set: {
          api_hash: encryptSecret(r.api_hash),
          session_string: encryptSecret(r.session_string),
          passkey: encryptSecret(r.passkey),
        },
      },
    );
    converted++;
  }
  if (converted) {
    console.log(`[secrets] encrypted stored credentials for ${converted} account(s)`);
  }
}

/** Tells the operator plainly which way their install is storing credentials. */
async function warnIfSecretsUnencrypted(): Promise<void> {
  if (!isSecretEncryptionEnabled()) return;
  await encryptExistingSecrets();
  return;
}

/**
 * Creates the OpenRouter supplier from the legacy flat settings on an upgraded install, so
 * nobody has to retype a key they already entered. Skipped whenever an install already has a
 * supplier -- including every fresh one, which gets nothing here and none needs it.
 */
async function seedDefaultAiSupplier(): Promise<void> {
  // Nothing to do for an install that already has a supplier table row -- which includes every
  // upgrade that has come through this once, and any install where the operator has set up
  // their own provider.
  const anySupplier = await col("ai_suppliers").countDocuments({});
  if (anySupplier > 0) return;

  const apiKey = (await getSetting("ai_api_key")) ?? "";
  const baseUrl = (await getSetting("ai_base_url")) || "https://openrouter.ai/api/v1";
  const model = (await getSetting("ai_model")) || "nvidia/nemotron-nano-12b-v2-vl:free";
  const timeout = Number((await getSetting("ai_timeout_ms")) || 25000);

  const supplierId = await createSupplier({
    name: "OpenRouter",
    base_url: baseUrl,
    api_key: apiKey,
    timeout_ms: timeout || 25000,
  });
  await createModel({ supplier_id: supplierId, model_id: model });
}

/** Called once per successful connection, before anything reads data. */
export async function bootstrapDatabase(): Promise<void> {
  // Defaults first: several of the fix-ups below compare against what is already stored, and
  // comparing against a missing key is not the same as comparing against its default.
  await Promise.all(
    Object.entries(DEFAULT_SETTINGS).map(async ([key, value]) => {
      const current = await getSetting(key);
      if (current === undefined) await setSetting(key, value);
    }),
  );

  await runOnce("default-tg-app-clients", async () => {
    const current = await getSetting("tg_app_clients");
    if (current === undefined) {
      await setSetting("tg_app_clients", JSON.stringify(DEFAULT_TG_APP_CLIENTS));
    }
  });

  await seedDefaultAiSupplier();

  // The data fix-ups that were still worth carrying over. Each is a one-off repair to rows
  // written by an earlier build; none of them may run twice, hence runOnce.
  await runOnce("device-name-yamby-to-mac", async () => {
    const value = await getSetting("default_device_name");
    if (value === "Yamby") await setSetting("default_device_name", "Mac");
  });
  await runOnce("ua-senplayer-610-to-612", async () => {
    const value = await getSetting("default_ua");
    if (value === "SenPlayer/6.1.0 CFNetwork/1490.0.4 Darwin/23.2.0") {
      await setSetting("default_ua", DEFAULT_SETTINGS.default_ua);
    }
  });
  await runOnce("timezone-follow-default", async () => {
    // An empty timezone means "follow the default_timezone setting", resolved when a job is
    // due. Rows written before that existed froze the default at creation time, so changing it
    // in Settings never reached them.
    await Promise.all([
      col("jobs").updateMany({}, { $set: { timezone: "" } }),
      col("job_templates").updateMany({}, { $set: { timezone: "" } }),
    ]);
  });

  await warnIfSecretsUnencrypted();
}
