/**
 * A chat ID as Telegram clients and bots show it, which is the form a job's group or contact
 * field takes: `c123` -> `-100123` (supergroup or channel), `g123` -> `-123` (basic group),
 * `u123` -> `123`. The backend sends this on a profile; this covers the offline fallback,
 * where all we have is the dialog's own ID.
 */
export function displayPeerId(chatId: string): string {
  const parts = chatId.match(/^([cgu])(\d+)$/);
  if (!parts) return chatId;
  const [, kind, id] = parts;
  if (kind === "c") return `-100${id}`;
  return kind === "g" ? `-${id}` : id;
}
