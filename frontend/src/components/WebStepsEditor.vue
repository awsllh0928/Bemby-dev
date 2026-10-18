<template>
  <div>
    <label class="form-label">{{ t("jobs.web.stepsLabel") }}</label>
    <div style="font-size: 11px; color: #aaa; margin: -2px 0 6px">
      {{ t("jobs.web.stepsHint") }}
    </div>

    <div v-for="(s, i) in steps" :key="i" class="web-step-card">
      <div class="web-step-header">
        <span class="web-step-num">{{ i + 1 }}</span>
        <select v-model="s.type" class="form-select web-step-type">
          <option
            v-for="ty in WEB_STEP_TYPES"
            :key="ty"
            :value="ty"
            :disabled="aiKeyMissing && AI_WEB_STEP_TYPES.includes(ty)"
          >
            {{ t("jobs.web.type." + ty)
            }}{{
              aiKeyMissing && AI_WEB_STEP_TYPES.includes(ty)
                ? " (" + t("jobs.noApiKey") + ")"
                : ""
            }}
          </option>
        </select>
        <button
          type="button"
          class="btn btn-ghost btn-sm btn-icon"
          :disabled="i === 0"
          @click="move(i, -1)"
        >
          <i class="fa-solid fa-arrow-up"></i>
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm btn-icon"
          :disabled="i === steps.length - 1"
          @click="move(i, 1)"
        >
          <i class="fa-solid fa-arrow-down"></i>
        </button>
        <button type="button" class="btn btn-danger btn-sm btn-icon" @click="remove(i)">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <!-- CSS selector: every type but the AI ones and the plain delay -->
      <div v-if="s.type === 'web_input' || s.type === 'web_button' || s.type === 'web_wait_element'">
        <label class="form-label">{{ t("jobs.web.labelSelector") }}</label>
        <input
          v-model.trim="s.selector"
          class="form-input"
          :placeholder="t('jobs.web.selectorPlaceholder')"
        />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.selectorHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_input'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelText") }}</label>
        <input
          v-model="s.text"
          class="form-input"
          :placeholder="t('jobs.web.textPlaceholder')"
        />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.textHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_delay' || s.type === 'web_wait_element'" style="margin-top: 8px">
        <label class="form-label">{{
          s.type === "web_delay" ? t("jobs.web.labelDelay") : t("jobs.web.labelTimeout")
        }}</label>
        <input v-model.number="s.waitMs" class="form-input" type="number" min="0" step="1000" />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{
            s.type === "web_delay" ? t("jobs.web.delayHint") : t("jobs.web.timeoutHint")
          }}
        </div>
      </div>

      <div v-if="s.type === 'web_scroll'" style="margin-top: 8px">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelScrollX") }}</label>
            <input v-model.number="s.scrollX" class="form-input" type="number" step="100" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("jobs.web.labelScrollY") }}</label>
            <input v-model.number="s.scrollY" class="form-input" type="number" step="100" />
          </div>
        </div>
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.scrollHint") }}
        </div>
      </div>

      <div v-if="s.type === 'web_turnstile'" style="font-size: 11px; color: #aaa">
        {{ t("jobs.web.turnstileHint") }}
      </div>

      <div
        v-if="
          s.type === 'ai_web_button' || s.type === 'ai_web_input' || s.type === 'ai_web_click_xy'
        "
      >
        <label class="form-label">{{ t("jobs.web.labelHint") }}</label>
        <input
          v-model.trim="s.hint"
          class="form-input"
          :placeholder="hintPlaceholder(s.type)"
        />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ s.type === "ai_web_click_xy" ? t("jobs.web.hintXyHint") : t("jobs.web.hintHint") }}
        </div>
      </div>

      <div v-if="s.type === 'ai_web_input'" style="margin-top: 8px">
        <label class="form-label">{{ t("jobs.web.labelAiText") }}</label>
        <input
          v-model="s.text"
          class="form-input"
          :placeholder="t('jobs.web.aiTextPlaceholder')"
        />
        <div style="font-size: 11px; color: #aaa; margin-top: 3px">
          {{ t("jobs.web.aiTextHint") }}
        </div>
      </div>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" style="margin-top: 6px" @click="add">
      <i class="fa-solid fa-plus"></i> {{ t("jobs.web.addStep") }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { t } from "../i18n";
import {
  AI_WEB_STEP_TYPES,
  WEB_STEP_TYPES,
  defaultWebStep,
  type WebStepForm,
  type WebStepType,
} from "../composables/webSteps";

// The list is mutated in place: the parent holds it inside its own action form object, so
// emitting a replacement would mean threading an update back through the action index.
const props = defineProps<{ steps: WebStepForm[]; aiKeyMissing: boolean }>();

function hintPlaceholder(type: WebStepType): string {
  if (type === "ai_web_input") return t("jobs.web.hintInputPlaceholder");
  if (type === "ai_web_click_xy") return t("jobs.web.hintXyPlaceholder");
  return t("jobs.web.hintButtonPlaceholder");
}

function add() {
  props.steps.push(defaultWebStep());
}

function remove(i: number) {
  props.steps.splice(i, 1);
}

function move(i: number, by: number) {
  const to = i + by;
  if (to < 0 || to >= props.steps.length) return;
  const [item] = props.steps.splice(i, 1);
  props.steps.splice(to, 0, item);
}
</script>

<style scoped>
.web-step-card {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  /* The parent action card is #fafafa, so these sit a shade lighter to read as nested */
  background: #fff;
}

.web-step-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.web-step-num {
  min-width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #4a9eff;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.web-step-type {
  flex: 1;
  min-width: 0;
}
</style>
