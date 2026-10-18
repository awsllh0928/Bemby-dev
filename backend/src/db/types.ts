/** Document shapes, one per collection. Field names stay in the SQL snake_case mostly used
 *  before so every call site keeps reading the way it did; `_id` replaces the SQLite `id`
 *  (and the `key` column on settings), and is always a number (or string for settings). */

export type SettingDoc = {
  _id: string;
  value: string;
};

export type AccountDoc = {
  _id: number;
  name: string;
  phone_number: string;
  api_id: number | null;
  api_hash: string | null;
  session_string: string | null;
  auth_status: string;
  created_at: string;
  proxy_id?: string | null;
  disabled?: number;
  app_client_id?: string | null;
  sort_order?: number;
  tg_display_name?: string | null;
  tg_username?: string | null;
  notes?: string | null;
  passkey?: string | null;
  additional_attributes?: string | null;
};

export type JobDoc = {
  _id: number;
  name: string;
  account_id: number | null;
  job_type: string;
  bot_username: string;
  schedule_window_start: number;
  schedule_window_end: number;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  created_at: string;
  config?: string | null;
  start_command?: string;
  checkin_button?: string;
  template_id?: number | null;
  run_every_days?: number;
  run_every_days_max?: number | null;
  last_success_at?: string | null;
  /** null = live; set = soft-deleted with the reason (e.g. its account was deleted) */
  retired?: string | null;
};

export type JobTemplateDoc = {
  _id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config?: string | null;
  start_command?: string;
  checkin_button?: string;
  run_every_days?: number;
  run_every_days_max?: number | null;
  created_at: string;
};

export type JobLogDoc = {
  _id: number;
  job_id: number;
  ran_at: string;
  status: string;
  message?: string | null;
  detail?: string | null;
  source?: string;
  retired?: number;
};

export type AiSupplierDoc = {
  _id: number;
  name: string;
  base_url: string;
  api_key: string;
  timeout_ms: number;
};

export type AiModelDoc = {
  _id: number;
  supplier_id: number;
  model_id: string;
  label?: string | null;
};

export type MessageCacheDoc = {
  _id: string;
  account_id: number;
  chat_id: string;
  msg_id: number;
  msg_date: number;
  payload: string;
};

export type DialogCacheDoc = {
  _id: string;
  account_id: number;
  chat_id: string;
  sort_order: number;
  payload: string;
};
