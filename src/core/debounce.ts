export interface Debounced<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): void;
  cancel(): void;
}

/**
 * Creates a debounced version of a function that delays execution
 * until after `delay` milliseconds have elapsed since the last call.
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): Debounced<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const debounced = function (this: any, ...args: Parameters<T>) {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      fn.apply(this, args);
    }, delay);
  } as Debounced<T>;

  debounced.cancel = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  return debounced;
}

/**
 * Creates a throttled version of a function that only executes
 * at most once per `limit` milliseconds.
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  return function (this: any, ...args: Parameters<T>) {
    const now = Date.now();
    const remaining = limit - (now - lastCall);

    if (remaining <= 0) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      lastCall = now;
      fn.apply(this, args);
    } else if (timeoutId === undefined) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = undefined;
        fn.apply(this, args);
      }, remaining);
    }
  };
}
