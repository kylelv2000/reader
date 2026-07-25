use axum::Router;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

use crate::api::{self, AppState};
use crate::app::config;
use crate::crawler::http_client::HttpClient;
use crate::parser::rule_engine::RuleEngine;
use crate::service::{
    book_group_service::BookGroupService, book_service::BookService,
    book_source_service::BookSourceService, json_document_service::JsonDocumentService,
    local_epub_book::LocalEpubBookService, local_mobi_book::LocalMobiBookService,
    local_pdf_book::LocalPdfBookService, local_txt_book::LocalTxtBookService,
    update_service::UpdateService, user_service::UserService,
};
use crate::storage::{cache::file_cache::FileCache, db, fs::storage_fs::StorageFs};

pub async fn run() -> anyhow::Result<()> {
    let mut cfg = config::load()?;

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(cfg.log_level.clone()))
        .init();

    let storage_fs = StorageFs::new(&cfg.storage_dir, &cfg.assets_dir);
    storage_fs.ensure().await?;

    // Zero-config startup: the database lives inside the storage volume and
    // the internal admin key is generated once and persisted there, so the
    // only thing a deployment must configure is where storage is mounted.
    if cfg.database_url.trim().is_empty() {
        cfg.database_url = format!("sqlite:{}/reader.db?mode=rwc", cfg.storage_dir);
    }
    if cfg.secure && cfg.secure_key.trim().is_empty() {
        cfg.secure_key = load_or_create_secret(
            &std::path::Path::new(&cfg.storage_dir)
                .join("data")
                .join("secure-key.txt"),
        )
        .await?;
        tracing::info!("SECURE_KEY not set; using the generated key persisted in storage/data/secure-key.txt");
    }
    // Companion secrets also live in the storage volume: the gateway reads
    // the session secret and the optional WebView bridge reads its key from
    // read-only mounts of the same volume, so nothing needs configuring.
    let data_dir = std::path::Path::new(&cfg.storage_dir).join("data");
    load_or_create_secret(&data_dir.join("session-secret.txt")).await?;
    let webview_key = load_or_create_secret(&data_dir.join("webview-key.txt")).await?;
    if std::env::var("WEBVIEW_BRIDGE_KEY").map(|v| v.trim().is_empty()).unwrap_or(true) {
        std::env::set_var("WEBVIEW_BRIDGE_KEY", &webview_key);
    }

    let pool = db::init_pool(&cfg.database_url).await?;
    let repo = db::repo::BookSourceRepo::new(pool.clone());

    let http = HttpClient::new(cfg.request_timeout_secs, None)?;
    let parser = RuleEngine::new()?;
    let cache = FileCache::new(format!("{}/cache", cfg.storage_dir));

    let book_service = Arc::new(BookService::new(http, parser, cache, &cfg.storage_dir));
    let book_source_service = Arc::new(BookSourceService::new(repo, &cfg.storage_dir));
    let local_txt_book_service = Arc::new(LocalTxtBookService::new(&cfg.storage_dir));
    let local_epub_book_service = Arc::new(LocalEpubBookService::new(&cfg.storage_dir));
    let local_mobi_book_service = Arc::new(LocalMobiBookService::new(&cfg.storage_dir));
    let local_pdf_book_service = Arc::new(LocalPdfBookService::new(&cfg.storage_dir));
    let json_document_service = Arc::new(JsonDocumentService::new(pool.clone(), &cfg.storage_dir));
    let user_service = Arc::new(UserService::new(cfg.clone(), pool.clone()));
    user_service.migrate_legacy_users_from_json().await?;
    user_service.ensure_initial_admin().await?;
    migrate_legacy_local_books(
        &cfg.storage_dir,
        &book_service,
        &local_txt_book_service,
        &local_epub_book_service,
        &local_mobi_book_service,
        &local_pdf_book_service,
    )
    .await;
    let book_group_service = Arc::new(BookGroupService::new(json_document_service.clone()));
    let update_service = Arc::new(UpdateService::new(
        json_document_service.clone(),
        cfg.request_timeout_secs,
        format!("v{}", env!("CARGO_PKG_VERSION")),
    )?);

    let state = AppState {
        config: cfg.clone(),
        book_service,
        book_source_service,
        user_service,
        book_group_service,
        local_txt_book_service,
        local_epub_book_service,
        local_mobi_book_service,
        local_pdf_book_service,
        json_document_service,
        update_service,
        reader_prefetches: Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
        chapter_fetches: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    };

    let app: Router = api::router::build_router(state);

    let addr = SocketAddr::new(cfg.server_host.parse()?, cfg.server_port);
    tracing::info!("listening on {}", addr);
    axum::serve(tokio::net::TcpListener::bind(addr).await?, app).await?;
    Ok(())
}

/// Legacy Reader Pro shelves store local books as `origin: "loc_book"` with
/// a raw file path in bookUrl. The reading pipeline only understands the
/// local-txt/epub/pdf/mobi origins, so those entries looked like broken web
/// books that endlessly searched for a source. Re-import each file through
/// the current local-book pipeline once at startup, carrying the reading
/// progress and group over, then drop the legacy entry (the original file is
/// left in place).
async fn migrate_legacy_local_books(
    storage_dir: &str,
    book_service: &BookService,
    txt: &LocalTxtBookService,
    epub: &LocalEpubBookService,
    mobi: &LocalMobiBookService,
    pdf: &LocalPdfBookService,
) {
    let storage_root = std::path::Path::new(storage_dir);
    let data_root = storage_root.join("data");
    let Ok(mut entries) = tokio::fs::read_dir(&data_root).await else {
        tracing::debug!(path = %data_root.display(), "no data directory; skipping legacy local book scan");
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let ns = entry.file_name().to_string_lossy().to_string();
        if ns.starts_with("__") || !entry.path().join("bookshelf.json").exists() {
            continue;
        }
        let books = match book_service.get_bookshelf(&ns).await {
            Ok(books) => books,
            Err(error) => {
                tracing::warn!(user = %ns, ?error, "failed to read bookshelf during legacy local book scan");
                continue;
            }
        };
        let legacy_count = books.iter().filter(|b| b.origin == "loc_book").count();
        if legacy_count > 0 {
            tracing::info!(user = %ns, count = legacy_count, "migrating legacy local books");
        }
        for book in books {
            if book.origin != "loc_book" {
                continue;
            }
            let relative = book
                .book_url
                .trim_start_matches('/')
                .trim_start_matches("storage/");
            let path = storage_root.join(relative);
            let Ok(canonical) = tokio::fs::canonicalize(&path).await else {
                tracing::warn!(book = %book.name, path = %path.display(), "legacy local book file is missing; keeping the entry as is");
                continue;
            };
            let Ok(canonical_root) = tokio::fs::canonicalize(storage_root).await else {
                return;
            };
            if !canonical.starts_with(&canonical_root) {
                tracing::warn!(book = %book.name, "legacy local book path escapes storage; skipping");
                continue;
            }
            // Legacy Reader Pro stored EPUBs as unpacked directories (the real
            // package root usually sits in an "index" subfolder); repack those
            // into a zip so the current importer can parse them.
            let bytes = if canonical.is_dir() {
                let root = if canonical.join("META-INF/container.xml").exists() {
                    canonical.clone()
                } else if canonical.join("index/META-INF/container.xml").exists() {
                    canonical.join("index")
                } else {
                    tracing::warn!(book = %book.name, "legacy local book directory has no EPUB container; skipping");
                    continue;
                };
                match pack_directory_as_epub(&root) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        tracing::warn!(book = %book.name, ?error, "failed to repack legacy EPUB directory");
                        continue;
                    }
                }
            } else {
                match tokio::fs::read(&canonical).await {
                    Ok(bytes) => bytes,
                    Err(_) => continue,
                }
            };
            let file_name = canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("book.epub")
                .to_string();
            let extension = std::path::Path::new(&file_name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let imported = match extension.as_str() {
                "epub" => epub.import_epub_book(&ns, &file_name, &bytes).await,
                "txt" => txt.import_txt_book(&ns, &file_name, &bytes).await,
                "pdf" => pdf.import_pdf_book(&ns, &file_name, &bytes).await,
                "mobi" | "azw" | "azw3" => mobi.import_mobi_book(&ns, &file_name, &bytes).await,
                _ => {
                    tracing::warn!(book = %book.name, file = %file_name, "legacy local book format is not supported; skipping");
                    continue;
                }
            };
            match imported {
                Ok(mut migrated) => {
                    migrated.dur_chapter_index = book.dur_chapter_index;
                    migrated.dur_chapter_pos = book.dur_chapter_pos;
                    migrated.dur_chapter_time = book.dur_chapter_time;
                    migrated.dur_chapter_title = book.dur_chapter_title.clone();
                    migrated.group = book.group;
                    let name = migrated.name.clone();
                    match book_service.save_book(&ns, migrated).await {
                        Ok(_) => {
                            let _ = book_service.delete_book(&ns, &book).await;
                            tracing::info!(user = %ns, book = %name, "migrated legacy local book");
                        }
                        Err(error) => {
                            tracing::warn!(user = %ns, book = %name, ?error, "failed to update bookshelf for migrated local book");
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(book = %book.name, ?error, "failed to migrate legacy local book");
                }
            }
        }
    }
}

fn pack_directory_as_epub(root: &std::path::Path) -> anyhow::Result<Vec<u8>> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            writer.start_file(relative, options)?;
            writer.write_all(&std::fs::read(&path)?)?;
        }
    }
    Ok(writer.finish()?.into_inner())
}

async fn load_or_create_secret(path: &std::path::Path) -> anyhow::Result<String> {
    if let Ok(existing) = tokio::fs::read_to_string(path).await {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let secret = crate::util::crypto::random_string(48);
    tokio::fs::write(path, &secret).await?;
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::book::Book;

    #[tokio::test]
    async fn migrates_legacy_loc_book_entries_and_keeps_progress() {
        let temp = std::env::temp_dir().join(format!(
            "yomu-legacy-local-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let storage = temp.to_str().unwrap().to_string();
        let book_dir = temp.join("data/reader1/MyBook_Author");
        tokio::fs::create_dir_all(&book_dir).await.unwrap();
        let content = "第一章 开始\n正文内容第一章。\n第二章 继续\n正文内容第二章。\n";
        tokio::fs::write(book_dir.join("My Book.txt"), content)
            .await
            .unwrap();

        let legacy = Book {
            name: "My Book".to_string(),
            author: "Author".to_string(),
            origin: "loc_book".to_string(),
            origin_name: Some("storage/data/reader1/MyBook_Author/My Book.txt".to_string()),
            book_url: "storage/data/reader1/MyBook_Author/My Book.txt".to_string(),
            toc_url: Some("toc".to_string()),
            dur_chapter_index: Some(1),
            dur_chapter_pos: Some(42),
            dur_chapter_title: Some("第二章 继续".to_string()),
            group: Some(3),
            ..Book::default()
        };
        tokio::fs::write(
            temp.join("data/reader1/bookshelf.json"),
            serde_json::to_string(&vec![legacy]).unwrap(),
        )
        .await
        .unwrap();

        let http = HttpClient::new(5, None).unwrap();
        let parser = RuleEngine::new().unwrap();
        let cache = FileCache::new(format!("{storage}/cache"));
        let book_service = BookService::new(http, parser, cache, &storage);
        let txt = LocalTxtBookService::new(&storage);
        let epub = LocalEpubBookService::new(&storage);
        let mobi = LocalMobiBookService::new(&storage);
        let pdf = LocalPdfBookService::new(&storage);

        migrate_legacy_local_books(&storage, &book_service, &txt, &epub, &mobi, &pdf).await;

        let shelf = book_service.get_bookshelf("reader1").await.unwrap();
        assert_eq!(shelf.len(), 1, "legacy entry replaced by migrated book");
        let migrated = &shelf[0];
        assert_eq!(migrated.origin, "local-txt");
        assert!(migrated.book_url.starts_with("local-txt:"));
        assert_eq!(migrated.dur_chapter_index, Some(1));
        assert_eq!(migrated.dur_chapter_pos, Some(42));
        assert_eq!(migrated.group, Some(3));

        // Running again must be a no-op (idempotent).
        migrate_legacy_local_books(&storage, &book_service, &txt, &epub, &mobi, &pdf).await;
        assert_eq!(
            book_service.get_bookshelf("reader1").await.unwrap().len(),
            1
        );

        let _ = tokio::fs::remove_dir_all(&temp).await;
    }

    #[tokio::test]
    async fn migrates_unpacked_epub_directory_entries() {
        let temp = std::env::temp_dir().join(format!(
            "yomu-legacy-epubdir-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let storage = temp.to_str().unwrap().to_string();
        // Reader Pro keeps EPUBs unpacked with the package root under "index/".
        let epub_root = temp.join("data/reader1/Test_Author/Test Book.epub/index");
        tokio::fs::create_dir_all(&epub_root).await.unwrap();
        let fixture = std::fs::read("tests/fixtures/test.epub").expect("fixture");
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(fixture)).expect("open fixture");
        archive.extract(&epub_root).expect("extract fixture");

        let legacy = Book {
            name: "Test Book".to_string(),
            origin: "loc_book".to_string(),
            book_url: "storage/data/reader1/Test_Author/Test Book.epub".to_string(),
            dur_chapter_index: Some(1),
            ..Book::default()
        };
        tokio::fs::write(
            temp.join("data/reader1/bookshelf.json"),
            serde_json::to_string(&vec![legacy]).unwrap(),
        )
        .await
        .unwrap();

        let http = HttpClient::new(5, None).unwrap();
        let parser = RuleEngine::new().unwrap();
        let cache = FileCache::new(format!("{storage}/cache"));
        let book_service = BookService::new(http, parser, cache, &storage);
        let txt = LocalTxtBookService::new(&storage);
        let epub = LocalEpubBookService::new(&storage);
        let mobi = LocalMobiBookService::new(&storage);
        let pdf = LocalPdfBookService::new(&storage);

        migrate_legacy_local_books(&storage, &book_service, &txt, &epub, &mobi, &pdf).await;

        let shelf = book_service.get_bookshelf("reader1").await.unwrap();
        assert_eq!(shelf.len(), 1);
        assert_eq!(shelf[0].origin, "local-epub");
        assert!(shelf[0].book_url.starts_with("local-epub:"));
        assert_eq!(shelf[0].dur_chapter_index, Some(1));

        let _ = tokio::fs::remove_dir_all(&temp).await;
    }
}
