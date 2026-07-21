use crate::api::auth::AuthContext;
use crate::api::AppState;
use axum::{
    extract::{Multipart, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use tokio::fs;

use crate::error::error::{ApiResponse, AppError};

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(rename = "isLogin")]
    pub is_login: Option<bool>,
    pub code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FileTypeQuery {
    #[serde(rename = "type")]
    pub file_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddUserRequest {
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResetPasswordRequest {
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    #[serde(rename = "oldPassword")]
    pub old_password: Option<String>,
    #[serde(rename = "newPassword")]
    pub new_password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    pub username: Option<String>,
    #[serde(rename = "enableWebdav")]
    pub enable_webdav: Option<bool>,
    #[serde(rename = "enableLocalStore")]
    pub enable_local_store: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteFileRequest {
    pub url: Option<String>,
}

const MAX_ASSET_BYTES: usize = 10 * 1024 * 1024;

fn safe_file_name(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 255 || value.chars().any(|ch| matches!(ch, '/' | '\\' | '\0')) {
        return None;
    }
    let path = Path::new(value);
    if path.components().count() != 1 || !matches!(path.components().next(), Some(Component::Normal(_))) {
        return None;
    }
    Some(value.to_string())
}

fn safe_asset_type(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 32 || !value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
        return None;
    }
    Some(value.to_string())
}

pub async fn login(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<LoginRequest>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let username = req.username.unwrap_or_default();
    let password = req.password.unwrap_or_default();
    let is_login = req.is_login.unwrap_or(false);
    let is_new_user = !is_login && !username.is_empty(); // registration attempt
    if is_new_user
        && !state.config.allow_registration
        && !auth.secure_key().map(|key| state.user_service.secure_key_matches(key)).unwrap_or(false)
    {
        return Err(AppError::BadRequest("REGISTRATION_DISABLED".to_string()));
    }
    let data = state
        .user_service
        .login(&username, &password, is_login, req.code.as_deref())
        .await?;
    // If this was a new user registration, copy default book sources
    if is_new_user {
        let _ = state
            .book_source_service
            .copy_default_to_user(&username)
            .await;
    }
    Ok(Json(ApiResponse::ok(data)))
}

pub async fn logout(
    State(state): State<AppState>,
    auth: AuthContext,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    if !state.user_service.secure_enabled() {
        return Ok(Json(ApiResponse::err("不支持的操作")));
    }
    if let Some(token) = auth.access_token() {
        let _ = state.user_service.logout(token).await;
    }
    Ok(Json(ApiResponse::err_with_data(
        "请重新登录",
        Value::String("NEED_LOGIN".to_string()),
    )))
}

pub async fn get_user_info(
    State(state): State<AppState>,
    auth: AuthContext,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let (user_info, secure, secure_key_required, admin_authorized) = state
        .user_service
        .get_user_info(auth.access_token(), auth.secure_key())
        .await?;
    let data = serde_json::json!({
        "userInfo": user_info,
        "secure": secure,
        "secureKeyRequired": secure_key_required,
        "adminAuthorized": admin_authorized,
    });
    Ok(Json(ApiResponse::ok(data)))
}

pub async fn save_user_config(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(body): Json<Value>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = match state
        .user_service
        .resolve_user_ns_with_override(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
    {
        Ok(ns) => ns,
        Err(_) => {
            return Ok(Json(ApiResponse::err_with_data(
                "请登录后使用",
                Value::String("NEED_LOGIN".to_string()),
            )))
        }
    };
    state.user_service.save_user_config(&user_ns, body).await?;
    Ok(Json(ApiResponse::ok(Value::String("".to_string()))))
}

pub async fn get_user_config(
    State(state): State<AppState>,
    auth: AuthContext,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = match state
        .user_service
        .resolve_user_ns_with_override(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
    {
        Ok(ns) => ns,
        Err(_) => {
            return Ok(Json(ApiResponse::err_with_data(
                "请登录后使用",
                Value::String("NEED_LOGIN".to_string()),
            )))
        }
    };
    let cfg = state.user_service.get_user_config(&user_ns).await?;
    Ok(Json(ApiResponse::ok(cfg)))
}

pub async fn get_user_list(
    State(state): State<AppState>,
    auth: AuthContext,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    if !state.user_service.secure_enabled() {
        return Ok(Json(ApiResponse::err("不支持的操作")));
    }
    // Check if admin (either by is_admin flag or secure key)
    let is_admin = state
        .user_service
        .is_admin(auth.access_token(), auth.secure_key())
        .await?;
    if !is_admin {
        return Ok(Json(ApiResponse::err_with_data(
            "请输入管理密码",
            Value::String("NEED_SECURE_KEY".to_string()),
        )));
    }
    let list = state.user_service.get_user_list().await?;
    Ok(Json(ApiResponse::ok(Value::from(list))))
}

pub async fn add_user(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<AddUserRequest>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    if !state.user_service.secure_enabled() {
        return Ok(Json(ApiResponse::err("不支持的操作")));
    }
    // Check if admin (either by is_admin flag or secure key)
    let is_admin = state
        .user_service
        .is_admin(auth.access_token(), auth.secure_key())
        .await?;
    if !is_admin {
        return Ok(Json(ApiResponse::err_with_data(
            "请输入管理密码",
            Value::String("NEED_SECURE_KEY".to_string()),
        )));
    }
    let username = req.username.unwrap_or_default();
    let password = req.password.unwrap_or_default();
    let list = state.user_service.add_user(&username, &password).await?;
    Ok(Json(ApiResponse::ok(Value::from(list))))
}

pub async fn reset_password(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<ResetPasswordRequest>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    if !state.user_service.secure_enabled() {
        return Ok(Json(ApiResponse::err("不支持的操作")));
    }
    // Check if admin (either by is_admin flag or secure key)
    let is_admin = state
        .user_service
        .is_admin(auth.access_token(), auth.secure_key())
        .await?;
    if !is_admin {
        return Ok(Json(ApiResponse::err_with_data(
            "请输入管理密码",
            Value::String("NEED_SECURE_KEY".to_string()),
        )));
    }
    let username = req.username.unwrap_or_default();
    let password = req.password.unwrap_or_default();
    state
        .user_service
        .reset_password(&username, &password)
        .await?;
    Ok(Json(ApiResponse::ok(Value::String("".to_string()))))
}

pub async fn change_password(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    if !state.user_service.secure_enabled() {
        return Ok(Json(ApiResponse::err("不支持的操作")));
    }
    let token = auth
        .access_token()
        .ok_or_else(|| AppError::BadRequest("NEED_LOGIN".to_string()))?;
    let old_password = req.old_password.unwrap_or_default();
    let new_password = req.new_password.unwrap_or_default();
    if old_password.is_empty() || new_password.is_empty() {
        return Err(AppError::BadRequest("请填写当前密码和新密码".to_string()));
    }
    state
        .user_service
        .change_password(token, &old_password, &new_password)
        .await?;
    Ok(Json(ApiResponse::ok(Value::String("".to_string()))))
}

pub async fn delete_users(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(list): Json<Vec<String>>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    if !state.user_service.secure_enabled() {
        return Ok(Json(ApiResponse::err("不支持的操作")));
    }
    // Check if admin (either by is_admin flag or secure key)
    let is_admin = state
        .user_service
        .is_admin(auth.access_token(), auth.secure_key())
        .await?;
    if !is_admin {
        return Ok(Json(ApiResponse::err_with_data(
            "请输入管理密码",
            Value::String("NEED_SECURE_KEY".to_string()),
        )));
    }
    let users = state.user_service.delete_users(&list).await?;
    Ok(Json(ApiResponse::ok(Value::from(users))))
}

pub async fn update_user(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<UpdateUserRequest>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    if !state.user_service.secure_enabled() {
        return Ok(Json(ApiResponse::err("不支持的操作")));
    }
    // Check if admin (either by is_admin flag or secure key)
    let is_admin = state
        .user_service
        .is_admin(auth.access_token(), auth.secure_key())
        .await?;
    if !is_admin {
        return Ok(Json(ApiResponse::err_with_data(
            "请输入管理密码",
            Value::String("NEED_SECURE_KEY".to_string()),
        )));
    }
    let username = req.username.unwrap_or_default();
    let list = state
        .user_service
        .update_user(
            &username,
            req.enable_webdav,
            req.enable_local_store,
        )
        .await?;
    Ok(Json(ApiResponse::ok(Value::from(list))))
}

pub async fn upload_file(
    State(state): State<AppState>,
    auth: AuthContext,
    Query(q): Query<FileTypeQuery>,
    mut multipart: Multipart,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = match state
        .user_service
        .resolve_user_ns_with_override(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
    {
        Ok(ns) => ns,
        Err(_) => {
            return Ok(Json(ApiResponse::err_with_data(
                "请登录后使用",
                Value::String("NEED_LOGIN".to_string()),
            )))
        }
    };
    let mut file_list = Vec::new();
    let file_type = q.file_type.as_deref().and_then(safe_asset_type).unwrap_or_else(|| "images".to_string());
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let name = field
            .file_name()
            .and_then(safe_file_name)
            .ok_or_else(|| AppError::BadRequest("非法文件名".to_string()))?;
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;
        if data.len() > MAX_ASSET_BYTES {
            return Err(AppError::BadRequest("文件不能超过10MB".to_string()));
        }
        let dir = PathBuf::from(&state.config.storage_dir)
            .join("assets")
            .join(&user_ns)
            .join(&file_type);
        fs::create_dir_all(&dir)
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let path = dir.join(&name);
        fs::write(&path, data)
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let url = format!("/assets/{}/{}/{}", user_ns, file_type, name);
        file_list.push(Value::String(url));
    }
    Ok(Json(ApiResponse::ok(Value::from(file_list))))
}

pub async fn delete_file(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<DeleteFileRequest>,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = match state
        .user_service
        .resolve_user_ns_with_override(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
    {
        Ok(ns) => ns,
        Err(_) => {
            return Ok(Json(ApiResponse::err_with_data(
                "请登录后使用",
                Value::String("NEED_LOGIN".to_string()),
            )))
        }
    };
    let url = req.url.unwrap_or_default();
    if url.is_empty() {
        return Ok(Json(ApiResponse::err("请输入文件链接")));
    }
    let prefix = format!("/assets/{}/", user_ns);
    if !url.starts_with(&prefix) {
        return Ok(Json(ApiResponse::err("文件链接错误")));
    }
    let relative = url.strip_prefix(&prefix).unwrap_or_default();
    if relative.is_empty() || relative.chars().any(|ch| matches!(ch, '\\' | '\0')) || Path::new(relative).components().any(|part| !matches!(part, Component::Normal(_))) {
        return Ok(Json(ApiResponse::err("文件链接错误")));
    }
    let full_path = PathBuf::from(&state.config.storage_dir)
        .join("assets")
        .join(&user_ns)
        .join(relative);
    let _ = fs::remove_file(full_path).await;
    Ok(Json(ApiResponse::ok(Value::String("".to_string()))))
}
