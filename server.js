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
  // Find the ICCID filter input.
  // Strategy: identify the grid header row by finding a row that contains MULTIPLE
  // known column names (ICCID + Status + Product). The autocomplete dropdown will
  // never have all three in the same row, so this uniquely identifies the real grid.
  const filterHandle = await sessionPage.evaluateHandle(() => {
    for (const table of document.querySelectorAll('table')) {
      for (const tr of table.querySelectorAll('tr')) {
        const cells = Array.from(tr.querySelectorAll('td, th'));
        const texts = cells.map(c => c.textContent.trim());

        // Must have ICCID, Status, AND Product in the same row = real grid header
        if (!texts.includes('ICCID') || !texts.includes('Status') || !texts.includes('Product')) continue;

        const iccidIndex = texts.indexOf('ICCID');
        console.log('Found grid header row, ICCID at index:', iccidIndex);

        // Walk sibling rows to find the filter row (first row after header with inputs)
        let sibling = tr.nextElementSibling;
        while (sibling) {
          const inputs = sibling.querySelectorAll('input[type="text"]');
          if (inputs.length > 0) {
            // Try to get input at the same column index as ICCID
            const sibCells = Array.from(sibling.querySelectorAll('td, th'));
            if (iccidIndex < sibCells.length) {
              const inp = sibCells[iccidIndex].querySelector('input[type="text"]') ||
                          sibCells[iccidIndex].querySelector('input');
              if (inp) return inp;
            }
            // Fallback: return the first input in the filter row
            return inputs[0];
          }
          sibling = sibling.nextElementSibling;
        }
      }
    }
    return null;
  });

  const filterElement = filterHandle.asElement();
  if (!filterElement) {
    throw new Error('Could not find ICCID filter input (grid header row with ICCID+Status+Product not found)');
  }

  console.log('[lookup] Found ICCID filter input via grid header detection');
  await filterElement.click({ clickCount: 3 });
  await filterElement.type(iccid, { delay: 30 });
  await sessionPage.keyboard.press('Enter');
  await sleep(5000); // let the ASP.NET grid re-render

  // ── Extract results from the table ───────────────────────────────────────────
  const result = await sessionPage.evaluate(() => {
    // Find the real data grid — a table with a header row containing ICCID+Status+Product
    let dataTable = null;
    for (const table of document.querySelectorAll('table')) {
      for (const tr of table.querySelectorAll('tr')) {
        const texts = Array.from(tr.querySelectorAll('td, th')).map(c => c.textContent.trim());
        if (texts.includes('ICCID') && texts.includes('Status') && texts.includes('Product')) {
          dataTable = table; break;
        }
      }
      if (dataTable) break;
    }
    if (!dataTable) return { found: false, reason: 'Data grid not found (no header row with ICCID+Status+Product)' };

    const rows = Array.from(dataTable.querySelectorAll('tr'));

    // Find the first data row: no <th>, no <input>/<select>, many columns, no placeholder text
    let dataRow = null;
    for (const row of rows) {
      if (row.querySelector('th, input, select')) continue;
      const cells = row.querySelectorAll('td');
      const text = row.textContent.trim();
      if (cells.length >= 10 && !text.includes('No data') && !text.includes('Loading')) {
        dataRow = row; break;
      }
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
