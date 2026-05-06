const { logger } = require('./logger');

/**
 * Deterministic, non-LLM nightly room assignment for Gateway Park.
 *
 * Why this isn't the agent:
 *
 * The 3:00 AM cron previously handed a free-form prompt to Gemini and
 * expected it to chain getReservations → getUnassignedRooms → a sequence
 * of assignRoom calls. Empirically the model would assign one or two
 * rooms and then declare the task complete in its summary, leaving most
 * arrivals unplaced. LLMs are unreliable for batch matching with strict
 * id correctness across many calls — this is exactly the work to lift
 * off the model.
 *
 * Algorithm (pure JS):
 *   1. Pull arrivals for today.
 *   2. Walk every guestList room slot; collect each that has a
 *      roomTypeID but no roomID (= unassigned).
 *   3. Pull the property-wide pool of available physical rooms.
 *   4. Pull the current housekeeping status for every room (so we can
 *      prefer rooms that were vacant + clean last night).
 *   5. For each unassigned slot, score every candidate room of the
 *      matching roomTypeID against Gateway Park's rule set, pick the
 *      highest score, and call assignRoom.
 *   6. Alert the front desk if anything is unplaced or errored, so
 *      morning shift sees the issue when they walk in.
 *
 * The agent's `assignRoom` tool is unchanged and still available for
 * ad-hoc reassignment requests via chat ("move guest X to room 215").
 *
 *
 * Rule set (in priority order, encoded as a score):
 *
 *   1. Specific room request from notes (e.g. "Please put us in 215") →
 *      gigantic positive score so it overrides everything else.
 *   2. Floor preference from a tag or note ("1st floor", "top floor",
 *      "ground floor") → HARD REJECT a room on the wrong floor.
 *   3. Conjoined-pair preservation: 207 connects to 209. 207 is a
 *      standard QQ and gets deprioritized in its type pool so it stays
 *      available for the conjoined-pair booking case. Staff still
 *      assign manually at booking time when a conjoined pair is
 *      explicitly booked; this is the safety net for nights when they
 *      forgot. (209 is its own unique room type so type-matching
 *      already isolates it.)
 *   4. Pet preference: when notes/tags say there's a pet, prefer
 *      stair-adjacent rooms on floors 2 and 3 (so the pet doesn't
 *      have to walk the full corridor to get outside). Floor 1 is
 *      fine anywhere — every room is close to an exit.
 *   5. Housekeeping tier:
 *        clean + vacant-last-night  → big bonus (no work, ready)
 *        clean + checkout-yesterday → smaller bonus (already cleaned)
 *        dirty                      → no bonus (still assignable; the
 *                                     housekeeping team uses today's
 *                                     assignment list to know what to
 *                                     clean first)
 *   6. Adjacent-occupied penalty: small ding if the room next door
 *      (n−1 or n+1) is occupied tonight (noise courtesy).
 *   7. Spread across the property: small per-floor penalty so today's
 *      arrivals don't all cluster on one floor when they could spread.
 *   8. Tie-breaker: lower room number wins.
 *
 * Things explicitly NOT encoded:
 *   - ADA matching beyond roomTypeID. ADA rooms at Gateway Park have
 *     their own room types, so the standard type-match handles it.
 *   - Loyalty / same-room-as-last-stay. Marked nice-to-have only;
 *     would require a per-arrival history lookup. Skipped for v1.
 *   - Pet-friendly room set. Gateway Park doesn't restrict which
 *     rooms can have pets — every room can if the fee is paid.
 */

// Property-specific constants — Gateway Park, Tea SD.
// Single wing, 3 floors, room numbers 1xx/2xx/3xx.
const PROPERTY = {
  // Stair- or exit-adjacent rooms. Used for the pet-rule preference on
  // floors 2 and 3 — pets near a stairwell don't have to walk the full
  // corridor when their owner takes them out. Floor 1 isn't in this set
  // because every floor-1 room is close to an exit anyway.
  stairAdjacent: new Set([
    201, 202, 204, 217, 218, 219, 220, 221,
    301, 302, 304, 317, 318, 319, 320, 321
  ]),
  // 207 connects to 209 (conjoined pair). 207 is a standard QQ; 209 is
  // its own special type. Deprioritize 207 in QQ assignment so it
  // stays available for the conjoined case. The penalty is large
  // enough that 207 is only picked when no other QQ is available, but
  // it still IS picked rather than left unassigned.
  conjoinedDeprioritize: new Set([207]),
};

// Score weights — tuned so a higher-priority rule reliably overrides a
// lower-priority one even at extreme combinations. Specific-room wins
// over everything; floor mismatch is a hard veto.
const W = {
  SPECIFIC_ROOM_REQUEST: 100000,
  CONJOINED_PENALTY:      -2000,
  // Group keep-together — applied when another reservation already
  // placed in this batch shares a group key with the current one.
  // "Adjacent" beats clean+vacant so families/groups cluster.
  GROUP_NEXT_DOOR:          600,
  GROUP_SAME_AREA:          400,
  GROUP_SAME_FLOOR:         250,
  PET_STAIR_ADJACENT:       200,
  PET_FAR_FROM_STAIRS:       50,
  PET_FLOOR_1_OK:           200,
  CLEAN_AND_VACANT:         500,
  CLEAN_AFTER_CHECKOUT:     300,
  DIRTY:                      0,
  ADJACENT_OCCUPIED:        -50,
  FLOOR_SPREAD_PER_PICK:    -15
};

function _floorOf(roomName) {
  const m = String(roomName || '').match(/^(\d)\d{2}$/);
  return m ? m[1] : null;
}

function _normalizedTagStrings(reservation) {
  const raw = reservation.tags || reservation.reservationTags || reservation.labels || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map(t => typeof t === 'string' ? t : (t && (t.name || t.label || t.title)) || '')
    .filter(Boolean)
    .map(s => s.toLowerCase().trim());
}

function _notesText(reservation) {
  return [
    reservation.notes,
    reservation.specialRequests,
    reservation.specialRequest,
    reservation.reservationNote,
    reservation.reservationNotes
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Pull a guest's stated preferences from Cloudbeds tags + reservation
 * notes. Tags are the more reliable signal (front desk picks from a
 * fixed enum like "1st floor"), notes are free text and only used as
 * a fallback / for specific-room requests like "please put us in 215".
 *
 * Also returns the raw notes string + a "next-to" hint so the group
 * keep-together pass downstream can re-parse without re-fetching.
 */
function extractPreferences(reservation) {
  const prefs = {
    requestedRoomName: null, // exact room (e.g. "215") guest asked for
    floorPreference:   null, // '1' | '2' | '3' | 'top'
    hasPet:            false,
    nextToName:        null, // free-text name from "please put next to <X>"
    notesRaw:          ''    // raw notes blob, lowercased — for downstream
  };

  for (const t of _normalizedTagStrings(reservation)) {
    if (/(?:^|\b)(?:1st|first|ground)\s*floor\b/.test(t))      prefs.floorPreference = '1';
    else if (/(?:^|\b)(?:2nd|second)\s*floor\b/.test(t))       prefs.floorPreference = '2';
    else if (/(?:^|\b)(?:3rd|third)\s*floor\b/.test(t))        prefs.floorPreference = '3';
    else if (/\btop\s*floor\b|\bhighest\s*floor\b/.test(t))    prefs.floorPreference = 'top';
    else if (/^floor\s*([123])$/.test(t)) {
      const m = t.match(/^floor\s*([123])$/);
      prefs.floorPreference = m[1];
    }
    if (/\b(pet|dog|cat|service\s*animal)\b/.test(t)) prefs.hasPet = true;
  }

  const notes = _notesText(reservation);
  prefs.notesRaw = notes;

  if (notes) {
    const roomMatch = notes.match(/\broom\s*[#]?\s*(\d{2,4})\b/);
    if (roomMatch) prefs.requestedRoomName = roomMatch[1];

    if (!prefs.floorPreference) {
      if (/(?:1st|first|ground)\s*floor/.test(notes))      prefs.floorPreference = '1';
      else if (/(?:2nd|second)\s*floor/.test(notes))       prefs.floorPreference = '2';
      else if (/(?:3rd|third)\s*floor/.test(notes))        prefs.floorPreference = '3';
      else if (/top\s*floor|highest\s*floor/.test(notes))  prefs.floorPreference = 'top';
    }

    if (!prefs.hasPet && /\b(pet|dog|cat|service\s*animal)\b/.test(notes)) {
      prefs.hasPet = true;
    }

    // "Please put us next to John Smith's room" / "near the Smiths" /
    // "near John". We capture a 1-3 word name token; the group pass
    // resolves it against the rest of today's batch.
    const nextToMatch = notes.match(/(?:next\s*to|near|by|adjacent\s*to)\s+([a-z][a-z .'-]{1,40}?)(?:'s|\s+room|\s+suite|[.,;!?]|$)/i);
    if (nextToMatch) {
      prefs.nextToName = nextToMatch[1].trim().toLowerCase().replace(/\s+/g, ' ');
    }
  }

  return prefs;
}

/**
 * Group keep-together: walk the unassigned set and merge entries that
 * should be placed near each other.
 *
 * Signals (any of which puts two reservations in the same group):
 *   1. Same parent reservation prefix — multi-room booking siblings
 *      arrive as PARENT-1, PARENT-2, … so we strip the trailing -N.
 *   2. Same Cloudbeds groupID — set explicitly by the front desk for
 *      group/wedding/event bookings.
 *   3. Identical full guest name across different reservation IDs —
 *      the same person booking multiple rooms separately.
 *   4. A "next to <name>" / "near <name>" hint in the notes that
 *      resolves to another reservation in today's batch.
 *
 * Implemented as union-find so signals compose: e.g. a reservation
 * with the same name as another AND a "next to Bob" note ends up in
 * one merged group covering all three.
 *
 * Mutates each entry, adding a `groupKey` field that's stable per
 * group across the batch. Singleton groups are fine — they just have
 * no group sibling for proximity scoring to reference.
 */
function assignGroupKeys(needs) {
  const parent = new Map();
  const find = (k) => {
    if (!parent.has(k)) { parent.set(k, k); return k; }
    let p = parent.get(k);
    while (p !== parent.get(p)) p = parent.get(p);
    parent.set(k, p);
    return p;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Pass 1: derive prefix / groupID / name signals.
  // We also build a name → reservationIds index for the next-to pass.
  const reservationsByName = new Map();
  for (const need of needs) {
    const id = need.reservationId;
    find(id); // ensure registered

    // Parent prefix (multi-room sibling detection).
    const m = String(id).match(/^(.*?)-\d+$/);
    if (m && m[1]) union(id, `prefix:${m[1]}`);

    // Cloudbeds groupID (when the front desk used the Group feature).
    if (need.groupID) union(id, `group:${need.groupID}`);

    // Same-full-name detection. Last-name-only is too noisy at a small
    // property (two unrelated Smiths in one batch); we require an
    // exact full-name match.
    if (need.guestName) {
      const k = need.guestName.toLowerCase().replace(/\s+/g, ' ').trim();
      if (k && k !== 'guest') {
        union(id, `name:${k}`);
        if (!reservationsByName.has(k)) reservationsByName.set(k, []);
        reservationsByName.get(k).push(id);
      }
    }
  }

  // Pass 2: resolve "next to <name>" / "near <name>" hints against the
  // batch. Only matches arrivals being placed today — stayover targets
  // would need a separate lookup that we punt on for v1.
  for (const need of needs) {
    if (!need.nextToName) continue;
    const target = need.nextToName.toLowerCase().trim();
    if (!target) continue;
    let matchedId = null;
    for (const [name, ids] of reservationsByName.entries()) {
      // Match if names overlap meaningfully — a guest writing "next to
      // Smith" likely means any Smith family member in the batch.
      const tokens = target.split(/\s+/).filter(Boolean);
      const hit = tokens.some(tok => name.split(/\s+/).includes(tok));
      if (hit) {
        for (const candidate of ids) {
          if (candidate !== need.reservationId) { matchedId = candidate; break; }
        }
        if (matchedId) break;
      }
    }
    if (matchedId) {
      union(need.reservationId, matchedId);
    } else {
      logger.warn(`[ROOM ASSIGN] ${need.guestName} (${need.reservationId}) requested "next to ${need.nextToName}" but no matching arrival found in today's batch.`);
    }
  }

  // Final: stamp each need with its resolved group key.
  for (const need of needs) {
    need.groupKey = find(need.reservationId);
  }
}

/**
 * Score one candidate room for one unassigned slot. Higher = better.
 * Returns -Infinity for hard rejects (currently only "tagged for floor
 * X but this room isn't on floor X").
 */
function scoreRoom(room, need, ctx) {
  const roomNum = parseInt(room.roomName, 10);
  const roomFloor = _floorOf(room.roomName);
  let score = 0;

  // 1. Specific-room request → overwhelming priority.
  if (need.requestedRoomName && String(room.roomName) === String(need.requestedRoomName)) {
    score += W.SPECIFIC_ROOM_REQUEST;
  }

  // 2. Floor tag is a hard veto. If a guest tagged "2nd floor" we never
  //    place them on 1 or 3, even if it costs us the assignment.
  if (need.floorPreference) {
    const wanted = need.floorPreference === 'top' ? '3' : need.floorPreference;
    if (roomFloor !== wanted) return -Infinity;
  }

  // 3. Conjoined-pair preservation (207).
  if (PROPERTY.conjoinedDeprioritize.has(roomNum)) {
    score += W.CONJOINED_PENALTY;
  }

  // 3.5. Group keep-together. Once one member of this group has been
  //      placed in this batch, prefer rooms adjacent to / on the same
  //      floor as that member. Adjacent beats clean+vacant so families
  //      and groups cluster ahead of housekeeping convenience.
  //      Only same-floor candidates earn a bonus — different-floor
  //      rooms simply get no boost (other rules decide).
  if (need.groupKey && ctx.placedByGroup) {
    const placed = ctx.placedByGroup.get(need.groupKey);
    if (placed && placed.length > 0) {
      let bestProximity = 0;
      for (const p of placed) {
        if (p.floor !== roomFloor) continue;
        const delta = Math.abs(roomNum - p.roomNum);
        let prox;
        if (delta === 0) prox = 0;          // shouldn't happen (room already taken)
        else if (delta <= 2) prox = W.GROUP_NEXT_DOOR;
        else if (delta <= 4) prox = W.GROUP_SAME_AREA;
        else prox = W.GROUP_SAME_FLOOR;
        if (prox > bestProximity) bestProximity = prox;
      }
      score += bestProximity;
    }
  }

  // 4. Pet preference: stair-adjacent on upper floors.
  if (need.hasPet) {
    if (roomFloor === '1') {
      score += W.PET_FLOOR_1_OK;
    } else if (PROPERTY.stairAdjacent.has(roomNum)) {
      score += W.PET_STAIR_ADJACENT;
    } else {
      score += W.PET_FAR_FROM_STAIRS;
    }
  }

  // 5. Housekeeping tier.
  const hk = ctx.housekeepingByRoomKey.get(room.roomId)
          || ctx.housekeepingByRoomKey.get(room.roomName);
  if (hk) {
    const recentlyOccupied = hk.reservationCondition === 'checkout' || hk.reservationCondition === 'stay_over';
    if (hk.roomCondition === 'clean' && !recentlyOccupied) {
      score += W.CLEAN_AND_VACANT;
    } else if (hk.roomCondition === 'clean') {
      score += W.CLEAN_AFTER_CHECKOUT;
    } else {
      score += W.DIRTY;
    }
  } else {
    // No housekeeping record for this room — assume best case (vacant
    // and clean). Conservative because most properties only return
    // rows for rooms the housekeeping team has touched recently.
    score += W.CLEAN_AND_VACANT;
  }

  // 6. Adjacent-occupied penalty (noise courtesy).
  if (ctx.tonightOccupiedRoomNumbers.has(roomNum - 1) ||
      ctx.tonightOccupiedRoomNumbers.has(roomNum + 1)) {
    score += W.ADJACENT_OCCUPIED;
  }

  // 7. Spread: light penalty per pick already made on the same floor
  //    in this batch, so we don't cluster every arrival on one floor.
  const picksOnFloor = ctx.picksByFloor.get(roomFloor) || 0;
  score += picksOnFloor * W.FLOOR_SPREAD_PER_PICK;

  return score;
}

function pickRoom(need, candidates, ctx) {
  let best = null;
  let bestScore = -Infinity;
  for (const room of candidates) {
    const s = scoreRoom(room, need, ctx);
    if (s === -Infinity) continue;
    if (s > bestScore) { best = room; bestScore = s; continue; }
    if (s === bestScore && best) {
      // Tie-breaker: lower room number first.
      const a = parseInt(room.roomName, 10);
      const b = parseInt(best.roomName, 10);
      if (a < b) { best = room; }
    }
  }
  return best ? { room: best, score: bestScore } : null;
}

async function runRoomAssignment({ api, alertHub, todayStr, tomorrowStr }) {
  logger.info(`[ROOM ASSIGN] Starting deterministic assignment for ${todayStr}.`);

  // 1. Today's arrivals.
  const reservationsResp = await api.getReservations(todayStr, todayStr);
  if (!reservationsResp || !reservationsResp.success) {
    logger.error(`[ROOM ASSIGN] getReservations failed; aborting.`);
    if (alertHub) alertHub.publish({
      urgency: 'high',
      issueDescription: `Nightly room assignment aborted — could not fetch today's arrivals from Cloudbeds. Reassign manually.`
    });
    return { assigned: 0, attempted: 0, unplaced: [], errors: ['getReservations failed'] };
  }
  const arrivals = reservationsResp.data || [];

  // 2. Find every unassigned slot AND collect per-reservation preferences.
  const needAssignment = [];
  for (const r of arrivals) {
    const status = (r.status || '').toLowerCase();
    if (status !== 'confirmed') continue;
    if (!r.guestList) continue;
    const reservationFallbackTypeId = r.roomTypeID || r.roomTypeId || null;
    const prefs = extractPreferences(r);
    for (const g of Object.values(r.guestList)) {
      if (!g) continue;
      const allRooms = [];
      if (Array.isArray(g.rooms)) allRooms.push(...g.rooms);
      if (Array.isArray(g.unassignedRooms)) allRooms.push(...g.unassignedRooms);
      if (allRooms.length === 0) continue;
      for (const rm of allRooms) {
        if (!rm) continue;
        if (rm.roomID) continue; // already placed
        const wantedTypeId = rm.roomTypeID || rm.roomTypeId || reservationFallbackTypeId;
        if (!wantedTypeId) {
          logger.warn(`[ROOM ASSIGN] Reservation ${r.reservationID} has an unassigned slot with no roomTypeID — skipping; cannot match.`);
          continue;
        }
          needAssignment.push({
            reservationId: r.reservationID,
            guestName: (r.guestName || `${g.firstName || ''} ${g.lastName || ''}`.trim() || 'Guest').toString(),
            roomTypeID: wantedTypeId,
            roomTypeName: rm.roomTypeName || rm.roomType || '',
            startDate: r.startDate || todayStr,
            endDate: r.endDate || tomorrowStr,
            // Cloudbeds groupID for the front-desk Group feature (event
          // bookings, weddings, etc). Optional. Used by assignGroupKeys.
          groupID: r.groupID || r.groupId || r.groupID0 || null,
          ...prefs
        });
      }
    }
  }

  if (needAssignment.length === 0) {
    logger.info(`[ROOM ASSIGN] No unassigned arrivals for ${todayStr}; nothing to do.`);
    return { assigned: 0, attempted: 0, unplaced: [], errors: [] };
  }
  logger.info(`[ROOM ASSIGN] ${needAssignment.length} unassigned arrival${needAssignment.length === 1 ? '' : 's'} to place.`);

  // 3. Available physical rooms.
  // Because stays have different durations, a room available for 1 night
  // might not be available for 3 nights. Fetch pools per unique endDate.
  const uniqueEndDates = new Set();
  needAssignment.forEach(need => uniqueEndDates.add(need.endDate));

  const poolsByEndDate = new Map();
  for (const ed of uniqueEndDates) {
    const unassignedResp = await api.getUnassignedRooms(todayStr, ed);
    if (!unassignedResp || !unassignedResp.success) {
      logger.error(`[ROOM ASSIGN] getUnassignedRooms failed for ${todayStr} to ${ed}; aborting.`);
      if (alertHub) alertHub.publish({
        urgency: 'high',
        issueDescription: `Nightly room assignment aborted — could not fetch the available-room pool from Cloudbeds. Reassign manually.`
      });
      return { assigned: 0, attempted: needAssignment.length, unplaced: needAssignment, errors: ['getUnassignedRooms failed'] };
    }
    poolsByEndDate.set(ed, unassignedResp.data || []);
  }

  // Track globally assigned room IDs to prevent double-booking across different pools
  const globallyAssignedRoomIDs = new Set();

  // 4. Housekeeping snapshot. Used for the clean+vacant tiering and
  //    to know which rooms are occupied tonight (stay_over rooms +
  //    rooms already pre-assigned to today's arrivals).
  let housekeeping = [];
  try {
    const hkResp = await api.getHousekeepingStatus();
    if (hkResp && hkResp.success && Array.isArray(hkResp.data)) housekeeping = hkResp.data;
  } catch (e) {
    logger.warn(`[ROOM ASSIGN] getHousekeepingStatus threw: ${e.message}; continuing without housekeeping tier.`);
  }
  const housekeepingByRoomKey = new Map();
  for (const row of housekeeping) {
    if (!row) continue;
    if (row.roomID)   housekeepingByRoomKey.set(row.roomID, row);
    if (row.roomName) housekeepingByRoomKey.set(row.roomName, row);
  }

  // 5. Tonight's occupied set (room NUMBERS, used for adjacency
  //    courtesy). Pull from housekeeping where reservationCondition is
  //    a current-occupancy state, plus arrivals already assigned today.
  const tonightOccupiedRoomNumbers = new Set();
  for (const row of housekeeping) {
    if (row && (row.reservationCondition === 'stay_over' || row.reservationCondition === 'checkin')) {
      const num = parseInt(row.roomName || row.roomID, 10);
      if (Number.isFinite(num)) tonightOccupiedRoomNumbers.add(num);
    }
  }
  for (const r of arrivals) {
    if (!r.guestList) continue;
    for (const g of Object.values(r.guestList)) {
      if (!Array.isArray(g.rooms)) continue;
      for (const rm of g.rooms) {
        if (rm && rm.roomID && rm.roomName) {
          const num = parseInt(rm.roomName, 10);
          if (Number.isFinite(num)) tonightOccupiedRoomNumbers.add(num);
        }
      }
    }
  }

  // 6. Available pool summary
  const totalPools = poolsByEndDate.size;
  logger.info(`[ROOM ASSIGN] Loaded available room pools for ${totalPools} unique date ranges.`);

  // 7. Resolve group keep-together signals (parent prefix, groupID,
  //    same full name, "next to <name>" notes) and merge into shared
  //    group keys. Then sort so group siblings process consecutively —
  //    once one is placed, the rest pull toward it via the proximity
  //    score.
  assignGroupKeys(needAssignment);
  needAssignment.sort((a, b) => {
    const gk = String(a.groupKey || '').localeCompare(String(b.groupKey || ''));
    if (gk !== 0) return gk;
    return String(a.reservationId).localeCompare(String(b.reservationId));
  });

  const ctx = {
    housekeepingByRoomKey,
    tonightOccupiedRoomNumbers,
    picksByFloor: new Map(),
    placedByGroup: new Map() // groupKey → [{ roomName, roomNum, floor }]
  };

  let assigned = 0;
  const unplaced = [];
  const errors = [];

  for (const need of needAssignment) {
    const myPool = poolsByEndDate.get(need.endDate) || [];
    const candidates = myPool.filter(rm => rm.roomTypeID === need.roomTypeID && !globallyAssignedRoomIDs.has(rm.roomId || rm.roomID));

    if (!candidates || candidates.length === 0) {
      logger.warn(`[ROOM ASSIGN] No available room of type ${need.roomTypeName || need.roomTypeID} for ${need.guestName} (${need.reservationId}).`);
      unplaced.push(need);
      continue;
    }
    const pick = pickRoom(need, candidates, ctx);
    if (!pick) {
      // Hard rejects (e.g. floor tag and no room on that floor in this
      // type's pool) — treat as unplaced and surface to staff.
      logger.warn(`[ROOM ASSIGN] No candidate satisfies hard constraints for ${need.guestName} (${need.reservationId}); preferences=${JSON.stringify({ requestedRoomName: need.requestedRoomName, floorPreference: need.floorPreference, hasPet: need.hasPet })}.`);
      unplaced.push(need);
      continue;
    }
    const { room, score } = pick;
    globallyAssignedRoomIDs.add(room.roomId || room.roomID);

    // Pop the picked room out of the type pool so two reservations
    // never get the same room.
    const idx = candidates.indexOf(room);
    if (idx >= 0) candidates.splice(idx, 1);

    try {
      const result = await api.assignRoom(need.reservationId, room.roomId, need.roomTypeID);
      if (result && result.success !== false) {
        const reasons = [];
        if (need.requestedRoomName === room.roomName) reasons.push('requested');
        if (need.floorPreference) reasons.push(`floor:${need.floorPreference}`);
        if (need.hasPet) reasons.push('pet');
        if (PROPERTY.conjoinedDeprioritize.has(parseInt(room.roomName, 10))) reasons.push('conjoined-fallback');
        // Tag if a group sibling was already placed; helps spot whether
        // the keep-together rule actually bit on the pick.
        if (need.groupKey && ctx.placedByGroup.has(need.groupKey)) reasons.push('group');
        const reasonTag = reasons.length ? ` [${reasons.join(',')}]` : '';
        logger.info(`[ROOM ASSIGN] Assigned ${need.guestName} (${need.reservationId}) → Room ${room.roomName} score=${score}${reasonTag}.`);
        assigned++;
        // Track for the spread rule + adjacency lookahead.
        const f = _floorOf(room.roomName);
        if (f) ctx.picksByFloor.set(f, (ctx.picksByFloor.get(f) || 0) + 1);
        const num = parseInt(room.roomName, 10);
        if (Number.isFinite(num)) tonightOccupiedRoomNumbers.add(num);
        // Register this placement in the group bucket so the next
        // sibling in the same group can score against it.
        if (need.groupKey) {
          if (!ctx.placedByGroup.has(need.groupKey)) ctx.placedByGroup.set(need.groupKey, []);
          ctx.placedByGroup.get(need.groupKey).push({
            roomName: room.roomName,
            roomNum: Number.isFinite(num) ? num : null,
            floor: f
          });
        }
      } else {
        const msg = (result && (result.message || result.error)) || 'unknown error';
        logger.error(`[ROOM ASSIGN] assignRoom rejected for ${need.guestName} (${need.reservationId}): ${msg}`);
        // Put the room back in the type pool — the next reservation of
        // the same type might succeed where this one didn't.
        candidates.unshift(room);
        errors.push({ ...need, error: msg });
      }
    } catch (e) {
      logger.error(`[ROOM ASSIGN] assignRoom threw for ${need.guestName} (${need.reservationId}): ${e.message}`);
      candidates.unshift(room);
      errors.push({ ...need, error: e.message });
    }
  }

  // 8. Alert if anything's broken or unplaced. Single coalesced alert
  //    so morning shift gets one summary line, not 7.
  if ((unplaced.length > 0 || errors.length > 0) && alertHub) {
    const lines = [`Auto-assigned ${assigned}/${needAssignment.length} arrival${needAssignment.length === 1 ? '' : 's'} for ${todayStr}.`];
    if (unplaced.length > 0) {
      lines.push(`${unplaced.length} could not be placed:`);
      for (const u of unplaced.slice(0, 6)) {
        const reasonHint = u.floorPreference
          ? ` — wanted floor ${u.floorPreference} but no ${u.roomTypeName || u.roomTypeID} available there`
          : ` — no ${u.roomTypeName || u.roomTypeID} available`;
        lines.push(`  • ${u.guestName} (${u.reservationId})${reasonHint}`);
      }
      if (unplaced.length > 6) lines.push(`  • …and ${unplaced.length - 6} more`);
    }
    if (errors.length > 0) {
      lines.push(`${errors.length} assignment${errors.length === 1 ? '' : 's'} errored:`);
      for (const e of errors.slice(0, 6)) {
        lines.push(`  • ${e.guestName} (${e.reservationId}): ${(e.error || '').substring(0, 80)}`);
      }
    }
    alertHub.publish({
      urgency: 'high',
      issueDescription: lines.join(' ')
    });
  }

  logger.info(`[ROOM ASSIGN] Done: ${assigned}/${needAssignment.length} placed; ${unplaced.length} unplaced; ${errors.length} errored.`);
  return { assigned, attempted: needAssignment.length, unplaced, errors };
}

module.exports = { runRoomAssignment, extractPreferences, assignGroupKeys, scoreRoom, PROPERTY };
