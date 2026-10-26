// Keep list responses from overwriting a newer local mutation or request.
export function createShelfSync() {
  let request = 0;
  let changes = 0;
  return {
    changed() { changes += 1; },
    cancel() { request += 1; },
    async load(fetchBooks, apply, refresh = false) {
      const id = ++request;
      while (id === request) {
        const version = changes;
        const books = await fetchBooks(refresh);
        if (id !== request) return null;
        if (version !== changes) {
          // The mutation has completed; read the current list without crawling again.
          refresh = false;
          continue;
        }
        apply(books);
        return books;
      }
      return null;
    },
  };
}
