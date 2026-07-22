import type {
  Book,
  BookGroup,
  Bookmark,
  BookSource,
  Chapter,
  ReplaceRule,
  ReaderUser,
  OfflineBookStatus,
  RssArticle,
  RssSource,
  SourceTestSummary,
  WebdavFile,
} from "./types";
import {
  bookCacheKey,
  chapterCacheKey,
  deleteOfflineScope,
  deleteOfflineBook,
  getCachedBook,
  getCachedChapter,
  getOfflineBookStatus,
  listCachedBooks,
  putCachedBook,
  putCachedChapter,
} from "./offline-store";

interface ApiEnvelope<T> {
  isSuccess: boolean;
  data: T;
  errorMsg?: string;
}

export class ReaderApiError extends Error {
  code?: unknown;

  constructor(message: string, code?: unknown) {
    super(message);
    this.name = "ReaderApiError";
    this.code = code;
  }
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "/reader3";
  return trimmed.endsWith("/reader3") ? trimmed : `${trimmed}/reader3`;
}

function readCookie(name: string) {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) {
      try { return decodeURIComponent(value.slice(prefix.length)); } catch { return ""; }
    }
  }
  return "";
}

export class ReaderApi {
  readonly baseUrl: string;
  private cacheNamespace = "anonymous";
  private offlineMode = false;
  private chapterMemoryCache = new Map<string, string>();

  constructor(baseUrl = "") {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  setCacheNamespace(username: string) {
    const nextNamespace = username.trim().toLowerCase() || "anonymous";
    if (nextNamespace !== this.cacheNamespace) this.chapterMemoryCache.clear();
    this.cacheNamespace = nextNamespace;
  }

  setOfflineMode(value: boolean) {
    this.offlineMode = value;
  }

  private cacheScope() {
    return `${this.baseUrl}\u0000${this.cacheNamespace}`;
  }

  private async request<T>(
    path: string,
    options: RequestInit & { query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}${path}`, isAbsolute ? undefined : origin);
    const query = { ...options.query };
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    });

    const response = await fetch(isAbsolute ? url.toString() : `${url.pathname}${url.search}`, {
      ...options,
      query: undefined,
      credentials: "include",
      headers: {
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(!["GET", "HEAD", "OPTIONS"].includes(options.method || "GET")
          ? { "X-Yomu-CSRF": readCookie("yomu_csrf") }
          : {}),
        ...options.headers,
      },
    } as RequestInit);

    const envelope = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok) {
      throw new ReaderApiError(
        envelope?.errorMsg || `服务器返回 ${response.status}`,
        response.status === 401 ? "NEED_LOGIN" : response.status,
      );
    }
    if (!envelope) throw new ReaderApiError("服务器响应格式无效");
    if (!envelope.isSuccess) {
      throw new ReaderApiError(envelope.errorMsg || "Reader 服务请求失败", envelope.data);
    }
    return envelope.data;
  }

  getUserInfo() {
    return this.authRequest<{ secure?: boolean; adminAuthorized?: boolean; userInfo?: { username?: string } }>("/auth/session");
  }

  login(username: string, password: string) {
    return this.authRequest<{ secure?: boolean; adminAuthorized?: boolean; userInfo?: { username?: string } }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  }

  logout() {
    return this.authRequest<null>("/auth/logout", { method: "POST", body: "{}" });
  }

  private async authRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...options,
      credentials: "include",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(!["GET", "HEAD", "OPTIONS"].includes(options.method || "GET")
          ? { "X-Yomu-CSRF": readCookie("yomu_csrf") }
          : {}),
        ...options.headers,
      },
    });
    const envelope = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok || !envelope?.isSuccess) {
      throw new ReaderApiError(envelope?.errorMsg || `服务器返回 ${response.status}`, response.status === 401 ? "NEED_LOGIN" : response.status);
    }
    return envelope.data;
  }

  async getBookshelf(refresh = false, options?: { maxAgeMs?: number; limit?: number; concurrentCount?: number }) {
    if (!refresh) return this.request<Book[]>("/getBookshelf");
    const result = await this.request<{ books: Book[]; updated: number; failed: number }>("/refreshBookshelf", {
      method: "POST",
      body: JSON.stringify({ concurrentCount: options?.concurrentCount ?? 2, maxAgeMs: options?.maxAgeMs, limit: options?.limit }),
    });
    return result.books;
  }

  getBookSources() {
    return this.request<BookSource[]>("/getBookSources");
  }

  getBookGroups() {
    return this.request<BookGroup[]>("/getBookGroups");
  }

  getBookmarks() {
    return this.request<Bookmark[]>("/getBookmarks");
  }

  getRssSources() {
    return this.request<RssSource[]>("/getRssSources");
  }

  getReplaceRules() {
    return this.request<ReplaceRule[]>("/getReplaceRules");
  }

  async searchBooks(key: string, onBatch?: (books: Book[]) => void, signal?: AbortSignal) {
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}/searchBookMultiSSE`, isAbsolute ? undefined : origin);
    url.searchParams.set("key", key);
    url.searchParams.set("lastIndex", "-1");
    url.searchParams.set("searchSize", "80");
    url.searchParams.set("concurrentCount", "4");
    const response = await fetch(isAbsolute ? url.toString() : `${url.pathname}${url.search}`, {
      credentials: "include",
      signal,
    });
    if (!response.ok || !response.body) throw new ReaderApiError(`搜索失败：${response.status}`);

    const books = new Map<string, Book>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const data = event.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (!data) continue;
        const payload = JSON.parse(data) as { data?: Book[]; errorMsg?: string };
        if (payload.errorMsg) throw new ReaderApiError(payload.errorMsg);
        for (const book of payload.data || []) {
          const key = `${book.name.trim()}\u0000${book.author.trim()}`;
          const existing = books.get(key);
          if (existing) {
            existing.bookSourceUrls = existing.bookSourceUrls || [existing.origin];
            if (book.origin && !existing.bookSourceUrls.includes(book.origin)) {
              existing.bookSourceUrls.push(book.origin);
            }
          } else {
            books.set(key, { ...book, bookSourceUrls: [book.origin] });
          }
        }
        if (payload.data?.length) onBatch?.([...books.values()]);
      }
    }
    return [...books.values()];
  }

  exploreBooks(category = "mixed", cursor = 0, page = 1) {
    return this.request<{ books: Book[]; nextCursor: number; hasMore: boolean; failed: number }>(
      "/exploreBookGlobal",
      {
        method: "POST",
        body: JSON.stringify({ category, cursor, page, limit: 24, concurrentCount: 4, scanLimit: 24 }),
      },
    );
  }

  saveBook(book: Book) {
    return this.request<unknown>("/saveBook", { method: "POST", body: JSON.stringify(book) });
  }

  setBookCover(bookUrl: string, coverUrl?: string) {
    return this.request<Book>("/setBookCover", {
      method: "POST",
      body: JSON.stringify({ bookUrl, coverUrl: coverUrl?.trim() || null }),
    });
  }

  getBookCoverCandidateUrl(bookUrl: string, coverUrl: string) {
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}/coverCandidate`, isAbsolute ? undefined : origin);
    url.searchParams.set("bookUrl", bookUrl);
    url.searchParams.set("coverUrl", coverUrl);
    return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
  }

  saveBooks(books: Book[]) {
    return this.request<unknown>("/saveBooks", { method: "POST", body: JSON.stringify(books) });
  }

  deleteBook(bookUrl: string) {
    return this.request<unknown>("/deleteBook", {
      method: "POST",
      body: JSON.stringify({ bookUrl }),
    });
  }

  async getChapterList(book: Book, refresh = false) {
    const key = bookCacheKey(this.cacheScope(), book.bookUrl);
    if (!refresh) {
      const cached = await getCachedBook(key);
      const expectedCount = Math.max(0, book.totalChapterNum || 0);
      if (cached?.chapters.length && (!expectedCount || cached.chapters.length >= expectedCount)) {
        return cached.chapters;
      }
    }
    if (this.offlineMode) {
      const cached = await getCachedBook(key);
      if (cached?.chapters.length) return cached.chapters;
      throw new ReaderApiError("这本书尚未下载到本机");
    }
    try {
      const chapters = await this.request<Chapter[]>("/getChapterList", {
        method: "POST",
        body: JSON.stringify({
          url: book.bookUrl,
          bookSourceUrl: book.origin,
          refresh: refresh ? 1 : 0,
        }),
      });
      void putCachedBook(key, book, chapters);
      return chapters;
    } catch (error) {
      const cached = await getCachedBook(key);
      if (cached?.chapters.length) return cached.chapters;
      throw error;
    }
  }

  async getBookContent(book: Book, chapter: Chapter, index: number, refresh = false, signal?: AbortSignal) {
    const cacheKey = chapterCacheKey(this.cacheScope(), book.bookUrl, index);
    if (!refresh) {
      const memoryCached = this.chapterMemoryCache.get(cacheKey);
      if (memoryCached !== undefined) {
        this.chapterMemoryCache.delete(cacheKey);
        this.chapterMemoryCache.set(cacheKey, memoryCached);
        return memoryCached;
      }
      const persistedCached = await getCachedChapter(cacheKey);
      if (persistedCached !== undefined) {
        this.rememberChapter(cacheKey, persistedCached);
        return persistedCached;
      }
    }
    if (this.offlineMode) {
      const cached = await getCachedChapter(cacheKey);
      if (cached !== undefined) {
        this.rememberChapter(cacheKey, cached);
        return cached;
      }
      throw new ReaderApiError("这一章尚未下载到本机");
    }
    try {
      const content = await this.request<string>("/getBookContent", {
        method: "POST",
        body: JSON.stringify({
          bookUrl: book.bookUrl,
          chapterUrl: chapter.url || book.bookUrl,
          bookSourceUrl: book.origin,
          index,
          refresh: refresh ? 1 : 0,
        }),
        signal,
      });
      this.rememberChapter(cacheKey, content);
      void putCachedChapter(cacheKey, content);
      return content;
    } catch (error) {
      const cached = await getCachedChapter(cacheKey);
      if (cached !== undefined) {
        this.rememberChapter(cacheKey, cached);
        return cached;
      }
      throw error;
    }
  }

  async prefetchBookChapters(
    book: Book,
    chapters: Chapter[],
    startIndex: number,
    count = 3,
    signal?: AbortSignal,
  ) {
    const endIndex = Math.min(chapters.length, Math.max(0, startIndex) + Math.max(0, count));
    let nextIndex = Math.max(0, startIndex);
    const worker = async () => {
      while (nextIndex < endIndex && !signal?.aborted) {
        const index = nextIndex++;
        await this.getBookContent(book, chapters[index], index, false, signal).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, Math.max(0, endIndex - startIndex)) }, worker));
  }

  private rememberChapter(key: string, content: string) {
    this.chapterMemoryCache.delete(key);
    this.chapterMemoryCache.set(key, content);
    while (this.chapterMemoryCache.size > 12) {
      const oldest = this.chapterMemoryCache.keys().next().value;
      if (oldest === undefined) break;
      this.chapterMemoryCache.delete(oldest);
    }
  }

  getOfflineBookStatus(bookUrl: string): Promise<OfflineBookStatus> {
    return getOfflineBookStatus(bookCacheKey(this.cacheScope(), bookUrl));
  }

  removeOfflineBook(bookUrl: string) {
    return deleteOfflineBook(bookCacheKey(this.cacheScope(), bookUrl));
  }

  async getOfflineBooks() {
    const cachedBooks = await listCachedBooks(this.cacheScope());
    const ranked = await Promise.all(cachedBooks.map(async (cached) => ({
      cached,
      chapterCount: (await getOfflineBookStatus(cached.key)).cachedChapters,
    })));
    const deduplicated = new Map<string, (typeof ranked)[number]>();
    for (const candidate of ranked) {
      const identity = `${candidate.cached.book.name.trim().toLowerCase()}\u0000${candidate.cached.book.author.trim().toLowerCase()}`;
      const current = deduplicated.get(identity);
      if (!current || candidate.chapterCount > current.chapterCount) {
        deduplicated.set(identity, candidate);
      }
    }
    return [...deduplicated.values()].map((candidate) => candidate.cached.book);
  }

  clearOfflineLibrary() {
    return deleteOfflineScope(this.cacheScope());
  }

  async saveOfflineProgress(book: Book, chapters: Chapter[], index: number) {
    const key = bookCacheKey(this.cacheScope(), book.bookUrl);
    const cached = await getCachedBook(key);
    if (!cached) return;
    await putCachedBook(key, {
      ...cached.book,
      durChapterIndex: index,
      durChapterTitle: chapters[index]?.title,
      durChapterTime: Date.now(),
    }, chapters);
  }

  async downloadBookForOffline(
    book: Book,
    amount: 10 | 50 | 100 | "all",
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ) {
    const chapters = await this.getChapterList(book);
    if (!chapters.length) throw new ReaderApiError("没有可下载的章节");
    await putCachedBook(bookCacheKey(this.cacheScope(), book.bookUrl), book, chapters);
    const startIndex = Math.min(Math.max(0, book.durChapterIndex || 0), chapters.length - 1);
    const endIndex = amount === "all" ? chapters.length : Math.min(chapters.length, startIndex + amount);
    const selected = chapters.slice(startIndex, endIndex);
    let nextOffset = 0;
    let completed = 0;
    let failed = 0;
    const worker = async () => {
      while (nextOffset < selected.length) {
        if (signal?.aborted) throw new DOMException("下载已取消", "AbortError");
        const index = startIndex + nextOffset++;
        try {
          await this.getBookContent(book, chapters[index], index, false, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          failed += 1;
        } finally {
          completed += 1;
          onProgress?.(completed, selected.length);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, selected.length) }, worker));
    if (failed) throw new ReaderApiError(`${failed} 章下载失败，可稍后继续`);
    return { completed, total: selected.length };
  }

  saveProgress(bookUrl: string, index: number) {
    return this.request<unknown>("/saveBookProgress", {
      method: "POST",
      body: JSON.stringify({ url: bookUrl, index }),
    });
  }

  saveBookSources(sources: BookSource[]) {
    return this.request<unknown>("/saveBookSources", {
      method: "POST",
      body: JSON.stringify(sources),
    });
  }

  saveBookSource(source: BookSource) {
    return this.request<unknown>("/saveBookSource", {
      method: "POST",
      body: JSON.stringify(source),
    });
  }

  deleteBookSource(source: BookSource) {
    return this.request<unknown>("/deleteBookSource", {
      method: "POST",
      body: JSON.stringify(source),
    });
  }

  getBookSourceLoginUrl(source: BookSource) {
    if (!source.loginUrl) throw new ReaderApiError("这个书源没有配置登录地址");
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}/bookSourceProxy`, isAbsolute ? undefined : origin);
    url.searchParams.set("bookSourceUrl", source.bookSourceUrl);
    url.searchParams.set("url", source.loginUrl);
    return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
  }

  getBookResourceUrl(book: Book, resourceUrl: string) {
    if (!/^https?:\/\//i.test(resourceUrl) || !book.origin) return resourceUrl;
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}/bookSourceProxy`, isAbsolute ? undefined : origin);
    url.searchParams.set("bookSourceUrl", book.origin);
    url.searchParams.set("bookUrl", book.bookUrl);
    url.searchParams.set("url", resourceUrl);
    return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
  }

  testBookSources(sources: BookSource[], keyword = "我的") {
    return this.request<SourceTestSummary>("/testBookSources", {
      method: "POST",
      body: JSON.stringify({
        bookSourceUrls: sources.map((source) => source.bookSourceUrl),
        keyword,
        markInvalid: true,
        concurrent: 8,
      }),
    });
  }

  deleteInvalidBookSources() {
    return this.request<{ deleted: number }>("/deleteInvalidBookSources", { method: "POST" });
  }

  saveBookGroup(group: BookGroup) {
    return this.request<unknown>("/saveBookGroup", {
      method: "POST",
      body: JSON.stringify(group),
    });
  }

  saveBookGroups(groups: BookGroup[]) {
    return this.request<unknown>("/saveBookGroupOrder", {
      method: "POST",
      body: JSON.stringify(groups),
    });
  }

  deleteBookGroup(groupId: number) {
    return this.request<unknown>("/deleteBookGroup", {
      method: "POST",
      body: JSON.stringify({ groupId }),
    });
  }

  saveBookGroupId(bookUrl: string, groupId: number) {
    return this.request<unknown>("/saveBookGroupId", {
      method: "POST",
      body: JSON.stringify({ bookUrl, groupId }),
    });
  }

  saveBookmark(bookmark: Bookmark) {
    return this.request<unknown>("/saveBookmark", {
      method: "POST",
      body: JSON.stringify(bookmark),
    });
  }

  saveBookmarks(bookmarks: Bookmark[]) {
    return this.request<unknown>("/saveBookmarks", {
      method: "POST",
      body: JSON.stringify(bookmarks),
    });
  }

  deleteBookmark(bookmark: Bookmark) {
    return this.request<unknown>("/deleteBookmark", {
      method: "POST",
      body: JSON.stringify(bookmark),
    });
  }

  getRssArticles(source: RssSource, page = 1) {
    return this.request<{ first: RssArticle[]; second?: unknown }>("/getRssArticles", {
      method: "POST",
      body: JSON.stringify({
        sourceUrl: source.sourceUrl,
        sortName: source.sourceName,
        sortUrl: source.sortUrl || source.sourceUrl,
        page,
      }),
    });
  }

  getRssContent(sourceUrl: string, article: RssArticle) {
    return this.request<string>("/getRssContent", {
      method: "POST",
      body: JSON.stringify({ sourceUrl, link: article.link, origin: article.origin }),
    });
  }

  saveRssSource(source: RssSource) {
    return this.request<unknown>("/saveRssSource", {
      method: "POST",
      body: JSON.stringify(source),
    });
  }

  saveRssSources(sources: RssSource[]) {
    return this.request<unknown>("/saveRssSources", {
      method: "POST",
      body: JSON.stringify(sources),
    });
  }

  deleteRssSource(source: RssSource) {
    return this.request<unknown>("/deleteRssSource", {
      method: "POST",
      body: JSON.stringify(source),
    });
  }

  saveReplaceRule(rule: ReplaceRule) {
    return this.request<unknown>("/saveReplaceRule", {
      method: "POST",
      body: JSON.stringify(rule),
    });
  }

  saveReplaceRules(rules: ReplaceRule[]) {
    return this.request<unknown>("/saveReplaceRules", {
      method: "POST",
      body: JSON.stringify(rules),
    });
  }

  deleteReplaceRule(rule: ReplaceRule) {
    return this.request<unknown>("/deleteReplaceRule", {
      method: "POST",
      body: JSON.stringify(rule),
    });
  }

  async uploadLocalBook(file: File) {
    const extension = file.name.split(".").pop()?.toLowerCase();
    const route = {
      txt: "/uploadTxtBook",
      epub: "/uploadEpubBook",
      mobi: "/uploadMobiBook",
      pdf: "/uploadPdfBook",
    }[extension || ""];
    if (!route) throw new ReaderApiError("仅支持 TXT、EPUB、MOBI 和 PDF");
    const body = new FormData();
    body.append("file", file);
    return this.request<Book>(route, { method: "POST", body });
  }

  async downloadLocalBook(bookUrl: string) {
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}/exportLocalBook`, isAbsolute ? undefined : origin);
    url.searchParams.set("url", bookUrl);
    const response = await fetch(isAbsolute ? url.toString() : `${url.pathname}${url.search}`, { credentials: "include" });
    if (!response.ok) throw new ReaderApiError(`本地书导出失败：${response.status}`);
    return response.blob();
  }

  async getAvailableBookSources(book: Book, refresh = false) {
    const result = await this.request<Book[] | { books: Book[] }>("/getAvailableBookSource", {
      method: "POST",
      body: JSON.stringify({
        url: book.bookUrl,
        name: book.name,
        author: book.author,
        origin: book.origin,
        refresh: refresh ? 1 : 0,
        resultLimit: 40,
        concurrentCount: 4,
      }),
    });
    return Array.isArray(result) ? result : result.books || [];
  }

  async streamAvailableBookSources(
    book: Book,
    refresh: boolean,
    onBatch: (books: Book[]) => void,
    signal?: AbortSignal,
    lastIndex = -1,
  ) {
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const requestUrl = (route: string) => {
      const url = new URL(`${this.baseUrl}${route}`, isAbsolute ? undefined : origin);
      url.searchParams.set("url", book.bookUrl);
      url.searchParams.set("name", book.name);
      url.searchParams.set("author", book.author);
      if (book.origin) url.searchParams.set("origin", book.origin);
      url.searchParams.set("lastIndex", String(lastIndex));
      url.searchParams.set("concurrentCount", "4");
      if (refresh) url.searchParams.set("refresh", "1");
      return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
    };
    let response = await fetch(requestUrl("/getAvailableBookSourceSSE"), {
      credentials: "include",
      signal,
    });
    // Reader forks expose either endpoint depending on their core version. Keep
    // source switching usable during an in-place core upgrade instead of
    // surfacing a bare 404 to the reader.
    if ([404, 405].includes(response.status)) {
      response = await fetch(requestUrl("/searchBookSourceSSE"), {
        credentials: "include",
        signal,
      });
    }
    if (!response.ok) {
      const envelope = (await response.json().catch(() => null)) as ApiEnvelope<unknown> | null;
      throw new ReaderApiError(envelope?.errorMsg || `换源搜索失败：${response.status}`);
    }
    if (!response.body) throw new ReaderApiError("换源搜索没有返回数据");

    const results = new Map<string, Book>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let nextLastIndex = lastIndex;
    let hasMore = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const data = event.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (!data) continue;
        const payload = JSON.parse(data) as {
          data?: Book[];
          books?: Book[];
          remove?: Array<Pick<Book, "origin" | "bookUrl">>;
          validating?: boolean;
          lastIndex?: number;
          hasMore?: boolean;
        };
        if (typeof payload.lastIndex === "number") nextLastIndex = payload.lastIndex;
        if (typeof payload.hasMore === "boolean") hasMore = payload.hasMore;
        for (const candidate of payload.remove || []) {
          results.delete(`${candidate.origin}\u0000${candidate.bookUrl}`);
        }
        for (const candidate of payload.data || payload.books || []) {
          if (candidate.origin === book.origin) continue;
          results.set(`${candidate.origin}\u0000${candidate.bookUrl}`, {
            ...candidate,
            sourceValidating: payload.validating === true,
          });
        }
        onBatch([...results.values()]);
      }
    }
    // A server-side early stop or a browser abort may leave transient
    // "validating" rows in the stream. They are progress indicators, not
    // usable source candidates and must never survive the scan.
    const books = [...results.values()].filter((candidate) => !candidate.sourceValidating);
    onBatch(books);
    return { books, lastIndex: nextLastIndex, hasMore };
  }

  setBookSource(book: Book, candidate: Book) {
    return this.request<Book>("/setBookSource", {
      method: "POST",
      body: JSON.stringify({
        bookUrl: book.bookUrl,
        name: book.name,
        author: book.author,
        newUrl: candidate.bookUrl,
        bookSourceUrl: candidate.origin,
      }),
    });
  }

  deleteBookCache(bookUrl: string) {
    return this.request<unknown>("/deleteBookCache", {
      method: "POST",
      body: JSON.stringify({ bookUrl }),
    });
  }

  async cacheBook(bookUrl: string, onProgress?: (message: string) => void) {
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}/cacheBookSSE`, isAbsolute ? undefined : origin);
    url.searchParams.set("url", bookUrl);
    url.searchParams.set("concurrentCount", "12");
    const response = await fetch(isAbsolute ? url.toString() : `${url.pathname}${url.search}`, {
      credentials: "include",
    });
    if (!response.ok || !response.body) throw new ReaderApiError(`整本缓存失败：${response.status}`);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const data = event.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (data) onProgress?.(data);
      }
    }
  }

  getWebdavFiles(path = "/") {
    return this.request<WebdavFile[]>("/getWebdavFileList", { query: { path } });
  }

  uploadWebdavFile(file: File, path = "/") {
    const body = new FormData();
    body.append("path", path);
    body.append("file", file);
    return this.request<WebdavFile[]>("/uploadFileToWebdav", { method: "POST", body });
  }

  deleteWebdavFile(path: string) {
    return this.request<unknown>("/deleteWebdavFile", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  async downloadWebdavFile(path: string) {
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}/getWebdavFile`, isAbsolute ? undefined : origin);
    url.searchParams.set("path", path);
    const response = await fetch(isAbsolute ? url.toString() : `${url.pathname}${url.search}`, {
      credentials: "include",
    });
    if (!response.ok) throw new ReaderApiError(`文件下载失败：${response.status}`);
    return response.blob();
  }

  getUsers() {
    return this.request<ReaderUser[]>("/getUserList");
  }

  addUser(username: string, password: string) {
    return this.request<ReaderUser[]>("/addUser", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  }

  updateUser(username: string, values: Partial<Pick<ReaderUser, "enableWebdav" | "enableLocalStore">>) {
    return this.request<ReaderUser[]>("/updateUser", {
      method: "POST",
      body: JSON.stringify({ username, ...values }),
    });
  }

  deleteUsers(usernames: string[]) {
    return this.request<ReaderUser[]>("/deleteUsers", {
      method: "POST",
      body: JSON.stringify(usernames),
    });
  }

  changePassword(oldPassword: string, newPassword: string) {
    return this.request<unknown>("/changePassword", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    });
  }

  resetPassword(username: string, password: string) {
    return this.request<unknown>("/resetPassword", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  }

  async debugBookSource(source: BookSource, keyword: string, onMessage: (message: string) => void) {
    const isAbsolute = this.baseUrl.startsWith("http");
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(`${this.baseUrl}/bookSourceDebugSSE`, isAbsolute ? undefined : origin);
    url.searchParams.set("bookSourceUrl", source.bookSourceUrl);
    url.searchParams.set("keyword", keyword);
    const response = await fetch(isAbsolute ? url.toString() : `${url.pathname}${url.search}`, {
      credentials: "include",
    });
    if (!response.ok || !response.body) throw new ReaderApiError(`书源调试失败：${response.status}`);
    const stream = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const data = event.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (data) onMessage(data);
      }
    }
  }
}
