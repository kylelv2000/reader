"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ReaderApi, ReaderApiError } from "./reader-api";
import type {
  Book,
  BookGroup,
  Bookmark,
  BookSource,
  Chapter,
  ConnectionState,
  ReplaceRule,
  ReaderUser,
  ReaderPreferences,
  ReaderSession,
  SourceRule,
  OfflineBookStatus,
  RssArticle,
  RssSource,
  ServerProfile,
  ViewName,
  WebdavFile,
} from "./types";

type LibraryTab = "local" | "bookmarks" | "rss" | "rules" | "backup" | "admin";
type AppTheme = "system" | "light" | "dark";

interface ArticleSession {
  article: RssArticle;
  content: string;
  loading: boolean;
}

interface YomuBackup {
  format: "yomu-backup";
  version: 1;
  createdAt: string;
  books: Book[];
  groups: BookGroup[];
  bookSources: BookSource[];
  rssSources: RssSource[];
  bookmarks: Bookmark[];
  replaceRules: ReplaceRule[];
}

const defaultPreferences: ReaderPreferences = {
  theme: "system",
  fontSize: 19,
  lineHeight: 1.9,
  contentWidth: 720,
  fontFamily: "serif",
  pageMode: "scroll",
  chineseMode: "original",
};

const coverPalettes = [
  ["#203c36", "#f0eadc"],
  ["#8f4f3d", "#fff7e9"],
  ["#32475c", "#edf3f6"],
  ["#6f6047", "#fff8e8"],
  ["#414452", "#f1eee8"],
  ["#365065", "#f5e9d2"],
];

const navigation: Array<{ id: ViewName; label: string; icon: string }> = [
  { id: "shelf", label: "书架", icon: "▥" },
  { id: "discover", label: "搜书", icon: "⌕" },
  { id: "sources", label: "书源", icon: "◎" },
  { id: "library", label: "资料库", icon: "◇" },
];

type SourceRuleKey = "ruleSearch" | "ruleExplore" | "ruleBookInfo" | "ruleToc" | "ruleContent";

const sourceRuleSections: Array<{
  key: SourceRuleKey;
  label: string;
  fields: Array<[string, string]>;
}> = [
  { key: "ruleSearch", label: "搜索规则", fields: [["bookList", "书籍列表"], ["name", "书名"], ["author", "作者"], ["bookUrl", "详情地址"], ["coverUrl", "封面"], ["intro", "简介"], ["kind", "分类"], ["lastChapter", "最新章节"], ["wordCount", "字数"]] },
  { key: "ruleExplore", label: "发现规则", fields: [["bookList", "书籍列表"], ["name", "书名"], ["author", "作者"], ["bookUrl", "详情地址"], ["coverUrl", "封面"], ["intro", "简介"], ["kind", "分类"], ["lastChapter", "最新章节"], ["wordCount", "字数"]] },
  { key: "ruleBookInfo", label: "详情规则", fields: [["init", "初始化"], ["name", "书名"], ["author", "作者"], ["intro", "简介"], ["kind", "分类"], ["lastChapter", "最新章节"], ["coverUrl", "封面"], ["tocUrl", "目录地址"], ["wordCount", "字数"], ["downloadUrls", "下载地址"]] },
  { key: "ruleToc", label: "目录规则", fields: [["preUpdateJs", "预处理 JS"], ["chapterList", "章节列表"], ["chapterName", "章节名"], ["chapterUrl", "章节地址"], ["isVolume", "卷名"], ["isVip", "VIP"], ["isPay", "付费"], ["updateTime", "更新时间"], ["nextTocUrl", "下一页目录"], ["formatJs", "格式化 JS"]] },
  { key: "ruleContent", label: "正文规则", fields: [["content", "正文"], ["title", "标题"], ["nextContentUrl", "下一页正文"], ["webJs", "正文 JS"], ["sourceRegex", "源码替换"], ["replaceRegex", "正文替换"], ["imageStyle", "图片样式"], ["imageDecode", "图片解码"]] },
];

function sourceRuleFromForm(values: FormData, key: SourceRuleKey, current?: SourceRule) {
  const next: SourceRule = { ...(current || {}) };
  const section = sourceRuleSections.find((item) => item.key === key);
  for (const [field] of section?.fields || []) {
    const value = String(values.get(`${key}.${field}`) || "").trim();
    if (value) next[field] = value;
    else delete next[field];
  }
  return Object.keys(next).length ? next : undefined;
}

function timeGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 19) return "下午好";
  return "晚上好";
}

function progressFor(book: Book) {
  const total = Math.max(1, book.totalChapterNum || 12);
  return Math.min(99, Math.round((((book.durChapterIndex || 0) + 1) / total) * 100));
}

function coverStyle(book: Book): CSSProperties {
  const sum = Array.from(book.name).reduce((value, char) => value + char.charCodeAt(0), 0);
  const palette = coverPalettes[sum % coverPalettes.length];
  const coverUrl = book.customCoverUrl || book.coverUrl;
  return {
    backgroundColor: palette[0],
    color: palette[1],
    ...(coverUrl ? {
      backgroundImage: `linear-gradient(180deg, rgba(20, 22, 19, 0.03), rgba(20, 22, 19, 0.28)), url("/reader3/cover?path=${encodeURIComponent(coverUrl)}")`,
      backgroundPosition: "center",
      backgroundSize: "cover",
    } : {}),
  };
}

function firstLetter(name: string) {
  return Array.from(name.trim())[0] || "书";
}

function getStoredProfile(): ServerProfile {
  if (typeof window === "undefined") return {};
  const username = localStorage.getItem("yomu-username") || "";
  return username ? { username } : {};
}

function getStoredPreferences(): ReaderPreferences {
  if (typeof window === "undefined") return defaultPreferences;
  try {
    return {
      ...defaultPreferences,
      ...(JSON.parse(localStorage.getItem("yomu-reader-preferences") || "{}") as Partial<ReaderPreferences>),
    };
  } catch {
    return defaultPreferences;
  }
}

function getStoredAppTheme(): AppTheme {
  if (typeof window === "undefined") return "system";
  const value = localStorage.getItem("yomu-app-theme");
  return value === "light" || value === "dark" ? value : "system";
}

function getStoredExploreEnabled() {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("yomu-explore-enabled") === "true";
}

function plainText(html: string) {
  if (typeof window === "undefined") return html.replace(/<[^>]+>/g, " ");
  const document = new DOMParser().parseFromString(html, "text/html");
  return (document.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function mediaUrls(content: string) {
  const matches = content.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[),，。]+$/, "")))];
}

function ComicImage({ src, alt }: { src: string; alt: string }) {
  // Comic pages are user-source URLs, so the built-in fixed-origin image loader cannot optimize them.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />;
}

function bookInGroup(book: Book, groupId: number) {
  const value = book.group || 0;
  return value === groupId || (value & groupId) === groupId;
}

function localBookExtension(book: Book) {
  if (book.bookUrl.startsWith("local-epub:")) return "epub";
  if (book.bookUrl.startsWith("local-mobi:")) return "mobi";
  if (book.bookUrl.startsWith("local-pdf:")) return "pdf";
  return "txt";
}

function extractBookSources(value: unknown): BookSource[] {
  if (typeof value === "string") {
    try { return extractBookSources(JSON.parse(value)); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(extractBookSources);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (typeof object.bookSourceName === "string" && typeof object.bookSourceUrl === "string") {
    return [object as unknown as BookSource];
  }
  for (const key of ["bookSourceList", "bookSources", "sources", "data"]) {
    if (object[key]) {
      const nested = extractBookSources(object[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function highlightedText(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "gi")).map((part, index) =>
    part.toLowerCase() === needle.toLowerCase() ? <mark key={`${part}-${index}`}>{part}</mark> : part,
  );
}

function extractRssSources(value: unknown): RssSource[] {
  if (typeof value === "string") {
    try { return extractRssSources(JSON.parse(value)); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(extractRssSources);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (typeof object.sourceUrl === "string" && typeof object.sourceName === "string") return [object as unknown as RssSource];
  for (const key of ["rssSources", "sources", "data"]) {
    const nested = extractRssSources(object[key]);
    if (nested.length) return nested;
  }
  return [];
}

function normalizedChapterTitle(title = "") {
  return title
    .toLowerCase()
    .replace(/[（(]\s*第?\s*\d+\s*[\/／]\s*\d+\s*页\s*[)）]/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function resolveChapterIndex(
  chapters: Chapter[],
  fallbackIndex: number,
  preferred?: { title?: string; progress?: number },
) {
  if (!chapters.length) return 0;
  const target = normalizedChapterTitle(preferred?.title);
  if (target) {
    const exact = chapters.findIndex((chapter) => normalizedChapterTitle(chapter.title) === target);
    if (exact >= 0) return exact;
    const partial = chapters.findIndex((chapter) => {
      const candidate = normalizedChapterTitle(chapter.title);
      return candidate.length >= 4 && (candidate.includes(target) || target.includes(candidate));
    });
    if (partial >= 0) return partial;
  }
  if (preferred?.progress !== undefined && Number.isFinite(preferred.progress)) {
    return Math.round(Math.min(1, Math.max(0, preferred.progress)) * Math.max(0, chapters.length - 1));
  }
  return Math.min(Math.max(0, fallbackIndex), Math.max(0, chapters.length - 1));
}

export function ReaderShell() {
  const [view, setView] = useState<ViewName>("shelf");
  const [books, setBooks] = useState<Book[]>([]);
  const [sources, setSources] = useState<BookSource[]>([]);
  const [groups, setGroups] = useState<BookGroup[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [rssSources, setRssSources] = useState<RssSource[]>([]);
  const [rssArticles, setRssArticles] = useState<RssArticle[]>([]);
  const [replaceRules, setReplaceRules] = useState<ReplaceRule[]>([]);
  const [webdavFiles, setWebdavFiles] = useState<WebdavFile[]>([]);
  const [users, setUsers] = useState<ReaderUser[]>([]);
  const [adminAuthorized, setAdminAuthorized] = useState(false);
  const [searchResults, setSearchResults] = useState<Book[]>([]);
  const [exploreResults, setExploreResults] = useState<Book[]>([]);
  const [discoverMode, setDiscoverMode] = useState<"search" | "explore">("search");
  const [exploreCategory, setExploreCategory] = useState("mixed");
  const [exploreCursor, setExploreCursor] = useState(0);
  const [exploreHasMore, setExploreHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [profile, setProfile] = useState<ServerProfile>({});
  const [showConnect, setShowConnect] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [message, setMessage] = useState("");
  const [reader, setReader] = useState<ReaderSession | null>(null);
  const [readerError, setReaderError] = useState("");
  const [showCatalog, setShowCatalog] = useState(false);
  const [showReaderSettings, setShowReaderSettings] = useState(false);
  const [showChapterSearch, setShowChapterSearch] = useState(false);
  const [chapterQuery, setChapterQuery] = useState("");
  const [preferences, setPreferences] = useState<ReaderPreferences>(defaultPreferences);
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [sourceFilter, setSourceFilter] = useState<"all" | "enabled" | "compatibility" | "invalid">("all");
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceSort, setSourceSort] = useState<"order" | "name" | "latency">("order");
  const [sourceDebugLog, setSourceDebugLog] = useState<string[]>([]);
  const [sourceDebugging, setSourceDebugging] = useState(false);
  const [convertedContent, setConvertedContent] = useState("");
  const [activeGroup, setActiveGroup] = useState<number | "all" | "ungrouped">("all");
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("local");
  const [selectedRssSource, setSelectedRssSource] = useState<RssSource | null>(null);
  const [articleSession, setArticleSession] = useState<ArticleSession | null>(null);
  const [sourceEditor, setSourceEditor] = useState<BookSource | null>(null);
  const [showSourceEditor, setShowSourceEditor] = useState(false);
  const [sourceCandidates, setSourceCandidates] = useState<Book[]>([]);
  const [sourceCandidateCursor, setSourceCandidateCursor] = useState(-1);
  const [sourceCandidateHasMore, setSourceCandidateHasMore] = useState(false);
  const [showSourceSwitch, setShowSourceSwitch] = useState(false);
  const [sourceSwitching, setSourceSwitching] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [autoReading, setAutoReading] = useState(false);
  const [readerChrome, setReaderChrome] = useState(true);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [greeting, setGreeting] = useState("欢迎回来");
  const [appTheme, setAppTheme] = useState<AppTheme>("system");
  const [systemDark, setSystemDark] = useState(false);
  const [exploreEnabled, setExploreEnabled] = useState(false);
  const [offlineStatus, setOfflineStatus] = useState<Record<string, OfflineBookStatus>>({});
  const [offlineDownload, setOfflineDownload] = useState<{ bookUrl: string; done: number; total: number } | null>(null);
  const [offlinePickerBook, setOfflinePickerBook] = useState<Book | null>(null);
  const [shelfVisibleCount, setShelfVisibleCount] = useState(48);
  const sourceFileRef = useRef<HTMLInputElement>(null);
  const localBookRef = useRef<HTMLInputElement>(null);
  const webdavFileRef = useRef<HTMLInputElement>(null);
  const backupFileRef = useRef<HTMLInputElement>(null);
  const rssFileRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const readerTopRef = useRef<HTMLDivElement>(null);
  const readerOverlayRef = useRef<HTMLElement>(null);
  const readingPaperRef = useRef<HTMLElement>(null);
  const activeCatalogChapterRef = useRef<HTMLButtonElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const autoTurnRef = useRef(false);
  const offlineDownloadRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const sourceSwitchAbortRef = useRef<AbortController | null>(null);
  const [shelfRefreshing, setShelfRefreshing] = useState(false);

  const api = useMemo(() => new ReaderApi(), []);

  const filteredSources = useMemo(() => {
    let result = sources;
    if (sourceFilter === "enabled") result = result.filter((source) => source.enabled !== false);
    if (sourceFilter === "compatibility") result = result.filter((source) => source.loginUrl || source.enabledCookieJar);
    if (sourceFilter === "invalid") result = result.filter((source) => (source.bookSourceGroup || "").split(/[,，]/).includes("失效"));
    const query = sourceQuery.trim().toLowerCase();
    if (query) result = result.filter((source) => `${source.bookSourceName}${source.bookSourceUrl}${source.bookSourceGroup || ""}`.toLowerCase().includes(query));
    return [...result].sort((left, right) => {
      if (sourceSort === "name") return left.bookSourceName.localeCompare(right.bookSourceName, "zh-CN");
      if (sourceSort === "latency") return (left.respondTime || Number.MAX_SAFE_INTEGER) - (right.respondTime || Number.MAX_SAFE_INTEGER);
      return (left.customOrder || 0) - (right.customOrder || 0);
    });
  }, [sourceFilter, sourceQuery, sourceSort, sources]);

  const currentChapter = reader?.chapters[reader.chapterIndex];
  const primaryBook = books[0];
  const visibleBooks = useMemo(
    () => activeGroup === "all"
      ? books
      : activeGroup === "ungrouped"
        ? books.filter((book) => !book.group)
        : books.filter((book) => bookInGroup(book, activeGroup)),
    [activeGroup, books],
  );
  const shownBooks = visibleBooks.slice(0, shelfVisibleCount);
  const hasExploreSources = sources.some((source) => source.enabled !== false && source.enabledExplore !== false && Boolean(source.exploreUrl));
  const exploreAvailable = exploreEnabled && hasExploreSources;
  const resolvedAppTheme = appTheme === "system" ? (systemDark ? "dark" : "light") : appTheme;
  const resolvedReaderTheme = preferences.theme === "system" ? (systemDark ? "night" : "paper") : preferences.theme;

  const renderedContent = useMemo(() => {
    if (!reader) return "";
    return replaceRules
      .filter((rule) => rule.isEnabled)
      .reduce((content, rule) => {
        if (rule.scope && !`${reader.book.name}\n${reader.book.author}\n${reader.book.bookUrl}`.includes(rule.scope)) {
          return content;
        }
        try {
          return rule.isRegex
            ? content.replace(new RegExp(rule.pattern, "g"), rule.replacement)
            : content.split(rule.pattern).join(rule.replacement);
        } catch {
          return content;
        }
      }, reader.content);
  }, [reader, replaceRules]);

  const readingContent = preferences.chineseMode === "original" ? renderedContent : convertedContent || renderedContent;
  const chapterMatchCount = useMemo(() => {
    const needle = chapterQuery.trim().toLowerCase();
    if (!needle) return 0;
    return readingContent.toLowerCase().split(needle).length - 1;
  }, [chapterQuery, readingContent]);
  const readerSourceType = reader?.book.type ?? sources.find((source) => source.bookSourceUrl === reader?.book.origin)?.bookSourceType ?? 0;
  const readerMediaUrls = useMemo(() => readerSourceType === 1 || readerSourceType === 2 ? mediaUrls(readingContent) : [], [readerSourceType, readingContent]);

  useEffect(() => {
    const storedProfile = getStoredProfile();
    const storedPreferences = getStoredPreferences();
    const storedAppTheme = getStoredAppTheme();
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    setProfile(storedProfile);
    setPreferences(storedPreferences);
    setAppTheme(storedAppTheme);
    setExploreEnabled(getStoredExploreEnabled());
    setSystemDark(colorScheme.matches);
    setGreeting(timeGreeting());

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowCommand((value) => !value);
      }
      if (event.key === "Escape") {
        setShowConnect(false);
        setShowCommand(false);
        setShowSourceEditor(false);
        setShowCatalog(false);
        setShowReaderSettings(false);
        setShowSourceSwitch(false);
        setShowChapterSearch(false);
      }
      if (reader && event.key === "ArrowRight") void changePageOrChapter(1);
      if (reader && event.key === "ArrowLeft") void changePageOrChapter(-1);
    };
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("keydown", keyboard);
    const followSystemTheme = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    colorScheme.addEventListener("change", followSystemTheme);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("keydown", keyboard);
      colorScheme.removeEventListener("change", followSystemTheme);
    };
    // Keyboard listener intentionally follows the active reader session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader]);

  useEffect(() => {
    const openLayer = document.querySelector<HTMLElement>(
      ".modal-backdrop [role='dialog'], .reader-drawer",
    );
    if (!openLayer) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = [
      "button:not([disabled])",
      "a[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusable = () => [...openLayer.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => element.offsetParent !== null);
    if (!openLayer.contains(document.activeElement)) focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    openLayer.addEventListener("keydown", trapFocus);
    return () => {
      openLayer.removeEventListener("keydown", trapFocus);
      previousFocus?.focus();
    };
  }, [showCatalog, showChapterSearch, showCommand, showConnect, showReaderSettings, showSourceEditor, showSourceSwitch]);

  useEffect(() => {
    localStorage.setItem("yomu-reader-preferences", JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    if (!showCatalog) return;
    const frame = window.requestAnimationFrame(() => {
      activeCatalogChapterRef.current?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showCatalog, reader?.chapterIndex]);

  useEffect(() => {
    localStorage.setItem("yomu-app-theme", appTheme);
    document.documentElement.dataset.theme = resolvedAppTheme;
    document.documentElement.style.colorScheme = resolvedAppTheme;
  }, [appTheme, resolvedAppTheme]);

  useEffect(() => {
    localStorage.setItem("yomu-explore-enabled", String(exploreEnabled));
    if (!exploreEnabled) setDiscoverMode("search");
  }, [exploreEnabled]);

  useEffect(() => {
    setShelfVisibleCount(48);
  }, [activeGroup]);

  useEffect(() => {
    if (!api) return;
    void hydrateFromServer(api, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (connection !== "connected" || !profile.username) return;
    const key = `yomu-shelf-refresh-at:${profile.username}`;
    const lastRefresh = Number(localStorage.getItem(key) || 0);
    if (Date.now() - lastRefresh < 24 * 60 * 60 * 1000) return;
    const timer = window.setTimeout(() => {
      void api.getBookshelf(true, {
        maxAgeMs: 24 * 60 * 60 * 1000,
        limit: 80,
        concurrentCount: 2,
      }).then((updatedBooks) => {
        localStorage.setItem(key, String(Date.now()));
        setBooks(updatedBooks);
        void refreshOfflineStatuses(updatedBooks);
      }).catch(() => undefined);
    }, 8000);
    return () => window.clearTimeout(timer);
    // This is deliberately detached from login and runs at most once per device/day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, connection, profile.username]);

  useEffect(() => {
    if (!autoReading || !reader) return;
    const timer = window.setInterval(() => {
      const overlay = readerOverlayRef.current;
      if (!overlay || reader.loading || preferences.pageMode === "paged") return;
      const atBottom = overlay.scrollTop + overlay.clientHeight >= overlay.scrollHeight - 4;
      if (atBottom) {
        if (reader.chapterIndex < reader.chapters.length - 1) {
          if (!autoTurnRef.current) {
            autoTurnRef.current = true;
            void loadChapter(reader.chapterIndex + 1).finally(() => {
              overlay.scrollTo({ top: 0 });
              autoTurnRef.current = false;
            });
          }
        } else setAutoReading(false);
      } else {
        overlay.scrollBy({ top: 1, behavior: "auto" });
      }
    }, 38);
    return () => window.clearInterval(timer);
    // The timer follows the current chapter and reading mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReading, preferences.pageMode, reader]);

  useEffect(() => {
    let cancelled = false;
    if (preferences.chineseMode === "original") {
      setConvertedContent("");
      return;
    }
    const converterModule = preferences.chineseMode === "simplified"
      ? import("opencc-js/t2cn")
      : import("opencc-js/cn2t");
    void converterModule.then((OpenCC) => {
      const converter = OpenCC.Converter(
        preferences.chineseMode === "simplified"
          ? { from: "tw", to: "cn" }
          : { from: "cn", to: "tw" },
      );
      if (!cancelled) setConvertedContent(converter(renderedContent));
    }).catch(() => {
      if (!cancelled) setConvertedContent(renderedContent);
    });
    return () => { cancelled = true; };
  }, [preferences.chineseMode, renderedContent]);

  function toast(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 2600);
  }

  function sourceNameFor(book: Book) {
    return book.originName
      || sources.find((source) => source.bookSourceUrl === book.origin)?.bookSourceName
      || book.origin
      || "未知书源";
  }

  async function hydrateFromServer(client: ReaderApi, refresh: boolean) {
    setConnection((current) => current === "connected" ? current : "checking");
    const storedProfile = getStoredProfile();
    if (storedProfile.username) client.setCacheNamespace(storedProfile.username);
    client.setOfflineMode(false);
    try {
      const [user, serverBooks] = await Promise.all([
        client.getUserInfo(),
        client.getBookshelf(refresh),
      ]);
      setBooks(serverBooks);
      const sessionUsername = user.userInfo?.username || profile.username || "";
      setProfile((current) => ({ ...current, username: sessionUsername || current.username }));
      if (sessionUsername) {
        client.setCacheNamespace(sessionUsername);
        localStorage.setItem("yomu-username", sessionUsername);
      }
      setAdminAuthorized(Boolean(user.adminAuthorized));
      setConnection("connected");
      void refreshOfflineStatuses(serverBooks);
      if (refresh) toast(`已更新 ${serverBooks.length} 本书`);

      void Promise.allSettled([
        client.getBookSources(),
        client.getBookGroups(),
        client.getBookmarks(),
        client.getRssSources(),
        client.getReplaceRules(),
      ]).then((optional) => {
        if (optional[0].status === "fulfilled") setSources(optional[0].value as BookSource[]);
        if (optional[1].status === "fulfilled") setGroups(optional[1].value as BookGroup[]);
        if (optional[2].status === "fulfilled") setBookmarks(optional[2].value as Bookmark[]);
        if (optional[3].status === "fulfilled") setRssSources(optional[3].value as RssSource[]);
        if (optional[4].status === "fulfilled") setReplaceRules(optional[4].value as ReplaceRule[]);
      });
    } catch (error) {
      if (error instanceof ReaderApiError && error.code === "NEED_LOGIN") {
        setConnection("signedout");
        if (refresh) toast("登录已过期，请重新登录");
      } else {
        const offlineBooks = storedProfile.username ? await client.getOfflineBooks().catch(() => []) : [];
        if (offlineBooks.length) {
          setBooks(offlineBooks);
          setProfile(storedProfile);
          setSources([]);
          setGroups([]);
          setBookmarks([]);
          setRssSources([]);
          setReplaceRules([]);
          setAdminAuthorized(false);
          await refreshOfflineStatuses(offlineBooks);
          client.setOfflineMode(true);
          setConnection("offline");
          toast("已进入离线阅读");
        } else {
          setConnection("signedout");
          toast(error instanceof Error ? error.message : "阅读服务暂时不可用");
        }
      }
    }
  }

  async function loginAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const username = String(values.get("username") || "").trim();
    const password = String(values.get("password") || "");
    if (!username || !password) return toast("请输入用户名和密码");
    setConnection("authenticating");
    try {
      await api.login(username, password);
      localStorage.setItem("yomu-username", username);
      setProfile({ username });
      await hydrateFromServer(api, false);
    } catch (error) {
      setConnection("signedout");
      toast(error instanceof Error ? error.message : "登录失败");
    }
  }

  async function logoutAccount() {
    offlineDownloadRef.current?.abort();
    searchAbortRef.current?.abort();
    await api.logout().catch(() => undefined);
    await api.clearOfflineLibrary().catch(() => undefined);
    localStorage.removeItem("yomu-username");
    setProfile({});
    setBooks([]);
    setSources([]);
    setGroups([]);
    setBookmarks([]);
    setRssSources([]);
    setReplaceRules([]);
    setWebdavFiles([]);
    setUsers([]);
    setAdminAuthorized(false);
    setOfflineStatus({});
    setConnection("signedout");
    setShowConnect(false);
  }

  async function searchBooks(event?: FormEvent) {
    event?.preventDefault();
    const key = query.trim();
    if (!key) {
      searchInputRef.current?.focus();
      return;
    }
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setView("discover");
    setDiscoverMode("search");
    setSearchResults([]);
    try {
      if (api && connection === "connected") {
        const result = await api.searchBooks(key, (batch) => setSearchResults(batch), controller.signal);
        setSearchResults(result);
      } else {
        throw new Error("登录已过期，请重新登录");
      }
    } catch (error) {
      if (!controller.signal.aborted) toast(error instanceof Error ? error.message : "搜索失败");
    } finally {
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
        setSearching(false);
      }
    }
  }

  async function refreshShelf() {
    if (shelfRefreshing) return;
    setShelfRefreshing(true);
    try {
      await hydrateFromServer(api, true);
    } finally {
      setShelfRefreshing(false);
    }
  }

  async function exploreBooks(category: string, append = false) {
    if (!exploreAvailable) {
      setDiscoverMode("search");
      return toast("当前书源没有分类入口");
    }
    setDiscoverMode("explore");
    setExploreCategory(category);
    setSearching(true);
    try {
      if (api && connection === "connected") {
        const result = await api.exploreBooks(category, append ? exploreCursor : 0);
        setExploreResults((current) => append ? [...current, ...result.books] : result.books);
        setExploreCursor(result.nextCursor);
        setExploreHasMore(result.hasMore);
      } else {
        throw new Error("登录已过期，请重新登录");
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "书海加载失败");
    } finally {
      setSearching(false);
    }
  }

  async function addBook(book: Book) {
    try {
      if (!api || connection !== "connected") throw new Error("离线时无法添加书籍");
      await api.saveBook(book);
      setBooks((current) =>
        current.some((item) => item.bookUrl === book.bookUrl) ? current : [book, ...current],
      );
      toast("已加入书架");
    } catch (error) {
      toast(error instanceof Error ? error.message : "加入书架失败");
    }
  }

  async function openBook(book: Book, preferredChapter?: { title?: string; progress?: number }) {
    const fallbackIndex = Math.max(0, book.durChapterIndex || 0);
    setReader({
      book,
      chapters: [],
      chapterIndex: fallbackIndex,
      content: "",
      loading: true,
    });
    setReaderChrome(true);
    setReaderError("");
    try {
      if (!api || !["connected", "offline"].includes(connection)) throw new Error("请重新登录");
      const chapters = await api.getChapterList(book);
      if (!chapters.length) throw new Error("这本书没有可读取的章节");
      const chapterPreference = preferredChapter || (book.durChapterTitle
        ? { title: book.durChapterTitle }
        : undefined);
      const chapterIndex = resolveChapterIndex(chapters, fallbackIndex, chapterPreference);
      // Keep the usable catalog in the reader even if the selected chapter's
      // source is temporarily unavailable. Users can still pick another cached
      // chapter, retry, refresh the catalog, or switch source.
      setReader({ book, chapters, chapterIndex, content: "", loading: true });
      const content = await api.getBookContent(book, chapters[chapterIndex], chapterIndex);
      setReader({ book, chapters, chapterIndex, content, loading: false });
      if (preferredChapter || chapterIndex !== fallbackIndex) {
        setBooks((current) => current.map((item) => item.bookUrl === book.bookUrl
          ? { ...item, durChapterIndex: chapterIndex, durChapterTitle: chapters[chapterIndex]?.title }
          : item));
        if (connection === "connected") void api.saveProgress(book.bookUrl, chapterIndex);
      }
      prefetchNearby(book, chapters, chapterIndex);
      window.setTimeout(() => readerTopRef.current?.scrollIntoView(), 10);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "打开书籍失败";
      setReader((current) => current ? { ...current, loading: false } : current);
      setReaderError(detail);
      toast(detail);
    }
  }

  async function loadChapter(index: number) {
    if (!reader || index < 0 || index >= reader.chapters.length) return;
    setReader((current) => (current ? { ...current, chapterIndex: index, loading: true } : current));
    setShowCatalog(false);
    setReaderError("");
    try {
      if (!api || !["connected", "offline"].includes(connection)) throw new Error("请重新登录");
      const content = await api.getBookContent(reader.book, reader.chapters[index], index);
      setReader((current) => (current ? { ...current, chapterIndex: index, content, loading: false } : current));
      setBooks((current) =>
        current.map((book) =>
          book.bookUrl === reader.book.bookUrl
            ? { ...book, durChapterIndex: index, durChapterTitle: reader.chapters[index]?.title }
            : book,
        ),
      );
      void api.saveOfflineProgress(reader.book, reader.chapters, index);
      if (api && connection === "connected") void api.saveProgress(reader.book.bookUrl, index);
      prefetchNearby(reader.book, reader.chapters, index);
      readerOverlayRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setReader((current) => (current ? { ...current, loading: false } : current));
      const detail = error instanceof Error ? error.message : "章节加载失败";
      setReaderError(detail);
      toast(detail);
    }
  }

  async function changeChapter(offset: number) {
    if (!reader || reader.loading) return;
    await loadChapter(reader.chapterIndex + offset);
  }

  async function changePageOrChapter(offset: number) {
    if (preferences.pageMode === "paged") {
      const paper = readingPaperRef.current;
      if (paper) {
        const maxScrollLeft = Math.max(0, paper.scrollWidth - paper.clientWidth);
        const next = Math.min(maxScrollLeft, Math.max(0, paper.scrollLeft + offset * paper.clientWidth));
        const canMove = offset > 0 ? paper.scrollLeft < maxScrollLeft - 4 : paper.scrollLeft > 4;
        if (canMove) {
          paper.scrollTo({ left: next, behavior: "smooth" });
          return;
        }
      }
    }
    await changeChapter(offset);
  }

  function handleReaderTouchStart(event: React.TouchEvent) {
    const touch = event.changedTouches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleReaderTouchEnd(event: React.TouchEvent) {
    const start = touchStartRef.current;
    const touch = event.changedTouches[0];
    touchStartRef.current = null;
    if (!start) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 58 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      void changePageOrChapter(dx < 0 ? 1 : -1);
    }
  }

  function handleReaderTap(event: React.MouseEvent<HTMLElement>) {
    if (window.getSelection()?.toString()) return;
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    const ratio = event.clientX / window.innerWidth;
    if (ratio < 0.23) void changePageOrChapter(-1);
    else if (ratio > 0.77) void changePageOrChapter(1);
    else setReaderChrome((value) => !value);
  }

  function prefetchNearby(book: Book, chapters: Chapter[], index: number) {
    if (!api || connection !== "connected") return;
    for (const next of [index + 1, index + 2]) {
      if (next < chapters.length) void api.getBookContent(book, chapters[next], next).catch(() => undefined);
    }
  }

  async function importSources(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (connection !== "connected") return toast("离线时无法导入书源");
    try {
      const imported = extractBookSources(JSON.parse(await file.text()));
      const valid = imported.filter((source) => source.bookSourceName && source.bookSourceUrl);
      if (!valid.length) throw new Error("文件里没有可识别的书源");
      if (api && connection === "connected") await api.saveBookSources(valid);
      setSources((current) => {
        const urls = new Set(valid.map((source) => source.bookSourceUrl));
        return [...valid, ...current.filter((source) => !urls.has(source.bookSourceUrl))];
      });
      toast(`已导入 ${valid.length} 个书源`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "书源导入失败");
    }
  }

  async function toggleSource(source: BookSource) {
    if (connection !== "connected") return toast("离线时无法修改书源");
    const updated = { ...source, enabled: source.enabled === false };
    try {
      if (api && connection === "connected") await api.saveBookSource(updated);
      setSources((current) => current.map((item) => item.bookSourceUrl === source.bookSourceUrl ? updated : item));
      toast(updated.enabled === false ? "书源已停用" : "书源已启用");
    } catch (error) {
      toast(error instanceof Error ? error.message : "更新书源失败");
    }
  }

  async function saveSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connection !== "connected") return toast("离线时无法保存书源");
    const values = new FormData(event.currentTarget);
    let rawSource: Partial<BookSource> = {};
    const rawJson = String(values.get("rawJson") || "").trim();
    if (rawJson) {
      try {
        rawSource = JSON.parse(rawJson) as BookSource;
      } catch {
        return toast("高级 JSON 格式有误");
      }
    }
    const baseSource: Partial<BookSource> = {
      ...(sourceEditor || { enabled: true, enabledExplore: true }),
      ...rawSource,
    };
    const source: BookSource = {
      ...baseSource,
      bookSourceName: String(values.get("bookSourceName") || "").trim(),
      bookSourceUrl: String(values.get("bookSourceUrl") || "").trim(),
      bookSourceGroup: String(values.get("bookSourceGroup") || "").trim(),
      bookSourceType: Number(values.get("bookSourceType") || 0),
      searchUrl: String(values.get("searchUrl") || "").trim() || undefined,
      exploreUrl: String(values.get("exploreUrl") || "").trim() || undefined,
      loginUrl: String(values.get("loginUrl") || "").trim() || undefined,
      concurrentRate: String(values.get("concurrentRate") || "").trim() || undefined,
      header: String(values.get("header") || "").trim() || undefined,
      bookUrlPattern: String(values.get("bookUrlPattern") || "").trim() || undefined,
      enabledCookieJar: values.get("enabledCookieJar") === "on",
      enabledExplore: values.get("enabledExplore") === "on",
      enabled: values.get("enabled") === "on",
      ruleSearch: sourceRuleFromForm(values, "ruleSearch", baseSource.ruleSearch),
      ruleExplore: sourceRuleFromForm(values, "ruleExplore", baseSource.ruleExplore),
      ruleBookInfo: sourceRuleFromForm(values, "ruleBookInfo", baseSource.ruleBookInfo),
      ruleToc: sourceRuleFromForm(values, "ruleToc", baseSource.ruleToc),
      ruleContent: sourceRuleFromForm(values, "ruleContent", baseSource.ruleContent),
    };
    if (!source.bookSourceName || !source.bookSourceUrl) return toast("名称和地址不能为空");
    try {
      if (api && connection === "connected") await api.saveBookSource(source);
      setSources((current) => [source, ...current.filter((item) => item.bookSourceUrl !== source.bookSourceUrl)]);
      setShowSourceEditor(false);
      toast("书源已保存");
    } catch (error) {
      toast(error instanceof Error ? error.message : "书源保存失败");
    }
  }

  async function testVisibleSources() {
    if (!api || connection !== "connected") return toast("登录已过期，请重新登录");
    if (!filteredSources.length) return;
    setLibraryBusy(true);
    try {
      const result = await api.testBookSources(filteredSources.slice(0, 100));
      await hydrateFromServer(api, false);
      toast(`检测完成：${result.valid} 可用，${result.invalid} 失效`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "书源检测失败");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function batchToggleSources(enabled: boolean) {
    if (!filteredSources.length) return;
    const updates = filteredSources.map((source) => ({ ...source, enabled }));
    try {
      if (api && connection === "connected") await api.saveBookSources(updates);
      const urls = new Set(updates.map((source) => source.bookSourceUrl));
      setSources((current) => current.map((source) => urls.has(source.bookSourceUrl) ? { ...source, enabled } : source));
      toast(`已${enabled ? "启用" : "停用"}当前 ${updates.length} 个书源`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "批量更新失败");
    }
  }

  async function deleteInvalidSources() {
    if (!api || connection !== "connected" || !window.confirm("确定删除所有已标记为“失效”的书源吗？")) return;
    try {
      const result = await api.deleteInvalidBookSources();
      await hydrateFromServer(api, false);
      toast(`已删除 ${result.deleted} 个失效书源`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "失效书源清理失败");
    }
  }

  async function moveSource(source: BookSource, offset: number) {
    const ordered = [...sources].sort((left, right) => (left.customOrder || 0) - (right.customOrder || 0));
    const index = ordered.findIndex((item) => item.bookSourceUrl === source.bookSourceUrl);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    const updated = ordered.map((item, order) => ({ ...item, customOrder: order }));
    try {
      if (api && connection === "connected") await api.saveBookSources(updated);
      setSources(updated);
    } catch (error) {
      toast(error instanceof Error ? error.message : "书源排序失败");
    }
  }

  function downloadJson(name: string, value: unknown) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function deleteSource(source: BookSource, closeEditor = false) {
    if (!window.confirm(`确定删除书源“${source.bookSourceName}”吗？`)) return;
    try {
      if (api && connection === "connected") await api.deleteBookSource(source);
      setSources((current) => current.filter((item) => item.bookSourceUrl !== source.bookSourceUrl));
      if (closeEditor) setShowSourceEditor(false);
      toast("书源已删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "书源删除失败");
    }
  }

  async function deleteEditedSource() {
    if (sourceEditor) await deleteSource(sourceEditor, true);
  }

  function openSourceLogin(source: BookSource) {
    if (!api || connection !== "connected") return toast("登录已过期，请重新登录");
    try {
      window.open(api.getBookSourceLoginUrl(source), "yomu-source-login", "popup,width=520,height=760");
      toast("登录完成后关闭窗口，再检测一次书源");
    } catch (error) {
      toast(error instanceof Error ? error.message : "无法打开登录页");
    }
  }

  async function debugEditedSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceEditor || !api || connection !== "connected") return toast("请先保存书源并重新登录");
    const keyword = String(new FormData(event.currentTarget).get("keyword") || "").trim();
    if (!keyword) return toast("请输入调试关键词");
    setSourceDebugLog([]);
    setSourceDebugging(true);
    try {
      await api.debugBookSource(sourceEditor, keyword, (entry) => {
        let message = entry;
        try {
          const value = JSON.parse(entry) as { msg?: string; error?: string; data?: unknown };
          message = value.msg || value.error || (value.data ? `返回 ${Array.isArray(value.data) ? value.data.length : 1} 条数据` : entry);
        } catch {
          // Keep plain SSE output.
        }
        setSourceDebugLog((current) => [...current.slice(-39), message]);
      });
    } catch (error) {
      setSourceDebugLog((current) => [...current, error instanceof Error ? error.message : "调试失败"]);
    } finally {
      setSourceDebugging(false);
    }
  }

  async function uploadLocalBook(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!api || connection !== "connected") return toast("登录已过期，请重新登录");
    setLibraryBusy(true);
    try {
      const saved = await api.uploadLocalBook(file);
      setBooks((current) => [saved, ...current.filter((book) => book.bookUrl !== saved.bookUrl)]);
      toast(`《${saved.name}》已加入书仓`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "本地书上传失败");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function exportLocalBook(book: Book) {
    if (connection !== "connected") return toast("离线时无法导出原文件");
    setLibraryBusy(true);
    try {
      const blob = await api.downloadLocalBook(book.bookUrl);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${book.name.replace(/[\\/:*?"<>|]/g, "_")}.${localBookExtension(book)}`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      toast("已导出本地书");
    } catch (error) {
      toast(error instanceof Error ? error.message : "本地书导出失败");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function saveCurrentBookmark() {
    if (!reader || !currentChapter) return;
    if (connection !== "connected") return toast("离线阅读时不能同步书签");
    const bookmark: Bookmark = {
      time: Date.now(),
      bookName: reader.book.name,
      bookAuthor: reader.book.author,
      bookUrl: reader.book.bookUrl,
      chapterIndex: reader.chapterIndex,
      chapterPos: window.scrollY,
      chapterName: currentChapter.title,
      bookText: readingContent.slice(0, 180),
      content: "",
    };
    try {
      if (api && connection === "connected") await api.saveBookmark(bookmark);
      setBookmarks((current) => [bookmark, ...current.filter((item) => `${item.bookName}_${item.bookAuthor}` !== `${bookmark.bookName}_${bookmark.bookAuthor}`)]);
      toast("书签已同步");
    } catch (error) {
      toast(error instanceof Error ? error.message : "书签保存失败");
    }
  }

  async function removeBookmark(bookmark: Bookmark) {
    if (connection !== "connected") return toast("离线时无法删除书签");
    try {
      if (api && connection === "connected") await api.deleteBookmark(bookmark);
      setBookmarks((current) => current.filter((item) => item !== bookmark));
      toast("书签已删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除书签失败");
    }
  }

  async function openBookmark(bookmark: Bookmark) {
    const book = books.find((item) =>
      item.bookUrl === bookmark.bookUrl ||
      (item.name === bookmark.bookName && item.author === bookmark.bookAuthor),
    );
    if (!book) return toast("这本书已不在书架中");
    await openBook({ ...book, durChapterIndex: bookmark.chapterIndex });
  }

  function toggleSpeech() {
    if (!("speechSynthesis" in window)) return toast("当前浏览器不支持系统朗读");
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const chunks = `${currentChapter?.title || ""}。${readingContent}`
      .split(/(?<=[。！？；\n])/)
      .reduce<string[]>((result, part) => {
        const last = result[result.length - 1];
        if (last && last.length + part.length < 900) result[result.length - 1] += part;
        else if (part.trim()) result.push(part);
        return result;
      }, []);
    let index = 0;
    const speakNext = () => {
      if (index >= chunks.length) return setSpeaking(false);
      const utterance = new SpeechSynthesisUtterance(chunks[index++]);
      utterance.lang = "zh-CN";
      utterance.rate = 0.95;
      utterance.onend = speakNext;
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    };
    setSpeaking(true);
    speakNext();
  }

  async function loadAvailableSources(refresh = false, append = false) {
    if (!reader || !api || connection !== "connected") return toast("登录已过期，请重新登录");
    sourceSwitchAbortRef.current?.abort();
    const controller = new AbortController();
    sourceSwitchAbortRef.current = controller;
    setShowSourceSwitch(true);
    setSourceSwitching(true);
    if (!append) {
      setSourceCandidates([]);
      setSourceCandidateCursor(-1);
      setSourceCandidateHasMore(false);
    }
    try {
      const result = await api.streamAvailableBookSources(
        reader.book,
        refresh,
        (batch) => setSourceCandidates((current) => {
          const merged = new Map((append ? current : []).map((book) => [`${book.origin}\u0000${book.bookUrl}`, book]));
          for (const book of batch) merged.set(`${book.origin}\u0000${book.bookUrl}`, book);
          return [...merged.values()];
        }),
        controller.signal,
        append ? sourceCandidateCursor : -1,
      );
      setSourceCandidates((current) => {
        const merged = new Map((append ? current : []).map((book) => [`${book.origin}\u0000${book.bookUrl}`, book]));
        for (const book of result.books) merged.set(`${book.origin}\u0000${book.bookUrl}`, book);
        return [...merged.values()];
      });
      setSourceCandidateCursor(result.lastIndex);
      setSourceCandidateHasMore(result.hasMore);
    } catch (error) {
      if (!controller.signal.aborted) toast(error instanceof Error ? error.message : "换源搜索失败");
    } finally {
      if (sourceSwitchAbortRef.current === controller) sourceSwitchAbortRef.current = null;
      if (!controller.signal.aborted) setSourceSwitching(false);
    }
  }

  async function switchBookSource(candidate: Book) {
    if (!reader || !api) return;
    const preferredChapter = {
      title: currentChapter?.title,
      progress: reader.chapters.length > 1 ? reader.chapterIndex / (reader.chapters.length - 1) : 0,
    };
    sourceSwitchAbortRef.current?.abort();
    sourceSwitchAbortRef.current = null;
    setSourceSwitching(true);
    try {
      const updated = await api.setBookSource(reader.book.bookUrl, candidate);
      setBooks((current) => current.map((book) => book.bookUrl === reader.book.bookUrl ? updated : book));
      setShowSourceSwitch(false);
      await openBook(updated, preferredChapter);
      toast(`已切换到 ${sourceNameFor(candidate)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "切换书源失败");
    } finally {
      setSourceSwitching(false);
    }
  }

  async function selectRssSource(source: RssSource) {
    setSelectedRssSource(source);
    setLibraryBusy(true);
    try {
      if (!api || connection !== "connected") throw new Error("登录已过期，请重新登录");
      const result = await api.getRssArticles(source);
      setRssArticles(result.first || []);
    } catch (error) {
      setRssArticles([]);
      toast(error instanceof Error ? error.message : "RSS 加载失败");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function openRssArticle(article: RssArticle) {
    setArticleSession({ article, content: plainText(article.content || article.description || ""), loading: true });
    try {
      let content = article.content || article.description || "";
      if (!content && api && selectedRssSource) content = await api.getRssContent(selectedRssSource.sourceUrl, article);
      setArticleSession({ article, content: plainText(content), loading: false });
    } catch (error) {
      setArticleSession((current) => current ? { ...current, loading: false } : current);
      toast(error instanceof Error ? error.message : "文章加载失败");
    }
  }

  async function saveRssSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const source: RssSource = {
      sourceName: String(values.get("sourceName") || "").trim(),
      sourceUrl: String(values.get("sourceUrl") || "").trim(),
      sourceGroup: String(values.get("sourceGroup") || "").trim() || undefined,
      enabled: true,
    };
    if (!source.sourceName || !source.sourceUrl) return toast("请填写 RSS 名称和地址");
    try {
      if (!api || connection !== "connected") throw new Error("登录已过期，请重新登录");
      await api.saveRssSource(source);
      setRssSources((current) => [source, ...current.filter((item) => item.sourceUrl !== source.sourceUrl)]);
      event.currentTarget.reset();
      toast("RSS 订阅已保存");
    } catch (error) {
      toast(error instanceof Error ? error.message : "RSS 保存失败");
    }
  }

  async function importRssSources(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = extractRssSources(JSON.parse(await file.text()));
      if (!imported.length) throw new Error("文件里没有可识别的 RSS 源");
      if (api && connection === "connected") await api.saveRssSources(imported);
      const urls = new Set(imported.map((source) => source.sourceUrl));
      setRssSources((current) => [...imported, ...current.filter((source) => !urls.has(source.sourceUrl))]);
      toast(`已导入 ${imported.length} 个 RSS 源`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "RSS 导入失败");
    }
  }

  async function saveReplaceRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const rule: ReplaceRule = {
      id: Date.now(),
      name: String(values.get("name") || "").trim(),
      pattern: String(values.get("pattern") || ""),
      replacement: String(values.get("replacement") || ""),
      group: String(values.get("group") || "").trim() || undefined,
      scope: String(values.get("scope") || "").trim() || undefined,
      isEnabled: true,
      isRegex: values.get("isRegex") === "on",
      order: replaceRules.length,
    };
    if (!rule.name || !rule.pattern) return toast("规则名称和匹配内容不能为空");
    try {
      if (api && connection === "connected") await api.saveReplaceRule(rule);
      setReplaceRules((current) => [rule, ...current.filter((item) => item.name !== rule.name)]);
      event.currentTarget.reset();
      toast("净化规则已保存");
    } catch (error) {
      toast(error instanceof Error ? error.message : "规则保存失败");
    }
  }

  async function toggleReplaceRule(rule: ReplaceRule) {
    const updated = { ...rule, isEnabled: !rule.isEnabled };
    try {
      if (api && connection === "connected") await api.saveReplaceRule(updated);
      setReplaceRules((current) => current.map((item) => item.name === rule.name ? updated : item));
    } catch (error) {
      toast(error instanceof Error ? error.message : "规则更新失败");
    }
  }

  async function deleteReplaceRule(rule: ReplaceRule) {
    try {
      if (api && connection === "connected") await api.deleteReplaceRule(rule);
      setReplaceRules((current) => current.filter((item) => item.name !== rule.name));
      toast("净化规则已删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "规则删除失败");
    }
  }

  async function deleteRssSource(source: RssSource) {
    try {
      if (!api || connection !== "connected") throw new Error("登录已过期，请重新登录");
      await api.deleteRssSource(source);
      setRssSources((current) => current.filter((item) => item.sourceUrl !== source.sourceUrl));
      if (selectedRssSource?.sourceUrl === source.sourceUrl) {
        setSelectedRssSource(null);
        setRssArticles([]);
      }
      toast("RSS 订阅已删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "RSS 删除失败");
    }
  }

  async function createBookGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connection !== "connected") return toast("离线时无法创建分组");
    const values = new FormData(event.currentTarget);
    const name = String(values.get("groupName") || "").trim();
    if (!name) return;
    let nextId = 1;
    while (groups.some((group) => group.groupId === nextId)) nextId <<= 1;
    const group: BookGroup = {
      groupId: nextId,
      groupName: name,
      orderNo: groups.length,
    };
    try {
      if (api && connection === "connected") await api.saveBookGroup(group);
      setGroups((current) => [...current, group]);
      event.currentTarget.reset();
      toast("书籍分组已创建");
    } catch (error) {
      toast(error instanceof Error ? error.message : "分组保存失败");
    }
  }

  async function moveBookToGroup(book: Book, groupId: number) {
    if (connection !== "connected") return toast("离线时无法移动书籍");
    try {
      if (api && connection === "connected") await api.saveBookGroupId(book.bookUrl, groupId);
      setBooks((current) => current.map((item) => item.bookUrl === book.bookUrl ? { ...item, group: groupId } : item));
      toast(groupId ? "书籍已移动到分组" : "书籍已移出分组");
    } catch (error) {
      toast(error instanceof Error ? error.message : "分组更新失败");
    }
  }

  async function removeBookGroup(group: BookGroup) {
    if (!api || connection !== "connected") return toast("离线时无法删除分组");
    if (!window.confirm(`删除分组“${group.groupName}”？组内书籍会保留并变为未分组。`)) return;
    try {
      const affected = books.filter((book) => bookInGroup(book, group.groupId));
      await Promise.all(affected.map((book) => api.saveBookGroupId(book.bookUrl, 0)));
      await api.deleteBookGroup(group.groupId);
      setBooks((current) => current.map((book) => bookInGroup(book, group.groupId) ? { ...book, group: 0 } : book));
      setGroups((current) => current.filter((item) => item.groupId !== group.groupId));
      if (activeGroup === group.groupId) setActiveGroup("all");
      toast("分组已删除，书籍仍保留在书架");
    } catch (error) {
      toast(error instanceof Error ? error.message : "分组删除失败");
    }
  }

  async function removeBook(book: Book) {
    if (connection !== "connected") return toast("离线时无法删除书籍");
    if (!window.confirm(`确定从书架删除《${book.name}》吗？本地书文件也会一并移除。`)) return;
    try {
      if (api && connection === "connected") await api.deleteBook(book.bookUrl);
      setBooks((current) => current.filter((item) => item.bookUrl !== book.bookUrl));
      toast("书籍已从书架删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除书籍失败");
    }
  }

  async function refreshOfflineStatuses(items: Book[] = books) {
    const entries = await Promise.all(items.map(async (book) => [book.bookUrl, await api.getOfflineBookStatus(book.bookUrl)] as const));
    setOfflineStatus((current) => ({ ...current, ...Object.fromEntries(entries) }));
  }

  async function downloadBookOffline(book: Book, amount: 10 | 50 | 100 | "all") {
    if (offlineDownload?.bookUrl === book.bookUrl) {
      offlineDownloadRef.current?.abort();
      return;
    }
    offlineDownloadRef.current?.abort();
    const controller = new AbortController();
    offlineDownloadRef.current = controller;
    setOfflineDownload({ bookUrl: book.bookUrl, done: 0, total: book.totalChapterNum || 0 });
    try {
      await navigator.storage?.persist?.().catch(() => false);
      await api.downloadBookForOffline(
        book,
        amount,
        (done, total) => setOfflineDownload({ bookUrl: book.bookUrl, done, total }),
        controller.signal,
      );
      await refreshOfflineStatuses([book]);
      toast(`《${book.name}》已下载到本机`);
    } catch (error) {
      if (controller.signal.aborted) toast("已停止离线下载");
      else toast(error instanceof Error ? error.message : "离线下载失败");
      await refreshOfflineStatuses([book]);
    } finally {
      if (offlineDownloadRef.current === controller) offlineDownloadRef.current = null;
      setOfflineDownload((current) => current?.bookUrl === book.bookUrl ? null : current);
    }
  }

  async function removeBookOffline(book: Book) {
    await api.removeOfflineBook(book.bookUrl);
    await refreshOfflineStatuses([book]);
    toast(`已删除《${book.name}》的本机缓存`);
  }

  async function clearAllOfflineChapters() {
    offlineDownloadRef.current?.abort();
    await api.clearOfflineLibrary();
    if (connection === "offline") setBooks([]);
    setOfflineStatus({});
    toast("这台设备的离线章节已清理");
  }

  async function loadWebdavFiles() {
    if (!api || connection !== "connected") return toast("登录已过期，请重新登录");
    setLibraryBusy(true);
    try {
      setWebdavFiles(await api.getWebdavFiles());
    } catch (error) {
      toast(error instanceof Error ? error.message : "WebDAV 文件加载失败，请让管理员为账号启用权限");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function uploadWebdavFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !api) return;
    setLibraryBusy(true);
    try {
      await api.uploadWebdavFile(file);
      await loadWebdavFiles();
      toast("备份文件已上传");
    } catch (error) {
      toast(error instanceof Error ? error.message : "备份上传失败");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function downloadWebdavFile(file: WebdavFile) {
    if (!api || file.isDirectory) return;
    try {
      const url = URL.createObjectURL(await api.downloadWebdavFile(file.path));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : "文件下载失败");
    }
  }

  async function deleteWebdavFile(file: WebdavFile) {
    if (!api || !window.confirm(`确定删除“${file.name}”吗？`)) return;
    try {
      await api.deleteWebdavFile(file.path);
      setWebdavFiles((current) => current.filter((item) => item.path !== file.path));
      toast("备份文件已删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "文件删除失败");
    }
  }

  function createBackupPayload(): YomuBackup {
    return {
      format: "yomu-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      books,
      groups,
      bookSources: sources,
      rssSources,
      bookmarks,
      replaceRules,
    };
  }

  function downloadFullBackup() {
    downloadJson(`yomu-backup-${new Date().toISOString().slice(0, 10)}.json`, createBackupPayload());
  }

  async function restoreBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!api || connection !== "connected") return toast("登录已过期，请重新登录");
    setLibraryBusy(true);
    try {
      const backup = JSON.parse(await file.text()) as YomuBackup;
      if (backup.format !== "yomu-backup" || backup.version !== 1) throw new Error("不是可识别的 Yomu 备份");
      await Promise.all([
        api.saveBooks(backup.books || []),
        api.saveBookGroups(backup.groups || []),
        api.saveBookSources(backup.bookSources || []),
        api.saveRssSources(backup.rssSources || []),
        api.saveBookmarks(backup.bookmarks || []),
        api.saveReplaceRules(backup.replaceRules || []),
      ]);
      await hydrateFromServer(api, true);
      toast("备份已恢复并重新同步");
    } catch (error) {
      toast(error instanceof Error ? error.message : "备份恢复失败");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function loadUsers() {
    if (!api || !adminAuthorized) return toast("需要管理员账户");
    setLibraryBusy(true);
    try {
      setUsers(await api.getUsers());
    } catch (error) {
      toast(error instanceof Error ? error.message : "用户列表加载失败");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function addReaderUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const username = String(values.get("username") || "").trim();
    const password = String(values.get("password") || "");
    if (!username || !password) return toast("请输入用户名和密码");
    try {
      setUsers(await api.addUser(username, password));
      form.reset();
      toast("用户已创建");
    } catch (error) {
      toast(error instanceof Error ? error.message : "创建用户失败");
    }
  }

  async function toggleUserPermission(user: ReaderUser, field: "enableWebdav" | "enableLocalStore") {
    if (!api) return;
    try {
      setUsers(await api.updateUser(user.username, { [field]: !user[field] }));
      toast("用户权限已更新");
    } catch (error) {
      toast(error instanceof Error ? error.message : "权限更新失败");
    }
  }

  async function resetReaderUserPassword(user: ReaderUser) {
    if (!api) return;
    const password = window.prompt(`为 ${user.username} 设置新密码（至少 12 位）`);
    if (!password) return;
    if (password.length < 12 || password.length > 128) return toast("密码长度应为 12–128 位");
    try {
      await api.resetPassword(user.username, password);
      toast("密码已重置");
    } catch (error) {
      toast(error instanceof Error ? error.message : "密码重置失败");
    }
  }

  async function deleteReaderUser(user: ReaderUser) {
    if (!api || user.isAdmin || !window.confirm(`确定删除用户“${user.username}”及其服务器数据吗？`)) return;
    try {
      setUsers(await api.deleteUsers([user.username]));
      toast("用户已删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "用户删除失败");
    }
  }

  async function changeOwnPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const oldPassword = String(values.get("oldPassword") || "");
    const newPassword = String(values.get("newPassword") || "");
    if (newPassword.length < 12 || newPassword.length > 128) return toast("新密码长度应为 12–128 位");
    try {
      await api.changePassword(oldPassword, newPassword);
      form.reset();
      toast("密码已更新");
    } catch (error) {
      toast(error instanceof Error ? error.message : "密码修改失败");
    }
  }

  async function installApp() {
    if (!installPrompt) {
      toast("可在浏览器菜单中选择“添加到主屏幕”");
      return;
    }
    const prompt = installPrompt as Event & { prompt?: () => Promise<void> };
    await prompt.prompt?.();
    setInstallPrompt(null);
  }

  function toggleAppTheme() {
    setAppTheme(resolvedAppTheme === "dark" ? "light" : "dark");
  }

  function changeView(next: ViewName) {
    if (next === "library" && libraryTab === "admin") setLibraryTab("local");
    setView(next);
    setShowCommand(false);
  }

  function openAdmin() {
    setView("library");
    setLibraryTab("admin");
    setShowCommand(false);
    void loadUsers();
  }

  if (connection !== "connected" && connection !== "offline") {
    const waiting = connection === "checking" || connection === "authenticating";
    return (
      <main className="auth-shell">
        <div className="auth-theme-switch" aria-label="外观模式">
          <button className={appTheme === "system" ? "active" : ""} onClick={() => setAppTheme("system")}>自动</button>
          <button className={appTheme === "light" ? "active" : ""} onClick={() => setAppTheme("light")}>浅色</button>
          <button className={appTheme === "dark" ? "active" : ""} onClick={() => setAppTheme("dark")}>深色</button>
        </div>
        <section className="auth-panel">
          <div className="auth-card">
            <div className="auth-brand"><span className="brand-mark">阅</span><div><strong>Yomu</strong><small>轻阅读</small></div></div>
            <h1>{waiting ? "正在连接" : "登录"}</h1>
            {waiting ? <div className="auth-loading" role="status"><span /><p>{connection === "authenticating" ? "正在登录…" : "正在连接…"}</p></div> : <>
              <p className="auth-hint">使用管理员创建的账号</p>
              <form onSubmit={loginAccount}>
                <label>用户名<input name="username" defaultValue={profile.username || ""} autoComplete="username" minLength={5} maxLength={32} pattern="[a-z0-9]+" required autoFocus /></label>
                <label>密码<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
                <button className="primary-button full-button">登录</button>
              </form>
            </>}
            <small className="auth-footnote">无账号请联系管理员</small>
          </div>
        </section>
        {message && <div className="toast" role="status">{message}</div>}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <button className="brand" onClick={() => changeView("shelf")} aria-label="回到书架">
          <span className="brand-mark">阅</span>
          <span className="brand-copy">
            <strong>Yomu</strong>
            <small>轻阅读</small>
          </span>
        </button>

        <nav className="nav-list">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-item active" : "nav-item"}
              onClick={() => changeView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
          {adminAuthorized && <button className={view === "library" && libraryTab === "admin" ? "nav-item active" : "nav-item"} onClick={openAdmin}><span className="nav-icon" aria-hidden="true">盾</span><span>后台</span></button>}
        </nav>

        <div className="sidebar-bottom">
          <button className="sync-card" onClick={() => setShowConnect(true)}>
            <span className={`status-dot ${connection}`} />
            <span>
              <strong>{connection === "offline" ? "离线阅读" : "同步正常"}</strong>
              <small>{profile.username || "已登录"}</small>
            </span>
          </button>
          <button className="profile-button" onClick={() => setShowConnect(true)} aria-label="账户设置">
            <span>{profile.username ? firstLetter(profile.username) : "我"}</span>
            <div>
              <strong>{profile.username || "我的阅读"}</strong>
              <small>{books.length} 本书 · {sources.filter((source) => source.enabled !== false).length} 个书源</small>
            </div>
            <span aria-hidden="true">⋯</span>
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <form className="global-search" onSubmit={searchBooks}>
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索书名或作者…"
              aria-label="搜索书籍"
            />
            <kbd>⌘ K</kbd>
          </form>
          <div className="topbar-actions">
            <button className="icon-button" onClick={toggleAppTheme} aria-label={resolvedAppTheme === "dark" ? "切换浅色模式" : "切换深色模式"}>{resolvedAppTheme === "dark" ? "☀" : "☾"}</button>
            <button className="icon-button" onClick={() => setShowConnect(true)} aria-label="账户设置">{profile.username ? firstLetter(profile.username) : "我"}</button>
            <button className="primary-button" onClick={() => setView("discover")}>＋ 添加书籍</button>
          </div>
        </header>

        <div className="view-scroll">
          {view === "shelf" && (
            <div className="view-content shelf-view">
              <section className="welcome-row">
                <div>
                  <h1>{greeting}</h1>
                </div>
                <button className="quiet-button" disabled={shelfRefreshing} onClick={refreshShelf}>
                  {shelfRefreshing ? "更新中…" : "↻ 更新书架"}
                </button>
              </section>

              {primaryBook ? <section className="continue-card">
                <div className="continue-cover" style={coverStyle(primaryBook)}>
                  <span>{firstLetter(primaryBook.name)}</span>
                  <small>{primaryBook.author}</small>
                </div>
                <div className="continue-copy">
                  <p className="eyebrow">继续阅读</p>
                  <h2>{primaryBook.name}</h2>
                  <p className="continue-author">{primaryBook.author}</p>
                  <p className="continue-chapter">{primaryBook.durChapterTitle || "从第一章开始"}</p>
                  <div className="progress-row">
                    <div className="progress-track"><span style={{ width: `${progressFor(primaryBook)}%` }} /></div>
                    <small>{progressFor(primaryBook)}%</small>
                  </div>
                  <button className="read-button" onClick={() => openBook(primaryBook)}>继续阅读 <span>→</span></button>
                </div>
                <blockquote>“真正的阅读，是让一段文字在你身上多停留一会儿。”</blockquote>
              </section> : <section className="continue-card empty-library-card"><div className="continue-copy"><p className="eyebrow">书架还是空的</p><h2>从添加一本书开始</h2><p className="continue-chapter">搜索网络书源，或在资料库导入本地书。</p><button className="read-button" onClick={() => setView("discover")}>去找书 <span>→</span></button></div></section>}

              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">全部藏书</p>
                    <h2>我的书架 <span>{books.length}</span></h2>
                  </div>
                  <div className="segmented compact shelf-groups" aria-label="书架分组">
                    <button className={activeGroup === "all" ? "active" : ""} onClick={() => setActiveGroup("all")}>全部</button>
                    <button className={activeGroup === "ungrouped" ? "active" : ""} onClick={() => setActiveGroup("ungrouped")}>未分组</button>
                    {groups.filter((group) => group.groupId > 0).map((group) => (
                      <button key={group.groupId} className={activeGroup === group.groupId ? "active" : ""} onClick={() => setActiveGroup(group.groupId)}>{group.groupName}</button>
                    ))}
                  </div>
                </div>
                <div className="book-grid">
                  {shownBooks.map((book, index) => (
                    <article className="book-card" key={book.bookUrl}>
                      <button className={book.customCoverUrl || book.coverUrl ? "book-cover has-cover" : "book-cover"} style={coverStyle(book)} onClick={() => openBook(book)} aria-label={`阅读 ${book.name}`}>
                        <span className="cover-index">{String(index + 1).padStart(2, "0")}</span>
                        <strong>{book.name}</strong>
                        <small>{book.author}</small>
                      </button>
                      <button className="book-meta" onClick={() => openBook(book)}>
                        <strong>{book.name}</strong>
                        <span>{book.author}</span>
                        <small>{book.durChapterTitle || book.latestChapterTitle || "尚未开始"}</small>
                      </button>
                      <div className="mini-progress"><span style={{ width: `${progressFor(book)}%` }} /></div>
                      <div className="book-card-actions">
                        <button onClick={() => offlineDownload?.bookUrl === book.bookUrl ? offlineDownloadRef.current?.abort() : setOfflinePickerBook(book)}>{offlineDownload?.bookUrl === book.bookUrl
                          ? `${offlineDownload.done}/${offlineDownload.total || "?"}`
                          : offlineStatus[book.bookUrl]?.cachedChapters
                            && (offlineStatus[book.bookUrl].totalChapters || 0) > 0
                            && offlineStatus[book.bookUrl].cachedChapters >= (offlineStatus[book.bookUrl].totalChapters || 0)
                            ? "已缓存全部"
                            : offlineStatus[book.bookUrl]?.cachedChapters
                              ? `已缓存 ${offlineStatus[book.bookUrl].cachedChapters} 章`
                              : "缓存章节"}</button>
                        {Boolean(offlineStatus[book.bookUrl]?.cachedChapters) && <button onClick={() => removeBookOffline(book)} aria-label={`删除 ${book.name} 的本机缓存`}>×</button>}
                      </div>
                    </article>
                  ))}
                </div>
                {shownBooks.length < visibleBooks.length && <button className="load-more" onClick={() => setShelfVisibleCount((value) => value + 48)}>显示更多</button>}
              </section>
            </div>
          )}

          {view === "discover" && (
            <div className="view-content discover-view">
              <section className="page-intro split-intro">
                <div><h1>搜书</h1></div>
                {exploreAvailable && <div className="segmented"><button className={discoverMode === "search" ? "active" : ""} onClick={() => setDiscoverMode("search")}>搜索</button><button className={discoverMode === "explore" ? "active" : ""} onClick={() => { setDiscoverMode("explore"); if (!exploreResults.length) void exploreBooks("mixed"); }}>分类</button></div>}
              </section>
              {discoverMode === "search" ? <>
                <form className="hero-search" onSubmit={searchBooks}>
                  <span aria-hidden="true">⌕</span>
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入书名或作者，例如：三体" aria-label="跨书源搜索" />
                  <button disabled={searching}>{searching ? "搜索中…" : "搜索"}</button>
                </form>
                {!searchResults.length && !searching && <div className="empty-state compact"><span>输入书名或作者开始搜索</span></div>}
              </> : <div className="explore-categories">{[["mixed", "综合"], ["rank", "排行"], ["new", "新书"], ["finished", "完本"], ["fantasy", "玄幻"], ["urban", "都市"], ["history", "历史"], ["sci-fi", "科幻"], ["suspense", "悬疑"]].map(([key, label]) => <button key={key} className={exploreCategory === key ? "active" : ""} onClick={() => exploreBooks(key)}>{label}</button>)}</div>}
              <section className="search-results">
                {(discoverMode === "explore" ? exploreResults : searchResults).map((book) => (
                  <article className="result-card" key={`result-${book.bookUrl}`}>
                    <div className="result-cover" style={coverStyle(book)}>{firstLetter(book.name)}</div>
                    <div>
                      <span className="source-chip">{book.originName || "聚合结果"}</span>
                      <h2>{book.name}</h2>
                      <p>{book.author} · {book.kind || "网络文学"}</p>
                      <small>{book.latestChapterTitle || "目录可用"}</small>
                    </div>
                    <button className="quiet-button" onClick={() => addBook(book)}>加入书架</button>
                  </article>
                ))}
              </section>
              {discoverMode === "explore" && exploreHasMore && <button className="load-more" disabled={searching} onClick={() => exploreBooks(exploreCategory, true)}>{searching ? "正在加载…" : "继续探索"}</button>}
            </div>
          )}

          {view === "sources" && (
            <div className="view-content sources-view">
              <section className="page-intro split-intro">
                <div>
                  <h1>书源管理</h1>
                </div>
                <div className="intro-actions">
                  <input ref={sourceFileRef} type="file" accept="application/json,.json" hidden onChange={importSources} />
                  <button className="quiet-button" onClick={() => sourceFileRef.current?.click()}>导入 JSON</button>
                  <button className="quiet-button" onClick={() => downloadJson("yomu-book-sources.json", sources)}>导出</button>
                  <button className="quiet-button" disabled={libraryBusy} onClick={testVisibleSources}>{libraryBusy ? "检测中…" : "检测"}</button>
                  <button className="primary-button" aria-label="新建书源" onClick={() => { setSourceEditor(null); setShowSourceEditor(true); }}>＋ 新建</button>
                </div>
              </section>
              <div className="source-summary-grid">
                <div><strong>{sources.length}</strong><span>全部书源</span></div>
                <div><strong>{sources.filter((source) => source.enabled !== false).length}</strong><span>已启用</span></div>
                <div><strong>{sources.filter((source) => source.loginUrl || source.enabledCookieJar).length}</strong><span>兼容模式</span></div>
              </div>
              <div className="source-toolbar">
                <div className="segmented">
                  <button className={sourceFilter === "all" ? "active" : ""} onClick={() => setSourceFilter("all")}>全部</button>
                  <button className={sourceFilter === "enabled" ? "active" : ""} onClick={() => setSourceFilter("enabled")}>已启用</button>
                  <button className={sourceFilter === "compatibility" ? "active" : ""} onClick={() => setSourceFilter("compatibility")}>兼容模式</button>
                  <button className={sourceFilter === "invalid" ? "active" : ""} onClick={() => setSourceFilter("invalid")}>失效</button>
                </div>
                <div className="source-tools"><input value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} placeholder="筛选名称、地址或分组" aria-label="筛选书源" /><select value={sourceSort} onChange={(event) => setSourceSort(event.target.value as typeof sourceSort)} aria-label="书源排序"><option value="order">自定义顺序</option><option value="name">按名称</option><option value="latency">按响应时间</option></select><button onClick={() => batchToggleSources(true)}>全部启用</button><button onClick={() => batchToggleSources(false)}>全部停用</button>{sourceFilter === "invalid" && <button className="danger-text" onClick={deleteInvalidSources}>删除失效</button>}<span>{filteredSources.length} 个结果</span></div>
              </div>
              <div className="source-list">
                {filteredSources.map((source) => (
                  <article className="source-row" key={source.bookSourceUrl}>
                    <button className={`source-toggle ${source.enabled === false ? "off" : ""}`} onClick={() => toggleSource(source)} aria-label={source.enabled === false ? `启用 ${source.bookSourceName}` : `停用 ${source.bookSourceName}`}><span /></button>
                    <div className="source-main">
                      <strong>{source.bookSourceName}</strong>
                      <small>{source.bookSourceUrl}</small>
                    </div>
                    <span className="source-group">{source.bookSourceGroup || "未分组"}</span>
                    <span className="runtime-badge">
                      {source.loginUrl ? "登录 / WebView" : source.enabledCookieJar ? "Cookie Jar" : "HTTP 规则"}
                    </span>
                    <span className="latency">{source.respondTime ? `${source.respondTime} ms` : "待检测"}</span>
                    <span className="source-order-actions"><button onClick={() => moveSource(source, -1)} aria-label={`${source.bookSourceName}上移`}>↑</button><button onClick={() => moveSource(source, 1)} aria-label={`${source.bookSourceName}下移`}>↓</button></span>
                    <button className="more-button" onClick={() => { setSourceEditor(source); setShowSourceEditor(true); }} aria-label={`编辑 ${source.bookSourceName}`}>编辑</button>
                    <button className="more-button danger-text" onClick={() => void deleteSource(source)} aria-label={`删除 ${source.bookSourceName}`}>删除</button>
                  </article>
                ))}
              </div>
            </div>
          )}

          {view === "library" && (
            <div className="view-content library-view">
              <section className="page-intro split-intro">
                <div>
                  <h1>{libraryTab === "admin" ? "后台管理" : "资料库"}</h1>
                </div>
                <input ref={localBookRef} type="file" accept=".txt,.epub,.mobi,.pdf,text/plain,application/epub+zip,application/pdf" hidden onChange={uploadLocalBook} />
                {libraryTab !== "admin" && <button className="primary-button" disabled={libraryBusy} onClick={() => localBookRef.current?.click()}>{libraryBusy ? "处理中…" : "＋ 导入本地书"}</button>}
              </section>
              {libraryTab !== "admin" && <div className="tool-grid">
                <button className={libraryTab === "local" ? "tool-card active" : "tool-card"} onClick={() => setLibraryTab("local") }>
                  <span className="tool-icon">Aa</span><strong>本地书仓</strong><small>TXT · EPUB · MOBI · PDF</small><em>{books.filter((book) => book.local || book.origin?.startsWith("local")).length} 本</em>
                </button>
                <button className={libraryTab === "bookmarks" ? "tool-card active" : "tool-card"} onClick={() => setLibraryTab("bookmarks") }>
                  <span className="tool-icon">签</span><strong>书签</strong><small>同步阅读位置</small><em>{bookmarks.length} 条</em>
                </button>
                <button className={libraryTab === "rss" ? "tool-card active" : "tool-card"} onClick={() => setLibraryTab("rss") }>
                  <span className="tool-icon">R</span><strong>RSS 订阅</strong><small>订阅源与文章</small><em>{rssSources.length} 个</em>
                </button>
                <button className={libraryTab === "rules" ? "tool-card active" : "tool-card"} onClick={() => setLibraryTab("rules") }>
                  <span className="tool-icon">净</span><strong>正文净化</strong><small>替换、正则与作用域</small><em>{replaceRules.filter((rule) => rule.isEnabled).length} 条启用</em>
                </button>
                <button className={libraryTab === "backup" ? "tool-card active" : "tool-card"} onClick={() => { setLibraryTab("backup"); void loadWebdavFiles(); } }>
                  <span className="tool-icon">存</span><strong>备份与缓存</strong><small>WebDAV · 离线章节 · 整本缓存</small><em>{webdavFiles.length} 个文件</em>
                </button>
              </div>}

              {libraryTab === "local" && (
                <section className="library-panel">
                  <div className="panel-heading"><div><h2>本地书与分组</h2></div></div>
                  <form className="inline-create" onSubmit={createBookGroup}><input name="groupName" placeholder="新分组名称" aria-label="新分组名称" /><button className="quiet-button">创建分组</button></form>
                  <div className="group-chip-row"><span>分组：</span>{groups.length ? groups.map((group) => <span className="managed-group" key={group.groupId}><button onClick={() => { setActiveGroup(group.groupId); setView("shelf"); }}>{group.groupName}</button><button className="danger-text" onClick={() => removeBookGroup(group)} aria-label={`删除分组 ${group.groupName}`}>×</button></span>) : <small>尚未创建分组</small>}</div>
                  <div className="library-list">
                    {books.map((book) => (
                      <article className="library-row" key={`library-${book.bookUrl}`}>
                        <span className="tiny-cover" style={coverStyle(book)}>{firstLetter(book.name)}</span>
                        <div><strong>{book.name}</strong><small>{book.author} · {book.local || book.origin?.startsWith("local") ? "本地文件" : book.originName || "网络书籍"}</small></div>
                        <select value={book.group || 0} onChange={(event) => moveBookToGroup(book, Number(event.target.value))} aria-label={`移动 ${book.name} 到分组`}><option value="0">未分组</option>{groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.groupName}</option>)}</select>
                        <div className="row-actions"><button className="text-button" onClick={() => openBook(book)}>阅读</button>{(book.local || book.bookUrl.startsWith("local-")) && <button className="text-button" onClick={() => exportLocalBook(book)}>导出</button>}<button className="text-button danger-text" onClick={() => removeBook(book)}>删除</button></div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {libraryTab === "bookmarks" && (
                <section className="library-panel">
                  <div className="panel-heading"><div><p className="eyebrow">跨端同步</p><h2>书签记录</h2></div><span>阅读器顶部的书签按钮只记录当前章节和位置。</span></div>
                  <div className="library-list">
                    {bookmarks.length ? bookmarks.map((bookmark, index) => (
                      <article className="library-row bookmark-row" key={`${bookmark.bookName}-${bookmark.chapterIndex}-${index}`}>
                        <span className="bookmark-mark">⌑</span>
                        <div><strong>{bookmark.bookName} · {bookmark.chapterName}</strong><small>{bookmark.bookAuthor}{bookmark.bookText ? ` · ${bookmark.bookText.slice(0, 62)}` : ""}</small></div>
                        <div className="row-actions"><button className="text-button" onClick={() => openBookmark(bookmark)}>打开</button><button className="text-button danger-text" onClick={() => removeBookmark(bookmark)}>删除</button></div>
                      </article>
                    )) : <div className="empty-state"><strong>还没有书签</strong><span>读到想留下来的地方，点一下阅读器里的“书签”。</span></div>}
                  </div>
                </section>
              )}

              {libraryTab === "rss" && (
                <section className="library-panel rss-panel">
                  <div className="panel-heading"><div><p className="eyebrow">文章订阅</p><h2>RSS 阅读</h2></div><div className="panel-actions"><input ref={rssFileRef} type="file" accept="application/json,.json" hidden onChange={importRssSources} /><button className="quiet-button" onClick={() => rssFileRef.current?.click()}>导入完整规则</button><button className="quiet-button" onClick={() => downloadJson("yomu-rss-sources.json", rssSources)}>导出</button></div></div>
                  <form className="resource-form" onSubmit={saveRssSource}>
                    <input name="sourceName" placeholder="订阅名称" aria-label="订阅名称" required />
                    <input name="sourceUrl" type="url" placeholder="https://example.com/feed.xml" aria-label="订阅地址" required />
                    <input name="sourceGroup" placeholder="分组（可选）" aria-label="订阅分组" />
                    <button className="quiet-button">添加订阅</button>
                  </form>
                  <div className="rss-layout">
                    <aside className="rss-sources">
                      {rssSources.length ? rssSources.map((source) => (
                        <div className={selectedRssSource?.sourceUrl === source.sourceUrl ? "rss-source active" : "rss-source"} key={source.sourceUrl}>
                          <button onClick={() => selectRssSource(source)}><strong>{source.sourceName}</strong><small>{source.sourceGroup || source.sourceUrl}</small></button>
                          <button className="danger-text" onClick={() => deleteRssSource(source)} aria-label={`删除 ${source.sourceName}`}>×</button>
                        </div>
                      )) : <div className="empty-state compact"><strong>还没有订阅</strong><span>在上方添加一个 RSS / Atom 地址。</span></div>}
                    </aside>
                    <div className="rss-articles">
                      {libraryBusy ? <div className="empty-state"><strong>正在刷新订阅…</strong></div> : rssArticles.length ? rssArticles.map((article) => (
                        <button key={`${article.link}-${article.order}`} onClick={() => openRssArticle(article)}><small>{article.pubDate ? new Date(article.pubDate).toLocaleDateString("zh-CN") : selectedRssSource?.sourceName}</small><strong>{article.title}</strong><span>{plainText(article.description || article.content || "").slice(0, 100)}</span></button>
                      )) : <div className="empty-state"><strong>{selectedRssSource ? "这个订阅暂时没有文章" : "选择一个订阅"}</strong><span>文章列表会显示在这里。</span></div>}
                    </div>
                  </div>
                </section>
              )}

              {libraryTab === "rules" && (
                <section className="library-panel">
                  <div className="panel-heading"><div><h2>替换与净化规则</h2></div></div>
                  <form className="resource-form rule-form" onSubmit={saveReplaceRule}>
                    <input name="name" placeholder="规则名称" required />
                    <input name="pattern" placeholder="匹配内容 / 正则" required />
                    <input name="replacement" placeholder="替换为（可留空）" />
                    <input name="scope" placeholder="作用域（书名或 URL，可选）" />
                    <label className="check-label"><input name="isRegex" type="checkbox" /> 正则</label>
                    <button className="quiet-button">添加规则</button>
                  </form>
                  <div className="library-list">
                    {replaceRules.length ? replaceRules.map((rule) => (
                      <article className="library-row rule-row" key={rule.name}>
                        <button className={`source-toggle ${rule.isEnabled ? "" : "off"}`} onClick={() => toggleReplaceRule(rule)} aria-label={rule.isEnabled ? `停用 ${rule.name}` : `启用 ${rule.name}`}><span /></button>
                        <div><strong>{rule.name}</strong><small>{rule.isRegex ? "正则" : "文本"} · {rule.pattern} → {rule.replacement || "删除"}{rule.scope ? ` · ${rule.scope}` : ""}</small></div>
                        <button className="text-button danger-text" onClick={() => deleteReplaceRule(rule)}>删除</button>
                      </article>
                    )) : <div className="empty-state"><strong>没有净化规则</strong><span>例如去除段尾广告或统一错别字。</span></div>}
                  </div>
                </section>
              )}

              {libraryTab === "backup" && (
                <section className="library-panel">
                  <div className="panel-heading"><div><h2>备份与离线</h2></div></div>
                  <input ref={webdavFileRef} type="file" hidden onChange={uploadWebdavFile} />
                  <input ref={backupFileRef} type="file" accept="application/json,.json" hidden onChange={restoreBackup} />
                  <div className="maintenance-actions"><button className="quiet-button" onClick={() => webdavFileRef.current?.click()}>上传 WebDAV 文件</button><button className="quiet-button" onClick={loadWebdavFiles}>刷新文件</button><button className="quiet-button" onClick={downloadFullBackup}>下载完整配置备份</button><button className="quiet-button" onClick={() => backupFileRef.current?.click()}>从配置备份恢复</button><button className="quiet-button danger-text" onClick={clearAllOfflineChapters}>清理本机离线章节</button></div>
                  <div className="library-list">
                    {webdavFiles.length ? webdavFiles.map((file) => (
                      <article className="library-row backup-row" key={file.path}><span className="bookmark-mark">{file.isDirectory ? "◇" : "↥"}</span><div><strong>{file.name}</strong><small>{file.isDirectory ? "文件夹" : `${Math.max(1, Math.round(file.size / 1024))} KB`} · {new Date(file.lastModified).toLocaleString("zh-CN")}</small></div><div className="row-actions">{!file.isDirectory && <button className="text-button" onClick={() => downloadWebdavFile(file)}>下载</button>}<button className="text-button danger-text" onClick={() => deleteWebdavFile(file)}>删除</button></div></article>
                    )) : <div className="empty-state"><strong>没有 WebDAV 文件，或账号未启用权限</strong><span>管理员可以在“账户与安全”中为当前用户开启 WebDAV。</span></div>}
                  </div>
                  <div className="cache-book-grid">
                    {books.map((book) => {
                      const status = offlineStatus[book.bookUrl];
                      const downloading = offlineDownload?.bookUrl === book.bookUrl;
                      return <article className="cache-book-row" key={`cache-${book.bookUrl}`}><span className="tiny-cover" style={coverStyle(book)}>{firstLetter(book.name)}</span><div><strong>{book.name}</strong><small>{status?.cachedChapters ? `本机已缓存 ${status.cachedChapters}/${status.totalChapters || "?"} 章` : "尚未缓存章节"}</small></div><div className="cache-actions"><button onClick={() => downloading ? offlineDownloadRef.current?.abort() : setOfflinePickerBook(book)}>{downloading ? `停止 ${offlineDownload.done}/${offlineDownload.total || "?"}` : "缓存章节"}</button>{Boolean(status?.cachedChapters) && <button className="danger-text" onClick={() => removeBookOffline(book)}>删除缓存</button>}</div></article>;
                    })}
                  </div>
                </section>
              )}

              {libraryTab === "admin" && (
                <section className="library-panel">
                  <div className="panel-heading"><div><p className="eyebrow">账户安全</p><h2>{adminAuthorized ? "用户与权限" : "密码与登录会话"}</h2></div><span>{adminAuthorized ? "新账号仅能由管理员创建。" : "公开注册已关闭；如需新账号请联系管理员。"}</span></div>
                  {adminAuthorized && <>
                    <form className="resource-form admin-user-form" onSubmit={addReaderUser}><input name="username" placeholder="新用户名（小写字母或数字）" minLength={5} maxLength={32} pattern="[a-z0-9]+" required /><input name="password" type="password" minLength={12} maxLength={128} placeholder="初始密码（至少 12 位）" autoComplete="new-password" required /><button className="quiet-button">创建用户</button></form>
                    <div className="library-list">
                      {users.map((user) => <article className="library-row user-row" key={user.username}><span className="bookmark-mark">{firstLetter(user.username)}</span><div><strong>{user.username}{user.isAdmin ? " · 管理员" : ""}</strong><small>最近登录：{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("zh-CN") : "从未"}</small></div><label><input type="checkbox" checked={user.enableLocalStore} onChange={() => toggleUserPermission(user, "enableLocalStore")} /> 本地书</label><label><input type="checkbox" checked={user.enableWebdav} onChange={() => toggleUserPermission(user, "enableWebdav")} /> WebDAV</label><div className="row-actions"><button className="text-button" onClick={() => resetReaderUserPassword(user)}>重置密码</button>{!user.isAdmin && <button className="text-button danger-text" onClick={() => deleteReaderUser(user)}>删除</button>}</div></article>)}
                    </div>
                  </>}
                  <form className="resource-form password-form" onSubmit={changeOwnPassword}><input name="oldPassword" type="password" autoComplete="current-password" placeholder="当前密码" required /><input name="newPassword" type="password" minLength={12} maxLength={128} autoComplete="new-password" placeholder="新密码（至少 12 位）" required /><button className="quiet-button">修改我的密码</button></form>
                </section>
              )}

            </div>
          )}
        </div>
      </section>

      <nav className={adminAuthorized ? "mobile-nav has-admin" : "mobile-nav"} aria-label="移动端导航">
        {navigation.map((item) => (
          <button key={`mobile-${item.id}`} className={view === item.id ? "active" : ""} onClick={() => changeView(item.id)}>
            <span>{item.icon}</span><small>{item.label}</small>
          </button>
        ))}
        {adminAuthorized && <button className={view === "library" && libraryTab === "admin" ? "active" : ""} onClick={openAdmin}><span>盾</span><small>后台</small></button>}
      </nav>

      {offlinePickerBook && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOfflinePickerBook(null)}>
          <section className="modal offline-picker" role="dialog" aria-modal="true" aria-labelledby="offline-picker-title">
            <button className="modal-close" onClick={() => setOfflinePickerBook(null)} aria-label="关闭">×</button>
            <p className="eyebrow">离线缓存</p>
            <h2 id="offline-picker-title">缓存《{offlinePickerBook.name}》</h2>
            <p>从当前阅读位置开始缓存。完成后无需切换模式，断网时会自动读取本机章节。</p>
            <div className="offline-options">
              {([10, 50, 100, "all"] as const).map((amount) => <button key={amount} onClick={() => { const book = offlinePickerBook; setOfflinePickerBook(null); void downloadBookOffline(book, amount); }}>{amount === "all" ? "全部" : `${amount} 章`}</button>)}
            </div>
          </section>
        </div>
      )}

      {showConnect && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowConnect(false)}>
          <section className="modal connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
            <button className="modal-close" onClick={() => setShowConnect(false)} aria-label="关闭">×</button>
            <h2 id="connect-title">{profile.username || "我的阅读"}</h2>
            <div className="account-setting"><span>外观</span><div className="segmented"><button className={appTheme === "system" ? "active" : ""} onClick={() => setAppTheme("system")}>自动</button><button className={appTheme === "light" ? "active" : ""} onClick={() => setAppTheme("light")}>浅色</button><button className={appTheme === "dark" ? "active" : ""} onClick={() => setAppTheme("dark")}>深色</button></div></div>
            <div className="account-setting"><span>分类发现</span><div className="segmented"><button className={!exploreEnabled ? "active" : ""} onClick={() => setExploreEnabled(false)}>关闭</button><button className={exploreEnabled ? "active" : ""} onClick={() => setExploreEnabled(true)} disabled={!hasExploreSources}>开启</button></div></div>
            <button className="quiet-button full-button" onClick={installApp}>安装到设备</button>
            <button className="quiet-button full-button" onClick={() => { setShowConnect(false); setView("library"); setLibraryTab("admin"); }}>修改密码与账户设置</button>
            <button className="text-button danger-text full-button" onClick={logoutAccount}>退出登录</button>
          </section>
        </div>
      )}

      {showCommand && (
        <div className="modal-backdrop command-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowCommand(false)}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="快捷操作">
            <div><span>⌕</span><input autoFocus placeholder="搜索或输入命令…" onChange={(event) => setQuery(event.target.value)} /></div>
            <small>快速前往</small>
            {navigation.map((item) => <button key={`command-${item.id}`} onClick={() => changeView(item.id)}><span>{item.icon}</span>{item.label}<kbd>↵</kbd></button>)}
          </section>
        </div>
      )}

      {showSourceEditor && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowSourceEditor(false)}>
          <section className="modal source-editor-modal" role="dialog" aria-modal="true" aria-labelledby="source-editor-title">
            <button className="modal-close" onClick={() => setShowSourceEditor(false)} aria-label="关闭">×</button>
            <p className="eyebrow">Reader / Legado</p>
            <h2 id="source-editor-title">{sourceEditor ? "编辑书源" : "新建书源"}</h2>
            <form onSubmit={saveSource}>
              <label>书源名称<input name="bookSourceName" defaultValue={sourceEditor?.bookSourceName || ""} required /></label>
              <label>唯一地址<input name="bookSourceUrl" defaultValue={sourceEditor?.bookSourceUrl || ""} placeholder="https://example.com" required /></label>
              <div className="form-row">
                <label>分组<input name="bookSourceGroup" defaultValue={sourceEditor?.bookSourceGroup || ""} /></label>
                <label>类型<select name="bookSourceType" defaultValue={sourceEditor?.bookSourceType || 0}><option value="0">文字</option><option value="1">音频</option><option value="2">图片</option></select></label>
              </div>
              <div className="form-row">
                <label>搜索地址<input name="searchUrl" defaultValue={sourceEditor?.searchUrl || ""} /></label>
                <label>发现地址<input name="exploreUrl" defaultValue={sourceEditor?.exploreUrl || ""} /></label>
              </div>
              <div className="form-row">
                <label>登录地址<input name="loginUrl" defaultValue={sourceEditor?.loginUrl || ""} /></label>
                <label>并发限制<input name="concurrentRate" defaultValue={sourceEditor?.concurrentRate || ""} /></label>
              </div>
              <div className="check-row">
                <label><input name="enabled" type="checkbox" defaultChecked={sourceEditor?.enabled !== false} /> 启用书源</label>
                <label><input name="enabledExplore" type="checkbox" defaultChecked={sourceEditor?.enabledExplore !== false} /> 启用发现</label>
                <label><input name="enabledCookieJar" type="checkbox" defaultChecked={sourceEditor?.enabledCookieJar || false} /> 独立 Cookie Jar</label>
              </div>
              <details className="source-rule-editor"><summary>请求设置</summary><div className="rule-field-grid"><label>详情地址匹配<input name="bookUrlPattern" defaultValue={sourceEditor?.bookUrlPattern || ""} /></label><label className="wide-field">请求头<textarea name="header" rows={3} defaultValue={sourceEditor?.header || ""} spellCheck={false} /></label></div></details>
              {sourceRuleSections.map((section) => <details className="source-rule-editor" key={section.key}><summary>{section.label}</summary><div className="rule-field-grid">{section.fields.map(([field, label]) => <label key={`${section.key}-${field}`}>{label}<textarea name={`${section.key}.${field}`} rows={2} defaultValue={sourceEditor?.[section.key]?.[field] || ""} spellCheck={false} /></label>)}</div></details>)}
              <details className="raw-source-editor"><summary>完整 JSON</summary><textarea name="rawJson" rows={12} defaultValue={sourceEditor ? JSON.stringify(sourceEditor, null, 2) : ""} spellCheck={false} /></details>
              <button className="primary-button full-button">保存书源</button>
              {sourceEditor?.loginUrl && <button className="quiet-button full-button" type="button" onClick={() => openSourceLogin(sourceEditor)}>打开书源登录页</button>}
              {sourceEditor && <button className="text-button danger-text" type="button" onClick={deleteEditedSource}>删除这个书源</button>}
            </form>
            {sourceEditor && <form className="source-debug" onSubmit={debugEditedSource}><div><input name="keyword" placeholder="输入关键词测试搜索规则" aria-label="书源调试关键词" /><button className="quiet-button" disabled={sourceDebugging}>{sourceDebugging ? "调试中…" : "运行调试"}</button></div>{sourceDebugLog.length > 0 && <pre>{sourceDebugLog.join("\n")}</pre>}</form>}
          </section>
        </div>
      )}

      {reader && (
        <section ref={readerOverlayRef} className={`reader-overlay reader-mode-${preferences.pageMode} reader-theme-${resolvedReaderTheme} ${readerChrome ? "" : "chrome-hidden"}`} onTouchStart={handleReaderTouchStart} onTouchEnd={handleReaderTouchEnd} style={{ "--reader-font-size": `${preferences.fontSize}px`, "--reader-line-height": preferences.lineHeight, "--reader-width": `${preferences.contentWidth}px` } as CSSProperties}>
          <div ref={readerTopRef} />
          <header className="reader-bar">
            <button onClick={() => { window.speechSynthesis?.cancel(); setSpeaking(false); setAutoReading(false); setReader(null); }} aria-label="退出阅读">←</button>
            <div><strong>{reader.book.name}</strong><small>{currentChapter?.title}</small></div>
            <div className="reader-actions"><button onClick={saveCurrentBookmark}>书签</button>{readerSourceType === 0 && <button onClick={toggleSpeech}>{speaking ? "停止" : "朗读"}</button>}{readerSourceType !== 1 && <button onClick={() => setAutoReading((value) => !value)}>{autoReading ? "停止" : "自动"}</button>}<button onClick={() => void loadAvailableSources(false)}>换源</button>{readerSourceType === 0 && <button onClick={() => setShowChapterSearch(true)}>查找</button>}<button onClick={() => setShowCatalog(true)}>目录</button><button onClick={() => setShowReaderSettings(true)}>Aa</button></div>
          </header>
          <article ref={readingPaperRef} className={`reading-paper font-${preferences.fontFamily} page-${preferences.pageMode} ${readerSourceType === 1 ? "reader-audio" : readerSourceType === 2 ? "reader-comic" : ""}`} onClick={handleReaderTap}>
            <p className="chapter-kicker">第 {reader.chapterIndex + 1} / {reader.chapters.length} 章</p>
            <h1>{currentChapter?.title}</h1>
            <p className="chapter-book">{reader.book.name} · {reader.book.author}</p>
            {reader.loading ? <div className="reader-loading"><span /><span /><span /><p>正在整理书页…</p></div>
              : readerError ? <div className="reader-error-state"><strong>这一页暂时没有打开</strong><p>{readerError}</p><div><button onClick={() => reader.chapters.length ? void loadChapter(reader.chapterIndex) : void openBook(reader.book)}>重试</button><button onClick={() => void loadAvailableSources(false)}>查找可用书源</button>{reader.chapters.length === 0 && <button onClick={() => void api.getChapterList(reader.book, true).then((chapters) => { setReader((current) => current ? { ...current, chapters } : current); setReaderError(""); }).catch((error) => setReaderError(error instanceof Error ? error.message : "目录刷新失败"))}>刷新目录</button>}</div></div>
              : readerSourceType === 1 && readerMediaUrls.length ? <div className="reader-audio-list">{readerMediaUrls.map((url, index) => <section key={url}><strong>{currentChapter?.title}{readerMediaUrls.length > 1 ? ` · ${index + 1}` : ""}</strong><audio controls preload="metadata" src={api.getBookResourceUrl(reader.book, url)} /></section>)}</div>
                : readerSourceType === 2 && readerMediaUrls.length ? <div className="reader-comic-list">{readerMediaUrls.map((url, index) => <ComicImage key={url} src={api.getBookResourceUrl(reader.book, url)} alt={`${currentChapter?.title || "本章"} ${index + 1}`} />)}</div>
                  : readingContent.split(/\n{2,}/).map((paragraph, index) => <p key={`${reader.chapterIndex}-${index}`}>{highlightedText(paragraph, chapterQuery)}</p>)}
            <footer className="chapter-footer">
              <button onClick={() => changePageOrChapter(-1)} disabled={reader.chapterIndex === 0}>← 上一章</button>
              <span>{reader.chapters.length ? Math.round(((reader.chapterIndex + 1) / reader.chapters.length) * 100) : 0}%</span>
              <button onClick={() => changePageOrChapter(1)} disabled={reader.chapterIndex === reader.chapters.length - 1}>下一章 →</button>
            </footer>
          </article>
          <div className="reader-progress"><span style={{ width: `${reader.chapters.length ? ((reader.chapterIndex + 1) / reader.chapters.length) * 100 : 0}%` }} /></div>

          {showCatalog && (
            <aside className="reader-drawer catalog-drawer">
              <header><div><p className="eyebrow">目录</p><h2>{reader.book.name}</h2></div><button onClick={() => setShowCatalog(false)}>×</button></header>
              <div className="catalog-list">{reader.chapters.map((chapter) => <button ref={chapter.index === reader.chapterIndex ? activeCatalogChapterRef : undefined} key={`${chapter.index}-${chapter.url}`} className={chapter.index === reader.chapterIndex ? "active" : ""} onClick={() => loadChapter(chapter.index)}><span>{String(chapter.index + 1).padStart(2, "0")}</span>{chapter.title}</button>)}</div>
            </aside>
          )}
          {showReaderSettings && (
            <aside className="reader-drawer settings-drawer">
              <header><div><p className="eyebrow">阅读设置</p><h2>排版与主题</h2></div><button onClick={() => setShowReaderSettings(false)}>×</button></header>
              <label>字号 <output>{preferences.fontSize}px</output><input type="range" min="15" max="28" value={preferences.fontSize} onChange={(event) => setPreferences((current) => ({ ...current, fontSize: Number(event.target.value) }))} /></label>
              <label>行高 <output>{preferences.lineHeight.toFixed(1)}</output><input type="range" min="1.4" max="2.4" step="0.1" value={preferences.lineHeight} onChange={(event) => setPreferences((current) => ({ ...current, lineHeight: Number(event.target.value) }))} /></label>
              <label>版心宽度 <output>{preferences.contentWidth}px</output><input type="range" min="560" max="920" step="20" value={preferences.contentWidth} onChange={(event) => setPreferences((current) => ({ ...current, contentWidth: Number(event.target.value) }))} /></label>
              <div className="setting-group"><span>字体</span><div className="segmented"><button className={preferences.fontFamily === "serif" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, fontFamily: "serif" }))}>宋体</button><button className={preferences.fontFamily === "sans" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, fontFamily: "sans" }))}>黑体</button></div></div>
              <div className="setting-group"><span>翻页</span><div className="segmented"><button className={preferences.pageMode === "scroll" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, pageMode: "scroll" }))}>上下滚动</button><button className={preferences.pageMode === "paged" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, pageMode: "paged" }))}>左右翻页</button></div></div>
              <div className="setting-group"><span>文字</span><div className="segmented"><button className={preferences.chineseMode === "original" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, chineseMode: "original" }))}>原文</button><button className={preferences.chineseMode === "simplified" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, chineseMode: "simplified" }))}>简体</button><button className={preferences.chineseMode === "traditional" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, chineseMode: "traditional" }))}>繁体</button></div></div>
              <div className="setting-group"><span>主题</span><div className="theme-picks"><button className={preferences.theme === "system" ? "active system" : "system"} onClick={() => setPreferences((current) => ({ ...current, theme: "system" }))}>自动</button><button className={preferences.theme === "paper" ? "active paper" : "paper"} onClick={() => setPreferences((current) => ({ ...current, theme: "paper" }))}>纸张</button><button className={preferences.theme === "green" ? "active green" : "green"} onClick={() => setPreferences((current) => ({ ...current, theme: "green" }))}>护眼</button><button className={preferences.theme === "night" ? "active night" : "night"} onClick={() => setPreferences((current) => ({ ...current, theme: "night" }))}>夜间</button></div></div>
            </aside>
          )}
          {showSourceSwitch && (
            <aside className="reader-drawer source-switch-drawer">
              <header><div><p className="eyebrow">换源</p><h2>同名书籍的可用来源</h2></div><div className="drawer-header-actions">{sourceCandidateHasMore && <button disabled={sourceSwitching} onClick={() => void loadAvailableSources(false, true)}>继续查找</button>}<button disabled={sourceSwitching} onClick={() => void loadAvailableSources(true)}>重新搜索</button><button onClick={() => { sourceSwitchAbortRef.current?.abort(); setSourceSwitching(false); setShowSourceSwitch(false); }}>×</button></div></header>
              <p className="drawer-note">会保留当前阅读进度，并重新获取目录和正文。</p>
              <div className="candidate-list">
                {sourceCandidates.length ? sourceCandidates.map((candidate, index) => (
                  <button key={`${candidate.bookUrl}-${index}`} onClick={() => switchBookSource(candidate)}><span>{index + 1}</span><div><strong>{sourceNameFor(candidate)}</strong><small>{candidate.latestChapterTitle || candidate.bookUrl}</small></div><i>切换</i></button>
                )) : sourceSwitching ? <div className="empty-state"><strong>正在用 4 路并发检测书源…</strong><span>找到结果会立即显示，不必等待全部书源。</span></div> : <div className="empty-state"><strong>没有找到可用来源</strong><span>可以检查书源状态或重新搜索。</span></div>}
              </div>
            </aside>
          )}
          {showChapterSearch && (
            <aside className="reader-drawer search-drawer"><header><div><p className="eyebrow">章节内查找</p><h2>{chapterMatchCount ? `${chapterMatchCount} 处匹配` : "查找正文"}</h2></div><button onClick={() => setShowChapterSearch(false)}>×</button></header><input autoFocus value={chapterQuery} onChange={(event) => setChapterQuery(event.target.value)} placeholder="输入要查找的文字" /><p className="drawer-note">匹配内容会在当前章节中高亮；切换章节后可继续使用同一关键词。</p></aside>
          )}
          {(showCatalog || showReaderSettings || showSourceSwitch || showChapterSearch) && <button className="drawer-scrim" aria-label="关闭侧栏" onClick={() => { setShowCatalog(false); setShowReaderSettings(false); setShowSourceSwitch(false); setShowChapterSearch(false); }} />}
        </section>
      )}

      {articleSession && (
        <section className={`reader-overlay article-overlay reader-theme-${resolvedReaderTheme}`} style={{ "--reader-font-size": `${preferences.fontSize}px`, "--reader-line-height": preferences.lineHeight, "--reader-width": `${preferences.contentWidth}px` } as CSSProperties}>
          <header className="reader-bar"><button onClick={() => setArticleSession(null)} aria-label="退出文章阅读">←</button><div><strong>{selectedRssSource?.sourceName || "RSS 阅读"}</strong><small>{articleSession.article.pubDate || articleSession.article.origin}</small></div><div className="reader-actions"><a href={articleSession.article.link} target="_blank" rel="noreferrer">原文</a><button onClick={() => setShowReaderSettings(true)}>Aa</button></div></header>
          <article className={`reading-paper font-${preferences.fontFamily}`}><p className="chapter-kicker">RSS · {selectedRssSource?.sourceName}</p><h1>{articleSession.article.title}</h1>{articleSession.loading ? <div className="reader-loading"><span /><span /><span /><p>正在整理文章…</p></div> : articleSession.content.split(/\n{2,}/).map((paragraph, index) => <p key={`article-${index}`}>{paragraph}</p>)}</article>
          {showReaderSettings && (
            <aside className="reader-drawer settings-drawer">
              <header><div><p className="eyebrow">文章设置</p><h2>排版与主题</h2></div><button onClick={() => setShowReaderSettings(false)}>×</button></header>
              <label>字号 <output>{preferences.fontSize}px</output><input type="range" min="15" max="28" value={preferences.fontSize} onChange={(event) => setPreferences((current) => ({ ...current, fontSize: Number(event.target.value) }))} /></label>
              <label>行高 <output>{preferences.lineHeight.toFixed(1)}</output><input type="range" min="1.4" max="2.4" step="0.1" value={preferences.lineHeight} onChange={(event) => setPreferences((current) => ({ ...current, lineHeight: Number(event.target.value) }))} /></label>
              <div className="setting-group"><span>字体</span><div className="segmented"><button className={preferences.fontFamily === "serif" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, fontFamily: "serif" }))}>宋体</button><button className={preferences.fontFamily === "sans" ? "active" : ""} onClick={() => setPreferences((current) => ({ ...current, fontFamily: "sans" }))}>黑体</button></div></div>
              <div className="setting-group"><span>主题</span><div className="theme-picks"><button className={preferences.theme === "system" ? "active system" : "system"} onClick={() => setPreferences((current) => ({ ...current, theme: "system" }))}>自动</button><button className={preferences.theme === "paper" ? "active paper" : "paper"} onClick={() => setPreferences((current) => ({ ...current, theme: "paper" }))}>纸张</button><button className={preferences.theme === "green" ? "active green" : "green"} onClick={() => setPreferences((current) => ({ ...current, theme: "green" }))}>护眼</button><button className={preferences.theme === "night" ? "active night" : "night"} onClick={() => setPreferences((current) => ({ ...current, theme: "night" }))}>夜间</button></div></div>
            </aside>
          )}
          {showReaderSettings && <button className="drawer-scrim" aria-label="关闭文章设置" onClick={() => setShowReaderSettings(false)} />}
        </section>
      )}

      {message && <div className="toast" role="status">{message}</div>}
    </main>
  );
}
