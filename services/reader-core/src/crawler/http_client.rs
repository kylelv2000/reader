use reqwest::{redirect::Policy, Client, Proxy};
use std::net::IpAddr;
use std::net::ToSocketAddrs;
use std::time::Duration;
use tokio::net::lookup_host;
use url::Url;

#[derive(Clone)]
pub struct HttpClient {
    client: Client,
}

impl HttpClient {
    pub fn new(timeout_secs: u64, proxy: Option<String>) -> anyhow::Result<Self> {
        let mut builder = Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .connect_timeout(Duration::from_secs(timeout_secs.min(10)))
            .pool_max_idle_per_host(2)
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(30))
            // Redirects are followed in fetcher.rs only after every target has
            // passed DNS/IP SSRF validation. A shared cookie jar would also
            // leak cookies between users that happen to use the same domain.
            .redirect(Policy::none())
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        if let Some(p) = proxy {
            builder = builder.proxy(Proxy::all(p)?);
        }
        let client = builder.build()?;
        Ok(Self { client })
    }

    pub fn client(&self) -> &Client {
        &self.client
    }
}

pub fn is_private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
                || a == 0
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || (a == 192 && b == 2)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224
        }
        IpAddr::V6(ip) => {
            if let Some(ipv4) = ip.to_ipv4_mapped() {
                return is_private_address(IpAddr::V4(ipv4));
            }
            let first = ip.segments()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first & 0xffc0) == 0xfec0
        }
    }
}

pub async fn ensure_public_url(value: &str) -> anyhow::Result<Url> {
    let url = validate_public_url_shape(value)?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL host is required"))?;
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if let Ok(address) = normalized.parse::<IpAddr>() {
        if is_private_address(address) {
            return Err(anyhow::anyhow!("private network targets are blocked"));
        }
        return Ok(url);
    }
    let port = url.port_or_known_default().ok_or_else(|| anyhow::anyhow!("URL port is invalid"))?;
    let addresses = lookup_host((normalized.as_str(), port)).await?;
    let resolved = addresses.map(|entry| entry.ip()).collect::<Vec<_>>();
    if resolved.is_empty() || resolved.into_iter().any(is_private_address) {
        return Err(anyhow::anyhow!("URL resolves to a blocked network"));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_mapped_private_addresses_are_blocked() {
        for value in [
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://169.254.169.254/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fec0::1]/",
        ] {
            assert!(ensure_public_url_blocking(value).is_err(), "{value}");
        }
    }

    #[test]
    fn public_literal_is_allowed_and_credentials_are_blocked() {
        assert!(ensure_public_url_blocking("https://1.1.1.1/").is_ok());
        assert!(ensure_public_url_blocking("https://user:pass@1.1.1.1/").is_err());
    }
}

pub fn ensure_public_url_blocking(value: &str) -> anyhow::Result<Url> {
    let url = validate_public_url_shape(value)?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL host is required"))?;
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if let Ok(address) = normalized.parse::<IpAddr>() {
        if is_private_address(address) {
            return Err(anyhow::anyhow!("private network targets are blocked"));
        }
        return Ok(url);
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("URL port is invalid"))?;
    let resolved = (normalized.as_str(), port)
        .to_socket_addrs()?
        .map(|entry| entry.ip())
        .collect::<Vec<_>>();
    if resolved.is_empty() || resolved.into_iter().any(is_private_address) {
        return Err(anyhow::anyhow!("URL resolves to a blocked network"));
    }
    Ok(url)
}

fn validate_public_url_shape(value: &str) -> anyhow::Result<Url> {
    let url = Url::parse(value)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(anyhow::anyhow!(
            "only public HTTP(S) URLs without embedded credentials are allowed"
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL host is required"))?;
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
    {
        return Err(anyhow::anyhow!("local targets are blocked"));
    }
    Ok(url)
}
