export function createShelfSync<T>(): {
  changed(): void;
  cancel(): void;
  load(fetchBooks: (refresh: boolean) => Promise<T>, apply: (books: T) => void, refresh?: boolean): Promise<T | null>;
};
