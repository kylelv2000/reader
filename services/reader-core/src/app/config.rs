use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub server_host: String,
    pub server_port: u16,
    pub database_url: String,
    pub storage_dir: String,
    pub web_root: String,
    pub assets_dir: String,
    pub log_level: String,
    pub request_timeout_secs: u64,
    pub secure: bool,
    pub secure_key: String,
    pub invite_code: String,
    pub allow_registration: bool,
    pub user_limit: u32,
    pub user_book_limit: u32,
    /// Max own book sources per non-admin user (0 = unlimited).
    pub user_source_limit: u32,
    /// Max sources consulted per search, best-ranked first (0 = unlimited).
    pub search_source_limit: u32,
    /// Search lanes for the source-switch scan (each lane = one in-flight
    /// search request, ~8s timeout).
    pub scan_search_concurrent: u32,
    /// Validation lanes for the source-switch scan (each lane fetches the
    /// candidate's catalog, ~2 requests, so keep it below the search lanes).
    pub scan_validate_concurrent: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_host: "0.0.0.0".to_string(),
            server_port: 18080,
            // Empty = derived from storage_dir at startup ({storage}/reader.db).
            database_url: String::new(),
            storage_dir: "storage".to_string(),
            web_root: "frontend/dist".to_string(),
            assets_dir: "storage/assets".to_string(),
            log_level: "info".to_string(),
            request_timeout_secs: 30,
            secure: false,
            secure_key: "".to_string(),
            invite_code: "".to_string(),
            allow_registration: false,
            user_limit: 50,
            user_book_limit: 2000,
            user_source_limit: 50,
            search_source_limit: 200,
            scan_search_concurrent: 12,
            scan_validate_concurrent: 6,
        }
    }
}

pub fn load() -> anyhow::Result<AppConfig> {
    dotenvy::dotenv().ok();
    let defaults = AppConfig::default();
    let cfg = config::Config::builder()
        .set_default("server_host", defaults.server_host)?
        .set_default("server_port", defaults.server_port as i64)?
        .set_default("database_url", defaults.database_url)?
        .set_default("storage_dir", defaults.storage_dir)?
        .set_default("web_root", defaults.web_root)?
        .set_default("assets_dir", defaults.assets_dir)?
        .set_default("log_level", defaults.log_level)?
        .set_default("request_timeout_secs", defaults.request_timeout_secs as i64)?
        .set_default("secure", defaults.secure)?
        .set_default("secure_key", defaults.secure_key)?
        .set_default("invite_code", defaults.invite_code)?
        .set_default("allow_registration", defaults.allow_registration)?
        .set_default("user_limit", defaults.user_limit as i64)?
        .set_default("user_book_limit", defaults.user_book_limit as i64)?
        .set_default("user_source_limit", defaults.user_source_limit as i64)?
        .set_default("search_source_limit", defaults.search_source_limit as i64)?
        .set_default("scan_search_concurrent", defaults.scan_search_concurrent as i64)?
        .set_default("scan_validate_concurrent", defaults.scan_validate_concurrent as i64)?
        .add_source(config::Environment::default().try_parsing(true))
        .build()?;
    Ok(cfg.try_deserialize()?)
}
