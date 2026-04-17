const { google } = require('googleapis');
const { logger } = require('./logger');

class HousekeepingAssigner {
  constructor(cloudbedsApi) {
    this.api = cloudbedsApi;
    this.sheetId = process.env.GOOGLE_SHEET_ID;
    this.serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    this.serviceAccountKey = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
    
    // Weight constants (minutes roughly)
    this.WEIGHT_CHECKOUT = 45;
    this.WEIGHT_STAYOVER = 10;
  }

  getGoogleAuth() {
    if (!this.serviceAccountEmail || !this.serviceAccountKey) return null;
    return new google.auth.JWT(
      this.serviceAccountEmail, null, this.serviceAccountKey,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
  }

  async run6AMAssignment() {
    logger.info('[HOUSEKEEPING] Starting 6:00 AM Assignment Engine...');

    // 1. Fetch available Housekeepers from Google Sheets (or fallback)
    const housekeepers = await this.fetchHousekeepersRoster();
    if (housekeepers.length === 0) {
      logger.error('[HOUSEKEEPING] 0 Housekeepers found! Cannot run assignment.');
      return;
    }
    logger.info(`[HOUSEKEEPING] Found ${housekeepers.length} active housekeepers for today.`);

    // 2. Fetch native Dirty Rooms from Cloudbeds
    const query = await this.api.getHousekeepingStatus();
    let dirtyRooms = [];
    if (query.success && query.data) {
      // Filter only dirty rooms
      dirtyRooms = query.data.filter(r => r.roomCondition.includes('dirty'));
    } else {
      logger.error('[HOUSEKEEPING] Failed to fetch Cloudbeds housekeeping data.');
      return;
    }

    logger.info(`[HOUSEKEEPING] Found ${dirtyRooms.length} dirty rooms to clean.`);

    // 3. Run Optimization Clustering Algorithm
    const assignments = this.clusterRooms(dirtyRooms, housekeepers);

    // 4. Push Native Assignments to Cloudbeds API
    const finalPayload = [];
    for (const hk of assignments) {
       for (const room of hk.assignedRooms) {
           finalPayload.push({ roomID: room.roomID, housekeeperID: hk.id });
       }
    }
    await this.api.postHousekeepingAssignment(finalPayload);

    // 5. Append Log directly to Google Sheets Records Folder
    await this.logAssignmentToDrive(assignments);

    logger.info('[HOUSEKEEPING] 6:00 AM Assignment Engine Completed successfully!');
  }

  async fetchHousekeepersRoster() {
    const auth = this.getGoogleAuth();
    if (!auth || !this.sheetId) {
      logger.warn('[HOUSEKEEPING] No Google Auth. Using default 3 mock housekeepers.');
      return [ { id: "HK_1", name: "Maria" }, { id: "HK_2", name: "Rosa" }, { id: "HK_3", name: "Elena" } ];
    }
    try {
      const sheets = google.sheets({ version: 'v4', auth });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: 'Roster!A:B' // Assumes Date, Name format
      });
      
      const rows = response.data.values || [];
      const today = new Date().toISOString().split('T')[0];
      
      const todayStaff = rows.filter(r => r[0] === today).map((r, idx) => ({ id: `HK_${idx}`, name: r[1] }));
      return todayStaff.length > 0 ? todayStaff : [ { id: "HK_1", name: "Mock Staff 1" } ];
    } catch (e) {
      logger.warn(`[HOUSEKEEPING] Failed to read roster from Sheets: ${e.message}`);
      return [ { id: "HK_1", name: "Maria" }, { id: "HK_2", name: "Rosa" } ];
    }
  }

  clusterRooms(rooms, housekeepers) {
    // Determine weights for all rooms
    rooms.forEach(r => {
      r.weight = r.reservationCondition === 'checkout' ? this.WEIGHT_CHECKOUT : this.WEIGHT_STAYOVER;
      // Rooms start with their floor. 113 -> Floor 1, 204 -> Floor 2, 312 -> Floor 3
      r.floor = parseInt(r.roomID.charAt(0)); 
    });

    // Sort rooms by floor, then weight (heaviest first)
    rooms.sort((a, b) => {
      if (a.floor !== b.floor) return a.floor - b.floor;
      return b.weight - a.weight;
    });

    // Initialize buckets
    const buckets = housekeepers.map(hk => ({ id: hk.id, name: hk.name, totalWeight: 0, assignedRooms: [], activeFloor: null }));

    // Greedy load-balancer taking floor affinity into account
    for (const room of rooms) {
      // Find eligible buckets (buckets that already have rooms on this floor)
      let eligibleBuckets = buckets.filter(b => b.activeFloor === room.floor);
      
      if (eligibleBuckets.length === 0) {
         // If no bucket has this floor yet, all buckets are eligible. We pick the one with the lowest total Weight.
         eligibleBuckets = buckets;
      }

      // Find the absolute lowest weight bucket among the eligible ones
      eligibleBuckets.sort((a, b) => a.totalWeight - b.totalWeight);
      const targetBucket = eligibleBuckets[0];

      targetBucket.assignedRooms.push(room);
      targetBucket.totalWeight += room.weight;
      targetBucket.activeFloor = room.floor;
    }

    // Logging balance
    buckets.forEach(b => {
      logger.info(`[HOUSEKEEPING] ${b.name} -> Weight: ${b.totalWeight} | Rooms: ${b.assignedRooms.map(r => r.roomID).join(', ')}`);
    });

    return buckets;
  }

  async logAssignmentToDrive(assignments) {
    const auth = this.getGoogleAuth();
    if (!auth || !this.sheetId) return;

    try {
      const sheets = google.sheets({ version: 'v4', auth });
      const today = new Date().toISOString().split('T')[0];
      
      for (const bucket of assignments) {
        const roomsString = bucket.assignedRooms.map(r => `${r.roomID}(${r.reservationCondition})`).join(', ');
        await sheets.spreadsheets.values.append({
           spreadsheetId: this.sheetId,
           range: 'HousekeepingLogs!A:Z',
           valueInputOption: 'USER_ENTERED',
           resource: { values: [[ today, bucket.name, bucket.totalWeight, roomsString ]] }
        });
      }
      logger.info('[HOUSEKEEPING] Successfully logged assignment details to Google Sheets Database.');
    } catch (e) {
      logger.warn(`[HOUSEKEEPING] Failed to write log back to sheets: ${e.message}`);
    }
  }
}

module.exports = { HousekeepingAssigner };
