use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

static EMBEDDED_PATH_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\{\s*(\$[^}]+)\}").expect("valid embedded JSONPath regex"));

pub fn jsonpath_query(value: &Value, rule: &str) -> Vec<Value> {
    if let Some(rendered) = render_embedded_paths(value, rule) {
        return vec![Value::String(rendered)];
    }
    if let Ok(res) = jsonpath_lib::select(value, rule) {
        let mut out = Vec::new();
        for item in res {
            match item {
                Value::Array(items) => {
                    out.extend(items.iter().cloned());
                }
                other => out.push(other.clone()),
            }
        }
        out
    } else {
        vec![]
    }
}

pub fn jsonpath_first_string(value: &Value, rule: &str) -> Option<String> {
    if let Some(rendered) = render_embedded_paths(value, rule) {
        return Some(rendered);
    }
    if let Some(field) = simple_object_field(rule) {
        return value.get(field).and_then(value_to_string);
    }
    let res = jsonpath_query(value, rule);
    res.first().and_then(|v| value_to_string(v))
}

fn simple_object_field(rule: &str) -> Option<&str> {
    let field = rule.trim().strip_prefix("$.")?;
    (!field.is_empty()
        && field
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')))
    .then_some(field)
}

pub fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Array(items) => Some(
            items
                .iter()
                .filter_map(value_to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Value::Object(_) => Some(v.to_string()),
    }
}

fn render_embedded_paths(value: &Value, rule: &str) -> Option<String> {
    if !rule.contains("{$") {
        return None;
    }
    let mut replaced_any = false;
    let rendered = EMBEDDED_PATH_RE
        .replace_all(rule, |captures: &regex::Captures| {
            replaced_any = true;
            let path = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
            jsonpath_first_string(value, path).unwrap_or_default()
        })
        .into_owned();
    if replaced_any {
        Some(rendered)
    } else {
        Some(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_simple_object_fields_without_general_jsonpath_parser() {
        let value = serde_json::json!({"chapterId": "42", "content_md5": "abc"});

        assert_eq!(
            jsonpath_first_string(&value, "$.chapterId").as_deref(),
            Some("42")
        );
        assert_eq!(
            jsonpath_first_string(
                &value,
                "https://book.test/{$.chapterId}?md5={$.content_md5}"
            )
            .as_deref(),
            Some("https://book.test/42?md5=abc")
        );
    }
}
