/**
 * Satellite SIM Balance API
 * Scrapes IBIS GlobalBeam portal to return prepay balance + expiry for a given ICCID.
 * Deploy on Railway.app (set IBIS_USERNAME and IBIS_PASSWORD env vars).
 */

const express = require('express');
const puppeteer = require('puppeteer');
const rateLimit = require('express-rate-limit');

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

    // Fill username – try common ASP.NET Identity field names
    await sessionPage.evaluate((user, pass) => {
      const userField =
        document.querySelector('input[name="UserName"]') ||
        document.querySelector('input[name="Username"]') ||
        document.querySelector('input[id*="UserName"]') ||
        document.querySelector('input[id*="Username"]') ||
        document.querySelector('input[type="text"]');

      const passField =
        document.querySelector('input[name="Password"]') ||
        document.querySelector('input[id*="Password"]') ||
        document.querySelector('input[type="password"]');

      if (userField) { userField.value = user; userField.dispatchEvent(new Event('input', { bubbles: true })); }
      if (passField) { passField.value = pass; passField.dispatchEvent(new Event('input', { bubbles: true })); }
    }, process.env.IBIS_USERNAME || '', process.env.IBIS_PASSWORD || '');

    // Submit the form
    await Promise.all([
      sessionPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      sessionPage.click('button[type="submit"], input[type="submit"]')
    ]);

    const url = sessionPage.url();
    if (url.toLowerCase().includes('login')) {
      throw new Error('Login failed – check IBIS_USERNAME and IBIS_PASSWORD environment variables.');
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
  await sleep(3000); // let the ASP.NET grid re-render

  // ── Extract results from the table ───────────────────────────────────────────
  const result = await sessionPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));

    // Find the sub-header row that contains "Balance" and "Expiry"
    // (The table has merged headers with a sub-row listing individual column names)
    let subHeaderRow = null;
    let colMap = {};   // column name → cell index

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const texts = cells.map(c => c.textContent.trim());

      if (texts.includes('Balance') || texts.includes('Expiry')) {
        subHeaderRow = row;
        texts.forEach((t, i) => { if (t) colMap[t] = i; });
        break;
      }
    }

    if (!subHeaderRow) {
      // Try to find the most-column header row as fallback
      let maxCols = 0;
      for (const row of rows) {
        const cells = row.querySelectorAll('th');
        if (cells.length > maxCols) { maxCols = cells.length; subHeaderRow = row; }
      }
      if (subHeaderRow) {
        Array.from(subHeaderRow.querySelectorAll('th')).forEach((th, i) => {
          if (th.textContent.trim()) colMap[th.textContent.trim()] = i;
        });
      }
    }

    if (!subHeaderRow) return { found: false, reason: 'Could not find column headers' };

    // Find the first data row AFTER the filter row
    // Filter row = a <tr> that contains <input> elements
    let passedFilterRow = false;
    let dataRow = null;

    let foundSubHeader = false;
    for (const row of rows) {
      if (row === subHeaderRow) { foundSubHeader = true; continue; }
      if (!foundSubHeader) continue;

      // Skip rows that are filter rows (contain inputs)
      if (row.querySelector('input')) { passedFilterRow = true; continue; }
      if (!passedFilterRow) continue;

      const cells = row.querySelectorAll('td');
      if (cells.length > 3) {
        dataRow = row;
        break;
      }
    }

    if (!dataRow) return { found: false, reason: 'No data rows found after filter' };

    const dataCells = Array.from(dataRow.querySelectorAll('td'));

    // Helper to get a cell value by column name
    function col(name) {
      const idx = colMap[name];
      return (idx !== undefined && dataCells[idx]) ? dataCells[idx].textContent.trim() : null;
    }

    // Also try getting the last two cells for Balance/Expiry (they're always last)
    const lastTwo = dataCells.slice(-2);

    return {
      found: true,
      iccid:            col('ICCID'),
      msisdn:           col('Master MSISDN'),
      product:          col('Product'),
      status:           col('Status'),
      name:             col('Name'),
      lastUsed:         col('Last Used'),
      location:         col('Location'),
      subscriptionName: col('Name') || col('Subscription'),
      planId:           col('ID'),
      planName:         col('Name.1') || col('Name'),
      balance:          col('Balance') || lastTwo[0]?.textContent.trim() || null,
      expiry:           col('Expiry')  || lastTwo[1]?.textContent.trim() || null,
      totalColumns:     dataCells.length,
      colMap:           colMap
    };
  });

  console.log('[lookup] Raw result:', JSON.stringify(result));
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
