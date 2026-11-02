import path from "node:path";

/**
 * Sign in through the API inside a Playwright browser context, so its cookies hold the session,
 * then save the storage state. Uses the bootstrap accounts from config.json; these only exist in
 * a local or CI database created by `rake bootstrap`.
 */
export async function signIn(browser, config, role, outFile) {
  const context = await browser.newContext({ baseURL: config.baseUrl });
  const req = context.request;
  const json = { headers: { "Content-Type": "application/json" } };
  if (role === "member") {
    const { phone } = config.logins.member;
    const start = await req.post("/api/v1/auth/start", { ...json, data: { phone, timezone: "America/Los_Angeles", terms_agreed: true } });
    if (!start.ok()) throw new Error(`member auth/start failed: ${start.status()} ${await start.text()}`);
    // Phones on MEMBER_SKIP_VERIFICATION_ALLOWLIST accept any code.
    const verify = await req.post("/api/v1/auth/verify", { ...json, data: { phone, token: "000000" } });
    if (!verify.ok()) throw new Error(`member auth/verify failed: ${verify.status()} ${await verify.text()}`);
  } else {
    throw new Error(`unknown role ${role}`);
  }
  await context.storageState({ path: outFile });
  await context.close();
  return path.resolve(outFile);
}
