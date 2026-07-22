export type ViewName = "shelf" | "discover" | "sources" | "library";

export type ConnectionState = "checking" | "authenticating" | "connected" | "offline" | "signedout";

export interface Book {
  name: string;
  author: string;
  bookUrl: string;
  coverUrl?: string;
  customCoverUrl?: string;
  origin?: string;
  originName?: string;
  intro?: string;
  kind?: string;
  latestChapterTitle?: string;
  lastChapter?: string;
  sourceValidating?: boolean;
  durChapterTitle?: string;
  durChapterIndex?: number;
  durChapterPos?: number;
  durChapterTime?: number;
  totalChapterNum?: number;
  group?: number;
  type?: number;
  local?: boolean;
}

export interface Chapter {
  title: string;
  url?: string;
  index: number;
}

export type SourceRule = Record<string, string | undefined>;

export interface BookSource {
  bookSourceName: string;
  bookSourceUrl: string;
  bookSourceGroup?: string;
  bookSourceType?: number;
  enabled?: boolean;
  enabledExplore?: boolean;
  exploreUrl?: string;
  respondTime?: number;
  customOrder?: number;
  loginUrl?: string;
  enabledCookieJar?: boolean;
  searchUrl?: string;
  header?: string;
  concurrentRate?: string;
  bookUrlPattern?: string;
  loginUi?: string;
  loginCheckJs?: string;
  jsLib?: string;
  ruleSearch?: SourceRule;
  ruleExplore?: SourceRule;
  ruleBookInfo?: SourceRule;
  ruleToc?: SourceRule;
  ruleContent?: SourceRule;
}

export interface BookGroup {
  groupId: number;
  groupName: string;
  orderNo?: number;
  order?: number;
  show?: boolean;
}

export interface Bookmark {
  time?: number;
  bookName: string;
  bookAuthor: string;
  bookUrl?: string;
  chapterIndex: number;
  chapterPos?: number;
  chapterName: string;
  bookText?: string;
  content?: string;
}

export interface RssSource {
  sourceUrl: string;
  sourceName: string;
  sourceIcon?: string;
  sourceGroup?: string;
  sourceComment?: string;
  enabled?: boolean;
  sortUrl?: string;
  loginUrl?: string;
  enableJs?: boolean;
  customOrder?: number;
}

export interface RssArticle {
  origin: string;
  sort: string;
  title: string;
  order: number;
  link: string;
  pubDate?: string;
  description?: string;
  content?: string;
  image?: string;
  read?: boolean;
}

export interface ReplaceRule {
  id: number;
  name: string;
  group?: string;
  pattern: string;
  replacement: string;
  scope?: string;
  isEnabled: boolean;
  isRegex: boolean;
  order: number;
}

export interface WebdavFile {
  name: string;
  size: number;
  path: string;
  lastModified: number;
  isDirectory: boolean;
}

export interface ReaderUser {
  username: string;
  lastLoginAt: number;
  createdAt: number;
  enableWebdav: boolean;
  enableLocalStore: boolean;
  isAdmin: boolean;
}

export interface SourceTestSummary {
  total: number;
  valid: number;
  invalid: number;
  markedInvalid: number;
  results: Array<{
    bookSourceUrl: string;
    bookSourceName: string;
    valid: boolean;
    searchOk: boolean;
    exploreOk: boolean;
    searchError?: string;
    exploreError?: string;
  }>;
}

export interface ReaderPreferences {
  theme: "system" | "paper" | "night" | "green";
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  fontFamily: "system" | "serif" | "sans";
  pageMode: "scroll" | "paged";
  chineseMode: "original" | "simplified" | "traditional";
}

export interface OfflineBookStatus {
  cachedChapters: number;
  totalChapters: number;
  savedAt?: number;
}

export interface ReaderSession {
  book: Book;
  chapters: Chapter[];
  chapterIndex: number;
  content: string;
  loading: boolean;
}

export interface ServerProfile {
  username?: string;
}
