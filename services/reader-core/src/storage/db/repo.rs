use crate::error::error::AppError;
use crate::model::book_source::BookSource;
use crate::util::time::now_ts;
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;

#[derive(Clone)]
pub struct BookSourceRepo {
    pool: SqlitePool,
}

impl BookSourceRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn upsert(
        &self,
        user_ns: &str,
        source: &BookSource,
        json: &str,
    ) -> Result<(), AppError> {
        query(
            "INSERT INTO book_sources (user_ns, book_source_url, book_source_name, json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(user_ns, book_source_url) DO UPDATE SET book_source_name=excluded.book_source_name, json=excluded.json, updated_at=excluded.updated_at"
        )
        .bind(user_ns)
        .bind(&source.book_source_url)
        .bind(&source.book_source_name)
        .bind(json)
        .bind(now_ts())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_many(
        &self,
        user_ns: &str,
        sources: &[(BookSource, String)],
    ) -> Result<(), AppError> {
        let mut transaction = self.pool.begin().await?;
        for (source, json) in sources {
            query(
                "INSERT INTO book_sources (user_ns, book_source_url, book_source_name, json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(user_ns, book_source_url) DO UPDATE SET book_source_name=excluded.book_source_name, json=excluded.json, updated_at=excluded.updated_at",
            )
            .bind(user_ns)
            .bind(&source.book_source_url)
            .bind(&source.book_source_name)
            .bind(json)
            .bind(now_ts())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn delete(&self, user_ns: &str, book_source_url: &str) -> Result<(), AppError> {
        query("DELETE FROM book_sources WHERE user_ns=?1 AND book_source_url=?2")
            .bind(user_ns)
            .bind(book_source_url)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_all(&self, user_ns: &str) -> Result<(), AppError> {
        query("DELETE FROM book_sources WHERE user_ns=?1")
            .bind(user_ns)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get(
        &self,
        user_ns: &str,
        book_source_url: &str,
    ) -> Result<Option<String>, AppError> {
        let row =
            query("SELECT json FROM book_sources WHERE user_ns=?1 AND book_source_url=?2")
                .bind(user_ns)
                .bind(book_source_url)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.get::<String, _>("json")))
    }

    pub async fn list(&self, user_ns: &str) -> Result<Vec<String>, AppError> {
        let rows =
            query("SELECT json FROM book_sources WHERE user_ns=?1 ORDER BY updated_at DESC")
                .bind(user_ns)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|r| r.get::<String, _>("json"))
            .collect())
    }

    /// Upsert one toc-validation outcome and return the row's new
    /// (success_count, failure_streak).
    pub async fn record_stat(
        &self,
        user_ns: &str,
        source_url: &str,
        ok: bool,
    ) -> Result<(i64, i64), AppError> {
        let row = query(
            "INSERT INTO source_stats (user_ns, source_url, success_count, failure_streak, updated_at) \
             VALUES (?1, ?2, CASE WHEN ?3 THEN 1 ELSE 0 END, CASE WHEN ?3 THEN 0 ELSE 1 END, ?4) \
             ON CONFLICT(user_ns, source_url) DO UPDATE SET \
             success_count = success_count + (CASE WHEN ?3 THEN 1 ELSE 0 END), \
             failure_streak = CASE WHEN ?3 THEN 0 ELSE failure_streak + 1 END, \
             updated_at = ?4 \
             RETURNING success_count, failure_streak",
        )
        .bind(user_ns)
        .bind(source_url)
        .bind(ok)
        .bind(now_ts())
        .fetch_one(&self.pool)
        .await?;
        Ok((row.get::<i64, _>(0), row.get::<i64, _>(1)))
    }

    /// All usage stats for one user: source_url -> (success_count, failure_streak).
    pub async fn stats_for_user(
        &self,
        user_ns: &str,
    ) -> Result<std::collections::HashMap<String, (i64, i64)>, AppError> {
        let rows = query(
            "SELECT source_url, success_count, failure_streak FROM source_stats WHERE user_ns=?1",
        )
        .bind(user_ns)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                (
                    r.get::<String, _>(0),
                    (r.get::<i64, _>(1), r.get::<i64, _>(2)),
                )
            })
            .collect())
    }

    pub async fn copy_to(&self, from_ns: &str, to_ns: &str) -> Result<i64, AppError> {
        let result = query(
            "INSERT INTO book_sources (user_ns, book_source_url, book_source_name, json, updated_at) \
             SELECT ?2, book_source_url, book_source_name, json, updated_at \
             FROM book_sources WHERE user_ns=?1 \
             ON CONFLICT(user_ns, book_source_url) DO UPDATE SET \
             book_source_name=excluded.book_source_name, json=excluded.json, updated_at=excluded.updated_at",
        )
            .bind(from_ns)
            .bind(to_ns)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() as i64)
    }
}
