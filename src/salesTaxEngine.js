const { google } = require('googleapis');
const { logger } = require('./logger');

class SalesTaxEngine {
  constructor(cloudbedsApi) {
    this.api = cloudbedsApi;
    this.sheetId = '1d_ywT_2aDX276hICeadrCkJKm_J4rPUSeXPkO0JpvpQ';
    this.serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    this.serviceAccountKey = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
  }

  getGoogleAuth() {
    if (!this.serviceAccountEmail || !this.serviceAccountKey) return null;
    return new google.auth.JWT(
      this.serviceAccountEmail, null, this.serviceAccountKey,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
  }

  toYMD(d) { return d.toISOString().slice(0,10); }

  async generateReport(targetMonth, targetYear, useTax) {
    logger.info(`[SALES TAX] Generating report for ${targetMonth} ${targetYear} with $${useTax} use tax.`);
    
    const monthMap = { 'January':0, 'February':1, 'March':2, 'April':3, 'May':4, 'June':5, 'July':6, 'August':7, 'September':8, 'October':9, 'November':10, 'December':11 };
    const m = monthMap[targetMonth] || 0;
    
    const currentStart = new Date(targetYear, m, 1);
    const currentEnd = new Date(targetYear, m + 1, 0, 23, 59, 59); 
    
    let priorM = m - 1;
    let priorY = targetYear;
    if (priorM < 0) { priorM = 11; priorY -= 1; }
    const priorStart = new Date(priorY, priorM, 1);
    const priorEnd = new Date(priorY, priorM + 1, 0, 23, 59, 59);

    // Fetch raw data
    const [currTxns, priorTxns, currRes, priorRes] = await Promise.all([
      this.api.getTransactions(this.toYMD(currentStart), this.toYMD(currentEnd)),
      this.api.getTransactions(this.toYMD(priorStart), this.toYMD(priorEnd)),
      this.api.getReservations(this.toYMD(currentStart), this.toYMD(currentEnd)),
      this.api.getReservations(this.toYMD(priorStart), this.toYMD(priorEnd))
    ]);

    const currArr = this.buildRows(currRes.data || [], currTxns.data || [], currentStart, currentEnd);
    const priorArr = this.buildRows(priorRes.data || [], priorTxns.data || [], priorStart, priorEnd);

    const auth = this.getGoogleAuth();
    if (!auth) throw new Error("Google Service Account credentials missing in environment.");
    const sheets = google.sheets({ version: 'v4', auth });

    // Update Setup
    await sheets.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range: 'Setup!B4:B6',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [ [ `${targetMonth} ${targetYear}` ], [ targetYear ], [ useTax ] ] }
    });

    // Overwrite Raw_CurrentMonth
    await sheets.spreadsheets.values.clear({ spreadsheetId: this.sheetId, range: 'Raw_CurrentMonth!A2:Z' });
    if (currArr.length > 0) {
      await sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId, range: 'Raw_CurrentMonth!A2',
          valueInputOption: 'USER_ENTERED', resource: { values: currArr }
      });
    }

    // Overwrite Raw_PriorMonth
    await sheets.spreadsheets.values.clear({ spreadsheetId: this.sheetId, range: 'Raw_PriorMonth!A2:Z' });
    if (priorArr.length > 0) {
      await sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId, range: 'Raw_PriorMonth!A2',
          valueInputOption: 'USER_ENTERED', resource: { values: priorArr }
      });
    }

    // Allow Google Sheets formulas to compute
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Fetch computed output
    const summaryData = await sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: 'Tax_Summary!A1:I25' });
    const filingData = await sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: 'State_Filing!A1:D15' });

    return {
       success: true,
       summaryHtml: this.renderHtml('Tax Summary', summaryData.data.values),
       filingHtml: this.renderHtml('State Filing', filingData.data.values)
    };
  }

  renderHtml(title, rows) {
    if (!rows) return `<h3>${title} - No Data</h3>`;
    let html = `<h3>${title}</h3><table class="tax-table">`;
    rows.forEach((r, idx) => {
        html += '<tr>' + r.map((c, i) => {
           const v = c || '';
           return idx === 0 ? `<th>${v}</th>` : `<td>${v}</td>`;
        }).join('') + '</tr>';
    });
    html += '</table>';
    return html;
  }

  buildRows(reservations, transactions, monthStart, monthEnd) {
    const resMap = {};
    for (const r of reservations) {
        resMap[r.reservationID] = {
            id: r.reservationID, guestName: r.guestName || r.guestNameString || 'Unknown', 
            checkIn: r.startDate || r.checkInDate || this.toYMD(monthStart),
            checkOut: r.endDate || r.checkOutDate || this.toYMD(monthEnd),
            source: r.source || r.sourceID || 'Direct',
            exempt: false, roomRev: 0, petFees: 0, other: 0, bar: 0, adj: 0
        };
    }

    for (const t of transactions) {
        if (t.transactionVoid === '1' || t.transactionVoid === true) continue;
        if (t.transactionType === 'Payment') continue;
        
        const rID = t.reservationID || 'Unassigned';
        if (!resMap[rID]) {
             resMap[rID] = {
                id: rID, guestName: 'Unknown', checkIn: this.toYMD(monthStart), checkOut: this.toYMD(monthEnd),
                source: 'Unknown', exempt: false, roomRev: 0, petFees: 0, other: 0, bar: 0, adj: 0
             };
        }

        const rvType = t.roomRevenueType || '';
        const tType = t.transactionType || '';
        const desc = t.transactionCodeDescription || '';
        const amt = parseFloat(t.transactionAmount || 0);

        if (desc.toLowerCase().includes('exempt') || resMap[rID].source.toLowerCase().includes('gov-sd')) {
            resMap[rID].exempt = true;
        }

        if (rvType === 'Room Rate') resMap[rID].roomRev += amt;
        else if (desc.toLowerCase().includes('pet')) resMap[rID].petFees += amt;
        else if (desc === 'Rate - Adjustment') resMap[rID].adj += amt;
        else if (tType === 'Items & Services' && (desc.toLowerCase().includes('bar') || desc.toLowerCase().includes('drink'))) resMap[rID].bar += amt;
        else resMap[rID].other += amt;
    }

    const rows = [];
    for (const r of Object.values(resMap)) {
       if (r.roomRev === 0 && r.petFees === 0 && r.other === 0 && r.bar === 0 && r.adj === 0) continue;

       const ci = new Date(r.checkIn);
       const co = new Date(r.checkOut);
       
       const overlapStart = ci > monthStart ? ci : monthStart;
       const overlapEnd = co < monthEnd ? co : monthEnd;
       let nights = Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 86400000);
       if (nights < 0) nights = 0;

       rows.push([ r.id, r.guestName, r.checkIn, r.checkOut, nights, r.source, r.exempt, r.roomRev, r.petFees, r.other, r.bar, r.adj ]);
    }
    return rows;
  }
}

module.exports = { SalesTaxEngine };
