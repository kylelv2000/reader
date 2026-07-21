use crate::crawler::http_client::{ensure_public_url, HttpClient};
use encoding_rs::Encoding;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::env;
use std::time::Duration;
use tokio::time::sleep;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum HttpMethod {
    GET,
    POST,
}

impl Default for HttpMethod {
    fn default() -> Self {
        Self::GET
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestSpec {
    pub url: String,
    pub method: HttpMethod,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub retry: usize,
    pub response_type: Option<String>,
    pub charset: Option<String>,
    pub proxy: Option<String>,
    pub server_id: Option<i64>,
    pub web_view: bool,
    pub web_js: Option<String>,
    pub web_view_delay_time: u64,
}

impl Default for RequestSpec {
    fn default() -> Self {
        Self {
            url: String::new(),
            method: HttpMethod::GET,
            headers: Vec::new(),
            body: None,
            retry: 2,
            response_type: None,
            charset: None,
            proxy: None,
            server_id: None,
            web_view: false,
            web_js: None,
            web_view_delay_time: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchResponse {
    pub url: String,
    pub status: u16,
    pub body: String,
    pub content_type: Option<String>,
    pub headers: Vec<(String, String)>,
    pub is_successful: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct StrResponse {
    pub body: String,
    pub url: String,
    pub code: u16,
    pub headers: Vec<(String, String)>,
    pub is_successful: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebViewBridgeRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    web_js: Option<String>,
    delay_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebViewBridgeResponse {
    url: String,
    status: u16,
    body: String,
    content_type: Option<String>,
    headers: Vec<(String, String)>,
    is_successful: bool,
}

async fn fetch_with_webview(
    client: &HttpClient,
    req: &RequestSpec,
) -> anyhow::Result<FetchResponse> {
    let bridge_url = env::var("WEBVIEW_BRIDGE_URL").map_err(|_| {
        anyhow::anyhow!("source requires WebView but WEBVIEW_BRIDGE_URL is not configured")
    })?;
    let bridge_key = env::var("WEBVIEW_BRIDGE_KEY").unwrap_or_default();
    let payload = WebViewBridgeRequest {
        url: req.url.clone(),
        method: match req.method {
            HttpMethod::GET => "GET",
            HttpMethod::POST => "POST",
        }
        .to_string(),
        headers: req.headers.clone(),
        body: req.body.clone(),
        web_js: req.web_js.clone(),
        delay_ms: req.web_view_delay_time,
    };
    let response = client
        .client()
        .post(format!(
            "{}/v1/fetch",
            bridge_url.trim_end_matches('/')
        ))
        .header("x-webview-key", bridge_key)
        .json(&payload)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow::anyhow!(
            "WebView bridge returned {}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }
    let value: WebViewBridgeResponse = response.json().await?;
    Ok(FetchResponse {
        url: value.url,
        status: value.status,
        body: value.body,
        content_type: value.content_type,
        headers: value.headers,
        is_successful: value.is_successful,
    })
}

pub async fn fetch(client: &HttpClient, req: RequestSpec) -> anyhow::Result<FetchResponse> {
    if req.web_view {
        return fetch_with_webview(client, &req).await;
    }
    let mut last_err: Option<anyhow::Error> = None;
    let max_retries = req.retry;
    for attempt in 0..=max_retries {
        let req = req.clone();
        match send_with_safe_redirects(client, &req).await {
            Ok(res) => {
                let status = res.status().as_u16();
                let is_successful = res.status().is_success();
                let url = res.url().to_string();
                let content_type = res
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let headers = res
                    .headers()
                    .iter()
                    .filter_map(|(name, value)| {
                        value
                            .to_str()
                            .ok()
                            .map(|value| (name.to_string(), value.to_string()))
                    })
                    .collect::<Vec<_>>();
                let bytes = read_limited_body(res, 20 * 1024 * 1024).await?;
                let mut body = if req
                    .response_type
                    .as_deref()
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
                {
                    hex::encode(&bytes)
                } else {
                    decode_body(&bytes, req.charset.as_deref(), content_type.as_deref())
                };
                if is_xml_response(content_type.as_deref(), &body)
                    && !body.trim_start().starts_with("<?xml")
                {
                    body = format!("<?xml version=\"1.0\"?>{}", body);
                }
                if status >= 500 && attempt < max_retries {
                    last_err = Some(anyhow::anyhow!("server error status {}", status));
                } else {
                    return Ok(FetchResponse {
                        url,
                        status,
                        body,
                        content_type,
                        headers,
                        is_successful,
                    });
                }
            }
            Err(e) => {
                last_err = Some(e.into());
            }
        }

        if attempt < max_retries {
            let backoff = 200u64 * (attempt as u64 + 1);
            sleep(Duration::from_millis(backoff)).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("fetch failed")))
}

async fn send_with_safe_redirects(
    client: &HttpClient,
    req: &RequestSpec,
) -> anyhow::Result<reqwest::Response> {
    let mut target = ensure_public_url(&req.url).await?;
    let mut method = req.method.clone();
    for hop in 0..=5 {
        let mut builder = match method {
            HttpMethod::GET => client.client().get(target.clone()),
            HttpMethod::POST => client.client().post(target.clone()),
        };
        let mut has_content_type = false;
        for (name, value) in &req.headers {
            let lower = name.to_ascii_lowercase();
            if lower == "content-type" {
                has_content_type = true;
            }
            if matches!(lower.as_str(), "host" | "content-length" | "connection" | "proxy-authorization") || lower.starts_with("x-forwarded-") {
                continue;
            }
            builder = builder.header(name, value);
        }
        if matches!(method, HttpMethod::POST) {
            if !has_content_type {
                builder = builder.header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded");
            }
            if let Some(body) = &req.body {
                builder = builder.body(body.clone());
            }
        }
        let response = builder.send().await?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        if hop == 5 {
            return Err(anyhow::anyhow!("too many redirects"));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| anyhow::anyhow!("redirect has no valid location"))?;
        let next = target.join(location)?;
        target = ensure_public_url(next.as_str()).await?;
        if matches!(response.status().as_u16(), 301 | 302 | 303) {
            method = HttpMethod::GET;
        }
    }
    Err(anyhow::anyhow!("redirect failed"))
}

async fn read_limited_body(response: reqwest::Response, limit: usize) -> anyhow::Result<Vec<u8>> {
    if response.content_length().map(|size| size > limit as u64).unwrap_or(false) {
        return Err(anyhow::anyhow!("upstream response is too large"));
    }
    let mut data = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if data.len().saturating_add(chunk.len()) > limit {
            return Err(anyhow::anyhow!("upstream response is too large"));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

fn decode_body(bytes: &[u8], charset: Option<&str>, content_type: Option<&str>) -> String {
    let label = charset
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| charset_from_content_type(content_type))
        .or_else(|| charset_from_html_meta(bytes));

    if let Some(label) = label {
        if let Some(encoding) = Encoding::for_label(label.trim().as_bytes()) {
            let (text, _, _) = encoding.decode(bytes);
            return text.into_owned();
        }
    }

    String::from_utf8_lossy(bytes).into_owned()
}

fn charset_from_content_type(content_type: Option<&str>) -> Option<String> {
    content_type.and_then(|content_type| {
        content_type.split(';').find_map(|part| {
            let (key, value) = part.split_once('=')?;
            if key.trim().eq_ignore_ascii_case("charset") {
                let value = value.trim().trim_matches('"').trim_matches('\'');
                (!value.is_empty()).then(|| value.to_string())
            } else {
                None
            }
        })
    })
}

fn charset_from_html_meta(bytes: &[u8]) -> Option<String> {
    let sniff_len = bytes.len().min(4096);
    let head = String::from_utf8_lossy(&bytes[..sniff_len]);
    let lower = head.to_ascii_lowercase();
    let index = lower.find("charset")?;
    let after = &head[index + "charset".len()..];
    let after = after.trim_start();
    let after = after.strip_prefix('=').unwrap_or(after).trim_start();
    let after = after
        .strip_prefix('"')
        .or_else(|| after.strip_prefix('\''))
        .unwrap_or(after);
    let label = after
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .collect::<String>();
    (!label.is_empty()).then_some(label)
}

impl From<FetchResponse> for StrResponse {
    fn from(value: FetchResponse) -> Self {
        Self {
            body: value.body,
            url: value.url,
            code: value.status,
            headers: value.headers,
            is_successful: value.is_successful,
        }
    }
}

impl From<StrResponse> for FetchResponse {
    fn from(value: StrResponse) -> Self {
        Self {
            url: value.url,
            status: value.code,
            body: value.body,
            content_type: None,
            headers: value.headers,
            is_successful: value.is_successful,
        }
    }
}

fn is_xml_response(content_type: Option<&str>, body: &str) -> bool {
    content_type
        .map(|value| value.to_ascii_lowercase().contains("xml"))
        .unwrap_or(false)
        || body.trim_start().starts_with("<rss")
        || body.trim_start().starts_with("<feed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_body_uses_response_charset() {
        let bytes = b"\xd0\xa1\xcb\xb5\xca\xd5\xb2\xd8\xc5\xc5\xd0\xd0\xb0\xf1";

        let text = decode_body(bytes, None, Some("text/html; charset=gb2312"));

        assert_eq!(text, "小说收藏排行榜");
    }

    #[test]
    fn decode_body_detects_html_meta_charset() {
        let bytes = b"<meta http-equiv=\"content-type\" content=\"text/html;charset=gb2312\"><title>\xb7\xc9\xc2\xac\xd0\xa1\xcb\xb5</title>";

        let text = decode_body(bytes, None, None);

        assert!(text.contains("飞卢小说"));
    }
}
