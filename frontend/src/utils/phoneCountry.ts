import { locale } from "../i18n";

// Country calling codes (ITU E.164) mapped to ISO 3166-1 alpha-2 codes.
// NANP (+1) and +7 are disambiguated below via longer prefixes.
const CALLING_CODES: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "20": "EG",
  "211": "SS",
  "212": "MA",
  "213": "DZ",
  "216": "TN",
  "218": "LY",
  "220": "GM",
  "221": "SN",
  "222": "MR",
  "223": "ML",
  "224": "GN",
  "225": "CI",
  "226": "BF",
  "227": "NE",
  "228": "TG",
  "229": "BJ",
  "230": "MU",
  "231": "LR",
  "232": "SL",
  "233": "GH",
  "234": "NG",
  "235": "TD",
  "236": "CF",
  "237": "CM",
  "238": "CV",
  "239": "ST",
  "240": "GQ",
  "241": "GA",
  "242": "CG",
  "243": "CD",
  "244": "AO",
  "245": "GW",
  "246": "IO",
  "248": "SC",
  "249": "SD",
  "250": "RW",
  "251": "ET",
  "252": "SO",
  "253": "DJ",
  "254": "KE",
  "255": "TZ",
  "256": "UG",
  "257": "BI",
  "258": "MZ",
  "260": "ZM",
  "261": "MG",
  "262": "RE",
  "263": "ZW",
  "264": "NA",
  "265": "MW",
  "266": "LS",
  "267": "BW",
  "268": "SZ",
  "269": "KM",
  "27": "ZA",
  "290": "SH",
  "291": "ER",
  "297": "AW",
  "298": "FO",
  "299": "GL",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "350": "GI",
  "351": "PT",
  "352": "LU",
  "353": "IE",
  "354": "IS",
  "355": "AL",
  "356": "MT",
  "357": "CY",
  "358": "FI",
  "359": "BG",
  "36": "HU",
  "370": "LT",
  "371": "LV",
  "372": "EE",
  "373": "MD",
  "374": "AM",
  "375": "BY",
  "376": "AD",
  "377": "MC",
  "378": "SM",
  "380": "UA",
  "381": "RS",
  "382": "ME",
  "383": "XK",
  "385": "HR",
  "386": "SI",
  "387": "BA",
  "389": "MK",
  "39": "IT",
  "40": "RO",
  "41": "CH",
  "420": "CZ",
  "421": "SK",
  "423": "LI",
  "43": "AT",
  "44": "GB",
  "45": "DK",
  "46": "SE",
  "47": "NO",
  "48": "PL",
  "49": "DE",
  "500": "FK",
  "501": "BZ",
  "502": "GT",
  "503": "SV",
  "504": "HN",
  "505": "NI",
  "506": "CR",
  "507": "PA",
  "508": "PM",
  "509": "HT",
  "51": "PE",
  "52": "MX",
  "53": "CU",
  "54": "AR",
  "55": "BR",
  "56": "CL",
  "57": "CO",
  "58": "VE",
  "590": "GP",
  "591": "BO",
  "592": "GY",
  "593": "EC",
  "594": "GF",
  "595": "PY",
  "596": "MQ",
  "597": "SR",
  "598": "UY",
  "599": "CW",
  "60": "MY",
  "61": "AU",
  "62": "ID",
  "63": "PH",
  "64": "NZ",
  "65": "SG",
  "66": "TH",
  "670": "TL",
  "672": "NF",
  "673": "BN",
  "674": "NR",
  "675": "PG",
  "676": "TO",
  "677": "SB",
  "678": "VU",
  "679": "FJ",
  "680": "PW",
  "681": "WF",
  "682": "CK",
  "683": "NU",
  "685": "WS",
  "686": "KI",
  "687": "NC",
  "688": "TV",
  "689": "PF",
  "690": "TK",
  "691": "FM",
  "692": "MH",
  "81": "JP",
  "82": "KR",
  "84": "VN",
  "850": "KP",
  "852": "HK",
  "853": "MO",
  "855": "KH",
  "856": "LA",
  "86": "CN",
  "880": "BD",
  "886": "TW",
  "90": "TR",
  "91": "IN",
  "92": "PK",
  "93": "AF",
  "94": "LK",
  "95": "MM",
  "960": "MV",
  "961": "LB",
  "962": "JO",
  "963": "SY",
  "964": "IQ",
  "965": "KW",
  "966": "SA",
  "967": "YE",
  "968": "OM",
  "970": "PS",
  "971": "AE",
  "972": "IL",
  "973": "BH",
  "974": "QA",
  "975": "BT",
  "976": "MN",
  "977": "NP",
  "98": "IR",
  "992": "TJ",
  "993": "TM",
  "994": "AZ",
  "995": "GE",
  "996": "KG",
  "998": "UZ",
};

// Kazakhstan shares +7 with Russia; its numbers start with 76 or 77.
for (const p of ["76", "77"]) CALLING_CODES[p] = "KZ";

// NANP (+1) area codes for countries other than the US.
const NANP_AREA_CODES: Record<string, string[]> = {
  CA: [
    "204", "226", "236", "249", "250", "263", "289", "306", "343", "354",
    "365", "367", "368", "382", "387", "403", "416", "418", "428", "431",
    "437", "438", "450", "460", "468", "474", "506", "514", "519", "548",
    "579", "581", "584", "587", "604", "613", "639", "647", "672", "683",
    "705", "709", "742", "753", "778", "780", "782", "807", "819", "825",
    "867", "873", "879", "902", "905",
  ],
  BS: ["242"],
  BB: ["246"],
  AI: ["264"],
  AG: ["268"],
  VG: ["284"],
  VI: ["340"],
  KY: ["345"],
  BM: ["441"],
  GD: ["473"],
  TC: ["649"],
  MS: ["664"],
  GU: ["671"],
  AS: ["684"],
  SX: ["721"],
  LC: ["758"],
  DM: ["767"],
  VC: ["784"],
  PR: ["787", "939"],
  DO: ["809", "829", "849"],
  JM: ["658", "876"],
  TT: ["868"],
  KN: ["869"],
};
for (const [iso, codes] of Object.entries(NANP_AREA_CODES)) {
  for (const c of codes) CALLING_CODES[`1${c}`] = iso;
}

export type PhoneCountry = {
  iso: string;
  flag: string;
  name: string;
};

function flagEmoji(iso: string): string {
  return iso.replace(/./g, (ch) =>
    String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65),
  );
}

function countryName(iso: string, lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(iso) ?? iso;
  } catch {
    return iso;
  }
}

const cache = new Map<string, PhoneCountry | null>();

// Resolve a country from an international phone number via longest-prefix match.
// Names follow the active UI locale; results are memoised per locale.
export function phoneCountry(
  phone: string | null | undefined,
): PhoneCountry | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  const lang = locale.value;
  const key = `${lang}|${digits}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let iso: string | undefined;
  for (let len = Math.min(4, digits.length); len >= 1; len--) {
    iso = CALLING_CODES[digits.slice(0, len)];
    if (iso) break;
  }
  const result: PhoneCountry | null = iso
    ? { iso, flag: flagEmoji(iso), name: countryName(iso, lang) }
    : null;
  cache.set(key, result);
  return result;
}
