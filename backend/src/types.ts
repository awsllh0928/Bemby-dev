export type AuthStatus =
  | "unauthenticated"
  | "pending_code"
  | "pending_2fa"
  | "authenticated"
  | "session_expired";
export type JobType = "checkin" | "embywatch" | "custom" | "autoreg";
export type LogStatus = "success" | "failed" | "running";

export type TgAppClient = {
  id: string;
  name: string;
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  langPack: string;
  systemLangCode: string;
  isDefault: boolean;
};

export type TgAccount = {
  id: number;
  name: string;
  phoneNumber: string;
  /** Null when the account relies on the global default from settings. */
  apiId: number | null;
  apiHash: string | null;
  sessionString: string | null;
  authStatus: AuthStatus;
  proxyId: string | null;
  disabled: boolean;
  appClientId: string | null;
  createdAt: string;
};

export type Job = {
  id: number;
  name: string;
  /** null for embywatch jobs that don't require a Telegram account */
  accountId: number | null;
  jobType: JobType;
  /** checkin: Telegram bot username. embywatch: Emby server URL */
  botUsername: string;
  scheduleWindowStart: number;
  scheduleWindowEnd: number;
  /** IANA zone; empty means follow the default_timezone setting */
  timezone: string;
  replyTimeoutMs: number;
  retryMax: number;
  enabled: boolean;
  createdAt: string;
  config: string | null;
  startCommand: string;
  checkinButton: string;
  templateId?: number | null;
  runEveryDays: number;
  /** Upper bound of the run-every-days range; null means a fixed interval. */
  runEveryDaysMax?: number | null;
  retired?: string | null;
  /** ISO timestamp of the last successful run; persisted so log purges don't lose it. */
  lastSuccessAt?: string | null;
};

export type JobTemplate = {
  id: number;
  name: string;
  jobType: JobType;
  botUsername: string;
  /** IANA zone; empty means follow the default_timezone setting */
  timezone: string;
  replyTimeoutMs: number;
  retryMax: number;
  enabled: boolean;
  config: string | null;
  startCommand: string;
  checkinButton: string;
  createdAt: string;
  linkedJobCount?: number;
  runEveryDays: number;
  /** Upper bound of the run-every-days range; null means a fixed interval. */
  runEveryDaysMax?: number | null;
};

export type CustomAction =
  | { type: "send_command"; content: string; maxRetries?: number }
  | {
      // Send a message/command to a specific contact (bot/group/user), rather than the
      // job's configured bot. Supports the same {aiInput} and command expansion as send_command.
      type: "send_contact_message";
      contact: string;
      content: string;
      maxRetries?: number;
    }
  // `scope` limits which messages an action considers, relative to the last
  // message we sent (the anchor). 0 (default) = only replies newer than the
  // anchor; -N = also the N most recent incoming messages before the anchor.
  | {
      type: "wait_reply";
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      scope?: number;
    }
  | { type: "delay"; waitMs: number }
  | {
      type: "click_button";
      button: string;
      maxRetries: number;
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      scope?: number;
      /** Open a Cloudflare-gated URL button/answer (e.g. "我不是机器人") in a headless browser to pass the "I am not a bot" check. */
      cfChallenge?: boolean;
    }
  | {
      // Click a button on the latest message from a specific contact (bot/group/user),
      // rather than from the job's configured bot. Seeds from the contact's last received
      // message and otherwise waits up to maxWaitMs for an incoming one with buttons.
      type: "click_message_button";
      contact: string;
      button: string;
      maxRetries: number;
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      scope?: number;
      /** Open a Cloudflare-gated URL button/answer (e.g. "我不是机器人") in a headless browser to pass the "I am not a bot" check. */
      cfChallenge?: boolean;
    }
  | {
      // AI selects and clicks multiple buttons in order. The AI returns a JSON array of
      // exact button texts; each is clicked in sequence with `gapMs` between clicks.
      // `contact` empty/undefined targets the job's bot chat; otherwise that peer.
      type: "ai_multiple_btn";
      contact?: string;
      hint?: string;
      gapMs: number;
      maxRetries: number;
      maxWaitMs: number;
      successContains?: string;
      failContains?: string;
      scope?: number;
    }
  | {
      type: "enter_captcha";
      maxWaitMs: number;
      captchaLength?: number;
      maxRetries?: number;
    }
  | {
      type: "join_group";
      groupId: string;
      checkMembership?: boolean;
      // When set, after joining, wait for an in-group verification message and click the
      // button whose text contains this string (bot-gated groups). verifyWaitMs bounds the wait.
      verifyButton?: string;
      verifyWaitMs?: number;
    }
  | {
      // Open a Mini App button's page in the installed browser (passing Cloudflare on
      // the way) and press a control inside the app, which is where such bots put the
      // actual checkin. `contact` empty/undefined targets the job's bot chat.
      type: "open_mini_app";
      contact?: string;
      /** Inline button that opens the Mini App; blank takes the most recent one. */
      button?: string;
      /**
       * Steps to run inside the app, in order: a control's visible text, `css:<selector>`,
       * `delay(2500)`, `scroll(x, y)` to reach something below the fold, or an `{aiBtn}` /
       * `{input}` / `{aiInput}` placeholder. Blank auto-detects a checkin-worded control.
       */
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /**
       * Budget for the browser part of this action, across every proxy tried.
       * Blank/0 uses the built-in default (5 minutes).
       */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy list id, or "direct" for none. Blank uses the job's proxy. */
      proxyId?: string;
      /** Work through the rest of the proxy list when an exit is refused. Defaults to true. */
      tryAllProxies?: boolean;
    }
  | {
      // Same as `open_mini_app`, but the address is given rather than hunted from a button
      // in the chat. Telegram still signs it for the job's own account, so the app sees
      // that user -- which is what makes one template usable across many accounts.
      type: "open_mini_app_url";
      /** Mini App address, or a t.me/<bot>/<app> link, which names its own bot. */
      url: string;
      /** Bot that owns the app, used to sign the URL. Blank uses the job's bot. */
      contact?: string;
      /**
       * Steps to run inside the app, in order, same vocabulary as `open_mini_app`
       * (control text, `css:`, `delay()`, `scroll()`, `{aiBtn}`, `{input}`, `{aiInput}`).
       * Blank auto-detects a checkin control.
       */
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /** Budget for the browser part of this action. Blank/0 uses the default. */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy list id, or "direct". Blank uses the job's. */
      proxyId?: string;
      /** Work through the rest of the proxy list when an exit is refused. Defaults to true. */
      tryAllProxies?: boolean;
    }
  | {
      // Open the Mini App a bot pins beside the composer -- the button at the bottom left
      // of its chat, next to the attachment clip. It belongs to the bot rather than to any
      // message, so nothing in the chat history points at it and no address needs typing:
      // the bot is asked what its button is, and Telegram signs it for this account.
      type: "open_bot_menu_app";
      /** Bot whose menu button to open. Blank uses the job's bot. */
      contact?: string;
      /**
       * Steps to run inside the app, in order, same vocabulary as `open_mini_app`
       * (control text, `css:`, `delay()`, `scroll()`, `{aiBtn}`, `{input}`, `{aiInput}`).
       * Blank auto-detects a checkin control.
       */
      appButtons?: string[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /** Budget for the browser part of this action. Blank/0 uses the default. */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy list id, or "direct". Blank uses the job's. */
      proxyId?: string;
      /** Work through the rest of the proxy list when an exit is refused. Defaults to true. */
      tryAllProxies?: boolean;
    }
  | {
      // Open a plain web page in the installed browser, passing any Cloudflare challenge,
      // and drive it with the sub-steps below. Nothing about this action goes through
      // Telegram: the URL is opened directly.
      type: "open_url";
      url: string;
      /** Sub-steps run on the page once it is up, in order. */
      steps?: WebStep[];
      successContains?: string;
      failContains?: string;
      maxRetries?: number;
      /**
       * Budget for the browser part of this action, across every proxy tried.
       * Blank/0 uses the built-in default (5 minutes).
       */
      maxWaitMs?: number;
      /** Proxy the browser exits through: a proxy list id, or "direct" for none. Blank uses the job's proxy. */
      proxyId?: string;
      /** Work through the rest of the proxy list when an exit is refused. Defaults to true. */
      tryAllProxies?: boolean;
    }
  | { type: "subscribe_channel"; channelId: string; checkMembership?: boolean };

/**
 * One sub-step of `open_url`, run against the loaded page.
 *
 * The `ai_*` variants hand a screenshot to the vision model rather than naming an element.
 * `ai_web_button` and `ai_web_input` number the interactive elements on the shot first, so
 * what comes back is a marker to press rather than a raw pixel guess, and the click lands
 * on a real element. `ai_web_click_xy` asks for a position instead, for what that cannot
 * reach: a control inside a cross-origin iframe or a closed shadow root (a Turnstile
 * checkbox), or one painted on a canvas, none of which any selector can number.
 */
export type WebStep =
  | {
      /** Type text into a field named by a CSS selector. */
      type: "web_input";
      selector: string;
      text: string;
    }
  | {
      /** Press a control named by a CSS selector. */
      type: "web_button";
      selector: string;
    }
  | {
      /** Sit still for a while, for a page that needs a moment between steps. */
      type: "web_delay";
      waitMs: number;
    }
  | {
      /**
       * Scroll the page by pixels, to bring something below the fold within reach of the
       * steps after it. Either figure may be negative to scroll back, and one past the end
       * of the page simply lands at the end.
       */
      type: "web_scroll";
      /** Horizontal move in pixels. Blank/0 leaves the column alone. */
      x?: number;
      /** Vertical move in pixels. Blank/0 leaves the row alone. */
      y?: number;
    }
  | {
      /**
       * Hold until a CSS selector is on the page and has a box, so the next step is not run
       * against a page that has not finished rendering what it needs.
       */
      type: "web_wait_element";
      selector: string;
      /** How long to wait before giving up. Blank/0 waits 30s. */
      waitMs?: number;
    }
  | {
      /** AI reads a screenshot and decides which control to press. */
      type: "ai_web_button";
      /** Optional steer, e.g. "the login button". Blank lets the AI judge on its own. */
      hint?: string;
    }
  | {
      /**
       * Press a Cloudflare Turnstile checkbox on the page ("Verify you are human"), wherever
       * it sits. No AI: the widget is found through the browser's own protocol, which reaches
       * inside the cross-origin frame it draws in, and the checkbox is clicked at its known
       * place in the widget. Prefer this to `ai_web_click_xy` for a Turnstile.
       */
      type: "web_turnstile";
    }
  | {
      /**
       * AI reads a screenshot and gives back a pixel position, which is clicked exactly.
       * The page is ruled with a labelled grid before the shot so the figure is read off
       * the picture rather than estimated.
       */
      type: "ai_web_click_xy";
      /** Optional steer, e.g. "the verify-you-are-human checkbox". Blank lets the AI judge. */
      hint?: string;
    }
  | {
      /** AI reads a screenshot and decides which field to type into. */
      type: "ai_web_input";
      /** Optional steer, e.g. "the password box". Blank lets the AI judge on its own. */
      hint?: string;
      /** Text to type. Blank lets the AI decide from the page (e.g. a captcha it can read). */
      text?: string;
    };

/** What one `open_url` sub-step did, with the page as it looked afterwards. */
export type WebStepLog = {
  type: WebStep["type"];
  /** What was attempted, e.g. `web_button css: #login`. */
  label: string;
  /** What happened, e.g. the element pressed or the text typed. */
  outcome?: string;
  error?: string;
  /** data: URI of the page right after the step. */
  screenshot?: string;
  /** Prompt sent to the vision model (`ai_*` steps only). */
  aiPrompt?: string;
  /** What the model replied (`ai_*` steps only). */
  aiResponse?: string;
};

export type CustomConfig = {
  actions: CustomAction[];
  maxRetries?: number;
  proxyId?: string;
};

export type CheckinConfig = {
  successContains?: string;
  failContains?: string;
  proxyId?: string;
  /** Open a Cloudflare-gated checkin URL (e.g. "我不是机器人") in a headless browser to pass the "I am not a bot" check. */
  cfChallenge?: boolean;
};

export type AutoregConfig = {
  /** Group to watch for registration codes: @username or t.me invite link */
  groupId: string;
  /** Line prefix identifying a registration code, e.g. ABC-30-Register_ */
  codePrefix: string;
  /**
   * Regular expression identifying a code, for groups whose codes carry no stable prefix.
   * Capture group 1 is the code when present, else the whole match. Takes the place of
   * `codePrefix` when set.
   */
  codeRegex?: string;
  /** Strip Chinese characters and punctuation out of a code before sending it. */
  stripChinese?: boolean;
  /** Characters to strip out of a code before sending, e.g. `~*·`. */
  stripChars?: string;
  /** Have the AI adjust each code before it is sent, going on the surrounding chat. */
  aiModifyCode?: boolean;
  /** What the AI should watch for, when the group's convention needs saying. */
  aiModifyCodeHint?: string;
  /** Group messages around the code shown to the AI as context. Default 6. */
  aiContextCount?: number;
  /** Bot text that means it is ready for a code; waited for after the register button. */
  codeReadyContains?: string;
  /** Bot text that means it is ready for the username; waited for after a code is accepted. */
  usernameReadyContains?: string;
  /** Button on the bot's start reply that opens registration (partial match). Blank clicks the sole button. */
  registerButton?: string;
  /**
   * Some bots vet the code first and only then offer a button (or a t.me link) that actually
   * opens registration. On, that click happens between the code being accepted and the
   * username being sent.
   */
  clickAfterCode?: boolean;
  /** Button or link text to click once a code is accepted (partial match). Blank takes the sole/first one. */
  afterCodeButton?: string;
  /**
   * Whether that button has to be there. On, a code whose reply never offers one is treated
   * as spent and the next code is tried; off, the run carries on to the username -- which is
   * what a bot that only sometimes asks for the extra click needs.
   */
  afterCodeRequired?: boolean;
  /** Username sent to finish signup; supports {word:N} {num:N} {alpha:N} {uuid} placeholders */
  signupUsername: string;
  /** How long to keep listening for codes before giving up, in minutes. Default 30. */
  listenMinutes?: number;
  /** Recent group messages scanned for codes at startup. Default 0 (live only). */
  scanHistoryCount?: number;
  /** How a code reaches the bot: "button" sends the start command and clicks the register button first; "command" appends the code to the start command (e.g. /start CODE). Default "button". */
  entryMode?: "button" | "command";
  /** Reply text marking a code as accepted; blank treats any non-fail reply as accepted. Multiple keywords separated by | */
  successContains?: string;
  /** Reply text marking a code as used/invalid, e.g. 已被使用|错误. Multiple keywords separated by | */
  failContains?: string;
  proxyId?: string;
};

export type CustomStepLog = {
  step: number;
  actionType: string;
  label: string;
  /** For click_button: the bot message we clicked on, when we had to wait for it */
  preClickHtml?: string;
  preClickImage?: string;
  preClickButtons?: string[][];
  preClickHasMedia?: boolean;
  clickedButton?: string;
  /** For ai_multiple_btn: every button clicked, in order */
  clickedButtons?: string[];
  /** Bot response after the action */
  responseHtml?: string;
  responseImage?: string;
  responseButtons?: string[][];
  responseHasMedia?: boolean;
  callbackAnswer?: string;
  result?: string;
  error?: string;
  durationMs?: number;
  aiPrompt?: string;
  aiResponse?: string;
  aiDurationMs?: number;
  aiRetries?: string[];
  // Dev fields
  /** For wait_reply: number of messages received during the wait */
  msgCount?: number;
  /** For click_button: 'edit' or 'new_message' — which response path fired */
  responseSource?: "edit" | "new_message";
  /** For click_button: how many retries were needed (0 = first attempt succeeded) */
  retryCount?: number;
  errorName?: string;
  /** Which job-level attempt this step belongs to, 1-based (only set when job maxRetries > 1) */
  jobAttempt?: number;
  /** Which action-level attempt this is, 1-based (only set when action maxRetries > 0) */
  actionAttempt?: number;
  /** Host of the Cloudflare-gated URL opened for this click (full URL is sensitive). */
  cfHost?: string;
  /** A Cloudflare "I am not a bot" challenge was encountered. */
  cfChallenged?: boolean;
  /** The challenge was cleared (or the page loaded with none). */
  cfPassed?: boolean;
  /** The page was opened as a Telegram Mini App (WebView button). */
  cfMiniApp?: boolean;
  /** Telegram returned a signed Mini App URL (the app loads logged in). */
  cfMiniAppSigned?: boolean;
  /** Label of the checkin control pressed inside the Mini App page. */
  cfMiniAppAction?: string;
  /** Proxy whose exit IP the challenge was cleared through. */
  cfProxy?: string;
  /**
   * Which browser build ran this step: "keyed" is the licensed build, "free" the
   * unlicensed fallback used when no licence seat was available. The free build is older
   * and passes fewer challenges, so a run that quietly fell back is worth seeing.
   */
  cfBuild?: "keyed" | "free";
  /** How many exits were tried before the page loaded. */
  cfAttempts?: number;
  /** Title of the page the browser ended up on. */
  cfPageTitle?: string;
  /** Navigation or renderer trouble seen while loading (crashed tab, failed request). */
  cfNavError?: string;
  /** One line per exit tried: outcome, page title, text length, in-app steps. */
  cfTrace?: string[];
  /** Screenshot of the final page, so a server-only failure can be seen. */
  cfScreenshot?: string;
  /** For open_url: one entry per sub-step run on the page, in order. */
  webSteps?: WebStepLog[];
};

export type EmbywatchConfig = {
  username: string;
  password: string;
  playDuration?: number;
  userAgent?: string;
  /** Mark the episode as watched after playback completes. Defaults to true. */
  markWatched?: boolean;
  /** ID of a proxy from the settings proxies list, if any. */
  proxyId?: string;
  /**
   * Verify the media is actually streamable (disk online) before reporting
   * playback, so an offline file is never reported as watched. Defaults to true.
   */
  verifyPlayable?: boolean;
  /**
   * Real Watch: continuously stream the actual media bytes from Emby at real
   * playback pace (direct play), so the server sees genuine streaming traffic
   * like a real client instead of progress reports alone. Defaults to false.
   */
  realWatch?: boolean;
  /**
   * Sequence Play: resume from the user's last position (Emby "Continue
   * Watching"), falling back to Next Up then a random item; when an episode
   * finishes it plays the next one until the play duration is used up.
   * Defaults to false.
   */
  sequencePlay?: boolean;
  /**
   * Restrict watching to one Emby library, by its name or its 1-based index in
   * the user's library list. If it doesn't resolve, the whole server is used.
   */
  library?: string;
};

/**
 * Why Real Watch pulled no bytes, when the toggle was on. Recorded so a run that
 * streamed nothing explains itself instead of just showing 0 MB.
 */
export type RealWatchNote =
  /** No direct-play, direct-stream or transcode URL the server would serve. */
  | 'no-stream-url'
  /** A stream URL resolved, but every ranged read failed. */
  | 'stream-failed';

// One played item within a run (a single episode/movie segment).
export type EmbywatchEpisode = {
  itemType: string;
  title: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  runtimeSeconds: number;
  startSeconds: number;
  endSeconds: number;
  watchedSeconds: number;
  markedWatched: boolean;
  streamedBytes?: number;
  realWatchNote?: RealWatchNote;
  /** True when the bytes came from the transcode fallback, not direct play. */
  realWatchTranscoded?: boolean;
};

export type EmbywatchLog = EmbywatchEpisode & {
  /** True when this run used Sequence Play (resume + next-episode chaining). */
  sequencePlay?: boolean;
  /** Episodes fully finished this run (Sequence Play chaining). */
  episodesCompleted?: number;
  /**
   * Every item played this run, in order. Present for Sequence Play so the log
   * can recall each episode; the top-level fields mirror the last entry.
   */
  episodes?: EmbywatchEpisode[];
};

export type TgProxy = {
  ip: string;
  port: number;
  socksType: 4 | 5;
  username?: string;
  password?: string;
};

