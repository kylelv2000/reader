const coreOrigin = new URL(process.env.READER_CORE_ORIGIN || "http://reader-core:18080");
const username = String(process.env.YOMU_ADMIN_USERNAME || "").trim().toLowerCase();
const password = String(process.env.YOMU_ADMIN_PASSWORD || "");
const code = String(process.env.READER_INVITE_CODE || "");
const secureKey = String(process.env.READER_SECURE_KEY || "");

if (!/^[a-z0-9]{5,32}$/.test(username)) throw new Error("YOMU_ADMIN_USERNAME must be 5-32 lowercase letters or digits");
if (password.length < 12 || password.length > 128) throw new Error("YOMU_ADMIN_PASSWORD must be 12-128 characters");
if (!code) throw new Error("READER_INVITE_CODE is required for first-time setup");
if (secureKey.length < 24) throw new Error("READER_SECURE_KEY must be configured for first-time setup");

async function login(isLogin) {
  const response = await fetch(new URL("/reader3/login", coreOrigin), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-secure-key": secureKey },
    body: JSON.stringify({ username, password, code, isLogin }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const existing = await login(true);
if (existing.body?.isSuccess) {
  process.stdout.write(`Administrator ${username} already exists and the password is valid.\n`);
  process.exit(0);
}

const created = await login(false);
if (!created.body?.isSuccess) throw new Error(created.body?.errorMsg || `administrator setup failed (${created.status})`);
process.stdout.write(`Administrator ${username} was created. Remove YOMU_ADMIN_PASSWORD from your shell history and sign in through Yomu.\n`);
