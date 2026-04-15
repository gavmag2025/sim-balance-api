/**
 * Satellite SIM Balance + CDR API
 * Scrapes IBIS GlobalBeam portal for prepay balance, expiry, and CDRs.
 * Deploy on Railway.app (set IBIS_USERNAME and IBIS_PASSWORD env vars).
 */

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const rateLimit = require('express-rate-limit');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

const PORTAL_LOGIN    = 'https://ibisglobalbeam.satcomhost.com/Account/Login';
const PORTAL_SIMCARDS = 'https://ibisglobalbeam.satcomhost.com/SimcardsSimple.aspx';
const PORTAL_CDRS     = 'https://ibisglobalbeam.satcomhost.com/RatedCdrs.aspx';

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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
    await sessionPage.waitForSelector('input[type="text"], input[name="UserName"]', { timeout: 15000 });

    const { userSel, passSel } = await sessionPage.evaluate(() => {
      const u =
        document.querySelector('input[name="UserName"]') ? 'input[name="UserName"]' :
        document.querySelector('input[name="Username"]') ? 'input[name="Username"]' :
        document.querySelector('input[id*="UserName"]')  ? 'input[id*="UserName"]'  :
        'input[type="text"]';
      const p =
        document.querySelector('input[name="Password"]') ? 'input[name="Password"]' :
        document.querySelector('input[id*="Password"]')  ? 'input[id*="Password"]'  :
        'input[type="password"]';
      return { userSel: u, passSel: p };
    });

    await sessionPage.click(userSel, { clickCount: 3 });
    await sessionPage.type(userSel, process.env.IBIS_USERNAME || '', { delay: 50 });
    await sessionPage.click(passSel);
    await sessionPage.type(passSel, process.env.IBIS_PASSWORD || '', { delay: 50 });

    console.log('[login] Submitting...');
    await sessionPage.keyboard.press('Enter');
    await sleep(8000);

    const url = sessionPage.url();
    console.log('[login] Post-submit URL:', url);

    if (url.toLowerCase().includes('login')) {
      const pageError = await sessionPage.evaluate(() => {
        const el = document.querySelector('.validation-summary-errors, .text-danger, [class*="error"], [class*="alert"]');
        return el ? el.textContent.trim() : 'No error message found on page';
      });
      throw new Error('Login failed: ' + pageError);
    }

    isLoggedIn = true;
    console.log('[login] Success');
  } finally {
    loginLock = false;
  }
}

async function ensureLoggedIn() {
  if (!sessionPage || sessionPage.isClosed()) isLoggedIn = false;
  if (!isLoggedIn) await doLogin();
}

// ─── Balance lookup ───────────────────────────────────────────────────────────

async function lookupSIM(iccid) {
  await ensureLoggedIn();

  console.log(`[lookup] SIM: ${iccid}`);
  await sessionPage.goto(PORTAL_SIMCARDS, { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (sessionPage.url().toLowerCase().includes('login')) {
    isLoggedIn = false;
    await ensureLoggedIn();
    await sessionPage.goto(PORTAL_SIMCARDS, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  await sessionPage.waitForSelector('input[id*="DXFREditorcol0"]', { timeout: 15000 });

  const filterInput = await sessionPage.$('input[id*="DXFREditorcol0"]');
  await filterInput.click({ clickCount: 3 });
  await filterInput.type(iccid, { delay: 40 });

  await sessionPage.evaluate(() => {
    const input = document.querySelector('input[id*="DXFREditorcol0"]');
    if (input) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof ASPx !== 'undefined' && input.id) {
        try { ASPx.EValueChanged(input.id.replace('_I', '')); } catch(e) {}
      }
    }
  });

  await sessionPage.keyboard.press('Enter');
  await sleep(5000);

  const result = await sessionPage.evaluate(() => {
    let dataRow = null;
    for (const row of document.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td.dxgv');
      if (cells.length < 10) continue;
      const text = row.textContent.trim();
      if (text.includes('No data') || text.includes('Loading')) continue;
      dataRow = row;
      break;
    }

    if (!dataRow) return { found: false, reason: 'No data row found after filter' };

    const expiryCell  = dataRow.querySelector('td.dxgv[style*="border-right-width:0px"]');
    const expiry      = expiryCell ? expiryCell.textContent.trim() : 'N/A';
    const balanceCell = expiryCell ? expiryCell.previousElementSibling : null;
    const balance     = balanceCell ? balanceCell.textContent.trim() : '0';
    const values      = Array.from(dataRow.querySelectorAll('td.dxgv')).map(c => c.textContent.trim());

    const iccid   = values.find(v => /^\d{17,22}$/.test(v)) || '';
    const msisdn  = values.find(v => /^\d{10,16}$/.test(v) && v !== iccid) || '';
    const status  = values.find(v => /^(Activated|Expired|Not Activated|Active|Inactive|Suspended)$/i.test(v)) || 'Unknown';
    const product = values.find(v => /^[A-Z]{2,6}$/.test(v)) || '';
    const location= values.find(v => /^[A-Z]{2,3}$/.test(v) && v !== product) || '';
    const dates   = values.filter(v => /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(v));
    const lastUsed= dates[0] || 'N/A';
    const planName= values.find(v => v.length > 5 && (v.toLowerCase().includes('plan') || v.toLowerCase().includes('prepay'))) || '';

    return { found: true, iccid, msisdn, product, status, location, lastUsed, expiry, balance, planName };
  });

  console.log('[lookup] Result:', JSON.stringify(result));
  return result;
}

// ─── CDR lookup ───────────────────────────────────────────────────────────────

async function lookupCDRs(iccid, period) {
  await ensureLoggedIn();

  console.log(`[cdrs] ICCID: ${iccid}, Period: ${period}`);

  // Navigate directly to CDR page for this ICCID
  const cdrUrl = `${PORTAL_CDRS}?FC=ICCID&FV=${encodeURIComponent(iccid)}`;
  await sessionPage.goto(cdrUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (sessionPage.url().toLowerCase().includes('login')) {
    isLoggedIn = false;
    await ensureLoggedIn();
    await sessionPage.goto(cdrUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  // Wait for page to settle
  await sleep(4000);

  // The billing period is a DevExpress combobox — find it and select the period
  // It renders as either a <select> OR a DevExpress custom dropdown
  const periodResult = await sessionPage.evaluate((period) => {
    // Try native select first
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options);
      if (!opts.some(o => /\d{6}/.test(o.value + o.text))) continue;
      const opt = opts.find(o => o.value.includes(period) || o.text.includes(period));
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { method: 'native-select', value: opt.value, text: opt.text };
      }
    }

    // Try DevExpress combobox — look for ASPxComboBox elements
    // They render as input + hidden select with id containing "ddl" or "BillingPeriod" or "Period"
    const inputs = Array.from(document.querySelectorAll('input[id*="Period"], input[id*="period"], input[id*="ddl"]'));
    for (const input of inputs) {
      // Find the corresponding hidden select
      const baseId = input.id.replace('_I', '');
      const hiddenSel = document.querySelector('select[id*="' + baseId + '"]') ||
                        document.querySelector('select[name*="Period"]') ||
                        document.querySelector('select[name*="period"]');
      if (hiddenSel) {
        const opt = Array.from(hiddenSel.options).find(o => o.value.includes(period) || o.text.includes(period));
        if (opt) {
          hiddenSel.value = opt.value;
          hiddenSel.dispatchEvent(new Event('change', { bubbles: true }));
          input.value = opt.text;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          // Trigger ASPx change
          try { ASPx.EValueChanged(baseId); } catch(e) {}
          return { method: 'dxcombo', value: opt.value, text: opt.text };
        }
      }
    }

    // Last resort — find ANY element containing the period value and click it
    const allOptions = Array.from(document.querySelectorAll('option, li, td'));
    const match = allOptions.find(el => el.textContent.trim().includes(period));
    if (match) {
      match.click();
      return { method: 'click', text: match.textContent.trim() };
    }

    // Return what dropdowns/selects we found for debugging
    const found = selects.map(s => ({
      id: s.id,
      name: s.name,
      opts: Array.from(s.options).slice(0,5).map(o => o.value + ':' + o.text)
    }));
    return { method: 'none', debug: found };
  }, period);

  console.log(`[cdrs] Period result:`, JSON.stringify(periodResult));

  if (!periodResult || periodResult.method === 'none') {
    // Try clicking the DevExpress dropdown button to open it, then select
    const clicked = await sessionPage.evaluate((period) => {
      // DevExpress comboboxes have a button with class dxb or similar
      const btns = Array.from(document.querySelectorAll('td[class*="dxb"], button[class*="dx"], img[class*="dxeB"]'));
      for (const btn of btns) {
        const parent = btn.closest('table') || btn.parentElement;
        if (!parent) continue;
        const text = parent.textContent;
        if (/\d{6}/.test(text) || /period|billing/i.test(parent.id || '')) {
          btn.click();
          return true;
        }
      }
      return false;
    }, period);

    if (clicked) {
      await sleep(2000);
      // Now try to find and click the period in the opened dropdown list
      await sessionPage.evaluate((period) => {
        const items = Array.from(document.querySelectorAll('td.dxeListBoxItem_MetropolisBlue, li, td[class*="List"]'));
        const match = items.find(el => el.textContent.includes(period));
        if (match) match.click();
      }, period);
      await sleep(4000);
    } else {
      return { found: false, reason: 'Could not find or interact with billing period dropdown. Debug: ' + JSON.stringify(periodResult) };
    }
  } else {
    // Period was selected via select/combo — wait for postback
    await sleep(6000);
  }

  // Extract CDR rows from the grid
  const rows = await sessionPage.evaluate(() => {
    const result = [];
    for (const row of document.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td.dxgv'));
      if (cells.length < 8) continue;
      const values = cells.map(c => c.textContent.trim());
      if (!values[0] || values[0].includes('No data') || values[0].includes('Loading')) continue;
      result.push({
        iccid:      values[0]  || '',
        product:    values[1]  || '',
        service:    values[2]  || '',
        originNum:  values[3]  || '',
        originCtry: values[4]  || '',
        destNum:    values[5]  || '',
        network:    values[6]  || '',
        country:    values[7]  || '',
        startCDR:   values[8]  || '',
        endCDR:     values[9]  || '',
        volData:    values[10] || '0',
        volMin:     values[11] || '0',
        volMsg:     values[12] || '0',
        cdrMoney:   values[13] || '0',
        cdrData:    values[14] || '0',
        cdrMin:     values[15] || '0',
        cdrMsg:     values[16] || '0',
        currency:   values[17] || '',
        cdrTotal:   values[18] || '0',
        inBundle:   values[19] || ''
      });
    }
    return result;
  });

  console.log(`[cdrs] Found ${rows.length} CDR rows`);
  return { found: true, rows };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', loggedIn: isLoggedIn, timestamp: new Date().toISOString() });
});

// Balance endpoint (existing — unchanged)
app.post('/api/balance', async (req, res) => {
  const { iccid } = req.body || {};
  if (!iccid || typeof iccid !== 'string')
    return res.status(400).json({ error: 'iccid is required.' });

  const clean = iccid.replace(/\s+/g, '');
  if (!/^\d{15,22}$/.test(clean))
    return res.status(400).json({ error: 'Invalid ICCID format. Must be 15–22 digits.' });

  try {
    const data = await lookupSIM(clean);
    if (!data.found)
      return res.status(404).json({ error: 'SIM card not found.', detail: data.reason });

    return res.json({
      iccid:    data.iccid    || clean,
      msisdn:   data.msisdn   || '',
      product:  data.product  || '',
      status:   data.status   || 'Unknown',
      balance:  data.balance  || '0',
      expiry:   data.expiry   || 'N/A',
      plan:     data.planName || '',
      lastUsed: data.lastUsed || 'N/A',
      location: data.location || ''
    });
  } catch (err) {
    console.error('[api/balance] Error:', err.message);
    isLoggedIn = false;
    return res.status(500).json({ error: 'Failed to retrieve balance. Please try again.' });
  }
});

// CDR endpoint (new)
app.post('/api/cdrs', async (req, res) => {
  const { iccid, period } = req.body || {};

  if (!iccid || typeof iccid !== 'string')
    return res.status(400).json({ error: 'iccid is required.' });
  if (!period || typeof period !== 'string' || !/^\d{6}$/.test(period))
    return res.status(400).json({ error: 'period is required in YYYYMM format (e.g. 202603).' });

  const clean = iccid.replace(/\s+/g, '');
  if (!/^\d{15,22}$/.test(clean))
    return res.status(400).json({ error: 'Invalid ICCID format. Must be 15–22 digits.' });

  try {
    const data = await lookupCDRs(clean, period);

    if (!data.found)
      return res.status(404).json({ error: 'No CDR data found.', detail: data.reason });

    return res.json({
      iccid:  clean,
      period: period,
      count:  data.rows.length,
      rows:   data.rows
    });
  } catch (err) {
    console.error('[api/cdrs] Error:', err.message);
    isLoggedIn = false;
    return res.status(500).json({ error: 'Failed to retrieve CDRs. Please try again.' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  ensureLoggedIn().catch(err => {
    console.error('[startup] Initial login failed:', err.message);
  });
});

process.on('SIGTERM', async () => {
  console.log('[server] Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
