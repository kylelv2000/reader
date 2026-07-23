use crate::error::error::AppError;
use crate::model::book_source::{book_source_from_value, BookSource};
use crate::storage::db::repo::BookSourceRepo;
use std::path::PathBuf;
use tokio::fs;

pub const INVALID_BOOK_SOURCE_GROUP: &str = "失效";
pub const INCOMPATIBLE_BOOK_SOURCE_GROUP: &str = "不兼容";
const TOC_FAILURE_DISABLE_THRESHOLD: i32 = 3;

#[derive(Clone)]
pub struct BookSourceService {
    repo: BookSourceRepo,
    default_owner_path: PathBuf,
}

impl BookSourceService {
    pub fn new(repo: BookSourceRepo, storage_dir: &str) -> Self {
        let default_owner_path = PathBuf::from(storage_dir)
            .join("data")
            .join("__default__")
            .join("defaultBookSourceOwner.txt");
        Self {
            repo,
            default_owner_path,
        }
    }

    pub async fn save(&self, user_ns: &str, mut source: BookSource) -> Result<(), AppError> {
        clear_auto_disable_when_reenabled(&mut source);
        let json =
            serde_json::to_string(&source).map_err(|e| AppError::BadRequest(e.to_string()))?;
        self.repo.upsert(user_ns, &source, &json).await
    }

    pub async fn save_many(&self, user_ns: &str, sources: Vec<BookSource>) -> Result<(), AppError> {
        let serialized = sources
            .into_iter()
            .map(|mut source| {
                clear_auto_disable_when_reenabled(&mut source);
                serde_json::to_string(&source)
                    .map(|json| (source, json))
                    .map_err(|error| AppError::BadRequest(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.repo.upsert_many(user_ns, &serialized).await
    }

    /// Track toc-validation outcomes per source. Sources whose catalog rules
    /// keep failing get auto-disabled so they stop polluting search results;
    /// a single success resets the streak (tolerates transient failures).
    pub async fn record_toc_outcome(
        &self,
        user_ns: &str,
        source_url: &str,
        ok: bool,
    ) -> Result<bool, AppError> {
        let Some(mut source) = self.get(user_ns, source_url).await? else {
            return Ok(false);
        };
        if source.enabled == Some(false) {
            return Ok(false);
        }
        if ok && source.toc_failure_count.unwrap_or(0) == 0 {
            return Ok(false);
        }
        let disabled = apply_toc_outcome(&mut source, ok);
        self.save(user_ns, source).await?;
        Ok(disabled)
    }

    pub async fn auto_disable_if_incompatible(
        &self,
        user_ns: &str,
        source: &BookSource,
        error: &AppError,
    ) -> Result<bool, AppError> {
        let Some(reason) = source_incompatibility_reason(error) else {
            return Ok(false);
        };
        let mut updated = self
            .get(user_ns, &source.book_source_url)
            .await?
            .unwrap_or_else(|| source.clone());
        if updated.enabled == Some(false)
            && updated.auto_disabled_reason.as_deref() == Some(reason.as_str())
        {
            return Ok(false);
        }
        updated.enabled = Some(false);
        updated.auto_disabled_reason = Some(reason);
        updated.auto_disabled_at = Some(chrono::Utc::now().timestamp_millis());
        add_source_group(&mut updated, INCOMPATIBLE_BOOK_SOURCE_GROUP);
        self.save(user_ns, updated).await?;
        Ok(true)
    }

    pub async fn get(
        &self,
        user_ns: &str,
        book_source_url: &str,
    ) -> Result<Option<BookSource>, AppError> {
        let json = self.repo.get(user_ns, book_source_url).await?;
        if let Some(j) = json {
            let value: serde_json::Value =
                serde_json::from_str(&j).map_err(|e| AppError::BadRequest(e.to_string()))?;
            let source =
                book_source_from_value(value).map_err(|e| AppError::BadRequest(e.to_string()))?;
            Ok(Some(source))
        } else {
            Ok(None)
        }
    }

    pub async fn list(&self, user_ns: &str) -> Result<Vec<BookSource>, AppError> {
        let rows = self.repo.list(user_ns).await?;
        let mut out = Vec::with_capacity(rows.len());
        for j in rows {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&j) {
                if let Ok(s) = book_source_from_value(value) {
                    out.push(s);
                }
            } else if let Ok(s) = serde_json::from_str::<BookSource>(&j) {
                out.push(s);
            }
        }
        Ok(out)
    }

    pub async fn delete(&self, user_ns: &str, book_source_url: &str) -> Result<(), AppError> {
        self.repo.delete(user_ns, book_source_url).await
    }

    pub async fn delete_all(&self, user_ns: &str) -> Result<(), AppError> {
        self.repo.delete_all(user_ns).await
    }

    /// Copy sources from one user to another (used for setting default sources)
    pub async fn copy_to(&self, from_ns: &str, to_ns: &str) -> Result<i64, AppError> {
        self.repo.copy_to(from_ns, to_ns).await
    }

    /// Set a user's sources as the default sources (for new users)
    pub async fn set_as_default(&self, from_ns: &str) -> Result<i64, AppError> {
        let count = self.copy_to(from_ns, "__default__").await?;
        if let Some(dir) = self.default_owner_path.parent() {
            fs::create_dir_all(dir)
                .await
                .map_err(|e| AppError::Internal(e.into()))?;
        }
        fs::write(&self.default_owner_path, from_ns)
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        Ok(count)
    }

    /// Copy default sources to a new user
    pub async fn copy_default_to_user(&self, to_ns: &str) -> Result<i64, AppError> {
        self.repo.copy_to("__default__", to_ns).await
    }

    pub async fn get_default_owner(&self) -> Result<Option<String>, AppError> {
        match fs::read_to_string(&self.default_owner_path).await {
            Ok(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(trimmed.to_string()))
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(AppError::Internal(err.into())),
        }
    }
}

fn source_incompatibility_reason(error: &AppError) -> Option<String> {
    match error {
        AppError::BadRequest(message) if message.starts_with("invalid url options:") => {
            Some("搜索地址配置无法解析".to_string())
        }
        AppError::BadRequest(message) if message == "missing search_url" => {
            Some("缺少搜索地址".to_string())
        }
        AppError::Internal(error) => {
            let detail = format!("{error:#}");
            let lower = detail.to_ascii_lowercase();
            if lower.contains("js exception") {
                let summary = detail
                    .split("JS Exception:")
                    .nth(1)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("书源脚本无法在当前规则引擎运行");
                Some(format!("规则脚本不兼容：{}", truncate_reason(summary)))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn truncate_reason(value: &str) -> String {
    const MAX_CHARS: usize = 120;
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= MAX_CHARS {
        compact
    } else {
        format!("{}…", compact.chars().take(MAX_CHARS).collect::<String>())
    }
}

/// Pure state transition for toc-outcome tracking. Returns true when the
/// source crossed the failure threshold and was auto-disabled.
fn apply_toc_outcome(source: &mut BookSource, ok: bool) -> bool {
    if ok {
        source.toc_failure_count = None;
        return false;
    }
    let count = source.toc_failure_count.unwrap_or(0) + 1;
    if count >= TOC_FAILURE_DISABLE_THRESHOLD {
        source.enabled = Some(false);
        source.auto_disabled_reason = Some("目录规则连续失败".to_string());
        source.auto_disabled_at = Some(chrono::Utc::now().timestamp_millis());
        source.toc_failure_count = None;
        add_source_group(source, INCOMPATIBLE_BOOK_SOURCE_GROUP);
        return true;
    }
    source.toc_failure_count = Some(count);
    false
}

fn add_source_group(source: &mut BookSource, group: &str) {
    let mut groups = source
        .book_source_group
        .as_deref()
        .map(split_source_groups)
        .unwrap_or_default();
    if !groups.iter().any(|existing| existing == group) {
        groups.push(group.to_string());
    }
    source.book_source_group = Some(groups.join(","));
}

fn clear_auto_disable_when_reenabled(source: &mut BookSource) {
    if source.enabled == Some(false) || source.auto_disabled_reason.is_none() {
        return;
    }
    source.auto_disabled_reason = None;
    source.auto_disabled_at = None;
    let mut groups = source
        .book_source_group
        .as_deref()
        .map(split_source_groups)
        .unwrap_or_default();
    groups.retain(|group| group != INCOMPATIBLE_BOOK_SOURCE_GROUP);
    source.book_source_group = if groups.is_empty() {
        None
    } else {
        Some(groups.join(","))
    };
}

pub fn book_source_has_group(source: &BookSource, target: &str) -> bool {
    source
        .book_source_group
        .as_deref()
        .map(split_source_groups)
        .unwrap_or_default()
        .into_iter()
        .any(|group| group == target)
}

pub fn set_invalid_book_source_group(source: &mut BookSource, invalid: bool) -> bool {
    let mut groups = source
        .book_source_group
        .as_deref()
        .map(split_source_groups)
        .unwrap_or_default();
    let had_invalid = groups
        .iter()
        .any(|group| group == INVALID_BOOK_SOURCE_GROUP);

    if invalid {
        if had_invalid {
            return false;
        }
        groups.push(INVALID_BOOK_SOURCE_GROUP.to_string());
    } else {
        if !had_invalid {
            return false;
        }
        groups.retain(|group| group != INVALID_BOOK_SOURCE_GROUP);
    }

    source.book_source_group = if groups.is_empty() {
        None
    } else {
        Some(groups.join(","))
    };
    true
}

fn split_source_groups(raw: &str) -> Vec<String> {
    raw.split(|ch| matches!(ch, ',' | ';' | '；' | '、'))
        .map(str::trim)
        .filter(|group| !group.is_empty())
        .map(str::to_string)
        .fold(Vec::new(), |mut groups, group| {
            if !groups.contains(&group) {
                groups.push(group);
            }
            groups
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_rule_errors_but_not_temporary_network_errors() {
        let js_error = AppError::Internal(anyhow::anyhow!(
            "JS Exception: ReferenceError: isGet is not defined"
        ));
        let timeout = AppError::Internal(anyhow::anyhow!("connection timed out"));
        let blocked = AppError::Internal(anyhow::anyhow!(
            "URL resolves to a blocked network"
        ));

        assert!(source_incompatibility_reason(&js_error)
            .is_some_and(|reason| reason.contains("isGet")));
        assert!(source_incompatibility_reason(&timeout).is_none());
        assert!(source_incompatibility_reason(&blocked).is_none());
        assert!(source_incompatibility_reason(&AppError::BadRequest(
            "invalid url options: expected value".to_string()
        ))
        .is_some());
    }

    #[test]
    fn toc_failures_disable_source_after_threshold_and_success_resets() {
        let mut source = BookSource {
            enabled: Some(true),
            ..BookSource::default()
        };

        assert!(!apply_toc_outcome(&mut source, false));
        assert!(!apply_toc_outcome(&mut source, false));
        assert_eq!(source.toc_failure_count, Some(2));

        // One success wipes the streak.
        assert!(!apply_toc_outcome(&mut source, true));
        assert!(source.toc_failure_count.is_none());

        // Three consecutive failures auto-disable the source.
        assert!(!apply_toc_outcome(&mut source, false));
        assert!(!apply_toc_outcome(&mut source, false));
        assert!(apply_toc_outcome(&mut source, false));
        assert_eq!(source.enabled, Some(false));
        assert_eq!(source.auto_disabled_reason.as_deref(), Some("目录规则连续失败"));
        assert!(book_source_has_group(&source, INCOMPATIBLE_BOOK_SOURCE_GROUP));
    }

    #[test]
    fn reenabling_clears_only_the_automatic_incompatibility_marker() {
        let mut source = BookSource {
            enabled: Some(true),
            book_source_group: Some("自用,不兼容".to_string()),
            auto_disabled_reason: Some("规则脚本不兼容".to_string()),
            auto_disabled_at: Some(123),
            ..BookSource::default()
        };

        clear_auto_disable_when_reenabled(&mut source);

        assert_eq!(source.book_source_group.as_deref(), Some("自用"));
        assert!(source.auto_disabled_reason.is_none());
        assert!(source.auto_disabled_at.is_none());
    }
}
