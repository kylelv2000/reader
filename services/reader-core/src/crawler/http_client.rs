use once_cell::sync::Lazy;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{redirect::Policy, Client, Proxy};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::lookup_host;
use url::Url;

const PUBLIC_DNS_CACHE_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
struct PublicDnsCacheEntry {
    addresses: Vec<IpAddr>,
    expires_at: Instant,
}

#[derive(Deserialize)]
struct DnsGoogleResponse {
    #[serde(rename = "Status")]
    status: i32,
    #[serde(rename = "Answer", default)]
    answers: Vec<DnsGoogleAnswer>,
}

#[derive(Deserialize)]
struct DnsGoogleAnswer {
    data: String,
}

static PUBLIC_DNS_CACHE: Lazy<Mutex<HashMap<String, PublicDnsCacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

static PUBLIC_DNS_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        // Pin only the DNS verifier itself. This bypasses Clash fake-IP DNS,
        // while the actual book request still follows the host's normal route.
        .resolve("dns.google", "8.8.8.8:443".parse().expect("valid DNS endpoint"))
        .timeout(Duration::from_secs(6))
        .connect_timeout(Duration::from_secs(4))
        .redirect(Policy::none())
        .build()
        .expect("public DNS verifier client")
});

static PUBLIC_DNS_BLOCKING_CLIENT: Lazy<reqwest::blocking::Client> = Lazy::new(|| {
    reqwest::blocking::Client::builder()
        .resolve("dns.google", "8.8.8.8:443".parse().expect("valid DNS endpoint"))
        .timeout(Duration::from_secs(6))
        .connect_timeout(Duration::from_secs(4))
        .redirect(Policy::none())
        .build()
        .expect("blocking public DNS verifier client")
});

/// Resolve outbound source hosts to the exact public addresses that passed the
/// SSRF check. This avoids validating a real address and then letting Clash's
/// fake-IP DNS choose a different destination for the actual request.
#[derive(Clone, Default)]
pub(crate) struct VerifiedPublicDnsResolver {
    internal_hosts: Arc<HashSet<String>>,
}

impl VerifiedPublicDnsResolver {
    fn for_http_client() -> Self {
        let mut internal_hosts = HashSet::new();
        if let Ok(value) = std::env::var("WEBVIEW_BRIDGE_URL") {
            if let Ok(url) = Url::parse(&value) {
                if let Some(host) = url.host_str() {
                    internal_hosts.insert(host.trim_end_matches('.').to_ascii_lowercase());
                }
            }
        }
        Self {
            internal_hosts: Arc::new(internal_hosts),
        }
    }
}

impl Resolve for VerifiedPublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().trim_end_matches('.').to_ascii_lowercase();
        let internal = self.internal_hosts.contains(&host);
        Box::pin(async move {
            let addresses = if internal {
                lookup_host((host.as_str(), 0))
                    .await
                    .map(|items| items.map(|item| item.ip()).collect::<Vec<_>>())
                    .map_err(|error| anyhow::anyhow!(error))?
            } else if let Ok(address) = host.parse::<IpAddr>() {
                if is_private_address(address) {
                    return Err(anyhow::anyhow!("private network targets are blocked").into());
                }
                vec![address]
            } else {
                resolve_public_dns(&host).await?
            };
            let socket_addresses = addresses
                .into_iter()
                .map(|address| SocketAddr::new(address, 0))
                .collect::<Vec<_>>();
            Ok(Box::new(socket_addresses.into_iter()) as Addrs)
        })
    }
}

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
            .dns_resolver(Arc::new(VerifiedPublicDnsResolver::for_http_client()))
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

fn cached_public_dns(host: &str) -> Option<Vec<IpAddr>> {
    let mut cache = PUBLIC_DNS_CACHE.lock().unwrap_or_else(|error| error.into_inner());
    cache.retain(|_, entry| entry.expires_at > Instant::now());
    cache.get(host).map(|entry| entry.addresses.clone())
}

fn cache_public_dns(host: &str, addresses: &[IpAddr]) {
    PUBLIC_DNS_CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            host.to_string(),
            PublicDnsCacheEntry {
                addresses: addresses.to_vec(),
                expires_at: Instant::now() + PUBLIC_DNS_CACHE_TTL,
            },
        );
}

fn validate_public_dns_addresses(host: &str, addresses: Vec<IpAddr>) -> anyhow::Result<Vec<IpAddr>> {
    if addresses.is_empty() || addresses.iter().copied().any(is_private_address) {
        return Err(anyhow::anyhow!(
            "public DNS confirms that {host} resolves to a blocked network"
        ));
    }
    cache_public_dns(host, &addresses);
    Ok(addresses)
}

async fn query_public_dns(host: &str, record_type: &str) -> anyhow::Result<Vec<IpAddr>> {
    let url = format!(
        "https://dns.google/resolve?name={}&type={record_type}",
        urlencoding::encode(host)
    );
    let response = PUBLIC_DNS_CLIENT
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json::<DnsGoogleResponse>()
        .await?;
    if response.status != 0 {
        return Ok(Vec::new());
    }
    Ok(response
        .answers
        .into_iter()
        .filter_map(|answer| answer.data.parse::<IpAddr>().ok())
        .collect())
}

async fn resolve_public_dns(host: &str) -> anyhow::Result<Vec<IpAddr>> {
    if let Some(addresses) = cached_public_dns(host) {
        return Ok(addresses);
    }
    let (ipv4, ipv6) = tokio::join!(
        query_public_dns(host, "A"),
        query_public_dns(host, "AAAA")
    );
    let mut addresses = ipv4.unwrap_or_default();
    addresses.extend(ipv6.unwrap_or_default());
    validate_public_dns_addresses(host, addresses)
}

fn query_public_dns_blocking(host: &str, record_type: &str) -> anyhow::Result<Vec<IpAddr>> {
    let url = format!(
        "https://dns.google/resolve?name={}&type={record_type}",
        urlencoding::encode(host)
    );
    let response = PUBLIC_DNS_BLOCKING_CLIENT
        .get(url)
        .send()?
        .error_for_status()?
        .json::<DnsGoogleResponse>()?;
    if response.status != 0 {
        return Ok(Vec::new());
    }
    Ok(response
        .answers
        .into_iter()
        .filter_map(|answer| answer.data.parse::<IpAddr>().ok())
        .collect())
}

fn resolve_public_dns_blocking(host: &str) -> anyhow::Result<Vec<IpAddr>> {
    if let Some(addresses) = cached_public_dns(host) {
        return Ok(addresses);
    }
    let mut addresses = query_public_dns_blocking(host, "A").unwrap_or_default();
    addresses.extend(query_public_dns_blocking(host, "AAAA").unwrap_or_default());
    validate_public_dns_addresses(host, addresses)
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
    resolve_public_dns(&normalized).await?;
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

    #[test]
    fn clash_fake_ip_literal_is_never_accepted_as_a_public_target() {
        assert!(ensure_public_url_blocking("http://198.18.7.9/").is_err());
    }

    #[test]
    fn public_dns_confirmation_still_rejects_private_targets() {
        assert!(validate_public_dns_addresses(
            "private.example",
            vec!["192.168.1.2".parse().unwrap()]
        )
        .is_err());
        assert!(validate_public_dns_addresses(
            "public.example",
            vec!["203.0.114.8".parse().unwrap()]
        )
        .is_ok());
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
    resolve_public_dns_blocking(&normalized)?;
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
