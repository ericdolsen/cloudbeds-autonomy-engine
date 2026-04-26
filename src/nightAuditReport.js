const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const TOTAL_ROOMS = 50;

class NightAuditReport {
  constructor(cloudbedsApi) {
    this.api = cloudbedsApi;
    this.sheetId = '1L_y5a7nNvhaEqpt6VWGvtS3RuoBPFcSRAc9fJz3jqdw';
    this.serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    this.serviceAccountKey = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
    this.transactionsTab = process.env.GOOGLE_SHEET_TAB_TRANSACTIONS || 'NightAuditData';
  }

  toYMD(d) {
    if (typeof d === 'string') return d;
    const tzOffset = d.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(d.getTime() - tzOffset)).toISOString().slice(0, -1);
    return localISOTime.split('T')[0];
  }
  addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  addYears(d, n) { const r = new Date(d); r.setFullYear(r.getFullYear() + n); return r; }
  monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  yearStart(d) { return new Date(d.getFullYear(), 0, 1); }
  daysBetween(a, b) { return Math.round((b.getTime() - a.getTime()) / 86400000) + 1; }
  fmtMonth(d) { return d.toLocaleDateString('en-US', {month:'long', year:'numeric'}); }

  getGoogleAuth() {
    if (!this.serviceAccountEmail || !this.serviceAccountKey) return null;
    return new google.auth.GoogleAuth({
      credentials: { client_email: this.serviceAccountEmail, private_key: this.serviceAccountKey },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }

  async generatePdfBuffer(reportDate) {
    logger.info(`[NIGHT AUDIT] Gathering data to generate PDF for ${this.toYMD(reportDate)}...`);
    const lyDate = this.addYears(reportDate, -1);
    const ms = this.monthStart(reportDate);
    const ys = this.yearStart(reportDate);
    const lyMs = this.monthStart(lyDate);
    const lyYs = this.yearStart(lyDate);

    // Reservation queries filter on check-IN date. To capture every check-OUT
    // that lands within the reporting window, look back 31 days before each
    // window start so reservations with earlier check-ins but in-window
    // check-outs are returned.
    const ACTIVITY_LOOKBACK_DAYS = 31;
    const lb = (d) => this.addDays(d, -ACTIVITY_LOOKBACK_DAYS);

    // 1. Fetch live data for TODAY only
    const [tdOcc, tdTxns, lyOcc, mtdRes, ytdRes, lyMtdRes, lyYtdRes] = await Promise.all([
        this.api.getHouseCount(this.toYMD(reportDate)),
        this.api.getTransactions(this.toYMD(reportDate), this.toYMD(reportDate)),
        this.api.getHouseCount(this.toYMD(lyDate)),
        this.api.getReservations(this.toYMD(lb(ms)),   this.toYMD(reportDate)),
        this.api.getReservations(this.toYMD(lb(ys)),   this.toYMD(reportDate)),
        this.api.getReservations(this.toYMD(lb(lyMs)), this.toYMD(lyDate)),
        this.api.getReservations(this.toYMD(lb(lyYs)), this.toYMD(lyDate))
    ]);

    const tdFilter = (tdTxns.data || []);
    
    // 1.5 Fetch Historical MTD/YTD data from Google Sheets database
    const mtdTxnsData = await this.getTransactionsFromSheets(ms, reportDate);
    const ytdTxnsData = await this.getTransactionsFromSheets(ys, reportDate);
    const lyMtdTxnsData = await this.getTransactionsFromSheets(lyMs, lyDate);
    const lyYtdTxnsData = await this.getTransactionsFromSheets(lyYs, lyDate);

    const lyFilter = lyMtdTxnsData.filter(t => t.transactionDate === this.toYMD(lyDate));

    // 2. Build the exact EMBEDDED json object
    // Activity counters use date ranges so MTD/YTD reflect the full window, not just the report date.
    // For TD we pass the wider mtdRes list because tdRes (check-in window only) misses today's check-outs.
    const td   = { ...(tdOcc.data || {}), ...this.computeFromTransactions(tdFilter, reportDate, reportDate), ...this.computeActivity(mtdRes.data || [], reportDate, reportDate) };
    const mtd  = { ...this.computeFromTransactions(mtdTxnsData, ms, reportDate), ...this.computeActivity(mtdRes.data || [], ms, reportDate) };
    const ytd  = { ...this.computeFromTransactions(ytdTxnsData, ys, reportDate), ...this.computeActivity(ytdRes.data || [], ys, reportDate) };
    const ly   = { ...(lyOcc.data || {}), ...this.computeFromTransactions(lyFilter, lyDate, lyDate), ...this.computeActivity(lyMtdRes.data || [], lyDate, lyDate) };
    const ly_m = { ...this.computeFromTransactions(lyMtdTxnsData, lyMs, lyDate), ...this.computeActivity(lyMtdRes.data || [], lyMs, lyDate) };
    const ly_y = { ...this.computeFromTransactions(lyYtdTxnsData, lyYs, lyDate), ...this.computeActivity(lyYtdRes.data || [], lyYs, lyDate) };

    const dataObj = {
      report_date: this.toYMD(reportDate), ly_date: this.toYMD(lyDate),
      month_name: this.fmtMonth(reportDate), ly_month: this.fmtMonth(lyDate),
      td, mtd, ytd, ly, ly_m, ly_y
    };

    // 3. Inject into HTML
    const templatePath = path.join(__dirname, '..', 'Example files', 'GatewayPark_DailyReport.html');
    let htmlContent = '';
    try {
      htmlContent = fs.readFileSync(templatePath, 'utf8');
      const injectionStr = `const EMBEDDED = ${JSON.stringify(dataObj)};`;
      htmlContent = htmlContent.replace(/const EMBEDDED = \{[\s\S]*?\};/, injectionStr);
    } catch (e) {
      logger.error(`[NIGHT AUDIT] Error loading or parsing HTML file: ${e.message}`);
      return null;
    }

    // 4. Generate PDF via Playwright
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(htmlContent, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
    } catch (err) {
      logger.warn(`Page rendering issue (often safe to ignore if network timeouts): ${err.message}`);
    }
    const pdfBuffer = await page.pdf({ format: 'Letter', landscape: true, scale: 0.8, printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    await browser.close();

    return { pdfBuffer, tdFilter };
  }

  async runDailyAudit() {
    logger.info('[NIGHT AUDIT] Starting Headless PDF Engine Flow...');
    const today = new Date();
    const reportDate = this.addDays(today, -1);

    const result = await this.generatePdfBuffer(reportDate);
    if (!result) return;

    const { pdfBuffer, tdFilter } = result;

    // 5. Append transactions to Google Sheets ensuring independent database construction
    await this.appendTransactionsToSheets(tdFilter, this.toYMD(reportDate), {});

    // 6. Send the PDF email
    await this.sendPdfEmail(pdfBuffer, this.toYMD(reportDate));
  }


  // --- TRANSLATED MATH LOGIC REPLICAS ---
  computeFromTransactions(txns, startDate, endDate) {
    const start = this.toYMD(startDate), end = this.toYMD(endDate);
    const active = txns.filter(t => t.transactionVoid !== '1' && t.transactionVoid !== true);
    
    let rev = 0, items = 0, pay = 0, adj = 0;
    let rooms = new Set();

    for (const t of active) {
      if (t.transactionDate < start || t.transactionDate > end) continue;
      const amt = parseFloat(t.transactionAmount || 0);
      const type = t.transactionType || '';
      const rvType = t.roomRevenueType || '';
      const desc = t.transactionCodeDescription || '';

      // Gross Room Revenue
      if (rvType === 'Room Rate') {
        rev += amt;
        if (t.roomNumber) rooms.add(t.transactionDate + '_' + t.roomNumber);
      }

      // Room Rate Adjustments (Identify via 1000A code or description for Google Sheets historical data)
      const isRoomRateAdjustment = 
        (t.internalTransactionCode === '1000A') || 
        (desc === 'Room Rate' && amt < 0 && rvType !== 'Room Rate') ||
        (desc === 'Rate - Adjustment');

      if (isRoomRateAdjustment) {
        adj += amt;
        rev += amt; // Subtract from Net Room Revenue to match Native Cloudbeds output
      }

      if (['Items & Services','Add-On'].includes(type)) items += amt;
      if (type === 'Payment' && amt < 0) pay += Math.abs(amt);
    }

    const days = this.daysBetween(startDate, endDate);
    const rn = rooms.size;
    const adr = rn > 0 ? rev / rn : 0;
    const revpar = rev / (TOTAL_ROOMS * days);
    const occ_pct = rn / (TOTAL_ROOMS * days);

    return { rev, items, pay, adj, total_rev: rev + items, adr, revpar, occ_pct, occ: rn, rn };
  }

  computeActivity(reservations, startDate, endDate) {
    // For backwards compat: a single date arg becomes a single-day range.
    if (endDate === undefined) endDate = startDate;
    const startYMD = this.toYMD(startDate);
    const endYMD = this.toYMD(endDate);
    let ci=0, co=0, ns=0, wi=0, cx=0;
    const seenCI = new Set(), seenCO = new Set();
    for (const r of reservations) {
      const sd = r.startDate || '';
      const ed = r.endDate || '';
      if (sd >= startYMD && sd <= endYMD && !seenCI.has(r.reservationID)) {
        seenCI.add(r.reservationID);
        const status = r.status || '';
        if (['checked_in','checked_out'].includes(status)) ci++;
        if (status === 'no_show') ns++;
        if (status === 'canceled' || status === 'cancelled') cx++;
        const src = r.sourceID || r.source || '';
        if (src.toLowerCase().includes('walk')) wi++;
      }
      if (ed >= startYMD && ed <= endYMD && !seenCO.has(r.reservationID)) {
        seenCO.add(r.reservationID);
        if ((r.status||'') === 'checked_out') co++;
      }
    }
    return { ci, co, ns, wi, cx };
  }


  // --- GOOGLE SHEETS APP / READ ---
  async getTransactionsFromSheets(startDate, endDate) {
    const auth = this.getGoogleAuth();
    if (!auth || !this.sheetId) return [];
    try {
      const sheets = google.sheets({ version: 'v4', auth });
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: `${this.transactionsTab}!A:Z`
      });
      const rows = res.data.values || [];
      const startStr = typeof startDate === 'string' ? startDate : this.toYMD(startDate);
      const endStr = typeof endDate === 'string' ? endDate : this.toYMD(endDate);
      
      // Dedupe key strategy:
      //   - Rows with a real transactionID (column M) — use that as the key.
      //   - Legacy rows missing the ID — use a deterministic content composite
      //     so an exact-row duplicate (e.g. from a script re-run before the
      //     transactionID column existed) collapses into one entry. Two
      //     legitimately-identical legacy fees would also collapse, but the
      //     historical over-counting risk is the larger problem.
      const parsedMap = new Map();
      for (const r of rows) {
        if (!r[1] || r[1] === '-') continue;
        const tDate = r[1];
        if (tDate < startStr || tDate > endStr) continue;
        const realId = r[12] && r[12] !== '-' ? r[12] : null;
        const key = realId || `legacy|${r[1]}|${r[2]}|${r[3]}|${r[4]}|${r[5]}|${r[6]}|${r[7]}|${r[8]}`;
        parsedMap.set(key, {
          transactionDate: tDate,
          transactionAmount: r[2],
          transactionType: r[3],
          roomRevenueType: r[4],
          transactionCodeDescription: r[5],
          roomNumber: r[6] === '-' ? '' : r[6],
          reservationID: r[7] === '-' ? '' : r[7],
          transactionVoid: r[8] === 'Yes',
          transactionID: realId || key
        });
      }
      return Array.from(parsedMap.values());
    } catch(e) {
      logger.error(`[NIGHT AUDIT] Error reading from Sheets DB: ${e.message}`);
      return [];
    }
  }

  async appendTransactionsToSheets(transactions, dateStr, sharedCache = {}) {
    const auth = this.getGoogleAuth();
    if (!auth || !this.sheetId) {
      logger.error('[NIGHT AUDIT] *** SHEETS DB UNAVAILABLE *** — Google credentials or GOOGLE_SHEET_ID missing. Transaction data for ' + dateStr + ' will NOT be saved. Check GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SHEET_ID env vars.');
      return;
    }
    try {
      logger.info(`[NIGHT AUDIT] Appending ${transactions.length} transaction records to Google Sheets for ${dateStr} (tab: ${this.transactionsTab})...`);
      const sheets = google.sheets({ version: 'v4', auth });

      // Cache missing reservations
      const uniqueResIds = [...new Set(transactions.map(t => t.reservationID).filter(id => id && id !== '-'))];
      const missingIds = uniqueResIds.filter(id => !sharedCache[id]);
      
      if (missingIds.length > 0) {
        logger.info(`[NIGHT AUDIT] Resolving ${missingIds.length} missing reservation profiles for ${dateStr}...`);
        for (const id of missingIds) {
          const resData = await this.api.getReservationById(id);
          if (resData.success && resData.data) {
            sharedCache[id] = {
              checkIn: resData.data.startDate || '-',
              checkOut: resData.data.endDate || '-',
              groupName: resData.data.companyName || resData.data.allotmentBlockCode || '-'
            };
          } else {
            sharedCache[id] = { checkIn: '-', checkOut: '-', groupName: '-' };
          }
          await new Promise(r => setTimeout(r, 100)); // sleep to respect rate limits
        }
      }

      const values = transactions.map(t => {
        const c = sharedCache[t.reservationID] || { checkIn: '-', checkOut: '-', groupName: '-' };
        return [
          dateStr,
          t.transactionDate || '-',
          t.transactionAmount || '0',
          t.transactionType || '-',
          t.roomRevenueType || '-',
          t.transactionCodeDescription || '-',
          t.roomNumber || '-',
          t.reservationID || '-',
          t.transactionVoid ? 'Yes' : 'No',
          c.checkIn,
          c.checkOut,
          c.groupName,
          t.transactionID || '-'
        ];
      });

      if (values.length === 0) {
        values.push([dateStr, "NO_TRANSACTIONS_FOUND"]);
      }

      await sheets.spreadsheets.values.append({
         spreadsheetId: this.sheetId,
         range: `${this.transactionsTab}!A:Z`,
         valueInputOption: 'USER_ENTERED',
         resource: { values }
      });
      logger.info(`[NIGHT AUDIT] Successfully saved ${transactions.length} transactions for ${dateStr} to Google Sheets (tab: ${this.transactionsTab}).`);
    } catch(e) {
      logger.error(`[NIGHT AUDIT] *** SHEETS DB WRITE FAILED *** for ${dateStr} — ${e.message}. Verify the tab "${this.transactionsTab}" exists and the service account has Editor access to spreadsheet ID: ${this.sheetId}`);
    }
  }


  // --- EMAIL DISPATCH COMPONENT ---
  async sendPdfEmail(pdfBuffer, dateStr) {
    logger.info(`[NIGHT AUDIT] Packaging generated PDF and securely sending to Management List...`);
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      logger.warn(`[NIGHT AUDIT] SMTP credentials missing. Writing resulting PDF locally to directory for debug viewing...`);
      fs.writeFileSync(`Test_Report_${dateStr}.pdf`, pdfBuffer);
      return;
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    try {
      await transporter.sendMail({
        from: `"Cloudbeds Autonomy Module" <${process.env.SMTP_USER}>`,
        to: process.env.REPORT_EMAILS || 'management@hotel.com',
        subject: `[Audit] Daily Dashboard Report - ${dateStr}`,
        text: `The automated Cloudbeds Daily Report for ${dateStr} has been successfully rendered into a PDF document.\n\nPlease find the attached file matching the format configured by Gateway Park management.`,
        attachments: [
          { filename: `Daily_Report_${dateStr}.pdf`, content: pdfBuffer }
        ]
      });
      logger.info(`[NIGHT AUDIT] Daily report dispatched to executive mailboxes smoothly!`);
    } catch(e) {
      logger.error(`[NIGHT AUDIT] SMTP failure during transmission: ${e.message}`);
    }
  }
}

module.exports = { NightAuditReport };

