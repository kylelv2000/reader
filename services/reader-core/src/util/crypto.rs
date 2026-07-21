use crate::util::hash::md5_hex;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::{distributions::Alphanumeric, Rng};

pub fn random_string(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

pub fn gen_encrypted_password(password: &str, salt: &str) -> String {
    let first = md5_hex(&format!("{}{}", password, salt));
    md5_hex(&format!("{}{}", first, salt))
}

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| anyhow::anyhow!("password hashing failed: {error}"))
}

pub fn verify_password(password: &str, encoded: &str, legacy_salt: &str) -> bool {
    if encoded.starts_with("$argon2id$") {
        return PasswordHash::new(encoded)
            .ok()
            .map(|hash| Argon2::default().verify_password(password.as_bytes(), &hash).is_ok())
            .unwrap_or(false);
    }
    gen_encrypted_password(password, legacy_salt) == encoded
}
