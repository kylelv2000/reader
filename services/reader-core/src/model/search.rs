use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchBook {
    pub name: String,
    pub author: String,
    pub book_url: String,
    pub origin: String,
    /// Human-readable source name so clients never have to resolve the origin
    /// URL against a source list they may not be able to see.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_name: Option<String>,
    /// Catalog URL resolved during source validation. Keeping it with the
    /// candidate makes a later source switch a cache-only operation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toc_url: Option<String>,
    pub cover_url: Option<String>,
    pub intro: Option<String>,
    pub kind: Option<String>,
    pub last_chapter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_chapter_num: Option<i32>,
    pub update_time: Option<String>,
    pub word_count: Option<String>,
    /// Book source URLs for the same book from different sources (for merged results)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_source_urls: Option<Vec<String>>,
}

impl SearchBook {
    /// Generate a key for merging books with same name and author
    pub fn merge_key(&self) -> String {
        let name = self.name.trim().to_lowercase();
        let author = self.author.trim().to_lowercase();
        format!("{}|{}", name, author)
    }
}
