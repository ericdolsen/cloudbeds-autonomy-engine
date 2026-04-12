const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { GoogleGenAI } = require('@google/genai');
const { logger } = require('./logger');

class NightAuditReport {
  constructor(cloudbedsApi) {
    this.api = cloudbedsApi;
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    // Auth for Google Sheets & Gmail will be built on these ENV vars
    this.sheetId = process.env.GOOGLE_SHEET_ID;
    this.serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    this.serviceAccountKey = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
  }

  getGoogleAuth() {
    if (!this.serviceAccountEmail || !this.serviceAccountKey) return null;
    const auth = new google.auth.JWT(
      this.serviceAccountEmail,
      null,
      this.serviceAccountKey,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    return auth;
  }

  async runDailyAudit() {
    logger.info('[NIGHT AUDIT] Starting 4:00 AM Automated Report Flow...');

    // 1. Fetch Yesterday's Delta
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    logger.info(`[NIGHT AUDIT] Pulling Cloudbeds reservations for ${dateStr}...`);
    
    let rawDailyData;
    try {
      // In cloudbedsApi.js, we will add getReservationsWithRateDetails
      rawDailyData = await this.api.getReservationsWithRateDetails(dateStr, dateStr); 
    } catch (e) {
      logger.error(`[NIGHT AUDIT] Cloudbeds API Fetch Failed: ${e.message}`);
      rawDailyData = { data: [] }; // fallback
    }

    // Process OTA vs Direct, No Shows, etc.
    const processedMetrics = this.processDailyMetrics(rawDailyData.data || []);
    
    // 2. Append to Google Sheets & Retrieve Historical 
    let historicalData = this.getMockHistoricalData(); // Fallback if no sheets keys
    const auth = this.getGoogleAuth();
    
    if (auth && this.sheetId) {
      logger.info(`[NIGHT AUDIT] Appending yesterday's metrics to Google Sheets Data Warehouse...`);
      try {
        const sheets = google.sheets({ version: 'v4', auth });
        // Example append:
        await sheets.spreadsheets.values.append({
           spreadsheetId: this.sheetId,
           range: 'Warehouse!A:Z',
           valueInputOption: 'USER_ENTERED',
           resource: { values: [[ dateStr, processedMetrics.totalBookings, processedMetrics.otaBookings, processedMetrics.directBookings, processedMetrics.totalRevenue, processedMetrics.adr ]] }
        });
        
        logger.info(`[NIGHT AUDIT] Reading YTD and LYTD historical stats from Google Sheets...`);
        // We assume your Google Sheet has a dashboard tab calculating LYTD and YTD natively from the appends
        const response = await sheets.spreadsheets.values.get({
           spreadsheetId: this.sheetId,
           range: 'DashboardStats!A2:E2' 
        });
        historicalData = response.data.values ? response.data.values[0] : historicalData;
      } catch (err) {
        logger.warn(`[NIGHT AUDIT] Sheets API Error: ${err.message}. Defaulting to mock historical data.`);
      }
    } else {
      logger.warn(`[NIGHT AUDIT] No Google Workspace keys found. Skipping Sheets Append and using Mock Historical Data.`);
    }

    // 3. Get 14 Day Forecast
    logger.info(`[NIGHT AUDIT] Pulling 14-Day Forward Forecast...`);
    const forecast = await this.api.getForecast(14);

    // 4. Generate AI Email Report
    logger.info(`[NIGHT AUDIT] Sending data matrix to Gemini 3.1 Pro for synthesis...`);
    const reportHtml = await this.generateReportHtml(processedMetrics, historicalData, forecast);

    // 5. Dispatch Email
    await this.sendEmail(reportHtml, dateStr);
  }

  processDailyMetrics(reservations) {
    let noShows = [];
    let otaBookings = 0;
    let directBookings = 0;
    let totalRevenue = 0;

    for (const res of reservations) {
      if (res.status === 'no_show') noShows.push(res.reservationId);
      if (res.source && res.source.toLowerCase().includes('ota')) {
        otaBookings++;
      } else {
        directBookings++;
      }
      totalRevenue += (res.total || 0);
    }

    const adr = reservations.length ? (totalRevenue / reservations.length).toFixed(2) : 0;
    return { totalBookings: reservations.length, otaBookings, directBookings, noShows, totalRevenue, adr: `$${adr}` };
  }

  getMockHistoricalData() {
    return {
      note: "MOCK DATA - Insert your Google Sheets API keys into .env to fetch live metrics.",
      metrics: {
        LD_OCC: "78%", PTD_OCC: "80%", YTD_OCC: "65%", LYP_OCC: "76%", LYTD_OCC: "62%",
        LD_ADR: "$145", PTD_ADR: "$140", YTD_ADR: "$135", LYP_ADR: "$138", LYTD_ADR: "$130"
      }
    };
  }

  async generateReportHtml(metrics, history, forecast) {
    const prompt = `You are a Master Hotel Data Analyst. Convert the following JSON matrix into a beautiful HTML email representing our Daily Night Audit Report.
    Use highly professional CSS styling inline (e.g. dark slate headers, clean grid tables with subtle borders). Make it look exactly like a high-end corporate executive summary. 
    
    REQUIREMENTS:
    1. Include a robust visual grid for Operational Stats (Occupancy, ADR, RevPAR comparing LD, PTD, YTD, LYP, LYTD).
    2. Include a highly visible section explicitly calling out the "No-Show Auditors" (flagging reservation IDs if any) so staff knows who didn't show up.
    3. Include a 14-Day Forecast graphical table.
    4. Include the OTA vs Direct Source breakdown pace.
    
    DATA MATRIX:
    Yesterday's Processed Metrics: ${JSON.stringify(metrics, null, 2)}
    Database Historical Stats: ${JSON.stringify(history, null, 2)}
    14-Day Forecast: ${JSON.stringify(forecast, null, 2)}
    
    Output ONLY valid HTML markup. Do not wrap the response with markdown backticks (like \`\`\`html).`;

    const chat = this.ai.chats.create({
        model: process.env.GEMINI_MODEL || 'gemini-3.1-pro',
        config: { temperature: 0.1 }
    });
    
    const response = await chat.sendMessage({ message: prompt });
    let html = response.text.trim();
    if (html.startsWith('\`\`\`html')) html = html.substring(7, html.length - 3).trim();
    return html;
  }

  async sendEmail(htmlContent, dateStr) {
    logger.info(`[NIGHT AUDIT] Dispatching email to stakeholders...`);
    
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      logger.warn(`[NIGHT AUDIT] SMTP Transport credentials not set in .env. Dumping HTML Report to console instead of emailing.`);
      console.log("\n=================== NIGHT AUDIT REPORT HTML PREVIEW ===================\n");
      console.log(htmlContent);
      console.log("\n=======================================================================\n");
      return;
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    try {
      await transporter.sendMail({
        from: `"Autonomy Engine" <${process.env.SMTP_USER}>`,
        to: process.env.REPORT_EMAILS || 'management@hotel.com',
        subject: `Night Audit Executive Report - ${dateStr}`,
        html: htmlContent
      });
      logger.info(`[NIGHT AUDIT] Successfully dispatched 4:00 AM Report securely via Google Workspace!`);
    } catch (e) {
      logger.error(`[NIGHT AUDIT] Email dispatch failed: ${e.message}`);
    }
  }
}

module.exports = { NightAuditReport };
