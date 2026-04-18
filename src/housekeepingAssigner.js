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

    // In-memory assignment state for intraday webhook pinning
    this.pinnedAssignments = new Map(); // roomID -> housekeeperID
    this.lastAssignmentDate = null;
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
      dirtyRooms = query.data.filter(r => r.roomCondition && r.roomCondition.toLowerCase().includes('dirty'));
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
        range: 'WeeklySchedule!A:Z' 
      });
      
      const rows = response.data.values || [];
      const today = new Date().toISOString().split('T')[0];
      
      let dateColIndex = -1;
      let dateRowIndex = -1;

      // Scan entirely from bottom to top so that if they paste a new week under the old week, we always hit the latest one!
      for (let r = rows.length - 1; r >= 0; r--) {
         const cIdx = rows[r].indexOf(today);
         if (cIdx !== -1) {
             dateColIndex = cIdx;
             dateRowIndex = r;
             break;
         }
      }

      if (dateColIndex === -1) {
         logger.warn(`[HOUSEKEEPING] Could not find today's date (${today}) in WeeklySchedule.`);
         return [];
      }

      const todayStaff = [];

      // Scan rows beneath the date headers
      for (let r = dateRowIndex + 1; r < rows.length; r++) {
         const row = rows[r];
         const name = row[0];
         const shiftText = row[dateColIndex];

         // Pull valid names and shift fields.
         if (name && shiftText && typeof shiftText === 'string') {
             // If any cell under today's column contains the word 'Housekeeping', they are on duty!
             if (shiftText.toLowerCase().includes('housekeeping')) {
                 todayStaff.push({ id: `HK_${todayStaff.length + 1}`, name: name.trim() });
             }
         }
      }
      
      return todayStaff.length > 0 ? todayStaff : [ { id: "HK_1", name: "Mock Staff 1" } ];
    } catch (e) {
      logger.warn(`[HOUSEKEEPING] Failed to read WeeklySchedule from Sheets: ${e.message}`);
      return [ { id: "HK_1", name: "Maria" }, { id: "HK_2", name: "Rosa" } ];
    }
  }

  clusterRooms(rooms, housekeepers) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (this.lastAssignmentDate !== todayStr) {
      this.pinnedAssignments.clear();
      this.lastAssignmentDate = todayStr;
      logger.info('[HOUSEKEEPING] New calendar day detected. Wiping pinned assignments for fresh routing.');
    }

    // Determine weights for all rooms
    rooms.forEach(r => {
      r.weight = r.reservationCondition === 'checkout' ? this.WEIGHT_CHECKOUT : this.WEIGHT_STAYOVER;
      // Rooms start with their floor. 113 -> Floor 1, 204 -> Floor 2, 312 -> Floor 3
      r.floor = parseInt(r.roomID.charAt(0)) || 1; 
    });

    // Sort rooms by floor, then weight (heaviest first)
    rooms.sort((a, b) => {
      if (a.floor !== b.floor) return a.floor - b.floor;
      return b.weight - a.weight;
    });

    // Initialize buckets
    const buckets = housekeepers.map(hk => ({ id: hk.id, name: hk.name, totalWeight: 0, assignedRooms: [], activeFloor: null }));
    const bucketMap = new Map(buckets.map(b => [b.id, b]));

    // Step 1: Pre-fill buckets with already PINNED assignments
    const unpinnedRooms = [];
    for (const room of rooms) {
      const pinnedHkId = this.pinnedAssignments.get(room.roomID);
      const targetBucket = pinnedHkId ? bucketMap.get(pinnedHkId) : null;
      
      if (targetBucket) {
        // Room was assigned previously today! Pin it so it doesn't shuffle.
        targetBucket.assignedRooms.push(room);
        targetBucket.totalWeight += room.weight;
        targetBucket.activeFloor = room.floor;
      } else {
        unpinnedRooms.push(room);
      }
    }

    // Step 2: Greedy load-balancer taking floor affinity into account for UNPINNED rooms
    for (const room of unpinnedRooms) {
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

      // Lock it in for the rest of the day so future webhooks don't steal it
      this.pinnedAssignments.set(room.roomID, targetBucket.id);
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
