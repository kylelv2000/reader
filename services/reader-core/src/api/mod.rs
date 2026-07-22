pub mod auth;
pub mod handlers;
pub mod router;

use crate::app::config::AppConfig;
use crate::service::{
    book_group_service::BookGroupService, book_service::BookService,
    book_source_service::BookSourceService, json_document_service::JsonDocumentService,
    local_epub_book::LocalEpubBookService, local_mobi_book::LocalMobiBookService,
    local_pdf_book::LocalPdfBookService, local_txt_book::LocalTxtBookService,
    update_service::UpdateService, user_service::UserService,
};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub book_service: Arc<BookService>,
    pub book_source_service: Arc<BookSourceService>,
    pub user_service: Arc<UserService>,
    pub book_group_service: Arc<BookGroupService>,
    pub local_txt_book_service: Arc<LocalTxtBookService>,
    pub local_epub_book_service: Arc<LocalEpubBookService>,
    pub local_mobi_book_service: Arc<LocalMobiBookService>,
    pub local_pdf_book_service: Arc<LocalPdfBookService>,
    pub json_document_service: Arc<JsonDocumentService>,
    pub update_service: Arc<UpdateService>,
    pub reader_prefetches: Arc<Mutex<std::collections::HashSet<String>>>,
    pub chapter_fetches:
        Arc<Mutex<std::collections::HashMap<String, broadcast::Sender<Result<String, String>>>>>,
}
