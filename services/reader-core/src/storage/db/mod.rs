pub mod repo;

use sqlx::migrate::Migrator;
use sqlx_sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use std::{path::Path, str::FromStr, time::Duration};

pub async fn init_pool(database_url: &str) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        .pragma("cache_size", "-8192")
        .pragma("temp_store", "MEMORY");
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options)
        .await?;
    let migrations_dir = std::env::var("MIGRATIONS_DIR")
        .unwrap_or_else(|_| "src/storage/db/migrations".to_string());
    Migrator::new(Path::new(&migrations_dir)).await?.run(&pool).await?;
    Ok(pool)
}
