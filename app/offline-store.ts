import type { Book, Chapter, OfflineBookStatus } from "./types";

const DATABASE_NAME = "yomu-offline";
const DATABASE_VERSION = 2;
const CHAPTER_STORE = "chapters";
const BOOK_STORE = "books";

interface CachedChapter {
  key: string;
  content: string;
  savedAt: number;
}

interface CachedBook {
  key: string;
  book: Book;
  chapters: Chapter[];
  savedAt: number;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CHAPTER_STORE)) {
        request.result.createObjectStore(CHAPTER_STORE, { keyPath: "key" });
      }
      if (!request.result.objectStoreNames.contains(BOOK_STORE)) {
        request.result.createObjectStore(BOOK_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function chapterCacheKey(server: string, bookUrl: string, index: number) {
  return `${server}\u0000${bookUrl}\u0000${index}`;
}

export function bookCacheKey(server: string, bookUrl: string) {
  return `${server}\u0000${bookUrl}`;
}

export async function getCachedChapter(key: string) {
  const database = await openDatabase();
  if (!database) return undefined;
  return new Promise<string | undefined>((resolve, reject) => {
    const transaction = database.transaction(CHAPTER_STORE, "readonly");
    const request = transaction.objectStore(CHAPTER_STORE).get(key);
    request.onsuccess = () => resolve((request.result as CachedChapter | undefined)?.content);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export async function putCachedChapter(key: string, content: string) {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CHAPTER_STORE, "readwrite");
    transaction.objectStore(CHAPTER_STORE).put({ key, content, savedAt: Date.now() } satisfies CachedChapter);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function getCachedBook(key: string) {
  const database = await openDatabase();
  if (!database) return undefined;
  return new Promise<CachedBook | undefined>((resolve, reject) => {
    const transaction = database.transaction(BOOK_STORE, "readonly");
    const request = transaction.objectStore(BOOK_STORE).get(key);
    request.onsuccess = () => resolve(request.result as CachedBook | undefined);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export async function putCachedBook(key: string, book: Book, chapters: Chapter[]) {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(BOOK_STORE, "readwrite");
    transaction.objectStore(BOOK_STORE).put({ key, book, chapters, savedAt: Date.now() } satisfies CachedBook);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

function chapterPrefix(bookKey: string) {
  return `${bookKey}\u0000`;
}

function scopeRange(scope: string) {
  const prefix = `${scope}\u0000`;
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
}

export async function listCachedBooks(scope: string) {
  const database = await openDatabase();
  if (!database) return [];
  try {
    return await new Promise<CachedBook[]>((resolve, reject) => {
      const request = database.transaction(BOOK_STORE, "readonly").objectStore(BOOK_STORE).getAll(scopeRange(scope));
      request.onsuccess = () => resolve((request.result as CachedBook[]).sort((left, right) => right.savedAt - left.savedAt));
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function countChapters(database: IDBDatabase, bookKey: string) {
  return new Promise<number>((resolve, reject) => {
    const prefix = chapterPrefix(bookKey);
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const request = database.transaction(CHAPTER_STORE, "readonly").objectStore(CHAPTER_STORE).count(range);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getOfflineBookStatus(key: string): Promise<OfflineBookStatus> {
  const database = await openDatabase();
  if (!database) return { cachedChapters: 0, totalChapters: 0 };
  try {
    const book = await new Promise<CachedBook | undefined>((resolve, reject) => {
      const request = database.transaction(BOOK_STORE, "readonly").objectStore(BOOK_STORE).get(key);
      request.onsuccess = () => resolve(request.result as CachedBook | undefined);
      request.onerror = () => reject(request.error);
    });
    return {
      cachedChapters: await countChapters(database, key),
      totalChapters: book?.chapters.length || 0,
      savedAt: book?.savedAt,
    };
  } finally {
    database.close();
  }
}

export async function deleteOfflineBook(key: string) {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([CHAPTER_STORE, BOOK_STORE], "readwrite");
    transaction.objectStore(BOOK_STORE).delete(key);
    const prefix = chapterPrefix(key);
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const request = transaction.objectStore(CHAPTER_STORE).openKeyCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      transaction.objectStore(CHAPTER_STORE).delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function deleteOfflineScope(scope: string) {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([CHAPTER_STORE, BOOK_STORE], "readwrite");
    for (const storeName of [CHAPTER_STORE, BOOK_STORE]) {
      const store = transaction.objectStore(storeName);
      const request = store.openKeyCursor(scopeRange(scope));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function clearCachedChapters() {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([CHAPTER_STORE, BOOK_STORE], "readwrite");
    transaction.objectStore(CHAPTER_STORE).clear();
    transaction.objectStore(BOOK_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
