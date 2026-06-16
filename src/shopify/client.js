// src/shopify/client.js
// Shared Shopify Admin API client. Reuses the same env vars already in use
// by server.js (SHOP_DOMAIN, SHOPIFY_TOKEN) so credentials are not duplicated.
//
// Exposes:
//   - rest(path, opts)        : single REST request, returns parsed JSON
//   - restPaginated(path, opts, key) : async-iterator over REST pages via Link header
//   - graphql(query, variables) : Admin GraphQL request
//
// No secrets are logged. Errors include status + a short body excerpt for
// diagnostics only.

const fetch = require('node-fetch');

const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const BASE = SHOP ? `https://${SHOP}/admin/api/${API_VERSION}` : null;

function assertConfigured() {
  if (!SHOP || !TOKEN) {
    const err = new Error('Shopify is not configured (SHOP_DOMAIN / SHOPIFY_TOKEN missing)');
    err.code = 'SHOPIFY_DISABLED';
    throw err;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawFetch(url, init = {}) {
  assertConfigured();
  const headers = {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { ...init, headers });
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = parseFloat(res.headers.get('retry-after') || '1');
      const waitMs = Math.min(10_000, Math.max(500, retryAfter * 1000) * attempt);
      if (attempt < maxAttempts) {
        await sleep(waitMs);
        continue;
      }
    }
    return res;
  }
  // Should not reach here
  throw new Error('shopify fetch exhausted retries');
}

async function rest(pathOrUrl, opts = {}) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${BASE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  const res = await rawFetch(url, opts);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Shopify ${res.status} on ${url.replace(SHOP, '<shop>')}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { body, headers: res.headers, status: res.status };
}

/**
 * Async iterator over REST pages. Yields the entire page body each iteration.
 * `key` is the JSON key holding the array (e.g. 'products', 'orders').
 *
 * Example:
 *   for await (const page of restPaginated('/products.json?limit=250', {}, 'products')) {
 *     for (const product of page.products) { ... }
 *   }
 */
async function* restPaginated(initialPath, opts = {}, key) {
  let url = initialPath.startsWith('http')
    ? initialPath
    : `${BASE}${initialPath.startsWith('/') ? '' : '/'}${initialPath}`;
  while (url) {
    const { body, headers } = await rest(url, opts);
    yield body;
    const link = headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
    if (url && key && !Array.isArray(body[key])) {
      // Nothing returned for the expected key on this page — stop to avoid loops.
      url = null;
    }
  }
}

async function graphql(query, variables = {}) {
  assertConfigured();
  const url = `${BASE}/graphql.json`;
  const res = await rawFetch(url, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  if (!res.ok) {
    const err = new Error(`Shopify GraphQL ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (body.errors) {
    const err = new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors).slice(0, 200)}`);
    err.body = body;
    throw err;
  }
  return body.data;
}

module.exports = {
  SHOP,
  API_VERSION,
  BASE,
  rest,
  restPaginated,
  graphql,
  isConfigured: () => Boolean(SHOP && TOKEN),
};
