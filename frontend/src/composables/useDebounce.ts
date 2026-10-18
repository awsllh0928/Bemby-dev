// Debounces a callback; used to avoid a server round-trip per keystroke in search inputs
export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delayMs = 300,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}
