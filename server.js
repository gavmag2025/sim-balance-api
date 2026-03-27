/**
 * Satellite SIM Balance API
 * Scrapes IBIS GlobalBeam portal to return prepay balance + expiry for a given ICCID.
 * Deploy on Railway.app (set IBIS_USERNAME and IBIS_PASSWORD env vars).
 */

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const rateLimit = require('express-rate-limit');

// Make Puppeteer look like a real browser — prevents bot detection on login
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

const PORTAL_LOGIN  = 'https://ibisglobalbeam.satcomhost.com/Account/Login';
const PORTAL_SIMCARDS = 'https://ibisglobalbeam.satcomhost.com/SimcardsSimple.aspx';

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());

// Required for express-rate-limit to work correctly behind Railway's proxy
app.set('trust proxy', 1);

// Allow all origins so Wix embeds can call the API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 20 lookups per minute per IP – prevents abuse
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please wait a minute and try again.' }
}));

// ─── Browser / Session state ──────────────────────────────────────────────────

let browser = null;
let sessionPage = null;
let isLoggedIn = false;
let loginLock = false;

async function launchBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900'
    ]
  });
  console.log('[browser] Launched');
}

async function doLogin() {
  // Prevent parallel login attempts
  if (loginLock) {
    console.log('[login] Waiting for existing login to finish...');
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      if (!loginLock) break;
    }
    return;
  }

  loginLock = true;
  isLoggedIn = false;

  try {
    await launchBrowser();
    sessionPage = await browser.newPage();
    await sessionPage.setViewport({ width: 1280, height: 900 });
    await sessionPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('[login] Navigating to login page...');
    await sessionPage.goto(PORTAL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the username field to appear
    await sessionPage.waitForSelector('input[type="text"], input[name="UserName"]', { timeout: 15000 });

    // Find the exact selectors present on the page
    const { userSel, passSel } = await sessionPage.evaluate(() => {
      const u =
        document.querySelector('input[name="UserName"]')  ? 'input[name="UserName"]'  :
        document.querySelector('input[name="Username"]')  ? 'input[name="Username"]'  :
        document.querySelector('input[id*="UserName"]')   ? 'input[id*="UserName"]'   :
        'input[type="text"]';
      const p =
        document.querySelector('input[name="Password"]')  ? 'input[name="Password"]'  :
        document.querySelector('input[id*="Password"]')   ? 'input[id*="Password"]'   :
        'input[type="password"]';
      return { userSel: u, passSel: p };
    });

    console.log('[login] Using selectors:', userSel, passSel);

    // Use Puppeteer type() to simulate real keystrokes (more reliable than setting .value)
    await sessionPage.click(userSel, { clickCount: 3 });
    await sessionPage.type(userSel, process.env.IBIS_USERNAME || '', { delay: 50 });

    await sessionPage.click(passSel);
    await sessionPage.type(passSel, process.env.IBIS_PASSWORD || '', { delay: 50 });

    console.log('[login] Credentials typed, submitting...');

    // Submit via Enter key and wait for page to settle
    await sessionPage.keyboard.press('Enter');
    await sleep(8000); // wait for the redirect to complete

    const url = sessionPage.url();
    console.log('[login] Post-submit URL:', url);

    if (url.toLowerCase().includes('login')) {
      // Log any error message visible on the page to help diagnose
      const pageError = await sessionPage.evaluate(() => {
        const el = document.querySelector('.validation-summary-errors, .text-danger, [class*="error"], [class*="alert"]');
        return el ? el.textContent.trim() : 'No error message found on page';
      });
      console.log('[login] Page error message:', pageError);
      throw new Error('Login failed – credentials rejected by IBIS site. Page says: ' + pageError);
    }

    isLoggedIn = true;
    console.log('[login] Success. URL:', url);
  } finally {
    loginLock = false;
  }
}

async function ensureLoggedIn() {
  if (!sessionPage || sessionPage.isClosed()) {
    isLoggedIn = false;
  }
  if (!isLoggedIn) {
    await doLogin();
  }
}

// ─── Balance lookup ───────────────────────────────────────────────────────────

async function lookupSIM(iccid) {
  await ensureLoggedIn();

  console.log(`[lookup] Navigating to SIM cards page for ICCID: ${iccid}`);
  await sessionPage.goto(PORTAL_SIMCARDS, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // If session expired we land back on login page
  if (sessionPage.url().toLowerCase().includes('login')) {
    console.log('[lookup] Session expired – re-logging in...');
    isLoggedIn = false;
    await ensureLoggedIn();
    await sessionPage.goto(PORTAL_SIMCARDS, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  // Wait for the data table to appear
  await sessionPage.waitForSelector('table', { timeout: 15000 });

  // ── Find and fill the ICCID filter input ─────────────────────────────────────
  // Strategy: scan all <tr>s for one containing <input type="text"> and whose
  // cell index matches the column that has "ICCID" in a header row above it.
  const filled = await sessionPage.evaluate((iccidValue) => {
    const rows = Array.from(document.querySelectorAll('tr'));

    // Step 1: find the column index of "ICCID" in a header row
    let iccidColIndex = -1;
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td'));
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].textContent.trim() === 'ICCID') {
          iccidColIndex = i;
          break;
        }
      }
      if (iccidColIndex >= 0) break;
    }

    if (iccidColIndex < 0) {
      // Fallback: just use the first text input in any filter-looking row
      for (const row of rows) {
        const inputs = row.querySelectorAll('input[type="text"]');
        if (inputs.length > 0) {
          inputs[0].focus();
          inputs[0].value = iccidValue;
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, method: 'fallback' };
        }
      }
      return { found: false, reason: 'ICCID column not found' };
    }

    // Step 2: find a row that has an <input> in the ICCID column position
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, th'));
      if (iccidColIndex < cells.length) {
        const input = cells[iccidColIndex].querySelector('input[type="text"]') ||
                      cells[iccidColIndex].querySelector('input');
        if (input) {
          input.focus();
          input.value = iccidValue;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, method: 'column-match', colIndex: iccidColIndex };
        }
      }
    }

    return { found: false, reason: 'Filter input not found at ICCID column' };
  }, iccid);

  console.log('[lookup] Filter fill result:', filled);

  if (!filled.found) {
    throw new Error(`Could not find ICCID filter input on the page. Reason: ${filled.reason}`);
  }

  // Press Enter to submit the filter and wait for the grid to reload
  await sessionPage.keyboard.press('Enter');
  await sleep(5000); // let the ASP.NET grid re-render

  // ── Extract results from the table ───────────────────────────────────────────
  const result = await sessionPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));

    // Find the first data row: no <th>, no <input>/<select>, and has many columns
    let dataRow = null;
    for (const row of rows) {
      if (row.querySelector('th, input, select')) continue;
      const cells = row.querySelectorAll('td');
      if (cells.length >= 10) { dataRow = row; break; }
    }

    if (!dataRow) return { found: false, reason: 'No data rows found' };

    const values = Array.from(dataRow.querySelectorAll('td')).map(td => td.textContent.trim());
    return { found: true, _values: values, iccid: '', msisdn: '', product: '', status: 'debug', location: '', lastUsed: '', expiry: '', balance: '', planName: '' };

    // ── Pattern-based extraction (immune to colspan/rowspan header layout) ──

    // ICCID: 17–22 digit string
    const iccid = values.find(v => /^\d{17,22}$/.test(v)) || '';

    // MSISDN: 10–15 digits, different from ICCID
    const msisdn = values.find(v => /^\d{10,16}$/.test(v) && v !== iccid) || '';

    // Status: exact known values
    const status = values.find(v =>
      /^(Activated|Expired|Not Activated|Active|Inactive|Suspended)$/i.test(v)
    ) || 'Unknown';

    // Product: 2–6 uppercase letters (e.g. GSPS, BGAN)
    const product = values.find(v => /^[A-Z]{2,6}$/.test(v)) || '';

    // Location: 2–3 uppercase letter country code, different from product
    const location = values.find(v => /^[A-Z]{2,3}$/.test(v) && v !== product) || '';

    // All dates in the row (format: "11 Jul 2025")
    const dates = values.filter(v => /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(v));
    const lastUsed = dates[0] || 'N/A';
    const expiry   = dates[dates.length - 1] || 'N/A'; // Expiry is always the last date

    // Balance: decimal number (e.g. 47.25) in the last 5 cells (Prepay section is at the end)
    const lastFive = values.slice(-5);
    const balance  = lastFive.find(v => /^\d+\.\d{2}$/.test(v)) || '0';

    // Plan name: text containing "Plan" or "Prepay"
    const planName = values.find(v =>
      v.length > 5 && (v.toLowerCase().includes('plan') || v.toLowerCase().includes('prepay'))
    ) || '';

    return { found: true, iccid, msisdn, product, status, location, lastUsed, expiry, balance, planName };
  });

  console.log('[lookup] Raw cell values:', JSON.stringify(result._values));
  console.log('[lookup] Total cells found:', result._values ? result._values.length : 0);
  return result;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', loggedIn: isLoggedIn, timestamp: new Date().toISOString() });
});

app.post('/api/balance', async (req, res) => {
  const { iccid } = req.body || {};

  if (!iccid || typeof iccid !== 'string') {
    return res.status(400).json({ error: 'iccid is required.' });
  }

  const clean = iccid.replace(/\s+/g, '');

  if (!/^\d{15,22}$/.test(clean)) {
    return res.status(400).json({
      error: 'Invalid ICCID format. Must be 15–22 digits (no spaces or dashes).'
    });
  }

  try {
    const data = await lookupSIM(clean);

    if (!data.found) {
      return res.status(404).json({
        error: 'SIM card not found. Check the ICCID and try again.',
        detail: data.reason
      });
    }

    return res.json({
      iccid:    data.iccid    || clean,
      msisdn:   data.msisdn   || '',
      product:  data.product  || '',
      status:   data.status   || 'Unknown',
      balance:  data.balance  || '0',
      expiry:   data.expiry   || 'N/A',
      plan:     data.planName || data.subscriptionName || '',
      lastUsed: data.lastUsed || 'N/A',
      location: data.location || ''
    });

  } catch (err) {
    console.error('[api] Error:', err.message);

    // Reset session so next request retries login cleanly
    isLoggedIn = false;

    return res.status(500).json({
      error: 'Failed to retrieve balance. Please try again in a moment.'
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);

  // Warm up: log in at startup so the first user request is fast
  ensureLoggedIn().catch(err => {
    console.error('[startup] Initial login failed:', err.message);
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[server] Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
