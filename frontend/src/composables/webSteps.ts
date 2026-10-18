import type { WebStep } from "../api/client";

// Sub-steps of the `open_url` action. The form keeps every field on one flat object, the
// same way the action forms do, so switching a step's type does not throw away what was
// already typed into the fields the other types use.

export type WebStepType = WebStep["type"];

export type WebStepForm = {
  type: WebStepType;
  selector: string;
  text: string;
  hint: string;
  waitMs: number;
  scrollX: number;
  scrollY: number;
};

/** Order the editor offers them in: the selector steps first, then waits, then the AI ones. */
export const WEB_STEP_TYPES: WebStepType[] = [
  "web_input",
  "web_button",
  "web_wait_element",
  "web_delay",
  "web_scroll",
  "web_turnstile",
  "ai_web_input",
  "ai_web_button",
  "ai_web_click_xy",
];

/** Types that need the vision model, so the editor can gate them on a configured key. */
export const AI_WEB_STEP_TYPES: WebStepType[] = [
  "ai_web_input",
  "ai_web_button",
  "ai_web_click_xy",
];

export function defaultWebStep(): WebStepForm {
  return {
    type: "web_button",
    selector: "",
    text: "",
    hint: "",
    waitMs: 3000,
    scrollX: 0,
    scrollY: 500,
  };
}

/** Drops the fields the chosen type does not use, so the saved config stays readable. */
export function webStepToConfig(s: WebStepForm): WebStep {
  switch (s.type) {
    case "web_input":
      return { type: "web_input", selector: s.selector.trim(), text: s.text };
    case "web_button":
      return { type: "web_button", selector: s.selector.trim() };
    case "web_delay":
      return { type: "web_delay", waitMs: s.waitMs };
    case "web_turnstile":
      return { type: "web_turnstile" };
    case "web_scroll":
      return {
        type: "web_scroll",
        ...(s.scrollX ? { x: s.scrollX } : {}),
        ...(s.scrollY ? { y: s.scrollY } : {}),
      };
    case "web_wait_element":
      return {
        type: "web_wait_element",
        selector: s.selector.trim(),
        ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}),
      };
    case "ai_web_button":
      return { type: "ai_web_button", ...(s.hint.trim() ? { hint: s.hint.trim() } : {}) };
    case "ai_web_click_xy":
      return { type: "ai_web_click_xy", ...(s.hint.trim() ? { hint: s.hint.trim() } : {}) };
    case "ai_web_input":
      return {
        type: "ai_web_input",
        ...(s.hint.trim() ? { hint: s.hint.trim() } : {}),
        ...(s.text ? { text: s.text } : {}),
      };
  }
}

export function webStepsToConfig(steps: WebStepForm[]): WebStep[] {
  return steps.map(webStepToConfig);
}

/** Fills the fields a saved step does not carry with the defaults, so the form is complete. */
export function webStepFromConfig(s: WebStep): WebStepForm {
  const base = defaultWebStep();
  switch (s.type) {
    case "web_input":
      return { ...base, type: s.type, selector: s.selector, text: s.text };
    case "web_button":
      return { ...base, type: s.type, selector: s.selector };
    case "web_delay":
      return { ...base, type: s.type, waitMs: s.waitMs };
    case "web_turnstile":
      return { ...base, type: s.type };
    case "web_scroll":
      return { ...base, type: s.type, scrollX: s.x ?? 0, scrollY: s.y ?? 0 };
    case "web_wait_element":
      return { ...base, type: s.type, selector: s.selector, waitMs: s.waitMs ?? 30000 };
    case "ai_web_button":
    case "ai_web_click_xy":
      return { ...base, type: s.type, hint: s.hint ?? "" };
    case "ai_web_input":
      return { ...base, type: s.type, hint: s.hint ?? "", text: s.text ?? "" };
  }
}

export function webStepsFromConfig(steps: WebStep[] | undefined): WebStepForm[] {
  return (steps ?? []).map(webStepFromConfig);
}
