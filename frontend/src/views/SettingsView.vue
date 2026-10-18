<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t("settings.title") }}</h2>
    </div>

    <div class="settings-grid">
      <!-- System defaults -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.sysDefaults") }}</div>

          <div v-if="saveMsg" class="success-msg">{{ saveMsg }}</div>
          <div v-if="saveError" class="error-msg">{{ saveError }}</div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelTimezone")
              }}</label>
              <select v-model="form.default_timezone" class="form-select">
                <option v-for="tz in timezones" :key="tz" :value="tz">
                  {{ tz }}
                </option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelMaxRetries")
              }}</label>
              <input
                v-model.number="form.default_max_retry"
                class="form-input"
                type="number"
                min="1"
                max="10"
              />
            </div>
          </div>

          <div class="form-group">
            <label class="form-check">
              <input v-model="form.check_daily_run" type="checkbox" />
              <span>{{ t("settings.labelDailyRun") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.dailyRunHint") }}
            </p>
          </div>

          <button
            class="btn btn-primary"
            :disabled="saving"
            @click="saveSettings"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ saving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- TG Notifications -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.notifySection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.notifyHint") }}
          </p>

          <!-- With no token the deprecated account sender is what still runs, so say so
               here rather than only inside the collapsed section below -->
          <p
            v-if="!notifyBot.configured"
            style="font-size: 12px; margin: -6px 0 12px; color: #c47f17"
          >
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.notifyNoBotWarning") }}
          </p>

          <div v-if="notifyMsg" class="success-msg">{{ notifyMsg }}</div>
          <div v-if="notifyError" class="error-msg">{{ notifyError }}</div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelNotifyBotToken")
            }}</label>
            <input
              v-model.trim="notifyForm.botToken"
              class="form-input"
              autocomplete="off"
              :placeholder="
                notifyBotTokenMasked || t('settings.notifyBotTokenPlaceholder')
              "
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.notifyBotTokenHint") }}
            </p>
            <p
              v-if="notifyBot.configured"
              style="font-size: 12px; margin: 4px 0 0"
              :style="{ color: notifyBot.ok ? '#2e9e5b' : '#c0392b' }"
            >
              <i
                :class="
                  notifyBot.ok
                    ? 'fa-solid fa-circle-check'
                    : 'fa-solid fa-circle-exclamation'
                "
              ></i>
              {{
                notifyBot.ok
                  ? `${t("settings.notifyBotOk")}: @${notifyBot.username}`
                  : notifyBot.error || t("settings.notifyBotBad")
              }}
            </p>
          </div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelNotifyBotTarget")
            }}</label>
            <input
              v-model.trim="notifyForm.botTarget"
              class="form-input"
              :placeholder="t('settings.notifyBotTargetPlaceholder')"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.notifyBotTargetHint") }}
            </p>
            <button
              class="btn btn-ghost btn-sm"
              style="margin-top: 6px"
              :disabled="notifyChatsLoading"
              @click="loadNotifyChats"
            >
              <i class="fa-solid fa-magnifying-glass"></i>
              {{
                notifyChatsLoading
                  ? t("settings.notifyChatsLoading")
                  : t("settings.notifyFindChatsBtn")
              }}
            </button>
            <p
              v-if="notifyChatsHint"
              style="font-size: 12px; color: #888; margin: 6px 0 0"
            >
              {{ notifyChatsHint }}
            </p>
            <div v-if="notifyChats.length" style="margin-top: 6px">
              <button
                v-for="c in notifyChats"
                :key="c.id"
                class="btn btn-ghost btn-sm"
                style="display: block; width: 100%; text-align: left"
                @click="notifyForm.botTarget = String(c.id)"
              >
                {{ c.title }}
                <span style="color: #888">— {{ c.id }} ({{ c.type }})</span>
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelNotifyEvents")
            }}</label>
            <div class="event-pills">
              <label
                v-for="ev in notifyEventOptions"
                :key="ev.value"
                class="event-pill"
                :class="{ active: notifyForm.events.includes(ev.value) }"
              >
                <input
                  type="checkbox"
                  :checked="notifyForm.events.includes(ev.value)"
                  @change="toggleNotifyEvent(ev.value)"
                />
                {{ ev.label }}
              </label>
            </div>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              class="btn btn-primary"
              :disabled="notifySaving"
              @click="saveNotify"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{ notifySaving ? t("common.saving") : t("settings.saveBtn") }}
            </button>
            <button
              class="btn btn-ghost"
              :disabled="notifyTesting || notifySaving"
              @click="testNotifyBot"
            >
              <i class="fa-solid fa-paper-plane"></i>
              {{
                notifyTesting
                  ? t("settings.notifyTesting")
                  : t("settings.notifyTestBtn")
              }}
            </button>
          </div>

          <!-- Pre-bot sender: deprecated and slated for removal. Only used while no token
               is set, and only for jobs whose account is authenticated. -->
          <div
            style="
              border-top: 1px solid var(--border, #333);
              margin-top: 16px;
              padding-top: 12px;
            "
          >
            <button
              class="btn btn-ghost btn-sm"
              @click="notifyLegacyOpen = !notifyLegacyOpen"
            >
              <i
                :class="
                  notifyLegacyOpen
                    ? 'fa-solid fa-chevron-down'
                    : 'fa-solid fa-chevron-right'
                "
              ></i>
              {{ t("settings.notifyLegacyTitle") }}
              <span style="color: #c47f17; font-weight: 400">
                ({{ t("settings.notifyDeprecatedTag") }})
              </span>
            </button>
            <div v-if="notifyLegacyOpen" style="margin-top: 10px">
              <p style="font-size: 12px; margin: 0 0 8px; color: #c47f17">
                <i class="fa-solid fa-triangle-exclamation"></i>
                {{ t("settings.notifyLegacyDeprecated") }}
              </p>
              <p style="font-size: 12px; color: #888; margin: 0 0 8px">
                {{ t("settings.notifyLegacyHint") }}
              </p>
              <label class="form-label">{{
                t("settings.labelNotifyUsername")
              }}</label>
              <input
                v-model.trim="notifyForm.username"
                class="form-input"
                :placeholder="t('settings.notifyUsernamePlaceholder')"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Cloudflare solver -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.cfSolver.title") }}</div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.cfSolver.hint") }}
          </p>
          <div v-if="cfInstallMsg" class="success-msg">{{ cfInstallMsg }}</div>
          <div v-if="cfInstallError" class="error-msg">{{ cfInstallError }}</div>
          <p style="font-size: 12px; margin: 0 0 8px">
            {{ t("settings.cfSolver.status") }}:
            <strong :style="{ color: cfChromiumInstalled ? '#2e9e5b' : '#c47f17' }">
              {{ cfChromiumInstalled ? t("settings.cfSolver.stateInstalled") : t("settings.cfSolver.stateNotInstalled") }}
            </strong>
            <!-- Only when the build list is unavailable (an older backend): otherwise every
                 build is listed below, and repeating the preferred one here reads as a
                 contradiction of the second entry -->
            <template v-if="!cfBuilds.length">
              <span v-if="cfChromiumVersion" style="color: #888"> — {{ cfChromiumVersion }}</span>
              <span v-if="cfChromiumTier" style="color: #888">
                ({{ cfChromiumTier === "keyed" ? t("settings.cfSolver.tierKeyed") : t("settings.cfSolver.tierFree") }})
              </span>
            </template>
          </p>
          <p
            v-if="!cfBuilds.length && cfChromiumPath"
            style="font-size: 11px; color: #888; margin: -6px 0 12px; word-break: break-all"
          >
            {{ cfChromiumPath }}
          </p>
          <!-- Both tiers can be installed at once and a job may run on either, so each is
               listed with which one it is and when it gets used -->
          <div v-if="cfBuilds.length" style="margin: 0 0 12px">
            <div v-for="b in cfBuilds" :key="b.path" style="margin-bottom: 6px">
              <span style="font-size: 12px">
                <strong>{{
                  b.tier === "keyed"
                    ? t("settings.cfSolver.tierKeyed")
                    : t("settings.cfSolver.tierFree")
                }}</strong>
                <span style="color: #888"> — CloakBrowser {{ b.version }}</span>
                <span
                  :style="`margin-left:6px;font-size:11px;color:${b.preferred ? '#2e9e5b' : '#888'}`"
                >
                  {{
                    b.preferred
                      ? t("settings.cfSolver.buildDefault")
                      : t("settings.cfSolver.buildFallback")
                  }}
                </span>
              </span>
              <div style="font-size: 11px; color: #aaa; word-break: break-all">{{ b.path }}</div>
            </div>
          </div>
          <p
            v-if="cfChromiumTier === 'keyed' && !cfFreeInstalled"
            style="font-size: 12px; margin: -6px 0 12px; color: #c47f17"
          >
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.cfSolver.noFreeFallback") }}
          </p>
          <p v-if="cfKeyedPending" style="font-size: 12px; margin: -6px 0 12px; color: #c47f17">
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.cfSolver.keyedPending") }}
          </p>
          <p v-if="cfChromiumInstalled && !cfFontsInstalled" style="font-size: 12px; margin: -6px 0 12px; color: #c47f17">
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ t("settings.cfSolver.fontsMissing") }}<span v-if="cfFontsMissing"> ({{ cfFontsMissing }})</span>
          </p>
          <div class="form-group" style="margin: 0 0 12px; max-width: 320px">
            <label class="form-label">{{ t("settings.cfSolver.langLabel") }}</label>
            <select v-model="cfBrowserLang" class="form-select" @change="saveCfBrowserLang">
              <option value="">{{ t("settings.cfSolver.langFollowExit") }}</option>
              <option v-for="l in CF_LOCALES" :key="l.id" :value="l.id">
                {{ l.name }} ({{ l.id }})
              </option>
            </select>
            <div style="font-size: 11px; color: #888; margin-top: 3px">
              {{ t("settings.cfSolver.langHint") }}
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              class="btn btn-primary"
              :disabled="cfInstalling || cfTesting || cfSolverComplete"
              @click="installCfSolver(false)"
            >
              <i class="fa-solid fa-download"></i>
              {{ cfInstalling ? t("settings.cfSolver.installing") : t(cfInstallLabelKey) }}
            </button>
            <button
              v-if="cfChromiumInstalled"
              class="btn btn-ghost"
              :disabled="cfInstalling || cfTesting"
              @click="installCfSolver(true)"
            >
              <i class="fa-solid fa-rotate"></i>
              {{ cfInstalling ? t("settings.cfSolver.installing") : t("settings.cfSolver.reinstallBtn") }}
            </button>
            <button
              v-if="!cfFreeInstalled"
              class="btn btn-ghost"
              :disabled="cfInstalling || cfTesting"
              @click="installCfSolver(false, 'free')"
            >
              <i class="fa-solid fa-download"></i>
              {{ cfInstalling ? t("settings.cfSolver.installing") : t("settings.cfSolver.installFreeBtn") }}
            </button>
            <button
              v-if="cfChromiumInstalled"
              class="btn btn-ghost"
              :disabled="cfInstalling || cfTesting"
              @click="testCfSolver"
            >
              <i class="fa-solid fa-flask"></i>
              {{ cfTesting ? t("settings.cfSolver.testing") : t("settings.cfSolver.testBtn") }}
            </button>
          </div>
          <div v-if="cfChromiumInstalled" style="font-size: 11px; color: #888; margin-top: 6px">
            {{ t("settings.cfSolver.reinstallHint") }}
          </div>
          <div v-if="!cfFreeInstalled" style="font-size: 11px; color: #888; margin-top: 6px">
            {{ t("settings.cfSolver.installFreeHint") }}
          </div>
          <!-- Kept off the row above and styled quietly: it throws away a 200MB download
               that everything else here depends on, so it should not read as a next step -->
          <div
            v-if="cfChromiumInstalled"
            style="margin-top: 12px; padding-top: 10px; border-top: 1px solid #eee"
          >
            <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
              <button
                class="btn btn-ghost btn-sm cf-uninstall-btn"
                :disabled="cfInstalling || cfTesting || cfUninstalling || cfStopping || cfClearingProfiles"
                @click="stopCfBrowsers"
              >
                <i class="fa-solid fa-hand"></i>
                {{ cfStopping ? t("settings.cfSolver.stopping") : t("settings.cfSolver.stopBtn") }}
                <template v-if="cfBrowsersRunning > 0"> ({{ cfBrowsersRunning }})</template>
              </button>
              <button
                class="btn btn-ghost btn-sm cf-uninstall-btn"
                :disabled="cfInstalling || cfTesting || cfUninstalling || cfStopping || cfClearingProfiles"
                @click="clearCfProfiles"
              >
                <i class="fa-solid fa-eraser"></i>
                {{ cfClearingProfiles ? t("settings.cfSolver.clearingProfiles") : t("settings.cfSolver.clearProfilesBtn") }}
                <template v-if="cfProfileCount > 0"> ({{ cfProfileCount }})</template>
              </button>
              <button
                class="btn btn-ghost btn-sm cf-uninstall-btn"
                :disabled="cfInstalling || cfTesting || cfUninstalling || cfStopping"
                @click="confirmUninstallCf = true"
              >
                <i class="fa-solid fa-trash"></i>
                {{ cfUninstalling ? t("settings.cfSolver.uninstalling") : t("settings.cfSolver.uninstallBtn") }}
              </button>
            </div>
            <div style="font-size: 11px; color: #888; margin-top: 6px">
              {{ t("settings.cfSolver.stopHint") }}
              {{ t("settings.cfSolver.clearProfilesHint") }}
              {{ t("settings.cfSolver.uninstallHint") }}
            </div>
          </div>
          <div v-if="cfTestWarnings.length" class="error-msg" style="margin-top: 8px">
            <div v-for="w in cfTestWarnings" :key="w">• {{ w }}</div>
          </div>
          <div
            v-if="cfTestNotes.length"
            style="font-size: 11px; color: #888; margin-top: 8px"
          >
            <div v-for="n in cfTestNotes" :key="n">• {{ n }}</div>
          </div>
          <pre
            v-if="cfTestReport"
            style="font-size: 11px; margin-top: 8px; max-height: 220px; overflow: auto; white-space: pre-wrap"
            >{{ cfTestReport }}</pre
          >

          <!-- CloakBrowser licence keys: one free key per GitHub account, one browser each -->
          <div style="border-top: 1px solid var(--border, #333); margin-top: 16px; padding-top: 12px">
            <button class="btn btn-ghost btn-sm" @click="cfKeysOpen = !cfKeysOpen">
              <i :class="cfKeysOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"></i>
              {{ t("settings.cfKeys.title") }}
              <span style="color: #888; font-weight: 400">({{ cfKeys.length }})</span>
            </button>
            <div v-if="cfKeysOpen" style="margin-top: 10px">
              <p style="font-size: 12px; color: #888; margin: 0 0 12px">
                {{ t("settings.cfKeys.hint") }}
              </p>
              <div v-if="cfKeysMsg" class="success-msg">{{ cfKeysMsg }}</div>
              <div v-if="cfKeysError" class="error-msg">{{ cfKeysError }}</div>
              <p v-if="cfKeys.length" style="font-size: 11px; color: #888; margin: 0 0 8px">
                {{ t("settings.cfKeys.inUse") }}: {{ cfKeysInUse }} / {{ cfKeys.length }}
              </p>
              <div
                v-for="(k, i) in cfKeys"
                :key="i"
                style="display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px"
              >
                <input
                  v-model="k.label"
                  class="form-input"
                  style="flex: 0 0 32%"
                  :placeholder="t('settings.cfKeys.labelPlaceholder')"
                />
                <div style="flex: 1">
                  <input
                    v-model="k.key"
                    class="form-input"
                    :placeholder="t('settings.cfKeys.keyPlaceholder')"
                  />
                  <div v-if="cfKeyChecks[k.label]" style="font-size: 11px; margin-top: 3px"
                    :style="{ color: cfKeyChecks[k.label].valid ? '#2e9e5b' : '#c0392b' }">
                    {{ cfKeyChecks[k.label].valid
                      ? `${t("settings.cfKeys.checkValid")} — ${cfKeyChecks[k.label].plan || "free"}`
                      : cfKeyChecks[k.label].error || t("settings.cfKeys.checkInvalid") }}
                  </div>
                </div>
                <button class="btn btn-ghost btn-sm" @click="cfKeys.splice(i, 1)">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap">
                <button class="btn btn-ghost" @click="cfKeys.push({ label: '', key: '' })">
                  <i class="fa-solid fa-plus"></i>
                  {{ t("settings.cfKeys.addBtn") }}
                </button>
                <button class="btn btn-primary" :disabled="cfKeysSaving" @click="saveCfKeys">
                  <i class="fa-solid fa-floppy-disk"></i>
                  {{ cfKeysSaving ? t("common.saving") : t("common.save") }}
                </button>
                <button
                  v-if="cfKeys.length"
                  class="btn btn-ghost"
                  :disabled="cfKeysSaving || cfKeysChecking"
                  @click="checkCfKeys"
                >
                  <i class="fa-solid fa-circle-check"></i>
                  {{ cfKeysChecking ? t("settings.cfKeys.checking") : t("settings.cfKeys.checkBtn") }}
                </button>
              </div>
            </div>
          </div>

          <!-- Browser timings and limits: defaults are what the solver ships with -->
          <div style="border-top: 1px solid var(--border, #333); margin-top: 16px; padding-top: 12px">
            <button class="btn btn-ghost btn-sm" @click="cfTuningOpen = !cfTuningOpen">
              <i :class="cfTuningOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"></i>
              {{ t("settings.cfTuning.title") }}
            </button>
            <div v-if="cfTuningOpen" style="margin-top: 10px">
              <p style="font-size: 12px; color: #888; margin: 0 0 12px">
                {{ t("settings.cfTuning.hint") }}
              </p>
              <div v-if="cfTuningMsg" class="success-msg">{{ cfTuningMsg }}</div>
              <div v-if="cfTuningError" class="error-msg">{{ cfTuningError }}</div>
              <div v-for="f in cfTuningFields" :key="f" class="form-group">
                <label class="form-label">
                  {{ t(`settings.cfTuning.fields.${f}.label`) }}
                  <span style="font-weight: 400; color: #888">
                    ({{ t("settings.cfTuning.default") }}: {{ cfTuningDefaults[f] }})
                  </span>
                </label>
                <input
                  v-model.number="cfTuningForm[f]"
                  class="form-input"
                  type="number"
                  :min="cfTuningLimits[f]?.min"
                  :max="cfTuningLimits[f]?.max"
                  :placeholder="String(cfTuningDefaults[f])"
                />
                <div style="font-size: 11px; color: #aaa; margin-top: 3px">
                  {{ t(`settings.cfTuning.fields.${f}.hint`) }}
                  <span v-if="cfTuningLimits[f]">
                    {{ t("settings.cfTuning.range") }}: {{ cfTuningLimits[f].min }}–{{ cfTuningLimits[f].max }}
                  </span>
                </div>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 12px">
                <button class="btn btn-primary" :disabled="cfTuningSaving" @click="saveCfTuning">
                  <i class="fa-solid fa-floppy-disk"></i>
                  {{ cfTuningSaving ? t("common.saving") : t("common.save") }}
                </button>
                <button class="btn btn-ghost" :disabled="cfTuningSaving" @click="resetCfTuning">
                  <i class="fa-solid fa-rotate-left"></i>
                  {{ t("settings.cfTuning.resetBtn") }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Database connection -- shown first because nothing else works without it -->
      <div class="card s-col-4">
        <div class="card-body">
          <div
            style="
              display: flex;
              align-items: center;
              justify-content: space-between;
            "
          >
            <div class="card-section-title" style="margin: 0">
              {{ t("settings.database.title") }}
            </div>
            <span :class="dbStatusClass">{{ dbStatusText }}</span>
          </div>

          <p style="font-size: 12px; color: #888; margin: 8px 0 12px">
            {{ t("settings.database.intro") }}
          </p>

          <div v-if="dbMsg" class="success-msg">{{ dbMsg }}</div>
          <div v-if="dbError" class="error-msg">{{ dbError }}</div>

          <div class="form-group">
            <label class="form-label">{{ t("settings.database.uri") }}</label>
            <input
              v-model.trim="dbUri"
              class="form-input"
              type="text"
              :placeholder="t('settings.database.uriPlaceholder')"
              spellcheck="false"
              autocomplete="off"
            />
          </div>

          <div class="form-group">
            <label class="form-label">{{ t("settings.database.dbName") }}</label>
            <input
              v-model.trim="dbName"
              class="form-input"
              type="text"
              :placeholder="t('settings.database.dbNamePlaceholder')"
              spellcheck="false"
              autocomplete="off"
            />
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              class="btn btn-ghost"
              :disabled="dbTesting || !dbUri"
              @click="testDb"
            >
              <i class="fa-solid fa-plug"></i>
              {{ dbTesting ? t("settings.database.testing") : t("settings.database.test") }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="dbSaving || !dbUri"
              @click="saveDb"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{ dbSaving ? t("settings.database.saving") : t("settings.database.save") }}
            </button>
            <button
              v-if="dbStatus?.source === 'ui'"
              class="btn btn-ghost btn-danger"
              style="margin-left: auto"
              :disabled="dbSaving"
              @click="disconnectDb"
            >
              {{ t("settings.database.disconnect") }}
            </button>
          </div>

          <!-- What the last test found, so the operator can tell a typo from a firewall -->
          <div
            v-if="dbTestResult"
            style="
              margin-top: 12px;
              padding: 10px 12px;
              border-radius: 6px;
              background: #f6f8fa;
              font-size: 12px;
              line-height: 1.7;
            "
          >
            <div v-if="dbTestResult.serverVersion">
              {{ t("settings.database.serverVersion") }}:
              <strong>{{ dbTestResult.serverVersion }}</strong>
            </div>
            <div v-if="dbTestResult.latencyMs != null">
              {{ t("settings.database.latency") }}:
              <strong>{{ dbTestResult.latencyMs }} ms</strong>
            </div>
            <div v-if="dbTestResult.database">
              DB: <strong>{{ dbTestResult.database }}</strong>
            </div>
            <div v-if="dbTestResult.collections?.length">
              {{ t("settings.database.collections") }}:
              {{ dbTestResult.collections.join(", ") }}
            </div>
          </div>

          <div v-if="dbStatus?.ready" style="margin-top: 14px">
            <div class="card-section-title" style="font-size: 12px">
              {{ t("settings.database.counts") }}
            </div>
            <div style="font-size: 12px; color: #666; line-height: 1.9">
              <span>{{ t("settings.database.countsAccounts") }}: {{ dbStatus.counts?.tg_accounts ?? 0 }}</span>
              ·
              <span>{{ t("settings.database.countsJobs") }}: {{ dbStatus.counts?.jobs ?? 0 }}</span>
              ·
              <span>{{ t("settings.database.countsTemplates") }}: {{ dbStatus.counts?.job_templates ?? 0 }}</span>
              ·
              <span>{{ t("settings.database.countsLogs") }}: {{ dbStatus.counts?.job_logs ?? 0 }}</span>
            </div>
          </div>

          <div style="margin-top: 14px">
            <div class="card-section-title" style="font-size: 12px">
              {{ t("settings.database.configPath") }}
            </div>
            <code
              style="
                display: block;
                font-size: 11px;
                color: #555;
                word-break: break-all;
                margin-top: 4px;
              "
              >{{ dbStatus?.configPath ?? "" }}</code
            >
            <p style="font-size: 11px; color: #999; margin: 6px 0 0">
              {{ t("settings.database.configPathHint") }}
            </p>
          </div>

          <!-- Legacy data: offered only while the old SQLite file has not been imported -->
          <div v-if="dbStatus?.ready" style="margin-top: 16px">
            <div class="card-section-title" style="font-size: 12px">
              {{ t("settings.database.importSqlite") }}
            </div>
            <p style="font-size: 11px; color: #999; margin: 4px 0 8px">
              {{ t("settings.database.importSqliteHint") }}
            </p>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="dbImporting || dbStatus.sqliteImported"
              @click="importSqlite"
            >
              {{
                dbImporting
                  ? t("settings.database.importSqliteRunning")
                  : dbStatus.sqliteImported
                    ? t("settings.database.importSqliteDone")
                    : t("settings.database.importSqliteRun")
              }}
            </button>
            <div
              v-if="dbImportResult"
              style="font-size: 11px; color: #666; margin-top: 8px"
            >
              {{ dbImportResult.message }}
            </div>
          </div>
        </div>
      </div>

      <!-- Admin credentials -->
      <div class="card s-col-4">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.adminCreds") }}</div>

          <div v-if="credMsg" class="success-msg">{{ credMsg }}</div>
          <div v-if="credError" class="error-msg">{{ credError }}</div>

          <div class="form-group">
            <label class="form-label">
              {{ t("settings.labelNewUsername") }}
              <span style="font-weight: 400; color: #aaa">
                {{ t("settings.hintKeepBlank") }}</span
              >
            </label>
            <input
              v-model.trim="cred.username"
              class="form-input"
              autocomplete="username"
            />
          </div>
          <div class="form-group">
            <label class="form-label">
              {{ t("settings.labelNewPassword") }}
              <span style="font-weight: 400; color: #aaa">
                {{ t("settings.hintKeepBlank") }}</span
              >
            </label>
            <input
              v-model="cred.newPassword"
              class="form-input"
              type="password"
              autocomplete="new-password"
            />
          </div>
          <div class="form-group">
            <label class="form-label"
              >{{ t("settings.labelCurrentPass") }}
              <span style="color: #e63946">*</span></label
            >
            <input
              v-model="cred.currentPassword"
              class="form-input"
              type="password"
              autocomplete="current-password"
            />
          </div>

          <button
            class="btn btn-primary"
            :disabled="credSaving"
            @click="saveCredentials"
          >
            <i class="fa-solid fa-shield-halved"></i>
            {{ credSaving ? t("common.saving") : t("settings.updateBtn") }}
          </button>

          <div class="settings-subsection" style="margin-top: 22px">
            {{ t("settings.sessionsSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.sessionsHint") }}
          </p>
          <button
            class="btn btn-secondary"
            :disabled="revoking"
            @click="signOutEverywhere"
          >
            <i class="fa-solid fa-right-from-bracket"></i>
            {{ revoking ? t("common.saving") : t("settings.revokeSessionsBtn") }}
          </button>
        </div>
      </div>

      <!-- General settings -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.generalSection") }}
          </div>

          <!-- Telegram API credentials -->
          <div class="settings-subsection">
            {{ t("settings.defaultTgApiSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 14px">
            {{ t("settings.defaultTgApiHint") }}
          </p>

          <div v-if="defaultTgApiMsg" class="success-msg">
            {{ defaultTgApiMsg }}
          </div>
          <div v-if="defaultTgApiError" class="error-msg">
            {{ defaultTgApiError }}
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelDefaultTgApiId")
              }}</label>
              <input
                v-model.number="defaultTgApiId"
                class="form-input"
                type="number"
                min="1"
                placeholder="e.g. 1234567"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelDefaultTgApiHash")
              }}</label>
              <input
                v-model.trim="defaultTgApiHashInput"
                class="form-input"
                :placeholder="
                  defaultTgApiHashMasked
                    ? t('settings.defaultTgApiHashPlaceholder')
                    : t('settings.defaultTgApiHashNew')
                "
                style="font-family: monospace"
              />
              <p
                v-if="defaultTgApiHashMasked"
                style="font-size: 11px; color: #888; margin: 4px 0 0"
              >
                {{ t("settings.defaultTgApiHashSet") }}
                <code style="font-size: 11px">{{
                  defaultTgApiHashMasked
                }}</code>
              </p>
            </div>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              class="btn btn-primary"
              :disabled="defaultTgApiSaving"
              @click="saveDefaultTgApi"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{
                defaultTgApiSaving ? t("common.saving") : t("settings.saveBtn")
              }}
            </button>
            <button
              v-if="defaultTgApiId || defaultTgApiHashMasked"
              class="btn btn-ghost"
              :disabled="defaultTgApiClearing"
              @click="clearDefaultTgApi"
            >
              {{
                defaultTgApiClearing
                  ? t("settings.defaultTgApiClearing")
                  : t("settings.defaultTgApiClear")
              }}
            </button>
          </div>

          <!-- Schedule list placement -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.schedulePageSection") }}
          </div>
          <div class="form-group">
            <label class="form-check">
              <input
                type="checkbox"
                v-model="scheduleSeparatePageSetting"
                @change="saveSchedulePage"
              />
              <span>{{ t("settings.schedulePageToggle") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.schedulePageHint") }}
            </p>
          </div>

          <!-- TG account display -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.accountDisplaySection") }}
          </div>
          <div class="form-group">
            <label class="form-check">
              <input
                type="checkbox"
                v-model="accountDisplayWithTgName"
                @change="saveAccountDisplay"
              />
              <span>{{ t("settings.accountDisplayToggle") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.accountDisplayHint") }}
            </p>
          </div>

          <!-- Log retention -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.logRetentionSection") }}
          </div>
          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelLogRetention")
            }}</label>
            <input
              v-model.number="logRetentionDays"
              class="form-input"
              type="number"
              min="0"
              style="max-width: 160px"
              @change="saveLogRetention"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.logRetentionHint") }}
            </p>
          </div>

          <!-- Schedule staggering -->
          <div class="settings-subsection" style="margin-top: 28px">
            {{ t("settings.scheduleGapSection") }}
          </div>
          <div class="form-group">
            <label class="form-label">{{
              t("settings.labelScheduleGap")
            }}</label>
            <input
              v-model.number="scheduleGapMinutes"
              class="form-input"
              type="number"
              min="0"
              max="30"
              style="max-width: 160px"
              @change="saveScheduleGap"
            />
            <p style="font-size: 12px; color: #888; margin: 4px 0 0">
              {{ t("settings.scheduleGapHint") }}
            </p>
          </div>
        </div>
      </div>

      <!-- Proxies -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.proxiesSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.proxiesHint") }}
          </p>

          <div v-if="proxiesMsg" class="success-msg">{{ proxiesMsg }}</div>
          <div v-if="proxiesError" class="error-msg">{{ proxiesError }}</div>

          <div v-for="(p, i) in proxies" :key="p.id">
            <div v-if="editingProxyId === p.id" class="proxy-edit-panel">
              <div class="proxy-row">
                <select
                  v-model="editProxyForm.protocol"
                  class="form-select"
                  style="flex: 0 0 110px"
                >
                  <option value="socks5">SOCKS5</option>
                  <option value="socks4">SOCKS4</option>
                </select>
                <input
                  v-model.trim="editProxyForm.host"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.proxyHost')"
                  @input="onProxyHostInput(editProxyForm)"
                />
                <input
                  v-model.trim="editProxyForm.port"
                  class="form-input"
                  style="flex: 0 0 80px"
                  type="number"
                  min="1"
                  max="65535"
                  :placeholder="t('settings.proxyPort')"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editProxyForm.username"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.proxyUsername')"
                  autocomplete="off"
                />
                <input
                  v-model.trim="editProxyForm.password"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.proxyPassword')"
                  autocomplete="off"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editProxyForm.name"
                  class="form-input"
                  style="flex: 0 0 160px"
                  :placeholder="t('settings.proxyName')"
                />
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="
                    proxyEditTesting ||
                    !editProxyForm.name ||
                    !editProxyForm.host
                  "
                  @click="saveProxyEdit(i)"
                >
                  {{
                    proxyEditTesting
                      ? t("settings.proxyTesting")
                      : t("common.save")
                  }}
                </button>
                <button
                  class="btn btn-sm btn-ghost"
                  @click="editingProxyId = null"
                >
                  {{ t("common.cancel") }}
                </button>
              </div>
            </div>
            <div v-else class="ua-preset-row">
              <span class="ua-preset-name">{{ p.name }}</span>
              <span class="ua-preset-value">{{ p.url }}</span>
              <button
                class="btn btn-sm btn-ghost btn-icon"
                :title="t('common.edit')"
                @click="startEditProxy(p)"
              >
                <i class="fa-solid fa-pen"></i>
              </button>
              <button
                class="btn btn-sm btn-ghost ua-preset-del"
                :title="t('settings.proxyDeleteTip')"
                @click="removeProxy(i)"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>

          <div class="proxy-edit-panel" style="margin-top: 8px">
            <div class="proxy-row">
              <select
                v-model="newProxy.protocol"
                class="form-select"
                style="flex: 0 0 110px"
              >
                <option value="socks5">SOCKS5</option>
                <option value="socks4">SOCKS4</option>
              </select>
              <input
                v-model.trim="newProxy.host"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyHost')"
                @input="onProxyHostInput(newProxy)"
              />
              <input
                v-model.trim="newProxy.port"
                class="form-input"
                style="flex: 0 0 80px"
                type="number"
                min="1"
                max="65535"
                :placeholder="t('settings.proxyPort')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newProxy.username"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyUsername')"
                autocomplete="off"
              />
              <input
                v-model.trim="newProxy.password"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.proxyPassword')"
                autocomplete="off"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newProxy.name"
                class="form-input"
                style="flex: 0 0 160px"
                :placeholder="t('settings.proxyName')"
                @keyup.enter="addProxy"
              />
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newProxy.name || !newProxy.host || proxyTesting"
                @click="addProxy"
              >
                <i class="fa-solid fa-plus"></i>
                {{
                  proxyTesting
                    ? t("settings.proxyTesting")
                    : t("settings.addProxy")
                }}
              </button>
            </div>
          </div>
          <p style="font-size: 11px; color: #888; margin: 4px 0 0">
            {{ t("settings.proxyUrlHint") }}
          </p>

          <!-- Import from a proxy provider -->
          <div class="proxy-edit-panel" style="margin-top: 12px">
            <div class="card-section-title" style="font-size: 12px">
              {{ t("settings.providersSection") }}
            </div>
            <p style="font-size: 11px; color: #888; margin: 0 0 8px">
              {{ t("settings.providersHint") }}
            </p>

            <div
              v-for="(prov, i) in providers"
              :key="prov.id"
              style="border-top: 1px solid #eee; padding-top: 8px; margin-top: 8px"
            >
              <div class="proxy-row">
                <input
                  v-model.trim="prov.name"
                  class="form-input"
                  style="flex: 0 0 140px"
                  :placeholder="t('settings.providerName')"
                />
                <select v-model="prov.type" class="form-input" style="flex: 0 0 130px">
                  <option value="webshare">Webshare</option>
                  <option value="list">{{ t("settings.providerTypeList") }}</option>
                </select>
                <label class="form-checkbox-label" style="flex: 0 0 auto">
                  <input type="checkbox" v-model="prov.enabled" />
                  {{ t("settings.providerEnabled") }}
                </label>
                <button
                  class="btn btn-ghost btn-sm btn-icon"
                  :disabled="providersSyncing"
                  :title="t('settings.providerSyncOne')"
                  @click="syncProviders(prov.id)"
                >
                  <i class="fa-solid fa-rotate"></i>
                </button>
                <button
                  class="btn btn-danger btn-sm btn-icon"
                  :title="t('settings.providerDelete')"
                  @click="providers.splice(i, 1)"
                >
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
              <div class="proxy-row" style="margin-top: 6px">
                <input
                  v-if="prov.type === 'list'"
                  v-model.trim="prov.url"
                  class="form-input"
                  :placeholder="t('settings.providerUrlPlaceholder')"
                />
                <select
                  v-if="prov.type === 'list'"
                  v-model="prov.scheme"
                  class="form-input"
                  style="flex: 0 0 110px"
                >
                  <option value="http">http</option>
                  <option value="socks5">socks5</option>
                </select>
                <input
                  v-model.trim="prov.apiKey"
                  class="form-input"
                  type="password"
                  autocomplete="off"
                  :placeholder="
                    prov.hasKey
                      ? t('settings.providerKeyStored')
                      : prov.type === 'webshare'
                        ? t('settings.providerKeyPlaceholder')
                        : t('settings.providerKeyOptional')
                  "
                />
              </div>
            </div>

            <div class="proxy-row" style="margin-top: 10px">
              <button class="btn btn-ghost btn-sm" @click="addProvider">
                <i class="fa-solid fa-plus"></i> {{ t("settings.providerAdd") }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                :disabled="providersSaving || !providers.length"
                @click="saveProviders"
              >
                <i class="fa-solid fa-floppy-disk"></i>
                {{ providersSaving ? t("common.saving") : t("settings.providerSave") }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                :disabled="providersSyncing || !providers.length"
                @click="syncProviders()"
              >
                <i class="fa-solid fa-rotate"></i>
                {{ providersSyncing ? t("settings.providerSyncing") : t("settings.providerSyncAll") }}
              </button>
            </div>

            <div v-if="providersMsg" class="success-msg" style="margin-top: 8px">{{ providersMsg }}</div>
            <div v-if="providersErrorMsg" class="error-msg" style="margin-top: 8px">{{ providersErrorMsg }}</div>
          </div>

          <button
            class="btn btn-primary"
            style="margin-top: 14px"
            :disabled="proxiesSaving"
            @click="saveProxies"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ proxiesSaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- TG App Clients -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.appClientsSection") }}
          </div>
          <p style="font-size: 12px; color: #888; margin: 0 0 6px">
            {{ t("settings.appClientsHint") }}
          </p>
          <p style="font-size: 12px; color: #888; margin: 0 0 12px">
            {{ t("settings.appClientDeviceVars") }}
          </p>

          <div v-if="appClientsMsg" class="success-msg">
            {{ appClientsMsg }}
          </div>
          <div v-if="appClientsError" class="error-msg">
            {{ appClientsError }}
          </div>

          <div class="tg-client-mode-row">
            <span class="form-label" style="margin: 0">{{
              t("settings.tgClientModeLabel")
            }}</span>
            <label class="radio-opt">
              <input type="radio" v-model="tgClientMode" value="default" />
              {{ t("settings.tgClientModeDefault") }}
            </label>
            <label class="radio-opt">
              <input type="radio" v-model="tgClientMode" value="random" />
              {{ t("settings.tgClientModeRandom") }}
            </label>
          </div>

          <div v-for="(c, i) in appClients" :key="c.id">
            <div v-if="editingClientId === c.id" class="proxy-edit-panel">
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.name"
                  class="form-input"
                  style="flex: 0 0 110px"
                  :placeholder="t('settings.appClientName')"
                />
                <input
                  v-model.trim="editClientForm.deviceModel"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientDevice')"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.systemVersion"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientSystem')"
                />
                <input
                  v-model.trim="editClientForm.appVersion"
                  class="form-input"
                  style="flex: 0 0 120px"
                  :placeholder="t('settings.appClientApp')"
                />
              </div>
              <div class="proxy-row">
                <input
                  v-model.trim="editClientForm.langCode"
                  class="form-input"
                  style="flex: 0 0 80px"
                  :placeholder="t('settings.appClientLangCode')"
                />
                <input
                  v-model.trim="editClientForm.langPack"
                  class="form-input"
                  style="flex: 1"
                  :placeholder="t('settings.appClientLangPack')"
                />
                <input
                  v-model.trim="editClientForm.systemLangCode"
                  class="form-input"
                  style="flex: 0 0 100px"
                  :placeholder="t('settings.appClientSysLang')"
                />
              </div>
              <div class="proxy-row">
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="
                    !editClientForm.name || !editClientForm.deviceModel
                  "
                  @click="saveClientEdit(i)"
                >
                  {{ t("common.save") }}
                </button>
                <button
                  class="btn btn-sm btn-ghost"
                  @click="editingClientId = null"
                >
                  {{ t("common.cancel") }}
                </button>
              </div>
            </div>
            <div v-else class="ua-preset-row">
              <span class="ua-preset-name">{{ c.name }}</span>
              <span class="ua-preset-value"
                >{{ c.deviceModel }} / {{ c.systemVersion }}</span
              >
              <template v-if="tgClientMode !== 'random'">
                <span
                  v-if="c.isDefault"
                  class="badge badge-green"
                  style="font-size: 11px; padding: 1px 6px"
                  >{{ t("settings.appClientIsDefault") }}</span
                >
                <button
                  v-else
                  class="btn btn-sm btn-ghost btn-icon"
                  :title="t('settings.appClientSetDefault')"
                  @click="setDefaultClient(i)"
                >
                  <i class="fa-regular fa-star"></i>
                </button>
              </template>
              <button
                class="btn btn-sm btn-ghost btn-icon"
                :title="t('common.edit')"
                @click="startEditClient(c)"
              >
                <i class="fa-solid fa-pen"></i>
              </button>
              <button
                class="btn btn-sm btn-ghost ua-preset-del"
                :title="t('settings.appClientDeleteTip')"
                :disabled="tgClientMode !== 'random' && c.isDefault"
                @click="removeClient(i)"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>

          <!-- Add new client form -->
          <div class="proxy-edit-panel" style="margin-top: 8px">
            <div class="proxy-row">
              <input
                v-model.trim="newClient.name"
                class="form-input"
                style="flex: 0 0 110px"
                :placeholder="t('settings.appClientName')"
              />
              <input
                v-model.trim="newClient.deviceModel"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientDevice')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newClient.systemVersion"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientSystem')"
              />
              <input
                v-model.trim="newClient.appVersion"
                class="form-input"
                style="flex: 0 0 120px"
                :placeholder="t('settings.appClientApp')"
              />
            </div>
            <div class="proxy-row">
              <input
                v-model.trim="newClient.langCode"
                class="form-input"
                style="flex: 0 0 80px"
                :placeholder="t('settings.appClientLangCode')"
              />
              <input
                v-model.trim="newClient.langPack"
                class="form-input"
                style="flex: 1"
                :placeholder="t('settings.appClientLangPack')"
              />
              <input
                v-model.trim="newClient.systemLangCode"
                class="form-input"
                style="flex: 0 0 100px"
                :placeholder="t('settings.appClientSysLang')"
              />
            </div>
            <div class="proxy-row">
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newClient.name || !newClient.deviceModel"
                @click="addClient"
              >
                <i class="fa-solid fa-plus"></i>
                {{ t("settings.addAppClient") }}
              </button>
            </div>
          </div>

          <button
            class="btn btn-primary"
            style="margin-top: 14px"
            :disabled="appClientsSaving"
            @click="saveAppClients"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ appClientsSaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- Emby defaults -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.embyDefaults") }}</div>

          <div v-if="embyMsg" class="success-msg">{{ embyMsg }}</div>
          <div v-if="embyError" class="error-msg">{{ embyError }}</div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelPlayDuration")
              }}</label>
              <input
                v-model.number="form.default_play_duration"
                class="form-input"
                type="number"
                min="30"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.labelDeviceName")
              }}</label>
              <input
                v-model.trim="form.default_device_name"
                class="form-input"
                placeholder="Mac"
              />
              <p style="font-size: 12px; color: #888; margin: 4px 0 0">
                {{ t("settings.deviceNameVars") }}
              </p>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t("settings.labelUserAgent") }}</label>
            <select v-model="form.default_ua" class="form-select">
              <option value="">— {{ t("jobs.uaDefault") }} —</option>
              <option v-for="p in uaPresets" :key="p.name" :value="p.value">
                {{ p.name }}
              </option>
            </select>
          </div>

          <div style="margin-bottom: 16px">
            <div class="card-section-title" style="margin-bottom: 10px">
              {{ t("settings.uaPresetsSection") }}
            </div>
            <div v-for="(p, i) in uaPresets" :key="i" class="ua-preset-row">
              <span class="ua-preset-name">{{ p.name }}</span>
              <span class="ua-preset-value">{{ p.value }}</span>
              <button
                class="btn btn-sm btn-ghost ua-preset-del"
                :title="t('settings.uaPresetDeleteTip')"
                @click="removeUaPreset(i)"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div class="ua-preset-add">
              <input
                v-model.trim="newPresetName"
                class="form-input"
                style="flex: 0 0 140px"
                :placeholder="t('settings.uaPresetName')"
                @keyup.enter="addUaPreset"
              />
              <input
                v-model.trim="newPresetValue"
                class="form-input"
                style="flex: 1; min-width: 0"
                :placeholder="t('settings.uaPresetValue')"
                @keyup.enter="addUaPreset"
              />
              <button
                class="btn btn-ghost btn-sm"
                :disabled="!newPresetName || !newPresetValue"
                @click="addUaPreset"
              >
                <i class="fa-solid fa-plus"></i> {{ t("settings.addPreset") }}
              </button>
            </div>
          </div>

          <button
            class="btn btn-primary"
            :disabled="embySaving"
            @click="saveEmby"
          >
            <i class="fa-solid fa-floppy-disk"></i>
            {{ embySaving ? t("common.saving") : t("settings.saveBtn") }}
          </button>
        </div>
      </div>

      <!-- Import / Export -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">
            {{ t("settings.importExport.title") }}
          </div>

          <div v-if="importMsg" class="success-msg">{{ importMsg }}</div>
          <div v-if="importError" class="error-msg">{{ importError }}</div>

          <div class="form-group">
            <p style="font-size: 12px; color: #888; margin: 0 0 8px">
              {{ t("settings.importExport.exportHint") }}
            </p>
            <label class="form-label">{{
              t("settings.importExport.exportSecretLabel")
            }}</label>
            <div class="input-with-toggle">
              <input
                v-model="exportSecret"
                :type="showExportSecret ? 'text' : 'password'"
                class="form-input"
                :placeholder="
                  t('settings.importExport.exportSecretPlaceholder')
                "
                autocomplete="new-password"
              />
              <button
                type="button"
                class="toggle-secret-btn"
                @click="showExportSecret = !showExportSecret"
              >
                <i
                  :class="
                    showExportSecret
                      ? 'fa-solid fa-eye-slash'
                      : 'fa-solid fa-eye'
                  "
                ></i>
              </button>
            </div>
            <p style="font-size: 11px; color: #888; margin: 4px 0 8px">
              {{ t("settings.importExport.exportSecretHint") }}
            </p>
            <button class="btn btn-secondary" @click="doExport">
              <i class="fa-solid fa-file-export"></i>
              {{ t("settings.importExport.exportBtn") }}
            </button>
          </div>

          <hr class="ie-divider" />

          <div class="form-group">
            <label class="form-label">{{
              t("settings.importExport.importLabel")
            }}</label>
            <input
              ref="fileInput"
              type="file"
              accept=".json"
              class="form-input"
              @change="onFileChange"
            />
          </div>

          <div v-if="importFileEncrypted" class="form-group">
            <label class="form-label">{{
              t("settings.importExport.importSecretLabel")
            }}</label>
            <div class="input-with-toggle">
              <input
                v-model="importSecret"
                :type="showImportSecret ? 'text' : 'password'"
                class="form-input"
                :placeholder="
                  t('settings.importExport.importSecretPlaceholder')
                "
                autocomplete="current-password"
              />
              <button
                type="button"
                class="toggle-secret-btn"
                @click="showImportSecret = !showImportSecret"
              >
                <i
                  :class="
                    showImportSecret
                      ? 'fa-solid fa-eye-slash'
                      : 'fa-solid fa-eye'
                  "
                ></i>
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-check">
              <input type="checkbox" v-model="importForceReauth" />
              <span>{{ t("settings.importExport.forceReauthLabel") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.importExport.forceReauthHint") }}
            </p>
            <div
              v-if="!importForceReauth"
              class="supplier-no-key-warning"
              style="margin-top: 8px"
            >
              {{ t("settings.importExport.forceReauthRisk") }}
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{
              t("settings.importExport.importMode")
            }}</label>
            <div class="import-mode-row">
              <label class="import-mode-option">
                <input type="radio" v-model="importMode" value="merge" />
                <div>
                  <div class="import-mode-label">
                    {{ t("settings.importExport.modeMerge") }}
                  </div>
                  <div class="import-mode-hint">
                    {{ t("settings.importExport.modeMergeHint") }}
                  </div>
                </div>
              </label>
              <label class="import-mode-option">
                <input type="radio" v-model="importMode" value="replace" />
                <div>
                  <div class="import-mode-label">
                    {{ t("settings.importExport.modeReplace") }}
                  </div>
                  <div class="import-mode-hint">
                    {{ t("settings.importExport.modeReplaceHint") }}
                  </div>
                </div>
              </label>
            </div>
          </div>

          <div v-if="importMode === 'replace'" class="form-group">
            <label class="form-label">{{
              t("settings.importExport.confirmPasswordLabel")
            }}</label>
            <div class="input-with-toggle">
              <input
                :type="showImportConfirmPassword ? 'text' : 'password'"
                class="form-control"
                v-model="importConfirmPassword"
                :placeholder="t('settings.importExport.confirmPasswordPlaceholder')"
              />
              <button
                type="button"
                class="toggle-secret-btn"
                @click="showImportConfirmPassword = !showImportConfirmPassword"
              >
                <i :class="showImportConfirmPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'"></i>
              </button>
            </div>
          </div>

          <button
            class="btn btn-primary"
            :disabled="importing"
            @click="doImport"
          >
            <i class="fa-solid fa-file-import"></i>
            {{
              importing
                ? t("settings.importExport.importing")
                : t("settings.importExport.importBtn")
            }}
          </button>
        </div>
      </div>

      <!-- AI settings -->
      <div class="card s-col-12">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.aiSection") }}</div>
          <p style="font-size: 12px; color: #888; margin: 0 0 16px">
            {{ t("settings.aiHint") }}
          </p>

          <!-- Fallback toggle -->
          <div class="form-group">
            <label class="form-check">
              <input v-model="form.ai_fallback_enabled" type="checkbox" @change="saveFallbackEnabled" />
              <span>{{ t("settings.aiFallbackLabel") }}</span>
            </label>
            <p style="font-size: 12px; color: #888; margin: 4px 0 0 24px">
              {{ t("settings.aiFallbackHint") }}
            </p>
          </div>

          <!-- Providers list -->
          <div
            style="
              display: flex;
              align-items: center;
              justify-content: space-between;
              margin-bottom: 10px;
            "
          >
            <div class="card-section-title" style="margin: 0">
              {{ t("settings.aiProvidersSection") }}
            </div>
            <button
              class="btn btn-ghost btn-sm"
              @click="showAddSupplier = true"
            >
              <i class="fa-solid fa-plus"></i> {{ t("settings.addProvider") }}
            </button>
          </div>

          <div v-if="aiSuppliersLoading" style="color: #888; font-size: 13px">
            {{ t("common.loading") }}
          </div>
          <div
            v-else-if="!suppliers.length"
            style="color: #aaa; font-size: 13px; margin-bottom: 12px"
          >
            {{ t("settings.noSuppliers") }}
          </div>

          <div v-for="s in suppliers" :key="s.id" class="supplier-card">
            <!-- Supplier header -->
            <div v-if="editingSupplierId !== s.id" class="supplier-header">
              <div class="supplier-info">
                <span class="supplier-name">{{ s.name }}</span>
                <span class="supplier-url">{{ s.base_url }}</span>
                <span class="supplier-timeout">{{ s.timeout_ms }}ms</span>
              </div>
              <div class="supplier-actions">
                <button
                  class="btn btn-ghost btn-sm"
                  @click="startEditSupplier(s)"
                >
                  {{ t("settings.editSupplier") }}
                </button>
                <button
                  class="btn btn-ghost btn-sm btn-danger"
                  @click="removeSupplier(s.id)"
                >
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            </div>
            <div
              v-if="editingSupplierId !== s.id && !s.api_key"
              class="supplier-no-key-warning"
            >
              <i class="fa-solid fa-triangle-exclamation"></i>
              {{ t("settings.supplierNoApiKey") }}
            </div>

            <!-- Supplier edit form -->
            <div v-if="editingSupplierId === s.id" class="supplier-edit-form">
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">{{
                    t("settings.supplierName")
                  }}</label>
                  <input v-model.trim="editForm.name" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">{{
                    t("settings.supplierTimeout")
                  }}</label>
                  <input
                    v-model.number="editForm.timeout_ms"
                    class="form-input"
                    type="number"
                    min="1000"
                    step="1000"
                  />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierBaseUrl")
                }}</label>
                <input
                  v-model.trim="editForm.base_url"
                  class="form-input"
                  placeholder="https://openrouter.ai/api/v1"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierApiKey")
                }}</label>
                <input
                  v-model.trim="editForm.api_key"
                  class="form-input"
                  type="text"
                  autocomplete="off"
                  placeholder="sk-..."
                />
              </div>
              <div style="display: flex; gap: 8px">
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="supplierSaving"
                  @click="saveEditSupplier(s.id)"
                >
                  {{
                    supplierSaving
                      ? t("common.saving")
                      : t("settings.saveSupplier")
                  }}
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  @click="editingSupplierId = null"
                >
                  {{ t("settings.cancelEdit") }}
                </button>
              </div>
            </div>

            <!-- Models -->
            <div class="supplier-models">
              <div class="supplier-models-label">
                {{ t("settings.supplierModels") }}
              </div>
              <div class="supplier-model-chips">
                <span v-for="m in s.models" :key="m.id" class="model-chip">
                  {{ m.model_id }}
                  <button
                    class="model-chip-del"
                    @click="removeModel(s.id, m.id)"
                  >
                    <i class="fa-solid fa-xmark"></i>
                  </button>
                </span>
                <span
                  v-if="!s.models.length"
                  style="color: #aaa; font-size: 12px"
                  >—</span
                >
              </div>
              <div class="model-add-row">
                <input
                  v-model.trim="newModelInputs[s.id]"
                  class="form-input form-input-sm"
                  :placeholder="t('settings.modelId')"
                  @keyup.enter="addModel(s.id)"
                />
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="!newModelInputs[s.id]"
                  @click="addModel(s.id)"
                >
                  <i class="fa-solid fa-plus"></i> {{ t("settings.addModel") }}
                </button>
              </div>
            </div>
          </div>

          <!-- Add supplier form -->
          <div v-if="showAddSupplier" class="supplier-card supplier-edit-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierName")
                }}</label>
                <input
                  v-model.trim="newSupplierForm.name"
                  class="form-input"
                  placeholder="OpenRouter"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{
                  t("settings.supplierTimeout")
                }}</label>
                <input
                  v-model.number="newSupplierForm.timeout_ms"
                  class="form-input"
                  type="number"
                  min="1000"
                  step="1000"
                />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.supplierBaseUrl")
              }}</label>
              <input
                v-model.trim="newSupplierForm.base_url"
                class="form-input"
                placeholder="https://openrouter.ai/api/v1"
              />
            </div>
            <div class="form-group">
              <label class="form-label">{{
                t("settings.supplierApiKey")
              }}</label>
              <input
                v-model.trim="newSupplierForm.api_key"
                class="form-input"
                type="text"
                autocomplete="off"
                placeholder="sk-..."
              />
            </div>
            <div style="display: flex; gap: 8px">
              <button
                class="btn btn-primary btn-sm"
                :disabled="
                  supplierSaving ||
                  !newSupplierForm.name ||
                  !newSupplierForm.base_url
                "
                @click="createSupplier"
              >
                {{
                  supplierSaving
                    ? t("common.saving")
                    : t("settings.saveSupplier")
                }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                @click="showAddSupplier = false"
              >
                {{ t("settings.cancelEdit") }}
              </button>
            </div>
          </div>

          <div v-if="supplierError" class="error-msg" style="margin-top: 8px">
            {{ supplierError }}
          </div>

          <!-- Default model -->
          <div
            style="
              margin-top: 20px;
              padding-top: 16px;
              border-top: 1px solid #e5e7eb;
            "
          >
            <div class="form-group">
              <label class="form-label">{{ t("settings.defaultModel") }}</label>
              <select v-model="form.ai_default_model_id" class="form-select">
                <option value="">{{ t("settings.defaultModelNone") }}</option>
                <optgroup v-for="s in suppliers" :key="s.id" :label="s.name">
                  <option v-for="m in s.models" :key="m.id" :value="String(m.id)">
                    {{ m.model_id }}
                  </option>
                </optgroup>
              </select>
            </div>
            <div v-if="aiMsg" class="success-msg">{{ aiMsg }}</div>
            <div v-if="aiError" class="error-msg">{{ aiError }}</div>
            <button
              class="btn btn-primary"
              :disabled="aiSaving"
              @click="saveAi"
            >
              <i class="fa-solid fa-floppy-disk"></i>
              {{
                aiSaving ? t("common.saving") : t("settings.saveDefaultModel")
              }}
            </button>
          </div>
        </div>
      </div>

      <!-- Memory -->
      <div class="card s-col-6">
        <div class="card-body">
          <div class="card-section-title">{{ t("settings.memorySection") }}</div>

          <div v-if="memoryLoading" style="color: #888; font-size: 13px">
            {{ t("common.loading") }}
          </div>
          <template v-else-if="memory">
            <!-- A previous kill is the thing worth surfacing: the process could not log it -->
            <div v-if="memory.lastBeforeCrash" class="error-msg">
              {{ crashText }}
              <div
                v-if="memory.lastBeforeCrash.runs.length"
                style="margin-top: 4px"
              >
                {{ t("settings.memoryCrashJobs") }}
                {{
                  memory.lastBeforeCrash.runs
                    .map((r) => `${r.jobName} (#${r.logId})`)
                    .join(", ")
                }}
              </div>
            </div>

            <div class="mem-rows">
              <div class="mem-row">
                <span>{{ t("settings.memoryCurrent") }}</span>
                <strong>{{ memory.current.rssMb }} MB</strong>
              </div>
              <div class="mem-row">
                <span>{{ t("settings.memoryPeak") }}</span>
                <strong>{{ memory.peak?.rssMb ?? memory.current.rssMb }} MB</strong>
              </div>
              <div class="mem-row">
                <span>{{ t("settings.memoryExternal") }}</span>
                <strong>{{ memory.current.externalMb }} MB</strong>
              </div>
              <div class="mem-row">
                <span>{{ t("settings.memoryHeap") }}</span>
                <strong>{{ memory.current.heapUsedMb }} MB</strong>
              </div>
              <div v-if="memory.limitMb" class="mem-row">
                <span>{{ t("settings.memoryLimit") }}</span>
                <strong>{{ memory.limitMb }} MB ({{ memoryPercent }}%)</strong>
              </div>
            </div>
            <p style="font-size: 12px; color: #888; margin: 8px 0 0">
              {{ t("settings.memoryHint") }}
            </p>
          </template>
          <div v-else class="error-msg">{{ t("settings.memoryUnavailable") }}</div>

          <button
            class="btn btn-ghost btn-sm"
            style="margin-top: 10px"
            :disabled="memoryLoading"
            @click="loadMemory"
          >
            <i class="fa-solid fa-rotate"></i> {{ t("common.refresh") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Removing every downloaded build: ~200MB each comes back only by downloading again -->
    <div v-if="confirmUninstallCf" class="modal-backdrop">
      <div class="modal" style="width: 420px">
        <h3 class="modal-title">{{ t("settings.cfSolver.uninstallBtn") }}</h3>
        <div class="modal-body">
          <p>{{ t("settings.cfSolver.uninstallConfirm") }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmUninstallCf = false">
            <i class="fa-solid fa-xmark"></i> {{ t("common.cancel") }}
          </button>
          <button class="btn btn-danger" @click="uninstallCfSolver">
            <i class="fa-solid fa-trash"></i> {{ t("settings.cfSolver.uninstallBtn") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import {
  settingsApi,
  authApi,
  dataApi,
  aiSuppliersApi,
  statusApi,
  databaseApi,
  type CfBrowserTest,
  type CfBrowserTestRun,
  type DatabaseStatus,
  type DatabaseTestResult,
  type SqliteImportResult,
} from "../api/client";
import type {
  MemoryReport,
  ExportPayload,
  EncryptedEnvelope,
  Settings,
  UAPreset,
  AiSupplier,
  Proxy,
  ProxyProvider,
  TgAppClient,
  CfKeyView,
  CfKeyCheck,
  NotifyBotInfo,
  NotifyBotChat,
} from "../api/client";
import { t } from "../i18n";
import { setAccountDisplayWithTgName } from "../composables/accountDisplay";
import { setSchedulePageSeparate } from "../composables/schedulePage";

const timezones = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Darwin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Paris",
  "UTC",
];

const form = reactive({
  default_timezone: "Australia/Sydney",
  default_max_retry: 5,
  check_daily_run: true,
  default_ua: "",
  default_play_duration: 300,
  default_device_name: "Mac",
  ai_model: "",
  ai_default_model_id: "",
  ai_fallback_enabled: true,
});
const saving = ref(false);
const saveMsg = ref("");
const saveError = ref("");

const embySaving = ref(false);
const embyMsg = ref("");
const embyError = ref("");

const aiSaving = ref(false);
const aiMsg = ref("");
const aiError = ref("");

const suppliers = ref<AiSupplier[]>([]);
const aiSuppliersLoading = ref(false);
const editingSupplierId = ref<number | null>(null);
const editForm = reactive({
  name: "",
  base_url: "",
  api_key: "",
  timeout_ms: 25000,
});
const newSupplierForm = reactive({
  name: "",
  base_url: "",
  api_key: "",
  timeout_ms: 25000,
});
const showAddSupplier = ref(false);
const supplierSaving = ref(false);
const supplierError = ref("");
const newModelInputs = ref<Record<number, string>>({});

const notifyForm = reactive({
  botToken: "",
  botTarget: "",
  username: "",
  events: ["failed"] as string[],
});
const notifySaving = ref(false);
const notifyMsg = ref("");
const notifyError = ref("");
const notifyTesting = ref(false);
// The stored token is never sent back in full; the mask stands in as the placeholder, and
// leaving the field blank keeps whatever is stored.
const notifyBotTokenMasked = ref("");
const notifyBot = ref<NotifyBotInfo>({ configured: false });
const notifyChats = ref<NotifyBotChat[]>([]);
const notifyChatsLoading = ref(false);
const notifyChatsHint = ref("");
const notifyLegacyOpen = ref(false);

// Cloudflare "I am not a bot" solver: an optional headless browser installed on
// demand into the data dir (keeps the image small).
const cfChromiumInstalled = ref(false);
const cfChromiumVersion = ref("");
// Which build is on disk ("keyed" or "free"), and whether a stored licence key unlocks one
// that has not been downloaded yet -- downloads are deliberate, never automatic.
const cfChromiumTier = ref("");
const cfChromiumPath = ref("");
const cfKeyedPending = ref(false);
// Whether the unlicensed build is on disk as well: it is what a launch with no licence
// seat falls back to, and the keyed build cannot start without one.
const cfFreeInstalled = ref(false);
const cfFontsInstalled = ref(false);
const cfFontsMissing = ref("");
// The fonts live in the data dir, not the image, so a browser installed by an older
// version can be complete while they are still missing. Both have to be there before
// the solver is fully set up.
const cfSolverComplete = computed(
  () => cfChromiumInstalled.value && cfFontsInstalled.value && !cfKeyedPending.value,
);
// The one install button fetches whatever is missing, and the server skips a browser that
// is already there. Saying "install browser" when only the fonts are outstanding leaves no
// button that looks like it installs fonts, so the label follows what will actually download.
const cfInstallLabelKey = computed(() => {
  if (cfKeyedPending.value) return "settings.cfSolver.installKeyedBtn";
  if (cfChromiumInstalled.value && !cfFontsInstalled.value)
    return "settings.cfSolver.installFontsBtn";
  return "settings.cfSolver.installBtn";
});
const cfInstalling = ref(false);
const cfInstallMsg = ref("");
const cfInstallError = ref("");
const cfTesting = ref(false);
const cfTestReport = ref("");
const cfTestWarnings = ref<string[]>([]);
const cfTestNotes = ref<string[]>([]);

// CloakBrowser licence keys. The server only ever sends them masked; a masked value sent
// back unchanged means "keep the stored key", so a label can be edited without pasting the
// key again.
const cfKeysOpen = ref(false);
const cfKeys = ref<Array<{ label: string; key: string }>>([]);
const cfKeysInUse = ref(0);
const cfKeysSaving = ref(false);
const cfKeysChecking = ref(false);
const cfKeysMsg = ref("");
const cfKeysError = ref("");
const cfKeyChecks = ref<Record<string, CfKeyCheck>>({});

function loadCfKeys(s: Settings) {
  try {
    const parsed = JSON.parse(s.cf_cloak_keys_masked ?? "[]") as CfKeyView[];
    cfKeys.value = parsed.map((k) => ({ label: k.label, key: k.masked }));
  } catch {
    cfKeys.value = [];
  }
  cfKeysInUse.value = Number(s.cf_cloak_keys_in_use ?? 0) || 0;
}

async function saveCfKeys() {
  cfKeysSaving.value = true;
  cfKeysMsg.value = "";
  cfKeysError.value = "";
  try {
    const res = await settingsApi.saveCfKeys(cfKeys.value.filter((k) => k.key.trim()));
    cfKeys.value = res.keys.map((k) => ({ label: k.label, key: k.masked }));
    cfKeysInUse.value = res.inUse;
    cfKeyChecks.value = {};
    // Adding the first key means the build it unlocks is now outstanding, so the install
    // panel above has to start offering it
    await refreshCfBuildState();
    cfKeysMsg.value = t("settings.saved");
  } catch (e: any) {
    cfKeysError.value = e?.response?.data?.error ?? e?.message ?? t("settings.cfKeys.saveFailed");
  } finally {
    cfKeysSaving.value = false;
  }
}

/** Re-reads which build is installed and whether a key has one outstanding. */
async function refreshCfBuildState() {
  try {
    const fresh = await settingsApi.get();
    cfChromiumTier.value = fresh.cf_chromium_tier ?? "";
    cfChromiumPath.value = fresh.cf_chromium_path ?? "";
    cfKeyedPending.value = fresh.cf_chromium_keyed_pending === "true";
    cfFreeInstalled.value = fresh.cf_chromium_free_installed === "true";
    cfBrowsersRunning.value = Number(fresh.cf_browsers_running ?? 0);
    cfBuilds.value = parseCfBuilds(fresh.cf_chromium_builds);
    cfProfileCount.value = Number(fresh.cf_profile_count ?? 0);
    cfChromiumVersion.value = fresh.cf_chromium_version ?? "";
  } catch {
    /* the panel keeps what it has */
  }
}

async function checkCfKeys() {
  cfKeysChecking.value = true;
  cfKeysMsg.value = "";
  cfKeysError.value = "";
  try {
    const results = await settingsApi.checkCfKeys();
    cfKeyChecks.value = Object.fromEntries(results.map((r) => [r.label, r]));
  } catch (e: any) {
    cfKeysError.value = e?.response?.data?.error ?? e?.message ?? t("settings.cfKeys.checkFailed");
  } finally {
    cfKeysChecking.value = false;
  }
}

// Browser timings. The server sends the values in force, the shipped defaults and the
// range each is held to, so this form needs no copy of any of them.
type CfLimit = { min: number; max: number };
const cfTuningOpen = ref(false);
const cfTuningSaving = ref(false);
const cfTuningMsg = ref("");
const cfTuningError = ref("");
const cfTuningForm = ref<Record<string, number>>({});
const cfTuningDefaults = ref<Record<string, number>>({});
const cfTuningLimits = ref<Record<string, CfLimit>>({});
const cfTuningFields = computed(() => Object.keys(cfTuningDefaults.value));

function loadCfTuning(s: Settings) {
  const parse = <T,>(raw: string | undefined, fallback: T): T => {
    try {
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  cfTuningDefaults.value = parse(s.cf_tuning_defaults, {} as Record<string, number>);
  cfTuningLimits.value = parse(s.cf_tuning_limits, {} as Record<string, CfLimit>);
  cfTuningForm.value = { ...cfTuningDefaults.value, ...parse(s.cf_tuning, {} as Record<string, number>) };
}

async function saveCfTuning() {
  cfTuningMsg.value = "";
  cfTuningError.value = "";
  cfTuningSaving.value = true;
  try {
    // The server clamps and stores what it will actually use, then hands it back
    const saved = await settingsApi.update({ cf_tuning: JSON.stringify(cfTuningForm.value) });
    loadCfTuning(saved);
    cfTuningMsg.value = t("settings.cfTuning.saved");
  } catch (e: any) {
    cfTuningError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  } finally {
    cfTuningSaving.value = false;
  }
}

function resetCfTuning() {
  cfTuningForm.value = { ...cfTuningDefaults.value };
  cfTuningMsg.value = t("settings.cfTuning.resetHint");
}

/**
 * Locales offered for the browser. Not a full list: these are the languages Mini Apps in
 * this space actually render in, and a name a step can be written against.
 */
const CF_LOCALES = [
  { id: "zh-CN", name: "简体中文" },
  { id: "zh-TW", name: "繁體中文" },
  { id: "en-US", name: "English (US)" },
  { id: "en-GB", name: "English (UK)" },
  { id: "en-AU", name: "English (AU)" },
  { id: "ru-RU", name: "Русский" },
  { id: "ja-JP", name: "日本語" },
  { id: "ko-KR", name: "한국어" },
  { id: "vi-VN", name: "Tiếng Việt" },
  { id: "th-TH", name: "ไทย" },
  { id: "id-ID", name: "Bahasa Indonesia" },
  { id: "pt-BR", name: "Português (BR)" },
  { id: "es-ES", name: "Español" },
  { id: "de-DE", name: "Deutsch" },
  { id: "fr-FR", name: "Français" },
  { id: "tr-TR", name: "Türkçe" },
];

// ── Database connection ────────────────────────────────────────────────────────
// The one setting that cannot be stored in the database. It is read before anything else
// on the page, because every other card here is meaningless without somewhere to save to.

const dbStatus = ref<DatabaseStatus | null>(null);
const dbUri = ref("");
const dbName = ref("");
const dbTesting = ref(false);
const dbSaving = ref(false);
const dbImporting = ref(false);
const dbMsg = ref("");
const dbError = ref("");
const dbTestResult = ref<DatabaseTestResult | null>(null);
const dbImportResult = ref<SqliteImportResult | null>(null);

const dbStatusText = computed(() => {
  if (!dbStatus.value) return "";
  if (dbStatus.value.connecting) return t("settings.database.statusConnecting");
  if (dbStatus.value.ready) return t("settings.database.statusConnected");
  if (!dbStatus.value.configured) return t("settings.database.statusUnconfigured");
  return t("settings.database.statusError");
});

const dbStatusClass = computed(() => {
  if (!dbStatus.value) return "db-badge";
  if (dbStatus.value.ready) return "db-badge db-badge-ok";
  if (dbStatus.value.connecting) return "db-badge db-badge-warn";
  return "db-badge db-badge-bad";
});

async function refreshDbStatus() {
  try {
    dbStatus.value = await databaseApi.status();
    // The URI comes back with its password masked; showing it is what lets the operator see
    // which database they are pointed at, and a blank field is what makes them type another.
    if (!dbUri.value) dbUri.value = dbStatus.value.uriMasked;
    if (!dbName.value && dbStatus.value.database) dbName.value = dbStatus.value.database;
  } catch {
    dbStatus.value = null;
  }
}

async function testDb() {
  dbMsg.value = "";
  dbError.value = "";
  dbTestResult.value = null;
  dbTesting.value = true;
  try {
    const result = await databaseApi.test(dbUri.value, dbName.value || undefined);
    dbTestResult.value = result;
    if (result.ok) {
      dbMsg.value = `${t("settings.database.testOk")} (${result.latencyMs ?? "?"} ms)`;
    } else {
      dbError.value = `${t("settings.database.testFailed")}: ${result.message}`;
    }
  } catch (err: any) {
    dbError.value = `${t("settings.database.testFailed")}: ${
      err?.response?.data?.message ?? err?.message ?? ""
    }`;
  } finally {
    dbTesting.value = false;
  }
}

async function saveDb() {
  if (!dbUri.value) return;
  dbMsg.value = "";
  dbError.value = "";
  dbSaving.value = true;
  try {
    // A first-time save also offers to bring the old SQLite data across, since that is the
    // moment it is most likely to be wanted and the only moment it is obviously safe.
    const firstTime = !dbStatus.value?.ready;
    const result = await databaseApi.save(
      dbUri.value,
      dbName.value || undefined,
      firstTime,
    );
    if (!result.ok) {
      dbError.value = `${t("settings.database.saveFailed")}: ${result.message}`;
      return;
    }
    dbImportResult.value = result.migration ?? null;
    dbMsg.value = t("settings.database.saved");
    await refreshDbStatus();
    // Every other page on the panel was reading "no database" a moment ago, and the values
    // behind them now come from somewhere else. A reload is the honest way to pick that up
    // rather than patching each view's cached state from here.
    setTimeout(() => window.location.reload(), 1200);
  } catch (err: any) {
    dbError.value = `${t("settings.database.saveFailed")}: ${
      err?.response?.data?.message ?? err?.message ?? ""
    }`;
  } finally {
    dbSaving.value = false;
  }
}

async function disconnectDb() {
  if (!window.confirm(t("settings.database.disconnectConfirm"))) return;
  dbMsg.value = "";
  dbError.value = "";
  dbSaving.value = true;
  try {
    dbStatus.value = await databaseApi.disconnect();
    dbUri.value = dbStatus.value.uriMasked;
    dbTestResult.value = null;
  } catch (err: any) {
    dbError.value = err?.response?.data?.error ?? err?.message ?? "";
  } finally {
    dbSaving.value = false;
  }
}

async function importSqlite() {
  dbMsg.value = "";
  dbError.value = "";
  dbImporting.value = true;
  try {
    const result = await databaseApi.importSqlite();
    dbImportResult.value = result;
    if (result.ok) {
      dbMsg.value = result.message || t("settings.database.importSqliteDone");
      await refreshDbStatus();
    } else {
      dbError.value = `${t("settings.database.importSqliteFailed")}: ${result.message}`;
    }
  } catch (err: any) {
    dbError.value = `${t("settings.database.importSqliteFailed")}: ${
      err?.response?.data?.message ?? err?.message ?? ""
    }`;
  } finally {
    dbImporting.value = false;
  }
}

const cfBrowserLang = ref("");

/** Saved as it is chosen: one select is not worth its own save button. */
async function saveCfBrowserLang() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  try {
    await settingsApi.update({ cf_browser_lang: cfBrowserLang.value });
    cfInstallMsg.value = t("settings.saved");
  } catch (e: any) {
    cfInstallError.value = e?.response?.data?.error ?? e?.message ?? t("settings.saveFailed");
  }
}

const cfUninstalling = ref(false);
const cfStopping = ref(false);
const cfClearingProfiles = ref(false);
let cfTestPollTimer: ReturnType<typeof setTimeout> | null = null;
const cfProfileCount = ref(0);
const cfBrowsersRunning = ref(0);
type CfBuild = { tier: "keyed" | "free"; version: string; path: string; preferred: boolean };
const cfBuilds = ref<CfBuild[]>([]);

/** The installed-build list arrives as JSON; a malformed or absent one just means none. */
function parseCfBuilds(raw?: string): CfBuild[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? (parsed as CfBuild[]) : [];
  } catch {
    return [];
  }
}
const confirmUninstallCf = ref(false);

/** Closes every open browser. Whatever job was using one fails, which is the point. */
async function stopCfBrowsers() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfStopping.value = true;
  try {
    const res = await settingsApi.stopCfBrowsers();
    cfInstallMsg.value = t("settings.cfSolver.stopped").replace("{n}", String(res.stopped));
    await refreshCfBuildState();
  } catch (e: any) {
    cfInstallError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.stopFailed");
  } finally {
    cfStopping.value = false;
  }
}

/**
 * Deletes the per-exit profiles. Cookies and cache go; the browser identity does not, since
 * the fingerprint comes from the exit rather than the profile.
 */
async function clearCfProfiles() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfClearingProfiles.value = true;
  try {
    const res = await settingsApi.clearCfProfiles();
    if (res.ok) {
      cfInstallMsg.value = t("settings.cfSolver.profilesCleared").replace(
        "{n}",
        String(res.removed ?? 0),
      );
      await refreshCfBuildState();
    } else {
      cfInstallError.value = res.message ?? t("settings.cfSolver.clearProfilesFailed");
    }
  } catch (e: any) {
    cfInstallError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.clearProfilesFailed");
  } finally {
    cfClearingProfiles.value = false;
  }
}

/** Deletes every downloaded build. The solver has nothing to launch until one is back. */
async function uninstallCfSolver() {
  confirmUninstallCf.value = false;
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfUninstalling.value = true;
  try {
    const res = await settingsApi.uninstallCfSolver();
    if (res.ok) {
      cfChromiumInstalled.value = false;
      cfChromiumVersion.value = "";
      cfChromiumTier.value = "";
      cfChromiumPath.value = "";
      cfFreeInstalled.value = false;
      cfBuilds.value = [];
      cfTestReport.value = "";
      cfTestWarnings.value = [];
      cfTestNotes.value = [];
      await refreshCfBuildState();
      cfInstallMsg.value = res.removed?.length
        ? `${t("settings.cfSolver.uninstalled")} — ${res.removed.join(", ")}`
        : t("settings.cfSolver.uninstalled");
    } else {
      cfInstallError.value = res.message ?? t("settings.cfSolver.uninstallFailed");
    }
  } catch (e: any) {
    cfInstallError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.uninstallFailed");
  } finally {
    cfUninstalling.value = false;
  }
}

/**
 * `force` downloads the browser again over an existing one, updating it. `tier: "free"`
 * fetches the unlicensed build specifically -- a separate download that sits beside the
 * keyed one, so a launch that cannot take a licence seat still has something to run.
 */
async function installCfSolver(force = false, tier?: "free") {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfInstalling.value = true;
  try {
    const res = await settingsApi.installCfSolver(force, tier);
    if (res.ok) {
      cfChromiumInstalled.value = true;
      cfChromiumVersion.value = res.version ?? "";
      cfFontsInstalled.value = res.fontsInstalled === true;
      if (res.fontsInstalled) cfFontsMissing.value = "";
      await refreshCfBuildState();
      cfInstallMsg.value = res.version
        ? `${t("settings.cfSolver.installed")} — ${res.version}`
        : t("settings.cfSolver.installed");
      // The browser is usable without them, so a font failure is a warning beside the
      // success rather than an error in place of it.
      if (!res.fontsInstalled) cfInstallError.value = t("settings.cfSolver.fontsFailed");
    } else {
      cfInstallError.value = res.message || res.output || t("settings.cfSolver.failed");
    }
  } catch (e: any) {
    cfInstallError.value = e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.failed");
  } finally {
    cfInstalling.value = false;
  }
}

// Launches the browser and reports what the page sees of itself, so one install can be
// compared against another when a challenge passes in one place and not the other.
/** Renders whatever the run has produced so far, so results appear build by build. */
function showCfTestRun(run: CfBrowserTestRun) {
  const builds = run.builds ?? [];
  const name = (b: CfBrowserTest) =>
    b.tier === "free"
      ? t("settings.cfSolver.tierFree")
      : b.tier === "keyed"
        ? t("settings.cfSolver.tierKeyed")
        : t("settings.cfSolver.testBtn");
  const label = (b: CfBrowserTest, text: string) =>
    builds.length > 1 ? `[${name(b)}] ${text}` : text;

  cfTestWarnings.value = builds.flatMap((b) => (b.warnings ?? []).map((w) => label(b, w)));
  cfTestNotes.value = builds.flatMap((b) => (b.notes ?? []).map((n) => label(b, n)));
  cfTestReport.value = builds
    .map((b) =>
      JSON.stringify(
        {
          build: name(b),
          ok: b.ok,
          version: b.version,
          executable: b.executable,
          exitCountry: b.exitCountry,
          ...(b.error ? { error: b.error } : {}),
          ...b.env,
        },
        null,
        2,
      ),
    )
    .join("\n\n");

  // Nothing conclusive to say until the last build is in
  if (run.running) return;

  if (run.error && !builds.length) {
    cfInstallError.value = run.error;
    return;
  }
  const failed = builds.filter((b) => !b.ok);
  const passed = builds.filter((b) => b.ok);
  if (failed.length) {
    cfInstallError.value = failed
      .map((b) =>
        builds.length > 1
          ? `${name(b)}: ${b.error || t("settings.cfSolver.testFailed")}`
          : b.error || t("settings.cfSolver.testFailed"),
      )
      .join(" | ");
    // A build that passed is still worth saying so, when another did not
    if (passed.length) {
      cfInstallMsg.value = `${t("settings.cfSolver.testPassed")} — ${passed.map(name).join(", ")}`;
    }
  } else if (builds.length) {
    cfInstallMsg.value =
      builds.length > 1
        ? `${t("settings.cfSolver.testPassed")} — ${builds.map(name).join(", ")}`
        : t("settings.cfSolver.testPassed");
  }
}

// Leaving the page should not leave a timer behind polling for a test nobody is watching
onUnmounted(() => stopCfTestPoll());

function stopCfTestPoll() {
  if (cfTestPollTimer) {
    clearTimeout(cfTestPollTimer);
    cfTestPollTimer = null;
  }
}

async function pollCfTest() {
  stopCfTestPoll();
  try {
    const run = await settingsApi.cfSolverTestStatus();
    showCfTestRun(run);
    if (run.running) {
      cfTestPollTimer = setTimeout(pollCfTest, 2000);
    } else {
      cfTesting.value = false;
    }
  } catch {
    // A blip on the way to the panel is not the test failing; keep watching, slower
    cfTestPollTimer = setTimeout(pollCfTest, 4000);
  }
}

/**
 * Starts the test and follows it. Each build means launching a browser and loading a real
 * page, which together outlast what a proxy will hold a request open for, so the run
 * happens server-side and this polls for it.
 */
async function testCfSolver() {
  cfInstallMsg.value = "";
  cfInstallError.value = "";
  cfTestReport.value = "";
  cfTestWarnings.value = [];
  cfTestNotes.value = [];
  cfTesting.value = true;
  try {
    const run = await settingsApi.testCfSolver();
    showCfTestRun(run);
    if (run.running) {
      cfTestPollTimer = setTimeout(pollCfTest, 2000);
    } else {
      cfTesting.value = false;
    }
  } catch (e: any) {
    // A test already running is not an error: follow that one instead
    if (e?.response?.status === 409) {
      cfTestPollTimer = setTimeout(pollCfTest, 500);
      return;
    }
    cfInstallError.value =
      e?.response?.data?.message ?? e?.message ?? t("settings.cfSolver.testFailed");
    cfTesting.value = false;
  }
}

const uaPresets = ref<UAPreset[]>([]);
const newPresetName = ref("");
const newPresetValue = ref("");

const proxies = ref<Proxy[]>([]);
const proxiesSaving = ref(false);
const proxyTesting = ref(false);
const editingProxyId = ref<string | null>(null);
const proxyEditTesting = ref(false);
const proxiesMsg = ref("");
const proxiesError = ref("");
const providers = ref<ProxyProvider[]>([]);
const providersSaving = ref(false);
const providersSyncing = ref(false);
const providersMsg = ref("");
const providersErrorMsg = ref("");

type ProxyForm = {
  protocol: "socks5" | "socks4";
  host: string;
  port: string;
  username: string;
  password: string;
  name: string;
};
const newProxy = reactive<ProxyForm>({
  protocol: "socks5",
  host: "",
  port: "1080",
  username: "",
  password: "",
  name: "",
});
const editProxyForm = reactive<ProxyForm>({
  protocol: "socks5",
  host: "",
  port: "1080",
  username: "",
  password: "",
  name: "",
});

function buildProxyUrl(f: ProxyForm): string {
  const auth = f.username
    ? `${encodeURIComponent(f.username)}:${encodeURIComponent(f.password)}@`
    : "";
  return `${f.protocol}://${auth}${f.host}:${f.port || "1080"}`;
}

function parseProxyInput(raw: string): Omit<ProxyForm, "name"> | null {
  try {
    const normalized = /^socks[45]?:\/\//i.test(raw) ? raw : `socks5://${raw}`;
    const u = new URL(normalized);
    const proto = u.protocol.replace(":", "").toLowerCase();
    return {
      protocol: proto === "socks4" ? "socks4" : "socks5",
      host: u.hostname,
      port: u.port || "1080",
      username: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
    };
  } catch {
    return null;
  }
}

function onProxyHostInput(form: ProxyForm) {
  const val = form.host;
  if (val.includes("://") || val.includes("@")) {
    const parsed = parseProxyInput(val);
    if (parsed) Object.assign(form, parsed);
  }
}

// ── TG App Clients ─────────────────────────────────────────────────────────────

const appClients = ref<TgAppClient[]>([]);
const tgClientMode = ref<"default" | "random">("default");
const appClientsSaving = ref(false);
const editingClientId = ref<string | null>(null);
const appClientsMsg = ref("");
const appClientsError = ref("");

type AppClientForm = {
  name: string;
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  langPack: string;
  systemLangCode: string;
};
const newClient = reactive<AppClientForm>({
  name: "",
  deviceModel: "",
  systemVersion: "",
  appVersion: "",
  langCode: "en",
  langPack: "",
  systemLangCode: "en-US",
});
const editClientForm = reactive<AppClientForm>({
  name: "",
  deviceModel: "",
  systemVersion: "",
  appVersion: "",
  langCode: "en",
  langPack: "",
  systemLangCode: "en-US",
});

function addClient() {
  if (!newClient.name.trim() || !newClient.deviceModel.trim()) return;
  appClients.value.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: newClient.name.trim(),
    deviceModel: newClient.deviceModel.trim(),
    systemVersion: newClient.systemVersion.trim(),
    appVersion: newClient.appVersion.trim(),
    langCode: newClient.langCode.trim() || "en",
    langPack: newClient.langPack.trim(),
    systemLangCode: newClient.systemLangCode.trim() || "en-US",
    isDefault: false,
  });
  Object.assign(newClient, {
    name: "",
    deviceModel: "",
    systemVersion: "",
    appVersion: "",
    langCode: "en",
    langPack: "",
    systemLangCode: "en-US",
  });
}

function removeClient(index: number) {
  appClients.value.splice(index, 1);
}

function startEditClient(c: TgAppClient) {
  editingClientId.value = c.id;
  Object.assign(editClientForm, {
    name: c.name,
    deviceModel: c.deviceModel,
    systemVersion: c.systemVersion,
    appVersion: c.appVersion,
    langCode: c.langCode,
    langPack: c.langPack,
    systemLangCode: c.systemLangCode,
  });
}

function saveClientEdit(index: number) {
  if (!editClientForm.name.trim() || !editClientForm.deviceModel.trim()) return;
  const existing = appClients.value[index];
  appClients.value[index] = {
    ...existing,
    name: editClientForm.name.trim(),
    deviceModel: editClientForm.deviceModel.trim(),
    systemVersion: editClientForm.systemVersion.trim(),
    appVersion: editClientForm.appVersion.trim(),
    langCode: editClientForm.langCode.trim() || "en",
    langPack: editClientForm.langPack.trim(),
    systemLangCode: editClientForm.systemLangCode.trim() || "en-US",
  };
  editingClientId.value = null;
}

function setDefaultClient(index: number) {
  appClients.value = appClients.value.map((c, i) => ({
    ...c,
    isDefault: i === index,
  }));
}

async function saveAppClients() {
  appClientsMsg.value = "";
  appClientsError.value = "";
  appClientsSaving.value = true;
  try {
    await settingsApi.update({
      tg_app_clients: JSON.stringify(appClients.value),
      tg_client_mode: tgClientMode.value,
    });
    appClientsMsg.value = t("settings.saved");
  } catch (err: any) {
    appClientsError.value =
      err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    appClientsSaving.value = false;
  }
}

// ── Default TG API Credentials ─────────────────────────────────────────────────

const defaultTgApiId = ref<number | "">(0);
const defaultTgApiHashInput = ref("");
const defaultTgApiHashMasked = ref("");
const defaultTgApiSaving = ref(false);
const defaultTgApiClearing = ref(false);
const defaultTgApiMsg = ref("");
const defaultTgApiError = ref("");

// ── TG account display ─────────────────────────────────────────────────────────
const accountDisplayWithTgName = ref(false);
const scheduleSeparatePageSetting = ref(false);

async function saveDefaultTgApi() {
  defaultTgApiMsg.value = "";
  defaultTgApiError.value = "";
  defaultTgApiSaving.value = true;
  try {
    const payload: Record<string, string> = {
      default_tg_api_id: String(defaultTgApiId.value || ""),
    };
    // Only include hash if user typed a new one
    if (defaultTgApiHashInput.value) {
      payload.default_tg_api_hash = defaultTgApiHashInput.value;
    }
    const updated = await settingsApi.update(payload);
    defaultTgApiHashMasked.value = updated.default_tg_api_hash ?? "";
    defaultTgApiHashInput.value = "";
    defaultTgApiMsg.value = t("settings.defaultTgApiSaved");
  } catch (err: any) {
    defaultTgApiError.value =
      err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    defaultTgApiSaving.value = false;
  }
}

async function clearDefaultTgApi() {
  defaultTgApiMsg.value = "";
  defaultTgApiError.value = "";
  defaultTgApiClearing.value = true;
  try {
    await settingsApi.update({
      default_tg_api_id: "",
      default_tg_api_hash: "",
    });
    defaultTgApiId.value = 0;
    defaultTgApiHashInput.value = "";
    defaultTgApiHashMasked.value = "";
    defaultTgApiMsg.value = t("settings.defaultTgApiCleared");
  } catch (err: any) {
    defaultTgApiError.value =
      err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    defaultTgApiClearing.value = false;
  }
}

const notifyEventOptions = computed(() => [
  { value: "failed", label: t("settings.notifyEventFailed") },
  { value: "success", label: t("settings.notifyEventSuccess") },
]);

function toggleNotifyEvent(value: string) {
  const idx = notifyForm.events.indexOf(value);
  if (idx === -1) notifyForm.events.push(value);
  else notifyForm.events.splice(idx, 1);
}

const cred = reactive({ username: "", newPassword: "", currentPassword: "" });
const credSaving = ref(false);
const revoking = ref(false);
const credMsg = ref("");
const credError = ref("");

// Memory: current/peak plus whatever the previous process was holding if it was killed
const memory = ref<MemoryReport | null>(null);
const memoryLoading = ref(true);
const memoryPercent = computed(() => {
  const m = memory.value;
  if (!m?.limitMb) return 0;
  return Math.round((m.current.rssMb / m.limitMb) * 100);
});

const crashText = computed(() => {
  const c = memory.value?.lastBeforeCrash;
  if (!c) return "";
  return t("settings.memoryCrash")
    .replace("{rss}", String(c.rssMb))
    .replace("{external}", String(c.externalMb))
    .replace("{at}", new Date(c.at).toLocaleString());
});

async function loadMemory() {
  memoryLoading.value = true;
  try {
    memory.value = await statusApi.memory();
  } catch {
    memory.value = null;
  } finally {
    memoryLoading.value = false;
  }
}

onMounted(async () => {
  loadMemory();
  // First, because everything below it is reading from wherever this says the data is.
  await refreshDbStatus();
  await loadProviders();
  try {
    const s = await settingsApi.get();
    form.default_timezone = s.default_timezone;
    form.default_max_retry = Number(s.default_max_retry);
    form.check_daily_run = s.check_daily_run !== "false";
    logRetentionDays.value = Number(s.log_retention_days) || 0;
    logRetentionSaved = logRetentionDays.value;
    scheduleGapMinutes.value =
      s.schedule_min_gap_minutes != null && s.schedule_min_gap_minutes !== ""
        ? Math.max(0, Number(s.schedule_min_gap_minutes) || 0)
        : 2;
    scheduleGapSaved = scheduleGapMinutes.value;
    form.default_ua = s.default_ua ?? "";
    try {
      uaPresets.value = JSON.parse(s.ua_presets ?? "[]");
    } catch {
      uaPresets.value = [];
    }
    try {
      proxies.value = JSON.parse(s.proxies ?? "[]");
    } catch {
      proxies.value = [];
    }
    try {
      appClients.value = JSON.parse(s.tg_app_clients ?? "[]");
    } catch {
      appClients.value = [];
    }
    tgClientMode.value = s.tg_client_mode === "random" ? "random" : "default";
    defaultTgApiId.value = Number(s.default_tg_api_id) || 0;
    defaultTgApiHashMasked.value = s.default_tg_api_hash ?? "";
    accountDisplayWithTgName.value = s.account_display_with_tg_name === "true";
    scheduleSeparatePageSetting.value = s.schedule_separate_page === "true";
    form.default_play_duration = Number(s.default_play_duration ?? 300);
    form.default_device_name = s.default_device_name ?? "Mac";
    form.ai_model = s.ai_model ?? "";
    form.ai_default_model_id = s.ai_default_model_id ?? "";
    form.ai_fallback_enabled = s.ai_fallback_enabled !== "false";
    cfChromiumInstalled.value = s.cf_chromium_installed === "true";
    cfChromiumVersion.value = s.cf_chromium_version ?? "";
    cfChromiumTier.value = s.cf_chromium_tier ?? "";
    cfFreeInstalled.value = s.cf_chromium_free_installed === "true";
    cfBrowsersRunning.value = Number(s.cf_browsers_running ?? 0);
    cfBuilds.value = parseCfBuilds(s.cf_chromium_builds);
    cfProfileCount.value = Number(s.cf_profile_count ?? 0);
    cfBrowserLang.value = s.cf_browser_lang ?? "";
    cfChromiumPath.value = s.cf_chromium_path ?? "";
    cfKeyedPending.value = s.cf_chromium_keyed_pending === "true";
    cfFontsInstalled.value = s.cf_fonts_installed === "true";
    cfFontsMissing.value = s.cf_fonts_missing ?? "";
    loadCfKeys(s);
    loadCfTuning(s);
    notifyForm.username = s.notify_tg_username ?? "";
    notifyForm.botTarget = s.notify_bot_target ?? "";
    notifyBotTokenMasked.value = s.notify_bot_token_masked ?? "";
    try {
      if (s.notify_tg_events)
        notifyForm.events = JSON.parse(s.notify_tg_events);
    } catch {
      /* ignore */
    }
    void loadNotifyBot(s.notify_bot_configured === "true");
  } catch {
    /* ignore */
  }
  try {
    aiSuppliersLoading.value = true;
    suppliers.value = await aiSuppliersApi.list();
  } catch {
    /* ignore */
  } finally {
    aiSuppliersLoading.value = false;
  }
  // Upgraded installs only have the legacy model string: pre-select the row
  // the backend resolves it to (first supplier with a key carrying that model)
  if (!form.ai_default_model_id && form.ai_model) {
    const rows = suppliers.value.flatMap((s) =>
      s.models.map((m) => ({ ...m, hasKey: Boolean(s.api_key) })),
    );
    const match =
      rows.find((m) => m.model_id === form.ai_model && m.hasKey) ??
      rows.find((m) => m.model_id === form.ai_model);
    if (match) form.ai_default_model_id = String(match.id);
  }
});

async function saveSettings() {
  saveMsg.value = "";
  saveError.value = "";
  saving.value = true;
  try {
    await settingsApi.update({
      default_timezone: form.default_timezone,
      default_max_retry: String(form.default_max_retry),
      check_daily_run: String(form.check_daily_run),
    });
    saveMsg.value = t("settings.saved");
  } catch (err: any) {
    saveError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    saving.value = false;
  }
}

function addUaPreset() {
  const name = newPresetName.value.trim();
  const value = newPresetValue.value.trim();
  if (!name || !value) return;
  uaPresets.value.push({ name, value });
  newPresetName.value = "";
  newPresetValue.value = "";
}

function removeUaPreset(index: number) {
  // If the default UA matches the removed preset, clear it
  if (form.default_ua === uaPresets.value[index]?.value) form.default_ua = "";
  uaPresets.value.splice(index, 1);
}

async function addProxy() {
  if (!newProxy.name.trim() || !newProxy.host.trim()) return;
  const url = buildProxyUrl(newProxy);

  proxiesMsg.value = "";
  proxiesError.value = "";
  proxyTesting.value = true;
  try {
    const result = await settingsApi.testProxy(url);
    if (!result.ok) {
      proxiesError.value =
        `${t("settings.proxyTestFailed")}: ${result.error ?? ""}`
          .trimEnd()
          .replace(/:$/, "");
      return;
    }
  } catch {
    proxiesError.value = t("settings.proxyTestFailed");
    return;
  } finally {
    proxyTesting.value = false;
  }

  proxies.value.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: newProxy.name.trim(),
    url,
  });
  Object.assign(newProxy, {
    protocol: "socks5",
    host: "",
    port: "1080",
    username: "",
    password: "",
    name: "",
  });
}

function removeProxy(index: number) {
  proxies.value.splice(index, 1);
}

function startEditProxy(p: Proxy) {
  editingProxyId.value = p.id;
  const parsed = parseProxyInput(p.url);
  Object.assign(editProxyForm, {
    protocol: parsed?.protocol ?? "socks5",
    host: parsed?.host ?? "",
    port: parsed?.port ?? "1080",
    username: parsed?.username ?? "",
    password: parsed?.password ?? "",
    name: p.name,
  });
  proxiesMsg.value = "";
  proxiesError.value = "";
}

async function saveProxyEdit(index: number) {
  if (!editProxyForm.name.trim() || !editProxyForm.host.trim()) return;
  const url = buildProxyUrl(editProxyForm);

  proxiesMsg.value = "";
  proxiesError.value = "";
  proxyEditTesting.value = true;
  try {
    const result = await settingsApi.testProxy(url);
    if (!result.ok) {
      proxiesError.value =
        `${t("settings.proxyTestFailed")}: ${result.error ?? ""}`
          .trimEnd()
          .replace(/:$/, "");
      return;
    }
  } catch {
    proxiesError.value = t("settings.proxyTestFailed");
    return;
  } finally {
    proxyEditTesting.value = false;
  }

  proxies.value[index] = {
    ...proxies.value[index],
    name: editProxyForm.name.trim(),
    url,
  };
  editingProxyId.value = null;
}

async function saveProxies() {
  proxiesMsg.value = "";
  proxiesError.value = "";
  proxiesSaving.value = true;
  try {
    await settingsApi.update({ proxies: JSON.stringify(proxies.value) });
    proxiesMsg.value = t("settings.saved");
  } catch (err: any) {
    proxiesError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    proxiesSaving.value = false;
  }
}

// Proxy providers: configured sellers whose current list can be pulled in. Keys are
// never sent back by the server, so a blank key field means "leave it as it is".
function addProvider() {
  providers.value.push({
    // Timestamp-based so a new row is stable before the first save
    id: `p${Date.now().toString(36)}`,
    name: "Webshare",
    type: "webshare",
    scheme: "http",
    enabled: true,
    apiKey: "",
  });
}

async function loadProviders() {
  try {
    providers.value = await settingsApi.getProxyProviders();
  } catch {
    providers.value = [];
  }
}

async function saveProviders() {
  providersMsg.value = "";
  providersErrorMsg.value = "";
  providersSaving.value = true;
  try {
    providers.value = await settingsApi.saveProxyProviders(providers.value);
    providersMsg.value = t("settings.saved");
  } catch (err: any) {
    providersErrorMsg.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    providersSaving.value = false;
  }
}

async function syncProviders(providerId?: string) {
  providersMsg.value = "";
  providersErrorMsg.value = "";
  providersSyncing.value = true;
  try {
    // Save first, so a key or URL just typed in is the one used
    providers.value = await settingsApi.saveProxyProviders(providers.value);
    const res = await settingsApi.syncProxyProviders(providerId);
    if (!res.ok) {
      providersErrorMsg.value = res.error ?? t("settings.providerSyncFailed");
      return;
    }
    providersMsg.value = t("settings.providerSynced")
      .replace("{added}", String(res.added ?? 0))
      .replace("{removed}", String(res.removed ?? 0))
      .replace("{total}", String(res.total ?? 0));
    const failed = (res.providers ?? []).filter((p) => !p.ok);
    if (failed.length) {
      providersErrorMsg.value = failed.map((p) => `${p.name}: ${p.error}`).join("; ");
    }
    // The server rewrote the proxy list, so refresh what is on screen
    const fresh = await settingsApi.get();
    try {
      proxies.value = JSON.parse(fresh.proxies ?? "[]");
    } catch {
      /* keep what is on screen */
    }
    await loadProviders();
  } catch (err: any) {
    providersErrorMsg.value = err.response?.data?.error ?? t("settings.providerSyncFailed");
  } finally {
    providersSyncing.value = false;
  }
}

async function saveEmby() {
  embyMsg.value = "";
  embyError.value = "";
  embySaving.value = true;
  try {
    await settingsApi.update({
      default_ua: form.default_ua,
      default_play_duration: String(form.default_play_duration),
      default_device_name: form.default_device_name,
      ua_presets: JSON.stringify(uaPresets.value),
    });
    embyMsg.value = t("settings.saved");
  } catch (err: any) {
    embyError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    embySaving.value = false;
  }
}

async function saveAi() {
  aiMsg.value = "";
  aiError.value = "";
  aiSaving.value = true;
  try {
    // Keep the legacy model string in sync: it is the fallback when the
    // pinned row id no longer exists (e.g. after a data import)
    const selected = suppliers.value
      .flatMap((s) => s.models)
      .find((m) => String(m.id) === form.ai_default_model_id);
    form.ai_model = selected?.model_id ?? "";
    await settingsApi.update({
      ai_default_model_id: form.ai_default_model_id,
      ai_model: form.ai_model,
      ai_fallback_enabled: String(form.ai_fallback_enabled),
    });
    aiMsg.value = t("settings.saved");
  } catch (err: any) {
    aiError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    aiSaving.value = false;
  }
}

async function saveFallbackEnabled() {
  try {
    await settingsApi.update({ ai_fallback_enabled: String(form.ai_fallback_enabled) });
  } catch {
    // revert on failure
    form.ai_fallback_enabled = !form.ai_fallback_enabled;
  }
}

const logRetentionDays = ref(0);
let logRetentionSaved = 0; // last persisted value, for revert on failure

async function saveLogRetention() {
  const value = Math.max(0, Math.floor(Number(logRetentionDays.value) || 0));
  logRetentionDays.value = value;
  if (value === logRetentionSaved) return;
  try {
    await settingsApi.update({ log_retention_days: String(value) });
    logRetentionSaved = value;
  } catch {
    logRetentionDays.value = logRetentionSaved;
  }
}

const scheduleGapMinutes = ref(2);
let scheduleGapSaved = 2; // last persisted value, for revert on failure

async function saveScheduleGap() {
  const value = Math.min(
    30,
    Math.max(0, Math.floor(Number(scheduleGapMinutes.value) || 0)),
  );
  scheduleGapMinutes.value = value;
  if (value === scheduleGapSaved) return;
  try {
    await settingsApi.update({ schedule_min_gap_minutes: String(value) });
    scheduleGapSaved = value;
  } catch {
    scheduleGapMinutes.value = scheduleGapSaved;
  }
}

async function saveAccountDisplay() {
  try {
    await settingsApi.update({
      account_display_with_tg_name: String(accountDisplayWithTgName.value),
    });
    // Reflect the change immediately across all views
    setAccountDisplayWithTgName(accountDisplayWithTgName.value);
  } catch {
    // revert on failure
    accountDisplayWithTgName.value = !accountDisplayWithTgName.value;
  }
}

async function saveSchedulePage() {
  try {
    await settingsApi.update({
      schedule_separate_page: String(scheduleSeparatePageSetting.value),
    });
    // Move the menu entry and the jobs-page panel at once
    setSchedulePageSeparate(scheduleSeparatePageSetting.value);
  } catch {
    scheduleSeparatePageSetting.value = !scheduleSeparatePageSetting.value;
  }
}

async function reloadSuppliers() {
  suppliers.value = await aiSuppliersApi.list();
}

function startEditSupplier(s: AiSupplier) {
  editingSupplierId.value = s.id;
  editForm.name = s.name;
  editForm.base_url = s.base_url;
  editForm.api_key = s.api_key;
  editForm.timeout_ms = s.timeout_ms;
}

async function saveEditSupplier(id: number) {
  supplierError.value = "";
  supplierSaving.value = true;
  try {
    await aiSuppliersApi.update(id, { ...editForm });
    editingSupplierId.value = null;
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    supplierSaving.value = false;
  }
}

async function createSupplier() {
  supplierError.value = "";
  supplierSaving.value = true;
  try {
    await aiSuppliersApi.create({ ...newSupplierForm });
    showAddSupplier.value = false;
    newSupplierForm.name = "";
    newSupplierForm.base_url = "";
    newSupplierForm.api_key = "";
    newSupplierForm.timeout_ms = 25000;
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    supplierSaving.value = false;
  }
}

async function removeSupplier(id: number) {
  supplierError.value = "";
  try {
    await aiSuppliersApi.remove(id);
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function addModel(supplierId: number) {
  const modelId = newModelInputs.value[supplierId]?.trim();
  if (!modelId) return;
  supplierError.value = "";
  try {
    await aiSuppliersApi.addModel(supplierId, modelId);
    newModelInputs.value[supplierId] = "";
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function removeModel(supplierId: number, modelId: number) {
  supplierError.value = "";
  try {
    await aiSuppliersApi.removeModel(supplierId, modelId);
    await reloadSuppliers();
  } catch (err: any) {
    supplierError.value = err.response?.data?.error ?? t("settings.saveFailed");
  }
}

async function saveNotify() {
  notifyMsg.value = "";
  notifyError.value = "";
  notifySaving.value = true;
  try {
    const s = await settingsApi.update({
      notify_tg_username: notifyForm.username,
      notify_tg_events: JSON.stringify(notifyForm.events),
      notify_bot_target: notifyForm.botTarget,
      // Blank leaves the stored token alone, so an operator can edit the target
      // without retyping the token
      ...(notifyForm.botToken ? { notify_bot_token: notifyForm.botToken } : {}),
    });
    notifyForm.botToken = "";
    notifyBotTokenMasked.value = s.notify_bot_token_masked ?? "";
    notifyMsg.value = t("settings.saved");
    await loadNotifyBot(s.notify_bot_configured === "true");
  } catch (err: any) {
    notifyError.value = err.response?.data?.error ?? t("settings.saveFailed");
  } finally {
    notifySaving.value = false;
  }
}

/** Confirms the stored token with getMe, so a revoked or mistyped one is visible here. */
async function loadNotifyBot(configured: boolean) {
  if (!configured) {
    notifyBot.value = { configured: false };
    return;
  }
  try {
    notifyBot.value = await settingsApi.getNotifyBot();
  } catch {
    notifyBot.value = { configured: true, ok: false };
  }
}

// A bot cannot start a conversation, so the numeric chat id it should notify only exists
// once someone has messaged it. This reads those chats back off getUpdates.
async function loadNotifyChats() {
  notifyChatsHint.value = "";
  notifyChats.value = [];
  notifyChatsLoading.value = true;
  try {
    const res = await settingsApi.getNotifyBotChats();
    notifyChats.value = res.chats ?? [];
    if (!notifyChats.value.length) notifyChatsHint.value = t("settings.notifyNoChats");
  } catch (err: any) {
    notifyChatsHint.value =
      err.response?.data?.error ?? t("settings.notifyChatsFailed");
  } finally {
    notifyChatsLoading.value = false;
  }
}

/** Sends a real message now: the only check that covers token, network and target. */
async function testNotifyBot() {
  notifyMsg.value = "";
  notifyError.value = "";
  notifyTesting.value = true;
  try {
    // Whatever is in the fields right now, saved or not, so a token can be tried first
    await settingsApi.testNotifyBot(
      notifyForm.botTarget || undefined,
      notifyForm.botToken || undefined,
    );
    notifyMsg.value = t("settings.notifyTestSent");
  } catch (err: any) {
    notifyError.value =
      err.response?.data?.error ?? t("settings.notifyTestFailed");
  } finally {
    notifyTesting.value = false;
  }
}

// ── Import / Export ───────────────────────────────────────────────────────────

const fileInput = ref<HTMLInputElement | null>(null);
const importFile = ref<File | null>(null);
const importMode = ref<"merge" | "replace">("merge");
const importForceReauth = ref(true);
const importing = ref(false);
const importMsg = ref("");
const importError = ref("");
const exportSecret = ref("");
const showExportSecret = ref(false);
const importSecret = ref("");
const showImportSecret = ref(false);
const importConfirmPassword = ref("");
const showImportConfirmPassword = ref(false);
// Set when a loaded file is detected as encrypted
const importFileEncrypted = ref(false);

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null;
  importFile.value = file;
  importFileEncrypted.value = false;
  importSecret.value = "";
  if (!file) return;
  // Peek at the file to detect encryption without a server round-trip
  file.text().then((text) => {
    try {
      const parsed = JSON.parse(text);
      importFileEncrypted.value = parsed?.encrypted === true;
    } catch {
      // Invalid JSON -- will be caught on actual import
    }
  });
}

async function doExport() {
  const secret = exportSecret.value.trim() || undefined;
  try {
    const data = await dataApi.export(secret);
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().split("T")[0];
    a.download = `bemby-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err: any) {
    const code = err.response?.data?.code;
    importError.value = code === "SECRET_REQUIRED"
      ? t("settings.importExport.exportSecretRequired")
      : (err.response?.data?.error ?? t("settings.importExport.importFailed"));
  }
}

async function doImport() {
  importMsg.value = "";
  importError.value = "";
  if (!importFile.value) {
    importError.value = t("settings.importExport.noFileSelected");
    return;
  }
  importing.value = true;
  try {
    const text = await importFile.value.text();
    let parsed: ExportPayload | EncryptedEnvelope;
    try {
      parsed = JSON.parse(text);
    } catch {
      importError.value = t("settings.importExport.invalidFile");
      return;
    }
    const secret = importSecret.value.trim() || undefined;
    const confirmPassword = importMode.value === "replace"
      ? importConfirmPassword.value.trim() || undefined
      : undefined;
    const result = await dataApi.import(
      parsed,
      importMode.value,
      secret,
      importForceReauth.value,
      confirmPassword,
    );
    importMsg.value = t("settings.importExport.importSuccess")
      .replace("{a}", String(result.accountsImported))
      .replace("{t}", String(result.templatesImported))
      .replace("{j}", String(result.jobsImported))
      .replace("{sup}", String(result.aiSuppliersImported))
      .replace("{mod}", String(result.aiModelsImported))
      .replace("{s}", String(result.settingsUpdated));
    if (fileInput.value) fileInput.value.value = "";
    importFile.value = null;
    importFileEncrypted.value = false;
    importSecret.value = "";
    importConfirmPassword.value = "";
  } catch (err: any) {
    const code = err.response?.data?.code;
    importError.value =
      code === "WRONG_SECRET"
        ? t("settings.importExport.wrongSecret")
        : code === "CONFIRM_REQUIRED"
          ? t("settings.importExport.confirmPasswordRequired")
          : code === "WRONG_PASSWORD"
            ? t("settings.importExport.wrongConfirmPassword")
            : (err.response?.data?.error ??
              t("settings.importExport.importFailed"));
  } finally {
    importing.value = false;
  }
}

async function saveCredentials() {
  credMsg.value = "";
  credError.value = "";
  if (!cred.currentPassword) {
    credError.value = t("settings.currentPassRequired");
    return;
  }
  credSaving.value = true;
  try {
    const { token } = await authApi.changeCredentials(
      cred.currentPassword,
      cred.username || undefined,
      cred.newPassword || undefined,
    );
    // A credential change retires every token issued before it, this tab's included. The
    // reply carries its replacement, so it has to be stored or the next request is a 401.
    if (token) localStorage.setItem("token", token);
    credMsg.value = t("settings.credSaved");
    Object.assign(cred, { username: "", newPassword: "", currentPassword: "" });
  } catch (err: any) {
    credError.value = err.response?.data?.error ?? t("settings.credFailed");
  } finally {
    credSaving.value = false;
  }
}

async function signOutEverywhere() {
  credMsg.value = "";
  credError.value = "";
  revoking.value = true;
  try {
    const { token } = await authApi.revokeSessions();
    if (token) localStorage.setItem("token", token);
    credMsg.value = t("settings.sessionsRevoked");
  } catch (err: any) {
    credError.value = err.response?.data?.error ?? t("settings.credFailed");
  } finally {
    revoking.value = false;
  }
}
</script>

<style scoped>
/* Connection state for the database card. Read at a glance from across the page, which is
   the point: an unconfigured database is why nothing else on the panel works. */
.db-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
  background: #eceff3;
  color: #667;
  white-space: nowrap;
}
.db-badge-ok {
  background: #e3f7ea;
  color: #1a7f42;
}
.db-badge-warn {
  background: #fff4d6;
  color: #8a6100;
}
.db-badge-bad {
  background: #fdeaea;
  color: #b3261e;
}
.tg-client-mode-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.radio-opt {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  cursor: pointer;
}

.event-pills {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.event-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: 20px;
  border: 1.5px solid #ddd;
  cursor: pointer;
  font-size: 13px;
  color: #555;
  user-select: none;
  transition:
    border-color 0.15s,
    background 0.15s,
    color 0.15s;
}

.event-pill input[type="checkbox"] {
  display: none;
}

.event-pill.active {
  border-color: var(--color-primary, #2563eb);
  background: #eff6ff;
  color: var(--color-primary, #2563eb);
  font-weight: 500;
}

.event-pill:hover:not(.active) {
  border-color: #bbb;
  background: #fafafa;
}

.ie-divider {
  border: none;
  border-top: 1px solid #eee;
  margin: 16px 0;
}

.import-mode-row {
  display: flex;
  gap: 16px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.import-mode-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}

.import-mode-option input[type="radio"] {
  margin-top: 3px;
  flex-shrink: 0;
}

.import-mode-label {
  font-size: 13px;
  font-weight: 500;
}

.settings-subsection {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  margin-bottom: 10px;
}

.mem-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mem-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 13px;
  gap: 12px;
}

.mem-row span {
  color: #888;
}

.mem-row strong {
  font-variant-numeric: tabular-nums;
}

.input-with-toggle {
  position: relative;
  display: flex;
  align-items: center;
}

.input-with-toggle .form-input {
  padding-right: 36px;
  flex: 1;
}

.toggle-secret-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: #888;
  padding: 0;
  display: flex;
  align-items: center;
}

.toggle-secret-btn:hover {
  color: #444;
}

.import-mode-hint {
  font-size: 12px;
  color: #888;
}

.ua-preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #f0f0f0;
}

.ua-preset-name {
  flex: 0 0 140px;
  font-size: 13px;
  font-weight: 500;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ua-preset-value {
  flex: 1;
  font-size: 11px;
  font-family: monospace;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.ua-preset-del {
  flex-shrink: 0;
  color: #e63946;
  padding: 3px 7px;
}

.ua-preset-add {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* AI supplier cards */
.supplier-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: #fafafa;
}
.supplier-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.supplier-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.supplier-name {
  font-weight: 600;
  font-size: 13px;
}
.supplier-url {
  font-size: 12px;
  color: #6b7280;
  font-family: monospace;
  word-break: break-all;
}
.supplier-timeout {
  font-size: 11px;
  color: #9ca3af;
}
.supplier-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.supplier-edit-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.supplier-no-key-warning {
  margin-top: 8px;
  font-size: 12px;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 5px;
  padding: 5px 10px;
}
.supplier-models {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #e5e7eb;
}
.supplier-models-label {
  font-size: 11px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.supplier-model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #e5e7eb;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  font-family: monospace;
}
.model-chip-del {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: #9ca3af;
  font-size: 11px;
  line-height: 1;
}
.model-chip-del:hover {
  color: #ef4444;
}
.model-add-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.form-input-sm {
  padding: 4px 8px;
  font-size: 12px;
  height: auto;
}
/*
 * Red lettering for a destructive action sitting on a light button. Kept to the ghost
 * pairing deliberately: as a bare `.btn-danger` this also hit the solid red variant, whose
 * own colour is white -- red text on a red fill, which is why the provider delete icon and
 * the uninstall button came out as blank red blocks.
 */
.btn-ghost.btn-danger {
  color: #ef4444;
}
.btn-ghost.btn-danger:hover {
  color: #dc2626;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 20px;
  align-items: start;
}
.s-col-4 {
  grid-column: span 4;
}
.s-col-6 {
  grid-column: span 6;
}
.s-col-12 {
  grid-column: span 12;
}
@media (max-width: 960px) {
  .s-col-4 {
    grid-column: span 6;
  }
}
@media (max-width: 640px) {
  .s-col-4,
  .s-col-6 {
    grid-column: span 12;
  }
}

.proxy-edit-panel {
  padding: 10px;
  border: 1px solid #e8e8f0;
  border-radius: 6px;
  background: #fafafa;
  margin-bottom: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.proxy-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

/* Destructive, but not a call to action: red lettering rather than a red slab, so it
   reads as available without competing with the download and test buttons above it. */
.cf-uninstall-btn {
  color: #c0392b;
  background: transparent;
  border: 1px solid #f0d0cd;
}

.cf-uninstall-btn:not(:disabled):hover {
  background: #fdf1f0;
  border-color: #e0a9a4;
  opacity: 1;
}
</style>
