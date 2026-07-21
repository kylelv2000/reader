use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct User {
    pub username: String,
    pub password: String,
    pub salt: String,
    pub token: String,
    #[serde(alias = "last_login_at", deserialize_with = "deserialize_i64_compat")]
    pub last_login_at: i64,
    #[serde(alias = "created_at", deserialize_with = "deserialize_i64_compat")]
    pub created_at: i64,
    #[serde(alias = "enable_webdav")]
    pub enable_webdav: bool,
    #[serde(
        alias = "token_map",
        deserialize_with = "deserialize_token_map_compat"
    )]
    pub token_map: Option<HashMap<String, i64>>,
    #[serde(alias = "enable_local_store")]
    pub enable_local_store: bool,
    #[serde(alias = "is_admin")]
    pub is_admin: bool,
}

fn deserialize_i64_compat<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    value_to_i64(&value).ok_or_else(|| {
        serde::de::Error::custom(format!("expected integer-compatible timestamp, got {value}"))
    })
}

fn deserialize_token_map_compat<'de, D>(
    deserializer: D,
) -> Result<Option<HashMap<String, i64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    let Some(Value::Object(entries)) = value else {
        return Ok(None);
    };

    let mut sessions = HashMap::with_capacity(entries.len());
    for (token, expires_at) in entries {
        let expires_at = value_to_i64(&expires_at).ok_or_else(|| {
            serde::de::Error::custom(format!(
                "expected integer-compatible session expiry for token {token}"
            ))
        })?;
        sessions.insert(token, expires_at);
    }
    Ok(Some(sessions))
}

fn value_to_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number.as_f64().and_then(|number| {
                (number.is_finite()
                    && number.fract() == 0.0
                    && number >= i64::MIN as f64
                    && number <= i64::MAX as f64)
                    .then_some(number as i64)
            })
        }),
        Value::String(raw) => raw.parse::<i64>().ok().or_else(|| {
            raw.parse::<f64>().ok().and_then(|number| {
                (number.is_finite()
                    && number.fract() == 0.0
                    && number >= i64::MIN as f64
                    && number <= i64::MAX as f64)
                    .then_some(number as i64)
            })
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_legacy_floating_point_timestamps() {
        let user: User = serde_json::from_value(serde_json::json!({
            "last_login_at": 1672721759012.0,
            "created_at": "1672721759012.0",
            "token_map": {"session": 1672721759012.0}
        }))
        .unwrap();

        assert_eq!(user.last_login_at, 1_672_721_759_012);
        assert_eq!(user.created_at, 1_672_721_759_012);
        assert_eq!(
            user.token_map.unwrap().get("session"),
            Some(&1_672_721_759_012)
        );
    }

    #[test]
    fn rejects_fractional_timestamps() {
        assert!(serde_json::from_value::<User>(serde_json::json!({
            "lastLoginAt": 1.5
        }))
        .is_err());
    }
}
