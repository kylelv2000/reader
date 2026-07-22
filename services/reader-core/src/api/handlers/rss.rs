use crate::api::auth::AuthContext;
use crate::api::AppState;
use crate::crawler::http_client::ensure_public_url;
use axum::extract::Multipart;
use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::error::error::{ApiResponse, AppError};
use crate::model::rss::{RssArticle, RssSource};
use crate::util::hash::md5_hex;
use crate::util::time::now_ts;
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, Deserialize)]
pub struct RemoteRssSourceParam {
    url: String,
}

#[derive(Debug, Deserialize)]
pub struct RssArticlesRequest {
    #[serde(rename = "sourceUrl")]
    pub source_url: Option<String>,
    #[serde(rename = "sortName")]
    pub sort_name: Option<String>,
    #[serde(rename = "sortUrl")]
    pub sort_url: Option<String>,
    pub page: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct RssContentRequest {
    #[serde(rename = "sourceUrl")]
    pub source_url: Option<String>,
    pub link: Option<String>,
    pub origin: Option<String>,
}

pub async fn get_rss_sources(
    State(state): State<AppState>,
    auth: AuthContext,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_user_ns(
        &state,
        auth.access_token(),
        auth.secure_key(),
        auth.user_ns(),
    )
    .await?;
    let list = read_list::<RssSource>(&state, &user_ns, "rssSources.json").await?;
    Ok(Json(ApiResponse::ok(
        serde_json::to_value(list).unwrap_or_default(),
    )))
}

pub async fn save_rss_source(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(source): Json<RssSource>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_user_ns(
        &state,
        auth.access_token(),
        auth.secure_key(),
        auth.user_ns(),
    )
    .await?;
    if source.source_url.is_empty() {
        return Err(AppError::BadRequest("RSS链接不能为空".to_string()));
    }
    if source.source_name.is_empty() {
        return Err(AppError::BadRequest("RSS名称不能为空".to_string()));
    }
    let mut list = read_list::<RssSource>(&state, &user_ns, "rssSources.json").await?;
    upsert_by_key(&mut list, source, |s| s.source_url.clone());
    write_list(&state, &user_ns, "rssSources.json", &list).await?;
    Ok(Json(ApiResponse::ok(Value::String("".to_string()))))
}

pub async fn save_rss_sources(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(mut sources): Json<Vec<RssSource>>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_user_ns(
        &state,
        auth.access_token(),
        auth.secure_key(),
        auth.user_ns(),
    )
    .await?;
    let mut list = read_list::<RssSource>(&state, &user_ns, "rssSources.json").await?;
    sources.retain(|s| !s.source_url.is_empty() && !s.source_name.is_empty());
    for s in sources {
        upsert_by_key(&mut list, s, |v| v.source_url.clone());
    }
    write_list(&state, &user_ns, "rssSources.json", &list).await?;
    Ok(Json(ApiResponse::ok(Value::String("".to_string()))))
}

pub async fn delete_rss_source(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(source): Json<RssSource>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_user_ns(
        &state,
        auth.access_token(),
        auth.secure_key(),
        auth.user_ns(),
    )
    .await?;
    let mut list = read_list::<RssSource>(&state, &user_ns, "rssSources.json").await?;
    list.retain(|s| s.source_url != source.source_url);
    write_list(&state, &user_ns, "rssSources.json", &list).await?;
    clear_rss_cache(&state, &user_ns).await;
    Ok(Json(ApiResponse::ok(Value::String("".to_string()))))
}

pub async fn delete_rss_sources(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(sources): Json<Vec<RssSource>>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_user_ns(
        &state,
        auth.access_token(),
        auth.secure_key(),
        auth.user_ns(),
    )
    .await?;
    let mut list = read_list::<RssSource>(&state, &user_ns, "rssSources.json").await?;
    let deleted = remove_rss_sources_by_url(&mut list, &sources);
    write_list(&state, &user_ns, "rssSources.json", &list).await?;
    clear_rss_cache(&state, &user_ns).await;
    Ok(Json(ApiResponse::ok(
        serde_json::json!({ "deleted": deleted }),
    )))
}

pub async fn read_remote_rss_source_file(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(param): Json<RemoteRssSourceParam>,
) -> Result<Json<ApiResponse<Vec<String>>>, AppError> {
    resolve_user_ns(&state, auth.access_token(), auth.secure_key(), auth.user_ns()).await?;
    ensure_public_url(&param.url)
        .await
        .map_err(|_| AppError::BadRequest("unsafe RSS source URL".to_string()))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| AppError::Internal(e.into()))?;

    let response = client
        .get(&param.url)
        .send()
        .await
        .map_err(|e| AppError::BadRequest(format!("网络请求失败: {}", e)))?;
    if response.content_length().map(|size| size > 2 * 1024 * 1024).unwrap_or(false) {
        return Err(AppError::BadRequest("RSS source file is too large".to_string()));
    }
    let bytes = response.bytes()
        .await
        .map_err(|e| AppError::BadRequest(format!("读取响应失败: {}", e)))?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(AppError::BadRequest("RSS source file is too large".to_string()));
    }
    let text = String::from_utf8_lossy(&bytes).to_string();

    let sources: Vec<RssSource> = serde_json::from_str(&text).or_else(|_| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            extract_rss_sources(v)
        } else {
            Err(AppError::BadRequest(
                "invalid rss sources json format".to_string(),
            ))
        }
    })?;

    let json_str = serde_json::to_string(&sources)
        .map_err(|e| AppError::BadRequest(format!("序列化RSS源失败: {}", e)))?;

    Ok(Json(ApiResponse::ok(vec![json_str])))
}

pub async fn read_rss_source_file(
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if let Some(file_name) = field.file_name() {
            if file_name.ends_with(".json") || file_name.ends_with(".txt") {
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?;
                let text = String::from_utf8_lossy(&bytes);
                let sources: Vec<RssSource> = serde_json::from_str(&text).or_else(|_| {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        extract_rss_sources(v)
                    } else {
                        Err(AppError::BadRequest(
                            "invalid rss sources json format".to_string(),
                        ))
                    }
                })?;
                return Ok(Json(serde_json::to_value(sources).unwrap_or_default()));
            }
        }
    }
    Err(AppError::BadRequest("No json file uploaded".to_string()))
}

pub async fn get_rss_articles(
    State(state): State<AppState>,
    auth: AuthContext,
    body: Option<Json<RssArticlesRequest>>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_user_ns(
        &state,
        auth.access_token(),
        auth.secure_key(),
        auth.user_ns(),
    )
    .await?;
    let req = body.map(|b| b.0).unwrap_or(RssArticlesRequest {
        source_url: None,
        sort_name: None,
        sort_url: None,
        page: None,
    });
    let source_url = req
        .source_url
        .ok_or_else(|| AppError::BadRequest("RSS源链接不能为空".to_string()))?;
    let sort_url = req.sort_url.unwrap_or_else(|| source_url.clone());
    let sort_name = req.sort_name.unwrap_or_default();
    let page = req.page.unwrap_or(1).max(1);

    let list = read_list::<RssSource>(&state, &user_ns, "rssSources.json").await?;
    let _rss_source = list
        .into_iter()
        .find(|s| s.source_url == source_url)
        .ok_or_else(|| AppError::BadRequest("RSS源不存在".to_string()))?;
    ensure_public_url(&sort_url)
        .await
        .map_err(|_| AppError::BadRequest("unsafe RSS feed URL".to_string()))?;
    let bytes = cached_rss_bytes(&state, &user_ns, "feeds", &sort_url, 10 * 60, 30 * 60, 4 * 1024 * 1024).await?;
    let feed =
        feed_rs::parser::parse(&bytes[..]).map_err(|e| AppError::BadRequest(e.to_string()))?;

    let mut items = Vec::new();
    for entry in feed.entries {
        let title = entry
            .title
            .as_ref()
            .map(|t| t.content.clone())
            .unwrap_or_default();
        let link = entry
            .links
            .first()
            .map(|l| l.href.clone())
            .unwrap_or_default();
        let description = entry.summary.as_ref().map(|s| s.content.clone());
        let content = entry.content.as_ref().and_then(|c| c.body.clone());
        let pub_date = entry.published.or(entry.updated).map(|d| d.to_rfc3339());
        let image = entry
            .media
            .first()
            .and_then(|m| m.thumbnails.first())
            .map(|t| t.image.uri.clone());
        let order = entry
            .published
            .or(entry.updated)
            .map(|d| d.timestamp())
            .unwrap_or(now_ts());
        items.push(RssArticle {
            origin: sort_url.clone(),
            sort: sort_name.clone(),
            title,
            order,
            link,
            pub_date,
            description,
            content,
            image,
            read: Some(false),
            variable: None,
        });
    }

    let page_size = 50usize;
    let start = ((page - 1) as usize) * page_size;
    let end = std::cmp::min(start + page_size, items.len());
    let page_items = if start < items.len() {
        items[start..end].to_vec()
    } else {
        Vec::new()
    };
    let data = serde_json::json!({"first": page_items, "second": null});
    Ok(Json(ApiResponse::ok(data)))
}

pub async fn get_rss_content(
    State(state): State<AppState>,
    auth: AuthContext,
    body: Option<Json<RssContentRequest>>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_user_ns(
        &state,
        auth.access_token(),
        auth.secure_key(),
        auth.user_ns(),
    )
    .await?;
    let req = body.map(|b| b.0).unwrap_or(RssContentRequest {
        source_url: None,
        link: None,
        origin: None,
    });
    let source_url = req
        .source_url
        .ok_or_else(|| AppError::BadRequest("RSS链接不能为空".to_string()))?;
    let link = req
        .link
        .ok_or_else(|| AppError::BadRequest("RSS文章链接不能为空".to_string()))?;
    ensure_public_url(&link)
        .await
        .map_err(|_| AppError::BadRequest("unsafe RSS article URL".to_string()))?;
    let _origin = req
        .origin
        .ok_or_else(|| AppError::BadRequest("RSS文章来源不能为空".to_string()))?;

    let list = read_list::<RssSource>(&state, &user_ns, "rssSources.json").await?;
    let _rss_source = list
        .into_iter()
        .find(|s| s.source_url == source_url)
        .ok_or_else(|| AppError::BadRequest("RSS源不存在".to_string()))?;

    let bytes = cached_rss_bytes(
        &state,
        &user_ns,
        "articles",
        &link,
        24 * 60 * 60,
        60 * 60,
        4 * 1024 * 1024,
    )
    .await?;
    let body = String::from_utf8_lossy(&bytes).to_string();
    Ok(Json(ApiResponse::ok(Value::String(body))))
}

fn rss_cache_path(state: &AppState, user_ns: &str, kind: &str, url: &str) -> PathBuf {
    PathBuf::from(&state.config.storage_dir)
        .join("cache")
        .join(user_ns)
        .join("rss")
        .join(kind)
        .join(md5_hex(url))
}

async fn cached_rss_bytes(
    state: &AppState,
    user_ns: &str,
    kind: &str,
    url: &str,
    fresh_seconds: u64,
    retry_seconds: u64,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    let path = rss_cache_path(state, user_ns, kind, url).with_extension("bin");
    let miss_path = rss_cache_path(state, user_ns, kind, url).with_extension("miss");
    if file_is_fresh(&path, fresh_seconds).await {
        return fs::read(path)
            .await
            .map_err(|error| AppError::Internal(error.into()));
    }
    if file_is_fresh(&miss_path, retry_seconds).await {
        if path.is_file() {
            return fs::read(path)
                .await
                .map_err(|error| AppError::Internal(error.into()));
        }
        return Err(AppError::NotFound(
            "RSS remote retry is temporarily paused".to_string(),
        ));
    }
    let response = state.book_service.http_client().get(url).send().await;
    let result = match response {
        Ok(response) if response.status().is_success() => {
            if response
                .content_length()
                .is_some_and(|size| size > max_bytes as u64)
            {
                Err(AppError::BadRequest("RSS response is too large".to_string()))
            } else {
                match response.bytes().await {
                    Ok(bytes) if bytes.len() <= max_bytes => Ok(bytes.to_vec()),
                    Ok(_) => Err(AppError::BadRequest("RSS response is too large".to_string())),
                    Err(error) => Err(AppError::Internal(error.into())),
                }
            }
        }
        Ok(_) => Err(AppError::NotFound("RSS remote content not found".to_string())),
        Err(error) => Err(AppError::Internal(error.into())),
    };
    match result {
        Ok(bytes) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .await
                    .map_err(|error| AppError::Internal(error.into()))?;
            }
            fs::write(&path, &bytes)
                .await
                .map_err(|error| AppError::Internal(error.into()))?;
            if miss_path.exists() {
                let _ = fs::remove_file(miss_path).await;
            }
            Ok(bytes)
        }
        Err(error) => {
            if let Some(parent) = miss_path.parent() {
                let _ = fs::create_dir_all(parent).await;
            }
            let _ = fs::write(&miss_path, &[]).await;
            if path.is_file() {
                fs::read(path)
                    .await
                    .map_err(|read_error| AppError::Internal(read_error.into()))
            } else {
                Err(error)
            }
        }
    }
}

async fn file_is_fresh(path: &std::path::Path, max_age_seconds: u64) -> bool {
    let Ok(metadata) = fs::metadata(path).await else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    modified.elapsed().is_ok_and(|age| age.as_secs() <= max_age_seconds)
}

async fn clear_rss_cache(state: &AppState, user_ns: &str) {
    let path = PathBuf::from(&state.config.storage_dir)
        .join("cache")
        .join(user_ns)
        .join("rss");
    if path.exists() {
        let _ = fs::remove_dir_all(path).await;
    }
}

async fn resolve_user_ns(
    state: &AppState,
    access_token: Option<&str>,
    secure_key: Option<&str>,
    user_ns: Option<&str>,
) -> Result<String, AppError> {
    match state
        .user_service
        .resolve_user_ns_with_override(access_token, secure_key, user_ns)
        .await
    {
        Ok(ns) => Ok(ns),
        Err(_) => Err(AppError::BadRequest("NEED_LOGIN".to_string())),
    }
}

async fn read_list<T: for<'de> serde::Deserialize<'de>>(
    state: &AppState,
    user_ns: &str,
    name: &str,
) -> Result<Vec<T>, AppError> {
    state.json_document_service.read_list(user_ns, name).await
}

async fn write_list<T: serde::Serialize>(
    state: &AppState,
    user_ns: &str,
    name: &str,
    list: &Vec<T>,
) -> Result<(), AppError> {
    state
        .json_document_service
        .write_list(user_ns, name, list)
        .await
}

fn extract_rss_sources(payload: serde_json::Value) -> Result<Vec<RssSource>, AppError> {
    if payload.is_array() {
        return serde_json::from_value::<Vec<RssSource>>(payload)
            .map_err(|e| AppError::BadRequest(e.to_string()));
    }
    if let Some(obj) = payload.as_object() {
        for key in ["rssSources", "rssSourceList", "data", "sources"] {
            if let Some(v) = obj.get(key) {
                if v.is_array() {
                    return serde_json::from_value::<Vec<RssSource>>(v.clone())
                        .map_err(|e| AppError::BadRequest(e.to_string()));
                }
            }
        }
    }
    Err(AppError::BadRequest(
        "invalid rss sources payload".to_string(),
    ))
}

fn upsert_by_key<T, F>(list: &mut Vec<T>, item: T, key_fn: F)
where
    F: Fn(&T) -> String,
{
    let key = key_fn(&item);
    if let Some(pos) = list.iter().position(|v| key_fn(v) == key) {
        list[pos] = item;
    } else {
        list.push(item);
    }
}

fn remove_rss_sources_by_url(list: &mut Vec<RssSource>, targets: &[RssSource]) -> usize {
    let before = list.len();
    let target_urls = targets
        .iter()
        .filter(|source| !source.source_url.is_empty())
        .map(|source| source.source_url.as_str())
        .collect::<std::collections::HashSet<_>>();
    list.retain(|source| !target_urls.contains(source.source_url.as_str()));
    before.saturating_sub(list.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rss_source(name: &str, url: &str) -> RssSource {
        RssSource {
            source_name: name.to_string(),
            source_url: url.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn remove_rss_sources_by_url_keeps_unmatched_sources() {
        let mut list = vec![
            rss_source("News", "https://news.example"),
            rss_source("Tech", "https://tech.example"),
            rss_source("Blog", "https://blog.example"),
        ];
        let targets = vec![
            rss_source("Ignored Name", "https://tech.example"),
            rss_source("Missing", "https://missing.example"),
        ];

        let deleted = remove_rss_sources_by_url(&mut list, &targets);

        assert_eq!(deleted, 1);
        assert_eq!(
            list.iter()
                .map(|source| source.source_url.as_str())
                .collect::<Vec<_>>(),
            vec!["https://news.example", "https://blog.example"]
        );
    }
}
